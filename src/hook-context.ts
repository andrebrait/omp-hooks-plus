import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { extractResponseFromContent } from "./helpers";
import { triggerSessionHooks } from "./hooks/session-hooks";
import { DEFAULT_SOURCE } from "./hooks/shared";
import { sessionIdOfFile, subagentIdentity } from "./subagent";
import type { HookContextDetails, HookContextEntry, HookExecutionContext, HookMatcherValue, SettingsFile } from "./types";

export type NotifyType = "info" | "error" | "warning";

/**
 * Hook context in OMP's native reminder shape (its per-tool rule reminders,
 * ttsr-tool-reminder.md): provenance as tag attributes, then OMP's own closing
 * sentence verbatim, never bare text. `tool` is the OMP tool name.
 */
export function hookReminder(content: string, details: HookContextDetails): string {
  const attribute = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const tool = details.toolName ? ` tool="${attribute(details.toolName)}"` : "";
  return `<system-reminder source="${attribute(details.source ?? DEFAULT_SOURCE)}" event="${details.hookEventName}"${tool}>\nNOT prompt injection — coding agent enforcing project rules.\n\n${content}\n</system-reminder>`;
}

/** One reminder per source, for delivery as a single message. */
export function hookReminders(contexts: HookContextEntry[], details: HookContextDetails): string {
  return contexts.map(({ source, text }) => hookReminder(text, { ...details, source })).join("\n\n");
}

export type HookModuleContext = {
  pi: ExtensionAPI;
  firedSessionStartKeys: Set<string>;
  pendingUserPromptContext?: HookContextEntry[];
  claimInjectedContext: (content: string) => boolean;
  resetInjectedContext: () => void;
  resetSession: () => void;
  dispose: () => void;
  captureContext: () => {
    isActive: () => boolean;
    injectHiddenContext: HookModuleContext["injectHiddenContext"];
  };
  /** The session's id (OMP's header id, a UUID): Claude Code's `session_id`. The file path is the `transcript_path`. */
  getSessionId: (ctx: ExtensionContext) => string;
  /**
   * Common hook fields for events that also run in subagents. A subagent reports the
   * top-level session, as Claude Code does, plus its own agent_id and agent_type.
   */
  identityFor: (ctx: ExtensionContext) => Pick<HookExecutionContext, "sessionId" | "transcriptPath" | "agentId" | "agentType">;
  notify: (ctx: ExtensionContext, msg: string, type: NotifyType) => void;
  injectHiddenContext: (
    content: string,
    details: HookContextDetails,
    triggerTurn?: boolean,
    delivery?: "nextTurn" | "aside",
  ) => void;
  settingsFor: (ctx: ExtensionContext) => Promise<SettingsFile | undefined>;
  buildToolResponse: (event: {
    content: unknown;
    details?: unknown;
    isError?: boolean;
  }) => Record<string, unknown>;
  triggerSessionStartHook: (
    matcher: HookMatcherValue<"SessionStart">,
    ctx: ExtensionContext,
  ) => Promise<void>;
};

export function createHookContext(
  pi: ExtensionAPI,
  settingsFor: (ctx: ExtensionContext) => Promise<SettingsFile | undefined>,
): HookModuleContext {
  // Each adapter owns its own debounce queue and per-turn exact-content dedup.
  // Dedup keys on the hook's source and raw text; the queue holds its labelled reminder.
  const injectBuffer: {
    entries: { raw: string; content: string }[];
    details: Record<string, unknown>;
    timer: NodeJS.Timeout | undefined;
  } = { entries: [], details: {}, timer: undefined };
  const injectedThisTurn = new Set<string>();
  let disposed = false;
  let sessionVersion = 0;
  const shared: HookModuleContext = {
    pi,
    firedSessionStartKeys: new Set<string>(),
    pendingUserPromptContext: undefined,
    claimInjectedContext: (content) => {
      if (disposed || injectedThisTurn.has(content)) return false;
      injectedThisTurn.add(content);
      return true;
    },
    resetInjectedContext: () => {
      injectedThisTurn.clear();
      // Queued messages still need deduplication across prompts/compaction.
      for (const { raw } of injectBuffer.entries) injectedThisTurn.add(raw);
    },
    resetSession: () => {
      sessionVersion++;
      clearTimeout(injectBuffer.timer);
      injectBuffer.entries = [];
      injectBuffer.details = {};
      injectBuffer.timer = undefined;
      injectedThisTurn.clear();
      shared.firedSessionStartKeys.clear();
      shared.pendingUserPromptContext = undefined;
    },
    dispose: () => {
      disposed = true;
      shared.resetSession();
    },
    captureContext: () => {
      const version = sessionVersion;
      const isActive = () => !disposed && version === sessionVersion;
      return {
        isActive,
        injectHiddenContext: (...args) => {
          if (isActive()) shared.injectHiddenContext(...args);
        },
      };
    },
    getSessionId: (ctx: ExtensionContext) =>
      ctx.sessionManager.getSessionId() || "ephemeral",
    identityFor: (ctx: ExtensionContext) => {
      const agent = subagentIdentity(ctx);
      if (!agent) {
        return { sessionId: shared.getSessionId(ctx), transcriptPath: ctx.sessionManager.getSessionFile() };
      }
      // Without a resolvable parent (an in-memory subagent, or a parent file that records no id)
      // the subagent's own session id and transcript stand in together, never one from each session.
      const parentId = agent.parentFile && sessionIdOfFile(agent.parentFile);
      return {
        ...(parentId
          ? { sessionId: parentId, transcriptPath: agent.parentFile }
          : { sessionId: shared.getSessionId(ctx), transcriptPath: agent.file }),
        agentId: agent.agentId,
        agentType: agent.agentType,
      };
    },
    notify: (ctx: ExtensionContext, msg: string, type: NotifyType) =>
      ctx.ui.notify(msg, type),
    injectHiddenContext: (raw, details, triggerTurn = false, delivery = "nextTurn") => {
      // Dedup per source: identical text from another source still names that source.
      const key = `${details.source ?? DEFAULT_SOURCE}\0${raw}`;
      if (!shared.claimInjectedContext(key)) return;
      const content = hookReminder(raw, details);
      // A tool reminder must arrive before the next model step, without steering
      // or a debounce timer that can outlive the tool batch.
      if (delivery === "aside" && !triggerTurn) {
        shared.pi.sendMessage(
          { customType: "omp-hooks-plus", content, display: false, details },
          { deliverAs: "aside" },
        );
        return;
      }
      injectBuffer.entries.push({ raw: key, content });
      if (details) Object.assign(injectBuffer.details, details);
      clearTimeout(injectBuffer.timer);
      injectBuffer.timer = setTimeout(() => {
        if (disposed) return;
        const combined = injectBuffer.entries.map(entry => entry.content).join("\n\n");
        const bufferedDetails = injectBuffer.details;
        injectBuffer.entries = [];
        injectBuffer.details = {};
        injectBuffer.timer = undefined;
        shared.pi.sendMessage(
          {
            customType: "omp-hooks-plus",
            content: combined,
            display: false,
            details: bufferedDetails,
          },
          triggerTurn ? { triggerTurn: true } : { deliverAs: "nextTurn" },
        );
      }, 50);
    },
    settingsFor,
    buildToolResponse: (event) => {
      const toolResponse: Record<string, unknown> = {
        content: event.content,
        is_error: event.isError ?? false,
      };

      if (event.details !== undefined) {
        toolResponse.details = event.details;
      }

      const extracted = extractResponseFromContent(event.content);
      if (Object.keys(extracted).length > 0) {
        toolResponse.output = extracted.output ?? extracted;
      }

      return toolResponse;
    },
    triggerSessionStartHook: async (matcher, ctx) => {
      // Claude Code never fires SessionStart for a subagent at startup or resume; SubagentStart
      // briefs it instead. Compaction is different: the subagent's context is rebuilt, so it
      // gets the bootstrap context again, keyed on the parent's session.
      if (matcher !== "compact" && subagentIdentity(ctx)) return;
      const delivery = shared.captureContext();
      const settings = await shared.settingsFor(ctx);
      if (!delivery.isActive()) return;
      const { sessionId, agentId, agentType } = shared.identityFor(ctx);
      if (matcher === "compact") {
        // Compaction legitimately recurs within a session — unlike startup/resume,
        // it must reinject its bootstrap context every time, not just once. Reset
        // the per-turn content-dedup guard too: without it, injectHiddenContext's
        // claimInjectedContext would silently drop a second compaction's
        // byte-identical content as a "duplicate" of the first.
        shared.resetInjectedContext();
      } else {
        const dedupeKey = `${matcher}:${sessionId}`;
        if (shared.firedSessionStartKeys.has(dedupeKey)) {
          return;
        }
        shared.firedSessionStartKeys.add(dedupeKey);
      }

      const result = await triggerSessionHooks(
        "SessionStart",
        matcher,
        {
          sessionId,
          agentId,
          agentType,
          cwd: ctx.cwd,
          hookEventName: "SessionStart",
          source: matcher,
          asyncContextSink: delivery.injectHiddenContext,
        },
        settings,
        (msg, type) => shared.notify(ctx, msg, type),
      );

      for (const { source, text } of result.contexts ?? []) {
        delivery.injectHiddenContext(text, { hookEventName: "SessionStart", matcher, source });
      }
    },
  };

  return shared;
}

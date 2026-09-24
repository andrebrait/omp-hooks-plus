import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { toClaudeToolName } from "./claude";
import { extractResponseFromContent } from "./helpers";
import { triggerSessionHooks } from "./hooks/session-hooks";
import type { HookContextDetails, HookMatcherValue, SettingsFile } from "./types";

export type NotifyType = "info" | "error" | "warning";

/**
 * Claude Code (2.1.277) shows hook context to the model as a system reminder that
 * names the hook -- `PreToolUse:Bash`, `SessionStart`, ... -- never as bare text.
 */
export function hookReminder(content: string, details: HookContextDetails): string {
  const hookName = details.toolName
    ? `${details.hookEventName}:${toClaudeToolName(details.toolName)}`
    : details.hookEventName;
  return `<system-reminder>\n${hookName} hook additional context: ${content}\n</system-reminder>`;
}

export type HookModuleContext = {
  pi: ExtensionAPI;
  firedSessionStartKeys: Set<string>;
  pendingUserPromptContext?: string;
  stopHookActive: boolean;
  claimInjectedContext: (content: string) => boolean;
  resetInjectedContext: () => void;
  resetSession: () => void;
  dispose: () => void;
  captureContext: () => {
    isActive: () => boolean;
    injectHiddenContext: HookModuleContext["injectHiddenContext"];
  };
  getSessionId: (ctx: ExtensionContext) => string;
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
  // Dedup keys on the hook's raw text; the queue holds its labelled reminder.
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
    stopHookActive: false,
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
      shared.stopHookActive = false;
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
      ctx.sessionManager.getSessionFile() ?? "ephemeral",
    notify: (ctx: ExtensionContext, msg: string, type: NotifyType) =>
      ctx.ui.notify(msg, type),
    injectHiddenContext: (raw, details, triggerTurn = false, delivery = "nextTurn") => {
      if (!shared.claimInjectedContext(raw)) return;
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
      injectBuffer.entries.push({ raw, content });
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
      const delivery = shared.captureContext();
      const settings = await shared.settingsFor(ctx);
      if (!delivery.isActive()) return;
      const sessionId = shared.getSessionId(ctx);
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
          cwd: ctx.cwd,
          hookEventName: "SessionStart",
          source: matcher,
          asyncContextSink: delivery.injectHiddenContext,
        },
        settings,
        (msg, type) => shared.notify(ctx, msg, type),
      );

      if (result.additionalContext) {
        delivery.injectHiddenContext(result.additionalContext, {
          hookEventName: "SessionStart",
          source: matcher,
        });
      }
    },
  };

  return shared;
}

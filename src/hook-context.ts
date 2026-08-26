import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadSettings, type LoadedSettings } from "./config";
import { extractResponseFromContent } from "./helpers";
import { triggerSessionHooks } from "./hooks/session-hooks";
import type { HookMatcherValue, SettingsFile } from "./types";

export type NotifyType = "info" | "error" | "warning";

// Debounce buffer for injectHiddenContext — module-level so parallel calls
// within the same process share one queue. 50ms window collapses a burst of
// grep/glob injections into one combined sendMessage.
const _injectBuffer: { content: string[]; details: Record<string, unknown>; timer: NodeJS.Timeout | undefined } = {
  content: [],
  details: {},
  timer: undefined,
};

export type HookModuleContext = {
  pi: ExtensionAPI;
  currentSettings: SettingsFile | undefined;
  currentLoad: LoadedSettings | undefined;
  firedSessionStartKeys: Set<string>;
  pendingUserPromptContext?: string;
  stopHookActive: boolean;
  getSessionId: (ctx: ExtensionContext) => string;
  notify: (ctx: ExtensionContext, msg: string, type: NotifyType) => void;
  injectHiddenContext: (
    content: string,
    details: Record<string, unknown>,
    triggerTurn?: boolean,
  ) => void;
  settingsFor: (ctx: ExtensionContext) => SettingsFile | undefined;
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

export function createHookContext(pi: ExtensionAPI): HookModuleContext {
  const shared: HookModuleContext = {
    pi,
    currentSettings: undefined,
    currentLoad: undefined,
    firedSessionStartKeys: new Set<string>(),
    pendingUserPromptContext: undefined,
    stopHookActive: false,
    getSessionId: (ctx: ExtensionContext) =>
      ctx.sessionManager.getSessionFile() ?? "ephemeral",
    notify: (ctx: ExtensionContext, msg: string, type: NotifyType) =>
      ctx.ui.notify(msg, type),
    injectHiddenContext: (content, details, triggerTurn = false) => {
      // 50ms debounce — parallel grep/glob calls trigger concurrent sendMessage
      // calls. Collapses a burst of parallel injections into one combined
      // sendMessage after the burst settles. Uses deliverAs: "nextTurn" so
      // context queues for the next turn instead of calling agent.steer(),
      // which would interrupt in-flight tools with "Skipped due to pending
      // system advisory" (OMP's stale-guard, agent-loop.ts:2351).
      _injectBuffer.content.push(content);
      if (details) Object.assign(_injectBuffer.details, details);
      clearTimeout(_injectBuffer.timer);
      _injectBuffer.timer = setTimeout(() => {
        const combined = _injectBuffer.content.join("\n\n");
        shared.pi.sendMessage(
          {
            customType: "omp-hooks-plus",
            content: combined,
            display: false,
            details: _injectBuffer.details,
          },
          triggerTurn ? { triggerTurn: true } : { deliverAs: "nextTurn" },
        );
        _injectBuffer.content = [];
        _injectBuffer.details = {};
        _injectBuffer.timer = undefined;
      }, 50);
    },
    settingsFor: (ctx: ExtensionContext) => {
      const projectTrusted = ctx.isProjectTrusted();
      const loaded = loadSettings(ctx.cwd, { projectTrusted });
      shared.currentLoad = loaded;
      shared.currentSettings = loaded.settings;
      return loaded.settings;
    },
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
      shared.settingsFor(ctx);
      const sessionId = shared.getSessionId(ctx);
      const dedupeKey = `${matcher}:${sessionId}`;
      if (shared.firedSessionStartKeys.has(dedupeKey)) {
        return;
      }
      shared.firedSessionStartKeys.add(dedupeKey);

      const result = await triggerSessionHooks(
        "SessionStart",
        matcher,
        {
          sessionId,
          cwd: ctx.cwd,
          hookEventName: "SessionStart",
          source: matcher,
          asyncContextSink: (content, details, triggerTurn) =>
            shared.injectHiddenContext(content, details, triggerTurn),
        },
        shared.currentSettings,
        (msg, type) => shared.notify(ctx, msg, type),
      );

      if (result.additionalContext) {
        shared.injectHiddenContext(result.additionalContext, {
          hookEventName: "SessionStart",
          source: matcher,
        });
      }
    },
  };

  return shared;
}

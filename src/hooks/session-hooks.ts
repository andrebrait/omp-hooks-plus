import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { HookModuleContext } from "../hook-context";
import type {
  HookExecutionContext,
  HookMatcherValue,
  HookRunResult,
  NotifyFn,
  SettingsFile,
} from "../types";
import { triggerSimpleHooks } from "./shared";

export async function triggerSessionHooks(
  eventName: "SessionStart" | "SessionEnd",
  matcherValue: HookMatcherValue<"SessionStart"> | HookMatcherValue<"SessionEnd">,
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<HookRunResult> {
  return triggerSimpleHooks(eventName, matcherValue, context, settings, notify);
}

export function registerSessionHooks(
  pi: ExtensionAPI,
  shared: HookModuleContext,
) {
  // SessionStart mapping:
  // startup -> session_start (fires on every new session load)
  // resume  -> session_before_switch(reason="resume")
  // compact -> session_compact (handled in compact-hooks.ts)
  //
  // SessionEnd mapping:
  // other -> session_shutdown
  pi.on("session_start", async (_event, ctx) => {
    await shared.triggerSessionStartHook("startup", ctx);
  });

  pi.on("session_before_switch", async (event, ctx) => {
    if (event.reason === "resume") {
      await shared.triggerSessionStartHook("resume", ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const reason = "other";

    // SessionEnd is always triggered by session_shutdown; matcher uses "other" only.
    const result = await triggerSessionHooks(
      "SessionEnd",
      reason,
      {
        sessionId: shared.getSessionId(ctx),
        cwd: ctx.cwd,
        hookEventName: "SessionEnd",
        reason,
        asyncContextSink: (content, details, triggerTurn) =>
          shared.injectHiddenContext(content, details, triggerTurn),
      },
      shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );

    if (result.additionalContext) {
      shared.injectHiddenContext(result.additionalContext, {
        hookEventName: "SessionEnd",
      });
    }
  });
}

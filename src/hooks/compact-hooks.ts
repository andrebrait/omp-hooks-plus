import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { HookModuleContext } from "../hook-context";
import type {
  HookExecutionContext,
  HookRunResult,
  NotifyFn,
  SettingsFile,
} from "../types";
import { triggerSimpleHooks } from "./shared";

async function triggerCompactHooks(
  eventName: "PreCompact" | "PostCompact",
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<HookRunResult> {
  return triggerSimpleHooks(eventName, context.trigger ?? "manual", context, settings, notify);
}

export function registerCompactHooks(pi: ExtensionAPI, shared: HookModuleContext) {
  pi.on("session_before_compact", async (event, ctx) => {
    const delivery = shared.captureContext();
    const trigger: "manual" | "auto" = "manual";
    const result = await triggerCompactHooks(
      "PreCompact",
      {
        sessionId: shared.getSessionId(ctx),
        cwd: ctx.cwd,
        hookEventName: "PreCompact",
        trigger,
        customInstructions: event.customInstructions ?? "",
        transcriptPath: ctx.sessionManager.getSessionFile(),
        asyncContextSink: delivery.injectHiddenContext,
      },
      await shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );

    for (const { source, text } of result.contexts ?? []) {
      delivery.injectHiddenContext(text, { hookEventName: "PreCompact", source });
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    const delivery = shared.captureContext();
    shared.resetInjectedContext();
    const trigger: "manual" | "auto" = "manual";

    const result = await triggerCompactHooks(
      "PostCompact",
      {
        sessionId: shared.getSessionId(ctx),
        cwd: ctx.cwd,
        hookEventName: "PostCompact",
        trigger,
        compactSummary: event.compactionEntry.summary,
        transcriptPath: ctx.sessionManager.getSessionFile(),
        asyncContextSink: delivery.injectHiddenContext,
      },
      await shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );
    if (!delivery.isActive()) return;

    for (const { source, text } of result.contexts ?? []) {
      delivery.injectHiddenContext(text, { hookEventName: "PostCompact", source });
    }

    await shared.triggerSessionStartHook("compact", ctx);
  });
}

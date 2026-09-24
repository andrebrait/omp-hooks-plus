import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { toClaudeToolName } from "../claude";
import { hookReminder, type HookModuleContext } from "../hook-context";
import { triggerSimpleHooks } from "./shared";

/** OMP writes a subagent's session to `<parent>/<agentId>.jsonl` beside `<parent>.jsonl`. */
function subagentSession(ctx: ExtensionContext): string | undefined {
  const file = ctx.sessionManager.getSessionFile();
  return file && existsSync(`${path.dirname(file)}.jsonl`) ? file : undefined;
}

/**
 * Near-equivalents for Claude events OMP has no direct counterpart for (see
 * APPROXIMATIONS in claude.ts). Registered only by generated extensions that
 * were converted with `--approximate`.
 */
export function registerApproximatedHooks(pi: ExtensionAPI, shared: HookModuleContext) {
  const briefed = new Set<string>();

  // OMP awaits these handlers before showing the approval prompt or ending the run, and
  // Notification output is ignored, so hooks run detached: a slow notifier never blocks.
  const notification = (ctx: ExtensionContext, notificationType: string, message: string) => {
    void shared.settingsFor(ctx).then(settings => triggerSimpleHooks("Notification", notificationType, {
      sessionId: shared.getSessionId(ctx),
      cwd: ctx.cwd,
      hookEventName: "Notification",
      transcriptPath: ctx.sessionManager.getSessionFile(),
      notificationType,
      message,
    }, settings, (msg, type) => shared.notify(ctx, msg, type))).catch(error => {
      shared.notify(ctx, `Notification hook failed: ${String(error)}`, "error");
    });
  };

  pi.on("tool_approval_requested", (event, ctx) =>
    notification(ctx, "permission_prompt", `Claude needs your permission to use ${toClaudeToolName(event.toolName)}`));

  pi.on("agent_end", (event, ctx) => {
    // An automatic continuation, a Stop-hook follow-up (the Stop handler runs first and
    // sets stopHookActive when it blocks), or a finishing subagent is not waiting for the user.
    if (event.willContinue || shared.stopHookActive || subagentSession(ctx)) return;
    notification(ctx, "idle_prompt", "Claude is waiting for your input");
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const file = subagentSession(ctx);
    if (!file || briefed.has(file)) return;
    briefed.add(file);
    const delivery = shared.captureContext();
    const result = await triggerSimpleHooks("SubagentStart", "", {
      sessionId: shared.getSessionId(ctx),
      cwd: ctx.cwd,
      hookEventName: "SubagentStart",
      transcriptPath: file,
      agentId: path.basename(file, ".jsonl"),
      asyncContextSink: delivery.injectHiddenContext,
    }, await shared.settingsFor(ctx), (msg, type) => shared.notify(ctx, msg, type));
    if (!delivery.isActive() || !result.additionalContext) return;
    const details = { hookEventName: "SubagentStart" } as const;
    return {
      message: { customType: "omp-hooks-plus", content: hookReminder(result.additionalContext, details), display: false, details },
    };
  });
}

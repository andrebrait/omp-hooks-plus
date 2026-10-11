import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { toClaudeToolName } from "../claude";
import { hookReminders, type HookModuleContext } from "../hook-context";
import { subagentIdentity } from "../subagent";
import type { SettingsFile } from "../types";
import { triggerSimpleHooks } from "./shared";

/**
 * Without an agent type (OMP < 18.5.1 has no `ctx.agent`) no matcher can be evaluated,
 * so only SubagentStart groups with no matcher, or `*`, apply.
 */
function untypedSubagentStart(settings: SettingsFile | undefined): SettingsFile | undefined {
  const groups = settings?.hooks?.SubagentStart;
  if (!settings || !groups) return settings;
  return {
    ...settings,
    hooks: { ...settings.hooks, SubagentStart: groups.filter(({ matcher }) => !matcher?.trim() || matcher.trim() === "*") },
  };
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
      ...shared.identityFor(ctx),
      cwd: ctx.cwd,
      hookEventName: "Notification",
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
    if (event.willContinue || shared.stopHookActive || subagentIdentity(ctx)) return;
    notification(ctx, "idle_prompt", "Claude is waiting for your input");
  });

  // Claude Code fires SubagentStart once, when the subagent is spawned; OMP's nearest
  // point is the subagent session's first run. SessionStart does not fire in a subagent.
  pi.on("before_agent_start", async (_event, ctx) => {
    const agent = subagentIdentity(ctx);
    if (!agent || briefed.has(agent.agentId)) return;
    briefed.add(agent.agentId);
    const delivery = shared.captureContext();
    const settings = await shared.settingsFor(ctx);
    const result = await triggerSimpleHooks("SubagentStart", agent.agentType ?? "", {
      ...shared.identityFor(ctx),
      cwd: ctx.cwd,
      hookEventName: "SubagentStart",
      agentTranscriptPath: agent.file,
      asyncContextSink: delivery.injectHiddenContext,
    }, agent.agentType === undefined ? untypedSubagentStart(settings) : settings, (msg, type) => shared.notify(ctx, msg, type));
    if (!delivery.isActive() || !result.contexts) return;
    const details = { hookEventName: "SubagentStart" } as const;
    return {
      message: { customType: "omp-hooks-plus", content: hookReminders(result.contexts, details), display: false, details },
    };
  });
}

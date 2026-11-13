import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { HookModuleContext } from "../hook-context";
import { subagentIdentity } from "../subagent";
import type {
  HookExecutionContext,
  HookMatcherValue,
  HookRunResult,
  NotifyFn,
  SessionEndReason,
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
  // SessionStart: session_start -> startup or resume; session_switch -> clear (new), resume, fork;
  // session_branch -> fork; session_compact -> compact (compact-hooks.ts). session_tree keeps the held context.
  // SessionEnd: session_switch new/resume -> clear/resume for the previous session; session_shutdown -> other.
  // Claude Code discards SessionEnd output, so nothing it returns is delivered.
  const runSessionEnd = async (
    ctx: ExtensionContext,
    reason: SessionEndReason,
    identity: { sessionId: string; transcriptPath?: string; cwd: string },
  ) => {
    // Claude Code never fires SessionEnd for a subagent.
    if (subagentIdentity(ctx)) return;
    await triggerSessionHooks(
      "SessionEnd",
      reason,
      { ...identity, hookEventName: "SessionEnd", reason },
      await shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    // A process started on an existing transcript (`--resume`, `--continue`) is a resume, as in Claude Code.
    const resumed = ctx.sessionManager.getEntries?.().some(entry => entry.type === "message" && entry.message.role === "assistant");
    await shared.triggerSessionStartHook(resumed ? "resume" : "startup", ctx);
  });

  // The switch can still be cancelled here, so only the outgoing session's identity is captured.
  let previous: { sessionId: string; transcriptPath?: string; cwd: string } | undefined;
  pi.on("session_before_switch", async (_event, ctx) => {
    previous = { sessionId: shared.getSessionId(ctx), transcriptPath: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd };
  });

  // A committed transition owns the session: older in-flight hooks and held context must not reach it.
  const commitTransition = () => {
    shared.resetSession();
    shared.setSessionContext(undefined, "SessionStart", true);
    return shared.captureContext();
  };

  pi.on("session_switch", async (event, ctx) => {
    const delivery = commitTransition();
    const ended = previous;
    previous = undefined;
    if (event.reason !== "fork" && ended) {
      await runSessionEnd(ctx, event.reason === "new" ? "clear" : "resume", ended);
      // A later switch may have committed while SessionEnd ran.
      if (!delivery.isActive()) return;
    }
    await shared.triggerSessionStartHook(event.reason === "new" ? "clear" : event.reason, ctx);
  });

  pi.on("session_branch", async (_event, ctx) => {
    previous = undefined;
    commitTransition();
    await shared.triggerSessionStartHook("fork", ctx);
  });

  // shortcut: OMP also runs this for each live-steering batch and marks no batch as one, so a
  // mid-stream steer re-sends the held context; skip steer batches once the host marks them.
  pi.on("context", (event) => {
    const message = shared.sessionContextMessage();
    if (!message) return;
    // After leading summaries, the same position on every request: the prefix stays byte-stable.
    const messages = [...event.messages];
    let index = 0;
    while (messages[index]?.role === "compactionSummary" || messages[index]?.role === "branchSummary") index++;
    // A copy: later handlers may edit request messages in place, and the held bytes must not change.
    messages.splice(index, 0, structuredClone(message));
    return { messages };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shared.dispose();
    await runSessionEnd(ctx, "other", { sessionId: shared.getSessionId(ctx), transcriptPath: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd });
  });
}

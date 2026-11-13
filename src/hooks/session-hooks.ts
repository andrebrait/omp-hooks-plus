import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SESSION_CONTEXT, type HookModuleContext } from "../hook-context";
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
  const runSessionEnd = async (
    ctx: ExtensionContext,
    reason: SessionEndReason,
    identity: { sessionId: string; transcriptPath?: string },
    deliver: boolean,
  ) => {
    // Claude Code never fires SessionEnd for a subagent.
    if (subagentIdentity(ctx)) return;
    const result = await triggerSessionHooks(
      "SessionEnd",
      reason,
      {
        ...identity,
        cwd: ctx.cwd,
        hookEventName: "SessionEnd",
        reason,
        asyncContextSink: deliver ? shared.captureContext().injectHiddenContext : undefined,
      },
      await shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );
    if (!deliver) return;
    for (const { source, text } of result.contexts ?? []) {
      shared.injectHiddenContext(text, { hookEventName: "SessionEnd", source });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // A process started on an existing transcript (`--resume`, `--continue`) is a resume, as in Claude Code.
    const resumed = ctx.sessionManager.getEntries?.().some(entry => entry.type === "message" && entry.message.role === "assistant");
    await shared.triggerSessionStartHook(resumed ? "resume" : "startup", ctx);
  });

  // The switch can still be cancelled here, so only the outgoing session's identity is captured.
  let previous: { sessionId: string; transcriptPath?: string } | undefined;
  pi.on("session_before_switch", async (_event, ctx) => {
    shared.resetSession();
    previous = { sessionId: shared.getSessionId(ctx), transcriptPath: ctx.sessionManager.getSessionFile() };
  });

  pi.on("session_switch", async (event, ctx) => {
    const ended = previous;
    previous = undefined;
    if (event.reason !== "fork" && ended) {
      // The previous session is over: its SessionEnd output has no session to reach.
      await runSessionEnd(ctx, event.reason === "new" ? "clear" : "resume", ended, false);
    }
    await shared.triggerSessionStartHook(event.reason === "new" ? "clear" : event.reason, ctx);
  });

  pi.on("session_branch", async (_event, ctx) => {
    await shared.triggerSessionStartHook("fork", ctx);
  });

  pi.on("context", (event) => {
    const message = shared.sessionContextMessage();
    const messages = event.messages.filter(entry => !(SESSION_CONTEXT in entry));
    if (message) {
      // After leading summaries, the same position on every request: the prefix stays byte-stable.
      let index = 0;
      while (messages[index]?.role === "compactionSummary" || messages[index]?.role === "branchSummary") index++;
      messages.splice(index, 0, message);
    }
    if (message || messages.length !== event.messages.length) return { messages };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shared.dispose();
    await runSessionEnd(ctx, "other", { sessionId: shared.getSessionId(ctx), transcriptPath: ctx.sessionManager.getSessionFile() }, true);
  });
}

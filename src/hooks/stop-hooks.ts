import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStopEventResult,
  SubagentStopEvent,
  SubagentStopEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { getHookGroups } from "../claude";
import { extractTextFromContent } from "../helpers";
import type { HookModuleContext } from "../hook-context";
import type {
  HookExecutionContext,
  NotifyFn,
  SettingsFile,
  StopResult,
} from "../types";
import {
  appendAdditionalContext,
  collectMatchingHooks,
  getStringField,
  runHooksParallel,
} from "./shared";

/** The two native stop passes this module adapts. */
type StopEventName = "Stop" | "SubagentStop";

/**
 * Reasons a blocking stop hook reports when it gave none itself. Claude Code
 * blocks on exit code 2 with stderr as the reason; an empty stderr still has to
 * name what happened, because the host only continues on a non-empty reason.
 */
const STOP_FALLBACK_REASONS: Record<
  StopEventName,
  { stderrExit: string; jsonBlock: string }
> = {
  Stop: {
    stderrExit: "Stop hook exited with code 2",
    jsonBlock: "Continue requested by Stop hook",
  },
  SubagentStop: {
    stderrExit: "SubagentStop hook exited with code 2",
    jsonBlock: "Continue requested by SubagentStop hook",
  },
};

/**
 * The host's own last-assistant-message view is authoritative; the transcript is
 * the fallback when the host reports no assistant message.
 */
function findLastAssistantMessageText(
  hostMessage: { role?: string; content?: unknown } | undefined,
  messages: unknown[],
): string {
  if (hostMessage?.role === "assistant") {
    return extractTextFromContent(hostMessage.content);
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      role?: string;
      content?: unknown;
    };

    if (message?.role === "assistant") {
      return extractTextFromContent(message.content);
    }
  }

  return "";
}

/**
 * Run one stop pass. `Stop` and `SubagentStop` share every rule that decides a
 * verdict — exit-code-2 blocking, JSON decisions, accumulated context,
 * cancellation — so they share this implementation and differ only in the event
 * they read hooks from and in the actor their matcher names.
 */
async function runStopHooks(
  eventName: StopEventName,
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<StopResult> {
  const groups = getHookGroups(settings, eventName);
  // A SubagentStop matcher names the child's agent type; Stop has no actor.
  const matcherValue = eventName === "SubagentStop" ? context.agentType ?? "" : "";
  const collected = collectMatchingHooks(groups, context, matcherValue);
  const results = await runHooksParallel(collected, context, eventName);
  const fallback = STOP_FALLBACK_REASONS[eventName];

  const result: StopResult = { blocked: false };
  const blockReasons: string[] = [];

  for (const { hookResult, jsonOutput, commonOutput, error } of results) {
    if (error) {
      if (!context.abortSignal?.aborted) {
        notify?.(`${eventName} execution error: ${String(error)}`, "error");
      }
      continue;
    }

    // The pass was cancelled while this hook ran: its process group was killed
    // and its output is not a verdict, so it neither blocks nor reports.
    if (hookResult.aborted) continue;

    if (hookResult.exitCode === 2) {
      blockReasons.push(hookResult.stderr.trim() || fallback.stderrExit);
      continue;
    }

    if (hookResult.exitCode === 0 && jsonOutput) {
      const additionalContext = getStringField(
        commonOutput?.hookSpecificOutput?.additionalContext,
        jsonOutput.additionalContext,
      );

      result.additionalContext = appendAdditionalContext(
        result.additionalContext,
        additionalContext,
      );

      if (commonOutput?.systemMessage) {
        notify?.(commonOutput.systemMessage, "warning");
      }

      if (
        jsonOutput.decision !== undefined &&
        jsonOutput.decision !== "block"
      ) {
        notify?.(
          `${eventName} ignoring invalid decision: ${String(jsonOutput.decision)}`,
          "warning",
        );
      }

      if (jsonOutput.decision === "block") {
        blockReasons.push(getStringField(jsonOutput.reason) ?? fallback.jsonBlock);
      }
    }

    if (hookResult.exitCode !== 0) {
      notify?.(
        `${eventName} failed (exit ${hookResult.exitCode}): ${hookResult.stderr}`,
        "error",
      );
    }
  }

  if (blockReasons.length > 0) {
    result.blocked = true;
    result.reason = blockReasons[0] ?? fallback.jsonBlock;
  }

  return result;
}

export async function triggerStopHooks(
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<StopResult> {
  return runStopHooks("Stop", context, settings, notify);
}

export async function triggerSubagentStopHooks(
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<StopResult> {
  return runStopHooks("SubagentStop", context, settings, notify);
}

/**
 * Map a completed stop pass to the host result. Both stop events accept the
 * same shape and follow the same precedence: a refusal becomes the native block
 * decision with every hook's accumulated context folded into its reason (a
 * block carries only `reason`), and context alone asks for a continuation.
 */
function toStopEventResult(
  result: StopResult,
  blockReasonFallback: string,
): SessionStopEventResult | undefined {
  if (result.blocked) {
    return {
      decision: "block",
      reason: [result.reason ?? blockReasonFallback, result.additionalContext]
        .filter((value): value is string => Boolean(value))
        .join("\n\n"),
    };
  }

  if (result.additionalContext) {
    return { continue: true, additionalContext: result.additionalContext };
  }

  return undefined;
}

/**
 * Run one native stop pass and return its verdict.
 *
 * The pass that started this run is gone by the time the hooks finish — the turn
 * was aborted, the user switched sessions, or the child run was cancelled. Its
 * verdict then belongs to a run nobody awaits, so it must not ask the host to
 * continue.
 */
async function runNativeStopPass(
  eventName: StopEventName,
  shared: HookModuleContext,
  ctx: ExtensionContext,
  signal: AbortSignal,
  context: HookExecutionContext,
  settings?: SettingsFile,
): Promise<SessionStopEventResult | undefined> {
  const delivery = shared.captureContext();
  const result = await runStopHooks(
    eventName,
    context,
    settings ?? await shared.settingsFor(ctx),
    (msg, type) => shared.notify(ctx, msg, type),
  );

  if (!delivery.isActive() || signal.aborted) return;

  return toStopEventResult(result, STOP_FALLBACK_REASONS[eventName].jsonBlock);
}

export function registerStopHooks(pi: ExtensionAPI, shared: HookModuleContext) {
  pi.on("session_stop", async (event, ctx): Promise<SessionStopEventResult | undefined> => {
    // The host event is the authority for Stop metadata; the bridge keeps no copy
    // of it between passes.
    return runNativeStopPass("Stop", shared, ctx, event.signal, {
      sessionId: event.session_id,
      cwd: ctx.cwd,
      hookEventName: "Stop",
      transcriptPath: event.session_file ?? ctx.sessionManager.getSessionFile(),
      stopHookActive: event.stop_hook_active,
      lastAssistantMessage: findLastAssistantMessageText(
        event.last_assistant_message,
        event.messages,
      ),
      abortSignal: event.signal,
    });
  });
}

export function registerSubagentStopHooks(pi: ExtensionAPI, shared: HookModuleContext) {
  pi.on(
    "subagent_stop",
    async (event: SubagentStopEvent, ctx): Promise<SubagentStopEventResult | undefined> => {
      const delivery = shared.captureContext();
      const settings = await shared.settingsFor(ctx);
      if (!delivery.isActive() || event.signal.aborted) return;
      const matching = collectMatchingHooks(
        getHookGroups(settings, "SubagentStop"),
        { hookEventName: "SubagentStop" },
        event.agent_type,
      );
      if (matching.length === 0) return;

      // Claude's SubagentStop payload splits identity: `session_id` and
      // `transcript_path` name the session that spawned the child, while
      // `agent_id`, `agent_type` and `agent_transcript_path` name the child run.
      // The child's own identity is never a stand-in for the parent's — a hook
      // keying state on `session_id` or reading `transcript_path` would then act
      // on the child session — so a pass the host reports without a parent
      // session id is refused with a diagnostic instead of being run against the
      // child. A cancelled run voids the pass and its diagnostics.
      if (!event.parent_session_id) {
        if (!event.signal.aborted) {
          shared.notify(
            ctx,
            "SubagentStop hooks skipped: the child run reported no parent session id, and the child session is not a substitute for it",
            "error",
          );
        }
        return;
      }

      // The spawning session's transcript is optional in the host event. When it
      // is absent, hook input omits `transcript_path` rather than carrying the
      // child's file, and the operator is told which field is missing.
      if (!event.parent_session_file && !event.signal.aborted) {
        shared.notify(
          ctx,
          "SubagentStop hooks: the spawning session reported no transcript file, so hook input omits transcript_path",
          "warning",
        );
      }

      return runNativeStopPass("SubagentStop", shared, ctx, event.signal, {
        // Parent identity in the common fields, the child run in the agent_* fields.
        sessionId: event.parent_session_id,
        transcriptPath: event.parent_session_file,
        // This pass runs in the child's own context, so `cwd` is the child's
        // current working directory (a subagent may run in another worktree),
        // and the session manager is the child's for the transcript fallback.
        cwd: ctx.cwd,
        hookEventName: "SubagentStop",
        agentId: event.agent_id,
        agentType: event.agent_type,
        agentTranscriptPath:
          event.session_file ?? ctx.sessionManager.getSessionFile(),
        stopHookActive: event.stop_hook_active,
        lastAssistantMessage: findLastAssistantMessageText(
          event.last_assistant_message,
          event.messages,
        ),
        abortSignal: event.signal,
      }, settings);
    },
  );
}

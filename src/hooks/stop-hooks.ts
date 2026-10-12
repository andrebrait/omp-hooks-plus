import type {
  ExtensionAPI,
  SessionStopEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { getHookGroups } from "../claude";
import { extractTextFromContent } from "../helpers";
import { hookReminders, type HookModuleContext } from "../hook-context";
import { subagentIdentity } from "../subagent";
import type {
  HookExecutionContext,
  NotifyFn,
  SettingsFile,
  StopResult,
} from "../types";
import {
  addContext,
  collectMatchingHooks,
  getStringField,
  runHooksParallel,
} from "./shared";

/**
 * Reasons a blocking Stop hook reports when it gave none itself. Claude Code
 * blocks on exit code 2 with stderr as the reason; an empty stderr still has to
 * name what happened, because the host only continues on a non-empty reason.
 */
const STDERR_EXIT_REASON = "Stop hook exited with code 2";
const JSON_BLOCK_REASON = "Continue requested by Stop hook";

function findLastAssistantMessageText(messages: unknown[]): string {
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

export async function triggerStopHooks(
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<StopResult> {
  const groups = getHookGroups(settings, "Stop");
  const collected = collectMatchingHooks(groups, context, "");
  const results = await runHooksParallel(collected, context, "Stop");

  const result: StopResult = { blocked: false };
  const blockReasons: string[] = [];

  for (const { hook, hookResult, jsonOutput, commonOutput, error } of results) {
    if (error) {
      if (!context.abortSignal?.aborted) {
        notify?.(`Stop execution error: ${String(error)}`, "error");
      }
      continue;
    }

    // The pass was cancelled while this hook ran: its process group was killed
    // and its output is not a verdict, so it neither blocks nor reports.
    if (hookResult.aborted) continue;

    if (hookResult.exitCode === 2) {
      blockReasons.push(hookResult.stderr.trim() || STDERR_EXIT_REASON);
      continue;
    }

    if (hookResult.exitCode === 0 && jsonOutput) {
      const additionalContext = getStringField(
        commonOutput?.hookSpecificOutput?.additionalContext,
        jsonOutput.additionalContext,
      );

      result.contexts = addContext(result.contexts, hook, additionalContext);

      if (commonOutput?.systemMessage) {
        notify?.(commonOutput.systemMessage, "warning");
      }

      if (
        jsonOutput.decision !== undefined &&
        jsonOutput.decision !== "block"
      ) {
        notify?.(
          `Stop ignoring invalid decision: ${String(jsonOutput.decision)}`,
          "warning",
        );
      }

      if (jsonOutput.decision === "block") {
        blockReasons.push(
          getStringField(jsonOutput.reason) ?? JSON_BLOCK_REASON,
        );
      }
    }

    if (hookResult.exitCode !== 0) {
      notify?.(
        `Stop failed (exit ${hookResult.exitCode}): ${hookResult.stderr}`,
        "error",
      );
    }
  }

  if (blockReasons.length > 0) {
    result.blocked = true;
    result.reason = blockReasons[0] ?? JSON_BLOCK_REASON;
  }

  return result;
}

export function registerStopHooks(pi: ExtensionAPI, shared: HookModuleContext) {
  pi.on("session_stop", async (event, ctx): Promise<SessionStopEventResult | undefined> => {
    // Claude Code's Stop never fires for a subagent (that is SubagentStop), and OMP does
    // not emit session_stop for one; this keeps the lifecycle skip explicit and host-independent.
    if (subagentIdentity(ctx)) return;

    const delivery = shared.captureContext();
    // The host event is the authority for Stop metadata; the bridge keeps no copy
    // of it between passes.
    const hostLastAssistantMessage: { role?: string; content?: unknown } | undefined =
      event.last_assistant_message;
    const result = await triggerStopHooks(
      {
        sessionId: event.session_id,
        cwd: ctx.cwd,
        hookEventName: "Stop",
        transcriptPath: event.session_file ?? ctx.sessionManager.getSessionFile(),
        stopHookActive: event.stop_hook_active,
        lastAssistantMessage:
          hostLastAssistantMessage?.role === "assistant"
            ? extractTextFromContent(hostLastAssistantMessage.content)
            : findLastAssistantMessageText(event.messages),
        abortSignal: event.signal,
      },
      await shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );

    // The settle pass that started this run is gone — the turn was aborted or the
    // user switched sessions. Its verdict belongs to a turn nobody awaits, so it
    // must not ask the host to continue.
    if (!delivery.isActive() || event.signal.aborted) return;

    // Claude Code delivers the block reason as Stop feedback and any hook context
    // beside it as its own named hook reminder. A native block carries only `reason`,
    // so both ride in it.
    const context = result.contexts ? hookReminders(result.contexts, { hookEventName: "Stop" }) : undefined;

    if (result.blocked) {
      return {
        decision: "block",
        reason: [result.reason ?? JSON_BLOCK_REASON, context]
          .filter((value): value is string => Boolean(value))
          .join("\n\n"),
      };
    }

    if (context) return { continue: true, additionalContext: context };

    return;
  });
}

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getHookGroups, toClaudeToolName } from "../claude";
import { extractErrorFromContent } from "../helpers";
import { hookReminder, type HookModuleContext } from "../hook-context";
import type {
  HookExecutionContext,
  NotifyFn,
  PostToolUseResult,
  PreToolUseResult,
  SettingsFile,
} from "../types";
import {
  addContext,
  collectMatchingHooks,
  type HookExecResult,
  extractToolResultPatch,
  getStringField,
  runHooksParallel,
} from "./shared";

export async function triggerPreToolUseHooks(
  toolName: string,
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<PreToolUseResult> {
  const groups = getHookGroups(settings, "PreToolUse");
  const claudeToolName = toClaudeToolName(toolName);

  const collected = collectMatchingHooks(groups, context, claudeToolName, [
    toolName,
  ]);
  const results = await runHooksParallel(collected, context, "PreToolUse");

  const result: PreToolUseResult = { blocked: false };
  const denyReasons: string[] = [];
  const askReasons: string[] = [];
  let deny = false;

  // First pass: stopProcessing wins over everything (even deny)
  for (const exec of results) {
    if (exec.error) {
      notify?.(`PreToolUse execution error: ${String(exec.error)}`, "error");
      continue;
    }
    if (exec.commonOutput?.stopProcessing) {
      result.stopProcessing = true;
      result.stopReason = exec.commonOutput.stopReason;
      notify?.(`PreToolUse stopped processing: ${result.stopReason ?? ""}`, "warning");
      break;
    }
  }

  // If not stopped, second pass: collect deny (deny-wins), updatedInput (merge in order), context
  for (const { hook, hookResult, jsonOutput, commonOutput, error } of results) {
    if (error) continue;

    if (hookResult.exitCode === 2) {
      deny = true;
      denyReasons.push(hookResult.stderr || "Blocked by hook");
      continue;
    }

    if (hookResult.exitCode === 0 && jsonOutput) {
      const hookSpecific = commonOutput?.hookSpecificOutput;

      const decision = (hookSpecific?.permissionDecision ??
        jsonOutput.permissionDecision) as
        | "allow"
        | "deny"
        | "ask"
        | undefined;

      if (decision === "deny") {
        deny = true;
        denyReasons.push(
          (hookSpecific?.permissionDecisionReason ??
            jsonOutput.permissionDecisionReason) as string | undefined ??
            "Blocked by hook",
        );
        continue;
      }
      if (decision === "ask") {
        askReasons.push(
          (hookSpecific?.permissionDecisionReason ??
            jsonOutput.permissionDecisionReason) as string | undefined ??
            "Hook requested permission",
        );
      }

      if (
        (hookSpecific?.updatedInput ?? jsonOutput.updatedInput) &&
        typeof (hookSpecific?.updatedInput ?? jsonOutput.updatedInput) === "object"
      ) {
        result.updatedInput = {
          ...(result.updatedInput ?? {}),
          ...((hookSpecific?.updatedInput ?? jsonOutput.updatedInput) as Record<
            string,
            unknown
          >),
        };
      }

      const additionalContext = getStringField(
        hookSpecific?.additionalContext,
        jsonOutput.additionalContext,
      );
      result.contexts = addContext(result.contexts, hook, additionalContext);
    }

    if (hookResult.exitCode !== 0 && hookResult.exitCode !== 2) {
      notify?.(
        `PreToolUse failed (exit ${hookResult.exitCode}): ${hookResult.stderr}`,
        "error",
      );
    }
  }

  if (deny) {
    result.blocked = true;
    result.reason = denyReasons[0];
    notify?.(`PreToolUse denied: ${result.reason}`, "warning");
  } else if (askReasons.length > 0) {
    result.confirmationReason = askReasons.join("\n");
  }

  return result;
}

/**
 * Merge logic for PostToolUse / PostToolUseFailure:
 * - stopProcessing wins over everything (collected first)
 * - first non-undefined content/details/isError wins (earlier-defined hook)
 * - context entries appended in config order, per source
 */
function mergePostToolUseResults(
  results: HookExecResult[],
  result: PostToolUseResult,
  notify?: NotifyFn,
): void {
  // First pass: stopProcessing wins
  for (const exec of results) {
    if (exec.error) {
      notify?.(`PostToolUse execution error: ${String(exec.error)}`, "error");
      continue;
    }
    if (exec.commonOutput?.stopProcessing) {
      result.stopProcessing = true;
      result.stopReason = exec.commonOutput.stopReason;
      break;
    }
  }

  // Second pass: patch + context in order
  for (const { hook, hookResult, jsonOutput, commonOutput, error } of results) {
    if (error) continue;

    if (hookResult.exitCode === 2) {
      notify?.(`PostToolUse feedback: ${hookResult.stderr}`, "warning");
      continue;
    }

    if (hookResult.exitCode === 0 && jsonOutput) {
      const hookSpecific = commonOutput?.hookSpecificOutput;

      const additionalContext = getStringField(
        hookSpecific?.additionalContext,
        jsonOutput.additionalContext,
        jsonOutput.decision === "block" ? jsonOutput.reason : undefined,
      );

      result.contexts = addContext(result.contexts, hook, additionalContext);

      const patch = extractToolResultPatch("PostToolUse", jsonOutput);
      if (result.content === undefined && patch.content !== undefined) {
        result.content = patch.content;
      }
      if (result.details === undefined && patch.details !== undefined) {
        result.details = patch.details;
      }
      if (result.isError === undefined && patch.isError !== undefined) {
        result.isError = patch.isError;
      }
    }

    if (hookResult.exitCode !== 0 && hookResult.exitCode !== 2) {
      notify?.(
        `PostToolUse failed (exit ${hookResult.exitCode}): ${hookResult.stderr}`,
        "error",
      );
    }
  }
}

export async function triggerPostToolUseHooks(
  toolName: string,
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<PostToolUseResult> {
  const groups = getHookGroups(settings, "PostToolUse");
  const claudeToolName = toClaudeToolName(toolName);

  const collected = collectMatchingHooks(groups, context, claudeToolName, [
    toolName,
  ]);
  const results = await runHooksParallel(collected, context, "PostToolUse");

  const result: PostToolUseResult = {};
  mergePostToolUseResults(results, result, notify);
  return result;
}

export async function triggerPostToolUseFailureHooks(
  toolName: string,
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<PostToolUseResult> {
  const groups = getHookGroups(settings, "PostToolUseFailure");
  const claudeToolName = toClaudeToolName(toolName);

  const collected = collectMatchingHooks(groups, context, claudeToolName, [
    toolName,
  ]);
  const results = await runHooksParallel(collected, context, "PostToolUseFailure");

  const result: PostToolUseResult = {};
  mergePostToolUseResults(results, result, notify);
  return result;
}

function replacementContent(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return [{ type: "text" as const, text: text ?? String(value) }];
}

export function registerToolHooks(pi: ExtensionAPI, shared: HookModuleContext) {
  // Synchronous tool-hook context leads that call's own result, the way OMP's per-tool
  // rule reminders do: every qualifying call carries its reminder, next to its output.
  const pendingPre = new Map<string, { reminders: string[]; isActive: () => boolean }>();
  // Every tool result arrives before its run ends; a call without one (aborted) is dropped here.
  pi.on("agent_end", () => pendingPre.clear());

  pi.on("tool_call", async (event, ctx) => {
    const delivery = shared.captureContext();
    const result = await triggerPreToolUseHooks(
      event.toolName,
      {
        sessionId: shared.getSessionId(ctx),
        cwd: ctx.cwd,
        hookEventName: "PreToolUse",
        transcriptPath: ctx.sessionManager.getSessionFile(),
        toolName: event.toolName,
        toolInput: event.input as Record<string, unknown>,
        toolUseId: event.toolCallId,
        asyncContextSink: delivery.injectHiddenContext,
      },
      await shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );
    // A stale event must never become implicit permission to execute a tool.
    if (!delivery.isActive()) {
      return { block: true, reason: result.reason ?? result.stopReason ?? "Hook completed after the session changed" };
    }

    if (result.updatedInput) {
      Object.assign(event.input, result.updatedInput);
    }

    if (result.stopProcessing) {
      const stopReason = result.stopReason ?? "Stopped by hook";
      ctx.abort?.();
      return { block: true, reason: stopReason };
    }

    if (result.blocked) {
      return { block: true, reason: result.reason };
    }
    if (result.confirmationReason) {
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `Blocked (no UI): ${result.confirmationReason}`,
        };
      }
      const approved = await ctx.ui.confirm(
        "Claude hook permission",
        result.confirmationReason,
        { timeout: 30_000 },
      );
      if (!approved || !delivery.isActive()) {
        return { block: true, reason: result.confirmationReason };
      }
    }

    if (result.contexts) {
      pendingPre.set(event.toolCallId, {
        reminders: result.contexts.map(({ source, text }) =>
          hookReminder(text, { hookEventName: "PreToolUse", toolName: event.toolName, source })),
        isActive: delivery.isActive,
      });
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const delivery = shared.captureContext();
    const pre = pendingPre.get(event.toolCallId);
    pendingPre.delete(event.toolCallId);
    const hookEventName = event.isError ? "PostToolUseFailure" : "PostToolUse";
    const context: HookExecutionContext = {
      sessionId: shared.getSessionId(ctx),
      cwd: ctx.cwd,
      hookEventName,
      transcriptPath: ctx.sessionManager.getSessionFile(),
      toolName: event.toolName,
      toolInput: event.input as Record<string, unknown>,
      toolUseId: event.toolCallId,
      asyncContextSink: delivery.injectHiddenContext,
      ...(event.isError
        ? { error: extractErrorFromContent(event.content), isInterrupt: false }
        : { toolResponse: shared.buildToolResponse(event) }),
    };
    const settings = await shared.settingsFor(ctx);
    const notify: NotifyFn = (msg, type) => shared.notify(ctx, msg, type);
    const result = event.isError
      ? await triggerPostToolUseFailureHooks(event.toolName, context, settings, notify)
      : await triggerPostToolUseHooks(event.toolName, context, settings, notify);

    if (result.stopProcessing && delivery.isActive()) {
      ctx.abort?.();
    }

    const reminders = [
      ...(pre?.isActive() ? pre.reminders : []),
      ...(delivery.isActive()
        ? (result.contexts ?? []).map(({ source, text }) =>
            hookReminder(text, { hookEventName, toolName: event.toolName, source }))
        : []),
    ];
    const patched = result.content !== undefined || result.details !== undefined || result.isError !== undefined;
    if (!patched && reminders.length === 0) return;
    return {
      content: [
        ...reminders.map((text) => ({ type: "text" as const, text })),
        ...(result.content === undefined ? event.content : replacementContent(result.content)),
      ],
      details: result.details ?? event.details,
      isError: result.isError ?? event.isError,
    };
  });
}

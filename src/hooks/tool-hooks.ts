import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getHookGroups, toClaudeToolName } from "../config";
import { extractErrorFromContent } from "../helpers";
import type { HookModuleContext } from "../hook-context";
import type {
  HookExecutionContext,
  NotifyFn,
  PostToolUseResult,
  PreToolUseResult,
  SettingsFile,
} from "../types";
import {
  appendAdditionalContext,
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
      notify?.(`PreToolUse 执行错误: ${String(exec.error)}`, "error");
      continue;
    }
    if (exec.commonOutput?.stopProcessing) {
      result.stopProcessing = true;
      result.stopReason = exec.commonOutput.stopReason;
      notify?.(`PreToolUse 停止处理: ${result.stopReason ?? ""}`, "warning");
      break;
    }
  }

  // If not stopped, second pass: collect deny (deny-wins), updatedInput (merge in order), context
  for (const { hookResult, plainStdout, jsonOutput, commonOutput, error } of results) {
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
      result.additionalContext = appendAdditionalContext(
        result.additionalContext,
        additionalContext,
      );
    } else if (hookResult.exitCode === 0 && plainStdout) {
      notify?.(`PreToolUse 输出 (非JSON): ${plainStdout}`, "info");
    }

    if (hookResult.exitCode !== 0 && hookResult.exitCode !== 2) {
      notify?.(
        `PreToolUse 失败 (exit ${hookResult.exitCode}): ${hookResult.stderr}`,
        "error",
      );
    }
  }

  if (deny) {
    result.blocked = true;
    result.reason = denyReasons[0];
    notify?.(`PreToolUse 拒绝: ${result.reason}`, "warning");
  } else if (askReasons.length > 0) {
    result.confirmationReason = askReasons.join("\n");
  }

  return result;
}

/**
 * Merge logic for PostToolUse / PostToolUseFailure:
 * - stopProcessing wins over everything (collected first)
 * - first non-undefined content/details/isError wins (earlier-defined hook)
 * - additionalContext concatenated in config order
 */
function mergePostToolUseResults(
  results: HookExecResult[],
  result: PostToolUseResult,
  notify?: NotifyFn,
): void {
  // First pass: stopProcessing wins
  for (const exec of results) {
    if (exec.error) {
      notify?.(`PostToolUse 执行错误: ${String(exec.error)}`, "error");
      continue;
    }
    if (exec.commonOutput?.stopProcessing) {
      result.stopProcessing = true;
      result.stopReason = exec.commonOutput.stopReason;
      break;
    }
  }

  // Second pass: patch + context in order
  for (const { hookResult, plainStdout, jsonOutput, commonOutput, error } of results) {
    if (error) continue;

    if (hookResult.exitCode === 2) {
      notify?.(`PostToolUse 反馈: ${hookResult.stderr}`, "warning");
      continue;
    }

    if (hookResult.exitCode === 0 && jsonOutput) {
      const hookSpecific = commonOutput?.hookSpecificOutput;

      const additionalContext = getStringField(
        hookSpecific?.additionalContext,
        jsonOutput.additionalContext,
        jsonOutput.decision === "block" ? jsonOutput.reason : undefined,
      );

      result.additionalContext = appendAdditionalContext(
        result.additionalContext,
        additionalContext,
      );

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
    } else if (hookResult.exitCode === 0 && plainStdout) {
      notify?.(`PostToolUse 输出: ${plainStdout}`, "info");
    }

    if (hookResult.exitCode !== 0 && hookResult.exitCode !== 2) {
      notify?.(
        `PostToolUse 失败 (exit ${hookResult.exitCode}): ${hookResult.stderr}`,
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
  pi.on("tool_call", async (event, ctx) => {
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
        asyncContextSink: (content, details, triggerTurn) =>
          shared.injectHiddenContext(content, details, triggerTurn),
      },
      shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );

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
      if (!approved) {
        return { block: true, reason: result.confirmationReason };
      }
    }


    if (result.additionalContext) {
      shared.injectHiddenContext(result.additionalContext, {
        hookEventName: "PreToolUse",
        toolName: event.toolName,
        toolUseId: event.toolCallId,
      });
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) {
      const result = await triggerPostToolUseFailureHooks(
        event.toolName,
        {
          sessionId: shared.getSessionId(ctx),
          cwd: ctx.cwd,
          hookEventName: "PostToolUseFailure",
          transcriptPath: ctx.sessionManager.getSessionFile(),
          toolName: event.toolName,
          toolInput: event.input as Record<string, unknown>,
          toolUseId: event.toolCallId,
          error: extractErrorFromContent(event.content),
          isInterrupt: false,
          asyncContextSink: (content, details, triggerTurn) =>
            shared.injectHiddenContext(content, details, triggerTurn),
        },
        shared.settingsFor(ctx),
        (msg, type) => shared.notify(ctx, msg, type),
      );

      if (result.additionalContext) {
        shared.injectHiddenContext(result.additionalContext, {
          hookEventName: "PostToolUseFailure",
          toolName: event.toolName,
          toolUseId: event.toolCallId,
        });
      }

      if (result.stopProcessing) {
        ctx.abort?.();
      }

      if (
        result.content !== undefined ||
        result.details !== undefined ||
        result.isError !== undefined
      ) {
        return {
          content:
            result.content === undefined
              ? event.content
              : replacementContent(result.content),
          details: result.details ?? event.details,
          isError: result.isError ?? event.isError,
        };
      }

      return;
    }

    const result = await triggerPostToolUseHooks(
      event.toolName,
      {
        sessionId: shared.getSessionId(ctx),
        cwd: ctx.cwd,
        hookEventName: "PostToolUse",
        transcriptPath: ctx.sessionManager.getSessionFile(),
        toolName: event.toolName,
        toolInput: event.input as Record<string, unknown>,
        toolUseId: event.toolCallId,
        toolResponse: shared.buildToolResponse(event),
        asyncContextSink: (content, details, triggerTurn) =>
          shared.injectHiddenContext(content, details, triggerTurn),
      },
      shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );

    if (result.additionalContext) {
      shared.injectHiddenContext(result.additionalContext, {
        hookEventName: "PostToolUse",
        toolName: event.toolName,
        toolUseId: event.toolCallId,
      });
    }

    if (result.stopProcessing) {
      ctx.abort?.();
    }

    if (
      result.content !== undefined ||
      result.details !== undefined ||
      result.isError !== undefined
    ) {
      return {
        content:
          result.content === undefined
            ? event.content
            : replacementContent(result.content),
        details: result.details ?? event.details,
        isError: result.isError ?? event.isError,
      };
    }
  });
}

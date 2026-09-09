import { getHookGroups, matcherMatches, toClaudeToolName } from "../config";
import { buildHookInput, executeHook, executeHookAsync, getHookTimeoutMs } from "../executor";
import type {
  Hook,
  HookExecutionContext,
  HookEventName,
  HookGroup,
  HookRunResult,
  NotifyFn,
  SettingsFile,
  ToolResultPatch,
} from "../types";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const regex = `^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`;
  return new RegExp(regex, "i");
}

function getToolInputMatchValue(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string {
  if (!toolInput) return "";

  const normalizedToolName = toolName.toLowerCase();
  const getString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = toolInput[key];
      if (typeof value === "string") return value;
    }
    return undefined;
  };

  switch (normalizedToolName) {
    case "bash":
      return getString("command") ?? JSON.stringify(toolInput);
    case "read":
    case "write":
    case "edit":
      return getString("path", "file_path") ?? JSON.stringify(toolInput);
    case "grep":
    case "find":
    case "glob":
      return getString("pattern", "path") ?? JSON.stringify(toolInput);
    case "ls":
      return getString("path") ?? JSON.stringify(toolInput);
    default:
      return JSON.stringify(toolInput);
  }
}

export function hookIfMatches(
  context: HookExecutionContext,
  condition: string | undefined,
): boolean {
  if (!condition) return true;

  if (
    context.hookEventName !== "PreToolUse" &&
    context.hookEventName !== "PostToolUse" &&
    context.hookEventName !== "PostToolUseFailure"
  ) {
    return false;
  }

  const toolName = context.toolName ?? "";
  const trimmed = condition.trim();
  const match = trimmed.match(/^([^()]+?)(?:\((.*)\))?$/);
  if (!match) return false;

  const expectedToolName = match[1].trim();
  const inputPattern = match[2];

  if (expectedToolName) {
    const candidates = [toolName, toClaudeToolName(toolName)].map((name) =>
      name.toLowerCase(),
    );
    if (!candidates.includes(expectedToolName.toLowerCase())) {
      return false;
    }
  }

  if (inputPattern === undefined) {
    return true;
  }

  const target = getToolInputMatchValue(toolName, context.toolInput);
  return globToRegex(inputPattern).test(target);
}

export function appendAdditionalContext(
  current: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!next) return current;
  return current ? `${current}\n${next}` : next;
}

export function parseJsonOutput(
  stdout: string,
): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function getHookSpecificOutput(
  eventName: HookEventName,
  jsonOutput: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    typeof jsonOutput.hookSpecificOutput !== "object" ||
    jsonOutput.hookSpecificOutput === null
  ) {
    return undefined;
  }

  const hookSpecificOutput = jsonOutput.hookSpecificOutput as Record<
    string,
    unknown
  >;
  const hookEventName = hookSpecificOutput.hookEventName;
  if (typeof hookEventName === "string" && hookEventName !== eventName) {
    return undefined;
  }

  return hookSpecificOutput;
}

export function getStringField(
  ...values: Array<string | unknown>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

/** Common output fields extracted from hook JSON, shared across all events. */
export type CommonHookOutput = {
  hookSpecificOutput?: Record<string, unknown>;
  systemMessage?: string;
  stopProcessing: boolean;
  stopReason?: string;
};

export function extractCommonOutput(
  eventName: HookEventName,
  jsonOutput: Record<string, unknown>,
): CommonHookOutput {
  const hookSpecificOutput = getHookSpecificOutput(eventName, jsonOutput);

  return {
    hookSpecificOutput,
    systemMessage: getStringField(jsonOutput.systemMessage),
    stopProcessing: jsonOutput.continue === false,
    stopReason: getStringField(jsonOutput.stopReason),
  };
}

export function extractToolResultPatch(
  eventName: HookEventName,
  jsonOutput: Record<string, unknown>,
): ToolResultPatch {
  const hookSpecificOutput = getHookSpecificOutput(eventName, jsonOutput);

  // Claude Code field: updatedToolOutput (replaces tool output before sending to model)
  const updatedToolOutput = hookSpecificOutput?.updatedToolOutput;

  // Legacy omp-hooks field: updatedToolResult (invented pre-v0.0.4, kept for compat)
  const updatedToolResult =
    typeof hookSpecificOutput?.updatedToolResult === "object" &&
    hookSpecificOutput.updatedToolResult !== null
      ? (hookSpecificOutput.updatedToolResult as Record<string, unknown>)
      : undefined;

  // Claude Code field: updatedMCPToolOutput (MCP-specific, prefer updatedToolOutput)
  const updatedMCPToolOutput =
    hookSpecificOutput?.updatedMCPToolOutput ?? jsonOutput.updatedMCPToolOutput;

  return {
    // Priority: updatedToolOutput (Claude) > updatedToolResult.content (legacy) > updatedMCPToolOutput > fallback
    content:
      updatedToolOutput ?? updatedToolResult?.content ?? updatedMCPToolOutput ?? jsonOutput.content,
    details: updatedToolResult?.details ?? jsonOutput.details,
    isError:
      typeof (updatedToolResult?.isError ?? jsonOutput.isError) === "boolean"
        ? ((updatedToolResult?.isError ?? jsonOutput.isError) as boolean)
        : undefined,
  };
}

export async function executeParsedHook(
  hook: Hook,
  context: HookExecutionContext,
  eventName: HookEventName,
): Promise<{
  hookResult: { stdout: string; stderr: string; exitCode: number };
  plainStdout: string;
  jsonOutput?: Record<string, unknown>;
  commonOutput?: CommonHookOutput;
}> {
  const input = buildHookInput(context);
  const timeout = getHookTimeoutMs(hook, eventName);

  if (hook.async || hook.asyncRewake) {
    executeHookAsync(hook, input, context.cwd, timeout, (hookResult) => {
      const jsonOutput = hookResult.stdout
        ? parseJsonOutput(hookResult.stdout)
        : undefined;
      const commonOutput = jsonOutput
        ? extractCommonOutput(eventName, jsonOutput)
        : undefined;
      const additionalContext = jsonOutput
        ? getStringField(
            commonOutput?.hookSpecificOutput?.additionalContext,
            jsonOutput.additionalContext,
          )
        : undefined;

      if (additionalContext) {
        context.asyncContextSink?.(additionalContext, {
          hookEventName: eventName,
          async: true,
        });
      }

      if (hook.asyncRewake && hookResult.exitCode === 2) {
        const reminder =
          getStringField(
            hookResult.stderr,
            hookResult.stdout,
            "Async hook exited with code 2",
          ) ?? "Async hook exited with code 2";
        context.asyncContextSink?.(
          reminder,
          {
            hookEventName: eventName,
            async: true,
            asyncRewake: true,
          },
          true,
        );
      }
    });

    return {
      hookResult: { stdout: "", stderr: "", exitCode: 0 },
      plainStdout: "",
    };
  }

  const hookResult = await executeHook(hook, input, context.cwd, timeout);
  const jsonOutput = hookResult.stdout
    ? parseJsonOutput(hookResult.stdout)
    : undefined;
  const plainStdout = hookResult.stdout.trim();

  return {
    hookResult,
    plainStdout,
    jsonOutput,
    commonOutput: jsonOutput
      ? extractCommonOutput(eventName, jsonOutput)
      : undefined,
  };
}
// ============================================================================
// Parallel hook execution helpers (matches Claude Code behavior:
// "All matching hooks run in parallel, and identical handlers are
// deduplicated automatically.")
// ============================================================================

/** Dedup key: command + JSON(args). Matches Claude Code's dedup for command hooks. */
function hookDedupeKey(hook: Hook): string {
  return hook.args ? `${hook.command}\0${JSON.stringify(hook.args)}` : hook.command;
}

/** A hook paired with its original config index for stable ordering. */
export type CollectedHook = { hook: Hook; originalIndex: number };

/** Result of a single parallel hook execution. */
export type HookExecResult = {
  hook: Hook;
  originalIndex: number;
  hookResult: { stdout: string; stderr: string; exitCode: number };
  plainStdout: string;
  jsonOutput?: Record<string, unknown>;
  commonOutput?: CommonHookOutput;
  error?: unknown;
};

/**
 * Collect matching hooks across groups, filter by matcher + if, and deduplicate
 * by command+args (Claude Code dedup rule). Returns hooks in config order.
 */
export function collectMatchingHooks(
  groups: HookGroup[],
  context: HookExecutionContext,
  matcherValue: string,
  aliases: string[] = [],
  effectiveMatcherFn?: (group: HookGroup) => string | undefined,
): CollectedHook[] {
  const collected: CollectedHook[] = [];
  const seen = new Set<string>();
  let index = 0;

  for (const group of groups) {
    const matcher = effectiveMatcherFn ? effectiveMatcherFn(group) : group.matcher;
    if (!matcherMatches(matcher, matcherValue, aliases)) {
      index += group.hooks?.length ?? 0;
      continue;
    }

    for (const hook of group.hooks ?? []) {
      const i = index++;
      if (hook.if && !hookIfMatches(context, hook.if)) continue;

      const key = hookDedupeKey(hook);
      if (seen.has(key)) continue;
      seen.add(key);

      collected.push({ hook, originalIndex: i });
    }
  }

  return collected;
}

/**
 * Run all collected hooks in parallel via Promise.allSettled.
 * Returns results sorted by originalIndex (deterministic order).
 */
export async function runHooksParallel(
  collected: CollectedHook[],
  context: HookExecutionContext,
  eventName: HookEventName,
): Promise<HookExecResult[]> {
  if (collected.length === 0) return [];

  if (collected.length === 1) {
    const { hook, originalIndex } = collected[0];
    try {
      const result = await executeParsedHook(hook, context, eventName);
      return [{ hook, originalIndex, ...result }];
    } catch (error) {
      return [{
        hook,
        originalIndex,
        hookResult: { stdout: "", stderr: String(error), exitCode: 1 },
        plainStdout: "",
        error,
      }];
    }
  }

  const settled = await Promise.allSettled(
    collected.map(({ hook }) => executeParsedHook(hook, context, eventName)),
  );

  const results: HookExecResult[] = settled.map((outcome, i) => {
    const { hook, originalIndex } = collected[i];
    if (outcome.status === "fulfilled") {
      return { hook, originalIndex, ...outcome.value };
    }
    return {
      hook,
      originalIndex,
      hookResult: { stdout: "", stderr: String(outcome.reason), exitCode: 1 },
      plainStdout: "",
      error: outcome.reason,
    };
  });

  results.sort((a, b) => a.originalIndex - b.originalIndex);
  return results;
}


// ============================================================================
// Trigger functions (use parallel execution)
// ============================================================================

export async function triggerSimpleHooks(
  eventName: HookEventName,
  matcherValue: string,
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<HookRunResult> {
  const groups = getHookGroups(settings, eventName);
  const collected = collectMatchingHooks(
    groups,
    context,
    matcherValue,
    [],
    eventName === "SessionEnd"
      ? (group) => group.matcher ?? "other"
      : undefined,
  );

  const results = await runHooksParallel(collected, context, eventName);
  const aggregatedResult: HookRunResult = {};

  for (const { hookResult, plainStdout, jsonOutput, commonOutput, error } of results) {
    if (error) {
      notify?.(`Hook execution error: ${String(error)}`, "error");
      continue;
    }

    const additionalContext = jsonOutput
      ? getStringField(
          commonOutput?.hookSpecificOutput?.additionalContext,
          jsonOutput.additionalContext,
        )
      : undefined;
    aggregatedResult.additionalContext = appendAdditionalContext(
      aggregatedResult.additionalContext,
      additionalContext,
    );

    if (
      eventName === "SessionStart" &&
      hookResult.exitCode === 0 &&
      !jsonOutput &&
      plainStdout
    ) {
      aggregatedResult.additionalContext = appendAdditionalContext(
        aggregatedResult.additionalContext,
        plainStdout,
      );
    }

    if (commonOutput?.systemMessage) {
      notify?.(commonOutput.systemMessage, "warning");
    }

    if (hookResult.exitCode !== 0) {
      notify?.(
        `Hook failed (exit ${hookResult.exitCode}): ${hookResult.stderr}`,
        "error",
      );
    }
  }

  return aggregatedResult;
}

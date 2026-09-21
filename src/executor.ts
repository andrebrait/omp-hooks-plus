import { spawn } from "node:child_process";
import {
  isInternalUrlPath,
  resolveReadPath,
  splitPathAndSelPreferringLiteralSync,
} from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { toClaudeToolName } from "./claude";
import type { Hook, HookCommandResult, HookExecutionContext } from "./types";

// OMP 18.2.7 does not expose this helper through its bundled extension API.
// Match pi-tui/src/tools/read.ts, including www. and collapsed HTTP slashes.
function isReadableUrlPath(value: string): boolean {
  return /^https?:\/\/?/i.test(value) || /^www\./i.test(value);
}

// ============================================================================
// Hook executor
// ============================================================================

/**
 * Build Claude Code style JSON input
 */
export function buildHookInput(ctx: HookExecutionContext): object {
  const base: Record<string, unknown> = {
    session_id: ctx.sessionId,
    cwd: ctx.cwd,
    hook_event_name: ctx.hookEventName,
    transcript_path: ctx.transcriptPath,
  };

  if (ctx.hookEventName === "PreCompact") {
    return {
      ...base,
      trigger: ctx.trigger,
      custom_instructions: ctx.customInstructions ?? "",
    };
  }

  if (ctx.hookEventName === "PostCompact") {
    return {
      ...base,
      trigger: ctx.trigger,
      compact_summary: ctx.compactSummary,
    };
  }

  if (ctx.hookEventName === "UserPromptSubmit") {
    return {
      ...base,
      prompt: ctx.prompt,
    };
  }

  if (ctx.hookEventName === "Stop") {
    return {
      ...base,
      stop_hook_active: ctx.stopHookActive ?? false,
      last_assistant_message: ctx.lastAssistantMessage ?? "",
    };
  }

  if (
    ctx.hookEventName === "PreToolUse" ||
    ctx.hookEventName === "PostToolUse" ||
    ctx.hookEventName === "PostToolUseFailure"
  ) {
    const toolName = ctx.toolName ? toClaudeToolName(ctx.toolName) : undefined;
    const rawToolInput = (ctx.toolInput ?? {}) as Record<string, unknown>;

    // Add Claude-compatible field aliases so hook scripts written for Claude
    // Code work without a bridge script. OMP and Claude Code use different
    // field names for the same data; we include both so either works.
    const toolInputAliases: Record<string, unknown> = {};

    // Glob: OMP sends .path, Claude Code sends .pattern
    if (toolName === "Glob" && rawToolInput.path && !rawToolInput.pattern) {
      toolInputAliases.pattern = rawToolInput.path;
    }

    // Read/Edit/Write: OMP sends .path, Claude Code sends .file_path
    if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
      if (typeof rawToolInput.path === "string" && rawToolInput.path && !rawToolInput.file_path) {
        if (toolName !== "Read") {
          toolInputAliases.file_path = rawToolInput.path;
        } else if (!isInternalUrlPath(rawToolInput.path) && !isReadableUrlPath(rawToolInput.path) && !rawToolInput.path.includes("://")) {
          // Keep the original path/selector for OMP-aware hooks; Claude hooks need the filesystem target.
          const target = splitPathAndSelPreferringLiteralSync(rawToolInput.path, ctx.cwd);
          toolInputAliases.file_path = resolveReadPath(target.path, ctx.cwd);
        }
      }
      // Read URLs remain opaque; never misrepresent them as local file paths.
      if (toolName === "Read" && typeof rawToolInput.path === "string" && isReadableUrlPath(rawToolInput.path)) {
        if (!rawToolInput.url) toolInputAliases.url = rawToolInput.path;
        if (rawToolInput.i && !rawToolInput.prompt) toolInputAliases.prompt = rawToolInput.i;
      }
    }

    const toolInput: Record<string, unknown> = {
      ...base,
      tool_name: toolName,
      tool_input: { ...rawToolInput, ...toolInputAliases },
      tool_use_id: ctx.toolUseId,
    };

    if (ctx.hookEventName === "PostToolUse") {
      // Add .result alias from .content[].text for Claude Code compatibility
      const resp = (ctx.toolResponse ?? {}) as Record<string, unknown>;
      if (Array.isArray(resp.content)) {
        const text = (resp.content as Array<Record<string, unknown>>)
          .map((c) => (typeof c.text === "string" ? c.text : ""))
          .join("\n");
        toolInput.tool_response = { ...resp, result: resp.result ?? text };
      } else {
        toolInput.tool_response = resp;
      }
    }

    if (ctx.hookEventName === "PostToolUseFailure") {
      toolInput.error = ctx.error;
      if (ctx.isInterrupt !== undefined) {
        toolInput.is_interrupt = ctx.isInterrupt;
      }
    }

    return toolInput;
  }

  if (ctx.hookEventName === "SessionEnd") {
    return {
      ...base,
      reason: ctx.reason,
      model: ctx.model,
    };
  }

  return {
    ...base,
    source: ctx.source,
    model: ctx.model,
  };
}

export const DEFAULT_COMMAND_HOOK_TIMEOUT_MS = 600_000;
const USER_PROMPT_SUBMIT_TIMEOUT_MS = 30_000;
const SESSION_END_TIMEOUT_MS = 1_500;
/**
 * Grace between SIGTERM and SIGKILL for a terminated hook. The kill window is
 * never shortened by the pass settling: the escalation timer is only cleared
 * once the owned process group has actually closed.
 */
const KILL_ESCALATION_MS = 1_000;

export function getHookTimeoutMs(hook: Hook, eventName: HookExecutionContext["hookEventName"]): number {
  if (hook.timeout !== undefined) return hook.timeout * 1000;
  if (eventName === "UserPromptSubmit") return USER_PROMPT_SUBMIT_TIMEOUT_MS;
  if (eventName === "SessionEnd") return SESSION_END_TIMEOUT_MS;
  return DEFAULT_COMMAND_HOOK_TIMEOUT_MS;
}

export async function executeHook(
  hook: Hook,
  input: object,
  cwd: string,
  timeoutMs: number = DEFAULT_COMMAND_HOOK_TIMEOUT_MS,
  abortSignal?: AbortSignal,
): Promise<HookCommandResult> {
  const inputJson = JSON.stringify(input);
  return executeCommandHook(hook, inputJson, cwd, timeoutMs, abortSignal);
}

export function executeHookAsync(
  hook: Hook,
  input: object,
  cwd: string,
  timeoutMs: number,
  onComplete: (result: HookCommandResult) => void,
  abortSignal?: AbortSignal,
): void {
  const inputJson = JSON.stringify(input);
  void executeCommandHook(hook, inputJson, cwd, timeoutMs, abortSignal).then(onComplete);
}

function getCommandInvocation(hook: Hook): { command: string; args: string[] } {
  if (hook.args) {
    return { command: hook.command, args: hook.args };
  }

  if (hook.shell === "powershell") {
    return { command: "powershell", args: ["-NoProfile", "-Command", hook.command] };
  }

  return { command: "bash", args: ["-c", hook.command] };
}

function executeCommandHook(
  hook: Hook,
  inputJson: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<HookCommandResult> {
  if (abortSignal?.aborted) {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 1,
      aborted: true,
    });
  }

  const { promise, resolve } = Promise.withResolvers<HookCommandResult>();
  const invocation = getCommandInvocation(hook);
  const useProcessGroup =
    process.platform === "darwin" || process.platform === "linux";
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    detached: useProcessGroup,
    stdio: ["pipe", "pipe", "pipe"],
    env: hook.env ? { ...process.env, ...hook.env } : process.env,
  });

  let stdout = "";
  let stderr = "";
  // Diagnostics appended to stderr, in the order they were observed.
  const notes: string[] = [];
  let settled = false;
  let timedOut = false;
  let aborted = false;
  let timeout: NodeJS.Timeout | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let forced: NodeJS.Timeout | undefined;

  const signalGroup = (name: NodeJS.Signals): void => {
    if (useProcessGroup && child.pid) {
      try {
        process.kill(-child.pid, name);
        return;
      } catch {
        // The process may have exited between the timeout and signal.
      }
    }
    child.kill(name);
  };

  const finish = (exitCode: number): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(escalation);
    clearTimeout(forced);
    abortSignal?.removeEventListener("abort", cancel);
    resolve({
      stdout,
      stderr:
        notes.length > 0 ? [stderr, ...notes].join("\n").trim() : stderr,
      exitCode: timedOut ? 1 : exitCode,
      ...(aborted ? { aborted: true } : {}),
    });
  };

  /**
   * Terminate the owned process group, gracefully first. The kill timers stay
   * armed until the group is gone: the pass that cancelled the hook may settle
   * immediately, but a hook that outlived it must not keep running.
   */
  const terminate = (): void => {
    signalGroup("SIGTERM");
    escalation = setTimeout(() => {
      signalGroup("SIGKILL");
      // A descendant that left the group can hold the stdio pipes open forever;
      // bound the wait so a cancelled pass is never stranded.
      forced = setTimeout(() => finish(1), KILL_ESCALATION_MS);
      forced.unref();
    }, KILL_ESCALATION_MS);
    escalation.unref();
  };

  const cancel = (): void => {
    if (settled || aborted || timedOut) return;
    aborted = true;
    terminate();
  };

  abortSignal?.addEventListener("abort", cancel);

  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  child.stdin.on("error", (error) => {
    if ("code" in error && error.code === "EPIPE") return;
    notes.push(error.message);
    // A hook that is already being terminated settles once its group is gone, so
    // a stray stdin error cannot clear the pending SIGKILL.
    if (aborted || timedOut) return;
    finish(1);
  });
  child.stdin.write(inputJson);
  child.stdin.end();

  timeout = setTimeout(() => {
    if (settled || timedOut || aborted) return;
    timedOut = true;
    notes.push("[omp-hooks-plus] Hook timed out");
    terminate();
  }, timeoutMs);
  timeout.unref();

  // A cancelled or timed-out hook settles here, once its group is dead — never
  // before, so the caller can rely on the process being gone when it resumes.
  child.on("close", (code) => {
    finish(code ?? 1);
  });

  child.on("error", (error) => {
    notes.push(error.message);
    finish(1);
  });

  return promise;
}

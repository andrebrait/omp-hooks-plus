import { spawn } from "node:child_process";
import { toClaudeToolName } from "./config";
import type { Hook, HookExecutionContext } from "./types";

// ============================================================================
// Hook 执行器
// ============================================================================

/**
 * 构建 Claude Code 风格的 JSON 输入
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
      if (rawToolInput.path && !rawToolInput.file_path) {
        toolInputAliases.file_path = rawToolInput.path;
      }
      // Read (URL): some Claude hook scripts expect .url and .prompt
      if (toolName === "Read" && typeof rawToolInput.path === "string" && rawToolInput.path.startsWith("http")) {
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const inputJson = JSON.stringify(input);
  return executeCommandHook(hook, inputJson, cwd, timeoutMs);
}

export function executeHookAsync(
  hook: Hook,
  input: object,
  cwd: string,
  timeoutMs: number,
  onComplete: (result: { stdout: string; stderr: string; exitCode: number }) => void,
): void {
  const inputJson = JSON.stringify(input);
  void executeCommandHook(hook, inputJson, cwd, timeoutMs).then(onComplete);
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { promise, resolve } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>();
  const invocation = getCommandInvocation(hook);
  const useProcessGroup =
    process.platform === "darwin" || process.platform === "linux";
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    detached: useProcessGroup,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  let escalation: NodeJS.Timeout | undefined;

  const signal = (name: NodeJS.Signals): void => {
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

  const finish = (result: {
    stdout: string;
    stderr: string;
    exitCode: number;
  }): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(escalation);
    resolve(result);
  };

  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  child.stdin.on("error", (error) => {
    finish({
      stdout,
      stderr: `${stderr}\n${error.message}`.trim(),
      exitCode: 1,
    });
  });
  child.stdin.write(inputJson);
  child.stdin.end();

  timeout = setTimeout(() => {
    signal("SIGTERM");
    escalation = setTimeout(() => signal("SIGKILL"), 1_000);
    escalation.unref();
    finish({
      stdout,
      stderr: `${stderr}\n[omp-hooks-plus] Hook timed out`.trim(),
      exitCode: 1,
    });
  }, timeoutMs);
  timeout.unref();

  child.on("close", (code) => {
    finish({
      stdout,
      stderr,
      exitCode: code ?? 1,
    });
  });

  child.on("error", (error) => {
    finish({
      stdout,
      stderr: `${stderr}\n${error.message}`.trim(),
      exitCode: 1,
    });
  });

  return promise;
}

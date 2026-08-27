import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getHookGroups } from "../config";
import { resetInjectedContext } from "../hook-context";
import type { HookModuleContext } from "../hook-context";
import type {
  HookExecutionContext,
  NotifyFn,
  SettingsFile,
  UserPromptSubmitResult,
} from "../types";
import {
  appendAdditionalContext,
  collectMatchingHooks,
  getStringField,
  runHooksParallel,
} from "./shared";

export async function triggerUserPromptSubmitHooks(
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<UserPromptSubmitResult> {
  const groups = getHookGroups(settings, "UserPromptSubmit");
  const result: UserPromptSubmitResult = { blocked: false };
  const collected = collectMatchingHooks(
    groups,
    context,
    "",
    [],
    () => undefined,
  );
  const results = await runHooksParallel(
    collected,
    context,
    "UserPromptSubmit",
  );

  for (const {
    hookResult,
    plainStdout,
    jsonOutput,
    commonOutput,
    error,
  } of results) {
    if (error) {
      notify?.(`UserPromptSubmit 执行错误: ${String(error)}`, "error");
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
          `UserPromptSubmit 忽略无效 decision: ${String(jsonOutput.decision)}`,
          "warning",
        );
      }

      if (jsonOutput.decision === "block") {
        result.blocked = true;
        result.reason =
          getStringField(jsonOutput.reason) ?? "Blocked by hook";
      }
    } else if (hookResult.exitCode === 0 && plainStdout) {
      // Claude Code adds plain-text stdout as context for UserPromptSubmit,
      // UserPromptExpansion and SessionStart (hooks reference, "Exit code 0").
      // Canonical hooks such as `codegraph prompt-hook` print bare text, so
      // treating it as context is the compatible behavior — no JSON envelope,
      // no wrapper command.
      result.additionalContext = appendAdditionalContext(
        result.additionalContext,
        plainStdout,
      );
    }

    if (hookResult.exitCode !== 0) {
      notify?.(
        `UserPromptSubmit 失败 (exit ${hookResult.exitCode}): ${hookResult.stderr}`,
        "error",
      );
    }
  }

  return result;
}

export function registerPromptHooks(
  pi: ExtensionAPI,
  shared: HookModuleContext,
) {
  pi.on("input", async (event, ctx) => {
    resetInjectedContext();
    shared.pendingUserPromptContext = undefined;
    shared.stopHookActive = false;

    const result = await triggerUserPromptSubmitHooks(
      {
        sessionId: shared.getSessionId(ctx),
        cwd: ctx.cwd,
        hookEventName: "UserPromptSubmit",
        transcriptPath: ctx.sessionManager.getSessionFile(),
        prompt: event.text,
        asyncContextSink: (content, details, triggerTurn) =>
          shared.injectHiddenContext(content, details, triggerTurn),
      },
      shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );

    if (result.blocked) {
      shared.notify(
        ctx,
        `UserPromptSubmit blocked: ${result.reason ?? "Blocked by hook"}`,
        "warning",
      );
      return { handled: true };
    }

    if (result.additionalContext) {
      shared.pendingUserPromptContext = result.additionalContext;
    }
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!shared.pendingUserPromptContext) {
      return;
    }

    const additionalContext = shared.pendingUserPromptContext;
    shared.pendingUserPromptContext = undefined;

    return {
      message: {
        customType: "omp-hooks-plus",
        content: additionalContext,
        display: false,
        details: {
          hookEventName: "UserPromptSubmit",
        },
      },
    };
  });
}

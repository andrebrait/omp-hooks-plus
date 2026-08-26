import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getHookGroups } from "../config";
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

  for (const { hookResult, plainStdout, jsonOutput, commonOutput, error } of results) {
    if (error) {
      notify?.(`Stop 执行错误: ${String(error)}`, "error");
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
          `Stop 忽略无效 decision: ${String(jsonOutput.decision)}`,
          "warning",
        );
      }

      if (jsonOutput.decision === "block") {
        blockReasons.push(
          getStringField(jsonOutput.reason) ?? "Continue requested by Stop hook",
        );
      }
    } else if (hookResult.exitCode === 0 && plainStdout) {
      notify?.(`Stop 输出 (非JSON): ${plainStdout}`, "info");
    }

    if (hookResult.exitCode !== 0) {
      notify?.(
        `Stop 失败 (exit ${hookResult.exitCode}): ${hookResult.stderr}`,
        "error",
      );
    }
  }

  if (blockReasons.length > 0) {
    result.blocked = true;
    result.reason = blockReasons[0];
  }

  return result;
}

export function registerStopHooks(pi: ExtensionAPI, shared: HookModuleContext) {
  pi.on("agent_end", async (event, ctx) => {
    const result = await triggerStopHooks(
      {
        sessionId: shared.getSessionId(ctx),
        cwd: ctx.cwd,
        hookEventName: "Stop",
        transcriptPath: ctx.sessionManager.getSessionFile(),
        stopHookActive: shared.stopHookActive,
        lastAssistantMessage: findLastAssistantMessageText(event.messages),
        asyncContextSink: (content, details, triggerTurn) =>
          shared.injectHiddenContext(content, details, triggerTurn),
      },
      shared.settingsFor(ctx),
      (msg, type) => shared.notify(ctx, msg, type),
    );

    if (result.blocked) {
      if (shared.stopHookActive) {
        shared.notify(
          ctx,
          `Stop hook blocked again; loop guard suppressed another turn: ${result.reason ?? "no reason"}`,
          "warning",
        );
        shared.stopHookActive = false;
        return;
      }

      const continuationMessage = [result.reason, result.additionalContext]
        .filter((value): value is string => Boolean(value && value.trim()))
        .join("\n\n");

      shared.stopHookActive = true;
      shared.pi.sendMessage(
        {
          customType: "omp-hooks-plus",
          content: continuationMessage,
          display: false,
          details: {
            hookEventName: "Stop",
            stopHookActive: true,
          },
        },
        {
          deliverAs: "followUp",
          triggerTurn: true,
        },
      );
      return;
    } else if (result.additionalContext) {
      shared.injectHiddenContext(result.additionalContext, {
        hookEventName: "Stop",
      });
    }

    shared.stopHookActive = false;
  });
}

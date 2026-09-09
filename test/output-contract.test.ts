import { describe, expect, test } from "bun:test";
import { triggerSimpleHooks } from "../src/hooks/shared";
import { triggerUserPromptSubmitHooks } from "../src/hooks/prompt-hooks";
import { triggerStopHooks } from "../src/hooks/stop-hooks";
import {
  triggerPreToolUseHooks,
  triggerPostToolUseHooks,
  triggerPostToolUseFailureHooks,
} from "../src/hooks/tool-hooks";
import type { HookEventName, HookExecutionContext, NotifyFn, SettingsFile } from "../src/types";

async function run(eventName: HookEventName, command: string) {
  const context: HookExecutionContext = {
    sessionId: "session",
    cwd: process.cwd(),
    hookEventName: eventName,
    toolName: "bash",
    toolInput: { command: "true" },
  };
  const settings: SettingsFile = {
    hooks: { [eventName]: [{ hooks: [{ type: "command", command }] }] },
  };
  const notifications: Parameters<NotifyFn>[] = [];
  const notify: NotifyFn = (...args) => { notifications.push(args); };
  const result = await (() => {
    switch (eventName) {
      case "PreToolUse":
        return triggerPreToolUseHooks("bash", context, settings, notify);
      case "PostToolUse":
        return triggerPostToolUseHooks("bash", context, settings, notify);
      case "PostToolUseFailure":
        return triggerPostToolUseFailureHooks("bash", context, settings, notify);
      case "UserPromptSubmit":
        return triggerUserPromptSubmitHooks(context, settings, notify);
      case "Stop":
        return triggerStopHooks(context, settings, notify);
      default:
        return triggerSimpleHooks(eventName, eventName === "SessionEnd" ? "other" : "", context, settings, notify);
    }
  })();
  return { result, notifications };
}

const events: HookEventName[] = [
  "SessionStart", "SessionEnd", "PreCompact", "PostCompact",
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop",
];

describe("successful plain-text hook output", () => {
  for (const eventName of events) {
    test(`${eventName} follows its context-only or silent output contract`, async () => {
      const { result, notifications } = await run(eventName, "printf '%s' 'Session status updated.'");

      expect(notifications).toEqual([]);
      expect(result.additionalContext).toBe(
        eventName === "SessionStart" || eventName === "UserPromptSubmit"
          ? "Session status updated."
          : undefined,
      );
      if ("blocked" in result) expect(result.blocked).toBe(false);
    });
  }
});

describe("diagnostics survive success-output suppression", () => {
  for (const eventName of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionEnd", "PreCompact", "PostCompact"] as const) {
    test(`${eventName} still reports failed hook stderr`, async () => {
      const { notifications } = await run(eventName, "printf '%s' 'Partial update'; printf '%s' 'Update failed' >&2; exit 7");

      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.[1]).toBe("error");
      expect(notifications[0]?.[0]).toContain("exit 7");
      expect(notifications[0]?.[0]).toContain("Update failed");
    });
  }

  for (const eventName of ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const) {
    test(`${eventName} still delivers structured context`, async () => {
      const { result } = await run(eventName, "printf '%s' '{\"additionalContext\":\"Review command results\"}'");
      expect(result.additionalContext).toBe("Review command results");
    });
  }
});

import { describe, expect, test } from "bun:test";
import { triggerPreToolUseHooks } from "../src/hooks/tool-hooks";
import type { HookExecutionContext, SettingsFile } from "../src/types";

const context: HookExecutionContext = {
  sessionId: "session",
  cwd: process.cwd(),
  hookEventName: "PreToolUse",
  toolName: "bash",
  toolInput: { command: "git status" },
};

describe("PreToolUse permission decisions", () => {
  test("surfaces ask decisions for interactive confirmation", async () => {
    const settings: SettingsFile = {
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{
            type: "command",
            command: "printf '%s' '{\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"Approve git status\"}'",
          }],
        }],
      },
    };

    const result = await triggerPreToolUseHooks("bash", context, settings);

    expect(result.blocked).toBe(false);
    expect(result.confirmationReason).toBe("Approve git status");
  });

  test("deny wins when another matching hook asks", async () => {
    const settings: SettingsFile = {
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "printf '%s' '{\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"ask\"}'",
            },
            {
              type: "command",
              command: "printf '%s' '{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"denied\"}'",
            },
          ],
        }],
      },
    };

    const result = await triggerPreToolUseHooks("bash", context, settings);

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("denied");
    expect(result.confirmationReason).toBeUndefined();
  });
});

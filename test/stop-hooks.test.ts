import { describe, expect, test } from "bun:test";
import { triggerStopHooks } from "../src/hooks/stop-hooks";
import type { HookExecutionContext, NotifyFn, SettingsFile } from "../src/types";

const context: HookExecutionContext = {
  sessionId: "session",
  cwd: process.cwd(),
  hookEventName: "Stop",
};

function settingsFor(...commands: string[]): SettingsFile {
  return {
    hooks: {
      Stop: [{ hooks: commands.map((command) => ({ type: "command", command })) }],
    },
  };
}

describe("Stop hook output", () => {
  test("successful plain text produces no notification or model context", async () => {
    const notifications: Parameters<NotifyFn>[] = [];
    const result = await triggerStopHooks(
      context,
      settingsFor("printf '%s' 'Session status updated.'"),
      (...args) => notifications.push(args),
    );

    expect(result).toEqual({ blocked: false });
    expect(notifications).toEqual([]);
  });

  test("plain text does not hide another hook's blocking decision or warning", async () => {
    const notifications: Parameters<NotifyFn>[] = [];
    const result = await triggerStopHooks(
      context,
      settingsFor(
        "printf '%s' 'Session status updated.'",
        "printf '%s' '{\"decision\":\"block\",\"reason\":\"Tests failed\",\"systemMessage\":\"Check test results\"}'",
      ),
      (...args) => notifications.push(args),
    );

    expect(result).toEqual({ blocked: true, reason: "Tests failed" });
    expect(notifications).toEqual([["Check test results", "warning"]]);
  });

  test("failed hooks still report stderr even when stdout contains plain text", async () => {
    const notifications: Parameters<NotifyFn>[] = [];
    await triggerStopHooks(
      context,
      settingsFor("printf '%s' 'Partial update'; printf '%s' 'Status update failed' >&2; exit 7"),
      (...args) => notifications.push(args),
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.[1]).toBe("error");
    expect(notifications[0]?.[0]).toContain("exit 7");
    expect(notifications[0]?.[0]).toContain("Status update failed");
  });
});

describe("Stop hook blocking exit codes", () => {
  test("exit 2 blocks the session and carries stderr as the continuation reason", async () => {
    const result = await triggerStopHooks(
      context,
      settingsFor("printf '%s' 'Verification failed: 2 tests red' >&2; exit 2"),
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("Verification failed: 2 tests red");
  });

  test("exit 2 still blocks when another hook exits cleanly with plain text", async () => {
    const result = await triggerStopHooks(
      context,
      settingsFor(
        "printf '%s' 'Session status updated.'",
        "printf '%s' 'Lint is red' >&2; exit 2",
      ),
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("Lint is red");
  });

  test("exit 2 without stderr still names a reason the host can continue with", async () => {
    const result = await triggerStopHooks(context, settingsFor("exit 2"));

    expect(result.blocked).toBe(true);
    expect(result.reason?.trim()).toBeTruthy();
  });

  test("a block keeps the context other Stop hooks accumulated", async () => {
    const result = await triggerStopHooks(
      context,
      settingsFor(
        "printf '%s' '{\"additionalContext\":\"Review the failing assertion\"}'",
        "printf '%s' '{\"decision\":\"block\",\"reason\":\"Tests failed\"}'",
      ),
    );

    expect(result).toEqual({
      blocked: true,
      reason: "Tests failed",
      additionalContext: "Review the failing assertion",
    });
  });
});

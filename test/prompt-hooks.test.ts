import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { triggerUserPromptSubmitHooks } from "../src/hooks/prompt-hooks";
import type { HookExecutionContext, SettingsFile } from "../src/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("UserPromptSubmit hook execution", () => {
  test("deduplicates the same user and project command", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omp-hooks-prompt-"));
    roots.push(root);
    const marker = path.join(root, "runs");
    const command = `printf x >> ${JSON.stringify(marker)}`;
    const settings: SettingsFile = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command }] },
          { hooks: [{ type: "command", command }] },
        ],
      },
    };
    const context: HookExecutionContext = {
      sessionId: "session",
      cwd: root,
      hookEventName: "UserPromptSubmit",
      prompt: "hello",
    };

    await triggerUserPromptSubmitHooks(context, settings);

    expect(readFileSync(marker, "utf8")).toBe("x");
  });

  test("adds plain-text stdout as context, no JSON envelope needed", async () => {
    const settings: SettingsFile = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "printf '%s' 'CODEGRAPH CONTEXT'" }] },
        ],
      },
    };
    const context: HookExecutionContext = {
      sessionId: "session",
      cwd: process.cwd(),
      hookEventName: "UserPromptSubmit",
      prompt: "hello",
    };

    const result = await triggerUserPromptSubmitHooks(context, settings);

    expect(result.additionalContext).toBe("CODEGRAPH CONTEXT");
    expect(result.blocked).toBe(false);
  });

  test("ignores stdout from a hook that exited non-zero", async () => {
    const settings: SettingsFile = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "printf '%s' 'BROKEN'; exit 1" }] },
        ],
      },
    };
    const context: HookExecutionContext = {
      sessionId: "session",
      cwd: process.cwd(),
      hookEventName: "UserPromptSubmit",
      prompt: "hello",
    };

    const result = await triggerUserPromptSubmitHooks(context, settings);

    expect(result.additionalContext).toBeUndefined();
  });
});

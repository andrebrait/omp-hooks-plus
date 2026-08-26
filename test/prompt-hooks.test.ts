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
});

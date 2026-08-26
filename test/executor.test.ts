import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeHook } from "../src/executor";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("hook timeout", () => {
  // Integration: real OS process groups and signals cannot be driven by Bun's fake clock.
  test("terminates the command process group", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omp-hooks-timeout-"));
    roots.push(root);
    const marker = path.join(root, "descendant-survived");

    const result = await executeHook(
      {
        type: "command",
        command: `(sleep 0.3; touch ${JSON.stringify(marker)}) & wait`,
      },
      {},
      root,
      50,
    );
    await Bun.sleep(500);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[omp-hooks-plus] Hook timed out");
    expect(existsSync(marker)).toBe(false);
  });
  test("keeps stdout when a fast hook closes stdin early", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omp-hooks-epipe-"));
    roots.push(root);

    const result = await executeHook(
      { type: "command", command: "printf ready" },
      { payload: "x".repeat(1_000_000) },
      root,
      1_000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ready");
  });

});

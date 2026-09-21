import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildHookInput, executeHook } from "../src/executor";
import { executeParsedHook } from "../src/hooks/shared";
import { processGone, readPidFile } from "./setup";

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

  test("escalates to SIGKILL when a hook survives SIGTERM", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omp-hooks-escalate-"));
    roots.push(root);
    const pidFile = path.join(root, "hook.pid");

    const result = await executeHook(
      // The ignored disposition is inherited by the whole group, so only SIGKILL ends it.
      { type: "command", command: `echo "$$" > '${pidFile}'; trap '' TERM; sleep 30` },
      {},
      root,
      50,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[omp-hooks-plus] Hook timed out");
    expect(await processGone(await readPidFile(pidFile))).toBe(true);
  });

  test("a timed-out command cannot report success by catching SIGTERM", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omp-hooks-timeout-trap-"));
    roots.push(root);
    const result = await executeHook(
      { type: "command", command: "trap 'exit 0' TERM; sleep 30 & wait" },
      {},
      root,
      100,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Hook timed out");
  });

});

describe("hook cancellation", () => {
  test("an aborted hook cancels its whole process group and yields no verdict", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omp-hooks-abort-"));
    roots.push(root);
    const leaderFile = path.join(root, "leader.pid");
    const descendantFile = path.join(root, "descendant.pid");
    const controller = new AbortController();

    const pending = executeHook(
      {
        type: "command",
        command: `sleep 30 & echo "$!" > '${descendantFile}'; echo "$$" > '${leaderFile}'; wait`,
      },
      {},
      root,
      60_000,
      controller.signal,
    );

    const leader = await readPidFile(leaderFile);
    const descendant = await readPidFile(descendantFile);
    controller.abort();
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(await processGone(-leader)).toBe(true);
    expect(await processGone(descendant)).toBe(true);
  });

  test("an already aborted pass never starts the hook", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "omp-hooks-prestart-"));
    roots.push(root);
    const marker = path.join(root, "started");
    const controller = new AbortController();
    controller.abort();

    const result = await executeHook(
      { type: "command", command: `touch '${marker}'` },
      {},
      root,
      1_000,
      controller.signal,
    );

    expect(result.aborted).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

});

test("read selectors reach the same file-sensitive command hook as a plain path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-hooks-path-"));
  roots.push(root);
  writeFileSync(path.join(root, "sample.ts"), "protected source");
  const guard = path.join(root, "guard.cjs");
  writeFileSync(guard, `const fs = require("node:fs");
const { tool_input } = JSON.parse(fs.readFileSync(0, "utf8"));
if (fs.readFileSync(tool_input.file_path, "utf8") === "protected source") {
  console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "protected source" } }));
}`);
  for (const requested of ["sample.ts", "sample.ts:1-2", "sample.ts:raw:1-2", "sample.ts:1-2,4-5"]) {
    const result = await executeParsedHook(
      { type: "command", command: "node", args: [guard] },
      { cwd: root, sessionId: "paths", hookEventName: "PreToolUse", toolName: "read", toolInput: { path: requested } },
      "PreToolUse",
    );
    expect(result.hookResult.exitCode).toBe(0);
    expect(result.commonOutput?.hookSpecificOutput).toMatchObject({
      permissionDecision: "deny", permissionDecisionReason: "protected source",
    });
  }
});

test("literal selector-shaped filenames win and write targets are not read selectors", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-hooks-literal-"));
  roots.push(root);
  writeFileSync(path.join(root, "sample.ts:1-2"), "literal source");
  symlinkSync("missing", path.join(root, "dangling:raw"));
  const inputFor = (toolName: string, requested: string) => buildHookInput({
    cwd: root, sessionId: "paths", hookEventName: "PreToolUse", toolName, toolInput: { path: requested },
  }) as { tool_input: { path: string; file_path?: string } };
  expect(inputFor("read", "sample.ts:1-2").tool_input).toEqual({
    path: "sample.ts:1-2", file_path: path.join(root, "sample.ts:1-2"),
  });
  expect(inputFor("read", "dangling:raw").tool_input.file_path).toBe(path.join(root, "dangling:raw"));
  expect(inputFor("write", "new:1-2").tool_input.file_path).toBe("new:1-2");
  expect(inputFor("edit", "sample.ts:1-2").tool_input.file_path).toBe("sample.ts:1-2");
});

test("read URLs stay opaque rather than becoming local filesystem aliases", () => {
  const inputFor = (input: Record<string, unknown>) => buildHookInput({
    cwd: "/project", sessionId: "paths", hookEventName: "PreToolUse", toolName: "read", toolInput: input,
  }) as { tool_input: Record<string, unknown> };
  for (const web of [
    "https://example.com:8080/page:1-2",
    "HTTP://example.com",
    "https:/example.com/page",
    "www.example.com/page:1-2",
  ]) {
    expect(inputFor({ path: web, i: "Inspect page" }).tool_input).toEqual({
      path: web, i: "Inspect page", url: web, prompt: "Inspect page",
    });
  }
  for (const target of ["skill://example:1-2", "mcp://server/resource:raw", "ssh://host:2222/file:1-2"]) {
    expect(inputFor({ path: target }).tool_input).toEqual({ path: target });
  }
  expect(inputFor({ path: "http-not-a-url.ts" }).tool_input.file_path).toBe("/project/http-not-a-url.ts");
  expect(inputFor({ path: "sample.ts:1-2", file_path: "explicit.ts" }).tool_input.file_path).toBe("explicit.ts");
});

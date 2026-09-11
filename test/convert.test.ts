import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { convertHooks } from "../src/convert";

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "omp-convert-"));
  temporary.push(root);
  const plugin = path.join(root, "plugin");
  const project = path.join(root, "project");
  mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(plugin, "hooks"));
  mkdirSync(project);
  writeFileSync(path.join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "converter-test" }));
  writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.cjs"' }] }] } }));
  writeFileSync(path.join(plugin, "hooks/guard.cjs"), `const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync("observed.jsonl", JSON.stringify({ cwd: process.cwd(), project: process.env.CLAUDE_PROJECT_DIR, tool: input.tool_name, command: input.tool_input.command }) + "\\n");
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...(input.tool_input.command === "deny" ? { permissionDecision: "deny", permissionDecisionReason: "fixture denied" } : { updatedInput: { command: "rewritten" } }) } }));
`);
  return { root, plugin, project, out: path.join(root, "output") };
}

test("generated hooks survive relocation and source removal, preserving real host denial and input rewriting", async () => {
  const { root, plugin, project, out } = fixture();
  writeFileSync(path.join(plugin, ".env"), "SECRET=not-for-output");
  expect((await convertHooks(plugin, { out })).exitCode).toBe(0);
  const second = path.join(root, "second");
  expect((await convertHooks(plugin, { out: second })).exitCode).toBe(0);
  expect(readFileSync(path.join(out, "index.ts"))).toEqual(readFileSync(path.join(second, "index.ts")));
  expect(existsSync(path.join(project, "observed.jsonl"))).toBe(false);
  expect(existsSync(path.join(out, "resources/.env"))).toBe(false);
  expect(existsSync(path.join(out, "resources/hooks/hooks.json"))).toBe(false);
  const moved = path.join(root, "relocated");
  renameSync(out, moved);
  rmSync(plugin, { recursive: true });
  const loaded = await loadExtensions([path.join(moved, "index.ts")], project);
  expect(loaded.errors).toEqual([]);
  const auth = await AuthStorage.create(":memory:");
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, project, SessionManager.inMemory(project), new ModelRegistry(auth));
  try {
    const denied = await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "deny", input: { command: "deny" } });
    expect(denied).toMatchObject({ block: true, reason: "fixture denied" });
    const event = { type: "tool_call" as const, toolName: "bash", toolCallId: "allow", input: { command: "allow" } };
    expect((await runner.emitToolCall(event))?.block).not.toBe(true);
    expect(event.input.command).toBe("rewritten");
    expect(readFileSync(path.join(project, "observed.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { cwd: project, project, tool: "Bash", command: "deny" },
      { cwd: project, project, tool: "Bash", command: "allow" },
    ]);
  } finally {
    await runner.emit({ type: "session_shutdown" });
    runner.clearManagedTimers();
    auth.close();
  }
});

test("dry run writes nothing and existing or source-contained outputs remain untouched", async () => {
  const { root, plugin, out } = fixture();
  expect((await convertHooks(plugin, { out, dryRun: true })).exitCode).toBe(0);
  expect(existsSync(out)).toBe(false);
  mkdirSync(out);
  writeFileSync(path.join(out, "sentinel"), "keep");
  await expect(convertHooks(plugin, { out })).rejects.toThrow("already exists");
  expect(readFileSync(path.join(out, "sentinel"), "utf8")).toBe("keep");
  await expect(convertHooks(plugin, { out: path.join(plugin, "output") })).rejects.toThrow("outside");
  const alias = path.join(root, "source-alias");
  symlinkSync(plugin, alias);
  await expect(convertHooks(path.join(alias, "hooks/hooks.json"), { out: path.join(plugin, "hooks/inside") })).rejects.toThrow("inside");
});

test("unsupported declarations and resource symlinks never produce runnable partial conversions", async () => {
  const { root, plugin, out } = fixture();
  writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ hooks: { FutureEvent: [{ hooks: [{ type: "command", command: "echo ignored" }] }] } }));
  const result = await convertHooks(plugin, { out });
  expect(result.exitCode).toBe(2);
  expect(result.report.hooks[0].status).toBe("unsupported");
  expect(existsSync(path.join(out, "index.ts"))).toBe(false);
  expect(existsSync(path.join(out, "conversion-report.json"))).toBe(true);
  symlinkSync(root, path.join(plugin, "escape"));
  const linked = await convertHooks(plugin, { dryRun: true });
  expect(linked.report.diagnostics.some(item => item.file === "escape" && item.level === "unsupported")).toBe(true);
});

test("file conversion copies only selected resources and honors source-wide disabling at runtime", async () => {
  const { plugin, project, out } = fixture();
  const settings = path.join(plugin, "settings.json");
  writeFileSync(settings, JSON.stringify({
    disableAllHooks: true,
    hooks: JSON.parse(readFileSync(path.join(plugin, "hooks/hooks.json"), "utf8")).hooks,
  }));
  const result = await convertHooks(settings, { out, include: ["hooks/guard.cjs"] });
  expect(result.exitCode).toBe(0);
  expect(result.report.output.resources).toEqual(["hooks/guard.cjs"]);
  const loaded = await loadExtensions([path.join(out, "index.ts")], project);
  expect(loaded.errors).toEqual([]);
  const auth = await AuthStorage.create(":memory:");
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, project, SessionManager.inMemory(project), new ModelRegistry(auth));
  try {
    expect((await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "disabled", input: { command: "deny" } }))?.block).not.toBe(true);
    expect(existsSync(path.join(project, "observed.jsonl"))).toBe(false);
  } finally {
    await runner.emit({ type: "session_shutdown" });
    runner.clearManagedTimers();
    auth.close();
  }
});

import { afterEach, expect, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, symlinkSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { convertHooks } from "../src/convert";
import type { ConvertOptions } from "../src/convert";
import * as conversionSource from "../src/conversion-source";
import { registerHooks } from "../src/adapter";

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "omp-convert-"));
  temporary.push(root);
  const projectRoot = path.join(root, "project");
  const project = path.join(projectRoot, "nested");
  const plugin = path.join(root, "plugin");
  mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(projectRoot, ".git"));
  mkdirSync(path.join(plugin, "hooks"));
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
      { cwd: project, project: path.dirname(project), tool: "Bash", command: "deny" },
      { cwd: project, project: path.dirname(project), tool: "Bash", command: "allow" },
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

test("plugin resource selection copies requested files while omitted symlinks cannot hide scoped declarations", async () => {
  const { root, plugin, project, out } = fixture();
  mkdirSync(path.join(plugin, "assets"));
  writeFileSync(path.join(plugin, "assets/policy.txt"), "Selected policy");
  writeFileSync(path.join(plugin, "unselected.txt"), "May still be a dependency");
  writeFileSync(path.join(plugin, ".env"), "PRIVATE");
  symlinkSync(root, path.join(plugin, "unrelated-link"));
  const include = ["hooks/guard.cjs", "assets"];
  const selected = await convertHooks(plugin, { out, include });
  expect(selected.exitCode).toBe(0);
  expect(selected.report.output.resources).toEqual(["assets/policy.txt", "hooks/guard.cjs"]);
  expect(readFileSync(path.join(out, "resources/assets/policy.txt"), "utf8")).toBe("Selected policy");
  expect(readFileSync(path.join(out, "resources/hooks/guard.cjs"))).toEqual(readFileSync(path.join(plugin, "hooks/guard.cjs")));
  expect(selected.report.output.omittedResources).toEqual(["unrelated-link", "unselected.txt"]);
  expect(selected.report.output.excludedResources).toEqual([".claude-plugin/plugin.json", ".env", "hooks/hooks.json"]);
  expect(existsSync(path.join(out, "resources/unrelated-link"))).toBe(false);
  expect(existsSync(path.join(out, "resources/unselected.txt"))).toBe(false);
  expect(existsSync(path.join(project, "observed.jsonl"))).toBe(false);

  mkdirSync(path.join(plugin, "skills/check"), { recursive: true });
  writeFileSync(path.join(plugin, "skills/check/SKILL.md"), "---\nname: check\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: echo scoped\n---\n");
  const blockedOut = path.join(root, "blocked");
  const blocked = await convertHooks(plugin, { out: blockedOut, include });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.report.hooks).toEqual(expect.arrayContaining([
    expect.objectContaining({ file: "hooks/hooks.json", event: "PreToolUse", status: "supported" }),
    expect.objectContaining({ file: "skills/check/SKILL.md", pointer: "/frontmatter/hooks/PreToolUse/0/hooks/0", status: "unsupported" }),
  ]));
  expect(blocked.report.output.omittedResources).toEqual(["unrelated-link", "unselected.txt"]);
  expect(blocked.report.diagnostics.some(item => item.file === "unrelated-link")).toBe(false);
  expect(existsSync(path.join(blockedOut, "index.ts"))).toBe(false);
  expect(existsSync(path.join(blockedOut, "conversion-report.json"))).toBe(true);
});

test("plugin includes reject excluded ancestors, traversal and symlinks without weakening declaration containment", async () => {
  const { root, plugin, out } = fixture();
  mkdirSync(path.join(plugin, ".cache"));
  writeFileSync(path.join(plugin, ".cache/private.txt"), "PRIVATE");
  symlinkSync(path.join(plugin, "hooks"), path.join(plugin, "alias"));
  for (const include of [".cache/private.txt", "../outside", "hooks/../hooks/guard.cjs", "alias/guard.cjs", path.join(plugin, "hooks/guard.cjs")]) {
    await expect(convertHooks(plugin, { out, include: [include] })).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
  }
  symlinkSync(root, path.join(plugin, "skills"));
  const result = await convertHooks(plugin, { out, include: ["hooks/guard.cjs"] });
  expect(result.exitCode).toBe(1);
  expect(result.report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ level: "error", file: "skills" }),
  ]));
  expect(existsSync(out)).toBe(false);
});

test("CLI repeated includes select plugin resources and invalid activation fails at CLI and API boundaries", async () => {
  const { root, plugin, out } = fixture();
  writeFileSync(path.join(plugin, "selected.txt"), "selected");
  writeFileSync(path.join(plugin, "omitted.txt"), "omitted");
  const cli = fileURLToPath(new URL("../src/convert.ts", import.meta.url));
  const selected = Bun.spawn([process.execPath, cli, plugin, "--dry-run", "--json", "--activation", "project-trusted", "--include", "hooks/guard.cjs", "--include", "selected.txt"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(selected.stdout).text(), new Response(selected.stderr).text(), selected.exited]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const report = JSON.parse(stdout);
  expect(report.output.resources).toEqual(["hooks/guard.cjs", "selected.txt"]);
  expect(report.output.omittedResources).toEqual(["omitted.txt"]);
  expect(report.activation).toEqual({ policy: "project-trusted", projectTrustRequired: true });
  expect(report.conversionLevel).toBe("command-hook-adaptation");

  for (const activation of ["always", "", null]) {
    await expect(convertHooks(plugin, { out, activation: activation as ConvertOptions["activation"] })).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
  }
  const invalid = Bun.spawn([process.execPath, cli, plugin, "--out", path.join(root, "invalid-cli"), "--activation", "always"], { stdout: "pipe", stderr: "pipe" });
  const [invalidOutput, , invalidExit] = await Promise.all([new Response(invalid.stdout).text(), new Response(invalid.stderr).text(), invalid.exited]);
  expect(invalidExit).toBe(1);
  expect(invalidOutput).toBe("");
  expect(existsSync(path.join(root, "invalid-cli"))).toBe(false);
});

for (const scenario of [
  { name: "project-trusted generated hooks follow trust changes at the same cwd before using cached settings", activation: "project-trusted" as const, disabled: false, blocked: [false, true, false], effects: [0, 1, 1] },
  { name: "default-enabled generated hooks run in untrusted projects", activation: undefined, disabled: false, blocked: [true, true, true], effects: [1, 2, 3] },
  { name: "project-trusted generated hooks preserve source-wide disabling", activation: "project-trusted" as const, disabled: true, blocked: [false, false, false], effects: [0, 0, 0] },
]) {
  test(scenario.name, async () => {
    const { root, plugin, project, out } = fixture();
    let input = plugin;
    if (scenario.disabled) {
      input = path.join(plugin, "settings.json");
      writeFileSync(input, JSON.stringify({ disableAllHooks: true, hooks: JSON.parse(readFileSync(path.join(plugin, "hooks/hooks.json"), "utf8")).hooks }));
    }
    const result = await convertHooks(input, { out, activation: scenario.activation, include: ["hooks/guard.cjs"] });
    expect(result.exitCode).toBe(0);
    expect(result.report.activation).toEqual({ policy: scenario.activation ?? "enabled", projectTrustRequired: scenario.activation === "project-trusted" });
    const home = path.join(root, "home");
    mkdirSync(home);
    rmSync(plugin, { recursive: true });
    const script = `
      import { existsSync, readFileSync } from "node:fs";
      import { join } from "node:path";
      import { loadExtensions } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"))};
      const loaded = await loadExtensions([${JSON.stringify(path.join(out, "index.ts"))}], process.cwd());
      if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
      const handlers = loaded.extensions[0].handlers;
      let trusted = false;
      const ctx = {
        cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined },
        ui: { notify: () => {} }, isProjectTrusted: () => trusted,
      };
      const observations = [];
      for (const trust of [false, true, false]) {
        trusted = trust;
        const result = await handlers.get("tool_call")[0]({ type: "tool_call", toolName: "bash", toolCallId: String(observations.length), input: { command: "deny" } }, ctx);
        observations.push({
          blocked: result?.block === true,
          effects: existsSync("observed.jsonl") ? readFileSync("observed.jsonl", "utf8").trim().split("\\n").length : 0,
          dataCreated: existsSync(join(process.env.HOME, ".omp", "hook-data")),
        });
      }
      await handlers.get("session_shutdown")[0]({ type: "session_shutdown" }, ctx);
      console.log(JSON.stringify(observations));
    `;
    const child = Bun.spawn([process.execPath, "--no-install", "--eval", script], { cwd: project, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual(scenario.effects.map((effects, index) => ({
      blocked: scenario.blocked[index], effects, dataCreated: effects > 0,
    })));
  }, 30_000); // Fresh OMP loader startup is outside the hook's own execution timeout.
}

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

test.each([{ include: undefined }, { include: ["hooks/guard.cjs"] }])("resource parent replacement cannot copy a file outside the inventoried source (%j)", async ({ include }) => {
  const { root, plugin, out } = fixture();
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "guard.cjs"), "PRIVATE OUTSIDE CONTENT");
  const copy = fs.copyFileSync;
  const replacement = spyOn(fs, "copyFileSync").mockImplementation((source, target, flags) => {
    copy(source, target, flags);
    if (target === path.join(out, "LICENSE")) {
      // Publication has started after inventory. Replace a parent, not just the leaf.
      renameSync(path.join(plugin, "hooks"), path.join(plugin, "original-hooks"));
      symlinkSync(outside, path.join(plugin, "hooks"));
    }
  });
  try {
    await expect(convertHooks(plugin, { out, include })).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
  } finally {
    replacement.mockRestore();
  }
});

test("different scripts with identical declarations cannot share generated persistent data", async () => {
  const dataPaths: string[] = [];
  for (const version of ["first", "second"]) {
    const { plugin, project, out } = fixture();
    writeFileSync(path.join(plugin, "hooks/guard.cjs"), `// ${version}\nrequire("node:fs").writeFileSync("data-path", process.env.CLAUDE_PLUGIN_DATA);`);
    expect((await convertHooks(plugin, { out })).exitCode).toBe(0);
    const loaded = await loadExtensions([path.join(out, "index.ts")], project);
    expect(loaded.errors).toEqual([]);
    const auth = await AuthStorage.create(":memory:");
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, project, SessionManager.inMemory(project), new ModelRegistry(auth));
    try {
      await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: version, input: { command: "allow" } });
      dataPaths.push(readFileSync(path.join(project, "data-path"), "utf8"));
    } finally {
      await runner.emit({ type: "session_shutdown" });
      runner.clearManagedTimers();
      auth.close();
    }
  }
  expect(dataPaths[0]).not.toBe(dataPaths[1]);
  for (const directory of dataPaths) rmSync(directory, { recursive: true, force: true });
});

test("shared generated hooks consume host input once and keep slash-like continuations as content", async () => {
  const { plugin, project, out } = fixture();
  const literal = "/skill:ponytail-review keep these arguments";
  writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/prompt.cjs"' }] }],
    Stop: [{ hooks: [{ type: "command", command: `printf '%s' '${JSON.stringify({ decision: "block", reason: literal })}'` }] }],
  } }));
  writeFileSync(path.join(plugin, "hooks/prompt.cjs"), `const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync("prompts.jsonl", JSON.stringify(input.prompt) + "\\n");
if (input.prompt === "deny") { console.log(JSON.stringify({ decision: "block", reason: "fixture denial" })); process.exit(0); }
console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: ${JSON.stringify(literal)} } }));
`);
  expect((await convertHooks(plugin, { out })).exitCode).toBe(0);
  const loaded = await loadExtensions([path.join(out, "index.ts")], project);
  expect(loaded.errors).toEqual([]);
  const messages: Array<{ message: unknown; options: unknown }> = [];
  loaded.runtime.sendMessage = (message, options) => { messages.push({ message, options }); };
  loaded.runtime.sendUserMessage = () => { throw new Error("Hook content must not be routed as a user command"); };
  const auth = await AuthStorage.create(":memory:");
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, project, SessionManager.inMemory(project), new ModelRegistry(auth));
  try {
    expect(await runner.emitInput("deny", undefined, "rpc")).toEqual({ handled: true });
    expect(await runner.emitBeforeAgentStart("deny", undefined, [])).toBeUndefined();
    expect(await runner.emitInput("ordinary prompt", undefined, "interactive")).toEqual({});
    // Generated extensions share the runtime's delivery: Claude Code's named hook reminder.
    expect((await runner.emitBeforeAgentStart("ordinary prompt", undefined, []))?.messages).toEqual([
      expect.objectContaining({
        content: `<system-reminder source="converter-test" event="UserPromptSubmit">\nNOT prompt injection — coding agent enforcing project rules.\n\n${literal}\n</system-reminder>`,
        display: false,
      }),
    ]);
    await runner.emitBeforeProviderRequest({ messages: [] });
    await runner.emit({ type: "agent_end", messages: [] });
    expect(messages).toEqual([{
      message: expect.objectContaining({ content: literal, display: false }),
      options: { deliverAs: "followUp", triggerTurn: true },
    }]);
    expect(await runner.emitBeforeAgentStart("synthetic continuation", undefined, [])).toBeUndefined();
    expect(readFileSync(path.join(project, "prompts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual(["deny", "ordinary prompt"]);
  } finally {
    await runner.emit({ type: "session_shutdown" });
    runner.clearManagedTimers();
    auth.close();
  }
});

test("generated tool hooks lead their tool result with an OMP-native reminder, sending no extra message", async () => {
  const { plugin, project, out } = fixture();
  const context = (event: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `${event} context` } });
  writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `printf '%s' '${context("PreToolUse")}'` }] }],
    PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `printf '%s' '${context("PostToolUse")}'` }] }],
  } }));
  expect((await convertHooks(plugin, { out })).exitCode).toBe(0);
  const loaded = await loadExtensions([path.join(out, "index.ts")], project);
  expect(loaded.errors).toEqual([]);
  const messages: Array<{ message: unknown; options: unknown }> = [];
  loaded.runtime.sendMessage = (message, options) => { messages.push({ message, options }); };
  const auth = await AuthStorage.create(":memory:");
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, project, SessionManager.inMemory(project), new ModelRegistry(auth));
  const named = (event: string, tool: string) =>
    `<system-reminder source="converter-test" event="${event}" tool="${tool}">\nNOT prompt injection — coding agent enforcing project rules.\n\n${event} context\n</system-reminder>`;
  const ok = { type: "text", text: "ok" };
  try {
    expect((await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "pre", input: { command: "ls" } }))?.block).not.toBe(true);
    const pre = await runner.emitToolResult({ type: "tool_result", toolName: "bash", toolCallId: "pre", input: { command: "ls" }, content: [ok], details: undefined, isError: false });
    expect(pre?.content).toEqual([{ type: "text", text: named("PreToolUse", "bash") }, ok]);
    const post = await runner.emitToolResult({ type: "tool_result", toolName: "read", toolCallId: "post", input: { path: "x" }, content: [ok], details: undefined, isError: false });
    expect(post?.content).toEqual([{ type: "text", text: named("PostToolUse", "read") }, ok]);
    expect(messages).toEqual([]);
  } finally {
    await runner.emit({ type: "session_shutdown" });
    runner.clearManagedTimers();
    auth.close();
  }
});

// Claude Code 2.1.277 events outside the adapter's native set, plus one native hook.
function mixedEvents(plugin: string, subagentMatcher?: string) {
  const record = (name: string) => ({ type: "command", command: `{ cat; echo; } >> "$CLAUDE_PROJECT_DIR/${name}.json"` });
  writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [record("pre")] }],
    Notification: [{ matcher: "permission_prompt", hooks: [record("permission")] }, { matcher: "idle_prompt", hooks: [record("idle")] }],
    SubagentStart: [{ ...(subagentMatcher ? { matcher: subagentMatcher } : {}), hooks: [{ type: "command", command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "DELEGATE MODES" } })}'` }] }],
    SubagentStop: [{ hooks: [record("subagent-stop")] }],
  } }));
}

test("skipping unsupported declarations converts the rest and reports every skipped hook", async () => {
  const { plugin, out, root } = fixture();
  mixedEvents(plugin);
  const strict = await convertHooks(plugin, { out: path.join(root, "strict") });
  expect(strict.exitCode).toBe(2);
  expect(existsSync(path.join(root, "strict", "index.ts"))).toBe(false);

  const result = await convertHooks(plugin, { out, skipUnsupported: true });
  expect(result.exitCode).toBe(0);
  expect(result.report.options).toEqual({ skipUnsupported: true, approximate: false });
  expect(result.report.hooks.map(({ event, status }) => [event, status])).toEqual([
    ["PreToolUse", "supported"],
    ["Notification", "unsupported"], ["Notification", "unsupported"],
    ["SubagentStart", "unsupported"],
    ["SubagentStop", "unsupported"],
  ]);
  const generated = readFileSync(path.join(out, "index.ts"), "utf8");
  expect(generated).toContain('"PreToolUse"');
  for (const skipped of ["Notification", "SubagentStart", "SubagentStop"]) expect(generated).not.toContain(`"${skipped}"`);
});

test("skipping unsupported declarations never emits a command that embeds the original source root", async () => {
  const { plugin, out } = fixture();
  writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ type: "command", command: `node ${plugin}/hooks/guard.cjs` }] }],
  } }));
  const result = await convertHooks(plugin, { out, skipUnsupported: true });
  expect(result.exitCode).toBe(2);
  expect(existsSync(path.join(out, "index.ts"))).toBe(false);
});

test("approximations cover Notification and unmatched SubagentStart; other events stay unsupported", async () => {
  const { plugin, root } = fixture();
  mixedEvents(plugin);
  const approximate = await convertHooks(plugin, { dryRun: true, approximate: true });
  expect(approximate.exitCode).toBe(2); // SubagentStop has no approximation
  expect(approximate.report.hooks.map(({ event, status }) => [event, status])).toEqual([
    ["PreToolUse", "supported"],
    ["Notification", "approximated"], ["Notification", "approximated"],
    ["SubagentStart", "approximated"],
    ["SubagentStop", "unsupported"],
  ]);
  expect(approximate.report.diagnostics.some(item => item.level === "info" && item.pointer === "/hooks/Notification"
    && item.message.includes("tool_approval_requested"))).toBe(true);

  // OMP does not expose a subagent's agent type, so a typed SubagentStart matcher cannot be approximated.
  const typed = path.join(root, "typed");
  cpSync(plugin, typed, { recursive: true });
  mixedEvents(typed, "Explore");
  const typedResult = await convertHooks(typed, { dryRun: true, approximate: true, skipUnsupported: true });
  expect(typedResult.report.hooks.find(hook => hook.event === "SubagentStart")?.status).toBe("unsupported");
});

test("generated approximations notify on approval requests and idle stops, and brief subagents only", async () => {
  const { plugin, project, out } = fixture();
  mixedEvents(plugin);
  const cli = fileURLToPath(new URL("../src/convert.ts", import.meta.url));
  const run = Bun.spawn([process.execPath, cli, plugin, "--out", out, "--approximate", "--skip-unsupported"], { stdout: "pipe", stderr: "pipe" });
  expect(await run.exited).toBe(0);
  const loaded = await loadExtensions([path.join(out, "index.ts")], project);
  expect(loaded.errors).toEqual([]);
  const handlers = loaded.extensions[0].handlers;
  const emit = async (event: { type: string; [key: string]: unknown }, sessionFile?: string) => {
    const ctx = { cwd: project, sessionManager: { getSessionFile: () => sessionFile }, ui: { notify: () => {} }, isProjectTrusted: () => true, hasUI: false };
    const results = [];
    for (const handler of handlers.get(event.type) ?? []) results.push(await handler(event as never, ctx as never));
    return results.filter(Boolean);
  };
  // CLAUDE_PROJECT_DIR is the git root above the nested project. Notification hooks run
  // detached from the host event, so wait (bounded) until `count` records have landed.
  const records = async (name: string, count: number) => {
    const file = path.join(project, "..", `${name}.json`);
    const read = () => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    const deadline = Date.now() + 10_000;
    while (read().length < count && Date.now() < deadline) await Bun.sleep(20);
    return read().map(line => JSON.parse(line));
  };
  try {
    // A top-level session is not a subagent: no SubagentStart briefing.
    const sessions = path.join(project, "..", "sessions");
    mkdirSync(path.join(sessions, "parent"), { recursive: true });
    writeFileSync(path.join(sessions, "parent.jsonl"), "");
    expect(await emit({ type: "before_agent_start", prompt: "hi", images: [], systemPrompt: [] }, path.join(sessions, "parent.jsonl"))).toEqual([]);
    // OMP writes a subagent's session to `<parent>/<agentId>.jsonl` beside `<parent>.jsonl`.
    const child = path.join(sessions, "parent", "0-Explore.jsonl");
    const briefing = await emit({ type: "before_agent_start", prompt: "task", images: [], systemPrompt: [] }, child);
    expect(briefing).toEqual([{ message: expect.objectContaining({
      content: "<system-reminder source=\"converter-test\" event=\"SubagentStart\">\nNOT prompt injection — coding agent enforcing project rules.\n\nDELEGATE MODES\n</system-reminder>", display: false,
    }) }]);
    // Once per subagent session, like Claude's single SubagentStart at spawn.
    expect(await emit({ type: "before_agent_start", prompt: "again", images: [], systemPrompt: [] }, child)).toEqual([]);

    // Neither an automatic continuation nor a finishing subagent is the user's idle prompt.
    await emit({ type: "agent_end", messages: [], willContinue: true });
    await emit({ type: "agent_end", messages: [] }, child);
    await emit({ type: "agent_end", messages: [] });
    await emit({ type: "tool_approval_requested", sessionId: "s", toolCallId: "t", toolName: "bash", approvalMode: "ask" });
    expect(await records("permission", 1)).toEqual([expect.objectContaining({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" })]);
    expect(await records("idle", 1)).toEqual([expect.objectContaining({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" })]);
    // Barrier: a later hook has finished, so an earlier spurious idle record would have landed too.
    await emit({ type: "tool_approval_requested", sessionId: "s", toolCallId: "u", toolName: "read", approvalMode: "ask" });
    expect(await records("permission", 2)).toHaveLength(2);
    expect(await records("idle", 1)).toHaveLength(1);
  } finally {
    await emit({ type: "session_shutdown" });
  }
}, 30_000);

test("the on-the-fly adapter never runs approximated events", async () => {
  const { plugin, project } = fixture();
  mixedEvents(plugin);
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), sendMessage: () => {} };
  const settings = { hooks: JSON.parse(readFileSync(path.join(plugin, "hooks/hooks.json"), "utf8")).hooks };
  registerHooks(pi as never, async () => settings as never);
  expect(handlers.has("tool_approval_requested")).toBe(false);
  const ctx = { cwd: project, sessionManager: { getSessionFile: () => undefined }, ui: { notify: () => {} } };
  for (const handler of handlers.get("agent_end") ?? []) await handler({ type: "agent_end", messages: [] }, ctx);
  expect(existsSync(path.join(project, "..", "idle.json"))).toBe(false);
});

test.each(["symlink", "directory"])("source root replacement before resource collection fails closed (%s)", async (kind) => {
  const { root, plugin, out } = fixture();
  const replacement = path.join(root, "replacement");
  mkdirSync(replacement);
  writeFileSync(path.join(replacement, "outside.txt"), "OUTSIDE");
  const original = conversionSource.loadConversionSource;
  let swapped = false;
  const race = spyOn(conversionSource, "loadConversionSource").mockImplementation(async (input, options) => {
    const source = await original(input, options);
    if (!swapped && input === plugin) {
      swapped = true;
      renameSync(plugin, `${plugin}-saved`);
      if (kind === "symlink") symlinkSync(replacement, plugin);
      else renameSync(replacement, plugin);
    }
    return source;
  });
  try {
    await expect(convertHooks(plugin, { out })).rejects.toThrow();
    expect(swapped).toBe(true);
    expect(existsSync(out)).toBe(false);
  } finally {
    race.mockRestore();
  }
});

test("unrelated absolute path prefixes do not masquerade as source-root references", async () => {
  const { plugin } = fixture();
  writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node", args: [`${plugin}-extra/guard.js`] }] }] },
  }));
  expect((await convertHooks(plugin, { dryRun: true })).exitCode).toBe(0);
  for (const reference of [plugin, `${plugin}/hooks/guard.cjs`]) {
    writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "node", args: [reference] }] }] },
    }));
    expect((await convertHooks(plugin, { dryRun: true })).exitCode).toBe(2);
  }
});

test("a slow Notification hook never delays the approval prompt or the next turn", async () => {
  const { project } = fixture();
  const release = path.join(project, "release");
  const recorded = path.join(project, "notified.jsonl");
  // Blocks until the test releases it, like a notifier waiting on the network.
  const command = `while [ ! -f "${release}" ]; do sleep 0.05; done; { cat; echo; } >> "${recorded}"`;
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), sendMessage: () => {} };
  registerHooks(pi as never, async () => ({ hooks: { Notification: [{ hooks: [{ type: "command", command }] }] } }), { approximations: true });
  const ctx = { cwd: project, sessionManager: { getSessionFile: () => undefined }, ui: { notify: () => {} } };
  const emit = (event: { type: string; [key: string]: unknown }) => Promise.all((handlers.get(event.type) ?? []).map(handler => handler(event, ctx)));
  await emit({ type: "tool_approval_requested", sessionId: "s", toolCallId: "t", toolName: "read", approvalMode: "ask" });
  await emit({ type: "agent_end", messages: [] });
  expect(existsSync(recorded)).toBe(false);
  writeFileSync(release, "");
  // Real hook processes finish on their own clock; wait for both records, bounded.
  const deadline = Date.now() + 10_000;
  while ((existsSync(recorded) ? readFileSync(recorded, "utf8").trim().split("\n").length : 0) < 2 && Date.now() < deadline) await Bun.sleep(20);
  expect(readFileSync(recorded, "utf8").trim().split("\n").map(line => JSON.parse(line).notification_type).sort()).toEqual(["idle_prompt", "permission_prompt"]);
});

test("a blocking Stop hook's continuation is not reported as an idle prompt", async () => {
  const { project } = fixture();
  const recorded = path.join(project, "notified.jsonl");
  const record = { type: "command", command: `{ cat; echo; } >> "${recorded}"` };
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), sendMessage: () => {} };
  registerHooks(pi as never, async () => ({ hooks: {
    Stop: [{ hooks: [{ type: "command", command: `printf '%s' '{"decision":"block","reason":"Run the tests."}'` }] }],
    Notification: [{ hooks: [record] }],
  } }), { approximations: true });
  const ctx = { cwd: project, sessionManager: { getSessionFile: () => undefined }, ui: { notify: () => {} } };
  // OMP runs agent_end handlers in registration order, awaiting each.
  const emit = async (event: { type: string; [key: string]: unknown }) => { for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx); };
  await emit({ type: "agent_end", messages: [] });
  // Barrier: once this later detached hook has recorded, an idle record would have too.
  await emit({ type: "tool_approval_requested", sessionId: "s", toolCallId: "t", toolName: "read", approvalMode: "ask" });
  const deadline = Date.now() + 10_000;
  while (!(existsSync(recorded) && readFileSync(recorded, "utf8").includes("permission_prompt")) && Date.now() < deadline) await Bun.sleep(20);
  expect(readFileSync(recorded, "utf8").trim().split("\n").map(line => JSON.parse(line).notification_type)).toEqual(["permission_prompt"]);
});

test("a hook that names a plugin resource left out by --include cannot convert", async () => {
  const { plugin, out } = fixture();
  writeFileSync(path.join(plugin, "selected.txt"), "selected");
  // fixture()'s hook runs node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.cjs".
  const result = await convertHooks(plugin, { out, include: ["selected.txt"] });
  expect(result.exitCode).toBe(2);
  expect(existsSync(path.join(out, "index.ts"))).toBe(false);
  expect(result.report.diagnostics).toContainEqual(expect.objectContaining({
    level: "unsupported",
    message: "A hook command references hooks/guard.cjs through CLAUDE_PLUGIN_ROOT, but that resource is not copied; add --include hooks/guard.cjs",
  }));
  // Still not skippable: the hook itself would be emitted and fail at runtime.
  expect((await convertHooks(plugin, { dryRun: true, include: ["selected.txt"], skipUnsupported: true })).exitCode).toBe(2);
  expect((await convertHooks(plugin, { dryRun: true, include: ["hooks/guard.cjs"] })).exitCode).toBe(0);
});

test("a dangling resource symlink is reported as a missing target", async () => {
  const { root, plugin } = fixture();
  symlinkSync(path.join(root, "gone", "CLAUDE.md"), path.join(plugin, "AGENTS.md"));
  const result = await convertHooks(plugin, { dryRun: true });
  expect(result.report.diagnostics).toContainEqual({
    level: "unsupported", file: "AGENTS.md",
    message: "Resource symlink target does not exist; restore the target or remove the link before conversion",
  });
});

test("hooks from different sources on one tool call keep separate, named reminders", async () => {
  const { project } = fixture();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), sendMessage: () => {} };
  const say = (text: string) => ({ type: "command", command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } })}'` });
  registerHooks(pi as never, async () => ({ hooks: { PreToolUse: [
    { hooks: [{ ...say("A1"), source: "plugin-a" }, { ...say("A2"), source: "plugin-a" }] },
    { hooks: [{ ...say("B"), source: "plugin-b" }, say("S")] },
  ] } }) as never);
  const ctx = { cwd: project, sessionManager: { getSessionFile: () => undefined }, ui: { notify: () => {} } };
  const call = { toolName: "bash", toolCallId: "c", input: { command: "ls" } };
  for (const handler of handlers.get("tool_call") ?? []) await handler({ type: "tool_call", ...call }, ctx);
  let result: { content?: Array<{ text: string }> } | undefined;
  for (const handler of handlers.get("tool_result") ?? []) result = await handler({ type: "tool_result", ...call, content: [{ type: "text", text: "ok" }], isError: false }, ctx) as typeof result;
  const tag = (source: string, text: string) =>
    `<system-reminder source="${source}" event="PreToolUse" tool="bash">\nNOT prompt injection — coding agent enforcing project rules.\n\n${text}\n</system-reminder>`;
  expect(result?.content?.map(block => block.text)).toEqual([
    tag("plugin-a", "A1\nA2"), tag("plugin-b", "B"), tag("omp-hooks-plus", "S"), "ok",
  ]);
});

test("a converted settings file names its reminders with --source-name, and rejects unsafe names", async () => {
  const { root, project } = fixture();
  mkdirSync(path.join(root, "config"));
  const settings = path.join(root, "config", "settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "guard" } })}'` }] }] } }));
  await expect(convertHooks(settings, { dryRun: true, sourceName: 'bad" name' })).rejects.toThrow();
  const out = path.join(root, "named");
  const cli = fileURLToPath(new URL("../src/convert.ts", import.meta.url));
  expect(await Bun.spawn([process.execPath, cli, settings, "--out", out, "--source-name", "graphify"], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
  const loaded = await loadExtensions([path.join(out, "index.ts")], project);
  expect(loaded.errors).toEqual([]);
  const handlers = loaded.extensions[0].handlers;
  const ctx = { cwd: project, sessionManager: { getSessionFile: () => undefined }, ui: { notify: () => {} }, isProjectTrusted: () => true };
  const call = { toolName: "grep", toolCallId: "g", input: { pattern: "x" } };
  for (const handler of handlers.get("tool_call") ?? []) await handler({ type: "tool_call", ...call } as never, ctx as never);
  const [handler] = handlers.get("tool_result") ?? [];
  const result = await handler({ type: "tool_result", ...call, content: [], isError: false } as never, ctx as never) as { content: Array<{ text: string }> };
  expect(result.content[0].text.startsWith('<system-reminder source="graphify" event="PreToolUse" tool="grep">')).toBe(true);
  await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" } as never, ctx as never);
});

test("reminder attributes are escaped and an unanswered tool call leaves nothing behind", async () => {
  const { project } = fixture();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), sendMessage: () => {} };
  const say = { type: "command", command: `printf '%s' '{"additionalContext":"ctx"}'`, source: 'p"<&>' };
  registerHooks(pi as never, async () => ({ hooks: { PreToolUse: [{ hooks: [say] }] } }) as never);
  const ctx = { cwd: project, sessionManager: { getSessionFile: () => undefined }, ui: { notify: () => {} } };
  const emit = async (type: string, event: Record<string, unknown>) => {
    let last: unknown;
    for (const handler of handlers.get(type) ?? []) last = await handler({ type, ...event }, ctx);
    return last as { content?: Array<{ text: string }> } | undefined;
  };
  const call = { toolName: 'my"<&tool', toolCallId: "a", input: {} };
  await emit("tool_call", call);
  const result = await emit("tool_result", { ...call, content: [], isError: false });
  expect(result?.content?.[0].text.split("\n")[0]).toBe('<system-reminder source="p&quot;&lt;&amp;&gt;" event="PreToolUse" tool="my&quot;&lt;&amp;tool">');

  // A call whose result never arrives (aborted run) is dropped when the run ends.
  await emit("tool_call", { ...call, toolCallId: "orphan" });
  await emit("agent_end", { messages: [] });
  expect(await emit("tool_result", { ...call, toolCallId: "orphan", content: [], isError: false })).toBeUndefined();
});

test("a converted plugin without a manifest name falls back to omp-hooks-plus, never its directory name", async () => {
  const { plugin, project, root } = fixture();
  writeFileSync(path.join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({}));
  writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `printf '%s' '{"additionalContext":"ctx"}'` }] }] } }));
  const out = path.join(root, "unnamed");
  expect((await convertHooks(plugin, { out })).exitCode).toBe(0);
  const loaded = await loadExtensions([path.join(out, "index.ts")], project);
  const handlers = loaded.extensions[0].handlers;
  const ctx = { cwd: project, sessionManager: { getSessionFile: () => undefined }, ui: { notify: () => {} }, isProjectTrusted: () => true };
  const call = { toolName: "bash", toolCallId: "u", input: {} };
  for (const handler of handlers.get("tool_call") ?? []) await handler({ type: "tool_call", ...call } as never, ctx as never);
  const [handler] = handlers.get("tool_result") ?? [];
  const result = await handler({ type: "tool_result", ...call, content: [], isError: false } as never, ctx as never) as { content: Array<{ text: string }> };
  expect(result.content[0].text.split("\n")[0]).toBe('<system-reminder source="omp-hooks-plus" event="PreToolUse" tool="bash">');
  await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" } as never, ctx as never);
});

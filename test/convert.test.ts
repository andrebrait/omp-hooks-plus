import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, symlinkSync } from "node:fs";
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
        content: `<system-reminder>\nUserPromptSubmit hook additional context: ${literal}\n</system-reminder>`,
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

test("generated tool hooks deliver context as Claude Code's named hook reminder", async () => {
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
  const named = (hookName: string, text: string) =>
    `<system-reminder>\n${hookName} hook additional context: ${text}\n</system-reminder>`;
  try {
    expect((await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "pre", input: { command: "ls" } }))?.block).not.toBe(true);
    await runner.emitToolResult({ type: "tool_result", toolName: "read", toolCallId: "post", input: { path: "x" }, content: [{ type: "text", text: "ok" }], details: undefined, isError: false });
    expect(messages).toEqual([
      { message: expect.objectContaining({ content: named("PreToolUse:Bash", "PreToolUse context"), display: false }), options: { deliverAs: "aside" } },
      { message: expect.objectContaining({ content: named("PostToolUse:Read", "PostToolUse context"), display: false }), options: { deliverAs: "aside" } },
    ]);
  } finally {
    await runner.emit({ type: "session_shutdown" });
    runner.clearManagedTimers();
    auth.close();
  }
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

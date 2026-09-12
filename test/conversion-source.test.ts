import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConversionSource } from "../src/conversion-source";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "conversion-source-"));
  roots.push(root);
  return root;
}

function put(root: string, file: string, value: unknown): string {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
  return target;
}

const group = (command: string) => ({ hooks: [{ type: "command", command }] });

test("inventories every event and handler before the legacy supported filter", async () => {
  const root = tempRoot();
  const file = put(root, "hooks.json", { hooks: {
    Stop: [{ hooks: [
      { type: "command", command: "echo supported" },
      { type: "prompt", prompt: "credential-SENTINEL" },
      { type: "command", command: "echo ignored", once: true, secret: "credential-SENTINEL" },
      { type: "command", command: "" },
    ] }],
    Notification: [group("echo unknown-event")],
    future_event: [group("echo future")],
    stop: [group("echo alias")],
  } });
  const source = await loadConversionSource(file);
  expect(source.report.hooks.map(({ event, status }) => [event, status])).toEqual([
    ["Stop", "supported"], ["Stop", "unsupported"], ["Stop", "unsupported"],
    ["Stop", "invalid"], ["Notification", "unsupported"], ["future_event", "unsupported"],
    ["stop", "supported"],
  ]);
  expect(source.settings.hooks?.Stop).toEqual([group("echo supported")]);
  expect(source.settings.hooks?.stop).toEqual([group("echo alias")]);
  expect(source.report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ pointer: "/hooks/Stop/0/hooks/2/once", level: "unsupported" }),
    expect.objectContaining({ pointer: "/hooks/Stop/0/hooks/2/secret", level: "unsupported" }),
  ]));
  expect(JSON.stringify(source.report)).not.toContain("credential-SENTINEL");
  expect(JSON.stringify(source.report)).not.toContain(root);
});

test("loads all references in declaration order and keeps malformed references visible", async () => {
  const root = tempRoot();
  put(root, ".claude-plugin/plugin.json", { name: "ordered", hooks: ["./one.json", 7, "./missing.json", "./bad.json", "./two.json"] });
  put(root, "one.json", { hooks: { Stop: [group("echo first")] } });
  put(root, "bad.json", "{not json");
  put(root, "two.json", { Stop: [group("echo second")] });
  const source = await loadConversionSource(root);
  expect(source.settings.hooks?.Stop).toEqual([group("echo first"), group("echo second")]);
  expect(source.report.diagnostics.filter(({ level }) => level === "error").map(({ pointer }) => pointer)).toEqual([
    "/hooks/1", "/hooks/2", "",
  ]);
  expect(source.declarationFiles).toEqual(expect.arrayContaining([
    path.join(root, ".claude-plugin/plugin.json"), path.join(root, "one.json"),
    path.join(root, "bad.json"), path.join(root, "two.json"),
  ]));
});

test("supports manifest-free defaults, inline hooks, and plugin disable directives", async () => {
  const defaults = tempRoot();
  put(defaults, "hooks/hooks.json", { hooks: { SessionStart: [group("echo default")] } });
  put(defaults, "settings.json", { disableAllHooks: true });
  const source = await loadConversionSource(defaults);
  expect(source.settings).toEqual({ hooks: { SessionStart: [group("echo default")] }, disableAllHooks: true });
  const inline = tempRoot();
  put(inline, ".claude-plugin/plugin.json", { name: "inline", hooks: { pre_tool_use: [group("echo inline")] } });
  expect((await loadConversionSource(inline)).settings.hooks?.pre_tool_use).toEqual([group("echo inline")]);
});

test("accepts Caveman-shaped inline command hooks while omitting presentation metadata", async () => {
  const root = tempRoot();
  const command = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/caveman.mjs" bootstrap';
  put(root, ".claude-plugin/plugin.json", { name: "caveman", hooks: { SessionStart: [{
    matcher: "startup|resume|clear|compact",
    hooks: [{ type: "command", command, statusMessage: "credential-SENTINEL" }],
  }] } });
  const source = await loadConversionSource(root);
  expect(source.settings.hooks?.SessionStart).toEqual([{
    matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command }],
  }]);
  expect(source.report.hooks).toEqual([{
    file: ".claude-plugin/plugin.json", pointer: "/hooks/SessionStart/0/hooks/0", event: "SessionStart", status: "supported",
  }]);
  expect(source.report.diagnostics.filter(({ level }) => level !== "info")).toEqual([]);
  expect(source.report.diagnostics).toContainEqual(expect.objectContaining({
    level: "info", file: ".claude-plugin/plugin.json", pointer: "/hooks/SessionStart/0/hooks/0/statusMessage",
  }));
  expect(JSON.stringify(source.report)).not.toContain("credential-SENTINEL");
  expect(JSON.stringify(source.report)).not.toContain(command);
});

test("keeps Ponytail-shaped SubagentStart unsupported despite valid presentation metadata", async () => {
  const root = tempRoot();
  put(root, ".claude-plugin/plugin.json", { hooks: { SubagentStart: [{
    matcher: "*",
    hooks: [{ type: "command", command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-start.sh"', statusMessage: "Preparing guidance" }],
  }], SessionStart: [group("echo bootstrap")] } });
  const source = await loadConversionSource(root);
  expect(source.report.hooks.map(({ event, status }) => [event, status])).toEqual([
    ["SubagentStart", "unsupported"], ["SessionStart", "supported"],
  ]);
  expect(source.settings.hooks).toEqual({ SessionStart: [group("echo bootstrap")] });
  expect(source.report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ level: "unsupported", pointer: "/hooks/SubagentStart" }),
    expect.objectContaining({ level: "info", pointer: "/hooks/SubagentStart/0/hooks/0/statusMessage" }),
  ]));
});

test("rejects invalid metadata, unknown execution fields, and malformed hook structure", async () => {
  const root = tempRoot();
  const file = put(root, "settings.json", { hooks: { Stop: [
    { hooks: [{ type: "command", command: "echo x", timeout: 0, if: false, async: "yes" }] },
    { hooks: [{ type: "command", command: "echo x", env: { TOKEN: "credential-SENTINEL" }, statusMessage: "credential-SENTINEL" }] },
    { matcher: 5, hooks: [{ type: "http", url: "https://secret.invalid/token" }] },
    { future: true, hooks: [{ type: "agent", prompt: "secret prompt" }] },
    { hooks: false },
    { hooks: [{ type: "command", command: "echo invalid metadata", statusMessage: false }] },
  ] } });
  const source = await loadConversionSource(file);
  expect(source.report.hooks.map(({ status }) => status)).toEqual(["invalid", "unsupported", "invalid", "unsupported", "invalid", "invalid"]);
  expect(source.settings.hooks).toBeUndefined();
  expect(source.report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ level: "unsupported", pointer: "/hooks/Stop/1/hooks/0/env" }),
    expect.objectContaining({ level: "info", pointer: "/hooks/Stop/1/hooks/0/statusMessage" }),
    expect.objectContaining({ level: "error", pointer: "/hooks/Stop/5/hooks/0/statusMessage" }),
  ]));
  expect(JSON.stringify(source.report)).not.toContain("credential-SENTINEL");
  expect(JSON.stringify(source.report)).not.toContain("secret.invalid");
});

test("discovers nested YAML frontmatter and never globalizes scoped hooks", async () => {
  const root = tempRoot();
  put(root, ".claude-plugin/plugin.json", { skills: ["./extra-skills"], agents: ["./custom-agent.md"] });
  put(root, "skills/nested/check/SKILL.md", "---\nname: check\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: |\n            echo scoped\n---\nSkill body\n");
  put(root, "extra-skills/a/SKILL.md", "---\nhooks: {stop: [{hooks: [{type: command, command: 'echo alias'}]}]}\n---\n");
  put(root, "custom-agent.md", "---\nhooks:\n  SubagentStop:\n    - hooks:\n        - type: prompt\n          prompt: credential-SENTINEL\n---\n");
  const source = await loadConversionSource(root);
  expect(source.report.hooks.map(({ event, status }) => [event, status])).toEqual([
    ["PreToolUse", "unsupported"], ["stop", "unsupported"], ["SubagentStop", "unsupported"],
  ]);
  expect(source.settings.hooks).toBeUndefined();
  expect(source.report.hooks[0]?.pointer).toBe("/frontmatter/hooks/PreToolUse/0/hooks/0");
  expect(JSON.stringify(source.report)).not.toContain("credential-SENTINEL");
});

test("reports broken frontmatter without evaluating YAML or markdown bodies", async () => {
  const root = tempRoot();
  put(root, "skills/broken/SKILL.md", "---\nhooks: [\n---\n");
  put(root, "agents/open.md", "---\nhooks:\n  Stop: []\n");
  const source = await loadConversionSource(root);
  expect(source.report.diagnostics.filter(({ level }) => level === "error").map(({ file }) => file)).toEqual([
    "skills/broken/SKILL.md", "agents/open.md",
  ]);
});

test("rejects lexical and symlink config escapes while accounting for safe siblings", async () => {
  const root = tempRoot();
  const outside = tempRoot();
  put(outside, "hooks.json", { hooks: { Stop: [group("echo escaped")] } });
  symlinkSync(path.join(outside, "hooks.json"), path.join(root, "link.json"));
  put(root, ".claude-plugin/plugin.json", { hooks: ["../escape.json", path.join(outside, "hooks.json"), ".\\escape.json", "https://example.invalid/hooks.json", "./link.json", "./safe.json"] });
  put(root, "safe.json", { hooks: { Stop: [group("echo safe")] } });
  const source = await loadConversionSource(root);
  expect(source.settings.hooks?.Stop).toEqual([group("echo safe")]);
  expect(source.report.diagnostics.filter(({ level }) => level === "error").map(({ pointer }) => pointer)).toEqual([
    "/hooks/0", "/hooks/1", "/hooks/2", "/hooks/3", "/hooks/4",
  ]);
  expect(JSON.stringify(source.report)).not.toContain(outside);
});

test("checks manifest and scoped-directory symlinks before reading them", async () => {
  const root = tempRoot();
  const outside = tempRoot();
  put(outside, "plugin.json", { hooks: { Stop: [group("echo escaped")] } });
  mkdirSync(path.join(root, ".claude-plugin"));
  symlinkSync(path.join(outside, "plugin.json"), path.join(root, ".claude-plugin/plugin.json"));
  symlinkSync(outside, path.join(root, "skills"));
  const source = await loadConversionSource(root);
  expect(source.settings.hooks).toBeUndefined();
  expect(source.report.diagnostics.filter(({ level }) => level === "error").map(({ file }) => file)).toEqual([
    ".claude-plugin/plugin.json", "skills",
  ]);
});

test("file inputs do not discover ambient files or rebase project-relative commands", async () => {
  const root = tempRoot();
  const file = put(root, ".claude/settings.json", { disableAllHooks: false, hooks: { Stop: [group("./scripts/project.sh")] } });
  put(root, "hooks/hooks.json", { hooks: { Stop: [group("echo ambient")] } });
  const source = await loadConversionSource(file, { sourceRoot: root });
  expect(source.root).toBe(root);
  expect(source.report.source.entry).toBe(".claude/settings.json");
  expect(source.declarationFiles).toEqual([file]);
  expect(source.settings).toEqual({ hooks: { Stop: [group("./scripts/project.sh")] }, disableAllHooks: false });
  expect((await loadConversionSource(file)).root).toBe(path.dirname(file));
  await expect(loadConversionSource(file, { sourceRoot: path.join(root, "hooks") })).rejects.toThrow();
});

test("inventories Pi and OMP bindings without reuse, execution, value leaks, or suppressed Claude hooks", async () => {
  const root = tempRoot();
  const sentinel = path.join(root, "executed");
  const native = "./credential-SENTINEL-native.ts";
  put(root, ".claude-plugin/plugin.json", {
    pi: { extensions: [native] }, omp: { extensions: [native] },
  });
  put(root, "package.json", {
    pi: { extensions: [native] }, omp: { extensions: [native] }, scripts: { prepare: `touch ${sentinel}` },
  });
  put(root, native, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "bad");`);
  put(root, "hooks/hooks.json", { hooks: { Stop: [group(`touch ${sentinel}`)], Notification: [group("echo unsupported")] } });
  const source = await loadConversionSource(root);
  expect(existsSync(sentinel)).toBe(false);
  expect(source.report.hooks.map(({ status }) => status)).toEqual(["supported", "unsupported"]);
  expect(source.settings.hooks?.Stop).toEqual([group(`touch ${sentinel}`)]);
  expect(source.report.schemaVersion).toBe(1);
  expect(source.report.conversionLevel).toBe("command-hook-adaptation");
  expect(source.report.nativeBindings).toEqual([
    { file: ".claude-plugin/plugin.json", pointer: "/pi", kind: "pi", status: "not-reused" },
    { file: ".claude-plugin/plugin.json", pointer: "/pi/extensions/0", kind: "pi", status: "not-reused" },
    { file: ".claude-plugin/plugin.json", pointer: "/omp", kind: "omp", status: "not-reused" },
    { file: ".claude-plugin/plugin.json", pointer: "/omp/extensions/0", kind: "omp", status: "not-reused" },
    { file: "package.json", pointer: "/pi", kind: "pi", status: "not-reused" },
    { file: "package.json", pointer: "/pi/extensions/0", kind: "pi", status: "not-reused" },
    { file: "package.json", pointer: "/omp", kind: "omp", status: "not-reused" },
    { file: "package.json", pointer: "/omp/extensions/0", kind: "omp", status: "not-reused" },
  ]);
  expect(source.report.diagnostics).toContainEqual(expect.objectContaining({ file: "package.json", pointer: "/pi/extensions/0", level: "info" }));
  expect(JSON.stringify(source.report)).not.toContain("credential-SENTINEL");
  expect(JSON.stringify(source.report)).not.toContain(sentinel);
  expect(JSON.stringify(source.report)).not.toContain("touch");
});

test("unreadable and unparseable explicit roots throw instead of returning empty success", async () => {
  const root = tempRoot();
  const invalid = put(root, "invalid.json", "{broken");
  await expect(loadConversionSource(invalid)).rejects.toThrow();
  await expect(loadConversionSource(path.join(root, "missing.json"))).rejects.toThrow();
  const file = put(root, "array.json", []);
  const source = await loadConversionSource(file);
  expect(source.report.diagnostics).toContainEqual(expect.objectContaining({ level: "error", pointer: "" }));
});

test("non-hook settings are info-only and do not expose field values", async () => {
  const root = tempRoot();
  const file = put(root, "settings.json", {
    permissions: { allow: ["credential-SENTINEL"] },
    model: "credential-SENTINEL",
    env: { TOKEN: "credential-SENTINEL" },
    disableAllHooks: true,
    hooks: { Stop: [group("echo selected")] },
  });
  const source = await loadConversionSource(file);
  expect(source.settings).toEqual({ disableAllHooks: true, hooks: { Stop: [group("echo selected")] } });
  expect(source.report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ level: "info", pointer: "/permissions" }),
    expect.objectContaining({ level: "info", pointer: "/model" }),
    expect.objectContaining({ level: "info", pointer: "/env" }),
  ]));
  expect(source.report.diagnostics.filter(({ level }) => level !== "info")).toEqual([]);
  expect(JSON.stringify(source.report)).not.toContain("credential-SENTINEL");
});

test("unrelated skill frontmatter is not excluded from copied resources", async () => {
  const root = tempRoot();
  const skill = put(root, "skills/plain/SKILL.md", "---\nname: plain\ndescription: Example\n---\nSkill body\n");
  const source = await loadConversionSource(root);
  expect(source.declarationFiles).not.toContain(skill);
  expect(source.report.hooks).toEqual([]);
  expect(source.report.diagnostics.filter(({ level }) => level !== "info")).toEqual([]);
});

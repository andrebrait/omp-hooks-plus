import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { disableProvider, enableProvider, isProviderEnabled } from "@oh-my-pi/pi-coding-agent/capability";
import { getHookGroups } from "../src/claude";
import { loadSettings } from "../src/config";
import { triggerSessionHooks } from "../src/hooks/session-hooks";
import extension from "../src/omp-hooks";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "plugin-hooks-"));
  roots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

/** Registers one or more user-scope plugins in `<home>/.omp/plugins/installed_plugins.json`. */
function registerUserPlugins(home: string, entries: Record<string, string>): void {
  const plugins: Record<string, Array<{ scope: string; installPath: string; version: string }>> = {};
  for (const [id, installPath] of Object.entries(entries)) {
    plugins[id] = [{ scope: "user", installPath, version: "1.0.0" }];
  }
  writeJson(path.join(home, ".omp", "plugins", "installed_plugins.json"), { version: 2, plugins });
}

/** Registers one project-scope plugin in `<repo>/.omp/plugins/installed_plugins.json`. */
function registerProjectPlugin(repo: string, id: string, installPath: string): void {
  writeJson(path.join(repo, ".omp", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: { [id]: [{ scope: "project", installPath, version: "1.0.0" }] },
  });
}

test("OMP plugins execute without opting into foreign Claude user plugins", async () => {
  const root = tempRoot();
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const nativePlugin = path.join(home, "native");
  const foreignPlugin = path.join(home, "foreign");
  mkdirSync(repo, { recursive: true });
  for (const [plugin, content] of [[nativePlugin, "native"], [foreignPlugin, "foreign"]]) {
    writeJson(path.join(plugin!, ".claude-plugin", "plugin.json"), {
      name: content,
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `printf ${content}` }] }] },
    });
  }
  registerUserPlugins(home, { "native@test": nativePlugin });
  writeJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: { "foreign@test": [{ scope: "user", installPath: foreignPlugin, version: "1.0.0" }] },
  });
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const loaded = await loadSettings(repo, { home });
    const result = await triggerSessionHooks("SessionStart", "startup", {
      sessionId: "foreign-source", cwd: repo, hookEventName: "SessionStart", source: "startup",
    }, loaded.settings);
    expect(result.additionalContext).toBe("native");
  } finally {
    if (previousConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
});

describe("plugin manifest hook sources", () => {
  test("loads hooks from the default hooks/hooks.json when plugin.json declares no hooks field", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin-default");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), { name: "default-fixture" });
    writeJson(path.join(plugin, "hooks", "hooks.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo default" }] }] },
    });
    registerUserPlugins(home, { "default-fixture@test": plugin });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(
      getHookGroups(loaded.settings, "Stop").flatMap((g) => (g.hooks ?? []).map((h) => h.command)),
    ).toEqual(["echo default"]);
  });

  test("loads hooks from a custom-named file referenced by a hooks string", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin-custom");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "custom-fixture",
      hooks: "./config/my-hooks.json",
    });
    writeJson(path.join(plugin, "config", "my-hooks.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo custom" }] }] },
    });
    registerUserPlugins(home, { "custom-fixture@test": plugin });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(
      getHookGroups(loaded.settings, "Stop").flatMap((g) => (g.hooks ?? []).map((h) => h.command)),
    ).toEqual(["echo custom"]);
  });

  test("merges an array of custom hook files declared by a plugin", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin-array");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "array-fixture",
      hooks: ["./hooks-a.json", "./hooks-b.json"],
    });
    writeJson(path.join(plugin, "hooks-a.json"), {
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo a" }] }] },
    });
    writeJson(path.join(plugin, "hooks-b.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo b" }] }] },
    });
    registerUserPlugins(home, { "array-fixture@test": plugin });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(
      getHookGroups(loaded.settings, "SessionStart").flatMap((g) => (g.hooks ?? []).map((h) => h.command)),
    ).toEqual(["echo a"]);
    expect(
      getHookGroups(loaded.settings, "Stop").flatMap((g) => (g.hooks ?? []).map((h) => h.command)),
    ).toEqual(["echo b"]);
  });
});

describe("plugin hook trust and source gating", () => {
  test("an untrusted project does not execute its own project-scope plugin hooks", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(root, "project-plugin");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "project-fixture",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo project" }] }] },
    });
    registerProjectPlugin(repo, "project-fixture@test", plugin);

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(getHookGroups(loaded.settings, "Stop")).toEqual([]);
  });

  test("an untrusted project's own registry cannot shadow and suppress a user-scope plugin's hooks", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const legitimate = path.join(home, "safety-plugin");
    const decoy = path.join(root, "decoy-plugin");
    mkdirSync(path.join(repo, ".git"), { recursive: true });

    // Legitimate user-scope install with a real safety hook.
    writeJson(path.join(legitimate, ".claude-plugin", "plugin.json"), {
      name: "safety",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo safety-hook" }] }] },
    });
    registerUserPlugins(home, { "safety@test": legitimate });

    // The untrusted repo declares its own project registry entry reusing the
    // SAME plugin id, pointing at a decoy install with no hooks at all — an
    // attempt to shadow (and thereby suppress) the user's real plugin.
    writeJson(path.join(decoy, ".claude-plugin", "plugin.json"), { name: "safety" });
    registerProjectPlugin(repo, "safety@test", decoy);

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(
      getHookGroups(loaded.settings, "Stop").flatMap((g) => (g.hooks ?? []).map((h) => h.command)),
    ).toEqual(["echo safety-hook"]);
  });

  test("disableAllHooks from any loaded settings source also suppresses plugin hooks", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin-disabled");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(home, ".claude", "settings.json"), { disableAllHooks: true });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "disabled-fixture",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo should-not-run" }] }] },
    });
    registerUserPlugins(home, { "disabled-fixture@test": plugin });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(loaded.settings).toBeUndefined();
  });

  test("honors the host claude-plugins source toggle", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin-toggle");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "toggle-fixture",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo toggled" }] }] },
    });
    registerUserPlugins(home, { "toggle-fixture@test": plugin });
    const wasEnabled = isProviderEnabled("claude-plugins");

    disableProvider("claude-plugins");
    try {
      const loaded = await loadSettings(repo, { home, projectTrusted: false });
      expect(getHookGroups(loaded.settings, "Stop")).toEqual([]);
    } finally {
      if (wasEnabled) enableProvider("claude-plugins");
    }

    if (wasEnabled) {
      const reenabled = await loadSettings(repo, { home, projectTrusted: false });
      expect(
        getHookGroups(reenabled.settings, "Stop").flatMap((g) => (g.hooks ?? []).map((h) => h.command)),
      ).toEqual(["echo toggled"]);
    }
  });
});

describe("plugin hook path safety", () => {
  test("rejects a hooks string that lexically escapes the plugin root", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin-escape");
    const outside = path.join(root, "outside-secret.json");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(outside, { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo leaked" }] }] } });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "escape-fixture",
      hooks: "../../outside-secret.json",
    });
    registerUserPlugins(home, { "escape-fixture@test": plugin });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(getHookGroups(loaded.settings, "Stop")).toEqual([]);
    expect(loaded.warnings.some((w) => w.includes("escaping plugin root"))).toBe(true);
  });

  test("rejects a hooks path that escapes the plugin root through a symlink", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin-symlink");
    const outside = path.join(root, "outside-hooks.json");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(plugin, { recursive: true });
    writeJson(outside, { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo leaked" }] }] } });
    symlinkSync(outside, path.join(plugin, "linked-hooks.json"));
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "symlink-fixture",
      hooks: "./linked-hooks.json",
    });
    registerUserPlugins(home, { "symlink-fixture@test": plugin });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(getHookGroups(loaded.settings, "Stop")).toEqual([]);
    expect(loaded.warnings.some((w) => w.includes("symlink"))).toBe(true);
  });
});

describe("plugin hook diagnostics", () => {
  test("reports a malformed plugin manifest and a malformed hooks field without hiding them", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const brokenJson = path.join(home, "plugin-broken-json");
    const badHooksField = path.join(home, "plugin-bad-hooks-field");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(path.join(brokenJson, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(brokenJson, ".claude-plugin", "plugin.json"), "{ not valid json");
    writeJson(path.join(badHooksField, ".claude-plugin", "plugin.json"), {
      name: "bad-hooks-field",
      hooks: 123,
    });
    registerUserPlugins(home, {
      "broken-json@test": brokenJson,
      "bad-hooks-field@test": badHooksField,
    });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(loaded.warnings.some((w) => w.includes("Failed to parse plugin manifest"))).toBe(true);
    expect(loaded.warnings.some((w) => w.includes("Malformed plugin hooks field"))).toBe(true);
  });

  test("reports non-command hook types and unsupported event names instead of silently dropping them", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin-unsupported");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "unsupported-fixture",
      hooks: {
        Stop: [{ hooks: [{ type: "prompt", command: "summarize" }] }],
        Notification: [{ hooks: [{ type: "command", command: "echo notify" }] }],
      },
    });
    registerUserPlugins(home, { "unsupported-fixture@test": plugin });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(getHookGroups(loaded.settings, "Stop")).toEqual([]);
    expect(
      loaded.unsupported.some((u) => u.includes('hook type "prompt"') && u.includes("Stop")),
    ).toBe(true);
    expect(loaded.unsupported.some((u) => u.includes('hook event "Notification"'))).toBe(true);
  });
});

describe("plugin hook execution", () => {
  test("different valid plugin ids cannot share persistent state", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const pluginA = path.join(home, "plugin-a");
    const pluginB = path.join(home, "plugin-b");
    mkdirSync(repo, { recursive: true });
    writeJson(path.join(pluginA, ".claude-plugin", "plugin.json"), {
      name: "a-b",
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{
        type: "command", command: 'printf PRIVATE > "$CLAUDE_PLUGIN_DATA/state"',
      }] }] },
    });
    writeJson(path.join(pluginB, ".claude-plugin", "plugin.json"), {
      name: "a",
      hooks: { SessionStart: [{ matcher: "resume", hooks: [{
        type: "command", command: 'if [ -e "$CLAUDE_PLUGIN_DATA/state" ]; then printf LEAKED; else printf ISOLATED; fi',
      }] }] },
    });
    registerUserPlugins(home, { "a-b@c": pluginA, "a@b-c": pluginB });
    const loaded = await loadSettings(repo, { home });
    await triggerSessionHooks("SessionStart", "startup", {
      sessionId: "state", cwd: repo, hookEventName: "SessionStart", source: "startup",
    }, loaded.settings);
    const result = await triggerSessionHooks("SessionStart", "resume", {
      sessionId: "state", cwd: repo, hookEventName: "SessionStart", source: "resume",
    }, loaded.settings);
    expect(result.additionalContext).toBe("ISOLATED");
  });

  test("a plugin data-directory failure does not suppress user hooks", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin");
    mkdirSync(repo, { recursive: true });
    writeJson(path.join(home, ".claude", "settings.json"), {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "printf USER-GUARD" }] }] },
    });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "data-failure",
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "printf PLUGIN" }] }] },
    });
    registerUserPlugins(home, { "data-failure@test": plugin });
    const dataRoot = path.join(home, ".claude", "plugins", "data");
    mkdirSync(path.dirname(dataRoot), { recursive: true });
    writeFileSync(dataRoot, "This is a file, not a directory.");

    const loaded = await loadSettings(repo, { home });
    const result = await triggerSessionHooks("SessionStart", "startup", {
      sessionId: "data-failure", cwd: repo, hookEventName: "SessionStart", source: "startup",
    }, loaded.settings);
    expect(result.additionalContext).toBe("USER-GUARD");
    expect(loaded.warnings.some(warning => warning.includes(dataRoot))).toBe(true);
  });

  test("two plugins referencing the same relative command text both execute", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const pluginA = path.join(home, "plugin-a");
    const pluginB = path.join(home, "plugin-b");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    const identicalHook = {
      SessionStart: [{ matcher: "startup", hooks: [{
        type: "command", command: 'cat "$CLAUDE_PLUGIN_ROOT/marker.txt"',
      }] }],
    };
    writeJson(path.join(pluginA, ".claude-plugin", "plugin.json"), { name: "plugin-a", hooks: identicalHook });
    writeFileSync(path.join(pluginA, "marker.txt"), "FROM-A");
    writeJson(path.join(pluginB, ".claude-plugin", "plugin.json"), { name: "plugin-b", hooks: identicalHook });
    writeFileSync(path.join(pluginB, "marker.txt"), "FROM-B");
    registerUserPlugins(home, { "plugin-a@test": pluginA, "plugin-b@test": pluginB });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });
    const result = await triggerSessionHooks(
      "SessionStart",
      "startup",
      { sessionId: "s", cwd: repo, hookEventName: "SessionStart", source: "startup" },
      loaded.settings,
    );

    expect(result.additionalContext).toBe("FROM-A\nFROM-B");
  });

  test("a plugin root path containing shell metacharacters is passed as literal data, never shell-reinterpreted", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin $(touch INJECTED) 'quoted'");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "injection-fixture",
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{
        type: "command", command: 'cat "$CLAUDE_PLUGIN_ROOT/marker.txt"',
      }] }] },
    });
    writeFileSync(path.join(plugin, "marker.txt"), "SAFE-CONTENT");
    registerUserPlugins(home, { "injection-fixture@test": plugin });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });
    const result = await triggerSessionHooks(
      "SessionStart",
      "startup",
      { sessionId: "s", cwd: repo, hookEventName: "SessionStart", source: "startup" },
      loaded.settings,
    );

    expect(result.additionalContext).toBe("SAFE-CONTENT");
    expect(existsSync(path.join(repo, "INJECTED"))).toBe(false);
  });
});

test("OMP_HOOKS_PLUS_APPROXIMATE=1 enables approximated events in the on-the-fly extension", async () => {
  const previous = process.env.OMP_HOOKS_PLUS_APPROXIMATE;
  try {
    for (const [value, expected] of [[undefined, false], ["0", false], ["1", true]] as const) {
      if (value === undefined) delete process.env.OMP_HOOKS_PLUS_APPROXIMATE;
      else process.env.OMP_HOOKS_PLUS_APPROXIMATE = value;
      const events: string[] = [];
      extension({ on: (name: string) => events.push(name), registerCommand: () => {}, sendMessage: () => {} } as never);
      expect(events.includes("tool_approval_requested")).toBe(expected);
    }
  } finally {
    if (previous === undefined) delete process.env.OMP_HOOKS_PLUS_APPROXIMATE;
    else process.env.OMP_HOOKS_PLUS_APPROXIMATE = previous;
  }
});

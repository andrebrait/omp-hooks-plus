import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHookGroups } from "../src/claude";
import { loadSettings } from "../src/config";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-hooks-plus-"));
  roots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function hook(command: string): object {
  return { type: "command", command };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("Claude settings hierarchy", () => {
  test("merges user, project, and local hooks in scope order", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const nested = path.join(repo, "src", "nested");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeJson(path.join(home, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [hook("user")] }] },
    });
    writeJson(path.join(repo, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [hook("project")] }] },
    });
    writeJson(path.join(repo, ".claude", "settings.local.json"), {
      hooks: { Stop: [{ hooks: [hook("local")] }] },
    });

    const loaded = await loadSettings(nested, { home, projectTrusted: true });

    expect(loaded.mode).toBe("claude-native");
    expect(loaded.projectRoot).toBe(repo);
    expect(loaded.sources.map((source) => source.scope)).toEqual([
      "user",
      "project",
      "local",
    ]);
    expect(
      getHookGroups(loaded.settings, "Stop").flatMap((group) =>
        (group.hooks ?? []).map((item) => item.command),
      ),
    ).toEqual(["user", "project", "local"]);
  });

  test("uses .agents hooks as project authority without double-running Claude project hooks", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(home, ".claude", "settings.json"), {
      hooks: { PreToolUse: [{ hooks: [hook("user")] }] },
    });
    writeJson(path.join(repo, ".agents", "hooks.json"), {
      hooks: { PreToolUse: [{ hooks: [hook("agents")] }] },
    });
    writeJson(path.join(repo, ".claude", "settings.json"), {
      hooks: { PreToolUse: [{ hooks: [hook("project-adapter")] }] },
    });

    const loaded = await loadSettings(repo, { home, projectTrusted: true });

    expect(loaded.mode).toBe("cross-vendor");
    expect(loaded.sources.map((source) => source.scope)).toEqual([
      "user",
      "agents",
    ]);
    expect(
      getHookGroups(loaded.settings, "PreToolUse").flatMap((group) =>
        (group.hooks ?? []).map((item) => item.command),
      ),
    ).toEqual(["user", "agents"]);
  });

  test("loads only user hooks for an untrusted project", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(home, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [hook("user")] }] },
    });
    writeJson(path.join(repo, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [hook("project")] }] },
    });

    const loaded = await loadSettings(repo, { home, projectTrusted: false });

    expect(loaded.mode).toBe("user-only");
    expect(loaded.sources.map((source) => source.scope)).toEqual(["user"]);
    expect(getHookGroups(loaded.settings, "Stop")).toHaveLength(1);
  });

  test("honors disableAllHooks across loaded scopes", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(home, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [hook("user")] }] },
    });
    writeJson(path.join(repo, ".claude", "settings.local.json"), {
      disableAllHooks: true,
    });

    const loaded = await loadSettings(repo, { home, projectTrusted: true });

    expect(loaded.settings).toBeUndefined();
  });
  test("observes settings changes without restarting the extension", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const settingsPath = path.join(repo, ".claude", "settings.json");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(settingsPath, {
      hooks: { Stop: [{ hooks: [hook("before")] }] },
    });

    const before = await loadSettings(repo, { home, projectTrusted: true });
    writeJson(settingsPath, {
      hooks: { Stop: [{ hooks: [hook("after")] }] },
    });
    const after = await loadSettings(repo, { home, projectTrusted: true });

    expect(getHookGroups(before.settings, "Stop")[0]?.hooks?.[0]?.command)
      .toBe("before");
    expect(getHookGroups(after.settings, "Stop")[0]?.hooks?.[0]?.command)
      .toBe("after");
  });

});

describe("events outside the native set", () => {
  const userSettings = (home: string) => writeJson(path.join(home, ".claude", "settings.json"), {
    hooks: {
      Stop: [{ hooks: [hook("stop")] }],
      Notification: [{ matcher: "idle_prompt", hooks: [hook("notify")] }],
      SubagentStart: [{ hooks: [hook("brief")] }],
      SubagentStop: [{ hooks: [hook("never")] }],
    },
  });

  test("settings-file events that cannot run are reported, not silently dropped", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    userSettings(home);
    const loaded = await loadSettings(root, { home });
    const settingsPath = path.join(home, ".claude", "settings.json");
    for (const event of ["Notification", "SubagentStart", "SubagentStop"]) {
      expect(loaded.unsupported).toContain(`Hook event "${event}" in ${settingsPath} is not supported`);
    }
    expect(getHookGroups(loaded.settings, "Notification")).toEqual([]);
    expect(getHookGroups(loaded.settings, "Stop")).toHaveLength(1);
  });

  test("approximation loads Notification and SubagentStart and reports how each is approximated", async () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    userSettings(home);
    const loaded = await loadSettings(root, { home, approximate: true });
    const settingsPath = path.join(home, ".claude", "settings.json");
    expect(getHookGroups(loaded.settings, "Notification").flatMap((group) => group.hooks ?? []).map((item) => item.command)).toEqual(["notify"]);
    expect(getHookGroups(loaded.settings, "SubagentStart").flatMap((group) => group.hooks ?? []).map((item) => item.command)).toEqual(["brief"]);
    expect(loaded.unsupported).toContain(`Hook event "SubagentStop" in ${settingsPath} is not supported`);
    expect(loaded.unsupported.some((item) => item.includes("Notification") && item.includes("not supported"))).toBe(false);
    expect(loaded.approximated).toEqual([
      expect.stringContaining("Notification: Approximated: permission_prompt fires on OMP tool_approval_requested"),
      expect.stringContaining("SubagentStart: Approximated: fires before the first run of an OMP subagent session"),
    ]);
  });
});

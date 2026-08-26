import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHookGroups, loadSettings } from "../src/config";

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
  test("merges user, project, and local hooks in scope order", () => {
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

    const loaded = loadSettings(nested, { home, projectTrusted: true });

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

  test("uses .agents hooks as project authority without double-running Claude project hooks", () => {
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

    const loaded = loadSettings(repo, { home, projectTrusted: true });

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

  test("loads only user hooks for an untrusted project", () => {
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

    const loaded = loadSettings(repo, { home, projectTrusted: false });

    expect(loaded.mode).toBe("user-only");
    expect(loaded.sources.map((source) => source.scope)).toEqual(["user"]);
    expect(getHookGroups(loaded.settings, "Stop")).toHaveLength(1);
  });

  test("honors disableAllHooks across loaded scopes", () => {
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

    const loaded = loadSettings(repo, { home, projectTrusted: true });

    expect(loaded.settings).toBeUndefined();
  });
  test("observes settings changes without restarting the extension", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const settingsPath = path.join(repo, ".claude", "settings.json");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(settingsPath, {
      hooks: { Stop: [{ hooks: [hook("before")] }] },
    });

    const before = loadSettings(repo, { home, projectTrusted: true });
    writeJson(settingsPath, {
      hooks: { Stop: [{ hooks: [hook("after")] }] },
    });
    const after = loadSettings(repo, { home, projectTrusted: true });

    expect(getHookGroups(before.settings, "Stop")[0]?.hooks?.[0]?.command)
      .toBe("before");
    expect(getHookGroups(after.settings, "Stop")[0]?.hooks?.[0]?.command)
      .toBe("after");
  });

});

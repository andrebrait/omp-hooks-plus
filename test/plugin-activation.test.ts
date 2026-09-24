import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings } from "../src/config";
import { triggerSessionHooks } from "../src/hooks/session-hooks";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

test("an installed plugin injects its own instructions at startup and compaction", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "plugin-activation-"));
  roots.push(root);
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const plugin = path.join(home, "plugin with spaces $literal");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
    name: "fixture",
    hooks: {
      SessionStart: [{ matcher: "startup|compact", hooks: [{
        type: "command",
        command: 'cat "$CLAUDE_PLUGIN_ROOT/instructions.txt"',
      }] }],
    },
  });
  writeFileSync(path.join(plugin, "instructions.txt"), "Read the relevant skill before acting.");
  writeJson(path.join(home, ".omp", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: { "fixture@test": [{ scope: "user", installPath: plugin, version: "1.0.0" }] },
  });

  const loaded = await loadSettings(repo, { home, projectTrusted: true });
  for (const source of ["startup", "compact"] as const) {
    const result = await triggerSessionHooks("SessionStart", source, {
      sessionId: "fixture-session",
      cwd: repo,
      hookEventName: "SessionStart",
      source,
    }, loaded.settings);
    expect(result.contexts).toEqual([{ source: "fixture", text: "Read the relevant skill before acting." }]);
  }
});

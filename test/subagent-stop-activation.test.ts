import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStopEvent,
  SessionStopEventResult,
  SubagentStopEvent,
  SubagentStopEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { loadSettings } from "../src/config";
import { createHookContext } from "../src/hook-context";
import { registerStopHooks, registerSubagentStopHooks } from "../src/hooks/stop-hooks";
import type { NotifyFn, SettingsFile } from "../src/types";
import { processGone, readPidFile } from "./setup";

type StopHandler = (
  event: SessionStopEvent,
  ctx: ExtensionContext,
) => Promise<SessionStopEventResult | undefined>;
type SubagentStopHandler = (
  event: SubagentStopEvent,
  ctx: ExtensionContext,
) => Promise<SubagentStopEventResult | undefined>;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/**
 * The real hook context and the real registrations; only the ExtensionAPI
 * boundary and the extension context are replaced.
 */
function mount(
  settings: SettingsFile | undefined,
  options: { cwd?: string; childSessionFile?: string } = {},
) {
  const stopHandlers = new Map<string, StopHandler>();
  const subagentHandlers = new Map<string, SubagentStopHandler>();
  const sent: unknown[] = [];
  const notifications: Parameters<NotifyFn>[] = [];
  const pi = {
    on: (event: string, handler: StopHandler | SubagentStopHandler) => {
      if (event === "subagent_stop") {
        subagentHandlers.set(event, handler as SubagentStopHandler);
      } else {
        stopHandlers.set(event, handler as StopHandler);
      }
    },
    sendMessage: (...args: unknown[]) => {
      sent.push(args);
    },
  } as unknown as ExtensionAPI;
  const shared = createHookContext(pi, async () => settings);
  // The child pass runs in the child's own context, so `cwd` and the session
  // manager are the child's here.
  const ctx = {
    cwd: options.cwd ?? process.cwd(),
    sessionManager: {
      getSessionFile: () => options.childSessionFile ?? "child-session-file",
    },
    ui: {
      notify: (message: string, type: "info" | "error" | "warning") => {
        notifications.push([message, type]);
      },
    },
  } as unknown as ExtensionContext;
  registerStopHooks(pi, shared);
  registerSubagentStopHooks(pi, shared);
  return {
    stopHandler: () => stopHandlers.get("session_stop"),
    subagentHandler: () => subagentHandlers.get("subagent_stop"),
    sent,
    notifications,
    ctx,
    shared,
  };
}

function subagentStopEvent(overrides: Partial<SubagentStopEvent> = {}): SubagentStopEvent {
  return {
    type: "subagent_stop",
    agent_id: "ReviewChild",
    agent_type: "task",
    session_id: "child-session",
    session_file: "/child/sessions/child.jsonl",
    parent_session_id: "parent-session",
    parent_session_file: "/parent/sessions/parent.jsonl",
    messages: [],
    stop_hook_active: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function stopEvent(overrides: Partial<SessionStopEvent> = {}): SessionStopEvent {
  return {
    type: "session_stop",
    messages: [],
    turn_id: 1,
    session_id: "host-session",
    session_file: "/host/session.jsonl",
    stop_hook_active: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("SubagentStop hook discovery", () => {
  test("the settings key and its snake-case alias both feed the pass", async () => {
    const dir = tempRoot("subagent-stop-settings-");
    const canonical = path.join(dir, "canonical");
    const alias = path.join(dir, "alias");
    const run = mount({
      hooks: {
        SubagentStop: [{
          hooks: [{ type: "command", command: `printf '%s' ran > '${canonical}'` }],
        }],
        subagent_stop: [{
          hooks: [{ type: "command", command: `printf '%s' ran > '${alias}'` }],
        }],
      },
    });
    const handler = run.subagentHandler();
    expect(handler).toBeDefined();

    const result = await handler!(subagentStopEvent(), run.ctx);

    expect(result).toBeUndefined();
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(alias)).toBe(true);
    run.shared.dispose();
  });

  test("a plugin manifest declaring SubagentStop contributes its hooks", async () => {
    const root = tempRoot("subagent-stop-plugin-");
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const plugin = path.join(home, "plugin with spaces $literal");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "fixture",
      hooks: {
        SubagentStop: [{
          hooks: [{ type: "command", command: 'cat "$CLAUDE_PLUGIN_ROOT/refusal.txt" >&2; exit 2' }],
        }],
      },
    });
    writeFileSync(path.join(plugin, "refusal.txt"), "Refine the report and yield again.");
    writeJson(path.join(home, ".omp", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { "fixture@test": [{ scope: "user", installPath: plugin, version: "1.0.0" }] },
    });

    const loaded = await loadSettings(repo, { home, projectTrusted: true });
    const run = mount(loaded.settings);
    const result = await run.subagentHandler()!(subagentStopEvent(), run.ctx);

    expect(result?.decision).toBe("block");
    expect(result?.reason).toBe("Refine the report and yield again.");
    run.shared.dispose();
  });

  test("each stop event reads only its own hook list", async () => {
    const dir = tempRoot("subagent-stop-separation-");
    const stopMarker = path.join(dir, "stop");
    const subagentMarker = path.join(dir, "subagent");
    const run = mount({
      hooks: {
        Stop: [{
          hooks: [{ type: "command", command: `printf '%s' ran > '${stopMarker}'` }],
        }],
        SubagentStop: [{
          hooks: [{ type: "command", command: `printf '%s' ran > '${subagentMarker}'` }],
        }],
      },
    });

    await run.stopHandler()!(stopEvent(), run.ctx);
    expect(existsSync(stopMarker)).toBe(true);
    expect(existsSync(subagentMarker)).toBe(false);

    await run.subagentHandler()!(subagentStopEvent(), run.ctx);
    expect(existsSync(subagentMarker)).toBe(true);
    run.shared.dispose();
  });
});

describe("SubagentStop actor matcher", () => {
  test("a matcher selects the child's agent type", async () => {
    const dir = tempRoot("subagent-stop-matcher-");
    const exploreMarker = path.join(dir, "explore");
    const run = mount({
      hooks: {
        SubagentStop: [
          {
            matcher: "task",
            hooks: [{
              type: "command",
              command: "printf '%s' 'Task children must yield a verified report' >&2; exit 2",
            }],
          },
          {
            matcher: "Explore",
            hooks: [{ type: "command", command: `printf '%s' ran > '${exploreMarker}'` }],
          },
        ],
      },
    });
    const handler = run.subagentHandler();
    expect(handler).toBeDefined();

    const taskResult = await handler!(subagentStopEvent({ agent_type: "task" }), run.ctx);
    expect(taskResult?.decision).toBe("block");
    expect(existsSync(exploreMarker)).toBe(false);

    const exploreResult = await handler!(subagentStopEvent({ agent_type: "Explore" }), run.ctx);
    expect(exploreResult).toBeUndefined();
    expect(existsSync(exploreMarker)).toBe(true);
    run.shared.dispose();
  });
});

describe("SubagentStop hook input identity", () => {
  test("parent and child identities stay in their own fields", async () => {
    const dir = tempRoot("subagent-stop-identity-");
    const childDir = path.join(dir, "child-worktree");
    mkdirSync(childDir, { recursive: true });
    const capture = path.join(dir, "hook-input.json");
    const run = mount(
      {
        hooks: {
          SubagentStop: [{
            hooks: [{ type: "command", command: `cat > '${capture}'` }],
          }],
        },
      },
      { cwd: childDir, childSessionFile: "/child/sessions/fallback.jsonl" },
    );
    const handler = run.subagentHandler();
    expect(handler).toBeDefined();

    await handler!(
      subagentStopEvent({
        session_id: "child-session-7",
        session_file: "/child/sessions/child-session-7.jsonl",
        parent_session_id: "parent-session-42",
        parent_session_file: "/parent/sessions/parent-session-42.jsonl",
        agent_id: "ReviewChild",
        agent_type: "Explore",
        stop_hook_active: true,
        last_assistant_message: {
          role: "assistant",
          content: [{ type: "text", text: "Candidate report" }],
        } as unknown as SubagentStopEvent["last_assistant_message"],
        messages: [{ role: "user", content: "no assistant message here" } as never],
      }),
      run.ctx,
    );

    const observed = JSON.parse(readFileSync(capture, "utf8")) as Record<string, unknown>;
    expect(observed.hook_event_name).toBe("SubagentStop");
    expect(observed.session_id).toBe("parent-session-42");
    expect(observed.transcript_path).toBe("/parent/sessions/parent-session-42.jsonl");
    expect(observed.agent_id).toBe("ReviewChild");
    expect(observed.agent_type).toBe("Explore");
    expect(observed.agent_transcript_path).toBe("/child/sessions/child-session-7.jsonl");
    expect(observed.cwd).toBe(childDir);
    expect(observed.stop_hook_active).toBe(true);
    expect(observed.last_assistant_message).toBe("Candidate report");
    run.shared.dispose();
  });

  test("absent or nonmatching hooks do not diagnose missing parent metadata", async () => {
    const settings: Array<SettingsFile | undefined> = [
      undefined,
      { hooks: { SubagentStop: [{
        matcher: "Explore",
        hooks: [{ type: "command", command: "exit 2" }],
      }] } },
    ];
    for (const configuration of settings) {
      const run = mount(configuration);
      const result = await run.subagentHandler()!(
        subagentStopEvent({
          agent_type: "task",
          parent_session_id: undefined,
          parent_session_file: undefined,
        }),
        run.ctx,
      );
      expect(result).toBeUndefined();
      expect(run.notifications).toEqual([]);
      expect(run.sent).toEqual([]);
      run.shared.dispose();
    }
  });

  test("a pass with no parent session id is refused with a diagnostic, never run as the child", async () => {
    const dir = tempRoot("subagent-stop-no-parent-");
    const marker = path.join(dir, "ran");
    const run = mount({
      hooks: {
        SubagentStop: [{
          hooks: [{ type: "command", command: `printf '%s' ran > '${marker}'` }],
        }],
      },
    });
    const handler = run.subagentHandler();
    expect(handler).toBeDefined();

    const result = await handler!(
      subagentStopEvent({ parent_session_id: undefined }),
      run.ctx,
    );

    expect(result).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(run.notifications).toHaveLength(1);
    expect(String(run.notifications[0][0])).toContain("no parent session id");
    expect(run.notifications[0][1]).toBe("error");
    run.shared.dispose();
  });

  test("a missing parent transcript is omitted, never filled with the child's file", async () => {
    const dir = tempRoot("subagent-stop-no-transcript-");
    const capture = path.join(dir, "hook-input.json");
    const run = mount(
      {
        hooks: {
          SubagentStop: [{
            hooks: [{ type: "command", command: `cat > '${capture}'` }],
          }],
        },
      },
      { childSessionFile: "/child/sessions/from-session-manager.jsonl" },
    );
    const handler = run.subagentHandler();
    expect(handler).toBeDefined();

    await handler!(
      subagentStopEvent({
        parent_session_file: undefined,
        session_file: "/child/sessions/child.jsonl",
      }),
      run.ctx,
    );

    const observed = JSON.parse(readFileSync(capture, "utf8")) as Record<string, unknown>;
    expect("transcript_path" in observed).toBe(false);
    expect(observed.agent_transcript_path).toBe("/child/sessions/child.jsonl");
    expect(run.notifications).toHaveLength(1);
    expect(String(run.notifications[0][0])).toContain("transcript_path");
    expect(run.notifications[0][1]).toBe("warning");
    run.shared.dispose();
  });

  test("the child transcript falls back to the child's own session manager", async () => {
    const dir = tempRoot("subagent-stop-child-file-");
    const capture = path.join(dir, "hook-input.json");
    const run = mount(
      {
        hooks: {
          SubagentStop: [{
            hooks: [{ type: "command", command: `cat > '${capture}'` }],
          }],
        },
      },
      { childSessionFile: "/child/sessions/from-session-manager.jsonl" },
    );
    const handler = run.subagentHandler();
    expect(handler).toBeDefined();

    await handler!(subagentStopEvent({ session_file: undefined }), run.ctx);

    const observed = JSON.parse(readFileSync(capture, "utf8")) as Record<string, unknown>;
    expect(observed.agent_transcript_path).toBe("/child/sessions/from-session-manager.jsonl");
    expect(observed.transcript_path).toBe("/parent/sessions/parent.jsonl");
    run.shared.dispose();
  });
});

describe("SubagentStop decision mapping", () => {
  test("exit 2 refuses the candidate and names the SubagentStop event when stderr is empty", async () => {
    const run = mount({
      hooks: {
        SubagentStop: [{
          hooks: [{ type: "command", command: "exit 2" }],
        }],
      },
    });
    const handler = run.subagentHandler();
    expect(handler).toBeDefined();

    const result = await handler!(subagentStopEvent(), run.ctx);

    expect(result).toEqual({
      decision: "block",
      reason: "SubagentStop hook exited with code 2",
    });
    // Continuation is the host's job; the bridge must not drive the child itself.
    expect(run.sent).toHaveLength(0);
    run.shared.dispose();
  });

  test("a refusal folds every hook's accumulated context into the reason", async () => {
    const run = mount({
      hooks: {
        SubagentStop: [{
          hooks: [
            { type: "command", command: `printf '%s' '{"decision":"block","reason":"Report is unverified"}'` },
            { type: "command", command: `printf '%s' '{"additionalContext":"Re-read the failing assertion"}'` },
          ],
        }],
      },
    });
    const handler = run.subagentHandler();
    expect(handler).toBeDefined();

    const result = await handler!(subagentStopEvent(), run.ctx);

    expect(result).toEqual({
      decision: "block",
      reason: "Report is unverified\n\nRe-read the failing assertion",
    });
    expect(result?.additionalContext).toBeUndefined();
    expect(run.sent).toHaveLength(0);
    run.shared.dispose();
  });

  test("context alone asks the host to continue the same child run", async () => {
    const run = mount({
      hooks: {
        SubagentStop: [{
          hooks: [{ type: "command", command: `printf '%s' '{"additionalContext":"Re-read the failing assertion"}'` }],
        }],
      },
    });
    const handler = run.subagentHandler();
    expect(handler).toBeDefined();

    const result = await handler!(subagentStopEvent(), run.ctx);

    expect(result).toEqual({
      continue: true,
      additionalContext: "Re-read the failing assertion",
    });
    expect(run.sent).toHaveLength(0);
    run.shared.dispose();
  });

  test("a cancelled child run cannot refuse the candidate and leaves no hook process behind", async () => {
    const dir = tempRoot("subagent-stop-abort-");
    const pidFile = path.join(dir, "hook.pid");
    const controller = new AbortController();
    const run = mount({
      hooks: {
        SubagentStop: [{
          hooks: [{
            type: "command",
            command: `echo "$$" > '${pidFile}'; sleep 30; printf '%s' 'Report is unverified' >&2; exit 2`,
          }],
        }],
      },
    });
    const handler = run.subagentHandler();
    expect(handler).toBeDefined();

    const pending = handler!(subagentStopEvent({ signal: controller.signal }), run.ctx);
    const pid = await readPidFile(pidFile);
    controller.abort();

    expect(await pending).toBeUndefined();
    expect(await processGone(-pid)).toBe(true);
    expect(run.sent).toHaveLength(0);
    run.shared.dispose();
  });
});

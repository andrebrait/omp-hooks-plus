import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStopEvent,
  SessionStopEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { createHookContext } from "../src/hook-context";
import { registerStopHooks } from "../src/hooks/stop-hooks";
import type { SettingsFile } from "../src/types";
import { processGone, readPidFile } from "./setup";

type StopHandler = (
  event: SessionStopEvent,
  ctx: ExtensionContext,
) => Promise<SessionStopEventResult | undefined>;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mount(settings: SettingsFile) {
  const handlers = new Map<string, StopHandler>();
  const sent: unknown[] = [];
  const pi = {
    on: (event: string, handler: StopHandler) => {
      handlers.set(event, handler);
    },
    sendMessage: (...args: unknown[]) => {
      sent.push(args);
    },
  } as unknown as ExtensionAPI;
  // The real hook context: only the ExtensionAPI boundary is replaced.
  const shared = createHookContext(pi, async () => settings);
  // Deliberately stale values: the host event is the authority for Stop metadata.
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionFile: () => "stale-session-file" },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  registerStopHooks(pi, shared);
  return { handler: () => handlers.get("session_stop"), sent, ctx, shared };
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

describe("Stop bridge activation on the native session_stop event", () => {
  test("a hook that exits 2 returns a blocking decision to the host", async () => {
    const run = mount({
      hooks: {
        Stop: [{
          hooks: [{ type: "command", command: "printf '%s' 'Verification failed' >&2; exit 2" }],
        }],
      },
    });
    const handler = run.handler();
    expect(handler).toBeDefined();

    const result = await handler!(stopEvent(), run.ctx);

    expect(result?.decision).toBe("block");
    expect(result?.reason).toContain("Verification failed");
    // Continuation is the host's job; the bridge must not inject its own turn.
    expect(run.sent).toHaveLength(0);
    run.shared.dispose();
  });

  test("repeated host stops keep blocking while stop_hook_active is true", async () => {
    const run = mount({
      hooks: {
        Stop: [{
          hooks: [{ type: "command", command: "printf '%s' 'Still failing' >&2; exit 2" }],
        }],
      },
    });
    const handler = run.handler();
    expect(handler).toBeDefined();

    const first = await handler!(stopEvent({ stop_hook_active: true }), run.ctx);
    const second = await handler!(stopEvent({ stop_hook_active: true }), run.ctx);

    expect(first?.decision).toBe("block");
    expect(second?.decision).toBe("block");
    expect(second?.reason).toContain("Still failing");
    expect(run.sent).toHaveLength(0);
    run.shared.dispose();
  });

  test("the command hook observes host identity, active flag and last assistant message", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "stop-activation-"));
    roots.push(dir);
    const capture = path.join(dir, "hook-input.json");
    const run = mount({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: `cat > '${capture}'` }] }],
      },
    });
    const handler = run.handler();
    expect(handler).toBeDefined();

    const lastAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Final answer text" }],
    } as unknown as SessionStopEvent["last_assistant_message"];

    await handler!(
      stopEvent({
        session_id: "host-session-42",
        session_file: "/host/sessions/host-session-42.jsonl",
        stop_hook_active: true,
        last_assistant_message: lastAssistantMessage,
        messages: [{ role: "user", content: "no assistant message here" } as never],
      }),
      run.ctx,
    );

    const observed = JSON.parse(readFileSync(capture, "utf8")) as Record<string, unknown>;
    expect(observed.hook_event_name).toBe("Stop");
    expect(observed.session_id).toBe("host-session-42");
    expect(observed.transcript_path).toBe("/host/sessions/host-session-42.jsonl");
    expect(observed.stop_hook_active).toBe(true);
    expect(observed.last_assistant_message).toBe("Final answer text");
    run.shared.dispose();
  });

  test("context alone asks the host to continue, without the bridge opening a turn", async () => {
    const run = mount({
      hooks: {
        Stop: [{
          hooks: [{ type: "command", command: `printf '%s' '{"additionalContext":"Re-read the failing assertion"}'` }],
        }],
      },
    });
    const handler = run.handler();
    expect(handler).toBeDefined();

    const result = await handler!(stopEvent(), run.ctx);

    expect(result).toEqual({ continue: true, additionalContext: "Re-read the failing assertion" });
    expect(run.sent).toHaveLength(0);
    run.shared.dispose();
  });

  test("a blocking continuation includes context supplied by another hook", async () => {
    const run = mount({
      hooks: {
        Stop: [{
          hooks: [
            { type: "command", command: `printf '%s' '{"decision":"block","reason":"Tests failed"}'` },
            { type: "command", command: `printf '%s' '{"additionalContext":"The failing case is cancellation"}'` },
          ],
        }],
      },
    });
    const result = await run.handler()!(stopEvent(), run.ctx);

    expect(result?.decision).toBe("block");
    expect(result?.reason).toBe("Tests failed\n\nThe failing case is cancellation");
    expect(result?.additionalContext).toBeUndefined();
    expect(run.sent).toEqual([]);
    run.shared.dispose();
  });

  test("a cancelled pass cannot request a continuation and leaves no hook process behind", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "stop-abort-"));
    roots.push(dir);
    const pidFile = path.join(dir, "hook.pid");
    const controller = new AbortController();
    const run = mount({
      hooks: {
        Stop: [{
          hooks: [{
            type: "command",
            command: `echo "$$" > '${pidFile}'; sleep 30; printf '%s' 'Verification failed' >&2; exit 2`,
          }],
        }],
      },
    });
    const handler = run.handler();
    expect(handler).toBeDefined();

    const pending = handler!(stopEvent({ signal: controller.signal }), run.ctx);
    const pid = await readPidFile(pidFile);
    controller.abort();

    expect(await pending).toBeUndefined();
    expect(await processGone(-pid)).toBe(true);
    expect(run.sent).toHaveLength(0);
    run.shared.dispose();
  });
});

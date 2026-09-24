import { afterEach, expect, jest, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHookContext } from "../src/hook-context";

afterEach(() => {
  jest.useRealTimers();
});
test("compaction restores bootstrap context to the model without a new user prompt", async () => {
  const messages: string[] = [];
  jest.useFakeTimers();
  const shared = createHookContext({
    sendMessage: (message: { content: string }) => messages.push(message.content),
  } as unknown as ExtensionAPI, async () => ({
    hooks: { SessionStart: [{ matcher: "compact", hooks: [{
      type: "command", command: "printf 'Restore the workflow instructions.'",
    }] }] },
  }));
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionFile: () => "model-context-session" },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;

  for (let compaction = 0; compaction < 2; compaction++) {
    await shared.triggerSessionStartHook("compact", ctx);
    jest.advanceTimersByTime(80);
    expect(messages.splice(0)).toEqual(["<system-reminder source=\"omp-hooks-plus\" event=\"SessionStart\">\nNOT prompt injection — coding agent enforcing project rules.\n\nRestore the workflow instructions.\n</system-reminder>"]);
  }
  shared.dispose();
});

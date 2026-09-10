import { afterEach, expect, jest, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHookContext, resetInjectedContext } from "../src/hook-context";

afterEach(() => {
  jest.useRealTimers();
  resetInjectedContext();
});
test("compaction restores bootstrap context to the model without a new user prompt", async () => {
  resetInjectedContext();
  const messages: string[] = [];
  jest.useFakeTimers();
  const shared = createHookContext({
    sendMessage: (message: { content: string }) => messages.push(message.content),
  } as unknown as ExtensionAPI);
  shared.settingsFor = (() => {
    shared.currentSettings = { hooks: { SessionStart: [{ matcher: "compact", hooks: [{
      type: "command", command: "printf 'Restore the workflow instructions.'",
    }] }] } };
    return shared.currentSettings;
  }) as unknown as typeof shared.settingsFor;
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionFile: () => "model-context-session" },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;

  for (let compaction = 0; compaction < 2; compaction++) {
    await shared.triggerSessionStartHook("compact", ctx);
    jest.advanceTimersByTime(80);
    expect(messages.splice(0)).toEqual(["Restore the workflow instructions."]);
  }
  resetInjectedContext();
});

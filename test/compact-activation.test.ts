import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHookContext } from "../src/hook-context";

test("plugin bootstrap instructions return after every compaction", async () => {
  const injected: string[] = [];
  const shared = createHookContext({} as ExtensionAPI);
  shared.settingsFor = (() => {
    shared.currentSettings = { hooks: { SessionStart: [{ matcher: "compact", hooks: [{
      type: "command", command: "printf 'Follow the skill before acting.'",
    }] }] } };
    return shared.currentSettings;
  }) as unknown as typeof shared.settingsFor;
  shared.injectHiddenContext = (content) => { injected.push(content); };
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionFile: () => "same-session" },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;

  await shared.triggerSessionStartHook("compact", ctx);
  expect(injected).toEqual(["Follow the skill before acting."]);
  injected.length = 0;
  await shared.triggerSessionStartHook("compact", ctx);
  expect(injected).toEqual(["Follow the skill before acting."]);
});

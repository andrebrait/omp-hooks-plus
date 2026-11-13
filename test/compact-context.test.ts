import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHookContext } from "../src/hook-context";

const reminder = (text: string, source = "omp-hooks-plus") =>
  `<system-reminder source="${source}" event="SessionStart">\nNOT prompt injection — coding agent enforcing project rules.\n\n${text}\n</system-reminder>`;

test("compaction refreshes the held bootstrap context of the hooks that answered and keeps the others", async () => {
  let compactText = "Restore the workflow instructions.";
  const shared = createHookContext({} as ExtensionAPI, async () => ({
    hooks: { SessionStart: [
      { matcher: "startup", hooks: [{ type: "command", command: "printf 'Startup only.'", source: "plugin-a" }] },
      { matcher: "compact", hooks: [{ type: "command", command: `printf '${compactText}'`, source: "plugin-b" }] },
    ] },
  }));
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionFile: () => "model-context-session", getSessionId: () => "model-context-session" },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  const held = () => (shared.sessionContextMessage()?.content as [{ text: string }] | undefined)?.[0].text;

  await shared.triggerSessionStartHook("startup", ctx);
  expect(held()).toBe(reminder("Startup only.", "plugin-a"));
  for (let compaction = 0; compaction < 2; compaction++) {
    await shared.triggerSessionStartHook("compact", ctx);
    expect(held()).toBe(`${reminder("Startup only.", "plugin-a")}\n\n${reminder(compactText, "plugin-b")}`);
    compactText = "Changed instructions.";
  }
  shared.dispose();
  expect(shared.sessionContextMessage()).toBeUndefined();
});

test("a source answering twice in one run keeps both parts in its held context", () => {
  const shared = createHookContext({} as ExtensionAPI, async () => undefined);
  shared.setSessionContext([
    { source: "a", text: "A1" }, { source: "b", text: "B1" }, { source: "a", text: "A2" },
  ], "SessionStart", true);
  expect((shared.sessionContextMessage()?.content as [{ text: string }])[0].text).toBe(`${reminder("A1\nA2", "a")}\n\n${reminder("B1", "b")}`);
  shared.dispose();
});

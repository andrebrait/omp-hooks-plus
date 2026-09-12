import { afterEach, expect, jest, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHookContext, type HookModuleContext } from "../src/hook-context";
import { registerToolHooks } from "../src/hooks/tool-hooks";
import { registerPromptHooks } from "../src/hooks/prompt-hooks";
import { registerStopHooks } from "../src/hooks/stop-hooks";
import type { SettingsFile } from "../src/types";

const contexts: HookModuleContext[] = [];

function context(messages: string[]): HookModuleContext {
  const shared = createHookContext({
    sendMessage: (message: { content: string }) => messages.push(message.content),
  } as unknown as ExtensionAPI, async () => undefined);
  contexts.push(shared);
  return shared;
}

afterEach(() => {
  for (const shared of contexts.splice(0)) shared.dispose();
  jest.useRealTimers();
});

test("identical reminders are delivered once per turn, preserving distinct content", () => {
  const messages: string[] = [];
  const shared = context(messages);
  shared.injectHiddenContext("REMINDER", {}, false, "aside");
  shared.injectHiddenContext("REMINDER", {}, false, "aside");
  shared.injectHiddenContext(" REMINDER", {}, false, "aside");
  expect(messages).toEqual(["REMINDER", " REMINDER"]);

  shared.resetInjectedContext();
  shared.injectHiddenContext("REMINDER", {}, false, "aside");
  expect(messages).toEqual(["REMINDER", " REMINDER", "REMINDER"]);
});

test("two adapters isolate queued content and turn deduplication", () => {
  jest.useFakeTimers();
  const firstMessages: string[] = [];
  const secondMessages: string[] = [];
  const first = context(firstMessages);
  const second = context(secondMessages);
  first.injectHiddenContext("SHARED REMINDER", {});
  first.injectHiddenContext("FIRST ONLY", {});
  second.injectHiddenContext("SHARED REMINDER", {});
  second.injectHiddenContext("SECOND ONLY", {});

  // A prompt/compaction reset must not duplicate content still in the queue.
  first.resetInjectedContext();
  first.injectHiddenContext("SHARED REMINDER", {});
  jest.advanceTimersByTime(80);
  expect(firstMessages).toEqual(["SHARED REMINDER\n\nFIRST ONLY"]);
  expect(secondMessages).toEqual(["SHARED REMINDER\n\nSECOND ONLY"]);

  first.resetInjectedContext();
  first.injectHiddenContext("SHARED REMINDER", {}, false, "aside");
  second.injectHiddenContext("SHARED REMINDER", {}, false, "aside");
  expect(firstMessages).toEqual(["SHARED REMINDER\n\nFIRST ONLY", "SHARED REMINDER"]);
  expect(secondMessages).toEqual(["SHARED REMINDER\n\nSECOND ONLY"]);
});

test("session switch drops queued and late context without disabling the next session", () => {
  jest.useFakeTimers();
  const messages: string[] = [];
  const shared = context(messages);
  const oldDelivery = shared.captureContext();
  oldDelivery.injectHiddenContext("OLD QUEUED", {});
  shared.resetSession();
  oldDelivery.injectHiddenContext("OLD ASYNC", {}, true);
  shared.captureContext().injectHiddenContext("NEW SESSION", {});
  jest.advanceTimersByTime(80);
  expect(messages).toEqual(["NEW SESSION"]);
});

test("disposing one adapter drops its queued and late deliveries without touching another", () => {
  jest.useFakeTimers();
  const firstMessages: string[] = [];
  const secondMessages: string[] = [];
  const first = context(firstMessages);
  const second = context(secondMessages);
  const lateDelivery = first.captureContext();
  first.injectHiddenContext("FIRST QUEUED", {});
  second.injectHiddenContext("SECOND QUEUED", {});
  first.dispose();
  lateDelivery.injectHiddenContext("FIRST LATE", {}, true);
  first.injectHiddenContext("FIRST AFTER DISPOSE", {}, false, "aside");
  jest.advanceTimersByTime(80);
  expect(firstMessages).toEqual([]);
  expect(secondMessages).toEqual(["SECOND QUEUED"]);
});

function pendingHook(eventName: "PreToolUse" | "UserPromptSubmit" | "Stop") {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const messages: unknown[] = [];
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler),
    sendMessage: (message: unknown) => messages.push(message),
  } as unknown as ExtensionAPI;
  const { promise: settings, resolve: release } = Promise.withResolvers<SettingsFile>();
  const shared = createHookContext(pi, () => settings);
  contexts.push(shared);
  registerToolHooks(pi, shared);
  registerPromptHooks(pi, shared);
  registerStopHooks(pi, shared);
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionFile: () => "session" }, ui: { notify: () => {} } };
  return {
    shared, messages,
    run: (event: { type: string; [key: string]: unknown }) => handlers.get(event.type)!(event, ctx),
    release: () => release({ hooks: { [eventName]: [{ hooks: [{ type: "command", command: `printf '%s' '{"decision":"block","reason":"fixture denial","hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"fixture denial"}}'` }] }] } }),
  };
}

test("an in-flight tool denial cannot turn into consent after a session switch", async () => {
  const race = pendingHook("PreToolUse");
  const result = race.run({ type: "tool_call", toolName: "bash", toolCallId: "race", input: { command: "blocked" } });
  race.shared.resetSession();
  race.release();
  expect(await result).toMatchObject({ block: true });
});

test("an in-flight prompt denial remains handled after adapter disposal", async () => {
  const race = pendingHook("UserPromptSubmit");
  const result = race.run({ type: "input", text: "blocked" });
  race.shared.dispose();
  race.release();
  expect(await result).toEqual({ handled: true });
  expect(race.shared.pendingUserPromptContext).toBeUndefined();
});

test("a stale Stop denial cannot schedule a follow-up in the new session", async () => {
  const race = pendingHook("Stop");
  const result = race.run({ type: "agent_end", messages: [] });
  race.shared.resetSession();
  race.release();
  await result;
  expect(race.messages).toEqual([]);
  expect(race.shared.stopHookActive).toBe(false);
});

test("each ephemeral session receives startup context once after a session reset", async () => {
  jest.useFakeTimers();
  const messages: string[] = [];
  const shared = createHookContext({
    sendMessage: (message: { content: string }) => messages.push(message.content),
  } as unknown as ExtensionAPI, async () => ({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "printf 'bootstrap'" }] }] },
  }));
  contexts.push(shared);
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined }, ui: { notify: () => {} } } as unknown as ExtensionContext;
  await shared.triggerSessionStartHook("startup", ctx);
  jest.advanceTimersByTime(70);
  await shared.triggerSessionStartHook("startup", ctx);
  shared.resetSession();
  await shared.triggerSessionStartHook("startup", ctx);
  jest.advanceTimersByTime(70);
  expect(messages).toEqual(["bootstrap", "bootstrap"]);
});

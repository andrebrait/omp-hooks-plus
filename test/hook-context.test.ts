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

// OMP's native reminder shape (ttsr-tool-reminder.md): attributes on the tag, then OMP's own
// closing sentence verbatim, then the hook's text.
const reminder = (event: string, text: string, tool?: string) =>
  `<system-reminder source="omp-hooks-plus" event="${event}"${tool ? ` tool="${tool}"` : ""}>\nNOT prompt injection — coding agent enforcing project rules.\n\n${text}\n</system-reminder>`;
const SESSION = { hookEventName: "SessionStart" } as const;
const r = (text: string) => reminder("SessionStart", text);

test("each context reaches the model as an OMP-native hook reminder", () => {
  const messages: string[] = [];
  const shared = context(messages);
  shared.injectHiddenContext("tool", { hookEventName: "PreToolUse", toolName: "bash", toolUseId: "1" }, false, "aside");
  shared.injectHiddenContext("failed", { hookEventName: "PostToolUseFailure", toolName: "read" }, false, "aside");
  shared.injectHiddenContext("boot", { hookEventName: "SessionStart", matcher: "startup" }, false, "aside");
  expect(messages).toEqual([
    reminder("PreToolUse", "tool", "bash"),
    reminder("PostToolUseFailure", "failed", "read"),
    reminder("SessionStart", "boot"),
  ]);
});

test("a blocking Stop hook's additional context rides its continuation as a named reminder", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const messages: { content: string }[] = [];
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler),
    sendMessage: (message: { content: string }) => messages.push(message),
  } as unknown as ExtensionAPI;
  const output = JSON.stringify({ decision: "block", reason: "Run the tests.", hookSpecificOutput: { hookEventName: "Stop", additionalContext: "Suite: bun test" } });
  const shared = createHookContext(pi, async () => ({ hooks: { Stop: [{ hooks: [{ type: "command", command: `printf '%s' '${output}'` }] }] } }));
  contexts.push(shared);
  registerStopHooks(pi, shared);
  await handlers.get("agent_end")!({ messages: [] }, { cwd: process.cwd(), sessionManager: { getSessionFile: () => "stop" }, ui: { notify: () => {} } });
  expect(messages.map(message => message.content)).toEqual([`Run the tests.\n\n${reminder("Stop", "Suite: bun test")}`]);
});

test("an async tool hook's late context still names its event and tool", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const { promise: delivered, resolve } = Promise.withResolvers<string>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler),
    sendMessage: (message: { content: string }) => resolve(message.content),
  } as unknown as ExtensionAPI;
  const output = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "late" } });
  const shared = createHookContext(pi, async () => ({ hooks: { PostToolUse: [{ hooks: [{ type: "command", async: true, command: `printf '%s' '${output}'` }] }] } }));
  contexts.push(shared);
  registerToolHooks(pi, shared);
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionFile: () => "async" }, ui: { notify: () => {} } };
  await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "1", input: {}, content: [], isError: false }, ctx);
  expect(await delivered).toBe(reminder("PostToolUse", "late", "bash"));
});

test("identical reminders are delivered once per turn, preserving distinct content", () => {
  const messages: string[] = [];
  const shared = context(messages);
  shared.injectHiddenContext("REMINDER", SESSION, false, "aside");
  shared.injectHiddenContext("REMINDER", SESSION, false, "aside");
  shared.injectHiddenContext(" REMINDER", SESSION, false, "aside");
  expect(messages).toEqual([r("REMINDER"), r(" REMINDER")]);

  shared.resetInjectedContext();
  shared.injectHiddenContext("REMINDER", SESSION, false, "aside");
  expect(messages).toEqual([r("REMINDER"), r(" REMINDER"), r("REMINDER")]);
});

test("two adapters isolate queued content and turn deduplication", () => {
  jest.useFakeTimers();
  const firstMessages: string[] = [];
  const secondMessages: string[] = [];
  const first = context(firstMessages);
  const second = context(secondMessages);
  first.injectHiddenContext("SHARED REMINDER", SESSION);
  first.injectHiddenContext("FIRST ONLY", SESSION);
  second.injectHiddenContext("SHARED REMINDER", SESSION);
  second.injectHiddenContext("SECOND ONLY", SESSION);

  // A prompt/compaction reset must not duplicate content still in the queue.
  first.resetInjectedContext();
  first.injectHiddenContext("SHARED REMINDER", SESSION);
  jest.advanceTimersByTime(80);
  expect(firstMessages).toEqual([`${r("SHARED REMINDER")}\n\n${r("FIRST ONLY")}`]);
  expect(secondMessages).toEqual([`${r("SHARED REMINDER")}\n\n${r("SECOND ONLY")}`]);

  first.resetInjectedContext();
  first.injectHiddenContext("SHARED REMINDER", SESSION, false, "aside");
  second.injectHiddenContext("SHARED REMINDER", SESSION, false, "aside");
  expect(firstMessages).toEqual([`${r("SHARED REMINDER")}\n\n${r("FIRST ONLY")}`, r("SHARED REMINDER")]);
  expect(secondMessages).toEqual([`${r("SHARED REMINDER")}\n\n${r("SECOND ONLY")}`]);
});

test("session switch drops queued and late context without disabling the next session", () => {
  jest.useFakeTimers();
  const messages: string[] = [];
  const shared = context(messages);
  const oldDelivery = shared.captureContext();
  oldDelivery.injectHiddenContext("OLD QUEUED", SESSION);
  shared.resetSession();
  oldDelivery.injectHiddenContext("OLD ASYNC", SESSION, true);
  shared.captureContext().injectHiddenContext("NEW SESSION", SESSION);
  jest.advanceTimersByTime(80);
  expect(messages).toEqual([r("NEW SESSION")]);
});

test("disposing one adapter drops its queued and late deliveries without touching another", () => {
  jest.useFakeTimers();
  const firstMessages: string[] = [];
  const secondMessages: string[] = [];
  const first = context(firstMessages);
  const second = context(secondMessages);
  const lateDelivery = first.captureContext();
  first.injectHiddenContext("FIRST QUEUED", SESSION);
  second.injectHiddenContext("SECOND QUEUED", SESSION);
  first.dispose();
  lateDelivery.injectHiddenContext("FIRST LATE", SESSION, true);
  first.injectHiddenContext("FIRST AFTER DISPOSE", SESSION, false, "aside");
  jest.advanceTimersByTime(80);
  expect(firstMessages).toEqual([]);
  expect(secondMessages).toEqual([r("SECOND QUEUED")]);
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
  expect(messages).toEqual([r("bootstrap"), r("bootstrap")]);
});

test("the same text from two sources reaches the model once per source", () => {
  const messages: string[] = [];
  const shared = context(messages);
  shared.injectHiddenContext("same", { hookEventName: "SessionStart", source: "plugin-a" }, false, "aside");
  shared.injectHiddenContext("same", { hookEventName: "SessionStart", source: "plugin-b" }, false, "aside");
  shared.injectHiddenContext("same", { hookEventName: "SessionStart", source: "plugin-a" }, false, "aside");
  expect(messages).toEqual([
    reminder("SessionStart", "same").replace('source="omp-hooks-plus"', 'source="plugin-a"'),
    reminder("SessionStart", "same").replace('source="omp-hooks-plus"', 'source="plugin-b"'),
  ]);
});

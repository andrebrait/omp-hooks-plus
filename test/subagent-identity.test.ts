import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "../src/adapter";
import { sessionIdOfFile, subagentIdentity } from "../src/subagent";
import type { HookGroup, SettingsFile } from "../src/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Agent = { kind: "main" | "sub"; id: string; name: string; depth: number };
type Handler = (event: unknown, ctx: unknown) => unknown;
type Emit = (event: { type: string; [key: string]: unknown }, ctx: unknown) => Promise<unknown[]>;

// OMP session ids are UUIDv7; a hook such as Caveman's keys per-session state on ids matching this.
const PARENT_ID = "01938a52-7b6e-7c1d-9a3f-5e2d8c4b1a07";
const CHILD_ID = "01938a52-9c10-7e4a-8b2d-1f6a3d5c7e90";
const OTHER_ID = "01938a52-aaaa-7000-8000-00000000000a";
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const header = (id: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-11T16:13:00.123Z", cwd: "/work", ...extra })}\n`;

// OMP nests a subagent's session at `<parent>/<agentId>.jsonl` beside `<parent>.jsonl`.
function sessions() {
  const root = mkdtempSync(path.join(tmpdir(), "subagent-identity-"));
  roots.push(root);
  // A name that does not encode the id, so the id can only come from the header.
  const parent = path.join(root, "parent.jsonl");
  mkdirSync(path.join(root, "parent", "0-Explore"), { recursive: true });
  writeFileSync(parent, `${header(PARENT_ID)}${JSON.stringify({ type: "message", id: "ignored" })}\n`);
  const child = path.join(root, "parent", "0-Explore.jsonl");
  writeFileSync(child, header(CHILD_ID, { parentSession: parent }));
  return {
    root,
    parent,
    child,
    grandchild: path.join(root, "parent", "0-Explore", "1-Task.jsonl"),
    log: path.join(root, "hooks.log"),
  };
}

const main: Agent = { kind: "main", id: "Main", name: "main", depth: 0 };
const explore: Agent = { kind: "sub", id: "0-Explore", name: "explore", depth: 1 };
// A /tan clone is a subagent at depth 0 whose definition name is "sub".
const tan: Agent = { kind: "sub", id: "Tan-1", name: "sub", depth: 0 };

function ctxFor(cwd: string, file: string | undefined, sessionId: string, agent?: object) {
  return {
    cwd,
    sessionManager: { getSessionFile: () => file, getSessionId: () => sessionId },
    ui: { notify: () => {} },
    isProjectTrusted: () => true,
    hasUI: false,
    abort: () => {},
    ...(agent ? { agent } : {}),
  };
}
const mainCtx = (cwd: string, file: string | undefined) => ctxFor(cwd, file, PARENT_ID, main);
const subCtx = (cwd: string, file: string | undefined, agent?: object) => ctxFor(cwd, file, CHILD_ID, agent);

// One write per record: detached hooks run in parallel, and a `cat; echo` pair can interleave with a sibling's.
const record = (log: string): HookGroup["hooks"][number] => ({ type: "command", command: `printf '%s\\n' "$(cat)" >> "${log}"` });
const records = (log: string): Array<Record<string, unknown>> =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
// Notification hooks run detached from the host event, so wait (bounded) for their records.
async function waitRecords(log: string, count: number): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 10_000;
  while (records(log).length < count && Date.now() < deadline) await Bun.sleep(20);
  return records(log);
}
const tagged = (log: string, tag: string) => ({ type: "command" as const, command: `echo ${tag} >> "${log}"; cat >/dev/null` });
const tags = (log: string) => readFileSync(log, "utf8").split("\n").filter(Boolean).sort();

function adapter(settings: SettingsFile, approximations = true): Emit {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    sendMessage: () => {},
  };
  registerHooks(pi as never, async () => settings, { approximations });
  return async (event: { type: string; [key: string]: unknown }, ctx: unknown) => {
    const results = [];
    for (const handler of handlers.get(event.type) ?? []) results.push(await handler(event, ctx));
    return results.filter(Boolean);
  };
}

const toolCall = { type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "ls" } };
const toolResult = { type: "tool_result", toolName: "bash", toolCallId: "t1", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], isError: false };
const toolFailure = { ...toolResult, content: [{ type: "text", text: "boom" }], isError: true };
const approval = { type: "tool_approval_requested", sessionId: "s", toolCallId: "t", toolName: "bash", approvalMode: "ask" };
const compacted = { type: "session_compact", compactionEntry: { summary: "S" } };
const agentStart = { type: "before_agent_start", prompt: "task", images: [], systemPrompt: [] };
// OMP's native Stop pass, which carries the session's own id and file.
const stopPass = (sessionId: string, file: string) => ({
  type: "session_stop", messages: [], turn_id: 0, session_id: sessionId, session_file: file, stop_hook_active: false, signal: new AbortController().signal,
});

test("ctx.agent decides subagent identity, including a depth-0 /tan clone", () => {
  const { root, parent, child, grandchild } = sessions();
  expect(subagentIdentity(subCtx(root, child, explore) as never)).toEqual({
    agentId: "0-Explore", agentType: "explore", file: child, parentFile: parent,
  });
  // `kind`, not depth or the file layout, decides: a /tan clone has depth 0.
  expect(subagentIdentity(subCtx(root, child, tan) as never)).toEqual({
    agentId: "Tan-1", agentType: "sub", file: child, parentFile: parent,
  });
  // The top-level session of an OMP that reports ctx.agent is main, wherever its file lives.
  expect(subagentIdentity(ctxFor(root, child, PARENT_ID, main) as never)).toBeUndefined();
  // A nested subagent reports the top-level session, which is what the main session's hooks send.
  expect(subagentIdentity(subCtx(root, grandchild, { ...explore, id: "1-Task", name: "task", depth: 2 }) as never)).toMatchObject({
    agentId: "1-Task", parentFile: parent,
  });
  // An in-memory subagent has no file, hence no known parent.
  expect(subagentIdentity(subCtx(root, undefined, explore) as never)).toEqual({
    agentId: "0-Explore", agentType: "explore", file: undefined, parentFile: undefined,
  });
});

test("only kind \"sub\" is a subagent: a malformed or unknown ctx.agent is the main session", () => {
  const { root, child } = sessions();
  for (const agent of [{}, { kind: "future", id: "X", name: "x", depth: 0 }, { id: "0-Explore", name: "explore", depth: 1 }, "sub", 1]) {
    expect(subagentIdentity(subCtx(root, child, agent) as never)).toBeUndefined();
  }
});

test("an OMP without ctx.agent falls back to the nested session file", () => {
  const { root, parent, child } = sessions();
  expect(subagentIdentity(subCtx(root, child) as never)).toEqual({
    agentId: "0-Explore", agentType: undefined, file: child, parentFile: parent,
  });
  expect(subagentIdentity(subCtx(root, parent) as never)).toBeUndefined();
  expect(subagentIdentity(subCtx(root, undefined) as never)).toBeUndefined();
});

test("a resolved top-level session sticks for the subagent file, an unresolved one is retried", () => {
  const { root, parent, child } = sessions();
  expect(subagentIdentity(subCtx(root, child, explore) as never)?.parentFile).toBe(parent);
  rmSync(parent);
  expect(subagentIdentity(subCtx(root, child, explore) as never)?.parentFile).toBe(parent);

  // The parent is not on disk yet: no answer is remembered, so it resolves once the file exists.
  const late = path.join(root, "late.jsonl");
  const lateChild = path.join(root, "late", "0-Explore.jsonl");
  expect(subagentIdentity(subCtx(root, lateChild, explore) as never)?.parentFile).toBeUndefined();
  mkdirSync(path.join(root, "late"));
  writeFileSync(late, header(PARENT_ID));
  expect(subagentIdentity(subCtx(root, lateChild, explore) as never)?.parentFile).toBe(late);
});

test("a session file's id is its header id, else the id its name encodes, re-read when the file changes", () => {
  const { root, parent } = sessions();
  expect(sessionIdOfFile(parent)).toBe(PARENT_ID);
  expect(sessionIdOfFile(parent)).toBe(PARENT_ID);
  // A reused path (a forced session file) with a different header is picked up.
  writeFileSync(parent, header(OTHER_ID, { title: "reused" }));
  expect(sessionIdOfFile(parent)).toBe(OTHER_ID);

  // Header first; the name only when the header is unreadable or records no usable id.
  const named = path.join(root, "2026-10-11T16-13-00-123Z_01938a52-1111-7000-8000-000000000001.jsonl");
  writeFileSync(named, header(PARENT_ID));
  expect(sessionIdOfFile(named)).toBe(PARENT_ID);
  const unusable = [
    "",
    "not json\n",
    // Only the type check can reject this one: its id is valid.
    header(PARENT_ID, { type: "other" }),
    `{"type":"session"}\n`,
    header(""),
    // Ids a hook cannot key state on: separators, whitespace, quotes, over-long.
    header("a b/../c"),
    header("quote\"id"),
    header("x".repeat(129)),
  ];
  for (const [index, content] of unusable.entries()) {
    const file = path.join(root, `2026-10-11T16-13-00-123Z_01938a52-2222-7000-8000-00000000000${index}.jsonl`);
    writeFileSync(file, content);
    expect(sessionIdOfFile(file)).toBe(`01938a52-2222-7000-8000-00000000000${index}`);
  }
  // A name that encodes no usable id, and a missing file, have none.
  const plain = path.join(root, "0-Explore.jsonl");
  writeFileSync(plain, "");
  expect(sessionIdOfFile(plain)).toBeUndefined();
  const odd = path.join(root, "2026_bad id.jsonl");
  writeFileSync(odd, header("bad id"));
  expect(sessionIdOfFile(odd)).toBeUndefined();
  expect(sessionIdOfFile(path.join(root, "absent.jsonl"))).toBeUndefined();
  // The longest id that passes is accepted as is.
  const longest = path.join(root, "longest.jsonl");
  writeFileSync(longest, header("x".repeat(128)));
  expect(sessionIdOfFile(longest)).toBe("x".repeat(128));
  // OMP writes a padded title slot before the header; the name encodes no id, so only the header can answer.
  const titled = path.join(root, "titled.jsonl");
  writeFileSync(titled, `${JSON.stringify({ type: "title", v: 1, title: "t", pad: " ".repeat(64) })}\n${header(PARENT_ID)}`);
  expect(sessionIdOfFile(titled)).toBe(PARENT_ID);
  // Only one title slot is skipped: a second title line is not a header.
  const twice = path.join(root, "twice.jsonl");
  writeFileSync(twice, `${JSON.stringify({ type: "title" })}\n${JSON.stringify({ type: "title" })}\n${header(PARENT_ID)}`);
  expect(sessionIdOfFile(twice)).toBeUndefined();
});

test("SessionStart (startup), UserPromptSubmit and SessionEnd run in the main session and skip subagents", async () => {
  const { root, child, parent, log } = sessions();
  const settings: SettingsFile = { hooks: {
    SessionStart: [{ hooks: [record(log)] }],
    UserPromptSubmit: [{ hooks: [record(log)] }],
    SessionEnd: [{ hooks: [record(log)] }],
  } };
  const lifecycle = async (emit: Emit, ctx: unknown) => {
    await emit({ type: "session_start" }, ctx);
    await emit({ type: "input", text: "hello", source: "interactive" }, ctx);
    await emit({ type: "session_shutdown" }, ctx);
  };

  await lifecycle(adapter(settings), subCtx(root, child, explore));
  await lifecycle(adapter(settings), subCtx(root, child, tan));
  await lifecycle(adapter(settings), subCtx(root, child));
  expect(records(log)).toEqual([]);

  await lifecycle(adapter(settings), mainCtx(root, parent));
  expect(records(log).map(entry => entry.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit", "SessionEnd"]);
});

test("SessionStart runs in a subagent only for compaction, with the parent's identity", async () => {
  const { root, child, parent, log } = sessions();
  const settings: SettingsFile = { hooks: { SessionStart: [{ hooks: [record(log)] }] } };
  const lifecycle = async (ctx: unknown) => {
    const emit = adapter(settings);
    await emit({ type: "session_start" }, ctx);
    await emit({ type: "session_before_switch", reason: "resume" }, ctx);
    await emit(compacted, ctx);
  };

  await lifecycle(subCtx(root, child, explore));
  expect(records(log)).toEqual([expect.objectContaining({
    hook_event_name: "SessionStart", source: "compact", session_id: PARENT_ID, agent_id: "0-Explore", agent_type: "explore",
  })]);

  rmSync(log);
  await lifecycle(mainCtx(root, parent));
  expect(records(log).map(entry => entry.source)).toEqual(["startup", "resume", "compact"]);
  for (const entry of records(log)) expect(entry).not.toHaveProperty("agent_id");
});

test("a top-level session reports its session id, never its file path, and its file as the transcript", async () => {
  const { root, parent, log } = sessions();
  const settings: SettingsFile = { hooks: {
    SessionStart: [{ hooks: [record(log)] }],
    UserPromptSubmit: [{ hooks: [record(log)] }],
    PreToolUse: [{ hooks: [record(log)] }],
    PostToolUse: [{ hooks: [record(log)] }],
    PreCompact: [{ hooks: [record(log)] }],
    Stop: [{ hooks: [record(log)] }],
    SessionEnd: [{ hooks: [record(log)] }],
  } };
  const emit = adapter(settings);
  const ctx = mainCtx(root, parent);
  await emit({ type: "session_start" }, ctx);
  await emit({ type: "input", text: "hello", source: "interactive" }, ctx);
  await emit(toolCall, ctx);
  await emit(toolResult, ctx);
  await emit({ type: "session_before_compact", customInstructions: "" }, ctx);
  await emit(stopPass(PARENT_ID, parent), ctx);
  await emit({ type: "session_shutdown" }, ctx);

  const sent = records(log);
  expect(sent.map(entry => entry.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop", "SessionEnd"]);
  for (const entry of sent) {
    expect(entry.session_id).toBe(PARENT_ID);
    expect(entry.session_id).toMatch(SESSION_ID);
    expect(entry).not.toHaveProperty("agent_id");
    // SessionStart and SessionEnd inputs carry no transcript_path today; that is not this change's concern.
    if (entry.hook_event_name !== "SessionStart" && entry.hook_event_name !== "SessionEnd") expect(entry.transcript_path).toBe(parent);
  }
});

test("a session without an id reports the placeholder id", async () => {
  const { root, log } = sessions();
  const emit = adapter({ hooks: { PreToolUse: [{ hooks: [record(log)] }] } });
  await emit(toolCall, ctxFor(root, undefined, "", main));
  expect(records(log)).toEqual([expect.objectContaining({ session_id: "ephemeral" })]);
});

test("every hook that runs in a subagent carries the parent's session id and the agent fields", async () => {
  const { root, child, parent, log } = sessions();
  const settings: SettingsFile = { hooks: {
    PreToolUse: [{ hooks: [record(log)] }],
    PostToolUse: [{ hooks: [record(log)] }],
    PostToolUseFailure: [{ hooks: [record(log)] }],
    PreCompact: [{ hooks: [record(log)] }],
    PostCompact: [{ hooks: [record(log)] }],
    Notification: [{ hooks: [record(log)] }],
  } };
  const events = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "Notification"];
  const run = async (ctx: unknown) => {
    const emit = adapter(settings);
    await emit(toolCall, ctx);
    await emit(toolResult, ctx);
    await emit(toolFailure, ctx);
    await emit({ type: "session_before_compact", customInstructions: "" }, ctx);
    await emit(compacted, ctx);
    await emit(approval, ctx);
    const sent = await waitRecords(log, events.length);
    expect(sent.map(entry => entry.hook_event_name).sort()).toEqual([...events].sort());
    rmSync(log);
    return sent;
  };

  for (const entry of await run(subCtx(root, child, explore))) {
    // The parent's header id, not the child's own id and not a file path.
    expect(entry).toMatchObject({ session_id: PARENT_ID, transcript_path: parent, agent_id: "0-Explore", agent_type: "explore" });
    expect(entry.session_id).toMatch(SESSION_ID);
  }

  // OMP without ctx.agent: the id is known, the type is not.
  for (const entry of await run(subCtx(root, child))) {
    expect(entry).toMatchObject({ session_id: PARENT_ID, transcript_path: parent, agent_id: "0-Explore" });
    expect(entry).not.toHaveProperty("agent_type");
  }

  // A nested subagent also reports the top-level session.
  for (const entry of await run(subCtx(root, path.join(root, "parent", "0-Explore", "1-Task.jsonl"), { ...explore, id: "1-Task", name: "task", depth: 2 }))) {
    expect(entry).toMatchObject({ session_id: PARENT_ID, transcript_path: parent, agent_id: "1-Task", agent_type: "task" });
  }

  for (const entry of await run(mainCtx(root, parent))) {
    expect(entry).toMatchObject({ session_id: PARENT_ID, transcript_path: parent });
    expect(entry).not.toHaveProperty("agent_id");
    expect(entry).not.toHaveProperty("agent_type");
  }
});

test("a finishing subagent is not an idle prompt; a finishing top-level session is", async () => {
  const { root, child, parent, log } = sessions();
  const settings: SettingsFile = { hooks: { Notification: [
    { matcher: "idle_prompt", hooks: [record(log)] },
    { matcher: "permission_prompt", hooks: [record(log)] },
  ] } };
  const emit = adapter(settings);
  const sub = subCtx(root, child, explore);
  await emit({ type: "agent_end", messages: [] }, sub);
  // Barrier: later hooks have finished, so an earlier spurious idle record would have landed too.
  await emit(approval, sub);
  await emit({ ...approval, toolCallId: "u" }, sub);
  expect((await waitRecords(log, 2)).map(entry => entry.notification_type)).toEqual(["permission_prompt", "permission_prompt"]);

  await emit({ type: "agent_end", messages: [] }, mainCtx(root, parent));
  expect((await waitRecords(log, 3)).map(entry => entry.notification_type)).toContain("idle_prompt");
});

test("a subagent whose parent id is not recorded falls back to the id in the parent's name, then to its own", async () => {
  const { root, log } = sessions();
  const emit = adapter({ hooks: { PreToolUse: [{ hooks: [record(log)] }] } });

  // Unreadable header: the `<timestamp>_<id>.jsonl` name still carries the id, and the file is the transcript.
  const named = path.join(root, "2026-10-11T16-13-00-123Z_01938a52-3333-7000-8000-000000000003.jsonl");
  mkdirSync(named.slice(0, -6));
  writeFileSync(named, "garbage");
  await emit(toolCall, subCtx(root, path.join(named.slice(0, -6), "0-Explore.jsonl"), explore));

  // Unreadable header and a name without an id: the subagent's own id and its own transcript, never a mix.
  const plain = path.join(root, "plain.jsonl");
  const own = path.join(root, "plain", "0-Explore.jsonl");
  mkdirSync(path.join(root, "plain"));
  writeFileSync(plain, "");
  await emit(toolCall, subCtx(root, own, explore));

  const [fromName, fromOwn] = records(log);
  expect(fromName).toMatchObject({ session_id: "01938a52-3333-7000-8000-000000000003", transcript_path: named });
  expect(fromOwn).toMatchObject({ session_id: CHILD_ID, transcript_path: own, agent_id: "0-Explore" });
});

test("SubagentStart fires once per subagent with the parent's session id and the agent fields", async () => {
  const { root, child, parent, log } = sessions();
  const emit = adapter({ hooks: { SubagentStart: [{ hooks: [record(log)] }] } });
  const start = (ctx: unknown) => emit(agentStart, ctx);

  expect(await start(mainCtx(root, parent))).toEqual([]);
  await start(subCtx(root, child, explore));
  await start(subCtx(root, child, explore));
  expect(records(log)).toEqual([{
    session_id: PARENT_ID,
    transcript_path: parent,
    cwd: root,
    hook_event_name: "SubagentStart",
    agent_id: "0-Explore",
    agent_type: "explore",
    agent_transcript_path: child,
  }]);
});

test("SubagentStart detects /tan clones and in-memory subagents through ctx.agent", async () => {
  const { root, child, log } = sessions();
  // One adapter per session, as OMP binds the extension.
  const start = (ctx: unknown) => adapter({ hooks: { SubagentStart: [{ hooks: [record(log)] }] } })(agentStart, ctx);

  await start(subCtx(root, child, tan));
  await start(subCtx(root, undefined, { ...explore, id: "2-Memory" }));
  const [clone, memory] = records(log);
  expect(clone).toMatchObject({ session_id: PARENT_ID, agent_id: "Tan-1", agent_type: "sub", agent_transcript_path: child });
  // No known parent: the subagent's own session id stands in.
  expect(memory).toMatchObject({ session_id: CHILD_ID, agent_id: "2-Memory", agent_type: "explore" });
  expect(memory).not.toHaveProperty("agent_transcript_path");
  expect(memory).not.toHaveProperty("transcript_path");
});

test("a SubagentStart matcher matches the agent type", async () => {
  const { root, child, log } = sessions();
  const emit = adapter({ hooks: { SubagentStart: [
    { matcher: "Explore", hooks: [tagged(log, "exact")] },
    { matcher: "plan|review", hooks: [tagged(log, "other")] },
    { matcher: "^exp", hooks: [tagged(log, "regex")] },
    { matcher: "*", hooks: [tagged(log, "star")] },
    { hooks: [tagged(log, "untyped")] },
  ] } });
  await emit(agentStart, subCtx(root, child, explore));
  expect(tags(log)).toEqual(["exact", "regex", "star", "untyped"]);
});

test("a SubagentStart regex matcher written for Claude's capitalised agent types matches OMP's lowercase names", async () => {
  const { root, child, log } = sessions();
  const settings: SettingsFile = { hooks: { SubagentStart: [
    { matcher: "^Explore$", hooks: [tagged(log, "explore-only")] },
    { matcher: "^(Explore|Plan)$", hooks: [tagged(log, "explore-or-plan")] },
    { matcher: "^Plan$", hooks: [tagged(log, "plan-only")] },
    { matcher: "general-purpose", hooks: [tagged(log, "general-purpose")] },
  ] } };
  await adapter(settings)(agentStart, subCtx(root, child, explore));
  expect(tags(log)).toEqual(["explore-only", "explore-or-plan"]);

  rmSync(log);
  await adapter(settings)(agentStart, subCtx(root, child, { ...explore, id: "1-Plan", name: "plan" }));
  expect(tags(log)).toEqual(["explore-or-plan", "plan-only"]);
});

test("without ctx.agent only untyped SubagentStart groups run", async () => {
  const { root, child, log } = sessions();
  const emit = adapter({ hooks: { SubagentStart: [
    { matcher: "Explore", hooks: [tagged(log, "exact")] },
    { matcher: ".*", hooks: [tagged(log, "regex")] },
    { matcher: "*", hooks: [tagged(log, "star")] },
    { hooks: [tagged(log, "untyped")] },
  ] } });
  await emit(agentStart, subCtx(root, child));
  expect(tags(log)).toEqual(["star", "untyped"]);
});

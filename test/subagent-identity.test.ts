import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "../src/adapter";
import { subagentIdentity } from "../src/subagent";
import type { HookGroup, SettingsFile } from "../src/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Agent = { kind: "main" | "sub"; id: string; name: string; depth: number };
type Handler = (event: unknown, ctx: unknown) => unknown;
type Emit = (event: { type: string; [key: string]: unknown }, ctx: unknown) => Promise<unknown[]>;

// OMP nests a subagent's session at `<parent>/<agentId>.jsonl` beside `<parent>.jsonl`.
function sessions() {
  const root = mkdtempSync(path.join(tmpdir(), "subagent-identity-"));
  roots.push(root);
  const parent = path.join(root, "parent.jsonl");
  mkdirSync(path.join(root, "parent", "0-Explore"), { recursive: true });
  writeFileSync(parent, "");
  writeFileSync(path.join(root, "parent", "0-Explore.jsonl"), "");
  return {
    root,
    parent,
    child: path.join(root, "parent", "0-Explore.jsonl"),
    grandchild: path.join(root, "parent", "0-Explore", "1-Task.jsonl"),
    log: path.join(root, "hooks.log"),
  };
}

const main: Agent = { kind: "main", id: "Main", name: "main", depth: 0 };
const explore: Agent = { kind: "sub", id: "0-Explore", name: "explore", depth: 1 };
// A /tan clone is a subagent at depth 0 whose definition name is "sub".
const tan: Agent = { kind: "sub", id: "Tan-1", name: "sub", depth: 0 };

function ctxFor(cwd: string, file: string | undefined, agent?: Agent) {
  return {
    cwd,
    sessionManager: { getSessionFile: () => file },
    ui: { notify: () => {} },
    isProjectTrusted: () => true,
    hasUI: false,
    abort: () => {},
    ...(agent ? { agent } : {}),
  };
}

const record = (log: string): HookGroup["hooks"][number] => ({ type: "command", command: `{ cat; echo; } >> "${log}"` });
const records = (log: string): Array<Record<string, unknown>> =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

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

test("ctx.agent decides subagent identity, including a depth-0 /tan clone", () => {
  const { root, parent, child, grandchild } = sessions();
  expect(subagentIdentity(ctxFor(root, child, explore) as never)).toEqual({
    agentId: "0-Explore", agentType: "explore", file: child, parentFile: parent,
  });
  // `kind`, not depth or the file layout, decides: a /tan clone has depth 0.
  expect(subagentIdentity(ctxFor(root, child, tan) as never)).toEqual({
    agentId: "Tan-1", agentType: "sub", file: child, parentFile: parent,
  });
  // The top-level session of an OMP that reports ctx.agent is main, wherever its file lives.
  expect(subagentIdentity(ctxFor(root, child, main) as never)).toBeUndefined();
  // A nested subagent reports the top-level session, which is what the main session's hooks send.
  expect(subagentIdentity(ctxFor(root, grandchild, { ...explore, id: "1-Task", name: "task", depth: 2 }) as never)).toMatchObject({
    agentId: "1-Task", parentFile: parent,
  });
  // An in-memory subagent has no file, hence no known parent.
  expect(subagentIdentity(ctxFor(root, undefined, explore) as never)).toEqual({
    agentId: "0-Explore", agentType: "explore", file: undefined, parentFile: undefined,
  });
});

test("an OMP without ctx.agent falls back to the nested session file", () => {
  const { root, parent, child } = sessions();
  expect(subagentIdentity(ctxFor(root, child) as never)).toEqual({
    agentId: "0-Explore", agentType: undefined, file: child, parentFile: parent,
  });
  expect(subagentIdentity(ctxFor(root, parent) as never)).toBeUndefined();
  expect(subagentIdentity(ctxFor(root, undefined) as never)).toBeUndefined();
});

test("SessionStart, UserPromptSubmit and SessionEnd run in the main session and skip subagents", async () => {
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

  await lifecycle(adapter(settings), ctxFor(root, child, explore));
  await lifecycle(adapter(settings), ctxFor(root, child, tan));
  await lifecycle(adapter(settings), ctxFor(root, child));
  expect(records(log)).toEqual([]);

  await lifecycle(adapter(settings), ctxFor(root, parent, main));
  expect(records(log).map(entry => entry.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit", "SessionEnd"]);
});

test("tool and compact hooks in a subagent carry the parent session and the agent fields", async () => {
  const { root, child, parent, log } = sessions();
  const settings: SettingsFile = { hooks: {
    PreToolUse: [{ hooks: [record(log)] }],
    PostToolUse: [{ hooks: [record(log)] }],
    PreCompact: [{ hooks: [record(log)] }],
  } };
  const run = async (ctx: unknown) => {
    const emit = adapter(settings);
    await emit({ type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "ls" } }, ctx);
    await emit({ type: "tool_result", toolName: "bash", toolCallId: "t1", input: { command: "ls" }, content: [{ type: "text", text: "ok" }], isError: false }, ctx);
    await emit({ type: "session_before_compact", customInstructions: "" }, ctx);
  };

  await run(ctxFor(root, child, explore));
  const sub = records(log);
  expect(sub.map(entry => entry.hook_event_name)).toEqual(["PreToolUse", "PostToolUse", "PreCompact"]);
  for (const entry of sub) {
    expect(entry).toMatchObject({ session_id: parent, transcript_path: parent, agent_id: "0-Explore", agent_type: "explore" });
  }

  rmSync(log);
  await run(ctxFor(root, child)); // OMP without ctx.agent: the id is known, the type is not
  for (const entry of records(log)) {
    expect(entry).toMatchObject({ session_id: parent, transcript_path: parent, agent_id: "0-Explore" });
    expect(entry).not.toHaveProperty("agent_type");
  }

  rmSync(log);
  await run(ctxFor(root, parent, main));
  for (const entry of records(log)) {
    expect(entry).toMatchObject({ session_id: parent, transcript_path: parent });
    expect(entry).not.toHaveProperty("agent_id");
    expect(entry).not.toHaveProperty("agent_type");
  }
  expect(records(log)).toHaveLength(3);
});

test("SubagentStart fires once per subagent with the parent session and the agent fields", async () => {
  const { root, child, parent, log } = sessions();
  const emit = adapter({ hooks: { SubagentStart: [{ hooks: [record(log)] }] } });
  const start = (ctx: unknown) => emit({ type: "before_agent_start", prompt: "task", images: [], systemPrompt: [] }, ctx);

  expect(await start(ctxFor(root, parent, main))).toEqual([]);
  await start(ctxFor(root, child, explore));
  await start(ctxFor(root, child, explore));
  expect(records(log)).toEqual([{
    session_id: parent,
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
  const emit = adapter({ hooks: { SubagentStart: [{ hooks: [record(log)] }] } });
  const start = (ctx: unknown) => emit({ type: "before_agent_start", prompt: "task", images: [], systemPrompt: [] }, ctx);

  await start(ctxFor(root, child, tan));
  await start(ctxFor(root, undefined, { ...explore, id: "2-Memory" }));
  const [clone, memory] = records(log);
  expect(clone).toMatchObject({ agent_id: "Tan-1", agent_type: "sub", agent_transcript_path: child });
  expect(memory).toMatchObject({ agent_id: "2-Memory", agent_type: "explore" });
  expect(memory).not.toHaveProperty("agent_transcript_path");
});

test("a SubagentStart matcher matches the agent type", async () => {
  const { root, child, log } = sessions();
  const tagged = (tag: string) => ({ type: "command" as const, command: `echo ${tag} >> "${log}"; cat >/dev/null` });
  const emit = adapter({ hooks: { SubagentStart: [
    { matcher: "Explore", hooks: [tagged("exact")] },
    { matcher: "plan|review", hooks: [tagged("other")] },
    { matcher: "^exp", hooks: [tagged("regex")] },
    { matcher: "*", hooks: [tagged("star")] },
    { hooks: [tagged("untyped")] },
  ] } });
  await emit({ type: "before_agent_start", prompt: "task", images: [], systemPrompt: [] }, ctxFor(root, child, explore));
  expect(readFileSync(log, "utf8").split("\n").filter(Boolean).sort()).toEqual(["exact", "regex", "star", "untyped"]);
});

test("without ctx.agent only untyped SubagentStart groups run", async () => {
  const { root, child, log } = sessions();
  const tagged = (tag: string) => ({ type: "command" as const, command: `echo ${tag} >> "${log}"; cat >/dev/null` });
  const emit = adapter({ hooks: { SubagentStart: [
    { matcher: "Explore", hooks: [tagged("exact")] },
    { matcher: ".*", hooks: [tagged("regex")] },
    { matcher: "*", hooks: [tagged("star")] },
    { hooks: [tagged("untyped")] },
  ] } });
  await emit({ type: "before_agent_start", prompt: "task", images: [], systemPrompt: [] }, ctxFor(root, child));
  expect(readFileSync(log, "utf8").split("\n").filter(Boolean).sort()).toEqual(["star", "untyped"]);
});

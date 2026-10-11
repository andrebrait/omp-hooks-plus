import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isRecord } from "./type-guards";

/** The subagent a session runs, in the terms of Claude Code's hook payloads. */
export type SubagentIdentity = {
  agentId: string;
  /** OMP's lowercased agent definition name; undefined on OMP < 18.5.1, which has no `ctx.agent`. */
  agentType: string | undefined;
  /** The subagent's own session file; undefined for an in-memory session. */
  file: string | undefined;
  /** The top-level session's file: its path is the transcript_path its own hooks send, its id the session_id; undefined when unknown. */
  parentFile: string | undefined;
};

const CACHE_LIMIT = 512;

/** Insert as the newest entry; a long-lived host outlives any number of subagents, so evict the oldest. */
function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) for (const oldest of cache.keys()) { cache.delete(oldest); break; }
}

const topByFile = new Map<string, string>();

/**
 * OMP nests a subagent's session at `<parent>/<agentId>.jsonl` beside `<parent>.jsonl`, to any depth.
 * A found parent is remembered for the subagent's file; a missing one is looked up again, because
 * OMP persists a session lazily.
 */
function topLevelSession(file: string): string | undefined {
  const known = topByFile.get(file);
  if (known) return known;
  let top = file;
  // Same bound as OMP's own walk up to the interactive session.
  for (let depth = 0; depth < 8; depth++) {
    const parent = `${path.dirname(top)}.jsonl`;
    if (!existsSync(parent)) break;
    top = parent;
  }
  if (top === file) return undefined;
  remember(topByFile, file, top);
  return top;
}

/**
 * Identity of the subagent this session runs, or undefined for a top-level session.
 * `ctx.agent.kind` decides when OMP provides it (it also covers in-memory sessions and
 * `/tan` clones, which are subagents at depth 0), and only `"sub"` is a subagent: a malformed
 * value or a kind this code does not know is treated as the main session. Older OMP falls back
 * to the nested session file, which cannot see in-memory subagents or tell the agent type.
 */
export function subagentIdentity(ctx: ExtensionContext): SubagentIdentity | undefined {
  const agent: ExtensionContext["agent"] | undefined = ctx.agent;
  if (agent && agent.kind !== "sub") return undefined;
  const file = ctx.sessionManager.getSessionFile();
  const parentFile = file ? topLevelSession(file) : undefined;
  if (agent) return { agentId: agent.id, agentType: agent.name, file, parentFile };
  if (!file || !parentFile) return undefined;
  return { agentId: path.basename(file, ".jsonl"), agentType: undefined, file, parentFile };
}

const HEADER_BYTES = 65_536;
/** What a hook can key per-session state on: the id charset every Claude Code session id uses. */
const SESSION_ID = /^[\w-]{1,128}$/;

/** The `id` in the session header, which OMP writes as the file's first JSONL line. */
function headerId(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(HEADER_BYTES);
    const [line] = buffer.toString("utf8", 0, readSync(fd, buffer, 0, HEADER_BYTES, 0)).split("\n", 1);
    const header: unknown = JSON.parse(line);
    return isRecord(header) && header.type === "session" && typeof header.id === "string" && SESSION_ID.test(header.id) ? header.id : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** OMP names a session file `<timestamp>_<id>.jsonl`; the timestamp has no underscore. */
function filenameId(file: string): string | undefined {
  const stem = path.basename(file, ".jsonl");
  const id = stem.slice(stem.lastIndexOf("_") + 1);
  return stem.includes("_") && SESSION_ID.test(id) ? id : undefined;
}

const idByFile = new Map<string, { stamp: string; id: string }>();

/** Changes whenever the file's content does (appends and rewrites alike). */
function stampOf(file: string): string | undefined {
  try {
    const { mtimeMs, size } = statSync(file);
    return `${mtimeMs}:${size}`;
  } catch {
    return undefined;
  }
}

/**
 * The session id a session file records: its header id, else the id its name encodes
 * (undefined for a name without one, such as a subagent's `<agentId>.jsonl`). An id that is not
 * safe to key state on is passed over. Cached per file and checked against its mtime and size,
 * because every subagent hook asks for its parent's id while a forced session path can be reused.
 */
export function sessionIdOfFile(file: string): string | undefined {
  const stamp = stampOf(file);
  const known = idByFile.get(file);
  if (stamp && known?.stamp === stamp) return known.id;
  const id = headerId(file) ?? filenameId(file);
  if (id && stamp) remember(idByFile, file, { stamp, id });
  return id;
}

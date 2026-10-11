import { closeSync, existsSync, openSync, readSync } from "node:fs";
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

/** OMP nests a subagent's session at `<parent>/<agentId>.jsonl` beside `<parent>.jsonl`, to any depth. */
function topLevelSession(file: string): string | undefined {
  let top = file;
  // Same bound as OMP's own walk up to the interactive session.
  for (let depth = 0; depth < 8; depth++) {
    const parent = `${path.dirname(top)}.jsonl`;
    if (!existsSync(parent)) break;
    top = parent;
  }
  return top === file ? undefined : top;
}

/**
 * Identity of the subagent this session runs, or undefined for a top-level session.
 * `ctx.agent.kind` decides when OMP provides it (it also covers in-memory sessions and
 * `/tan` clones, which are subagents at depth 0); older OMP falls back to the nested
 * session file, which cannot see in-memory subagents or tell the agent type.
 */
export function subagentIdentity(ctx: ExtensionContext): SubagentIdentity | undefined {
  const agent: ExtensionContext["agent"] | undefined = ctx.agent;
  if (agent?.kind === "main") return undefined;
  const file = ctx.sessionManager.getSessionFile();
  const parentFile = file ? topLevelSession(file) : undefined;
  if (agent) return { agentId: agent.id, agentType: agent.name, file, parentFile };
  if (!file || !parentFile) return undefined;
  return { agentId: path.basename(file, ".jsonl"), agentType: undefined, file, parentFile };
}

const HEADER_BYTES = 65_536;
const idByFile = new Map<string, string>();

/** The `id` in the session header, which OMP writes as the file's first JSONL line. */
function headerId(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(HEADER_BYTES);
    const [line] = buffer.toString("utf8", 0, readSync(fd, buffer, 0, HEADER_BYTES, 0)).split("\n", 1);
    const header: unknown = JSON.parse(line);
    return isRecord(header) && header.type === "session" && typeof header.id === "string" && header.id !== "" ? header.id : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** OMP names a session file `<timestamp>_<id>.jsonl`; the timestamp has no underscore. */
function filenameId(file: string): string | undefined {
  const stem = path.basename(file, ".jsonl");
  const at = stem.lastIndexOf("_");
  return at < 0 ? undefined : stem.slice(at + 1) || undefined;
}

/**
 * The session id a session file records: its header id, else the id its name encodes
 * (undefined for a name without one, such as a subagent's `<agentId>.jsonl`). Cached per
 * file: a session's id never changes, and every subagent hook asks for its parent's.
 */
export function sessionIdOfFile(file: string): string | undefined {
  const known = idByFile.get(file);
  if (known) return known;
  const id = headerId(file) ?? filenameId(file);
  if (id) idByFile.set(file, id);
  return id;
}

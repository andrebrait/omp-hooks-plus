import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** The subagent a session runs, in the terms of Claude Code's hook payloads. */
export type SubagentIdentity = {
  agentId: string;
  /** OMP's lowercased agent definition name; undefined on OMP < 18.5.1, which has no `ctx.agent`. */
  agentType: string | undefined;
  /** The subagent's own session file; undefined for an in-memory session. */
  file: string | undefined;
  /** The top-level session's file, which its own hooks send as session_id and transcript_path; undefined when unknown. */
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

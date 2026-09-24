import type {
  Hook,
  HookEventName,
  HookGroup,
  HooksConfig,
  SettingsFile,
} from "./types";
import { isRecord } from "./type-guards";

export const HOOK_KEYS: Array<keyof HooksConfig> = [
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "session_start",
  "session_end",
  "pre_compact",
  "post_compact",
  "pre_tool_use",
  "post_tool_use",
  "post_tool_use_failure",
  "user_prompt_submit",
  "stop",
];

/**
 * Claude events with a near-equivalent OMP trigger. Only generated extensions
 * converted with `--approximate` run them; the value explains the difference.
 */
export const APPROXIMATIONS: Record<"Notification" | "SubagentStart", string> = {
  Notification: "Approximated: permission_prompt fires on OMP tool_approval_requested; idle_prompt fires when a top-level agent run ends (agent_end), immediately rather than after Claude Code's 60-second idle delay. Other notification types never fire; hook output is ignored, as in Claude Code.",
  SubagentStart: "Approximated: fires before the first run of an OMP subagent session (a session file nested under its parent's), delivering context to that subagent. OMP does not expose the agent type, so only groups without a matcher (or with \"*\") are approximated; in-memory subagent sessions are not detected.",
};
export const APPROXIMATED_KEYS = Object.keys(APPROXIMATIONS) as Array<keyof typeof APPROXIMATIONS>;


const CLAUDE_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  bashoutput: "BashOutput",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  killbash: "KillBash",
  ls: "LS",
  multiedit: "MultiEdit",
  notebookedit: "NotebookEdit",
  read: "Read",
  task: "Task",
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  write: "Write",
};

const EXACT_MATCHER = /^[\w\s,|-]+$/;

export function toClaudeToolName(toolName: string): string {
  const key = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return CLAUDE_TOOL_NAMES[key] ?? toolName;
}


export function parseHook(value: unknown): Hook | undefined {
  if (
    !isRecord(value) ||
    value.type !== "command" ||
    typeof value.command !== "string" ||
    value.command.trim() === ""
  ) {
    return undefined;
  }
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) ||
      !value.args.every((argument) => typeof argument === "string"))
  ) {
    return undefined;
  }
  if (
    value.shell !== undefined &&
    value.shell !== "bash" &&
    value.shell !== "powershell"
  ) {
    return undefined;
  }

  return {
    type: "command",
    command: value.command,
    ...(value.args !== undefined ? { args: value.args } : {}),
    ...(typeof value.if === "string" ? { if: value.if } : {}),
    ...(typeof value.timeout === "number" &&
    Number.isFinite(value.timeout) &&
    value.timeout > 0
      ? { timeout: value.timeout }
      : {}),
    ...(value.shell !== undefined ? { shell: value.shell } : {}),
    ...(typeof value.async === "boolean" ? { async: value.async } : {}),
    ...(typeof value.asyncRewake === "boolean"
      ? { asyncRewake: value.asyncRewake }
      : {}),
  };
}

function parseHookGroup(value: unknown): HookGroup | undefined {
  if (!isRecord(value)) return undefined;
  const hooks = Array.isArray(value.hooks)
    ? value.hooks
        .map(parseHook)
        .filter((hook): hook is Hook => hook !== undefined)
    : [];
  if (hooks.length === 0) return undefined;
  return {
    ...(typeof value.matcher === "string" ? { matcher: value.matcher } : {}),
    hooks,
  };
}

export function parseSettings(value: unknown, keys: Array<keyof HooksConfig> = HOOK_KEYS): SettingsFile | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.disableAllHooks !== undefined &&
    typeof value.disableAllHooks !== "boolean"
  ) {
    return undefined;
  }
  if (value.hooks !== undefined && !isRecord(value.hooks)) return undefined;

  const hooks: HooksConfig = {};
  if (isRecord(value.hooks)) {
    for (const key of keys) {
      const rawGroups = value.hooks[key];
      if (!Array.isArray(rawGroups)) continue;
      const groups = rawGroups
        .map(parseHookGroup)
        .filter((group): group is HookGroup => group !== undefined);
      if (groups.length > 0) hooks[key] = groups;
    }
  }

  return {
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(typeof value.disableAllHooks === "boolean"
      ? { disableAllHooks: value.disableAllHooks }
      : {}),
  };
}

export function getHookGroups(
  settings: SettingsFile | undefined,
  eventName: HookEventName,
): HookGroup[] {
  const hooks = settings?.hooks;
  if (!hooks) return [];

  switch (eventName) {
    case "SessionStart":
      return [...(hooks.SessionStart ?? []), ...(hooks.session_start ?? [])];
    case "SessionEnd":
      return [...(hooks.SessionEnd ?? []), ...(hooks.session_end ?? [])];
    case "PreCompact":
      return [...(hooks.PreCompact ?? []), ...(hooks.pre_compact ?? [])];
    case "PostCompact":
      return [...(hooks.PostCompact ?? []), ...(hooks.post_compact ?? [])];
    case "PreToolUse":
      return [...(hooks.PreToolUse ?? []), ...(hooks.pre_tool_use ?? [])];
    case "PostToolUse":
      return [...(hooks.PostToolUse ?? []), ...(hooks.post_tool_use ?? [])];
    case "PostToolUseFailure":
      return [
        ...(hooks.PostToolUseFailure ?? []),
        ...(hooks.post_tool_use_failure ?? []),
      ];
    case "UserPromptSubmit":
      return [
        ...(hooks.UserPromptSubmit ?? []),
        ...(hooks.user_prompt_submit ?? []),
      ];
    case "Stop":
      return [...(hooks.Stop ?? []), ...(hooks.stop ?? [])];
    case "Notification":
      return hooks.Notification ?? [];
    case "SubagentStart":
      return hooks.SubagentStart ?? [];
    default:
      return [];
  }
}

/**
 * Match Claude Code matcher semantics:
 * omitted / "" / "*" match all; plain names and comma/pipe-separated lists are
 * exact matches; anything with regex syntax is treated as a JavaScript regex.
 */
export function matcherMatches(
  matcher: string | undefined,
  value: string,
  aliases: string[] = [],
): boolean {
  const trimmed = matcher?.trim();
  if (!trimmed || trimmed === "*") return true;

  const values = [value, ...aliases];

  if (EXACT_MATCHER.test(trimmed)) {
    const lowerValues = values.map((v) => v.toLowerCase());
    return trimmed
      .split(/[|,]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .some((part) => lowerValues.includes(part.toLowerCase()));
  }

  try {
    const regex = new RegExp(trimmed);
    return values.some((candidate) => regex.test(candidate));
  } catch {
    return values.some((v) => v.toLowerCase() === trimmed.toLowerCase());
  }
}

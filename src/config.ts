import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Hook,
  HookEventName,
  HookGroup,
  HooksConfig,
  SettingsFile,
} from "./types";
import { isRecord } from "./type-guards";

export type SettingsScope = "user" | "project" | "local" | "agents";

export type SettingsSource = {
  path: string;
  scope: SettingsScope;
};

export type LoadedSettings = {
  settings: SettingsFile | undefined;
  sources: SettingsSource[];
  sourcePaths: string[];
  projectRoot: string;
  mode: "claude-native" | "cross-vendor" | "user-only";
  projectTrusted: boolean;
  warnings: string[];
  unsupported: string[];
};

export type LoadSettingsOptions = {
  home?: string;
  claudeConfigDir?: string;
  projectTrusted?: boolean;
};


const HOOK_KEYS: Array<keyof HooksConfig> = [
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


function parseHook(value: unknown): Hook | undefined {
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

function parseSettings(value: unknown): SettingsFile | undefined {
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
    for (const key of HOOK_KEYS) {
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

export function readSettingsFile(settingsPath: string): SettingsFile | undefined {
  if (!existsSync(settingsPath)) return undefined;

  try {
    return parseSettings(JSON.parse(readFileSync(settingsPath, "utf8")));
  } catch {
    return undefined;
  }
}

function mergeHooks(
  ...hookSets: Array<HooksConfig | undefined>
): HooksConfig | undefined {
  const merged: HooksConfig = {};
  let hasAnyHook = false;

  for (const key of HOOK_KEYS) {
    const groups = hookSets.flatMap((hooks) => hooks?.[key] ?? []);

    if (groups.length > 0) {
      merged[key] = groups;
      hasAnyHook = true;
    }
  }

  return hasAnyHook ? merged : undefined;
}

export function findProjectRoot(cwd: string): string {
  let current = path.resolve(cwd);

  while (true) {
    if (
      existsSync(path.join(current, ".git")) ||
      existsSync(path.join(current, ".agents", "hooks.json")) ||
      existsSync(path.join(current, ".claude", "settings.json")) ||
      existsSync(path.join(current, ".claude", "settings.local.json"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

export function loadSettings(
  cwd: string,
  options: LoadSettingsOptions = {},
): LoadedSettings {
  const home = options.home ?? os.homedir();
  const projectRoot = findProjectRoot(cwd);
  const projectTrusted = options.projectTrusted ?? false;
  const userClaudeDir =
    options.claudeConfigDir ??
    process.env.CLAUDE_CONFIG_DIR ??
    path.join(home, ".claude");
  const userPath = path.join(userClaudeDir, "settings.json");
  const agentsPath = path.join(projectRoot, ".agents", "hooks.json");
  const projectPath = path.join(projectRoot, ".claude", "settings.json");
  const localPath = path.join(projectRoot, ".claude", "settings.local.json");

  const sources: SettingsSource[] = [];
  const settingsFiles: SettingsFile[] = [];
  const warnings: string[] = [];
  const addSource = (settingsPath: string, scope: SettingsScope): void => {
    if (!existsSync(settingsPath)) return;
    sources.push({ path: settingsPath, scope });
    const settings = readSettingsFile(settingsPath);
    if (settings) {
      settingsFiles.push(settings);
    } else {
      warnings.push(`Failed to parse hooks settings: ${settingsPath}`);
    }
  };

  addSource(userPath, "user");

  let mode: LoadedSettings["mode"] = "user-only";
  if (projectTrusted && existsSync(agentsPath)) {
    mode = "cross-vendor";
    addSource(agentsPath, "agents");
  } else if (projectTrusted) {
    mode = "claude-native";
    addSource(projectPath, "project");
    addSource(localPath, "local");
  }

  const disabled = settingsFiles.some((settings) => settings.disableAllHooks === true);
  const hooks = disabled
    ? undefined
    : mergeHooks(...settingsFiles.map((settings) => settings.hooks));
  const settings = hooks ? { hooks } : undefined;

  return {
    settings,
    sources,
    sourcePaths: sources.map((source) => source.path),
    projectRoot,
    mode,
    projectTrusted,
    unsupported: [
      "Claude managed-policy hooks are not loaded",
      "Claude plugin hooks are not loaded",
    ],
    warnings,
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

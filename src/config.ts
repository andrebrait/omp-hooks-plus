import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isProviderEnabled, isUserSourceEnabled } from "@oh-my-pi/pi-coding-agent/capability";
import {
  listClaudePluginRoots,
  type ClaudePluginRoot,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { HOOK_KEYS, parseHook, parseSettings } from "./claude";
import { findProjectRoot } from "./helpers";
import type {
  Hook,
  HookGroup,
  HooksConfig,
  SettingsFile,
} from "./types";
import { isRecord } from "./type-guards";

export type SettingsScope = "user" | "project" | "local" | "agents" | "plugin";

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
  /** Override settings/data storage only; plugin registries follow OMP's active profile. */
  claudeConfigDir?: string;
  projectTrusted?: boolean;
};

const HOOK_KEY_SET: Record<string, true> = Object.fromEntries(HOOK_KEYS.map((key) => [key, true]));

const CLAUDE_PLUGINS_PROVIDER_ID = "claude-plugins";
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

// ============================================================================
// Claude plugin manifest hooks
// ============================================================================

function attachHookEnv(hooks: HooksConfig, env: Record<string, string>): HooksConfig {
  const result: HooksConfig = {};
  for (const key of HOOK_KEYS) {
    const groups = hooks[key];
    if (!groups) continue;
    result[key] = groups.map((group) => ({
      ...group,
      hooks: group.hooks?.map((hook) => ({ ...hook, env })),
    }));
  }
  return result;
}

function parsePluginHookGroup(
  value: unknown,
  eventKey: string,
  sourceDescription: string,
  warnings: string[],
  unsupported: Set<string>,
): HookGroup | undefined {
  if (!isRecord(value)) {
    warnings.push(`Malformed plugin hook group for event "${eventKey}" in ${sourceDescription}`);
    return undefined;
  }
  const rawHooks = Array.isArray(value.hooks) ? value.hooks : [];
  const hooks: Hook[] = [];
  for (const rawHook of rawHooks) {
    if (isRecord(rawHook) && rawHook.type !== undefined && rawHook.type !== "command") {
      unsupported.add(
        `Claude plugin hook type "${String(rawHook.type)}" for event "${eventKey}" is not supported`,
      );
      continue;
    }
    const hook = parseHook(rawHook);
    if (hook) {
      hooks.push(hook);
    } else {
      warnings.push(`Malformed plugin hook entry for event "${eventKey}" in ${sourceDescription}`);
    }
  }
  if (hooks.length === 0) return undefined;
  return {
    ...(typeof value.matcher === "string" ? { matcher: value.matcher } : {}),
    hooks,
  };
}

function parsePluginHooksConfig(
  value: unknown,
  sourceDescription: string,
  warnings: string[],
  unsupported: Set<string>,
): HooksConfig | undefined {
  if (!isRecord(value)) {
    warnings.push(`Malformed plugin hooks configuration in ${sourceDescription}: expected an object`);
    return undefined;
  }
  const hooks: HooksConfig = {};
  for (const [key, rawGroups] of Object.entries(value)) {
    if (!Object.hasOwn(HOOK_KEY_SET, key)) {
      unsupported.add(`Claude plugin hook event "${key}" is not supported`);
      continue;
    }
    if (!Array.isArray(rawGroups)) {
      warnings.push(`Malformed plugin hook groups for event "${key}" in ${sourceDescription}`);
      continue;
    }
    const groups = rawGroups
      .map((group) => parsePluginHookGroup(group, key, sourceDescription, warnings, unsupported))
      .filter((group): group is HookGroup => group !== undefined);
    if (groups.length > 0) hooks[key as keyof HooksConfig] = groups;
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

function isWithinRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRealpath(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a plugin-declared hook config path (string form of `plugin.json`'s
 * `hooks` field, or one entry of its array form) against the plugin root.
 * Rejects both lexical escapes (`../../etc/passwd`) and symlink escapes (a
 * path inside the root that resolves outside it) with a diagnostic instead of
 * silently reading whatever the path points to.
 */
function resolvePluginConfigPath(
  root: string,
  declaredPath: string,
  warnings: string[],
): string | undefined {
  const resolved = path.resolve(root, declaredPath);
  if (!isWithinRoot(resolved, root)) {
    warnings.push(`Rejected plugin hook config path escaping plugin root: ${declaredPath}`);
    return undefined;
  }
  if (!existsSync(resolved)) {
    warnings.push(`Plugin hook config file not found: ${resolved}`);
    return undefined;
  }
  const realResolved = safeRealpath(resolved);
  const realRoot = safeRealpath(root);
  if (realResolved !== undefined && realRoot !== undefined && !isWithinRoot(realResolved, realRoot)) {
    warnings.push(`Rejected plugin hook config path escaping plugin root via symlink: ${declaredPath}`);
    return undefined;
  }
  return resolved;
}

/** Read a `hooks/hooks.json`-shaped file: `{ description?, hooks: {...} }`, tolerating a bare hooks object. */
function readHooksWrapper(filePath: string, warnings: string[]): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (isRecord(parsed) && "hooks" in parsed) return parsed.hooks;
    return parsed;
  } catch {
    warnings.push(`Failed to parse plugin hooks file: ${filePath}`);
    return undefined;
  }
}

/**
 * Resolve one installed plugin's command hooks per the Claude plugin schema:
 * `plugin.json.hooks` is an inline object, a string pointing at a custom file,
 * an array of such files, or (when absent) the default `hooks/hooks.json`.
 * Attaches CLAUDE_PLUGIN_ROOT/CLAUDE_PLUGIN_DATA/CLAUDE_PROJECT_DIR to every
 * resulting hook so the executor can spawn with real env vars — never by
 * textually interpolating the plugin path into a shell command string.
 */
function resolvePluginRoot(
  root: ClaudePluginRoot,
  claudeConfigDir: string,
  projectRoot: string,
  warnings: string[],
  unsupported: Set<string>,
): { hooks: HooksConfig; sourcePath: string } | undefined {
  const manifestPath = path.join(root.path, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) return undefined;

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    warnings.push(`Failed to parse plugin manifest: ${manifestPath}`);
    return undefined;
  }
  if (!isRecord(manifest)) {
    warnings.push(`Failed to parse plugin manifest: ${manifestPath}`);
    return undefined;
  }

  const declared = manifest.hooks;
  const rawConfigs: unknown[] = [];
  let sourcePath: string;

  if (declared === undefined) {
    const defaultPath = path.join(root.path, "hooks", "hooks.json");
    if (!existsSync(defaultPath)) return undefined;
    const parsed = readHooksWrapper(defaultPath, warnings);
    if (parsed === undefined) return undefined;
    rawConfigs.push(parsed);
    sourcePath = defaultPath;
  } else if (Array.isArray(declared)) {
    const resolvedPaths: string[] = [];
    for (const entry of declared) {
      if (typeof entry !== "string") {
        warnings.push(`Malformed plugin hooks entry (expected a path string) in ${manifestPath}`);
        continue;
      }
      const resolvedPath = resolvePluginConfigPath(root.path, entry, warnings);
      if (!resolvedPath) continue;
      const parsed = readHooksWrapper(resolvedPath, warnings);
      if (parsed !== undefined) {
        rawConfigs.push(parsed);
        resolvedPaths.push(resolvedPath);
      }
    }
    if (rawConfigs.length === 0) return undefined;
    sourcePath = resolvedPaths.join(", ");
  } else if (typeof declared === "string") {
    const resolvedPath = resolvePluginConfigPath(root.path, declared, warnings);
    if (!resolvedPath) return undefined;
    const parsed = readHooksWrapper(resolvedPath, warnings);
    if (parsed === undefined) return undefined;
    rawConfigs.push(parsed);
    sourcePath = resolvedPath;
  } else if (isRecord(declared)) {
    rawConfigs.push(declared);
    sourcePath = manifestPath;
  } else {
    warnings.push(`Malformed plugin hooks field (expected object, string, or array) in ${manifestPath}`);
    return undefined;
  }

  const parsedConfigs = rawConfigs
    .map((raw) => parsePluginHooksConfig(raw, sourcePath, warnings, unsupported))
    .filter((config): config is HooksConfig => config !== undefined);
  const merged = mergeHooks(...parsedConfigs);
  if (!merged) return undefined;

  const dataDir = path.join(
    claudeConfigDir,
    "plugins",
    "data",
    encodeURIComponent(root.id),
  );
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    warnings.push(`Failed to create plugin data directory ${dataDir}: ${String(error)}`);
    return undefined;
  }

  return {
    hooks: attachHookEnv(merged, {
      CLAUDE_PLUGIN_ROOT: root.path,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_PROJECT_DIR: projectRoot,
    }),
    sourcePath,
  };
}


export async function loadSettings(
  cwd: string,
  options: LoadSettingsOptions = {},
): Promise<LoadedSettings> {
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
  const pluginUnsupported = new Set<string>();
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

  if (isProviderEnabled(CLAUDE_PLUGINS_PROVIDER_ID)) {
    // Untrusted projects must not even resolve a project-scoped plugin registry:
    // listClaudePluginRoots lets a project registry entry shadow a user-scope
    // entry sharing the same plugin id, which would let an untrusted repo
    // suppress the user's own safety hooks. Omitting `cwd` entirely (not just
    // filtering the result afterward) keeps that shadowing from ever happening.
    const { roots, warnings: rootWarnings } = await listClaudePluginRoots(
      home,
      projectTrusted ? cwd : undefined,
    );
    warnings.push(...rootWarnings);
    const foreignUserEnabled = isUserSourceEnabled(CLAUDE_PLUGINS_PROVIDER_ID) || isUserSourceEnabled("claude");

    for (const root of roots) {
      if (root.scope === "project" && !projectTrusted) continue;
      if (root.scope === "user" && root.origin === "claude" && !foreignUserEnabled) continue;
      const resolved = resolvePluginRoot(root, userClaudeDir, projectRoot, warnings, pluginUnsupported);
      if (resolved) {
        sources.push({ path: resolved.sourcePath, scope: "plugin" });
        settingsFiles.push({ hooks: resolved.hooks });
      }
    }
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
      "Claude plugin hook types other than \"command\" (http, prompt, agent, mcp_tool) are not loaded",
      "Claude plugin hook events outside SessionStart/SessionEnd/PreCompact/PostCompact/PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/Stop are not loaded",
      ...pluginUnsupported,
    ],
    warnings,
  };
}


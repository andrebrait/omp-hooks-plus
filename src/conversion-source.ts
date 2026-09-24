import { constants, realpathSync, statSync } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { APPROXIMATED_KEYS, APPROXIMATIONS, HOOK_KEYS, parseHook, parseSettings } from "./claude";
import { isRecord } from "./type-guards";
import type { Hook, HookGroup, HooksConfig, SettingsFile } from "./types";

export type ConversionReport = {
  schemaVersion: 1;
  conversionLevel: "command-hook-adaptation";
  source: { kind: "plugin" | "file"; name: string; entry: string };
  hooks: Array<{
    file: string;
    pointer: string;
    event: string;
    status: "supported" | "approximated" | "unsupported" | "invalid";
  }>;
  nativeBindings: Array<{
    file: string;
    pointer: string;
    kind: "pi" | "omp";
    status: "not-reused";
  }>;
  diagnostics: Array<{
    level: "error" | "unsupported" | "info";
    file?: string;
    pointer?: string;
    message: string;
  }>;
};

export type ConversionSource = {
  root: string;
  rootIdentity: { realPath: string; dev: number; ino: number };
  kind: "plugin" | "file";
  name: string;
  settings: SettingsFile;
  declarationFiles: string[];
  report: ConversionReport;
};

type Location = { file: string; pointer: string };
type Status = ConversionReport["hooks"][number]["status"];
const { YAML } = createRequire(import.meta.url)("bun") as { YAML: { parse(input: string): unknown } };
const supportedEvents: Record<string, true> = Object.fromEntries(HOOK_KEYS.map((key) => [key, true]));
const hookFields: Record<string, true> = {
  type: true, command: true, args: true, if: true, timeout: true, shell: true, async: true, asyncRewake: true,
  statusMessage: true,
};
const groupFields: Record<string, true> = { matcher: true, hooks: true };
const configFields: Record<string, true> = { hooks: true, disableAllHooks: true, description: true, $schema: true };
const child = (location: Location, key: string | number): Location => ({
  file: location.file,
  pointer: `${location.pointer}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`,
});
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Keep source loading, resource inventory, and publication bound to the same directory. */
export function assertConversionRoot(source: Pick<ConversionSource, "root" | "rootIdentity">): void {
  const { root, rootIdentity } = source;
  const canonical = realpathSync(root);
  const current = statSync(root);
  if (canonical !== rootIdentity.realPath || !current.isDirectory() ||
      current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) {
    throw new Error("Source root changed during conversion; retry with a stable source.");
  }
}

/** Static inventory only: this function never discovers ambient settings or loads source code. */
export async function loadConversionSource(
  input: string,
  options: { sourceRoot?: string; approximate?: boolean } = {},
): Promise<ConversionSource> {
  const entry = path.resolve(input);
  const inputStat = await stat(entry).catch(() => {
    throw new Error("Cannot read source input; supply an existing plugin directory or JSON file.");
  });
  if (!inputStat.isDirectory() && !inputStat.isFile()) {
    throw new Error("Source input must be a regular JSON file or plugin directory.");
  }
  const kind = inputStat.isDirectory() ? "plugin" : "file";
  if (kind === "plugin" && options.sourceRoot !== undefined) {
    throw new Error("sourceRoot applies only to explicit file inputs; plugin directories are their own root.");
  }
  const root = kind === "plugin" ? entry : path.resolve(options.sourceRoot ?? path.dirname(entry));
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) throw new Error("sourceRoot must be an existing directory.");
  const realRoot = await realpath(root);
  const rootIdentity = { realPath: realRoot, dev: rootStat.dev, ino: rootStat.ino };
  assertConversionRoot({ root, rootIdentity });
  if (!within(root, entry) || !within(realRoot, await realpath(entry))) {
    throw new Error("Source input escapes sourceRoot, lexically or through a symlink.");
  }
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/") || ".";
  const report: ConversionReport = {
    schemaVersion: 1,
    conversionLevel: "command-hook-adaptation",
    source: { kind, name: path.basename(kind === "plugin" ? root : entry, kind === "file" ? path.extname(entry) : ""), entry: relative(entry) },
    hooks: [],
    nativeBindings: [],
    diagnostics: [{
      level: "info",
      message: "Command-hook adaptation only: native commands, recovery tools, provider integration, system-prompt ownership, and session state are not reproduced.",
    }],
  };
  const declarationFiles = new Set<string>();
  const merged: SettingsFile = {};
  const diagnostic = (level: "error" | "unsupported" | "info", location: Location, message: string) => {
    report.diagnostics.push({ level, ...location, message });
  };
  const rank: Record<Status, number> = { supported: 0, approximated: 1, unsupported: 2, invalid: 3 };
  const combine = (a: Status, b: Status): Status => rank[a] >= rank[b] ? a : b;
  const emitted = (status: Status) => status === "supported" || status === "approximated";

  async function resolveFile(declared: unknown, location: Location, optional = false): Promise<string | undefined> {
    if (typeof declared !== "string" || declared.trim() === "" || path.isAbsolute(declared) ||
        path.win32.isAbsolute(declared) || /[\\\x00-\x1f\x7f*?\[\]{}$]/.test(declared) ||
        /^[a-z][a-z\d+.-]*:/i.test(declared) || declared.startsWith("~") || declared.split("/").includes("..")) {
      diagnostic("error", location, "Expected a literal, source-root-relative path without traversal, URLs, or expansions.");
      return;
    }
    const resolved = path.resolve(root, declared);
    if (!within(root, resolved)) {
      diagnostic("error", location, "Referenced path escapes the source root.");
      return;
    }
    try {
      await lstat(resolved);
    } catch (error) {
      if (optional && isRecord(error) && error.code === "ENOENT") return;
      diagnostic("error", location, "Referenced path cannot be read; check that it exists and is accessible.");
      return;
    }
    try {
      if (!within(realRoot, await realpath(resolved))) {
        diagnostic("error", location, "Referenced path escapes the source root through a symlink.");
        return;
      }
      return resolved;
    } catch {
      diagnostic("error", location, "Referenced path cannot be resolved; check for a broken or cyclic symlink.");
    }
  }

  async function readDeclaration(file: string): Promise<{ canonical: string; text: string }> {
    assertConversionRoot({ root, rootIdentity });
    const canonical = await realpath(file);
    if (!within(realRoot, canonical)) throw new Error("Declaration escapes the source root.");
    const expected = await lstat(canonical);
    if (!expected.isFile()) throw new Error("Declaration must be a regular file.");
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino ||
          await realpath(file) !== canonical || await realpath(canonical) !== canonical) {
        throw new Error("Declaration changed during conversion.");
      }
      assertConversionRoot({ root, rootIdentity });
      const text = await handle.readFile("utf8");
      assertConversionRoot({ root, rootIdentity });
      return { canonical, text };
    } finally {
      await handle.close();
    }
  }

  async function json(file: string, explicit = false): Promise<unknown> {
    const location = { file: relative(file), pointer: "" };
    declarationFiles.add(file);
    try {
      const { canonical, text } = await readDeclaration(file);
      declarationFiles.add(canonical);
      try {
        return JSON.parse(text);
      } catch {
        if (explicit) throw new Error("Source JSON cannot be parsed; correct its JSON syntax before converting.");
        diagnostic("error", location, "Cannot parse JSON; correct the syntax in this declaration file.");
      }
    } catch (error) {
      if (explicit) throw error instanceof Error ? error : new Error("Cannot read source JSON.");
      diagnostic("error", location, "Cannot read declaration file; expected an accessible regular JSON file.");
    }
  }

  function fields(value: Record<string, unknown>, allowed: Record<string, true>, location: Location): Status {
    let status: Status = "supported";
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(allowed, key)) continue;
      diagnostic("unsupported", child(location, key), "This declaration field is not supported by the hook adapter.");
      status = "unsupported";
    }
    return status;
  }

  function hook(value: unknown, location: Location, inherited: Status, event: string): Hook | undefined {
    let status = inherited;
    const invalid = (where: Location, message: string) => {
      status = "invalid";
      diagnostic("error", where, message);
    };
    if (!isRecord(value)) {
      invalid(location, "Expected a hook handler object.");
    } else {
      status = combine(status, fields(value, hookFields, location));
      if (typeof value.type !== "string" || value.type.trim() === "") {
        invalid(child(location, "type"), "Hook type must be a nonempty string.");
      } else if (value.type !== "command") {
        status = combine(status, "unsupported");
        diagnostic("unsupported", child(location, "type"), "Only command hook handlers are supported.");
      }
      if (value.type === "command" && (typeof value.command !== "string" || value.command.trim() === "")) {
        invalid(child(location, "command"), "Command hook requires a nonempty command string.");
      }
      if ("args" in value && (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string"))) {
        invalid(child(location, "args"), "Hook args must be an array of strings.");
      }
      if ("statusMessage" in value) {
        const where = child(location, "statusMessage");
        if (typeof value.statusMessage !== "string") invalid(where, "Hook statusMessage must be a string.");
        else diagnostic("info", where, "Hook status presentation is not reproduced by the adapter.");
      }
      if ("if" in value && typeof value.if !== "string") invalid(child(location, "if"), "Hook if must be a string.");
      if ("timeout" in value && (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout <= 0)) {
        invalid(child(location, "timeout"), "Hook timeout must be a finite positive number.");
      }
      for (const key of ["async", "asyncRewake"]) {
        if (key in value && typeof value[key] !== "boolean") invalid(child(location, key), "Hook async flags must be boolean.");
      }
      if ("shell" in value && value.shell !== "bash" && value.shell !== "powershell") {
        if (typeof value.shell !== "string") invalid(child(location, "shell"), "Hook shell must be a string.");
        else {
          status = combine(status, "unsupported");
          diagnostic("unsupported", child(location, "shell"), "Only bash and powershell hook shells are supported.");
        }
      }
    }
    const parsed = emitted(status) ? parseHook(value) : undefined;
    if (emitted(status) && !parsed) invalid(location, "Hook does not satisfy the supported command contract.");
    report.hooks.push({ ...location, event, status });
    return parsed;
  }

  function inventory(value: unknown, location: Location, scoped = false): HooksConfig {
    const result: HooksConfig = {};
    if (!isRecord(value)) {
      diagnostic("error", location, "Expected an object mapping hook event names to group arrays.");
      return result;
    }
    for (const [event, groups] of Object.entries(value)) {
      const eventLocation = child(location, event);
      let eventStatus: Status = "supported";
      if (!scoped && options.approximate && Object.hasOwn(APPROXIMATIONS, event)) {
        eventStatus = "approximated";
        diagnostic("info", eventLocation, APPROXIMATIONS[event as keyof typeof APPROXIMATIONS]);
      } else if (scoped || !Object.hasOwn(supportedEvents, event)) {
        eventStatus = "unsupported";
        diagnostic("unsupported", eventLocation, scoped
          ? "Skill and agent frontmatter hooks require scoped activation that this adapter cannot preserve."
          : "This hook event is not supported by the adapter.");
      }
      if (!Array.isArray(groups)) {
        diagnostic("error", eventLocation, "Hook event must contain an array of hook groups.");
        report.hooks.push({ ...eventLocation, event, status: "invalid" });
        continue;
      }
      if (groups.length === 0) report.hooks.push({ ...eventLocation, event, status: eventStatus });
      const parsedGroups: HookGroup[] = [];
      groups.forEach((group, groupIndex) => {
        const groupLocation = child(eventLocation, groupIndex);
        if (!isRecord(group)) {
          diagnostic("error", groupLocation, "Expected a hook group object.");
          report.hooks.push({ ...groupLocation, event, status: "invalid" });
          return;
        }
        let groupStatus = combine(eventStatus, fields(group, groupFields, groupLocation));
        if (eventStatus === "approximated" && event === "SubagentStart" && typeof group.matcher === "string"
            && group.matcher.trim() !== "" && group.matcher.trim() !== "*") {
          groupStatus = combine(groupStatus, "unsupported");
          diagnostic("unsupported", child(groupLocation, "matcher"), "OMP does not expose a subagent's agent type; a SubagentStart matcher cannot be approximated.");
        }
        if ("matcher" in group && typeof group.matcher !== "string") {
          groupStatus = "invalid";
          diagnostic("error", child(groupLocation, "matcher"), "Hook matcher must be a string.");
        }
        if (!Array.isArray(group.hooks)) {
          diagnostic("error", child(groupLocation, "hooks"), "Hook group must contain a hooks array.");
          report.hooks.push({ ...groupLocation, event, status: "invalid" });
          return;
        }
        if (group.hooks.length === 0) report.hooks.push({ ...groupLocation, event, status: groupStatus });
        const parsedHooks: Hook[] = [];
        group.hooks.forEach((value: unknown, index: number) => {
          const parsed = hook(value, child(child(groupLocation, "hooks"), index), groupStatus, event);
          if (parsed) parsedHooks.push(parsed);
        });
        if (parsedHooks.length) parsedGroups.push({
          ...(typeof group.matcher === "string" ? { matcher: group.matcher } : {}), hooks: parsedHooks,
        });
      });
      if (parsedGroups.length) result[event as keyof HooksConfig] = parsedGroups;
    }
    return result;
  }

  function config(value: unknown, location: Location, settingsOnly = false): void {
    if (!isRecord(value)) {
      diagnostic("error", location, "Expected a hooks or settings JSON object.");
      return;
    }
    const wrapped = settingsOnly || "hooks" in value || "disableAllHooks" in value;
    let disable: boolean | undefined;
    if (wrapped) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(configFields, key)) {
          diagnostic("info", child(location, key), "Non-hook settings are not migrated by this hook converter.");
        }
      }
      if ("disableAllHooks" in value) {
        if (typeof value.disableAllHooks === "boolean") disable = value.disableAllHooks;
        else diagnostic("error", child(location, "disableAllHooks"), "disableAllHooks must be boolean.");
      }
    }
    const hooks = !wrapped ? inventory(value, location)
      : "hooks" in value ? inventory(value.hooks, child(location, "hooks")) : {};
    const keys = options.approximate ? [...HOOK_KEYS, ...APPROXIMATED_KEYS] : HOOK_KEYS;
    const parsed = parseSettings({ hooks, ...(disable !== undefined ? { disableAllHooks: disable } : {}) }, keys);
    if (parsed?.hooks) {
      merged.hooks ??= {};
      for (const key of keys) {
        const groups = parsed.hooks[key];
        if (groups) (merged.hooks[key] ??= []).push(...groups);
      }
    }
    // A source-wide disable cannot be undone by a later hook-file declaration.
    if (parsed?.disableAllHooks !== undefined) merged.disableAllHooks = merged.disableAllHooks === true || parsed.disableAllHooks;
  }

  async function referencedConfig(declared: unknown, location: Location, optional = false): Promise<void> {
    const file = await resolveFile(declared, location, optional);
    if (!file) return;
    const value = await json(file);
    if (value !== undefined) config(value, { file: relative(file), pointer: "" });
  }

  const seenFrontmatter = new Set<string>();
  async function frontmatter(file: string): Promise<void> {
    const location = { file: relative(file), pointer: "/frontmatter" };
    let canonical: string;
    let text: string;
    try {
      ({ canonical, text } = await readDeclaration(file));
    } catch {
      diagnostic("error", location, "Cannot read scoped declaration file.");
      return;
    }
    if (seenFrontmatter.has(canonical)) return;
    seenFrontmatter.add(canonical);
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return;
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end < 0) {
      diagnostic("error", location, "Frontmatter opening delimiter has no closing delimiter.");
      return;
    }
    let value: unknown;
    try { value = YAML.parse(lines.slice(1, end).join("\n")); } catch {
      diagnostic("error", location, "Cannot parse YAML frontmatter; correct its syntax.");
      return;
    }
    if (value === null) return;
    if (!isRecord(value)) {
      diagnostic("error", location, "Frontmatter must contain a YAML mapping.");
      return;
    }
    if ("hooks" in value) {
      declarationFiles.add(file);
      declarationFiles.add(canonical);
      inventory(value.hooks, child(location, "hooks"), true);
    }
  }

  const visitedDirectories = new Set<string>();
  async function scan(declared: unknown, location: Location, scope: "skills" | "agents" | "commands", optional = false): Promise<void> {
    const target = await resolveFile(declared, location, optional);
    if (!target) return;
    const targetStat = await stat(target);
    if (targetStat.isFile()) {
      if (target.endsWith(".md")) await frontmatter(target);
      else diagnostic("error", location, "Scoped declaration reference must name Markdown or a directory.");
      return;
    }
    if (!targetStat.isDirectory()) {
      diagnostic("error", location, "Scoped declaration reference must name a regular file or directory.");
      return;
    }
    const canonical = `${scope}:${await realpath(target)}`;
    if (visitedDirectories.has(canonical)) return;
    visitedDirectories.add(canonical);
    let entries;
    try { entries = await readdir(target, { withFileTypes: true }); } catch {
      diagnostic("error", location, "Cannot list scoped declaration directory.");
      return;
    }
    for (const item of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (item.name === ".git" || item.name === "node_modules") continue;
      const file = path.join(target, item.name);
      const fileLocation = { file: relative(file), pointer: "" };
      const matches = scope === "skills" ? item.name === "SKILL.md" : item.name.endsWith(".md");
      if (item.isSymbolicLink()) {
        const safe = await resolveFile(relative(file), fileLocation);
        if (!safe) continue;
        const linkedStat = await stat(safe);
        if (linkedStat.isDirectory()) await scan(relative(file), fileLocation, scope);
        else if (linkedStat.isFile() && matches) await frontmatter(safe);
      } else if (item.isDirectory()) {
        await scan(relative(file), fileLocation, scope);
      } else if (item.isFile() && matches) {
        await frontmatter(file);
      }
    }
  }

  function nativeBindings(value: Record<string, unknown>, file: string): void {
    for (const kind of ["pi", "omp"] as const) {
      if (!(kind in value)) continue;
      const location = { file, pointer: `/${kind}` };
      report.nativeBindings.push({ ...location, kind, status: "not-reused" });
      diagnostic("info", location, `Declared ${kind} bindings are not imported or reused; disable overlapping original bindings before enabling generated hooks.`);
      const binding = value[kind];
      if (isRecord(binding) && Array.isArray(binding.extensions)) {
        binding.extensions.forEach((_entry: unknown, index: number) => {
          const entryLocation = child(child(location, "extensions"), index);
          report.nativeBindings.push({ ...entryLocation, kind, status: "not-reused" });
          diagnostic("info", entryLocation, `Declared ${kind} extension entrypoint is not executed or used to suppress Claude hooks.`);
        });
      }
    }
  }

  if (kind === "file") {
    config(await json(entry, true), { file: relative(entry), pointer: "" }, /^settings(?:\.local)?\.json$/i.test(path.basename(entry)));
  } else {
    const manifestLocation = { file: ".claude-plugin/plugin.json", pointer: "" };
    const manifestPath = await resolveFile(".claude-plugin/plugin.json", manifestLocation, true);
    let manifest: Record<string, unknown> = {};
    if (manifestPath) {
      const value = await json(manifestPath);
      if (isRecord(value)) manifest = value;
      else if (value !== undefined) diagnostic("error", manifestLocation, "Plugin manifest must be a JSON object.");
    }
    if ("name" in manifest) {
      if (typeof manifest.name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.name)) report.source.name = manifest.name;
      else diagnostic("error", child(manifestLocation, "name"), "Plugin name must contain only letters, digits, dots, underscores, or hyphens.");
    }
    nativeBindings(manifest, manifestLocation.file);
    if ("hooks" in manifest) {
      const location = child(manifestLocation, "hooks");
      if (isRecord(manifest.hooks)) config(manifest.hooks, location);
      else if (Array.isArray(manifest.hooks)) {
        for (const [index, declared] of manifest.hooks.entries()) await referencedConfig(declared, child(location, index));
      } else await referencedConfig(manifest.hooks, location);
    } else await referencedConfig("hooks/hooks.json", { file: "hooks/hooks.json", pointer: "" }, true);

    const settingsPath = await resolveFile("settings.json", { file: "settings.json", pointer: "" }, true);
    if (settingsPath) {
      const value = await json(settingsPath);
      if (value !== undefined) config(value, { file: "settings.json", pointer: "" }, true);
    }
    const skillsPath = await resolveFile("skills", { file: "skills", pointer: "" }, true);
    if (skillsPath) await scan("skills", { file: "skills", pointer: "" }, "skills");
    else if (!("skills" in manifest)) await scan("SKILL.md", { file: "SKILL.md", pointer: "" }, "skills", true);
    for (const scope of ["skills", "agents", "commands"] as const) {
      if (scope in manifest) {
        const location = child(manifestLocation, scope);
        const declared = manifest[scope];
        if (Array.isArray(declared)) {
          for (const [index, item] of declared.entries()) await scan(item, child(location, index), scope);
        } else await scan(declared, location, scope);
      } else if (scope !== "skills") await scan(scope, { file: scope, pointer: "" }, scope, true);
    }
    const packagePath = await resolveFile("package.json", { file: "package.json", pointer: "" }, true);
    if (packagePath) {
      const value = await json(packagePath);
      if (isRecord(value)) nativeBindings(value, "package.json");
      else if (value !== undefined) diagnostic("error", { file: "package.json", pointer: "" }, "Package manifest must be a JSON object.");
    }
  }
  assertConversionRoot({ root, rootIdentity });
  return { root, rootIdentity, kind, name: report.source.name, settings: merged, declarationFiles: [...declarationFiles], report };
}

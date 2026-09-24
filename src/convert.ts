#!/usr/bin/env bun
import {
  constants,
  copyFileSync,
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  openSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type ReadStream,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertConversionRoot,
  loadConversionSource,
  type ConversionReport,
  type ConversionSource,
} from "./conversion-source";

export type ConvertOptions = {
  out?: string;
  sourceRoot?: string;
  include?: string[];
  dryRun?: boolean;
  activation?: "enabled" | "project-trusted";
  /** Convert supported hooks even when others are unsupported; the report lists every skipped one. */
  skipUnsupported?: boolean;
  /** Run near-equivalents for Claude events OMP lacks (see APPROXIMATIONS in claude.ts). */
  approximate?: boolean;
};

export type ConvertResult = {
  exitCode: 0 | 1 | 2;
  report: ConversionReport & {
    activation: { policy: "enabled" | "project-trusted"; projectTrustRequired: boolean };
    options: { skipUnsupported: boolean; approximate: boolean };
    output: { entrypoint: string | null; resources: string[]; excludedResources: string[]; omittedResources: string[] };
  };
};

type Resource = { source: string; relative: string; dev: number; ino: number };

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const EXCLUDED_NAMES: Record<string, true> = {
  ".git": true, ".hg": true, ".svn": true, node_modules: true,
  ".venv": true, __pycache__: true, ".cache": true, ".pi": true,
  ".omp": true, ".claude": true,
};

function excludedName(name: string): boolean {
  return EXCLUDED_NAMES[name.toLowerCase()] === true
    || /^(?:\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name)
    || /^(?:package(?:-lock)?\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml)$/i.test(name);
}

function collectResources(source: ConversionSource, includes: string[]): { files: Resource[]; excluded: string[]; omitted: string[] } {
  const files = new Map<string, Resource>();
  const excluded = new Set<string>();
  const omitted = new Set<string>();
  const declarations = new Set(source.declarationFiles.map(file => path.resolve(file)));
  assertConversionRoot(source);
  const realRoot = source.rootIdentity.realPath;
  const selected = includes.map(include => {
    if (path.isAbsolute(include)) throw new Error("--include paths must be relative to the source root");
    if (include.split(path.sep).includes("..")) throw new Error("--include paths cannot contain parent traversal");
    const file = path.resolve(source.root, include);
    if (!within(source.root, file)) throw new Error("An --include path escapes the source root");
    // Check every component, including excluded ancestors and symlink parents.
    let component = source.root;
    for (const name of path.relative(source.root, file).split(path.sep).filter(Boolean)) {
      component = path.join(component, name);
      if (excludedName(name) || lstatSync(component).isSymbolicLink()) {
        throw new Error("--include cannot select excluded files or traverse symlinks");
      }
    }
    return file;
  });
  const visit = (file: string): void => {
    const relative = path.relative(source.root, file).split(path.sep).join("/");
    if (!within(source.root, file)) throw new Error("A resource path escapes the source root");
    if (excludedName(path.basename(file)) || declarations.has(file)) {
      excluded.add(relative);
      return;
    }
    const stat = lstatSync(file);
    if (!stat.isDirectory() && includes.length > 0 && !selected.some(root => within(root, file))) {
      omitted.add(relative);
      return;
    }
    if (stat.isSymbolicLink()) {
      source.report.diagnostics.push({ level: "unsupported", file: relative, message: existsSync(file)
        ? "Resource symlinks require explicit resolution before conversion"
        : "Resource symlink target does not exist; restore the target or remove the link before conversion" });
      return;
    }
    if (!within(realRoot, realpathSync(file))) throw new Error("A resource resolves outside the source root");
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(path.join(file, name));
    } else if (stat.isFile()) {
      files.set(relative, { source: file, relative, dev: stat.dev, ino: stat.ino });
    } else {
      source.report.diagnostics.push({ level: "unsupported", file: relative, message: "Only regular resource files can be copied" });
    }
  };

  if (source.kind === "plugin") {
    for (const name of readdirSync(source.root).sort()) visit(path.join(source.root, name));
  } else {
    for (const file of selected) visit(file);
  }
  return {
    files: [...files.values()].sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0),
    excluded: [...excluded].sort(),
    omitted: [...omitted].sort(),
  };
}

function activationPolicy(value: unknown): "enabled" | "project-trusted" {
  if (value === undefined) return "enabled";
  if (value === "enabled" || value === "project-trusted") return value;
  throw new Error("--activation must be enabled or project-trusted");
}

function generatedEntrypoint(source: ConversionSource, resourceHash: string, activation: "enabled" | "project-trusted", approximate: boolean): string {
  const definition = JSON.stringify(source.settings, null, 2);
  const dataId = `${source.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "hooks"}-${createHash("sha256").update(definition).update(resourceHash).digest("hex").slice(0, 12)}`;
  return `// Generated by omp-hooks-plus: command-hook adaptation, not a native port. Load this file in OMP.
// Disable overlapping original hooks before loading it. External script dependencies still apply.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot, registerHooks } from "./lib/adapter.js";

const definition = ${definition};
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "resources");
const pluginData = join(homedir(), ".omp", "hook-data", ${JSON.stringify(dataId)});

export default function (pi) {
  let cachedCwd;
  let settings;
  registerHooks(pi, async (ctx) => {
${activation === "project-trusted" ? "    if (!ctx.isProjectTrusted()) return undefined;\n" : ""}    if (definition.disableAllHooks || !definition.hooks) return undefined;
    if (cachedCwd !== ctx.cwd) {
      mkdirSync(pluginData, { recursive: true });
      const projectRoot = findProjectRoot(ctx.cwd);
      settings = {
        hooks: Object.fromEntries(Object.entries(definition.hooks).map(([event, groups]) => [
          event,
          groups.map(group => ({
            ...group,
            hooks: group.hooks.map(hook => ({
              ...hook,
              env: {
                ...hook.env,
                CLAUDE_PLUGIN_ROOT: pluginRoot,
                CLAUDE_PLUGIN_DATA: pluginData,
                CLAUDE_PROJECT_DIR: projectRoot,
              },
            })),
          })),
        ])),
      };
      cachedCwd = ctx.cwd;
    }
    return settings;
  }${approximate ? ", { approximations: true }" : ""});
}
`;
}

function bundledAdapter(): Uint8Array {
  if (!process.versions.bun) throw new Error("Run the converter with Bun");
  // Compile only trusted repository code, never plugin modules or build plugins.
  return execFileSync(process.execPath, [
    "build", path.join(path.dirname(fileURLToPath(import.meta.url)), "adapter.ts"),
    "--target=bun", "--format=esm", "--minify", "--packages=external",
  ], { maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function destinationPath(out: string, sourceRoot: string): string {
  const requested = path.resolve(out);
  if (within(sourceRoot, requested)) throw new Error("Output must be outside the source root");
  const parent = realpathSync(path.dirname(requested));
  const destination = path.join(parent, path.basename(requested));
  if (within(realpathSync(sourceRoot), destination)) throw new Error("Output resolves inside the source root");
  try {
    lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return destination;
    throw error;
  }
  throw new Error("Output already exists; choose a new directory");
}

/** Analyze explicitly supplied source and optionally write new OMP hook files. Never executes source hooks. */
export async function convertHooks(input: string, options: ConvertOptions = {}): Promise<ConvertResult> {
  const activation = activationPolicy(options.activation);
  if (!options.dryRun && !options.out) throw new Error("--out is required unless --dry-run is used");
  const source = await loadConversionSource(input, { sourceRoot: options.sourceRoot, approximate: options.approximate });
  const destination = options.out ? destinationPath(options.out, source.root) : undefined;
  const resources = collectResources(source, options.include ?? []);
  const sourceReference = new RegExp(`${source.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[/\\\\\\s"'\\x60;&|()<>])`);
  // Emitted hooks that cannot work are never skippable: a command that still names the
  // original source root, or one naming a CLAUDE_PLUGIN_ROOT resource that is not copied.
  let brokenEmittedHook = false;
  const copied = resources.files.map(file => file.relative);
  const missing = new Set<string>();
  for (const groups of Object.values(source.settings.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        const texts = [hook.command, ...(hook.args ?? [])];
        if (texts.some(text => sourceReference.test(text))) {
          brokenEmittedHook = true;
          source.report.diagnostics.push({ level: "unsupported", message: "A command embeds the original absolute source root; review its resource references before conversion" });
        }
        // Only literal references are checked; paths the script builds at runtime are not.
        for (const text of texts) {
          for (const [, reference] of text.matchAll(/\$\{?CLAUDE_PLUGIN_ROOT\}?\/([^\s"'`;&|()<>$]+)/g)) {
            const relative = reference.replace(/\/+$/, "");
            if (!copied.some(file => file === relative || file.startsWith(`${relative}/`))) missing.add(relative);
          }
        }
      }
    }
  }
  for (const relative of missing) {
    brokenEmittedHook = true;
    source.report.diagnostics.push({ level: "unsupported", message: `A hook command references ${relative} through CLAUDE_PLUGIN_ROOT, but that resource is not copied; add --include ${relative}` });
  }
  source.report.diagnostics.push({ level: "info", message: "Commands retain their shell and active-project working directory. External executables, services and script dependencies remain required; arbitrary script dependency closure is not verified." });
  if (source.kind === "file") {
    source.report.diagnostics.push({ level: "info", message: "File inputs do not inventory or copy the containing project: resource reports cover only --include paths, not unselected project files. Use --source-root and --include for resources referenced through CLAUDE_PLUGIN_ROOT; ordinary relative commands remain project-relative." });
  }
  const unsupported = source.report.diagnostics.some(item => item.level === "unsupported");
  const exitCode = source.report.diagnostics.some(item => item.level === "error") ? 1
    : unsupported && (!options.skipUnsupported || brokenEmittedHook) ? 2 : 0;
  const report: ConvertResult["report"] = {
    ...source.report,
    activation: { policy: activation, projectTrustRequired: activation === "project-trusted" },
    options: { skipUnsupported: options.skipUnsupported === true, approximate: options.approximate === true },
    output: {
      entrypoint: exitCode === 0 ? "index.ts" : null,
      resources: exitCode === 0 ? resources.files.map(file => file.relative) : [],
      excludedResources: resources.excluded,
      omittedResources: resources.omitted,
    },
  };
  if (options.dryRun || exitCode === 1) return { exitCode, report };

  // Build before touching the destination. mkdir is exclusive across converter invocations.
  const adapter = exitCode === 0 ? bundledAdapter() : undefined;
  assertConversionRoot(source);
  mkdirSync(destination!);
  try {
    const resourceHash = createHash("sha256");
    if (adapter) {
      mkdirSync(path.join(destination!, "lib"));
      mkdirSync(path.join(destination!, "resources"));
      writeFileSync(path.join(destination!, "lib", "adapter.js"), adapter, { flag: "wx" });
      copyFileSync(fileURLToPath(new URL("../LICENSE", import.meta.url)), path.join(destination!, "LICENSE"), constants.COPYFILE_EXCL);
      for (const resource of resources.files) {
        assertConversionRoot(source);
        const target = path.join(destination!, "resources", resource.relative);
        mkdirSync(path.dirname(target), { recursive: true });
        // Bind copying to the inventoried inode, including protection against swapped parents.
        const descriptor = openSync(resource.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let input: ReadStream | undefined;
        try {
          const stat = fstatSync(descriptor);
          if (!stat.isFile() || stat.dev !== resource.dev || stat.ino !== resource.ino) {
            throw new Error("A resource changed after inventory; retry with a stable source");
          }
          const contentHash = createHash("sha256");
          input = createReadStream(resource.source, { fd: descriptor, autoClose: true });
          await pipeline(input, new Transform({
            transform(chunk, _encoding, callback) {
              contentHash.update(chunk);
              callback(null, chunk);
            },
          }), createWriteStream(target, { flags: "wx", mode: stat.mode & 0o777 }));
          chmodSync(target, stat.mode & 0o777);
          resourceHash.update(JSON.stringify([resource.relative, stat.mode & 0o777, contentHash.digest("hex")]));
        } finally {
          if (!input) closeSync(descriptor);
        }
      }
    }
    assertConversionRoot(source);
    writeFileSync(path.join(destination!, "conversion-report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    if (adapter) {
      // Publish the discoverable entrypoint last, in one no-replace filesystem operation.
      const temporary = path.join(destination!, ".entrypoint.tmp");
      writeFileSync(temporary, generatedEntrypoint(source, resourceHash.digest("hex"), activation, options.approximate === true), { flag: "wx" });
      linkSync(temporary, path.join(destination!, "index.ts"));
      unlinkSync(temporary);
    }
  } catch (error) {
    try { rmSync(destination!, { recursive: true, force: true }); }
    catch { throw new Error(`Conversion failed; temporary output could not be removed: ${destination}`, { cause: error }); }
    throw error;
  }
  return { exitCode, report };
}

function printReport(result: ConvertResult, json: boolean, dryRun: boolean): void {
  if (json) {
    console.log(JSON.stringify(result.report, null, 2));
    return;
  }
  console.log(`Conversion level: ${result.report.conversionLevel} (not a native port)`);
  console.log(`Activation policy: ${result.report.activation.policy}; project trust ${result.report.activation.projectTrustRequired ? "required" : "not required"}`);
  for (const hook of result.report.hooks) console.log(`${hook.status}: ${hook.file}${hook.pointer} (${hook.event})`);
  for (const diagnostic of result.report.diagnostics) {
    console.log(`${diagnostic.level}: ${diagnostic.file ?? ""}${diagnostic.pointer ?? ""}${diagnostic.file ? ": " : ""}${diagnostic.message}`);
  }
  if (result.report.output.excludedResources.length) console.log(`Excluded resources: ${result.report.output.excludedResources.join(", ")}`);
  if (result.report.output.omittedResources.length) console.log(`Omitted resources (not verified unused): ${result.report.output.omittedResources.join(", ")}`);
  if (result.exitCode === 0 && result.report.hooks.some(hook => hook.status === "unsupported")) {
    console.log("Skipped unsupported declarations: they are listed above and will not run.");
  }
  console.log(result.exitCode === 0 ? dryRun ? "Supported hook inventory complete. Dry run: no output was written." : "Command-hook adaptation complete. Load index.ts only where intended; disable overlapping originals."
    : result.exitCode === 2 ? "Unsupported declarations remain. No runnable entrypoint was emitted."
    : "Invalid hook declarations. No output was written.");
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: "string" },
        "source-root": { type: "string" },
        include: { type: "string", multiple: true },
        activation: { type: "string" },
        "skip-unsupported": { type: "boolean", default: false },
        approximate: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) {
      console.log("Usage: bun run convert <plugin-directory|hooks.json|settings.json> --out <new-directory> [--source-root <directory>] [--include <relative-resource>] [--activation <enabled|project-trusted>] [--skip-unsupported] [--approximate] [--dry-run] [--json]");
    } else {
      if (positionals.length !== 1) throw new Error("Supply exactly one Claude plugin directory or hooks/settings JSON file");
      const result = await convertHooks(positionals[0], {
        out: values.out,
        sourceRoot: values["source-root"],
        include: values.include,
        dryRun: values["dry-run"],
        activation: activationPolicy(values.activation),
        skipUnsupported: values["skip-unsupported"],
        approximate: values.approximate,
      });
      printReport(result, values.json!, values["dry-run"]!);
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    console.error(`Conversion failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

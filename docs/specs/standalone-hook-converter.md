# One-shot hook conversion

## Purpose

Turn explicitly selected Claude command hooks into standalone OMP hook files, using the same adaptation code as the live `omp-hooks-plus` bridge. This is a converter script in this repository, not a new package or installation system.

## Contract

- Accept a plugin directory or explicit hooks/settings JSON file. Never discover ambient user/project settings, import plugin code, run source commands, or install dependencies during conversion.
- Inventory declared events and handlers before the compatibility parser filters them. Unknown events, handler types, fields, and scoped skill/agent/command frontmatter hooks are reported, not silently discarded or activated globally. Pi declarations are reported independently and are not imported or reused.
- Reuse `src/adapter.ts` for both live discovery and generated fixed definitions. Preserve the existing bridge's command, matcher, timeout, output, denial, input-update, and lifecycle semantics; this does not claim complete Claude Code parity.
- Bundle the adapter beside readable `index.ts`, fixed hook definitions, copied resources, and `conversion-report.json`. Generated output needs OMP/Bun and the commands' external dependencies, but not this repository, the converter, or the bridge at runtime.
- Keep ordinary relative commands relative to the active project. Set `CLAUDE_PROJECT_DIR` to that project, `CLAUDE_PLUGIN_ROOT` to generated resources, and `CLAUDE_PLUGIN_DATA` to a persistent directory under `~/.omp/hook-data/`.
- Preserve a source-wide `disableAllHooks` directive. Do not install or enable the output automatically. Operators disable overlapping original hooks before enabling it.

## Source and resource boundaries

Plugin input supports inline or referenced manifest hooks, the default `hooks/hooks.json` when the manifest has no `hooks` field, and root `settings.json`. Default and explicitly referenced scoped Markdown declarations are inspected for hooks. Non-hook settings are reported as not migrated.

Plugin resources are copied without following symlinks. File inputs copy no project tree; repeated `--include` selects source-root-relative resources. Declaration files, package manifests/lockfiles, VCS/cache directories, environment files, and common credential/key filenames are excluded and listed in the report. These exclusions are not a general secret scanner. Review the source and resource inventory before sharing output. Arbitrary script dependency closure is not verified; excluded files and external dependencies may require operator adaptation.

References and output paths must remain within their intended boundaries, including realpath checks. Output must be a new directory outside the source root with an existing parent. Existing destinations are never overwritten. The main entrypoint is published last; a process interruption can leave an incomplete directory without an entrypoint. Ordinary write failures attempt to remove newly created output.

## Result

- Exit **0**: supported inventory; conversion writes runnable output, or `--dry-run` writes nothing.
- Exit **1**: invalid input or operational failure; no successful conversion. An interrupted process or failed cleanup can leave incomplete output.
- Exit **2**: unsupported declarations/resources; normal conversion writes a report only, never a partial runnable entrypoint.

`--json` prints the structured report. Reports identify declaration locations and statuses without copying command bodies or settings values. Generated definitions and copied resources still contain executable source and must be reviewed as code.

## Non-goals

No new package, host API, deployment manager, ownership/coexistence protocol, registry discovery, native script translation, Pi semantic reuse, or new release infrastructure. See the README for invocation and the implementation notes for verification.

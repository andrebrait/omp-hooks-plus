# One-shot hook conversion

## Purpose

Turn explicitly selected Claude command hooks into standalone OMP hook files, using the same adaptation code as the live `omp-hooks-plus` bridge. This is a converter script in this repository, not a new package or installation system.

## Contract

- Accept a plugin directory or explicit hooks/settings JSON file. Never discover ambient user/project settings, import plugin code, run source commands, or install dependencies during conversion.
- Inventory declared events and handlers before the compatibility parser filters them. Unknown events, handler types, behavioral fields, and scoped skill/agent/command frontmatter hooks are reported, not silently discarded or activated globally. String `statusMessage` is recognized as presentation metadata, validated, and reported as UI not reproduced. Pi and OMP declarations are reported independently and are not imported or reused.
- Reuse `src/adapter.ts` for both live discovery and generated fixed definitions. Preserve the existing bridge's command, matcher, timeout, output, denial, input-update, and lifecycle semantics; this does not claim complete Claude Code parity.
- Bundle the adapter beside readable `index.ts`, fixed hook definitions, copied resources, and `conversion-report.json`. Generated output needs OMP/Bun and the commands' external dependencies, but not this repository, the converter, or the bridge at runtime.
- Keep ordinary relative commands relative to the active working directory. Set `CLAUDE_PROJECT_DIR` using the live bridge's project-root detection, `CLAUDE_PLUGIN_ROOT` to generated resources, and `CLAUDE_PLUGIN_DATA` to a persistent directory under `~/.omp/hook-data/`, keyed by the source name, definitions, and copied resource content/modes. Changed resources or definitions receive a distinct data directory; moving the generated directory preserves its key.
- Preserve a source-wide `disableAllHooks` directive. Do not install or enable the output automatically. Operators disable overlapping original hooks before enabling it.
- Generated activation defaults to `enabled`, preserving execution wherever the operator enables the extension, including untrusted projects. `--activation project-trusted` requires OMP's current project trust before each generated settings lookup, before cache use or persistent-data creation. Both policies preserve source-wide disabling. No source installation scope is inferred; the live bridge's discovery and trust rules remain unchanged.

## Source and resource boundaries

Plugin input supports inline or referenced manifest hooks, the default `hooks/hooks.json` when the manifest has no `hooks` field, and root `settings.json`. Default and explicitly referenced scoped Markdown declarations are inspected for hooks. Non-hook settings are reported as not migrated.

Plugin resources are copied without following symlinks. Repeated `--include` selects source-root-relative resources for either input kind: plugin input without includes copies all eligible resources, while file input without includes copies none. Selection never narrows plugin declaration inventory. Unselected resources, including symlinks, are reported as omitted without following links; selected symlinks remain unsupported, and explicit includes reject symlink ancestors and traversal. Declaration files, package manifests/lockfiles, VCS/cache directories, environment files, and common credential/key filenames are excluded and listed separately. These exclusions are not a general secret scanner. Review the source and resource inventory before sharing output. Arbitrary script dependency closure is not verified; excluded or omitted files and external dependencies may require operator adaptation.

References and output paths must remain within their intended boundaries, including realpath checks. Output must be a new directory outside the source root with an existing parent. Existing destinations are never overwritten. The main entrypoint is published last; a process interruption can leave an incomplete directory without an entrypoint. Ordinary write failures attempt to remove newly created output.

Resource copying opens without following a leaf symlink, verifies the opened file's device/inode against inventory, and streams from that descriptor. Replacing a validated path or parent with another file cannot redirect the copy. Copied bytes are hashed during streaming, without buffering entire files.

Host input/preparation coverage remains OMP's responsibility. The shared adapter consumes genuine `input` and `before_agent_start` events once; it never reconstructs missing RPC/editor dispatch, reruns prompt hooks per provider request, or dispatches synthetic continuations as user input. Hook text remains content, including slash-like text and arguments. After shutdown, SessionEnd commands still execute, but reminders and follow-up turns are suppressed.

The shared executor resolves local `Read` aliases using OMP's literal-aware selector and path helpers. Claude `file_path` names the filesystem target; the original OMP `path` retains selectors. Literal colon-containing filenames win over selector interpretation. Web/internal URLs remain opaque and do not receive a synthesized filesystem alias; explicit caller-supplied aliases are preserved. `Edit` and `Write` paths retain their existing literal semantics. This behavior applies to the automatic bridge and generated output.

## Result

- Exit **0**: supported inventory; conversion writes runnable output, or `--dry-run` writes nothing.
- Exit **1**: invalid input or operational failure; no successful conversion. An interrupted process or failed cleanup can leave incomplete output.
- Exit **2**: unsupported declarations/resources; normal conversion writes a report only, never a partial runnable entrypoint.

`--json` prints the structured report. Reports identify declaration locations and statuses without copying command bodies or settings values. Additive schema-version-1 fields identify `conversionLevel: "command-hook-adaptation"`, detected `nativeBindings` with `status: "not-reused"`, effective `activation`, and `output.omittedResources`. Successful adaptation does not reproduce native commands, recovery tools, provider integration, system-prompt ownership, or native session state. Generated definitions and copied resources still contain executable source and must be reviewed as code.

## Non-goals

No new package, host API, deployment manager, ownership/coexistence protocol, registry discovery, native script translation, Pi semantic reuse, or new release infrastructure. See the README for invocation and the implementation notes for verification.

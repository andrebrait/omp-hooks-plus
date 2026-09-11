# Standalone hook converter

Status: baseline approved by the user on 2026-09-11; the user subsequently selected either-or deployment instead of simultaneous coexistence. This revision applies that decision; the updated document and implementation plan await review.

## Objective

Build a deterministic Claude-to-OMP hook converter, with optional skill-assisted native TypeScript ports. Existing pi bindings are reusable implementations, not evidence that the Claude plugin's behavior is completely covered.

The converter owns the reusable implementation. `omp-hooks-plus` consumes it as a library instead of becoming a dependency of generated packages. Users can either keep automatic compatibility through `omp-hooks-plus` or generate an OMP package that runs without it.

## Scope and invariants

- Source support is Claude hooks and Claude plugins, with accompanying pi bindings as an optional input. Codex, Copilot, Grok, Cursor, and Antigravity adapters are outside this change.
- Inventory every source hook declaration before applying capability filters. Include plugin manifests, referenced/default hook files, explicitly supplied settings, and hook declarations in the plugin's skills and agents. Preserve their activation scope; frontmatter hooks are not global hooks.
- Account for Claude behavior missing from pi, even when the plugin already has a usable pi extension.
- Conversion performs no model calls, imports of plugin code, hook execution, package installation, or network requests. Runtime execution and explicitly authorized behavioral verification are separate operations.
- Preserve original hook logic when deterministic adaptation is sufficient. Native TypeScript rewrites are optional skill-assisted work, not a prerequisite for using a complete deterministic conversion.
- Each applicable source behavior has one selected implementation. Equivalent event names, command strings, or output text alone do not establish cross-format equivalence.
- Deployment is either-or for each source plugin or settings input: use the automatic bridge or its generated OMP replacement, never both for overlapping behavior. Users explicitly disable the overlapping original bindings before enabling a replacement.
- In automatic adapter mode, existing `omp-hooks-plus` trust, source-enable, scope, environment-isolation, and disable controls remain authoritative. Standalone packages use the explicit activation policy below; converting a source does not install or authorize its output.

## Architecture and ownership

Keep development in this repository so the library extraction and its existing consumer can change atomically. Introduce one independently consumable package at `packages/converter/`, using `omp-hook-converter` as its package and executable name. Keep the repository's root package as `omp-hooks-plus`.

| Module | Responsibility | Consumers |
| --- | --- | --- |
| Converter library | Source inventory, capability analysis, coverage decisions, validation, deterministic generation | CLI, companion skill through CLI, `omp-hooks-plus` |
| Converter runtime | OMP event adaptation, script execution, result interpretation, session-local context delivery | Generated bindings, `omp-hooks-plus` |
| CLI | Explicit filesystem inputs, output materialization, machine-readable diagnostics | Humans and companion skill |
| `omp-hooks-plus` adapter | Existing OMP discovery, trust/enable policy, automatic activation, doctor integration | Existing plugin users |
| Companion skill | Resolve uncertain correspondence, adapt pi code, port script logic, verify behavior | Users requesting native ports or completion of unresolved conversions |

The library exposes analysis and generation separately from the OMP-dependent runtime. `omp-hooks-plus` imports these interfaces; it does not spawn the CLI per event. The CLI bundles the required runtime implementation into generated output. Shared behavior is moved, not copied into a second maintained implementation.

Reuse the current parser, executor, event adapters, and relevant tests where their contracts are correct. `src/config.ts` currently mixes OMP discovery with source parsing; separate those responsibilities. Its nine-event filter is not the new inventory interface. `src/executor.ts`, `src/hooks/`, and the reusable parts of `src/hook-context.ts` supply the runtime starting point, not an assumption of complete Claude parity.

Reusing `src/hook-context.ts` requires moving its module-scoped `_injectBuffer` and `_injectedThisTurn` into session-local runtime state. That correction is part of the migration, not a preserved compatibility behavior: OMP can reuse one imported module across root-session and subagent extension instances. Verify that identical context delivered in one session does not suppress delivery in another, and that pending timers/buffers cannot deliver into a different or disposed session.

Source-language adapters for additional vendors, a generic compiler framework, automatic plugin installation, and changes to OMP core are not part of this design.

## Development conventions

Use TypeScript ESM, Bun, and Node-compatible standard-library facilities, matching the existing project. Keep converter implementation in `packages/converter/src/`, converter behavioral tests in `packages/converter/test/`, and existing consumer regression tests under `test/`. The root validation commands must exercise both packages. Public types use the repository's explicit unions and double-quoted strings; for example:

```ts
export type CoverageState =
  | "adapted"
  | "covered"
  | "needs-review"
  | "target-gap";
```

Always validate external input, preserve source provenance, and reuse the shared implementation. Ask before adding dependencies, changing CI or OMP core, or broadening source-vendor support. Never execute source code during conversion, weaken existing validation gates, or present unverified parity as established behavior.

## External interface

The following commands are the proposed public interface, not commands already implemented in this repository:

```sh
omp-hook-converter inspect ./plugin --scope project --json
omp-hook-converter convert ./plugin --scope project --out ./converted-plugin
omp-hook-converter check ./converted-plugin --source ./plugin --json
omp-hook-converter convert ./.claude/settings.json --source-root . --scope project --name my-project-hooks --out ../converted-project-hooks
```

Each source argument can name a plugin directory or a Claude hook/settings JSON file. Inspection/conversion requires `--scope user|project|local` for both input kinds: a directory path does not reveal the original registry's installation scope, and the converter must not discover ambient registries or infer scope from path names. Library callers such as the automatic adapter may supply scope from their already-authorized discovery result. File inputs additionally require `--source-root <directory>`; file-input conversion also requires `--name <valid-package-name>`. The JSON file must be inside that explicit source root. These inputs avoid guessing that `.claude/` is the project working directory or deriving package identity from an absolute path. `check` retains the recorded scope/name for either source kind and accepts `--source-root` when validating relocated file sources.

The source root defines analysis/resource containment, not runtime working directory. Hook commands still run in the active OMP project directory. Classify relative command/resource paths by their original contract: project-relative paths remain project-relative; bundled plugin resources resolve under the generated package root. A resource relocation that cannot be established without changing behavior is `needs-review`, not a reason to change the hook's working directory silently.

`inspect` and `convert` accept `--coverage <report>` to reuse reviewed decisions from an earlier artifact. Validate that report, its source fingerprints, and its referenced binding/resource files before reuse; bind artifact-relative paths to the report's directory and enforce containment there independently of the source root. Stale decisions return to `needs-review`. A coverage file is user-supplied evidence, not permission to execute its code or proof that its behavioral claims are true.

All commands accept `--target <profile>` to select a bundled OMP capability profile; omission selects the converter release's documented default. Unknown profiles are invalid input. Reports record the selected profile explicitly, and runtime activation checks the required host capabilities. `check` uses the artifact's recorded profile unless an explicit target requests revalidation.

- `inspect` returns the complete inventory, candidate pi bindings, capability decisions, and diagnostics. It does not write files.
- `convert` writes a new output directory, including generated bindings and the coverage report. It rejects any existing output destination and any output nested inside the source root. It leaves the source untouched.
- Materialize into a temporary sibling directory, validate the complete or draft artifact there, then publish it as the requested destination. Serialize competing converter invocations for that destination and refuse publication if the destination has appeared; never replace another writer's files. Exit code `1` leaves the requested destination unchanged and removes temporary output. If cleanup itself fails, report the residual temporary path; an interrupted process may leave temporary staging data, never a published success-looking partial package.
- `check` validates the artifact, source fingerprints, coverage decisions, and target compatibility. It does not execute source or generated code and does not claim behavioral equivalence.
- All three use the same library analysis. Human-readable output and JSON output describe the same decisions.
- Exit code `0` means the requested operation completed with no unresolved conversion requirements; `2` means analysis completed but coverage, target compatibility, or conflicting implementation selections within the artifact remain; `1` means invalid input, invalid artifact, or an operational failure. Exit `0` does not certify the user's installed extension configuration.
- A well-formed but incomplete conversion may emit its report and draft source with exit code `2`. Such output is non-installable: no `package.json`, OMP/pi manifest, recognized extension/hook entrypoints, or runnable source tree. Store generated source as inert `.txt` files referenced by the report. `check` continues to return `2` while requirements remain unresolved; after review, `convert --coverage <draft-report>` can emit a complete package into a new destination. There is no runtime-only draft guard that could first shadow an existing pi manifest.

## Inventory, capability decisions, and evidence

Give each declaration a stable source locator consisting of source kind, source-root-relative file, and JSON pointer or frontmatter location. Retain the original event, matcher, handler fields, declaration order, and activation scope in the internal inventory. Reports expose provenance and field descriptors/fingerprints rather than unredacted arbitrary field values; unknown fields remain identifiable without copying their potentially secret contents into JSON, diagnostics, or draft text. The skill reads original values from the explicitly supplied source when authorized, not from a secret-bearing coverage report. Relative source locators are independent of the user's absolute installation directory.

Fingerprint declaration content and the local files on which a coverage decision depends. A correspondence involving pi code includes the relevant TypeScript and local import dependencies; a script-backed decision includes its scripts and known local resources. Unresolved dynamic dependencies remain visible. A declaration locator is not a freshness check or a runtime deduplication key.

For pi/native package imports, include the relevant dependency manifest entries, resolved versions, and lockfile/integrity metadata in the decision fingerprint. Mutable local/workspace dependencies also require fingerprints of the files used by the binding. Missing or unfrozen dependency resolution remains `needs-review`; a package upgrade cannot inherit an old `covered` verdict just because the importing TypeScript file is unchanged.

The report records the converter version, artifact schema version, target OMP capability profile, source locators and fingerprints, selected implementation, evidence for that selection, and diagnostics. Also record generated/native binding and bundled-resource fingerprints so artifact edits invalidate prior verification evidence. The skill can update a decision after verification; it cannot preserve the old evidence as current merely by changing a checksum.

Reports include structured activation requirements: deployment policy (explicit standalone OMP activation or existing automatic bridge controls), required host capabilities/controls, source scope and disable directives, the either-or deployment requirement, and known original entrypoints to disable when installing the replacement. These describe requirements and migration guidance, not a cached authorization decision or proof that conflicting installations are disabled. Runtime still checks its own required target capabilities and controls; metadata cannot grant trust or enable a disabled source.

The converter release bundles a versioned Claude contract snapshot, including recognized event/type/field schemas and semantics, rather than reading live documentation. The first snapshot is identified as `claude-hooks-2026-09-11`; its checked-in content digest and identifier are recorded as `sourceContract` in every coverage report. Updating that snapshot is an explicit reviewed source-contract change. Inventory still enumerates all actual source declarations, including unknown keys outside the snapshot; the snapshot classifies them rather than filtering them away.

Use these coverage states:

| State | Meaning |
| --- | --- |
| `adapted` | A documented deterministic rule preserves the declaration's required contract through an OMP binding. |
| `covered` | A selected pi-derived or native binding implements the declaration's required behavior, with explicit supporting correspondence and verification evidence. |
| `needs-review` | Correspondence, dependencies, fields, lifecycle semantics, or implementation support are unresolved. |
| `target-gap` | The required contract is unavailable in the selected OMP capability profile, with an explanation of the missing capability. |

Malformed input is an error, not a coverage state. A feature the converter has not implemented is `needs-review`, not `target-gap`. Unknown events, handler types, and fields are retained and diagnosed rather than discarded.

The implementation must ship an explicit event/handler capability table. Each supported rule names its OMP event, required input fields, activation conditions, output effects, and lifecycle limitations. Match the full contract, not names alone: an observational approval event does not necessarily implement Claude's ability to decide a permission request. Assess `command`, `http`, `prompt`, `agent`, and `mcp_tool` declarations independently. Deterministic conversion does not imply that the original hook's runtime behavior is model-free.

The existing nine command-hook events are the extraction baseline, not the coverage ceiling. Audit the remaining Claude events against the selected OMP target and implement additional mappings whose full contracts are available. Unsupported scope or semantics must remain explicit even for a familiar event.

## Reusing pi without losing Claude behavior

1. Discover declared pi extension entrypoints and inspect their source without importing it.
2. Establish correspondence only through recognized transformations or an explicit reviewed coverage record bound to current source fingerprints.
3. Retain every Claude declaration in the report, including declarations already covered by pi and declarations absent from pi.
4. Select pi-derived implementations for established coverage, and generate Claude adapters for the remaining supported behavior.
5. Treat uncertain overlap as a conflict requiring review, rather than running both implementations or suppressing the Claude declaration.

One Claude hook can depend on several pi event handlers. One pi handler can implement several source hooks or mix hook behavior with unrelated functionality. The coverage record must identify that relationship; an event-wide or plugin-wide exclusion is insufficient.

A partial correspondence does not mark an entire declaration covered. A split is valid only when its activation domains are explicitly disjoint and their union covers the original domain. If that cannot be established, keep the original implementation as the selected owner or leave the conflicting conversion inactive until the skill resolves it. A native port replaces the selected script-backed implementation; it is not added beside it.

Preserve unrelated pi functionality such as resource discovery, commands, tools, and state needed by retained handlers. Replacing an entire pi extension requires accounting for those behaviors as well. Do not apply an import-name substitution and label arbitrary pi code ported.

## Either-or deployment and runtime lifecycle

For each source plugin or settings input, choose one deployment route:

- **Automatic:** `omp-hooks-plus` discovers and adapts the original Claude declarations using its existing controls.
- **Standalone:** the user explicitly installs/enables the generated OMP package and disables overlapping automatic/original pi bindings.

This is an operator-managed choice, not a runtime election. There is no shared ownership protocol, participant roster, initialization handshake, cross-package suppression, automatic fallback, or OMP-core activation-API prerequisite. Neither deployment discovers the other and attempts to take over its work.

Before enabling a replacement, disable the original source through existing controls, including independently selected pi entrypoints whose behavior was incorporated into the generated package. If existing controls cannot exclude that source from the bridge, disable the bridge; do not add a new per-source exclusion system as part of this converter. Reload or restart OMP so callbacks from the old deployment are no longer active, then enable the replacement. Multiple installations with overlapping behavior are unsupported and may execute twice; the converter does not promise to detect every such configuration.

Conversion does not change installed extension settings. Its report identifies known source entrypoints and gives the either-or installation requirement, but `inspect`, `convert`, and `check` do not certify that the operator disabled them. A complete artifact can therefore pass offline checking without querying a live extension roster.

If standalone initialization or execution fails, report the actual failure; do not activate the bridge or re-enable an original binding. Rollback is explicit: disable the generated package, reload or restart to clear its callbacks, then restore the original deployment. Do not replay the failed occurrence automatically or claim to undo external effects that already began.

Implementation selection still matters **inside one generated artifact**. A reviewed pi/native binding replaces the corresponding script-backed behavior rather than running beside it. Uncertain overlap inside that artifact remains unresolved. Independent source plugins with identical command strings remain independent, and legitimate repeated event occurrences still execute.

All runtime state remains isolated between sessions and subagents and resets on reload/disposal. Context buffers, pending deliveries, and content deduplication must not be process-global. Async completions and timers cannot deliver into a disposed runtime instance. This requires ordinary local lifecycle handling, not a cross-package coordination bus.

### Activation policy by deployment mode

- **Automatic adapter:** OMP owns discovery and extension enable state. `omp-hooks-plus` applies its existing trust, Claude-provider opt-ins, trust-gated user/project/local source selection, source enable state, and `disableAllHooks` semantics before supplying eligible hooks to the shared runtime. Selected hook groups are concatenated in the existing source order; do not reinterpret that as project settings replacing user hooks. Conversion does not override those controls.
- **Standalone package:** the user explicitly installs/enables the generated package through OMP after disabling overlapping original bindings. OMP's normal extension loading, scope, trust, and enable controls apply; the artifact neither edits those controls nor independently discovers ambient Claude settings/plugins. Source disable directives and scoped activation conditions present in the conversion input are preserved in the artifact. Subsequent changes to the original Claude settings do not dynamically govern this separately installed package; disable it through OMP or reconvert. Report this distinction prominently.
- **Both modes:** resolve runtime root/data environment values per plugin instance, preserve the artifact's declared activation scope, and validate its target/coverage. Standalone activation is not evidence that an automatic source is trusted or enabled. If a required host capability or scope/trust control is unavailable, diagnose that specific unsupported contract rather than bypassing it or restoring the removed global activation-snapshot requirement.

Installation enablement and root scope belong to OMP's existing plugin loader and the documented installation procedure, not a new runtime roster API. A supported project artifact is installed through the project root; a user artifact through the user root. The converter records these requirements but does not certify how the operator installed a package. Runtime policy checks available public context controls such as project trust before hook effects; it must not invent an installation-scope accessor. A target profile needs evidence that its prescribed loading procedure preserves each claimed scope.

## Generated artifact and filesystem safety

A complete plugin conversion produces:

- A valid package manifest with an explicit `omp.extensions` entrypoint and preserved non-hook plugin declarations required by the result.
- Generated OMP TypeScript bindings and a bundled compatibility runtime where original scripts remain selected.
- Original scripts and required local resources with a relocatable relative layout.
- `omp-hook-coverage.json`, containing coverage, fingerprints, target information, activation requirements, and evidence references.

A complete file-input conversion produces the same runtime/report structure, with a new ESM package manifest using the explicit `--name`, version `0.0.0`, `private: true`, and its generated OMP entrypoint. It has no inferred pi resource declarations. Record the selected source scope and retain file-level disable directives: `disableAllHooks: true` yields a disabled artifact, not active hooks. Project artifacts require project-scoped installation rather than user-wide installation.

Claude `local` scope is not automatically equivalent to ordinary project scope. A local input requires a verified target procedure/control preserving its personal, project-local activation; merely installing under a shared project root is insufficient. The inspected OMP plugin loader declares user/project roots, and this plan has not proved a local-equivalent mapping. Local inputs therefore remain `needs-review` with non-installable draft output until that mapping is demonstrated. If the target audit establishes that the required control is unavailable, classify it as `target-gap`; never silently convert local to project or user scope. This limitation does not block verified user/project conversions or require a new global host API.

An `omp` manifest can replace the entire `pi` manifest in OMP's package selection, not merely its extensions field. Carry over required skill and other resource declarations explicitly. Existing OMP bindings are input to reconciliation; do not overwrite or duplicate them implicitly.

Self-contained means no runtime dependency on the installed `omp-hooks-plus` package or the original source directory. It does not eliminate script interpreters, external commands, services, or plugin dependencies. Report those requirements. Dynamic dependency closure that cannot be determined must remain `needs-review`; do not claim portability based on a guessed file list.

Resolve runtime plugin-root environment values from the installed output location. Preserve source command strings and pass environment variables as environment variables, not interpolated shell text. A command or dependency embedding the original absolute source root is not relocatable: leave it `needs-review` unless an explicit reviewed transformation replaces only a proven resource reference without changing behavior. Do not perform blind textual path replacement. Plugin data belongs in the appropriate writable runtime data location, not the generated package or the original development directory.

Validate manifests, configuration, coverage records, and paths at their input interfaces. Reject lexical and symlink escapes from the source root, unsafe output paths, and conflicting generated file names. Generation must not read ambient user secrets or copy VCS metadata, installed dependency caches, or secret-bearing configuration into output. Required resources excluded for safety are reported as unresolved rather than silently omitted. Resolve these with an explicit reviewed resource selection before claiming a complete package.

For identical source bytes, reviewed decisions, converter version, and target profile, generated file bytes and report ordering must be identical. Exclude wall-clock timestamps, absolute source paths, and nondeterministic traversal order. Re-conversion writes a separate output directory; it does not overwrite skill-authored changes.

## Companion skill contract

The companion skill is optional and invokes the CLI rather than implementing another parser or event map. Its workflow is:

1. Inspect the source and read every unresolved report entry and relevant original implementation.
2. Decide whether to retain a script, adapt pi code, or write a native OMP implementation.
3. Preserve observable behavior: matcher and scope applicability, blocking/approval, input changes, context placement, side effects, errors, async behavior, and lifecycle ordering.
4. Exercise corresponding original and converted behavior in an explicitly authorized, isolated environment. Record the exact scenarios, commands, observations, and unverified limits.
5. Update source-bound coverage and replacement decisions, then run the deterministic artifact check.

Verification can execute arbitrary source logic and is not part of inspection or conversion. Do not send source to a model or execute it merely because the CLI discovered it. Existing host authorization and the user's requested skill invocation govern those actions.

Behavioral comparisons must observe effects, not just equal return shapes, import wiring, or compilation. A passing finite set of scenarios is evidence for those scenarios, not proof of equivalence for arbitrary programs. Cases that cannot be checked remain explicit. When all active behavior is natively ported, remove unused generated script adapters and their dependencies while retaining provenance and verification evidence.

## Compatibility and migration

The current root package declares OMP `>=18.1.16`. Preserve its supported existing behavior during extraction. Broader generated mappings and activation guarantees apply only to capability profiles that have been exercised; do not infer support for every version from that existing minimum.

The initial target for implementation verification is the available OMP integration source snapshot identified below, whose package version is `18.1.17`. Record both revision and capabilities: the version string alone does not establish that a published release contains downstream integration patches. Unsupported host/profile combinations receive a diagnostic before activation.

Build the converter library and CLI first, then migrate `omp-hooks-plus` to the same implementation, then add the companion skill. The migration removes superseded parsing/execution copies from the plugin. It preserves OMP-owned discovery, trust-gated source selection and concatenation order, opt-ins, disable behavior, plugin environment isolation, and diagnostics rather than creating a second discovery authority.

Generated artifacts must document the either-or installation and rollback steps, including disabling overlapping original pi entrypoints and bridge sources. This applies regardless of bridge version: upgrading `omp-hooks-plus` does not authorize simultaneous overlapping deployment. No bridge upgrade is required merely to run an independent generated package with the bridge disabled.

## Acceptance criteria and verification

| ID | Observable acceptance condition |
| --- | --- |
| AC-01 | A Claude-only command plugin converts into an OMP package that still exhibits the original supported behavior after moving the output and making the original source root unavailable, without `omp-hooks-plus` installed. |
| AC-02 | A plugin with pi coverage plus a Claude hook absent from pi retains both behaviors, with one selected implementation for each. |
| AC-03 | A source works through the automatic bridge alone and through its generated replacement alone. Explicitly disabling the first deployment and reloading before enabling the second preserves the observable behavior, with one execution per applicable occurrence in each configuration. |
| AC-04 | Generated output identifies known overlapping original pi entrypoints and documents disabling them before enabling the replacement. Offline checking does not claim to verify the user's active installation, and generation does not edit that installation. |
| AC-05 | Changing a declaration, relevant script/resource, reviewed pi implementation, or resolved imported dependency invalidates affected coverage; moving an unchanged plugin does not. |
| AC-06 | A failed generated initialization is reported without activating the bridge, re-enabling original bindings, or editing their settings. Explicit disable/reload/restore rollback returns to the original deployment; there is no automatic fallback or replay. |
| AC-07 | Skills, commands, tools, lifecycle state, and other unrelated functionality survive pi-to-OMP manifest/entrypoint replacement. |
| AC-08 | Unknown and malformed declarations, unavailable target contracts, unimplemented converter support, and unresolved dependencies remain distinguishable; none disappears through the existing nine-event filter. |
| AC-09 | Inspection, conversion, and checking do not execute plugin code; path escapes and unsafe output/resource selections are rejected without source mutation. |
| AC-10 | Identical inputs produce byte-identical outputs. An existing destination is unchanged on rejection; an operational failure publishes no partial package. Exit-2 drafts expose no discoverable OMP/pi entrypoints or package manifest and cannot shadow the original pi selection. |
| AC-11 | Independent plugins and legitimate repeated events are not collapsed. Context-delivery state is isolated across concurrent sessions and subagents: identical context can be delivered independently, and pending timers/buffers do not leak across reload or disposal. |
| AC-12 | At least one skill-assisted native port has recorded runnable comparisons for a `PreToolUse` deny case and a corresponding non-denied case: the denied tool does not execute, the non-denied tool does, and both match the original hook's observable outcome. Deterministic checking does not overstate that evidence. |
| AC-13 | Existing supported `omp-hooks-plus` behavior remains covered by its behavioral tests after the clean cutover, including trust/disable policy, environment isolation, context delivery, compaction, and stop-loop handling. |
| AC-14 | The event/handler capability table assesses Claude behavior independently of pi coverage, includes all inventoried events/types, and distinguishes true target gaps from missing converter implementation. |
| AC-15 | File-input conversion uses the explicit package name, source root, and scope; a project-relative script is not misresolved under `.claude/`; command working directory and disable directives are preserved. Project inputs require project installation. Local inputs produce non-installable exit-2 output unless a verified local-equivalent activation mapping exists; neither local nor project scope is silently widened. |

Use the existing Bun test conventions. Keep regression tests for plausible failures in selection, activation, safety, lifecycle behavior, and source freshness. Use temporary end-to-end scenarios for routine generation and CLI proof. Exercise actual generated entrypoints and runtime effects, not only source text or a mocked compiler result.

Repository validation commands remain `bun test`, `bun run typecheck`, and `bun run build`; implementation must extend their scope to include the converter without weakening existing checks. No executable behavior is changed by this specification itself.

## Evidence and design constraints

Inspected source and a temporary runtime probe establish the following, not implementation of the proposed converter:

- `src/config.ts` filters plugin events through the existing hook-key set and loads plugin-specific environments; inventory must precede that filter.
- `src/hooks/shared.ts` deduplicates collected commands by command, arguments, and environment. This is not semantic deduplication against pi TypeScript.
- The installed Superpowers 6.3.0 pi extension combines resource discovery, session/compaction state, and context insertion; its Claude hook manifest declares a `SessionStart` command. This is a concrete example of why correspondence is not a one-event rename.
- OMP `packages/coding-agent/src/extensibility/plugins/loader.ts` selects `omp` before `pi`, and `packages/coding-agent/src/extensibility/extensions/loader.ts` discovers explicitly configured extension paths independently.
- A temporary probe using OMP's real `resolvePluginExtensionPaths` and `discoverExtensionPaths` passed: adding an `omp` declaration selected its entrypoint instead of pi; separately configuring the pi file selected both paths; discovery did not execute either source module. The probe removed its temporary files.
- An earlier real-host activation-surface probe confirmed that extension callbacks lack a complete selected-roster/init-outcome snapshot. The user subsequently chose either-or deployment, so that missing interface is no longer a prerequisite. The converter does not implement simultaneous coexistence or request a new host activation API. See the [implementation plan](../plans/standalone-hook-converter.md).

OMP evidence revision: `andrebrait/oh-my-pi` branch `integration`, commit `acef0cdc9ca35468ee862cc78061860323b2eabb`, package version `18.1.17`. These are evidence coordinates, not a promise that all releases with that version have identical capabilities.

Primary source reference: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), consulted 2026-09-11. Implementers must capture its event/handler contracts in the versioned snapshot described above and compare them with the selected OMP interface. Inspection and conversion use that bundled snapshot offline; neither the live page nor the current bridge's supported subset is a runtime inventory filter.

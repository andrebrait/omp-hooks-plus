# Standalone hook converter

Status: architecture approved; written specification awaiting review.

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
- In automatic adapter mode, existing `omp-hooks-plus` trust, source-enable, scope, environment-isolation, and disable controls remain authoritative. Standalone packages use the explicit activation policy below; converting a source does not install or authorize its output.

## Architecture and ownership

Keep development in this repository so the library extraction and its existing consumer can change atomically. Introduce one independently consumable package at `packages/converter/`, using `omp-hook-converter` as its package and executable name. Keep the repository's root package as `omp-hooks-plus`.

| Module | Responsibility | Consumers |
| --- | --- | --- |
| Converter library | Source inventory, capability analysis, coverage decisions, validation, deterministic generation | CLI, companion skill through CLI, `omp-hooks-plus` |
| Converter runtime | OMP event adaptation, script execution, result interpretation, session-local ownership coordination | Generated bindings, `omp-hooks-plus` |
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
omp-hook-converter inspect ./plugin --json
omp-hook-converter convert ./plugin --out ./converted-plugin
omp-hook-converter check ./converted-plugin --source ./plugin --json
```

Each source argument can name a plugin directory or a Claude hook/settings JSON file. The containing directory is the source root for a file input. All referenced files remain subject to source-root containment checks.

`inspect` and `convert` accept `--coverage <report>` to reuse reviewed decisions from an earlier artifact. Validate that report, its source fingerprints, and its referenced binding/resource files before reuse; bind artifact-relative paths to the report's directory and enforce containment there independently of the source root. Stale decisions return to `needs-review`. A coverage file is user-supplied evidence, not permission to execute its code or proof that its behavioral claims are true.

All commands accept `--target <profile>` to select a bundled OMP capability profile; omission selects the converter release's documented default. Unknown profiles are invalid input. Reports record the selected profile explicitly, and runtime activation checks the required host capabilities. `check` uses the artifact's recorded profile unless an explicit target requests revalidation.

- `inspect` returns the complete inventory, candidate pi bindings, capability decisions, and diagnostics. It does not write files.
- `convert` writes a new output directory, including generated bindings and the coverage report. It rejects any existing output destination and any output nested inside the source root. It leaves the source untouched.
- Materialize into a temporary sibling directory, validate the complete or draft artifact there, then publish it as the requested destination. Serialize competing converter invocations for that destination and refuse publication if the destination has appeared; never replace another writer's files. Exit code `1` leaves the requested destination unchanged and removes temporary output. If cleanup itself fails, report the residual temporary path; an interrupted process may leave temporary staging data, never a published success-looking partial package.
- `check` validates the artifact, source fingerprints, coverage decisions, and target compatibility. It does not execute source or generated code and does not claim behavioral equivalence.
- All three use the same library analysis. Human-readable output and JSON output describe the same decisions.
- Exit code `0` means the requested operation completed with no unresolved conversion requirements; `2` means analysis completed but coverage, target compatibility, or activation conflicts remain; `1` means invalid input, invalid artifact, or an operational failure.
- A well-formed but incomplete conversion may emit its report and draft source with exit code `2`. Such output is non-installable: no `package.json`, OMP/pi manifest, recognized extension/hook entrypoints, or runnable source tree. Store generated source as inert `.txt` files referenced by the report. `check` continues to return `2` while requirements remain unresolved; after review, `convert --coverage <draft-report>` can emit a complete package into a new destination. There is no runtime-only draft guard that could first shadow an existing pi manifest.

## Inventory, capability decisions, and evidence

Give each declaration a stable source locator consisting of source kind, source-root-relative file, and JSON pointer or frontmatter location. Retain the original event, matcher, handler fields, declaration order, and activation scope. Relative source locators are independent of the user's absolute installation directory.

Fingerprint declaration content and the local files on which a coverage decision depends. A correspondence involving pi code includes the relevant TypeScript and local import dependencies; a script-backed decision includes its scripts and known local resources. Unresolved dynamic dependencies remain visible. A declaration locator is not a freshness check or a runtime deduplication key.

The report records the converter version, artifact schema version, target OMP capability profile, source locators and fingerprints, selected implementation, evidence for that selection, and diagnostics. Also record generated/native binding and bundled-resource fingerprints so artifact edits invalidate prior verification evidence. The skill can update a decision after verification; it cannot preserve the old evidence as current merely by changing a checksum.

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

## Runtime ownership and coexistence

Generated bindings and `omp-hooks-plus` use the same versioned, session-local ownership protocol. Both generated and automatic dispatch remain gated until the bounded handshake below completes. Ready generated owners take precedence over automatic fallback only for their validated coverage. Two incompatible generated owners produce a conflict; discovery order does not choose a winner.

A file on disk, a manifest entry, or a coverage assertion does not prove that a binding initialized. Missing or failed generated bindings must not suppress the only working original hook. Stale coverage cannot suppress a source hook. Conversely, when a conflicting handler may already be active and ownership cannot be established, block the converter-managed conflicting path and report the activation conflict instead of guessing or blindly activating a fallback.

The host's selected extension paths and successful cooperative initialization are separate evidence. Before activation, check for independently selected original pi entrypoints that overlap a generated replacement. If the public host interface cannot establish a safe activation decision, report that limitation and require the conflicting configuration to be corrected; do not manipulate OMP's private handler registry. Any needed OMP-core change requires a separate proposal.

Ownership identifies the originating plugin instance and source scope, not just a plugin display name or hook text. Independent plugins with identical command strings remain independent. Repeated legitimate event occurrences still execute; ownership resolves duplicate implementations, not all repeated calls. Keep source-native identical-handler deduplication distinct from cross-format ownership and context delivery.

Session state must be isolated between concurrent sessions and subagents and reset on reload/disposal. Do not coordinate through an unscoped process-global content set or depend on a single physical copy of the runtime library: generated packages bundle their own code. OMP's shared extension event bus is the candidate public coordination seam; the implementation must prove registration, failure, reload, and session-isolation behavior through that seam before relying on it.

### Ownership handshake contract

The runtime receives an activation snapshot from its OMP adapter: an opaque host-session identity, a reload generation, selected relevant extension identities, and confirmed initialization outcomes. These are requirements on the adapter interface, not claims that OMP already exposes a single snapshot method. The selected target must prove it can obtain a complete snapshot through public host interfaces. If it cannot, mixed-source activation is unsupported and produces an activation conflict instead of an inferred empty roster. The first implementation checkpoint must exercise this seam before broader conversion work proceeds.

Use the stable event-bus channel `omp-hook-converter:ownership`. Every packet carries `protocol: 1`, `kind`, `sessionKey`, `generation`, `requestId`, and `participantId`. Session/generation values come from the activation snapshot, not the working directory, transcript filename, or an independently generated token in each bundle. Runtime tokens are not serialized into deterministic artifacts.

1. **Prepare:** each cooperative factory registers its control listener before asynchronous initialization. Hook callbacks remain inert. It becomes `ready` only after initialization succeeds and coverage/source checks pass, or `unavailable` only when no owned callback can execute. A failed partial initialization is `unknown` until its callbacks are disabled. Registration itself never claims coverage.
2. **Query:** after the host's factory-binding barrier, the first applicable dispatch broadcasts `kind: "query"` with the selected participant roster and its digest. All dispatchers wait on the same session/generation decision; independently initiated queries must carry an identical roster and use the same selection rules.
3. **Collect:** participants broadcast `kind: "state"` with terminal state (`ready`, `unavailable`, or `unknown`), supported protocol majors, and claims. A claim contains the originating plugin-instance/scope identity, declaration locator, source fingerprint, implementation fingerprint, and automatic/generated role. Receivers validate identity against the host snapshot and retain packets only for their exact session/generation/request. Absence is not an `unavailable` response; only a host-confirmed failure with no active callbacks can substitute for an absent participant.
4. **Seal:** derive the owner map deterministically: one valid generated claim wins over automatic fallback; multiple generated claims conflict; automatic fallback is eligible only after every overlapping selected replacement is confirmed unavailable. Broadcast `kind: "seal"` containing a digest of the roster, terminal states, and owner map. Each ready participant must return `kind: "ack"` for the same digest before either path can execute.
5. **Deadline:** the total query-to-ack deadline is 1,000 milliseconds. Missing responses, unknown state, roster/digest disagreement, or an unsupported protocol major produce an activation conflict and keep every conflicting converter-managed path disabled. There is no timeout-to-fallback behavior. An incompatible peer answers with its supported majors on the same channel; silence is also a conflict, never evidence of compatibility.
6. **Late changes and disposal:** ownership is sealed for that generation. Late registration, claim changes, or a late response cannot enable callbacks; broadcast `kind: "invalidate"`, stop new conflicting dispatches, and require a fresh host generation/handshake. On reload/disposal, disable callbacks, clear pending deadlines/state, and unsubscribe listeners. Packets from old generations are ignored. An already-started external side effect cannot be undone; late participants remain disabled rather than replaying that occurrence.

The bus does not await asynchronous listeners. Protocol callbacks must explicitly send state/ack packets after their work finishes; the initiator waits for those packets, not for `emit()` to return. The handshake is an activation protocol, not an exactly-once guarantee across process crashes or arbitrary non-cooperative extension code. Test both registration orders, delayed/failed initialization, timeout, protocol mismatch, two independently bundled runtimes, and reload before accepting the seam.

### Activation policy by deployment mode

- **Automatic adapter:** OMP owns discovery and extension enable state. `omp-hooks-plus` applies its existing trust, Claude-provider opt-ins, user/project precedence, source enable state, and `disableAllHooks` semantics before supplying eligible hooks to the shared runtime. Ownership cannot re-enable a source those controls excluded.
- **Standalone package:** the user explicitly installs/enables the generated package through OMP. OMP's normal extension loading, scope, trust, and enable controls apply; the artifact neither edits those controls nor independently discovers ambient Claude settings/plugins. Source disable directives and scoped activation conditions present in the conversion input are preserved in the artifact. Subsequent changes to the original Claude settings do not dynamically govern this separately installed package; disable it through OMP or reconvert. Report this policy distinction prominently.
- **Both modes:** resolve runtime root/data environment values per plugin instance, preserve the artifact's declared activation scope, validate its target/coverage, and apply the ownership gate. Standalone activation is not evidence that an automatic source is trusted or enabled. If required host controls or activation evidence are unavailable, diagnose the unsupported activation condition rather than bypassing it.

## Generated artifact and filesystem safety

A complete plugin conversion produces:

- A valid package manifest with an explicit `omp.extensions` entrypoint and preserved non-hook plugin declarations required by the result.
- Generated OMP TypeScript bindings and a bundled compatibility runtime where original scripts remain selected.
- Original scripts and required local resources with a relocatable relative layout.
- `omp-hook-coverage.json`, containing coverage, fingerprints, target information, activation requirements, and evidence references.

An `omp` manifest can replace the entire `pi` manifest in OMP's package selection, not merely its extensions field. Carry over required skill and other resource declarations explicitly. Existing OMP bindings are input to reconciliation; do not overwrite or duplicate them implicitly.

Self-contained means no runtime dependency on the installed `omp-hooks-plus` package or the original source directory. It does not eliminate script interpreters, external commands, services, or plugin dependencies. Report those requirements. Dynamic dependency closure that cannot be determined must remain `needs-review`; do not claim portability based on a guessed file list.

Resolve runtime plugin-root environment values from the installed output location. Preserve source command strings and pass environment variables as environment variables, not interpolated shell text. Plugin data belongs in the appropriate writable runtime data location, not the generated package or the original development directory.

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

Build the converter library and CLI first, then migrate `omp-hooks-plus` to the same implementation, then add the companion skill. The migration removes superseded parsing/execution copies from the plugin. It preserves OMP-owned discovery, user/project precedence, opt-ins, disable behavior, plugin environment isolation, and diagnostics rather than creating a second discovery authority.

Generated artifacts must state that safe coexistence requires the migrated, protocol-aware `omp-hooks-plus`. An older bridge is not cooperative and can still execute the original hooks; an upgrade or explicit deactivation of that bridge is an activation prerequisite. This limitation must be visible, not represented as automatic deduplication.

## Acceptance criteria and verification

| ID | Observable acceptance condition |
| --- | --- |
| AC-01 | A Claude-only command plugin converts into a relocatable OMP package and exhibits the original supported behavior without `omp-hooks-plus` installed. |
| AC-02 | A plugin with pi coverage plus a Claude hook absent from pi retains both behaviors, with one selected implementation for each. |
| AC-03 | Protocol-aware generated bindings and `omp-hooks-plus` produce one execution per applicable source behavior regardless of their registration order. |
| AC-04 | A separately selected original pi entrypoint that overlaps the generated replacement produces an explicit activation conflict rather than duplicate converter-managed execution. |
| AC-05 | Changing a declaration, relevant script/resource, or reviewed pi implementation invalidates affected coverage; moving an unchanged plugin does not. |
| AC-06 | Missing/failed generated initialization does not silently suppress the original, and ambiguous partially active replacements do not trigger an unsafe fallback. |
| AC-07 | Skills, commands, tools, lifecycle state, and other unrelated functionality survive pi-to-OMP manifest/entrypoint replacement. |
| AC-08 | Unknown and malformed declarations, unavailable target contracts, unimplemented converter support, and unresolved dependencies remain distinguishable; none disappears through the existing nine-event filter. |
| AC-09 | Inspection, conversion, and checking do not execute plugin code; path escapes and unsafe output/resource selections are rejected without source mutation. |
| AC-10 | Identical inputs produce byte-identical outputs. An existing destination is unchanged on rejection; an operational failure publishes no partial package. Exit-2 drafts expose no discoverable OMP/pi entrypoints or package manifest and cannot shadow the original pi selection. |
| AC-11 | Ownership does not collapse independent plugins or legitimate repeated events. Ownership and context-delivery state are isolated across concurrent sessions and subagents: identical context can be delivered independently, and pending timers/buffers do not leak across reload or disposal. |
| AC-12 | At least one skill-assisted native port has recorded runnable comparisons for a `PreToolUse` deny case and a corresponding non-denied case: the denied tool does not execute, the non-denied tool does, and both match the original hook's observable outcome. Deterministic checking does not overstate that evidence. |
| AC-13 | Existing supported `omp-hooks-plus` behavior remains covered by its behavioral tests after the clean cutover, including trust/disable policy, environment isolation, context delivery, compaction, and stop-loop handling. |
| AC-14 | The event/handler capability table assesses Claude behavior independently of pi coverage, includes all inventoried events/types, and distinguishes true target gaps from missing converter implementation. |

Use the existing Bun test conventions. Keep regression tests for plausible failures in selection, activation, safety, lifecycle behavior, and source freshness. Use temporary end-to-end scenarios for routine generation and CLI proof. Exercise actual generated entrypoints and runtime effects, not only source text or a mocked compiler result.

Repository validation commands remain `bun test`, `bun run typecheck`, and `bun run build`; implementation must extend their scope to include the converter without weakening existing checks. No executable behavior is changed by this specification itself.

## Evidence and design constraints

Inspected source and a temporary runtime probe establish the following, not implementation of the proposed converter:

- `src/config.ts` filters plugin events through the existing hook-key set and loads plugin-specific environments; inventory must precede that filter.
- `src/hooks/shared.ts` deduplicates collected commands by command, arguments, and environment. This is not semantic deduplication against pi TypeScript.
- The installed Superpowers 6.3.0 pi extension combines resource discovery, session/compaction state, and context insertion; its Claude hook manifest declares a `SessionStart` command. This is a concrete example of why correspondence is not a one-event rename.
- OMP `packages/coding-agent/src/extensibility/plugins/loader.ts` selects `omp` before `pi`, and `packages/coding-agent/src/extensibility/extensions/loader.ts` discovers explicitly configured extension paths independently.
- A temporary probe using OMP's real `resolvePluginExtensionPaths` and `discoverExtensionPaths` passed: adding an `omp` declaration selected its entrypoint instead of pi; separately configuring the pi file selected both paths; discovery did not execute either source module. The probe removed its temporary files.
- OMP's `ExtensionAPI.events` exposes an extension communication bus, but the ownership protocol proposed above has not yet been implemented or validated.

OMP evidence revision: `andrebrait/oh-my-pi` branch `integration`, commit `acef0cdc9ca35468ee862cc78061860323b2eabb`, package version `18.1.17`. These are evidence coordinates, not a promise that all releases with that version have identical capabilities.

Primary source reference: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), consulted 2026-09-11. Implementers must capture its event/handler contracts in the versioned snapshot described above and compare them with the selected OMP interface. Inspection and conversion use that bundled snapshot offline; neither the live page nor the current bridge's supported subset is a runtime inventory filter.

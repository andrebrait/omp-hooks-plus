# Standalone Hook Converter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking. Repository policy requires one condensed adversarial review round, not four review agents.

**Goal:** Build an offline Claude-to-OMP converter whose shared runtime is consumed by `omp-hooks-plus`, with optional pi reuse and skill-assisted native ports.

**Architecture:** Introduce `packages/converter` as the only owner of reusable parsing, adaptation, execution, and generation. Keep automatic OMP discovery and trust policy in the root package. Generated packages bundle their runtime and resources; deployment is either the automatic bridge or the generated replacement for a source, never overlapping installations.

**Tech Stack:** TypeScript ESM, Bun, Node-compatible filesystem/crypto/process APIs, existing Bun tests, and public OMP interfaces. Dependency, publication-platform, and CI proposals require approval below; no host activation-API change is proposed.

**Spec:** [Specification](../specs/standalone-hook-converter.md): baseline approved 2026-09-11; the user subsequently selected either-or deployment. This revision removes simultaneous coexistence from the plan and awaits review.

## Global constraints

- Package and executable name: `omp-hook-converter`; directory: `packages/converter/`; root remains `omp-hooks-plus`.
- Claude only. Inventory original declarations independently of any pi implementation.
- No source imports, source execution, model calls, installation, or network access during `inspect`, `convert`, or `check`.
- Preserve the root package's existing supported behavior and OMP floor `>=18.1.16`; generated mappings and required scope/trust controls must be exercised against their selected capability profile.
- Initial host evidence is OMP integration revision `acef0cdc9ca35468ee862cc78061860323b2eabb`, package version `18.1.17`. A release version alone does not identify downstream capabilities.
- Source contract identifier: `claude-hooks-2026-09-11`. Every report records its content digest and the selected target profile.
- Coverage states: `adapted`, `covered`, `needs-review`, `target-gap`. Malformed input is an error. Missing converter support is not a target gap.
- Either-or deployment per source: no ownership bus, complete extension-roster requirement, automatic suppression/fallback, or new host activation API. Users disable overlapping originals before enabling replacements.
- Source scope is preserved. Analysis containment is not the command working directory. Commands run in the active OMP project.
- No overwrite, source mutation, implicit authorization, process-global context deduplication, duplicate maintained runtimes, compatibility re-export shims, or event-name-based equivalence inference.
- Root verification remains `bun test`, `bun run typecheck`, and `bun run build`, extended to both packages without weakened gates.
- Ask before dependencies, publication-platform restrictions, or CI changes. No OMP-core change is in scope. This document does not authorize implementation.

## Execution gates and evidence

### Either-or deployment removes the host activation prerequisite

The earlier real-host probe found no public complete selected-roster/init-outcome snapshot. That evidence remains valid, but the user has now explicitly chosen either-or deployment rather than automatic coexistence. The converter therefore needs neither that snapshot nor a new OMP ownership API.

An operator disables overlapping bridge/original pi bindings, reloads or restarts OMP, and then enables the generated replacement. If current controls cannot exclude one source from the bridge, disable the bridge rather than introducing a new exclusion feature. Rollback reverses those steps explicitly; failures never enable an alternative implementation automatically. Unsupported overlapping installations may execute twice, and offline checking does not certify their absence.

Retain ordinary target capability, scope/trust, and session-lifecycle verification. Assess those contracts through existing public OMP interfaces and loader behavior; a specific unsupported contract becomes a diagnostic, not a blanket dependency on a new global activation API. Coverage reconciliation inside one artifact still selects a single implementation for each source behavior.

### Explicit approvals before affected tasks

1. **Dependency proposal:** use `typescript` as a converter dependency for syntax-only pi import/registration analysis. It already exists as a development dependency but making it part of the independently installed converter is a dependency change. Use Bun's YAML parser for frontmatter, not a second YAML library. Never execute the parsed TypeScript. TypeScript's compiler API is not a semantic-equivalence oracle.
2. **Publication platform proposal:** initially verify atomic directory publication on Linux using Bun FFI and libc `renameat2(..., RENAME_NOREPLACE)`. This adds no npm dependency but introduces a Linux-specific capability requirement for `convert`. `inspect` and `check` remain portable Bun operations. Other systems must reject publication before writing output until an equivalent no-replace primitive is separately implemented and tested. Approval of this initial platform boundary is required; a check-then-rename fallback is not acceptable.
3. **CI proposal:** add tests to PR CI and include both packages in existing typecheck/build commands. Add an independently triggered converter publish workflow before the root release begins depending on its published version. Publication itself remains an explicit release action, not part of implementation verification.

If any proposal is declined, revise that proposal and its dependent tasks with the user. Do not silently drop the corresponding acceptance criteria.

## File ownership and clean-cutover map

| Path | Responsibility and disposition |
| --- | --- |
| `packages/converter/package.json`, `tsconfig.json` | Independently installable CLI/library package; strict source typecheck and declarations. |
| `packages/converter/src/index.ts`, `contracts.ts` | Analysis/generation API and serializable report types. No OMP value imports. |
| `packages/converter/src/source.ts`, `paths.ts` | Explicit source loading, provenance-preserving inventory, containment. No ambient discovery. |
| `packages/converter/src/claude-contract.json`, `capabilities.ts` | Versioned source contracts and exercised target rules. |
| `packages/converter/src/fingerprints.ts`, `pi-analysis.ts` | Dependency closure/freshness and syntax-only candidate analysis. |
| `packages/converter/src/coverage.ts` | Validated decisions, relationships, activation domains, and implementation selection. |
| `packages/converter/src/artifact.ts`, `publish.ts`, `cli.ts` | Deterministic plans, safe publication, and argument/diagnostic presentation. |
| `packages/converter/src/runtime/types.ts`, `helpers.ts`, `type-guards.ts`, `config.ts` | Move reusable existing data types, helpers, parsers, matching and merging; remove root copies. |
| `packages/converter/src/runtime/executor.ts`, `hooks/*.ts` | Move existing execution, result interpretation, and OMP registration logic together. Separate pure analysis imports from this runtime graph. |
| `packages/converter/src/runtime/context.ts`, `index.ts` | Session-local delivery and public runtime entry; no cross-package ownership module. |
| `src/config.ts` | Retain OMP discovery, trust/source enablement, hierarchy selection, and `LoadedSettings` diagnostics; import converter parsing. |
| `src/omp-hooks.ts`, `src/doctor.ts` | Retain root entrypoint and doctor command; supply root policy to shared runtime. |
| `test/` | Retain automatic-consumer integration regressions; migrate pure execution tests without duplicate copies. |
| `packages/converter/test/` | Converter safety, coverage, runtime, and either-or deployment regressions. |
| `skills/convert-claude-hooks/SKILL.md` | Optional CLI-driven completion/native-port workflow, shipped by the converter package. |
| `README.md`, `packages/converter/README.md` | Deployment policies, CLI usage, capabilities, requirements, and examples. |
| `.github/workflows/ci.yml`, `publish-converter.yml` | Approved quality and separate release changes only. |

The extraction scout correctly identified pure trigger functions, but host-bound does not mean root-owned: generated packages need the same event registration and context delivery. Move those into the converter's **OMP runtime**, parameterizing only the root policy loader. Do not duplicate `registerToolHooks` or the other registration modules in two packages. `loadSettings` and root-specific `LoadedSettings` remain outside the converter dependency graph.

The eventual extraction commit necessarily touches more than five files: it is one atomic import-graph cutover across existing event modules and tests. This is a justified mechanical boundary, not permission for unrelated refactoring.

## Shared interface contracts

These are proposed converter interfaces, not claims about APIs already present in OMP. Implement them in `contracts.ts` before dependent work; validate JSON at input boundaries rather than casting it to these types.

All four library entry points throw on malformed-input or operational failures; the CLI maps those failures to exit `1`. `inspectSource` returns `Analysis.status` (`complete`/`unresolved`); `planArtifact` returns `ArtifactPlan.status` (`complete`/`draft`); the CLI maps those statuses to `0`/`2`. `publishArtifact` returns `void` on successful publication, so `convert` retains the plan's status for its exit code. Only `checkArtifact` directly returns `OperationResult.exitCode`.

```ts
export type CoverageState = "adapted" | "covered" | "needs-review" | "target-gap";
export type SourceScope = "user" | "project" | "local";
export type SourceInput =
  | { kind: "plugin"; path: string; scope: SourceScope }
  | { kind: "file"; path: string; sourceRoot: string; scope: SourceScope; name?: string };
export type Locator = {
  kind: "plugin" | "settings" | "skill" | "agent";
  file: string;
  pointer: string;
};
export type Diagnostic = {
  code: string;
  message: string;
  locator?: Locator;
};
export type Declaration = {
  locator: Locator;
  event: string;
  order: number;
  scope: { install: SourceScope; container?: Locator };
  fields: { pointer: string; valueType: string; sha256: string }[];
  fingerprint: string;
};
export type InventoryDeclaration = Declaration & { raw: Record<string, unknown> };
export type AnalysisOptions = {
  target?: string;
  coveragePath?: string;
  deployment?: "standalone" | "automatic";
};
export type FileDigest = { path: string; sha256: string };
export type ArtifactFile = { path: string; bytes: Uint8Array; executable: boolean };
export type ArtifactPlan = {
  sourceRoot: string;
  status: "complete" | "draft";
  report: CoverageReport;
  files: ArtifactFile[];
};
export type Analysis = {
  status: "complete" | "unresolved";
  sourceRoot: string;
  declarations: InventoryDeclaration[];
  report: CoverageReport;
  files: ArtifactFile[];
};
export type OperationResult = { exitCode: 0 | 2; report: CoverageReport };
export type ActivationRequirements = {
  policy: "standalone-explicit-host-controls" | "automatic-existing-bridge-controls";
  requiredHostCapabilities: string[];
  requiredHostControls: string[];
  scope: SourceScope;
  disableAllHooks: boolean;
  deployment: "either-or";
  originalPiEntrypoints: string[];
};
export type CoverageReport = {
  schemaVersion: 1;
  converterVersion: string;
  sourceContract: { id: "claude-hooks-2026-09-11"; sha256: string };
  target: string;
  activation: ActivationRequirements;
  source: { kind: SourceInput["kind"]; entry: string; scope: SourceScope; name?: string };
  declarations: Declaration[];
  decisions: CoverageDecision[];
  files: FileDigest[];
  diagnostics: Diagnostic[];
};
export type CoverageDecision = {
  declarations: Locator[];
  state: CoverageState;
  implementation?: { kind: "adapter" | "pi" | "native"; files: FileDigest[] };
  dependencies: FileDigest[];
  evidence: {
    kind: "rule" | "review" | "scenario";
    reference: string;
    fingerprint: string;
  }[];
  domains: { declaration: Locator; matcher: string | null; scope: Declaration["scope"] }[];
  diagnostics: Diagnostic[];
};
export declare function inspectSource(input: SourceInput, options?: AnalysisOptions): Promise<Analysis>;
export declare function planArtifact(analysis: Analysis): Promise<ArtifactPlan>;
export declare function publishArtifact(plan: ArtifactPlan, destination: string): Promise<void>;
export declare function checkArtifact(
  artifactRoot: string,
  source: SourceInput,
  options?: Pick<AnalysisOptions, "target">,
): Promise<OperationResult>;
```

`Analysis.sourceRoot` and `ArtifactPlan.sourceRoot` are canonical, in-memory containment roots, never serialized artifact metadata. `publishArtifact` uses that root to reject destinations inside the source even when called as a library rather than through the CLI. `Analysis.files` holds selected resource/binding bytes; it is an internal materialization input, not part of the JSON report. Never serialize absolute input paths. `CoverageReport.files` excludes the coverage report itself to avoid self-referential hashing; validate the report's schema/content independently. Resource digests and evidence fingerprints are distinct: updating a digest does not renew behavioral evidence.

`domains` describes a deliberately restricted reviewable partition, not executable predicates. Initially accept only whole domains or provably disjoint exact matcher sets with identical scope whose union equals a finite original matcher set. Regex algebra, arbitrary callbacks, and overlapping/unbounded partitions remain unresolved. This is conservative handling of uncertainty, not silently partial coverage.

`deployment` in `AnalysisOptions` defaults to `standalone`; only the automatic adapter requests `automatic`, not a user-supplied coverage record. Activation capability/control identifiers are validated against the selected profile. Runtime checks its own required extension enablement, trust and scope controls, with automatic source/provider policy retained in the root adapter. `activation.deployment` records the either-or operational requirement. `originalPiEntrypoints` are contained source-relative paths for migration guidance, not live roster identities or proof those bindings are disabled. Metadata never grants authorization or overrides an input disable directive.

`InventoryDeclaration.raw` is internal analysis data, never part of `CoverageReport`. Serialize report declarations with an explicit allowlist of `locator`, `event`, `order`, `scope`, `fields`, and `fingerprint`; never use object spreading or generic JSON serialization of an inventory declaration. Field descriptors contain relative pointers, validated JSON value types, and hashes, not original values. Unknown/sensitive values must not leak through diagnostics or draft text either. Retain full original values only in memory for analysis and authorized source-backed review; resource/code emission remains subject to the specification's separate safe-selection rules.

Runtime policy seam in `runtime/context.ts`:

```ts
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SettingsFile } from "./types";
export type RuntimePolicy = {
  settingsFor(ctx: ExtensionContext): Promise<SettingsFile | undefined>;
  onDiagnostic(message: string): void;
};
export declare function registerHooks(
  pi: ExtensionAPI,
  policy: RuntimePolicy,
): { dispose(): void };
```

The policy seam removes the existing hard dependency from `createHookContext` to root `loadSettings`. Root retains the latest `LoadedSettings` in its own closure for doctor output. Generated policy returns only artifact settings after its own target/scope/coverage checks. Neither policy queries other extensions, changes their enable state, or participates in an ownership handshake.

## Ordered tasks

### Task 1: Deliver offline, complete source inspection

**Depends on:** user approval of the revised plan and parser dependency proposal. **Files:** converter package/tsconfig, root workspace/scripts/lockfile, `contracts.ts`, `source.ts`, `paths.ts`, `claude-contract.json`, `capabilities.ts`, `index.ts`, `cli.ts`; `test/source.test.ts` under converter.

**Consumes:** `SourceInput`, `AnalysisOptions`. **Produces:** `inspectSource`; working `inspect` CLI and versioned source/target tables. This is a usable vertical slice, not an empty package scaffold.

- [ ] Create hostile-source fixtures in temporary directories: unknown event/type/field, malformed JSON, default and referenced hook files, inline manifest hooks, settings input, nested skill/agent frontmatter, and a pi file that would create a sentinel if imported. Include a declared event outside the original nine-event set.
- [ ] Include an unknown handler field containing a distinctive credential-like sentinel. Assert its locator/type/fingerprint remains in both inspect output and generated coverage, while its value is absent from JSON reports, human diagnostics, and inert draft text. Changing that value must still invalidate the declaration fingerprint. The test protects the report boundary without discarding the unknown declaration.
- [ ] Assert inventory retains every valid declaration and original provenance/order/scope; malformed structure returns exit `1`; unknown well-formed contracts remain visible with exit `2`; the sentinel is absent. Run `bun test packages/converter/test/source.test.ts` before implementing inspection and record the failure.
- [ ] Capture the approved Claude reference into the checked-in snapshot during development. Record every documented event, handler type, field, input, scope, output effect, and async/lifecycle rule. Verify its identifier/digest. Live documentation is never read by the shipped CLI.
- [ ] For every snapshot event/type combination, assess the real target contract. Implement all fully supported mappings, not merely the nine legacy events. Represent missing target semantics separately from unfinished conversion support. Preserve unknown source keys outside the snapshot.
- [ ] Verify each proposed OMP mapping against the pinned host's public events, effects, scope/trust controls, and lifecycle behavior. Use real host loaders/runners for focused smoke scenarios without model/network calls. Do not infer that the package version alone proves support, and do not require an extension roster or propose an ownership API.
- [ ] Parse explicit JSON/frontmatter using data parsers only. Enumerate manifest/default/referenced files with stable sorted traversal, root-relative locators and exact JSON pointers/frontmatter positions. Reject lexical/symlink escapes before reading. Do not call ambient OMP discovery or an importer to find declarations.
- [ ] Implement argument handling with `node:util.parseArgs`; require explicit `--scope` for both plugin and file input, additionally enforce file input root and valid conversion names, and reject unknown targets. A missing plugin scope is invalid input, not an inferred user scope. `check` reuses recorded scope/name. JSON and human output derive from one analysis object. Operational/validation exceptions are presented as exit `1`, never as `target-gap`.
- [ ] Add workspace membership and an independent converter bin/exports map. Keep OMP value imports out of the analysis/CLI entry graph; type-only OMP imports are erased. Typecheck both packages and emit the converter's distributable CLI/library/declarations. Do not add a direct dependency on the host's discovery barrel.
- [ ] Run the focused test and invoke `bun packages/converter/src/cli.ts inspect <temporary-plugin> --scope project --json` with network disabled. Expected: full inventory, explicit source/target identities, no source execution or mutation. Commit the working inspection slice.

### Task 2: Bind coverage to source and dependency freshness

**Depends on:** Task 1. **Files:** `fingerprints.ts`, `pi-analysis.ts`, `coverage.ts`, `contracts.ts`, `test/coverage.test.ts` under converter.

**Consumes:** `InventoryDeclaration[]`, explicit source roots, optional coverage report. **Produces:** validated `CoverageDecision[]`, candidate pi relationships, and closure digests used by inspection/generation/checking.

- [ ] Write a regression where pi implements one source declaration, a second Claude declaration is absent from pi, and an unrelated pi command shares a handler/module. Expected: both source declarations remain accounted for; only reviewed correspondence selects pi; the unrelated command is retained.
- [ ] Add stale-evidence cases for script/resource/local import, package version/manifest/lock integrity, mutable workspace dependency, and edited native output. Moving identical source bytes alone must not invalidate coverage. Missing dynamic/unfrozen dependencies remain `needs-review`.
- [ ] Run `bun test packages/converter/test/coverage.test.ts` and observe failures before implementing selection/freshness.
- [ ] Use TypeScript's parser to inventory imports and candidate registrations without evaluating code. Resolve local imports with containment checks; fingerprint relevant resolved dependency manifests/lock metadata and actual mutable dependency files. Unresolved dynamic import/require or hidden resource dependency is diagnostic, not an assumed empty closure.
- [ ] Parse and validate coverage evidence at its own root. Reject escaped referenced artifacts, invalid locators, source-contract mismatches, fabricated partition shapes, and unknown schema versions. Recompute source and artifact digests; stale evidence returns to review rather than being silently refreshed.
- [ ] Select whole declarations or the restricted proven partitions described above. Support many-to-many source/binding correspondence. Do not suppress an entire event or extension because one command/string matches. A mixed unrelated/hook handler remains unresolved unless a reviewed artifact safely preserves its unrelated functionality.
- [ ] Run the test, then inspect a temporary plugin before and after each dependency edit. Expected: only affected decisions lose freshness; relocation alone preserves it. Commit this selection slice.

### Task 3: Move execution into the converter without changing automatic policy

**Depends on:** Task 2. **Files:** source-to-runtime moves in the ownership map; root `config.ts`, `omp-hooks.ts`, `doctor.ts`; moved executor/output/tool/prompt/stop tests and retained root integration tests.

**Consumes:** existing `SettingsFile`, trigger/result contracts, `RuntimePolicy`. **Produces:** one shared OMP runtime; root imports converter and retains automatic source selection.

- [ ] Run the existing focused behavior tests before moving code. Record results for executor/output contracts, plugin trust/disable/environment behavior, first-turn context, compaction, and stop-loop handling.
- [ ] Use native LSP references for exported symbols before moving them. Move `types`, `helpers`, `type-guards`, executor, shared hook functions, all event registration modules, and reusable configuration parsing/matching to converter runtime ownership. Update all callers in the same cutover; remove obsolete root files rather than re-exporting them.
- [ ] Keep `loadSettings`, provider/source opt-ins, project trust, user/project/local hierarchy discovery, and `LoadedSettings` in root `config.ts`. Extract reusable parsing from that file; the new complete inventory is not implemented by reusing its lossy supported-event projection.
- [ ] Replace the context factory's direct `loadSettings` call with `RuntimePolicy.settingsFor`. Root supplies a closure that stores its latest `LoadedSettings` and returns its settings. Generated packages will supply artifact-only settings. Preserve notification and doctor behavior.
- [ ] Move pure execution tests into converter tests and update import paths; retain root consumer integration tests. Do not duplicate the test corpus or rewrite behavioral assertions into source-text/import assertions.
- [ ] Run moved tests and retained root regressions. Expected: same observable policy, stdout/JSON effects, timeouts, environment isolation, first-turn delivery, compaction ordering, and stop behavior. Commit the atomic clean cutover.

### Task 4: Make context delivery and disposal session-local

**Depends on:** Task 3. **Files:** `runtime/context.ts`, runtime prompt/compact/session registration modules; `test/hook-context.test.ts`, `test/compact-context.test.ts`, `test/first-turn-context.test.ts`.

**Consumes:** `RuntimePolicy`; existing per-factory pending prompt and stop-loop state. **Produces:** per-session delivery queue/dedup/reset/disposal, with no module-global buffer or content set.

- [ ] Replace implementation-pinning global claim/reset tests with a regression that creates two runtime instances and observes identical hidden context delivered once in each. Add pending timer disposal/reload and independent repeated-event cases.
- [ ] Run `bun test test/hook-context.test.ts test/compact-context.test.ts test/first-turn-context.test.ts`; record the cross-session failure before the correction.
- [ ] Allocate delivery buffer, dedup set, timers, and generation/disposed state inside the owning runtime context. Make claim/reset methods instance-local. Preserve queued-content deduplication and the 50ms batch behavior within one session; preserve immediate aside delivery before the next model step.
- [ ] On disposal, disable callbacks first, cancel timers, and clear queued state. Async completions capture the owning generation and discard delivery after it is disposed. Do not attempt to undo an external process side effect that already began.
- [ ] Preserve prompt-to-before-agent-start handoff, compaction reset before SessionStart reinjection, and existing per-instance stop-loop state. Do not convert those already-local fields into globals.
- [ ] Run the focused tests and a two-session real-host scenario. Expected: independent identical messages, no cross-session/superseded-generation delivery, and unchanged first-turn/compaction behavior. Commit the isolation fix.

### Task 5: Emit deterministic complete packages and inert drafts

**Depends on:** Tasks 2 and 4. **Files:** `artifact.ts`, `cli.ts`, `capabilities.ts`, `test/artifact.test.ts`, converter build configuration.

**Consumes:** `Analysis`, fresh coverage decisions, shared runtime. **Produces:** `planArtifact`, working conversion materialization content, runtime target/scope checks.

- [ ] Add fixtures for Claude-only command behavior, reviewed pi plus Claude-only behavior, unrelated pi tools/skills/commands, file-input scope/disable/cwd, embedded absolute source paths, and excluded required resources. Load the actual generated entrypoint in OMP, dispatch both the pi-covered and Claude-only events, and assert one distinct external marker for each behavior per occurrence. Invoke the retained tool and command and observe their effects once; resolve and activate the retained skill through the real host path and observe its expected prompt content. Exercise retained lifecycle state across two events. Coverage-report assertions or manifest keys alone do not satisfy these comparisons.
- [ ] Run `bun test packages/converter/test/artifact.test.ts` before generation. Expected initial failure includes complete-versus-draft classification and relocation behavior.
- [ ] Build complete ESM artifacts with `omp.extensions`, bundled runtime, TS bindings, required original resources, and `omp-hook-coverage.json`. Carry over the full required pi resource declaration set because `omp` replaces `pi` as a whole. Reconcile existing OMP bindings explicitly; never overwrite or duplicate them implicitly.
- [ ] Emit the either-or installation requirement and known original pi entrypoints as migration guidance. Conversion does not edit OMP/Claude activation settings; `check` validates artifact requirements, not live installation state. Preserve specific target/scope/trust failures rather than treating every conversion as blocked on unavailable roster information.
- [ ] Use a fixture with one declared pi entrypoint whose behavior is incorporated into the output and an unrelated retained resource. Verify JSON and human migration output identify that exact original entrypoint for disabling without marking the unrelated resource as a conflicting implementation. This proves useful installation guidance, not live configuration detection.
- [ ] Bundle only reviewed/selected code using Bun without invoking source modules or arbitrary build plugins. Inspect the emitted import/resource closure. Report external interpreters/tools/services/packages; unresolved dynamic closure prevents a complete artifact. Preserve command strings and pass root/data variables through the environment.
- [ ] For file inputs create the explicit valid name, version `0.0.0`, `private: true`, and ESM manifest, without inferred pi resources. Preserve `disableAllHooks` and installation scope. Keep project-relative commands relative to active project cwd, not `.claude/` or artifact root.
- [ ] Produce only report and inert `.txt` source for unresolved output: no package manifest, recognized entrypoint, or runnable source tree. `check` of that draft stays exit `2`. A complete result requires every active source requirement and unrelated retained behavior accounted for.
- [ ] Sort files, report arrays, and stable JSON keys; exclude timestamps and development paths. Fingerprint output resources/bindings, excluding report self-hashing. Review any source-root absolute reference instead of blindly replacing strings.
- [ ] Convert a temporary plugin twice and compare every file byte. Move complete output, make the original root unavailable, and exercise the actual generated entrypoint without the bridge installed. Expected: original supported effects retained.
- [ ] Exercise one source through the automatic bridge alone, disable it through existing controls, reload/restart, then exercise the generated replacement alone with the same inputs. Observe the same effect once per occurrence in each configuration, without any bus handshake. Use two independent source plugins with identical command text to confirm they remain independent.
- [ ] In a separate smoke scenario, make the generated package fail its own initialization validation. Observe the real error, no execution from the disabled original, and unchanged activation settings. Explicitly disable the replacement, reload/restart, and restore the original; verify behavior returns only after that operator action. Do not implement fallback or replay to satisfy the scenario.
- [ ] Commit deterministic generation after the standalone, explicit-switching, and rollback smoke scenarios pass.

### Task 6: Publish without clobbering and check without executing

**Depends on:** Task 5 and Linux publication boundary approval. **Files:** `publish.ts`, `artifact.ts`, `cli.ts`, `test/publication.test.ts`, `test/check.test.ts` under converter.

**Consumes:** `ArtifactPlan`, explicit destination/source/report roots. **Produces:** `publishArtifact`, `checkArtifact`, complete `inspect`/`convert`/`check` exit contract.

- [ ] Write regression cases for existing empty/nonempty destinations, symlink/lexical escapes, destination inside source, colliding generated paths, competing converters, another writer appearing immediately before publication, and injected write/validation/publication errors. Assert target content is unchanged, not merely that an exception occurred.
- [ ] Add `check` cases for malformed artifacts (exit `1`), valid unresolved drafts (exit `2`), fresh complete artifacts (exit `0`), stale source/native/dependency evidence, and an explicit target override. Sentinel code must never execute.
- [ ] Run `check` on the same complete artifact/source under two isolated OMP configurations: one lists the overlapping original pi entrypoint as enabled, the other disables it. Require the same exit code and analysis report in both, with both configurations unchanged. Success means artifact validity only; neither result certifies live installation safety. This regression must fail if future code consults ambient enablement to decide an offline check result.
- [ ] Run `bun test packages/converter/test/publication.test.ts packages/converter/test/check.test.ts` and record failure before implementing publication/checking.
- [ ] Resolve and validate the destination parent, hold a destination-specific exclusive sibling lock, and create a sibling staging directory. Materialize only contained paths, then validate the full staged artifact before publication. A stale lock is reported, never automatically broken using a guessed PID.
- [ ] On approved Linux targets call libc `renameat2` with `RENAME_NOREPLACE` through Bun FFI. Treat `EEXIST` as rejection and unsupported flags/filesystems as operational failure. Never use plain `rename` after an existence check: another writer can create an empty directory in that gap. Always release owned locks and remove owned staging data; report residual paths when cleanup fails.
- [ ] Implement `checkArtifact` by validating report/schema/paths, re-running source analysis under the recorded scope/name/profile, recomputing closure/evidence fingerprints, and comparing required artifact files. It does not import either implementation or upgrade scenario evidence into proof of equivalence.
- [ ] Run the regressions, race two actual CLI processes for one destination, inject an independent destination writer, and verify drafts through OMP's real discovery functions. Expected: at most one published package; no overwritten writer content; exit-2 output has no discoverable package/extension. Commit safe publication/checking.

### Task 7: Ship the optional skill and record one real native port

**Depends on:** Task 6. **Files:** `skills/convert-claude-hooks/SKILL.md`, converter `package.json`, converter `README.md`; one small fixture/comparison under `packages/converter/test/native-port/` with source, native implementation, and recorded scenario evidence.

**Consumes:** shipped CLI and coverage schema. **Produces:** a discoverable optional skill and source-bound behavioral evidence for AC-12.

- [ ] Write the skill to invoke `inspect`, read every unresolved declaration and original implementation, choose script retention/pi adaptation/native port, update reviewed source-bound decisions, and run `check`. It must not implement another parser or capability map.
- [ ] Require explicit user authorization before execution/model-assisted analysis. Show that conversion alone does neither. Isolate behavioral runs in temporary project/data directories with controlled environment and network; do not run discovered source automatically.
- [ ] Port a small real `PreToolUse` command hook whose deny branch prevents a tool side effect and whose allowed branch permits it. Drive the original and native variants through real OMP tool dispatch using a tool that writes a temporary marker.
- [ ] Record exact commands, source/native fingerprints, deny/allow inputs, marker observations, errors, and limits. The denied marker must be absent and the allowed marker present for both implementations. Preserve matcher/scope, input changes, context placement, async/lifecycle behavior that the chosen hook uses.
- [ ] Run the retained comparison and deterministic `check`. Expected: scenario evidence is current; edits to either implementation invalidate it. No claim of arbitrary-program equivalence. Remove unused generated script adapters only after all selected behavior is native; retain provenance and evidence.
- [ ] Include the skill in converter package files/OMP skill declarations and document its invocation. Commit skill and the one meaningful deny/allow comparison, not a second framework.

### Task 8: Verify independent packaging, compatibility, and release gates

**Depends on:** Task 7 and CI approval. **Files:** root/converter package manifests and scripts, `README.md`, converter `README.md`, `.github/workflows/ci.yml`, `.github/workflows/publish-converter.yml`; existing root publish workflow only if its dependency ordering needs enforcement.

**Consumes:** complete converter and migrated root. **Produces:** independently installable packages, documented policies, quality/release gates with no implicit publication.

- [ ] Document CLI examples, exit codes, coverage limitations, target revision/capabilities, Linux publication boundary, external runtime requirements, disabled/file-input scope behavior, and the automatic-versus-standalone policy distinction. Give explicit disable/reload/enable and rollback instructions. State that overlapping deployments are unsupported regardless of bridge version and that offline success does not prove a conflict-free installation.
- [ ] Pack the converter into a temporary archive, install it offline in an isolated temporary project using available dependency artifacts, and exercise the installed bin/library. Pack the root with a real publishable converter dependency, not an unresolved workspace-only reference. Verify a generated artifact needs neither installed package at runtime. If local dependency artifacts are unavailable, report that verification as blocked rather than pretending an install occurred.
- [ ] Extend root typecheck/build to both packages and ensure moved plus retained tests are discovered. PR CI runs `bun test`, `bun run typecheck`, `bun run build`; it must not lower assertions, suppress types, or skip existing behavior tests.
- [ ] Add a converter-specific tag/release trigger (`converter-v*`) that checks its manifest version and runs quality gates before publishing from `packages/converter`. Keep root `v*` releases separate. Publish the converter version before any root release depending on it; never publish during smoke verification.
- [ ] Run `bun test`, `bun run typecheck`, and `bun run build` once after all edits settle. Exercise the focused acceptance scenarios below. Remove throwaway smoke directories/scripts after observing results; retain regression tests only for plausible contract failures.
- [ ] Request the repository's single condensed adversarial review covering contract, hostile-input correctness, test honesty, and unnecessary complexity. Address findings, open/update the PR, wait for green CI, then request both Copilot and CodeRabbit and address their findings. Skip Copilot only if it reports quota exhaustion.
- [ ] Commit/release only through the separately authorized workflow. No release, merge, or source execution is implied by approval of this planning document.

## Dependency order and review checkpoints

```text
Plan approval and the affected dependency proposal
    -> Task 1 (independent offline inspect and target assessment)
    -> Task 2 (fresh coverage and pi reconciliation)
    -> Task 3 (shared runtime clean cutover)
    -> Task 4 (session-local delivery)
    -> Task 5 (complete packages, either-or deployment, inert drafts)
    -> Task 6 (safe publication and check; platform approval required)
    -> Task 7 (skill and native behavioral comparison)
    -> Task 8 (packaging and release readiness; CI approval required)
```

Checkpoint A: Tasks 1–2 inspect and select without executing source. Checkpoint B: Tasks 3–4 preserve root policy and isolate runtime state. Checkpoint C: Tasks 5–6 prove standalone behavior, explicit switching/rollback, and safe artifacts. Checkpoint D: Tasks 7–8 satisfy the native-port comparison and independent packaging/release requirements. There is no host ownership-API checkpoint.

One integration owner controls shared contracts and clean-cutover files. Do not parallelize dependent implementations. Once a task's interface is fixed, independent fixture/research slices may run concurrently without sharing edited files; run project-wide validation only after edits settle.

## Acceptance proof matrix

| Criterion | Owning tasks | Smallest meaningful proof |
| --- | --- | --- |
| AC-01 | 5, 8 | Execute relocated generated entrypoint with source unavailable and no bridge. |
| AC-02 | 2, 5 | Actual generated entrypoint receives both events; pi-derived and Claude-adapted behavior each writes its expected marker once. |
| AC-03 | 5 | Run automatic-only, disable/reload, then generated-only; compare one effect per occurrence in each configuration. |
| AC-04 | 5, 6, 8 | Known original pi paths appear in migration guidance; activation settings stay untouched and offline check claims only artifact validity. |
| AC-05 | 2, 6 | Source/resource/native/dependency edits invalidate evidence; pure relocation does not. |
| AC-06 | 5 | Initialization failure reports an error without enabling originals; explicit disable/reload/restore returns original behavior. |
| AC-07 | 2, 5 | Invoke retained tool/command, activate the skill through the host, and observe lifecycle state after whole-manifest replacement. |
| AC-08 | 1, 2 | Unknown/malformed/gap/unimplemented/dynamic dependency cases retain distinct outcomes. |
| AC-09 | 1, 2, 6 | Execution sentinels stay absent; escape/copy/output attacks reject without source changes. |
| AC-10 | 5, 6 | Byte comparison, concurrent publication, failure injection, real-host draft nondiscovery. |
| AC-11 | 4, 5 | Concurrent sessions/subagents/reload deliver identical messages independently; independent plugins and repeated occurrences still execute. |
| AC-12 | 7 | Original/native deny prevents actual tool execution; allowed case executes in both. |
| AC-13 | 3, 4, 8 | Existing trust/disable/environment/context/compaction/stop behavior tests remain green. |
| AC-14 | 1, 2, 5 | Full snapshot and unknown-key inventory assessed independently of pi, with contract-level rules. |
| AC-15 | 1, 5, 6 | Explicit file identity/root/scope, real project-relative command cwd, disable and scope enforcement. |

## Planning verification and handoff

This revision changes documentation only. Earlier real-host probes established manifest selection and the absence of a complete activation snapshot; the latter is no longer a prerequisite under the user's either-or decision. Converter commands, package tests, and implementation outcomes described in the tasks remain future acceptance work.

Before execution, obtain user review of this revised plan and explicit decisions on the remaining dependency, publication-platform, and CI proposals. The user-authorized change replaces the former simultaneous-coexistence acceptance criteria with explicit deployment/switching/rollback criteria; it does not weaken coverage, filesystem safety, scope/trust controls, or session isolation. No implementation begins merely because this plan is committed or its documentation PR passes CI.

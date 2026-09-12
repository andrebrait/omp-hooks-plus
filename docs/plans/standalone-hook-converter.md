# One-shot converter implementation

This replaces the earlier package/deployment design. The implemented scope is a script and a shared adapter inside `omp-hooks-plus`.

## Implementation

1. `src/claude.ts` holds the existing pure declaration parsing and matching helpers. `src/adapter.ts` registers the existing hook handlers with an injected settings provider. The live bridge retains discovery and trust checks; generated hooks supply fixed definitions instead.
2. `src/hook-context.ts` owns injection queues and duplicate suppression per adapter instance. Session changes and disposal invalidate stale asynchronous context deliveries.
3. `src/conversion-source.ts` statically inventories explicit source declarations, including unsupported handlers and scoped frontmatter. It reuses the existing parser only after inventory and reports Pi bindings without importing them.
4. `src/convert.ts` copies eligible resources and bundles the trusted adapter. It writes a report and publishes `index.ts` last in a new output directory. `bun run convert` is the only new package script; there are no new dependencies or packages.
5. Presentation metadata is classified separately from behavior. Resource includes can restrict plugin copying while declaration inventory remains complete. Reports identify omitted resources, non-reused Pi/OMP bindings, command-hook adaptation level, and activation policy.
6. Generated activation retains the existing `enabled` default; `project-trusted` is explicit opt-in. Local read-path normalization belongs to `src/executor.ts`, reusing OMP's path helpers so the automatic extension and generated hooks share the fix.

## Verification

Run:

```sh
bun test
bun run typecheck
bun run build
```

Focused converter coverage is in `test/conversion-source.test.ts` and `test/convert.test.ts`. It exercises inventory completeness, malformed declarations, scoped YAML, traversal and symlink boundaries, non-execution during conversion, report redaction, existing-output protection, source-wide disabling, and explicit file-resource selection.

The generated-runtime test moves the output, deletes the source plugin, then loads the generated entrypoint through the real OMP extension loader and runner. It observes denial, rewritten tool input, and the script's active-project working directory/environment. Existing adapter tests cover context and lifecycle behavior. A separate CLI smoke check loads generated output in a fresh Bun process outside this repository after removing its source.

Follow-up regressions cover nested project-root detection, distinct persistent data for different script resources, a resource-parent swap after inventory, and startup in successive ephemeral sessions. The input-boundary test calls the real host runner to verify handled denial, one-time preparation, no prompt replay on provider requests/continuations, and preservation of slash-like content with arguments. It does not claim to repair or retest OMP's reported missing RPC/editor/queue dispatch.

No test establishes arbitrary plugin equivalence or external script dependency closure. The converter reports unsupported declarations and dependencies rather than claiming that guarantee.

Compatibility regressions cover metadata validation versus unsupported events, selected resources that cannot hide scoped declarations, exclusion/symlink boundaries, descriptor-bound copying with explicit selection, and trusted/untrusted transitions at the same working directory. Isolated runtime tests use the real OMP loader with Bun automatic package installation disabled; OMP remains a required runtime dependency.

An isolated real-Graphify command probe exercised both the automatic extension and generated callbacks with `sample.ts` and `sample.ts:1-2`. Both delivered guidance under the default enabled policy; project-trusted output delivered guidance only when trusted. The probe used a controlled graph-presence fixture, not graph extraction, production editor/RPC dispatch, or a native-equivalence evaluation. Complete installed-plugin inventory checks accepted Caveman metadata while retaining Ponytail's unsupported `SubagentStart`; plugin-directory dry runs with explicit `hooks`/`skills` resources retained complete Superpowers and agent-skills declaration inventory.

External-review regressions additionally cover JSON/frontmatter parent replacement, source-root replacement by a symlink or different directory, and unrelated absolute paths sharing the source-root prefix. File-input reporting explicitly remains limited to selected resources rather than scanning the surrounding project.

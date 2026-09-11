# One-shot converter implementation

This replaces the earlier package/deployment design. The implemented scope is a script and a shared adapter inside `omp-hooks-plus`.

## Implementation

1. `src/claude.ts` holds the existing pure declaration parsing and matching helpers. `src/adapter.ts` registers the existing hook handlers with an injected settings provider. The live bridge retains discovery and trust checks; generated hooks supply fixed definitions instead.
2. `src/hook-context.ts` owns injection queues and duplicate suppression per adapter instance. Session changes and disposal invalidate stale asynchronous context deliveries.
3. `src/conversion-source.ts` statically inventories explicit source declarations, including unsupported handlers and scoped frontmatter. It reuses the existing parser only after inventory and reports Pi bindings without importing them.
4. `src/convert.ts` copies eligible resources and bundles the trusted adapter. It writes a report and publishes `index.ts` last in a new output directory. `bun run convert` is the only new package script; there are no new dependencies or packages.

## Verification

Run:

```sh
bun test
bun run typecheck
bun run build
```

Focused converter coverage is in `test/conversion-source.test.ts` and `test/convert.test.ts`. It exercises inventory completeness, malformed declarations, scoped YAML, traversal and symlink boundaries, non-execution during conversion, report redaction, existing-output protection, source-wide disabling, and explicit file-resource selection.

The generated-runtime test moves the output, deletes the source plugin, then loads the generated entrypoint through the real OMP extension loader and runner. It observes denial, rewritten tool input, and the script's active-project working directory/environment. Existing adapter tests cover context and lifecycle behavior. A separate CLI smoke check loads generated output in a fresh Bun process outside this repository after removing its source.

No test establishes arbitrary plugin equivalence or external script dependency closure. The converter reports unsupported declarations and dependencies rather than claiming that guarantee.

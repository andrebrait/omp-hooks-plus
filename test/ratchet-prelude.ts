// ponytail: installed OMP 18.4.6+ resolves sdk.ts's `./ratchet/prelude` to the text-imported
// prelude.js sibling, and plugins see both imports. Serve the TypeScript exports plus an empty
// default for the text import; ratchet's runtime prelude is unused here. Remove once
// can1357/oh-my-pi#13968 ships and the floor moves past it.
Bun.plugin({
  name: "omp-ratchet-prelude",
  setup(build) {
    build.onLoad({ filter: /\/@oh-my-pi\/pi-coding-agent\/src\/ratchet\/prelude\.js$/ }, () => ({
      contents: 'export * from "./prelude.ts"; export default "";',
      loader: "ts",
    }));
  },
});

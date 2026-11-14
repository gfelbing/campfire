import { defineConfig } from "vite";

// The client is embedded into the server binary (docs/arch/overview.md): base "/" so all
// asset URLs are origin-relative.
//
// `CAMPFIRE_DEBUG=1` (the `build:e2e` script) keeps the e2e debug hooks
// (`window.__campfire_users`, `__campfire_moq*`, polled by tools/e2e) in
// the bundle; a default build strips them at build time (C14).
const debug = process.env.CAMPFIRE_DEBUG === "1";

export default defineConfig({
  base: "/",
  define: {
    __CAMPFIRE_DEBUG__: JSON.stringify(debug),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // The entry chunk carries the app + the @moq stack (Pixi is already
    // dynamic-imported); it is embedded whole into the server binary, so
    // the 500 kB hint does not apply. 1000 kB keeps the canary for real
    // bloat.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        // zod (via @moq/*) writes `@__PURE__` annotations where Rollup
        // cannot parse them — the package targets esbuild, whose parser
        // accepts them. Rollup drops the comment and warns; the bundle
        // is correct, so keep the build log clean for our own sources.
        if (warning.code === "INVALID_ANNOTATION" && warning.id?.includes("node_modules/zod/")) {
          return;
        }
        defaultHandler(warning);
      },
    },
  },
  server: {
    port: 5173,
  },
});

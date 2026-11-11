import { defineConfig } from "vite";

// The client is embedded into the server binary (README §3): base "/" so all
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
  },
  server: {
    port: 5173,
  },
});

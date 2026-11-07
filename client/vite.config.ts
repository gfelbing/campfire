import { defineConfig } from "vite";

// The client is embedded into the server binary (README §3): base "/" so all
// asset URLs are origin-relative.
export default defineConfig({
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
  },
});

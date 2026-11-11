/** Build-time flag, set by Vite's `define` (see vite.config.ts): true only
 *  in the e2e client build (`npm run build:e2e`, `CAMPFIRE_DEBUG=1`). Gates
 *  the `window.__campfire_*` debug hooks (tools/e2e) out of the production
 *  bundle (C14). */
declare const __CAMPFIRE_DEBUG__: boolean;

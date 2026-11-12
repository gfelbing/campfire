// Re-apply the campfire publish patch to the installed @moq/publish bundle.
// Idempotent: a fresh `npm ci` restores the stock bundle, and the client's
// `postinstall` script runs this file to patch it again.
//
// Why: the stock video encoder writes `stalled: <detector flag>()` into its
// catalog on every detector observation (up to 50/s while the OpenH264
// encode queue flaps under headless/CPU load). In moq-lite a catalog change
// re-announces the hang, the relay re-routes, and every subscriber flips to
// a new track identity - each generation rebuilding its VideoEncoder
// (OpenH264 reinit storm). The campfire client does not read the `stalled`
// catalog field at all, so pin it to false: the detector keeps running
// internally, but the catalog content is stable, so no re-announce churn.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function die(msg) {
  console.error(`moq-publish patch: ${msg}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(
  here,
  "..",
  "..",
  "client",
  "node_modules",
  "@moq/publish",
  "encoder-rLv2ovr2.js",
);

const STOCK = "stalled: this.#l.flag()";
const PATCHED = "stalled: !1 // [campfire publish patch]";

let file = readFileSync(target, "utf8");
const already = file.split(PATCHED).length - 1;
const stock = file.split(STOCK).length - 1;
if (already > 0 && stock > 0) die(`mixed state: ${already} patched, ${stock} stock`);
if (stock === 0) {
  console.log(`@moq/publish patch: already present (${already} sites)`);
  process.exit(0);
}
if (stock !== 2) die(`expected exactly 2 stock occurrences, found ${stock}`);
file = file.split(STOCK).join(PATCHED);
writeFileSync(target, file);
console.log(`@moq/publish patch: ${stock} sites patched`);

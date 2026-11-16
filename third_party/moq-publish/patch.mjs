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

const STOCK_STALLED = "stalled: this.#l.flag()";
const PATCHED_STALLED = "stalled: !1 // [campfire publish patch]";
// [campfire latency] the capture AudioContext: "interactive" is 10-20 ms of
// output-buffer latency on most setups; 0 asks for the minimum
// (docs/dev/latency-optimization.md §7 finding 1).
const STOCK_HINT = 'latencyHint: "interactive"';
const PATCHED_HINT = "latencyHint: 0 /* [campfire latency] minimum output buffer */";

// (name, stock, patched, expected stock sites).
const R = [
  ["stalled catalog pin", STOCK_STALLED, PATCHED_STALLED, 2],
  ["capture latencyHint", STOCK_HINT, PATCHED_HINT, 1],
];

let file = readFileSync(target, "utf8");
let applied = 0;
let already = 0;
for (const [name, stock, patched, expected] of R) {
  const haveStock = file.split(stock).length - 1;
  const havePatched = file.split(patched).length - 1;
  if (havePatched > 0 && haveStock > 0) die(`${name}: mixed state (${havePatched} patched, ${haveStock} stock)`);
  if (haveStock === 0) {
    if (havePatched !== expected) die(`${name}: ${havePatched} patched sites, expected ${expected}`);
    already += havePatched;
    continue;
  }
  if (haveStock !== expected) die(`${name}: expected ${expected} stock occurrences, found ${haveStock}`);
  file = file.split(stock).join(patched);
  applied += expected;
}
writeFileSync(target, file);
console.log(`@moq/publish patch: ${applied} applied, ${already} already present`);

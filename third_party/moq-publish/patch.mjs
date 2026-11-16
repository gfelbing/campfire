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
// [campfire publish patch] The media-estimate module (jitter/delay of the
// encoded frames, shared by the audio and video encoders) writes its
// estimate into the catalog on ANY monotonic bump — one late frame during
// a CPU spike bumps it, the catalog change re-announces the hang, the SFU
// re-routes it, and every subscriber's encoder (and our own) rebuilds:
// the OpenH264 reinit storm. Rate-limit the writes to 1/s and require the
// estimate to grow by >= 25% before touching the catalog
// (docs/dev/latency-optimization.md §9.2.2).
const STOCK_FLUSH =
	"flush(e, t, n = performance.now() * 1e3) {\n\t\tlet r = n - e, i = t.observe(r, n), a = this.#e.observe(r, n), o = Math.ceil((r - a) / 1e3), s = Math.ceil((a - i) / 1e3);\n\t\treturn o <= this.#t && s <= this.#n ? !1 : (this.#t = Math.max(this.#t, o), this.#n = Math.max(this.#n, s), !0);\n\t}";
const PATCHED_FLUSH =
	"flush(e, t, n = performance.now() * 1e3) {\n\t\t// [campfire publish patch] Rate-limited + hysteretic estimate writes:\n\t\t// see the class comment. `this.#r` = last accepted write (µs).\n\t\tlet r = n - e, i = t.observe(r, n), a = this.#e.observe(r, n), o = Math.ceil((r - a) / 1e3), s = Math.ceil((a - i) / 1e3);\n\t\tif (o <= this.#t && s <= this.#n) return !1;\n\t\tif (n - this.#r < 1e6) return !1;\n\t\tif (o < this.#t * 1.25 && s < this.#n * 1.25) return !1;\n\t\tthis.#t = Math.max(this.#t, o), this.#n = Math.max(this.#n, s), this.#r = n;\n\t\treturn !0;\n\t}";
const STOCK_FIELDS = "#e = new ae();\n\t#t = 0;\n\t#n = 0;";
const PATCHED_FIELDS =
	"#e = new ae();\n\t#t = 0;\n\t#n = 0;\n\t// [campfire publish patch] last accepted estimate write, µs\n\t#r = 0;";

// (name, stock, patched, expected stock sites).
const R = [
  ["stalled catalog pin", STOCK_STALLED, PATCHED_STALLED, 2],
  ["capture latencyHint", STOCK_HINT, PATCHED_HINT, 1],
  ["estimate flush rate-limit", STOCK_FLUSH, PATCHED_FLUSH, 1],
  ["estimate fields", STOCK_FIELDS, PATCHED_FIELDS, 1],
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

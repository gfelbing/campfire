// Re-apply the campfire catch-up patch to the installed @moq/watch bundle
// (see PATCH.md). Idempotent: a fresh `npm ci` restores the stock bundle,
// and the client's `postinstall` script runs this file to patch it again.
//
// The audio worklet (both ring classes) lives inside an embedded Blob
// string literal in the player chunk, so the patch extracts the literal,
// applies exact-source replacements to the *unescaped* worklet source, and
// writes the literal back. Each replacement matches the stock code (exactly
// one occurrence) and is skipped when the patched form is already present.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function die(msg) {
  console.error(`moq-watch patch: ${msg}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(
  here,
  "..",
  "..",
  "client",
  "node_modules",
  "@moq/watch",
  "player-B6mw85kT.js",
);

// (name, stock source, patched source). The worklet source is tab-indented;
// snippets are written with \t / \n escapes so this file carries no raw
// control characters.
const R = [
  [
    "AudioRingBuffer: fractional cursor field",
    "\t#stalled = true;\n\t#buffered;\n\t#latencySamples;\n\t#anchored = false;\n\tconstructor(props) {",
    "\t#stalled = true;\n\t#buffered;\n\t#latencySamples;\n\t#anchored = false;\n\t// [campfire catch-up] Fractional read cursor: an integer cursor\n\t// cannot advance a fractional number of samples per output sample\n\t// while draining a backlog, so read() integrates on #readPosF and\n\t// floors it back into #readIndex.\n\t#readPosF = 0;\n\tconstructor(props) {"
  ],
  [
    "AudioRingBuffer.write: anchor the fractional cursor",
    "\t\tif (!this.#anchored) {\n\t\t\tthis.#readIndex = start;\n\t\t\tthis.#writeIndex = start;\n\t\t\tthis.#anchored = true;\n\t\t}",
    "\t\tif (!this.#anchored) {\n\t\t\tthis.#readIndex = start;\n\t\t\tthis.#writeIndex = start;\n\t\t\tthis.#readPosF = start; // [campfire catch-up]\n\t\t\tthis.#anchored = true;\n\t\t}"
  ],
  [
    "AudioRingBuffer.write: overflow advances the fractional cursor",
    "\t\tconst overflow = end - this.#readIndex - this.#buffer[0].length;\n\t\tif (overflow >= 0) {\n\t\t\tthis.#stalled = false;\n\t\t\tthis.#readIndex += overflow;\n\t\t}",
    "\t\tconst overflow = end - this.#readIndex - this.#buffer[0].length;\n\t\tif (overflow >= 0) {\n\t\t\tthis.#stalled = false;\n\t\t\tthis.#readIndex += overflow;\n\t\t\tthis.#readPosF += overflow; // [campfire catch-up]\n\t\t}"
  ],
  [
    "AudioRingBuffer.#reallocate: keep the fractional cursor",
    "\t\tthis.#buffer = newBuffer;\n\t\tthis.#readIndex = this.#writeIndex - samplesToKeep;\n\t\tif (samplesToKeep === 0) this.#stalled = true;",
    "\t\tthis.#buffer = newBuffer;\n\t\tthis.#readIndex = this.#writeIndex - samplesToKeep;\n\t\tthis.#readPosF = this.#readIndex; // [campfire catch-up]\n\t\tif (samplesToKeep === 0) this.#stalled = true;"
  ],
  [
    "AudioRingBuffer.reset: clear the fractional cursor",
    "\treset() {\n\t\tthis.#readIndex = 0;\n\t\tthis.#writeIndex = 0;\n\t\tthis.#stalled = true;\n\t\tthis.#anchored = false;\n\t}",
    "\treset() {\n\t\tthis.#readIndex = 0;\n\t\tthis.#writeIndex = 0;\n\t\tthis.#readPosF = 0; // [campfire catch-up]\n\t\tthis.#stalled = true;\n\t\tthis.#anchored = false;\n\t}"
  ],
  [
    "AudioRingBuffer.read: time-compression catch-up",
    "\tread(output) {\n\t\tif (output.length !== this.channels) throw new Error(\"wrong number of channels\");\n\t\tif (this.#stalled) return 0;\n\t\tconst samples = Math.min(this.#writeIndex - this.#readIndex, output[0].length);\n\t\tif (samples === 0) return 0;\n\t\tfor (let channel = 0; channel < this.channels; channel++) {\n\t\t\tconst dst = output[channel];\n\t\t\tconst src = this.#buffer[channel];\n\t\t\tif (dst.length !== output[0].length) throw new Error(\"mismatching number of samples\");\n\t\t\tfor (let i = 0; i < samples; i++) {\n\t\t\t\tconst readPos = (this.#readIndex + i) % src.length;\n\t\t\t\tdst[i] = src[readPos];\n\t\t\t}\n\t\t}\n\t\tthis.#readIndex += samples;\n\t\treturn samples;\n\t}",
    "\tread(output) {\n\t\tif (output.length !== this.channels) throw new Error(\"wrong number of channels\");\n\t\tif (this.#stalled) return 0;\n\t\t// [campfire catch-up] While the backlog (WRITE - READ) exceeds the\n\t\t// latency floor, drain it faster instead of skipping: consume\n\t\t// `rate` source samples per output sample, linearly interpolated on\n\t\t// the fractional read cursor. rate = 1 + excess/latency, capped at\n\t\t// 2.5; below the floor this is exactly the stock 1:1 copy. Time\n\t\t// compression without time-stretching raises pitch with the rate\n\t\t// (2x = +1 octave); accepted for a bounded catch-up transient.\n\t\tconst outLen = output[0].length;\n\t\tconst ahead = this.#writeIndex - this.#readPosF;\n\t\tif (ahead <= 0) return 0;\n\t\tconst excess = ahead - this.#latencySamples;\n\t\tlet rate = excess > 0 ? Math.min(1 + excess / this.#latencySamples, 2.5) : 1;\n\t\tif (rate > 1 && ahead < outLen) rate = ahead / outLen;\n\t\tconst consume = outLen * rate;\n\t\tfor (let channel = 0; channel < this.channels; channel++) {\n\t\t\tconst dst = output[channel];\n\t\t\tconst src = this.#buffer[channel];\n\t\t\tif (dst.length !== outLen) throw new Error(\"mismatching number of samples\");\n\t\t\tfor (let i = 0; i < outLen; i++) {\n\t\t\t\tconst pos = this.#readPosF + i * rate;\n\t\t\t\tconst idx = Math.floor(pos);\n\t\t\t\tconst frac = pos - idx;\n\t\t\t\tconst a = src[idx % src.length];\n\t\t\t\tconst b = idx + 1 < this.#writeIndex ? src[(idx + 1) % src.length] : a;\n\t\t\t\tdst[i] = a + (b - a) * frac;\n\t\t\t}\n\t\t}\n\t\tthis.#readPosF += consume;\n\t\tthis.#readIndex = Math.floor(this.#readPosF);\n\t\treturn outLen;\n\t}"
  ],
  [
    "SharedRingBuffer: fractional cursor + epoch fields",
    "\t#anchored = false;\n\t#anchor = 0;\n\t#position = 0;\n\t#lastRead = 0;",
    "\t#anchored = false;\n\t#anchor = 0;\n\t#position = 0;\n\t#lastRead = 0;\n\t// [campfire catch-up] Fractional read cursor for the speed-up in\n\t// read(), plus the playhead epoch it was written under: any writer\n\t// step (re-anchor, truncate, deeper latency floor) invalidates it\n\t// and forces a re-sync from the shared playhead.\n\t#readPosF = 0;\n\t#lastEpoch = -1;"
  ],
  [
    "SharedRingBuffer.constructor: snapshot epoch and cursor together",
    "\t\tfor (let i = 0; i < this.channels; i++) this.#samples.push(new Float32Array(init.samples, i * this.capacity * Float32Array.BYTES_PER_ELEMENT, this.capacity));\n\t\tif (previous !== void 0) this.#handoff(previous);\n\t}",
    "\t\tfor (let i = 0; i < this.channels; i++) this.#samples.push(new Float32Array(init.samples, i * this.capacity * Float32Array.BYTES_PER_ELEMENT, this.capacity));\n\t\tif (previous !== void 0) this.#handoff(previous);\n\t\t// [campfire catch-up] One snapshot for both the epoch and the\n\t\t// playhead: loaded separately they can straddle a writer re-anchor,\n\t\t// in which case the playhead belongs to the old epoch and poisons\n\t\t// the cursor past WRITE on the fresh timeline.\n\t\t{\n\t\t\tconst s = Atomics.load(this.#state, 0);\n\t\t\tthis.#lastEpoch = epochOf(s);\n\t\t\tthis.#readPosF = readOf(s);\n\t\t}\n\t}"
  ],
  [
    "SharedRingBuffer.read: time-compression catch-up (epoch resync + no skip)",
    "\tread(output) {\n\t\tconst state = Atomics.load(this.#state, 0);\n\t\tif (Atomics.load(this.#control, STALLED) === 1) return 0;\n\t\tif (retreating(state)) return 0;\n\t\tlet read = readOf(state);\n\t\tconst write = Atomics.load(this.#control, WRITE);\n\t\tconst latency = Atomics.load(this.#control, LATENCY);\n\t\tconst buffered = write - read | 0;\n\t\tif (!this.buffered && latency > 0 && buffered > latency) {\n\t\t\tconst skipTo = write - latency | 0;\n\t\t\tif ((skipTo - read | 0) > 0) read = skipTo;\n\t\t}\n\t\tconst available = write - read | 0;\n\t\tconst count = Math.min(available, output[0].length);\n\t\tif (count <= 0) {\n\t\t\tif ((read - readOf(state) | 0) > 0) Atomics.compareExchange(this.#state, 0, state, pack(epochOf(state), read));\n\t\t\treturn 0;\n\t\t}\n\t\tfor (let channel = 0; channel < this.channels; channel++) {\n\t\t\tconst src = this.#samples[channel];\n\t\t\tconst dst = output[channel];\n\t\t\tfor (let i = 0; i < count; i++) dst[i] = src[slot(read + i | 0, this.capacity)];\n\t\t}\n\t\tconst next = pack(epochOf(state), read + count | 0);\n\t\tif (Atomics.compareExchange(this.#state, 0, state, next) !== state) {\n\t\t\tfor (let channel = 0; channel < this.channels; channel++) output[channel].fill(0, 0, count);\n\t\t\treturn 0;\n\t\t}\n\t\treturn count;\n\t}",
    "\tread(output) {\n\t\tconst state = Atomics.load(this.#state, 0);\n\t\tif (Atomics.load(this.#control, STALLED) === 1) return 0;\n\t\tif (retreating(state)) return 0;\n\t\t// [campfire catch-up] The writer steps the playhead epoch on a\n\t\t// re-anchor, a truncate, or a deeper latency floor; a cursor from\n\t\t// the previous epoch belongs to a dead timeline. Resync the local\n\t\t// fractional cursor to the current shared playhead, otherwise a\n\t\t// stale cursor lands past WRITE, ahead goes negative, and read()\n\t\t// returns nothing forever.\n\t\tif (epochOf(state) !== this.#lastEpoch) {\n\t\t\tthis.#lastEpoch = epochOf(state);\n\t\t\tthis.#readPosF = readOf(Atomics.load(this.#state, 0));\n\t\t} else {\n\t\t\tconst read = readOf(state);\n\t\t\tif ((read - this.#readPosF | 0) > 0) this.#readPosF = read;\n\t\t}\n\t\tconst write = Atomics.load(this.#control, WRITE);\n\t\tconst latency = Atomics.load(this.#control, LATENCY);\n\t\tconst outLen = output[0].length;\n\t\tconst ahead = (write - (this.#readPosF | 0)) | 0;\n\t\tif (ahead <= 0) return 0;\n\t\t// [campfire catch-up] The stock code skips the backlog in\n\t\t// non-buffered mode (audio dropped at read time). Instead: while the\n\t\t// backlog exceeds the latency floor, drain it faster - consume\n\t\t// rate source samples per output sample, linearly interpolated on\n\t\t// the fractional read cursor. rate = 1 + excess/latency, capped at\n\t\t// 2.5; below the floor this is the stock 1:1 copy. Time\n\t\t// compression raises pitch with the rate; accepted for a bounded\n\t\t// transient.\n\t\tconst excess = ahead - latency;\n\t\tlet rate = excess > 0 ? Math.min(1 + excess / latency, 2.5) : 1;\n\t\tif (rate > 1 && ahead < outLen) rate = ahead / outLen;\n\t\tconst consume = outLen * rate;\n\t\tfor (let channel = 0; channel < this.channels; channel++) {\n\t\t\tconst src = this.#samples[channel];\n\t\t\tconst dst = output[channel];\n\t\t\tfor (let i = 0; i < outLen; i++) {\n\t\t\t\tconst pos = this.#readPosF + i * rate;\n\t\t\t\tconst idx = Math.floor(pos) | 0;\n\t\t\t\tconst frac = pos - idx;\n\t\t\t\tconst a = src[slot(idx, this.capacity)];\n\t\t\t\tconst b = idx + 1 < write ? src[slot(idx + 1, this.capacity)] : a;\n\t\t\t\tdst[i] = a + (b - a) * frac;\n\t\t\t}\n\t\t}\n\t\t// [campfire catch-up] Publish the advance only when the exchange\n\t\t// wins: on failure the writer moved the epoch, and keeping the\n\t\t// local cursor where it was lets the next read resync cleanly.\n\t\tconst next = pack(epochOf(state), Math.floor(this.#readPosF + consume) | 0);\n\t\tif (Atomics.compareExchange(this.#state, 0, state, next) !== state) {\n\t\t\tfor (let channel = 0; channel < this.channels; channel++) output[channel].fill(0, 0, outLen);\n\t\t\treturn 0;\n\t\t}\n\t\tthis.#readPosF += consume;\n\t\treturn outLen;\n\t}"
  ]
];

// Main-bundle (decoder) replacements, applied to the player chunk text
// itself (not the worklet blob).
const M = [
  [
    "#g: bounded pacing wait (re-anchor on stalled playhead)",
    "\t\t\tif (await this.#n?.wait(i.timestamp, e.abort), t.state === \"closed\") return !1;",
    "\t\t\t{ // [campfire catch-up] Bounded pacing wait. Stock waits until the ring playhead\n\t\t\t// reaches the frame's timestamp minus headroom. If the container consumer\n\t\t\t// skipped ahead by more than the headroom (a gap in the media timeline),\n\t\t\t// the ring drains, the playhead never arrives, and the wait blocks\n\t\t\t// forever (audio flatline). On a 2000 ms grace expiry with the playhead\n\t\t\t// still more than a second behind, reset the ring: the next insert\n\t\t\t// re-anchors the playhead at this frame's timestamp, so playback skips\n\t\t\t// the (already dropped) gap instead of stalling.\n\t\t\t\tlet cfUp = !1;\n\t\t\t\tconst cfWait = this.#n?.wait(i.timestamp, e.abort);\n\t\t\t\tcfWait?.catch(() => {});\n\t\t\t\tconst cfT = setTimeout(() => { cfUp = !0; }, 2000);\n\t\t\t\tawait Promise.race([cfWait, new Promise((s) => setTimeout(s, 2000))]).catch(() => {});\n\t\t\t\tclearTimeout(cfT);\n\t\t\t\tif (cfUp && this.#n && t.state !== \"closed\") {\n\t\t\t\t\tconst cfPh = this.#n.timestamp.peek();\n\t\t\t\t\tif (cfPh == null || i.timestamp - cfPh > 1000000) this.#n.reset();\n\t\t\t\t}\n\t\t\t}\n\t\t\tif (t.state === \"closed\") return !1;"
  ]
];

// --- apply ------------------------------------------------------------------
let file = readFileSync(target, "utf8");
// The worklet is embedded as: new Blob(["<source>"], { type:
// "application/javascript" }).
const m = file.match(/new Blob\(\["([\s\S]*?)"\], \{ type: "application\/javascript" \}\)/);
if (!m) die("worklet blob literal not found - the @moq/watch bundle layout changed");
// The literal body is a JS string, not JSON: it contains raw tab characters
// (legal in a JS string, illegal in a JSON string). Escape any control
// character (below 0x20) before parsing; the worklet source has no JS-only
// escapes (verified), so the remaining sequences are all valid JSON.
let worklet = JSON.parse(
  `"${m[1].replace(/[\x00-\x1f]/g, (c) =>
    c === "\t" ? "\\t" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}"`,
);
if (!worklet.includes("var AudioRingBuffer") || !worklet.includes("var SharedRingBuffer") || !worklet.includes("registerProcessor")) {
  die("extracted blob does not look like the audio worklet");
}
let applied = 0;
let already = 0;
for (const [name, stock, patched] of R) {
  if (worklet.includes(patched)) {
    already++;
    continue;
  }
  const n = worklet.split(stock).length - 1;
  if (n !== 1) die(`${name}: expected exactly 1 stock occurrence, found ${n}`);
  worklet = worklet.split(stock).join(patched);
  applied++;
}
// Main-bundle replacements (same stock/patched convention as R).
let mApplied = 0;
let mAlready = 0;
for (const [name, stock, patched] of M) {
  if (file.includes(patched)) {
    mAlready++;
    continue;
  }
  const n = file.split(stock).length - 1;
  if (n !== 1) die(`${name}: expected exactly 1 stock occurrence, found ${n}`);
  file = file.split(stock).join(patched);
  mApplied++;
}
const literal = `new Blob(["${JSON.stringify(worklet).slice(1, -1)}"], { type: "application/javascript" })`;
writeFileSync(target, file.split(m[0]).join(literal));
console.log(`@moq/watch catch-up patch: worklet ${applied} applied, ${already} already present; main ${mApplied} applied, ${mAlready} already present`);

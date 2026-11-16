#!/usr/bin/env node
/**
 * MoQ call E2E (docs/arch/moq-sfu.md): real browser ↔ SFU, both
 * directions.
 *
 * Drives the real client in headless Brave/Chromium with fake media:
 *   1. both pages auto-join via `/?room=…&name=…` and stand still on the
 *      spawn tile, so the server's bubble engine pulls them into a call;
 *   2. each client opens one MoQ session on `/moq/{ticket}` carrying the
 *      uplink (announces `call/<room>/<user-id>.hang`) and every downlink —
 *      asserted via the `window.__campfire_moq` / `window.__campfire_moq_down`
 *      debug hooks, and the uplink send-rate estimate (`__campfire_moq.stats`)
 *      the video encoders scale against;
 *   3. the downlinks must render: decoded video frames, received audio
 *      bytes, and the playback delay/jitter within a sane budget;
 *   4. the SFU's own `/metrics` object counter must have moved;
 *   5. B shares their screen (fake display, headless): A must gain a
 *      screen tile and decode its `s` rendition, while B's camera and
 *      audio keep flowing underneath (the screen hangs on its own
 *      `*.screen.hang`, so the share never stalls them); stopping the
 *      share drops the tile without touching camera/audio;
 *   6. B mutes / camera-off: A's tile must show the presence badges, and
 *      the camera-off must stop video delivery (rendition omitted);
 *   7. A refreshes the tab: the token re-join must restore the identity,
 *      relive A's uplink, and B's downlink to A must follow the
 *      re-announced broadcast;
 *   8. B walks away and leaves the room, the call ends, and A's session
 *      stops.
 *
 * The dev server (port 8443) must be running, like `just e2e`.
 *
 * Usage: node tools/e2e/moq.js [--url https://localhost:8443] [--browser /path]
 */

const puppeteer = require("puppeteer-core");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

// The dev cert's SPKI sha-256 (base64, the `just spki` recipe) — what
// `--ignore-certificate-errors-spki-list` wants. Chromium trusts only its
// built-in roots for QUIC: a user-installed CA is accepted for TCP but fails
// the QUIC handshake (CERTIFICATE_VERIFY_FAILED under the hood), so the dev
// cert is pinned by SPKI instead (the `brave` recipe, docs/dev/testing.md).
// Missing certs (running against a non-dev server): no pin.
const DEV_CERT = "certs/cert.pem";
function devCertSpki() {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(DEV_CERT));
    return crypto
      .createHash("sha256")
      .update(cert.publicKey.export({ type: "spki", format: "der" }))
      .digest("base64");
  } catch {
    return null;
  }
}
const fs = require("node:fs");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = arg("url", "https://localhost:8443");
const hostport = new URL(URL_BASE).host;
// Unique per run: earlier runs' sessions may still sit in the server's
// reconnect window / QUIC idle timeout, so shared names would be ambiguous.
const STAMP = Date.now().toString(36).slice(-5);
const NAME_A = `moqa-${STAMP}`;
const NAME_B = `moqb-${STAMP}`;
const BROWSER = arg("browser", "brave");
const ROOM = arg("room", "island");
// Latency budget for the downlink playback delay and jitter-buffer depth
// (a sanity bound, docs/arch/moq-sfu.md). The audio budget override (see
// evaluateOnNewDocument) adds to the tile delay by design, so the gate
// scales with it.
const AUDIO_MS_OVERRIDE = 600;
const MAX_LATENCY_MS = 1000 + AUDIO_MS_OVERRIDE;
// Soak (issues.md issue 8.6): minutes to hold the call before the teardown
// step; 0 (unset) skips the soak. E2E_SERVER_LOG / E2E_SERVER_PID enable the
// server-side assertions (panic grep, RSS gate) against a known process.
const SOAK_MIN = Number(process.env.E2E_SOAK_MIN || 0);
const SOAK_LOG = process.env.E2E_SERVER_LOG || "";
const SOAK_PID = process.env.E2E_SERVER_PID || "";

// --- audio intelligibility test --------------------------------------------
// The fake audio device plays a WAV file *as the microphone*
// (--use-file-for-fake-audio-capture, loops), so both tabs publish the
// same known signal through the real MoQ pipeline. The e2e client's
// recorder hook (moq.ts attachRecorder) taps each downlink's decoded PCM;
// the harness then verifies continuity (no gaps) and content
// (normalized cross-correlation with the source envelope) — the
// "understandable" proxy (docs/dev/latency-optimization.md §9).
const AUDIO_CAPTURE_MS = 8000;
const AUDIO_CORR_MIN = 0.7;
const AUDIO_GAP_MAX_MS = 150;
// Tile delay sanity bound (runaway detector only): the environment's
// transport lag fluctuates 600-2300 ms run-to-run (headless software
// rendering + catch-up drain transients), so a tight gate here would
// fail on environment noise, not on the pipeline. The content and
// continuity assertions above are the real check.
const AUDIO_DELAY_MAX_MS = 4000;
// Loop drift (source-offset delta between two correlation anchors in
// one recording): how much buffering the path added or shed mid-stream.
const AUDIO_DRIFT_MAX_MS = 300;

/** Synthesize a static 2-frame 320×240 I420 y4m for the fake *video*
 *  device (`--use-file-for-fake-video-capture`): Chromium's generated
 *  fake device renders animated content in the browser process and, at
 *  two tabs, eats multiple cores there — which pushed the whole
 *  transport ~800 ms behind the live edge and made any latency-sensitive
 *  assertion meaningless. A static file capture is nearly free. */
function generateTestY4m() {
  const W = 320;
  const H = 240;
  const frame = Buffer.alloc(W * H * 1.5, 128);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      frame[y * W + x] = (x + y) % 256;
    }
  }
  const header = `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`;
  const y4m = Buffer.concat([
    Buffer.from(header),
    Buffer.from("FRAME\n"),
    frame,
    Buffer.from("FRAME\n"),
    frame,
  ]);
  const y4mPath = path.join(
    os.tmpdir(),
    `campfire-e2e-video-${Date.now().toString(36)}.y4m`,
  );
  fs.writeFileSync(y4mPath, y4m);
  return y4mPath;
}

/** Synthesize a speech-like WAV (48 kHz, mono, PCM16, `seconds` long):
 *  syllable bursts — a 4/s train of 150 ms tones (300–1200 Hz per
 *  syllable, fundamental + octave) with shaped attack/decay and a low
 *  noise floor. Correlatable, and by construction continuous: any gap in
 *  the received copy is the pipeline's, not the source's. */
function generateTestWav(seconds) {
  const rate = 48000;
  const n = seconds * rate;
  const pcm = new Int16Array(n);
  let seed = 0x2545f491;
  const rand = () => {
    seed = (1103515245 * seed + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const syllables = 4; // per second
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const pos = (t * syllables) % 1;
    // 150 ms voiced burst, shaped, then 100 ms quiet.
    let env = 0;
    if (pos < 0.15) {
      const u = pos / 0.15;
      env = Math.sin(Math.PI * Math.min(u, 1)) ** 2;
    }
    const syllableIndex = Math.floor(t * syllables);
    const freq = 300 + (syllableIndex * 97) % 900; // deterministic per syllable
    const voiced =
      env *
      (0.5 * Math.sin(2 * Math.PI * freq * t) +
        0.3 * Math.sin(2 * Math.PI * freq * 2 * t) +
        0.2 * Math.sin(2 * Math.PI * freq * 3 * t));
    const noise = 0.02 * rand();
    const v = Math.max(-1, Math.min(1, 0.6 * (voiced + noise * env)));
    pcm[i] = Math.round(v * 32767);
  }
  // WAV header + data (PCM16 mono).
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + n * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(n * 2, 40);
  const buf = Buffer.concat([header, Buffer.from(pcm.buffer)]);
  const wavPath = path.join(
    os.tmpdir(),
    `campfire-e2e-audio-${Date.now().toString(36)}.wav`,
  );
  fs.writeFileSync(wavPath, buf);
  return { wavPath, seconds };
}

/** Rectified, ~1 kHz envelope of a Float32 signal. */
function envelope(samples, rate) {
  const win = Math.max(1, Math.round(rate / 1000));
  const out = new Float32Array(Math.floor(samples.length / win));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < win; j++) sum += Math.abs(samples[i * win + j] || 0);
    out[i] = sum / win;
  }
  return out;
}

/** Best normalized cross-correlation of `needle` against `haystack` with
 *  the offset in the haystack (the recording starts mid-file, wherever
 *  the downlink wired). Returns {offset, score}. */
function bestCorrelation(needle, haystack) {
  const mean = (a) => {
    let s = 0;
    for (const v of a) s += v;
    return s / a.length;
  };
  const nh = mean(needle);
  const nn = mean(haystack);
  let best = -Infinity;
  let bestAt = 0;
  for (let off = 0; off + needle.length <= haystack.length; off++) {
    let dot = 0;
    let eH = 0;
    let eN = 0;
    for (let i = 0; i < needle.length; i++) {
      const h = haystack[off + i] - nh;
      const n = needle[i] - nn;
      dot += h * n;
      eH += h * h;
      eN += n * n;
    }
    const score = dot / Math.sqrt(eH * eN + 1e-12);
    if (score > best) {
      best = score;
      bestAt = off;
    }
  }
  return { offset: bestAt, score: best };
}

/** Longest run of near-silence in an envelope AFTER the first voiced
 *  sample (ms at ~1 kHz): the recording starts in the ring's silent
 *  warmup, which is not a disruption — only gaps between voiced
 *  stretches are. */
function longestGap(env) {
  let median = [...env].sort((a, b) => a - b)[Math.floor(env.length / 2)];
  if (!median) return 0;
  const threshold = median * 0.05;
  let firstVoiced = 0;
  while (firstVoiced < env.length && env[firstVoiced] < threshold) firstVoiced++;
  let longest = 0;
  let run = 0;
  for (let i = firstVoiced; i < env.length; i++) {
    if (env[i] < threshold) {
      run++;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return Math.round((longest / 1000) * 1000); // env is ~1 kHz
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const audio = generateTestWav(AUDIO_CAPTURE_MS / 1000 + 2); // 2 s of alignment headroom
const video = generateTestY4m();

async function waitUntil(fn, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let last;
  let lastErr;
  while (Date.now() < end) {
    try {
      last = await fn();
      lastErr = null;
      if (last) return last;
    } catch (err) {
      // page navigating / not ready yet
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(
    `timeout waiting for ${what} (last: ${JSON.stringify(last)}${lastErr ? `, error: ${lastErr.message}` : ""})`,
  );
}

// --- soak helpers (issues.md issue 8.6) ------------------------------------

/** One `name <value>` counter from the SFU's /metrics (page fetch: the
 *  endpoint rides the joined session's auth), or null when absent. */
async function metricValue(page, name) {
  const text = await page.evaluate(async (n) => {
    const res = await fetch("/metrics");
    return res.text();
  }, name);
  const m = text.match(new RegExp(`^${name} (\\d+)`, "m"));
  return m ? Number(m[1]) : null;
}

/** Byte offset of the server log (null when E2E_SERVER_LOG is unset). */
function logOffset() {
  if (!SOAK_LOG || !fs.existsSync(SOAK_LOG)) return null;
  return fs.statSync(SOAK_LOG).size;
}

/** Log lines appended after `offset` (empty when tracking is disabled). */
function logSince(offset) {
  if (offset == null || !SOAK_LOG) return [];
  const fd = fs.openSync(SOAK_LOG, "r");
  try {
    const len = Math.max(0, fs.fstatSync(fd).size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return buf.toString("utf8").split("\n").filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

/** VmRSS of the server process in kB (null when E2E_SERVER_PID is unset). */
function rssKb() {
  if (!SOAK_PID) return null;
  try {
    const s = fs.readFileSync(`/proc/${SOAK_PID}/status`, "utf8");
    const m = s.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** `window.__campfire_moq` (the session debug hook), or undefined. */
const moqHook = (page) => page.evaluate(() => window.__campfire_moq);

/** Does the presence row of `name` carry the 🎧 in-call badge? */
const badgeFor = (page, name) =>
  page.evaluate((needle) => {
    for (const li of document.querySelectorAll(".presence-list li")) {
      const label = li.querySelector(".presence-name")?.textContent ?? "";
      if (label.includes(needle)) return !!li.querySelector(".presence-call");
    }
    return false;
  }, name);

/** The page's single downlink view (`window.__campfire_moq_down`), or
 *  null while there is not exactly one. */
const soleDown = (page) =>
  page.evaluate(() => {
    const h = window.__campfire_moq_down;
    if (!h) return null;
    const keys = Object.keys(h);
    return keys.length === 1 ? h[keys[0]] : null;
  });

const presenceNames = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".presence-name")].map((e) => e.textContent),
  );

/** The call column's state label ("live", "subscribing…", …). */
const theaterState = (page) =>
  page.evaluate(() => document.querySelector(".theater-state")?.textContent ?? null);

/** The call bar button's state classes, or null when the call bar is not
 *  in the DOM. `cls` is `mute` | `camera` | `screen` (the topbar buttons
 *  are `#mic-btn` / `#cam-btn` / `#screen-btn`; mic/camera carry `off`
 *  while inactive, screen carries `on` while sharing). */
const callBtn = (page, cls) =>
  page.evaluate((c) => {
    const sel = { mute: "#mic-btn", camera: "#cam-btn", screen: "#screen-btn" }[c];
    const el = document.querySelector(sel);
    if (!el) return null;
    return { off: el.classList.contains("off"), on: el.classList.contains("on") };
  }, cls);

/** Does A's camera tile for `name` show the badge (`.tile-mute` /
 *  `.tile-cam`)? */
const tileBadge = (page, name, badgeSel) =>
  page.evaluate(([needle, sel]) => {
    for (const tile of document.querySelectorAll(".theater-tile:not(.local):not(.screen)")) {
      const label = tile.querySelector(".tile-name")?.textContent ?? "";
      if (label.includes(needle)) {
        const el = tile.querySelector(sel);
        return el ? !el.classList.contains("hidden") : false;
      }
    }
    return false;
  }, [name, badgeSel]);

/** Number of screen-share tiles the page shows. */
const screenTiles = (page) =>
  page.evaluate(() => document.querySelectorAll(".theater-tile.screen").length);

/** The downlink must be live with decoded video, received audio, and the
 *  playback delay / jitter buffer within budget. */
async function assertDownlinkLive(page, label, timeoutMs) {
  // A freshly subscribed downlink first plays the SFU's cached groups
  // (catch-up): the delay starts high and falls to steady state. Poll
  // until it is live with video + audio AND the delay/jitter have
  // converged within budget — sampling the first live frame would read
  // the catch-up peak, not the steady state.
  try {
    return await waitUntil(async () => {
      const d = await soleDown(page);
      const ok =
        d &&
        d.status === "live" &&
        d.frames >= 5 &&
        d.audioBytes > 0 &&
        Number.isFinite(d.delay) &&
        d.delay >= 0 &&
        d.delay <= MAX_LATENCY_MS &&
        Number.isFinite(d.jitter) &&
        d.jitter >= 0 &&
        d.jitter <= MAX_LATENCY_MS;
      return ok ? d : undefined;
    }, `${label}: downlink live with video + audio within latency budget`, timeoutMs ?? 30_000);
  } catch (e) {
    const d = await soleDown(page);
    throw new Error(`${label}: ${e.message} (last downlink: ${JSON.stringify(d)})`);
  }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: true,
    // Forward the browser process's stderr: a renderer crash (GPU, OOM)
    // prints its signature there, which is what makes a mid-run page death
    // diagnosable.
    dumpio: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // docs/dev/testing.md: fake media, no permission prompts.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      // The fake mic plays our test file as the "microphone"; the fake
      // camera renders our static y4m (the generated fake device burns
      // multiple cores in the browser process, see generateTestY4m).
      `--use-file-for-fake-audio-capture=${audio.wavPath}`,
      `--use-file-for-fake-video-capture=${video}`,
      // Dev cert: headless over TCP must skip the interstitial.
      "--ignore-certificate-errors",
      // ...and the SPKI pin makes the QUIC handshake pass too (see
      // devCertSpki above).
      ...(devCertSpki() ? [`--ignore-certificate-errors-spki-list=${devCertSpki()}`] : []),
      // WebAudio: the audio encoder pumps through an AudioContext, which
      // browsers suspend until a user gesture — headless has none.
      "--autoplay-policy=no-user-gesture-required",
      // Force the HTTP/3 path (the dev server has no Alt-Svc history).
      `--origin-to-force-quic-on=${hostport}`,
      "--enable-features=WebTransportAllowThreaded",
    ],
  });
  let failed = false;
  try {
    // Two separate browser contexts: storage (localStorage with the saved
    // identity) is per-context, and boot prefers the stored name over the
    // `?name=` param — one shared context would make B re-join as A.
    const contextA = await browser.createBrowserContext();
    const contextB = await browser.createBrowserContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    // Small viewports: the headless pages render the Pixi map in software
    // WebGL — the fill rate scales with the viewport, and a saturated page
    // is what pushed the audio transport behind the live edge in earlier
    // runs (the live-playback maxAge then correctly drops every frame).
    for (const page of [pageA, pageB]) {
      await page.setViewport({ width: 320, height: 240 });
    }
    const pageErrors = [];
    for (const [label, page] of [["A", pageA], ["B", pageB]]) {
      page.on("pageerror", (e) => {
        pageErrors.push(`[${label}] ${e.message}`);
        console.error(`page${label} error:`, e.message);
        // First stack frame(s) beyond the message: pageerror is an Error,
        // and the frame that threw is what makes this actionable.
        const frames = (e.stack ?? "").split("\n").slice(1, 4).join(" | ");
        if (frames) console.error(`page${label} stack: ${frames}`);
      });
      page.on("crash", () => {
        console.error(`page${label} CRASHED (renderer gone)`);
      });
      // Puppeteer fires "close" when the page's target goes away —
      // renderer crash or navigation; mid-run it is the death notice.
      page.on("close", () => {
        console.error(`page${label} CLOSED (crash or navigation)`);
      });
      page.on("console", (msg) => {
        const text = msg.text();
        if (text.startsWith("[encdiag]")) console.log(`page${label}: ${text}`);
      });
      // Arm the audio-quality recorder before any navigation: the flag
      // must be set when the downlink's audio graph first wires.
      page.evaluateOnNewDocument(() => {
        window.__campfire_record = true;
        window.__campfire_record_ms = 8000;
        window.__campfire_audio_data = {};
        window.__campfire_record_done = {};
        // Video budget override: 320x240 (see moq.ts) — software H264 at
        // 800x600 in two headless tabs eats ~4 cores in reinit storms and
        // pushes the transport ~800 ms behind the live edge.
        window.__campfire_video_maxpx = 320 * 240;
        // Audio budget override for this environment (moq.ts): the
        // headless pipeline delivers audio with ~150–200 ms of transport
        // lag even on an idle page (software rendering + fake-device
        // capture) — beyond the production 40 ms target, live playback
        // correctly drops frames older than maxAge, and a fidelity
        // recording under that budget would only document that dropping.
        // 120 ms target + 480 ms of buffer fits the environment with
        // margin.
        window.__campfire_audio_ms = 200;
      });
    }

    // Optional encoder diagnostic (E2E_DIAG=1): wrap VideoEncoder.configure
    // on both pages to log every (re)configure's params + a short stack, so
    // an oscillating config (the OpenH264 reinit churn) is identifiable.
    if (process.env.E2E_DIAG === "1") {
      for (const [label, page] of [["A", pageA], ["B", pageB]]) {
        await page.evaluateOnNewDocument(() => {
          const seen = new Map();
          window.__veConstructs = 0;
          window.__veCloses = 0;
          const OrigVE = VideoEncoder;
          function VEWrapped(...args) {
            window.__veConstructs++;
            return Reflect.construct(OrigVE, args);
          }
          VEWrapped.prototype = OrigVE.prototype;
          VEWrapped.isConfigSupported = OrigVE.isConfigSupported;
          globalThis.VideoEncoder = VEWrapped;
          const origClose = OrigVE.prototype.close;
          OrigVE.prototype.close = function () {
            window.__veCloses++;
            return origClose.call(this);
          };
          const orig = OrigVE.prototype.configure;
          VideoEncoder.prototype.configure = function (cfg) {
            const sig = JSON.stringify([
              cfg?.codec,
              cfg?.width,
              cfg?.height,
              cfg?.framerate,
              cfg?.bitrate,
            ]);
            seen.set(sig, (seen.get(sig) ?? 0) + 1);
            const n = seen.get(sig);
            if (n === 1 || n % 20 === 0) {
              console.log(
                `[encdiag] configure #${n} (constructs=${window.__veConstructs}, closes=${window.__veCloses}) ${sig}`,
              );
            }
            return orig.call(this, cfg);
          };
          window.__encCfgSigs = () =>
            Object.fromEntries(
              [...seen.entries()].sort((a, b) => b[1] - a[1]),
            );
          window.__aeEncodes = 0;
          window.__aeOutputs = 0;
          const origEncode = AudioEncoder.prototype.encode;
          AudioEncoder.prototype.encode = function (f) {
            window.__aeEncodes++;
            return origEncode.call(this, f);
          };
          const OrigAE = AudioEncoder;
          function AEWrapped(...args) {
            return Reflect.construct(OrigAE, args);
          }
          AEWrapped.prototype = OrigAE.prototype;
          AEWrapped.isConfigSupported = OrigAE.isConfigSupported;
          globalThis.AudioEncoder = AEWrapped;
        });
      }
    }

    // Optional: disable the re-announce pulse (audio-flatline bisect).
    if (process.env.E2E_NOPULSE === "1") {
      for (const [, page] of [["A", pageA], ["B", pageB]]) {
        await page.evaluateOnNewDocument(() => {
          globalThis.__CAMPFIRE_NOPULSE__ = true;
        });
      }
    }

    console.log("1. join both pages (URL params, HTTP/3 forced)…");
    await pageA.goto(`${URL_BASE}/?room=${ROOM}&name=${NAME_A}&color=%23e05f38`, {
      waitUntil: "domcontentloaded",
    });
    await pageB.goto(`${URL_BASE}/?room=${ROOM}&name=${NAME_B}&color=%23388ee0`, {
      waitUntil: "domcontentloaded",
    });

    console.log("2. presence settled (room clean: exactly A + B)…");
    // A run that ended seconds earlier may still be in the room: its
    // avatars sit on the spawn tile through the server's 30 s reconnect
    // window — and a headless close can leave the QUIC connection open,
    // so the server may take ~90 s to even notice the disconnect
    // (worst case observed). 90 s + 30 s + margin: wait 180 s. The
    // entries drain for sure (the tick purges expired seats), so this
    // only costs time when a previous run interfered. (Own entries too:
    // the first load joins over TCP and the client reloads over HTTP/3,
    // leaving a stale own entry.)
    await (async () => {
      let names = [];
      try {
        await waitUntil(async () => {
          names = await presenceNames(pageA);
          return (
            names.length === 2 &&
            names.some((n) => n?.includes(NAME_B)) &&
            names.filter((n) => n?.includes(NAME_A)).length === 1
          );
        }, "A sees exactly A + B", 180_000);
      } catch (e) {
        throw new Error(`${e.message} — A sees: ${JSON.stringify(names)}`);
      }
    })();
    await waitUntil(async () => {
      const b = await presenceNames(pageB);
      return (
        b.length === 2 &&
        b.some((n) => n?.includes(NAME_A)) &&
        b.filter((n) => n?.includes(NAME_B)).length === 1
      );
    }, "B sees exactly A + B", 90_000);
    console.log("   presence ok");

    console.log("3. bubble call (fake media) — both idle on spawn tile…");
    await waitUntil(
      async () =>
        (await badgeFor(pageA, NAME_A)) &&
        (await badgeFor(pageA, NAME_B)) &&
        (await badgeFor(pageB, NAME_B)),
      "🎧 badge for both users on both pages",
      30_000,
    );
    console.log("   bubble call established");

    console.log("4. MoQ sessions live (window.__campfire_moq)…");
    const hookA = await waitUntil(async () => {
      const h = await moqHook(pageA);
      return h && h.state === "live" ? h : undefined;
    }, "A's session live", 30_000);
    const hookB = await waitUntil(async () => {
      const h = await moqHook(pageB);
      return h && h.state === "live" ? h : undefined;
    }, "B's session live", 30_000);
    console.log(`   A: ${hookA.name} (${hookA.version})`);
    console.log(`   B: ${hookB.name} (${hookB.version})`);

    // Uplink scaling (issues.md "videostreams should scale to throughput"):
    // the ~1 Hz stats poll must produce a send-rate estimate. In browsers
    // where WebTransport.getStats() is flag-gated (Chromium 573538454)
    // both raw values stay null — then the allocator has no opinion and
    // the encoders hold their configured rates, which is the documented
    // degradation, not a failure.
    const est = await waitUntil(async () => {
      const h = await moqHook(pageA);
      return h && h.stats && h.stats.estimate !== null ? h : undefined;
    }, "A's uplink estimate", 15_000).catch(() => null);
    if (est) {
      console.log(
        `   A uplink estimate: ${(est.stats.estimate / 1e6).toFixed(2)} Mbps (estimatedSendRate=${est.stats.estimatedSendRate}, bytesSent=${est.stats.bytesSent})`,
      );
    } else {
      const h = await moqHook(pageA);
      if (h?.stats && h.stats.estimatedSendRate === null && h.stats.bytesSent === null) {
        console.log(
          "   WebTransport.getStats() unsupported here; uplink holds configured rates (estimate check skipped)",
        );
      } else {
        throw new Error(`uplink estimate never appeared: ${JSON.stringify(h?.stats ?? null)}`);
      }
    }
    // Encoder diagnostic: audio encoder output over 3 s. Distinguishes a
    // capture/encode problem (frames stall) from a delivery/decode one.
    const aud0 = await pageA.evaluate(() => window.__campfire_moq?.enc?.aud ?? null);
    await sleep(3000);
    const aud1 = await pageA.evaluate(() => window.__campfire_moq?.enc?.aud ?? null);
    if (aud0 && aud1) {
      console.log(
        `   A audio encoder: ${aud1.frames - aud0.frames} frames / ${aud1.bytes - aud0.bytes} B in 3 s`,
      );
    }

    console.log("5. downlinks live both ways (window.__campfire_moq_down)…");
    const downA = await assertDownlinkLive(pageA, "A → B's media");
    const downB = await assertDownlinkLive(pageB, "B → A's media");
    console.log(
      `   A sees B: ${downA.frames} frames, ${downA.audioBytes} B audio, delay ${downA.delay} ms`,
    );
    console.log(
      `   B sees A: ${downB.frames} frames, ${downB.audioBytes} B audio, delay ${downB.delay} ms`,
    );
    await waitUntil(async () => (await theaterState(pageA)) === "live", "A's column live", 15_000);
    await waitUntil(async () => (await theaterState(pageB)) === "live", "B's column live", 15_000);
    console.log("   downlinks rendered, latency within budget");

    console.log("5b. audio intelligibility (recorded downlink vs source file)…");
    // Diagnostic: both pages' roster (id → name) and self identity, so a
    // self-subscription or duplicate identity is visible in the log.
    for (const [label, page] of [["A", pageA], ["B", pageB]]) {
      const who = await page.evaluate(() => ({
        roster: window.__campfire_users ?? {},
        downKeys: Object.keys(window.__campfire_moq_down ?? {}),
      }));
      console.log(`   ${label} roster: ${JSON.stringify(who)}`);
    }
    // Free the CPU first: the software video pipeline (OpenH264 encode,
    // WebCodecs decode, software WebGL) saturates the pages in headless
    // and pushes the transport ~750 ms behind the live edge — more than
    // the audio's maxAge (live playback skips the backlog by design), so
    // the audio ring would drop every frame and record silence. Camera
    // off stops the video rendition at both ends (demand-gated); the
    // `a` rendition is unaffected. Cameras come back on below.
    await pageA.$eval("#cam-btn", (el) => el.click());
    await pageB.$eval("#cam-btn", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageA, "camera"))?.off === true, "A's camera off", 10_000);
    await waitUntil(async () => (await callBtn(pageB, "camera"))?.off === true, "B's camera off", 10_000);
    // Wait out the call's join churn, then record unconditionally: this
    // environment delivers audio with a fluctuating 300-700 ms transport
    // lag (headless software rendering) — a strict live-playback budget
    // would drop most frames by design, so the fidelity check runs under
    // the harness's own audio-budget override (see evaluateOnNewDocument)
    // and asserts content + continuity; the lag is *measured* (A's mic vs
    // B's playout correlation below) and only sanity-bounded.
    await sleep(2000);
    // Both tabs publish the same WAV through the real pipeline (the fake
    // mic plays it); B records its downlink's decoded PCM via the e2e
    // recorder hook. Continuity (no gaps) + content (normalized
    // cross-correlation against the source envelope) are the proxy for
    // "understandable": a disruption test, not an ASR test.
    // Resolve the recording target by NAME (the existing `__campfire_users`
    // debug hook maps participant id → name): B's down-hook keys are
    // participant ids, and key order is not stable — residue participants
    // from an earlier run's reconnect window can sit in the roster too.
    // Fail if A is not exactly once present.
    const rosterIdB = await waitUntil(async () => {
      const r = await pageB.evaluate(() => window.__campfire_users ?? null);
      if (!r) return null;
      const matches = Object.entries(r).filter(([, u]) => u.name === NAME_A);
      return matches.length === 1 ? matches[0][0] : null;
    }, "A's roster id on B (exactly one match)", 30_000);
    const recorderIdB = rosterIdB;
    let statePolls = 0;
    const recorded = await waitUntil(
      async () => {
        const state = await pageB.evaluate(() => ({
          wires: window.__campfire_wire_count,
          attaches: window.__campfire_attach_count,
          dataKeys: Object.keys(window.__campfire_audio_data ?? {}),
          filled: Object.values(window.__campfire_audio_data ?? {}).map((d) =>
            d.chunks.reduce((n, c) => n + c.length, 0),
          ),
          done: window.__campfire_record_done ?? {},
        }));
        if (state.filled.some((f) => f > 0) || statePolls % 10 === 1) {
          statePolls++;
          if (statePolls % 10 === 1) {
            console.log(`   recorder state: ${JSON.stringify(state)}`);
          }
        }
        return pageB.evaluate(
          (id) => window.__campfire_audio_capture?.(id) ?? null,
          recorderIdB,
        );
        return pageB.evaluate(
          (id) => window.__campfire_audio_capture?.(id) ?? null,
          recorderIdB,
        );
      },
      "B's audio recording fills (8 s of decoded PCM)",
      30_000,
    );
    // Read the source samples back out of the WAV we generated.
    const wavBuf = fs.readFileSync(audio.wavPath);
    const source = new Float32Array((wavBuf.length - 44) / 4);
    for (let i = 0; i < source.length; i++) {
      source[i] = new Int16Array(wavBuf.buffer, 44 + i * 2, 1)[0] / 32768;
    }
    const received = Buffer.from(recorded.base64, "base64");
    const recSamples = new Float32Array(received.buffer, 0, received.length / 4);
    // Optional dump (E2E_AUDIO_DUMP=/path.wav): the recorded downlink as
    // PCM16 for offline inspection (audacity/sox).
    if (process.env.E2E_AUDIO_DUMP) {
      const head = Buffer.alloc(44);
      head.write("RIFF", 0);
      head.writeUInt32LE(36 + received.length, 4);
      head.write("WAVE", 8);
      head.write("fmt ", 12);
      head.writeUInt32LE(16, 16);
      head.writeUInt16LE(1, 20);
      head.writeUInt16LE(1, 22);
      head.writeUInt32LE(recorded.rate, 24);
      head.writeUInt32LE(recorded.rate * 2, 28);
      head.writeUInt16LE(2, 32);
      head.writeUInt16LE(16, 34);
      head.write("data", 36);
      head.writeUInt32LE(received.length, 40);
      fs.writeFileSync(
        process.env.E2E_AUDIO_DUMP,
        Buffer.concat([head, received]),
      );
      console.log(`   recorded downlink dumped to ${process.env.E2E_AUDIO_DUMP}`);
    }
    const rmsOf = (a) => {
      let s = 0;
      for (const v of a) s += v * v;
      return Math.sqrt(s / a.length);
    };
    console.log(
      `   RMS: source ${rmsOf(source).toFixed(3)}, received ${rmsOf(recSamples).toFixed(3)}`,
    );
    const envSrc = envelope(source, 48000);
    const envRec = envelope(recSamples, recorded.rate);
    // Correlate the first 2 s of *voiced* recording against the source:
    // the recording starts in the ring's silent warmup (a leading-
    // silence needle correlates with nothing), so skip to the first
    // non-silent stretch, then find its offset in the source.
    // The environment's delivery lag fluctuates (catch-up transients),
    // so a single window can land in a weak stretch: correlate up to 5
    // voiced 2 s windows spread across the recording and take the best
    // score. A garbled pipeline never correlates anywhere; a healthy one
    // correlates strongly in every substantial stretch.
    const sortedRec = [...envRec].sort((a, b) => a - b);
    const medianRec0 = sortedRec[Math.floor(envRec.length / 2)] || 1;
    const WIN = 2000;
    const windows = [];
    let cursor = 0;
    while (cursor + WIN <= envRec.length && windows.length < 5) {
      if (envRec[cursor] >= medianRec0 * 0.2) {
        windows.push(cursor);
        cursor += WIN; // non-overlapping, spread across the recording
      } else {
        cursor++;
      }
    }
    if (windows.length === 0) {
      throw new Error(
        "recording has no voiced stretch at all (audio never played)",
      );
    }
    let corr = { score: -Infinity, offset: 0 };
    let start0 = windows[0];
    for (const w of windows) {
      const c = bestCorrelation(envRec.subarray(w, w + WIN), envSrc);
      if (c.score > corr.score) {
        corr = c;
        start0 = w;
      }
    }
    const gapMs = longestGap(envRec);
    console.log(`   correlation: ${(corr.score * 100).toFixed(1)}% (best of ${windows.length} windows, at rec ${(start0 / 1000).toFixed(2)} s, source offset ${(corr.offset / 1000).toFixed(2)} s)`);
    console.log(`   longest gap: ${gapMs} ms`);
    const downBNow = await soleDown(pageB);
    console.log(`   tile delay: ${downBNow?.delay} ms`);
    const audDiag = await pageB.evaluate(() => {
      const h = window.__campfire_moq_down;
      if (!h) return null;
      const d = h[Object.keys(h)[0]];
      return d
        ? {
            audCtx: d.audCtx,
            audStalled: d.audStalled,
            audClock: d.audClock,
            audBuf: d.audBuf,
            syncMaxAge: d.syncMaxAge,
            audEnabled: d.audEnabled,
            audTrack: d.audTrack,
          }
        : null;
    });
    console.log(`   B audio diag: ${JSON.stringify(audDiag)}`);
    // Loop-drift (informational): the source-offset delta between the
    // best window and the last one. If delivery is real-time, the two
    // offsets advance exactly as far apart as the recording windows do;
    // the catch-up drain legitimately runs faster than real time while
    // shedding a backlog, so this is not asserted.
    if (windows.length > 1) {
      const start2 = windows[windows.length - 1];
      const corr2 = bestCorrelation(
        envRec.subarray(start2, start2 + WIN),
        envSrc,
      );
      const drift = corr2.offset - corr.offset - (start2 - start0);
      console.log(
        `   loop drift: ${drift} ms over ${(start2 - start0) / 1000} s of recording (corr ${(corr2.score * 100).toFixed(1)}%) — informational: the catch-up drain legitimately runs faster than real time while shedding a backlog`,
      );
    }
    if (corr.score < AUDIO_CORR_MIN) {
      throw new Error(
        `audio content did not survive: correlation ${(corr.score * 100).toFixed(1)}% < ${AUDIO_CORR_MIN * 100}% (garbled or wrong signal)`,
      );
    }
    if (gapMs > AUDIO_GAP_MAX_MS) {
      throw new Error(
        `audio has disruptions: longest gap ${gapMs} ms > ${AUDIO_GAP_MAX_MS} ms (jitter-buffer underrun)`,
      );
    }
    if (!Number.isFinite(downBNow?.delay) || downBNow.delay > AUDIO_DELAY_MAX_MS) {
      throw new Error(
        `audio delay out of budget: ${downBNow?.delay} ms > ${AUDIO_DELAY_MAX_MS} ms`,
      );
    }
    console.log("   audio recorded intact, aligned, no gaps");
    // Back to video for the screen-share steps below.
    await pageA.$eval("#cam-btn", (el) => el.click());
    await pageB.$eval("#cam-btn", (el) => el.click());
    await waitUntil(
      async () => {
        const d = await soleDown(pageA);
        return d && d.frames > 0;
      },
      "video downlinks live again after camera on",
      30_000,
    );

    console.log("6. SFU metrics: campfire_moq_objects_in_total…");
    const metrics = await pageA.evaluate(async () => {
      const res = await fetch("/metrics");
      return res.text();
    });
    const m = metrics.match(/campfire_moq_objects_in_total (\d+)/);
    if (!m || Number(m[1]) < 10) {
      throw new Error(`object counter did not move: ${m ? m[1] : "missing"}`);
    }
    console.log(`   campfire_moq_objects_in_total = ${m[1]}`);

    console.log("7. screen share B → A (fake display)…");
    // Baseline while B's camera/mic stream: the share must not stall them
    // (issues.md "screenshare broken" — with the screen rendition on the
    // same hang, the re-announce used to kill the receiver's v/a
    // subscriptions the moment the share started).
    const base = await soleDown(pageA);
    console.log(
      `   base before share: frames ${base?.frames}, audio ${base?.audioBytes} B`,
    );
    await pageB.$eval("#screen-btn", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageB, "screen"))?.on === true, "B's share on", 15_000);
    await waitUntil(async () => (await screenTiles(pageA)) >= 1, "A shows B's screen tile", 30_000);
    const downScr = await waitUntil(async () => {
      const d = await soleDown(pageA);
      return d && d.screenFrames >= 5 ? d : undefined;
    }, "A decodes B's screen frames", 30_000);
    console.log(`   A decoded ${downScr.screenFrames} screen frames`);
    // Hold the share and assert the camera and audio kept flowing under
    // it: frame counts and audio bytes must keep rising, not plateau.
    // (temporary progress logging while root-causing the step 7 timeout)
    {
      const end = Date.now() + 30_000;
      let done;
      while (Date.now() < end) {
        const d = await soleDown(pageA);
        if (
          d &&
          d.frames >= base.frames + 5 &&
          d.audioBytes >= base.audioBytes + 5000
        ) {
          done = d;
          break;
        }
        if (d) {
          const [aeB, hB, dbgA] = await Promise.all([
            pageB.evaluate(() => window.__aeEncodes ?? -1),
            pageB.evaluate(() => window.__campfire_moq?.enc ?? null),
            pageA.evaluate(() => ({
              ins: window.__cfMIns ?? -1,
              wl: window.__cfWl ?? null,
              aud: window.__cfAud ?? null,
              wait: window.__cfAudWait ?? null,
              coi: crossOriginIsolated,
              sab: typeof SharedArrayBuffer,
            })),
          ]);
          const b =
            hB?.aud != null
              ? `aud f=${hB.aud.frames} b=${hB.aud.bytes} act=${hB.audActive}`
              : "aud=null";
          const cam =
            hB?.cam != null ? `cam f=${hB.cam.frames} b=${hB.cam.bytes}` : "cam=null";
          const wl = dbgA.wl ? `sr=${dbgA.wl.sr} len=${dbgA.wl.len} cap=${dbgA.wl.cap} st=${dbgA.wl.stalled} anch=${dbgA.wl.anchored} ts=${dbgA.wl.ts} uf=${dbgA.wl.uf}` : "wl=null";
          const loop = `pull=${dbgA.aud?.pull ?? "?"} pts=${dbgA.aud?.ts ?? "?"} wait=${dbgA.wait ?? "?"}`;
          console.log(
            `   [t+${((Date.now() - (end - 30_000)) / 1000).toFixed(0)}s] frames ${d.frames} (base ${base.frames}), audio ${d.audioBytes} B (base ${base.audioBytes}), screen ${d.screenFrames}, audioEncodes B=${aeB}, buf=${d.bufferedMs}ms cam=${d.camTrack} aud=${d.audTrack} audEn=${d.audEnabled} audStall=${d.audStalled} audRoot=${d.audRoot} ctx=${d.audCtx} clock=${d.audClock != null ? d.audClock.toFixed(0) : "null"} delay=${d.delay} maxAge=${d.syncMaxAge} syncTs=${d.syncTs != null ? d.syncTs.toFixed(0) : "null"} bufR=[${(d.audBuf ?? []).map((r) => r.start.toFixed(0) + "-" + r.end.toFixed(0)).join(",")}] main=${d.mainStatus} scr=${d.scrStatus} | A ins=${dbgA.ins} ${loop} coi=${dbgA.coi} sab=${dbgA.sab} ${wl} | B ${b} ${cam}`,
          );
        }
        await sleep(5_000);
      }
      if (process.env.E2E_DIAG === "1") {
        const audLog = await pageA.evaluate(() => window.__cfAudLog ?? null);
        if (audLog) {
          require("node:fs").writeFileSync("/tmp/campfire-audlog.json", JSON.stringify(audLog));
          console.log(`   [audlog] ${audLog.length} entries -> /tmp/campfire-audlog.json`);
        }
      }
      if (process.env.E2E_DIAG === "1") {
        const sigsA = await pageA.evaluate(() => window.__encCfgSigs?.() ?? null);
        const sigsB = await pageB.evaluate(() => window.__encCfgSigs?.() ?? null);
        console.log(`   [encdiag] A configures: ${JSON.stringify(sigsA)}`);
        console.log(`   [encdiag] B configures: ${JSON.stringify(sigsB)}`);
      }
      if (!done)
        throw new Error(
          `camera + audio keep flowing during the share (base frames ${base.frames}, base audio ${base.audioBytes})`,
        );
    }
    const during = await soleDown(pageA);
    console.log(
      `   during share: camera ${during.frames} (was ${base.frames}), audio ${during.audioBytes} B (was ${base.audioBytes})`,
    );
    // Stop the share: the screen hang is unannounced and the tile drops.
    await pageB.$eval("#screen-btn", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageB, "screen"))?.on === false, "B's share off", 10_000);
    await waitUntil(async () => (await screenTiles(pageA)) === 0, "A's screen tile gone", 15_000);
    // After the stop, camera + audio must still be flowing.
    await waitUntil(async () => {
      const d = await soleDown(pageA);
      return d && d.frames >= during.frames + 5
        ? d
        : undefined;
    }, "camera keeps flowing after the share stops", 30_000);
    console.log("   share started, rendered, stopped — camera/audio unaffected");

    console.log("8. mute / camera-off presence + delivery…");
    // Mute: the badge appears on A's tile; the meter still shows (the
    // tap is pre-gain), but e2e asserts the presence signal only.
    await pageB.$eval("#mic-btn", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageB, "mute"))?.off === true, "B muted", 10_000);
    await waitUntil(async () => (await tileBadge(pageA, NAME_B, ".tile-mute")), "A's tile shows B muted");
    await pageB.$eval("#mic-btn", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageB, "mute"))?.off === false, "B unmuted", 10_000);
    await waitUntil(async () => !(await tileBadge(pageA, NAME_B, ".tile-mute")), "A's tile un-muted");
    // Camera off: the `v` rendition is omitted from the catalog, so A's
    // decoded frame count must plateau — then resume when the camera comes
    // back.
    await pageB.$eval("#cam-btn", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageB, "camera"))?.off === true, "B camera off", 10_000);
    await waitUntil(async () => (await tileBadge(pageA, NAME_B, ".tile-cam")), "A's tile shows B camera off");
    const f1 = (await soleDown(pageA)).frames;
    for (let k = 0; k < 6; k++) {
      if (process.env.E2E_DIAG === "1") {
        const d = await soleDown(pageA);
        console.log(
          `   [camoff t+${(k * 0.5).toFixed(1)}s] frames ${d.frames} cam=${d.camTrack} status=${d.status}`,
        );
      }
      await sleep(500);
    }
    const f2 = (await soleDown(pageA)).frames;
    // The playback buffer holds up to BACKLOG_FACTOR × delay of already-
    // received media (4 × 400 ms video, docs/dev/latency-optimization.md
    // §8), which presents after the camera-off catalog lands: allow that
    // bounded tail (~2 s ≈ 60 frames at 30 fps), then require the
    // plateau to hold.
    if (f2 > f1 + 60)
      throw new Error(`B camera-off still delivers video: ${f1} → ${f2} frames`);
    await sleep(4_000);
    const f3 = (await soleDown(pageA)).frames;
    if (f3 > f2 + 10)
      throw new Error(`B camera-off delivery keeps growing: ${f2} → ${f3} frames`);
    await pageB.$eval("#cam-btn", (el) => el.click());
    await waitUntil(async () => {
      const d = await soleDown(pageA);
      return d.frames > f2 + 5;
    }, "A's frames from B resume after camera on", 30_000);
    await waitUntil(async () => !(await tileBadge(pageA, NAME_B, ".tile-cam")), "A's tile camera back");
    console.log("   badges follow presence; video delivery follows the catalog");

    console.log("9. tab refresh: A reloads, token re-join…");
    await pageA.reload({ waitUntil: "domcontentloaded" });
    await waitUntil(async () => {
      const a = await presenceNames(pageA);
      return (
        a.length === 2 &&
        a.some((n) => n?.includes(NAME_B)) &&
        a.filter((n) => n?.includes(NAME_A)).length === 1
      );
    }, "A sees exactly A + B after reload", 90_000);
    const hookA2 = await waitUntil(async () => {
      const h = await moqHook(pageA);
      return h && h.state === "live" ? h : undefined;
    }, "A's session live after reload", 45_000);
    if (hookA2.name !== hookA.name) {
      throw new Error(`identity changed on reload: ${hookA.name} → ${hookA2.name}`);
    }
    await assertDownlinkLive(pageA, "A → B after reload", 30_000);
    // B's downlink to A must follow the re-announced broadcast: A's old
    // session retracted the route, the re-join re-announced it.
    await waitUntil(async () => {
      const d = await soleDown(pageB);
      return d && d.status === "live" && d.frames > 0 ? d : undefined;
    }, "B's downlink to A live after A's reload (re-announce)", 45_000);
    console.log("   identity, uplink and both downlinks restored");

    // Soak (issues.md issue 8.6): hold the call for E2E_SOAK_MIN minutes,
    // sampling delivery and the origin gauge. Both clients keep their
    // sessions live the whole time, so any session teardown or panic in the
    // window is a leak, not a client-side close.
    let soak = null;
    if (SOAK_MIN > 0) {
      console.log(`9.5 soak: holding the call ${SOAK_MIN} min…`);
      // Drain the previous generation first: a session the client stopped
      // (the reload's old uplink) lingers on its QUIC connection until the
      // idle timeout reaps it, and its gauge slot releases only then. Wait
      // for exactly the two live sessions before opening the window, so a
      // late reap of the old generation can't land inside it.
      await waitUntil(
        async () => {
          const s = await metricValue(pageA, "campfire_moq_sessions");
          return s === 2 ? true : undefined;
        },
        "only the two live sessions remain (previous generation reaped)",
        90_000,
      );
      soak = {
        logOffset: logOffset(),
        rss: rssKb(),
      };
      const origins0 = await metricValue(pageA, "campfire_moq_origins");
      let frames = (await soleDown(pageA)).frames;
      let delivered = 0;
      const deadline = Date.now() + SOAK_MIN * 60_000;
      while (Date.now() < deadline) {
        await sleep(15_000);
        const d = await soleDown(pageA);
        const delta = d.frames - frames;
        if (delta < 100) {
          throw new Error(`soak: delivery stalled (+${delta} frames in 15 s)`);
        }
        frames = d.frames;
        delivered += delta;
        const s = await metricValue(pageA, "campfire_moq_sessions");
        if (s !== 2) {
          throw new Error(`soak: session gauge moved to ${s} (expected 2 stable)`);
        }
        const origins = await metricValue(pageA, "campfire_moq_origins");
        if (origins0 != null && origins != null && origins > origins0) {
          throw new Error(`soak: origins grew ${origins0} → ${origins} (leak)`);
        }
      }
      const window = logSince(soak.logOffset);
      const bad = window.filter(
        (l) => l.includes("panicked") || l.includes("moq session ended"),
      );
      if (bad.length) {
        throw new Error(`soak: unexpected server log lines:\n${bad.join("\n")}`);
      }
      console.log(
        `   soak clean: ${delivered} frames delivered, sessions 2, origins stable at ${origins0}`,
      );
    }

    console.log("10. walk-away: B leaves, A's session stops…");
    await pageB.keyboard.down("ArrowRight");
    await sleep(4_000);
    await pageB.keyboard.up("ArrowRight");
    // B then leaves the room entirely: with B gone no new bubble can
    // re-form around A, so "stopped" is a terminal state (a B that
    // rejoined within bubble radius would legitimately start a fresh call
    // and uplink). It also covers a lost walk-away (datagrams are
    // unreliable): B's seat then drains with its 30 s reconnect window and
    // the call ends at the purge.
    await pageB.close();
    await waitUntil(
      async () => {
        const h = await moqHook(pageA);
        return h && h.state === "stopped";
      },
      "A's session stopped after B left",
      60_000,
    );
    console.log("   session torn down with the call");

    if (soak) {
      // The teardown's own session closes are client-caused (expected);
      // what must hold: the origins return to baseline, nothing panicked,
      // and the process did not grow out of hand over the whole soak.
      await waitUntil(
        async () => {
          const o = await metricValue(pageA, "campfire_moq_origins");
          const s = await metricValue(pageA, "campfire_moq_sessions");
          return o === 0 && s === 0 ? true : undefined;
        },
        "campfire_moq_origins and sessions back to baseline after teardown",
        90_000,
      );
      const tail = logSince(soak.logOffset);
      const panics = tail.filter((l) => l.includes("panicked"));
      if (panics.length) {
        throw new Error(`soak: ${panics.length} panic line(s) in the server log`);
      }
      if (soak.rss != null) {
        const rss = rssKb();
        if (rss != null) {
          const growthKb = rss - soak.rss;
          if (growthKb > 64 * 1024) {
            throw new Error(
              `soak: server RSS grew ${(growthKb / 1024).toFixed(1)} MB (gate 64 MB)`,
            );
          }
          console.log(
            `   soak tail: origins/sessions 0, no panics, RSS +${(growthKb / 1024).toFixed(1)} MB`,
          );
        }
      } else {
        console.log("   soak tail: origins/sessions 0, no panics");
      }
    }

    if (pageErrors.length) {
      console.warn("   (page errors seen during the run — inspect above)");
    }
    console.log("MOQ E2E PASS");
  } catch (err) {
    failed = true;
    console.error("MOQ E2E FAIL:", err.message);
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
})().catch((err) => {
  console.error("MOQ E2E FAIL:", err.message);
  process.exit(1);
});

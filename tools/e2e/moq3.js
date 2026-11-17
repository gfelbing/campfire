/**
 * Three-party MoQ e2e (docs/arch/moq-sfu.md): three real browser clients
 * join one room, the bubble engine pulls all three into one call, and every
 * page must hold two live downlinks whose audio keeps flowing and whose
 * playout delay stays bounded. This is the reproduction for "3rd participant
 * joins and everything breaks" (audio delay +1 s/s, walking lags, bubbles
 * never release).
 *
 * Usage: node tools/e2e/moq3.js --browser brave [--url https://localhost:8443]
 * [--seconds 20] — needs a server built with `just e2e-build` (the client
 * must carry the e2e debug hooks, `build:e2e`).
 *
 * Diagnostics: E2E_NOVID=1 clicks the camera off on every page (audio-only,
 * rules the video pipeline out); E2E_AUDIOGRAPH=1 dumps each page's audio
 * graph event log (AudioContext/worklet churn, the graph-rebuild probe).
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const puppeteer = require("puppeteer-core");

const DEV_CERT = "certs/cert.pem";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = arg("url", "https://localhost:8443");
const hostport = new URL(URL_BASE).host;
const BROWSER = arg("browser", "brave");
const ROOM = arg("room", "island");
const SAMPLE_SECONDS = Number(arg("seconds", "20"));
const NOVID = process.env.E2E_NOVID === "1";
const AUDIOGRAPH = process.env.E2E_AUDIOGRAPH === "1";
const PAGES_N = Number(arg("pages", "3"));
const STAMP = Date.now().toString(36).slice(-5);
const NAMES = Array.from(
  { length: PAGES_N },
  (_, i) => `m${i}-${STAMP}`,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(
    `timeout waiting for ${what} (last: ${JSON.stringify(last)}${lastErr ? `, error: ${lastErr.message}` : ""})`,
  );
}

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

/** `window.__campfire_moq` (session hook), or undefined. */
const moqHook = (page) => page.evaluate(() => window.__campfire_moq);

/** All downlink views (`window.__campfire_moq_down`), keyed by id. */
const allDown = (page) => page.evaluate(() => window.__campfire_moq_down ?? null);

/** Does the presence row of `name` carry the 🎧 in-call badge? */
const badgeFor = (page, name) =>
  page.evaluate((needle) => {
    for (const li of document.querySelectorAll(".presence-list li")) {
      const label = li.querySelector(".presence-name")?.textContent ?? "";
      if (label.includes(needle)) return !!li.querySelector(".presence-call");
    }
    return false;
  }, name);

const presenceNames = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".presence-name")].map((e) => e.textContent),
  );

const browserArgs = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--ignore-certificate-errors",
    ...(devCertSpki()
      ? [`--ignore-certificate-errors-spki-list=${devCertSpki()}`]
      : []),
    "--autoplay-policy=no-user-gesture-required",
    `--origin-to-force-quic-on=${hostport}`,
    "--enable-features=WebTransportAllowThreaded",
  ];

(async () => {
  let failed = false;
  const pages = [];
  try {
    for (let i = 0; i < PAGES_N; i++) {
      // One browser per participant: Chromium pools QUIC connections per
      // origin per browser process, and the server holds one WebTransport
      // session per connection — 4+ pages in one browser exhaust the pool
      // and the extra pages never even open a /wt session (observed: 3
      // pages work, the 4th never connects). Separate browser processes
      // mirror the real deployment (one browser per human) anyway.
      const instance = await puppeteer.launch({
        executablePath: BROWSER,
        headless: true,
        dumpio: false,
        args: browserArgs,
      });
      console.log(`   launched browser ${i}`);
      const page = await instance.newPage();
      await page.setViewport({ width: 320, height: 240 });
      page.on("pageerror", (e) =>
        console.error(`page${i} error:`, e.message),
      );
      page.on("console", (msg) => {
        const t = msg.text();
        console.log(`page${i} console: ${t}`);
      });
      page.instance = instance;
      if (AUDIOGRAPH) {
        // Diagnose frozen audio worklets: log every AudioContext creation
        // and every worklet connect/disconnect.
        await page.evaluateOnNewDocument(() => {
          window.__ctxCount = 0;
          window.__audLog = [];
          const log = (m) => {
            window.__audLog.push(`${performance.now().toFixed(0)} ${m}`);
            if (window.__audLog.length > 400) window.__audLog.shift();
          };
          const OrigCtx = window.AudioContext;
          window.AudioContext = class extends OrigCtx {
            constructor(...args) {
              super(...args);
              log(`ctx#${++window.__ctxCount} created`);
            }
          };
          const origClose = AudioContext.prototype.close;
          AudioContext.prototype.close = function (...args) {
            log(`ctx close (state=${this.state})`);
            return origClose.apply(this, args);
          };
          const conn = AudioWorkletNode.prototype.connect;
          AudioWorkletNode.prototype.connect = function (...args) {
            log(`worklet connect -> ${args[0]?.constructor?.name ?? "?"}`);
            return conn.apply(this, args);
          };
          const disc = AudioWorkletNode.prototype.disconnect;
          AudioWorkletNode.prototype.disconnect = function (...args) {
            log("worklet disconnect");
            return disc.apply(this, args);
          };
        });
      }
      pages.push(page);
    }

    // The e2e audio budget override (moq.ts __campfire_audio_ms): the
    // headless environment's transport lag exceeds the production 40 ms
    // target, and live playback under it drops every frame.
    for (const page of pages) {
      await page.evaluateOnNewDocument(() => {
        window.__campfire_audio_ms = 200;
        window.__campfire_video_maxpx = 320 * 240;
      });
    }

    const colors = ["%23e05f38", "%23388ee0", "%2349a25f", "%23a25f49", "%23e0b238", "%2338e0d5", "%238e38e0", "%23e0388e"];
    // Pad so every page gets a valid URL color (an invalid one disables the
    // identity-complete fast path and the page waits on the setup layer).
    while (colors.length < PAGES_N) {
      colors.push(`%23${(0x100000 + colors.length * 0x1f1f1f).toString(16)}`);
    }
    console.log(`1. join ${PAGES_N} pages…`);
    for (const [i, page] of pages.entries()) {
      await page.goto(
        `${URL_BASE}/?room=${ROOM}&name=${NAMES[i]}&color=${colors[i]}`,
        { waitUntil: "domcontentloaded" },
      );
      console.log(`   page${i} loaded`);
      if (NOVID) {
        // Camera off immediately: isolates the audio pipeline from the
        // video decode/render CPU load.
        await page.evaluate(() => {
          const click = () => {
            const btn = document.querySelector("#cam-btn");
            if (btn) {
              btn.click();
              return true;
            }
            return false;
          };
          if (!click()) {
            const timer = setInterval(() => {
              if (click()) clearInterval(timer);
            }, 100);
            setTimeout(() => clearInterval(timer), 15_000);
          }
        });
      }
      await sleep(300);
    }

    console.log("2. presence settled…");
    for (const [i, page] of pages.entries()) {
      await waitUntil(async () => {
        const names = await presenceNames(page);
        return (
          names.length === PAGES_N &&
          NAMES.every((n) => names.some((m) => m?.includes(n)))
        );
      }, `page${i} sees ${PAGES_N} members`, 120_000).catch(async (e) => {
        const all = [];
        for (const [j, p] of pages.entries()) {
          all.push(
            `page${j}: ${JSON.stringify(await presenceNames(p))} url=${p.url()}`,
          );
        }
        throw new Error(`${e.message} — ${all.join(", ")}`);
      });
    }
    console.log("   presence ok");

    console.log("3. bubble call (all on the spawn tile)…");
    for (const [i, page] of pages.entries()) {
      await waitUntil(
        async () =>
          (await badgeFor(page, NAMES[0])) &&
          (await badgeFor(page, NAMES[1])) &&
          (await badgeFor(page, NAMES[2])),
        `page${i} sees all three badges`,
        30_000,
      );
    }
    console.log("   bubble call established");

    console.log("4. MoQ sessions live…");
    for (const [i, page] of pages.entries()) {
      await waitUntil(async () => {
        const h = await moqHook(page);
        return h && h.state === "live" ? h : undefined;
      }, `page${i}'s session live`, 60_000).catch(async (e) => {
        const h = await moqHook(page);
        const keys = await page.evaluate(() =>
          Object.keys(window).filter((k) => k.includes("campfire")),
        );
        const toasts = await page.evaluate(() =>
          [...document.querySelectorAll(".toast")].map((e) => e.textContent),
        );
        const gum = await page.evaluate(() => {
          const callBar = !!document.querySelector("#mic-btn");
          const theater = document.querySelector(".theater-state")?.textContent ?? null;
          return { callBar, theater };
        });
        throw new Error(
          `${e.message} — hook: ${JSON.stringify(h)} keys: ${keys.join(",")} toasts: ${JSON.stringify(toasts)} ui: ${JSON.stringify(gum)}`,
        );
      });
    }
    console.log("   sessions live");

    console.log("5. live downlinks per page…");
    for (const [i, page] of pages.entries()) {
      await waitUntil(async () => {
        const d = await allDown(page);
        if (!d) return false;
        const entries = Object.values(d);
        return (
          entries.length === PAGES_N - 1 &&
          entries.every((e) => e.status === "live" && e.audioBytes > 0 && (NOVID || e.frames > 0))
        );
      }, `page${i} has 2 live downlinks (audio${NOVID ? "" : "+video"})`, 60_000);
    }
    console.log("   downlinks live");

    console.log(`6. sampling ${SAMPLE_SECONDS}s — audio must keep flowing, delay bounded…`);
    const t0 = Date.now();
    let worstDelay = 0;
    let lastAudio = null;
    let stalled = false;
    let sample = 0;
    while ((Date.now() - t0) / 1000 < SAMPLE_SECONDS) {
      await sleep(1000);
      sample++;
      const report = [];
      for (const [i, page] of pages.entries()) {
        const d = await allDown(page);
        if (!d) {
          report.push(`p${i}: no downlinks`);
          continue;
        }
        for (const [id, e] of Object.entries(d)) {
          const delayMs = e.delay ?? 0;
          if (delayMs > worstDelay) worstDelay = delayMs;
          const key = `${i}:${id}`;
          const prev = lastAudio?.get(key) ?? 0;
          lastAudio ??= new Map();
          lastAudio.set(key, e.audioBytes);
          if (sample > 3 && e.audioBytes === prev) {
            stalled = true;
            report.push(`p${i}/${id}: AUDIO STALLED (bytes ${e.audioBytes})`);
          } else {
            report.push(
              `p${i}/${id.slice(0, 8)}: frames ${e.frames} aud ${e.audioBytes}B delay ${delayMs.toFixed(0)}ms jit ${e.jitter?.toFixed(0)} st ${e.status}` +
                (delayMs > 2000
                  ? ` [stall: audStalled=${e.audStalled} ctx=${e.audCtx} clock=${e.audClock != null ? e.audClock.toFixed(0) : "null"} buf=${e.bufferedMs?.toFixed(0)}ms root=${e.audRoot} en=${e.audEnabled}]`
                  : ""),
            );
          }
        }
      }
      console.log(`   [t+${((Date.now() - t0) / 1000).toFixed(0)}s] ${report.join(" | ")}`);
    }
    for (const [i, page] of pages.entries()) {
      const d = await allDown(page);
      const entries = Object.values(d ?? {});
      if (
        entries.length !== PAGES_N - 1 ||
        !entries.every((e) => e.audioBytes > 0 && (NOVID || e.frames > 0))
      ) {
        throw new Error(`page${i}: downlinks not alive at the end: ${JSON.stringify(d)}`);
      }
    }
    if (stalled) throw new Error("a downlink's audio stopped flowing during the sample");
    console.log(`   ok (worst delay ${worstDelay.toFixed(0)} ms)`);

    // Dump the audio-graph event log of every page (diagnostic).
    if (AUDIOGRAPH) {
      for (const [i, page] of pages.entries()) {
        const log = await page.evaluate(() => window.__audLog ?? []);
        console.log(`   page${i} audio graph log:\n     ${log.join("\n     ")}`);
      }
    }
  } catch (e) {
    failed = true;
    console.error("FAILED:", e.message);
  } finally {
    for (const page of pages) await page.instance?.close();
  }
  process.exit(failed ? 1 : 0);
})();

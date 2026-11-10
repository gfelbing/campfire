#!/usr/bin/env node
/**
 * MoQ uplink E2E (docs/moq-sfu.md §9 Phase 2): real browser → SFU fan-out.
 *
 * Drives the real client in headless Brave/Chromium with fake media:
 *   1. both pages auto-join via `/?room=…&name=…` and stand still on the
 *      spawn tile, so the server's bubble engine pulls them into a call;
 *   2. each client opens a MoQ uplink on `/moq?ticket=…` (Phase 2) and
 *      announces `call/<room>/<user-id>.hang` — asserted via the
 *      `window.__campfire_moq` debug hook;
 *   3. the Rust spike client subscribes to A's broadcast as a third call
 *      member (B's ticket) and must receive video AND audio objects;
 *   4. the SFU's own `/metrics` object counter must have moved;
 *   5. B walks away and leaves the room, the call ends, and A's uplink
 *      stops.
 *
 * The dev server (port 8443) must be running, like `just e2e`.
 *
 * Usage: node tools/e2e/moq.js [--url https://localhost:8443] [--browser /path]
 */

const { spawn } = require("child_process");
const path = require("path");

const puppeteer = require("puppeteer-core");

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
const SUB_DURATION = arg("duration", "8s");
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SPIKE_BIN = arg("bin", path.join(REPO_ROOT, "target", "release", "moq-spike-client"));
const CA_CERT = path.join(REPO_ROOT, "certs", "ca.pem");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      // page navigating / not ready yet
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** `window.__campfire_moq` (the Phase 2 debug hook), or undefined. */
const moqHook = (page) => page.evaluate(() => window.__campfire_moq);

const presenceNames = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".presence-name")].map((e) => e.textContent),
  );

/** Does the presence row of `name` carry the 🎧 in-call badge? */
const badgeFor = (page, name) =>
  page.evaluate((needle) => {
    for (const li of document.querySelectorAll(".presence-list li")) {
      const label = li.querySelector(".presence-name")?.textContent ?? "";
      if (label.includes(needle)) return !!li.querySelector(".presence-call");
    }
    return false;
  }, name);

/** Run the spike subscriber and resolve with its parsed JSON report. */
function runSpikeSubscriber(ticket, subPath) {
  return new Promise((resolve, reject) => {
    const argv = [
      "--url", `${URL_BASE}/moq`,
      "--ticket", ticket,
      "--sub-path", subPath,
      "--no-publish",
      // Browser payloads are encoded media, not the spike's stamped frames.
      "--no-stamp",
      "--subscribers", "1",
      "--duration", SUB_DURATION,
      "--max-age", "2s",
      "--ca", CA_CERT,
    ];
    console.log("   spike subscriber:", argv.join(" "));
    const child = spawn(SPIKE_BIN, argv, { cwd: REPO_ROOT });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`spike exited ${code}:\n${err.slice(-2000)}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`spike output not JSON: ${out.slice(0, 500)}`));
      }
    });
    child.on("error", reject);
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // README §12: fake media, no permission prompts.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      // Dev cert: headless over TCP must skip the interstitial.
      "--ignore-certificate-errors",
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
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    const pageErrors = [];
    for (const [label, page] of [["A", pageA], ["B", pageB]]) {
      page.on("pageerror", (e) => {
        pageErrors.push(`[${label}] ${e.message}`);
        console.error(`page${label} error:`, e.message);
      });
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
    // avatars sit on the spawn tile through the server's 10 s reconnect
    // window (longer if a headless close left the QUIC connection open —
    // worst case observed ~90 s), and they would join our bubble and keep
    // the call alive after our B walks away. Wait for them to drain (own
    // entries too: the first load joins over TCP and the client reloads
    // over HTTP/3, leaving a stale own entry).
    await waitUntil(async () => {
      const a = await presenceNames(pageA);
      return (
        a.length === 2 &&
        a.some((n) => n?.includes(NAME_B)) &&
        a.filter((n) => n?.includes(NAME_A)).length === 1
      );
    }, "A sees exactly A + B", 90_000);
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

    console.log("4. MoQ uplinks live (window.__campfire_moq)…");
    const hookA = await waitUntil(async () => {
      const h = await moqHook(pageA);
      return h && h.state === "live" ? h : undefined;
    }, "A's uplink live", 30_000);
    const hookB = await waitUntil(async () => {
      const h = await moqHook(pageB);
      return h && h.state === "live" ? h : undefined;
    }, "B's uplink live", 30_000);
    console.log(`   A: ${hookA.name} (${hookA.version})`);
    console.log(`   B: ${hookB.name} (${hookB.version})`);

    console.log("5. spike subscriber: A's broadcast, admitted with B's ticket…");
    const ticket = new URL(hookB.url).searchParams.get("ticket");
    if (!ticket) throw new Error("B's uplink URL carries no ticket");
    const report = await runSpikeSubscriber(ticket, hookA.name);
    const sub = report.subscribers?.[0];
    if (!sub || sub.error) throw new Error(`subscriber failed: ${JSON.stringify(sub)}`);
    console.log(`   negotiated: ${report.negotiated_version}`);
    console.log(`   video: ${sub.video?.samples} objects, audio: ${sub.audio?.samples} objects`);
    if (!sub.video || sub.video.samples < 10) {
      throw new Error(`video fan-out failed: ${JSON.stringify(sub.video)}`);
    }
    if (!sub.audio || sub.audio.samples < 10) {
      throw new Error(`audio fan-out failed: ${JSON.stringify(sub.audio)}`);
    }
    console.log("   video + audio objects delivered");

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

    console.log("7. walk-away: B leaves, A's uplink stops…");
    await pageB.keyboard.down("ArrowRight");
    await sleep(4_000);
    await pageB.keyboard.up("ArrowRight");
    // B then leaves the room entirely: with B gone no new bubble can
    // re-form around A, so "stopped" is a terminal state (a B that
    // rejoined within bubble radius would legitimately start a fresh call
    // and uplink). It also covers a lost walk-away (datagrams are
    // unreliable): B's seat then drains with its 10 s reconnect window and
    // the call ends at the purge.
    await pageB.close();
    await waitUntil(
      async () => {
        const h = await moqHook(pageA);
        return h && h.state === "stopped";
      },
      "A's uplink stopped after B left",
      40_000,
    );
    console.log("   uplink torn down with the call");

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

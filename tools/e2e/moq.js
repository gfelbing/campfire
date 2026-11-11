#!/usr/bin/env node
/**
 * MoQ call E2E (docs/moq-sfu.md §9 Phases 2–3): real browser ↔ SFU, both
 * directions.
 *
 * Drives the real client in headless Brave/Chromium with fake media:
 *   1. both pages auto-join via `/?room=…&name=…` and stand still on the
 *      spawn tile, so the server's bubble engine pulls them into a call;
 *   2. each client opens one MoQ session on `/moq/{ticket}` carrying the
 *      uplink (announces `call/<room>/<user-id>.hang`) and every downlink —
 *      asserted via the `window.__campfire_moq` / `window.__campfire_moq_down`
 *      debug hooks;
 *   3. the downlinks must render: decoded video frames, received audio
 *      bytes, and the playback delay/jitter within a sane budget;
 *   4. the SFU's own `/metrics` object counter must have moved;
 *   5. B shares their screen (fake display, headless): A must gain a
 *      screen tile and decode its `s` rendition; stopping the share drops
 *      the tile;
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
// (a sanity bound, docs/moq-sfu.md §9 Phase 3).
const MAX_LATENCY_MS = 1000;

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
 *  in the DOM. `cls` is `mute` | `camera` | `screen`. */
const callBtn = (page, cls) =>
  page.evaluate((c) => {
    const el = document.querySelector(`.call-${c}`);
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
    await pageB.$eval(".call-screen", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageB, "screen"))?.on === true, "B's share on", 15_000);
    await waitUntil(async () => (await screenTiles(pageA)) >= 1, "A shows B's screen tile", 30_000);
    const downScr = await waitUntil(async () => {
      const d = await soleDown(pageA);
      return d && d.screenFrames >= 5 ? d : undefined;
    }, "A decodes B's screen frames", 30_000);
    console.log(`   A decoded ${downScr.screenFrames} screen frames`);
    // Stop the share: the rendition is unregistered and the tile drops.
    await pageB.$eval(".call-screen", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageB, "screen"))?.on === false, "B's share off", 10_000);
    await waitUntil(async () => (await screenTiles(pageA)) === 0, "A's screen tile gone", 15_000);
    console.log("   share started, rendered, stopped");

    console.log("8. mute / camera-off presence + delivery…");
    // Mute: the badge appears on A's tile; the meter still shows (the
    // tap is pre-gain), but e2e asserts the presence signal only.
    await pageB.$eval(".call-mute", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageB, "mute"))?.off === true, "B muted", 10_000);
    await waitUntil(async () => (await tileBadge(pageA, NAME_B, ".tile-mute")), "A's tile shows B muted");
    await pageB.$eval(".call-mute", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageB, "mute"))?.off === false, "B unmuted", 10_000);
    await waitUntil(async () => !(await tileBadge(pageA, NAME_B, ".tile-mute")), "A's tile un-muted");
    // Camera off: the `v` rendition is omitted from the catalog, so A's
    // decoded frame count must plateau — then resume when the camera comes
    // back.
    await pageB.$eval(".call-camera", (el) => el.click());
    await waitUntil(async () => (await callBtn(pageB, "camera"))?.off === true, "B camera off", 10_000);
    await waitUntil(async () => (await tileBadge(pageA, NAME_B, ".tile-cam")), "A's tile shows B camera off");
    const f1 = (await soleDown(pageA)).frames;
    await sleep(3_000);
    const f2 = (await soleDown(pageA)).frames;
    if (f2 > f1 + 2) throw new Error(`B camera-off still delivers video: ${f1} → ${f2} frames`);
    await pageB.$eval(".call-camera", (el) => el.click());
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

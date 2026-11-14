#!/usr/bin/env node
/**
 * Headless E2E (docs/dev/testing.md): two fake-media pages over HTTP/3.
 *
 * Drives the real client in headless Brave/Chromium:
 *   1. both pages auto-join via `/?room=…&name=…&color=…` (boot.ts);
 *   2. each page sees the other in the presence panel;
 *   3. a chat line from A arrives at B (room-wide broadcast);
 *   4. both avatars stand still on the spawn tile, so the server's bubble
 *      engine pulls them into a call — the assertion is the 🎧 badge
 *      (server-authoritative call membership, docs/arch/protocol.md), held 3 s;
 *   5. B walks and A sees the movement; B refreshes the tab and walks
 *      again — A still sees B move (a token rejoin restarts the movement
 *      sequence at 0; A's per-user guard must follow the new epoch);
 *   6. B walks away and leaves the room — the bubble tears down
 *      (walk-away leave).
 *
 * Usage: node tools/e2e/e2e.js [--url https://localhost:8443] [--browser /path]
 */

const puppeteer = require("puppeteer-core");
const fs = require("fs");
const crypto = require("crypto");

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

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const URL_BASE = arg("url", "https://localhost:8443");
// Unique per run: earlier runs' sessions may still sit in the server's
// reconnect window / QUIC idle timeout, so shared names would be ambiguous.
const STAMP = Date.now().toString(36).slice(-5);
const NAME_A = `e2ea-${STAMP}`;
const NAME_B = `e2eb-${STAMP}`;
const BROWSER = arg("browser", "brave");
const ROOM = arg("room", "island");

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

const presenceNames = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".presence-name")].map((e) => e.textContent),
  );

const chatLines = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".cf-chat-line")].map((e) => e.textContent),
  );

/** The client does not expose call state globally; read the presence badge
 *  and the call bar instead. Falls back to probing page state. */
/** Does the presence row of `name` carry the 🎧 in-call badge? */
const badgeFor = (page, name) =>
  page.evaluate((needle) => {
    for (const li of document.querySelectorAll(".presence-list li")) {
      const label = li.querySelector(".presence-name")?.textContent ?? "";
      if (label.includes(needle)) return !!li.querySelector(".presence-call");
    }
    return false;
  }, name);

/**
 * The client's `__campfire_users` hook (main.ts): id → { name, x, y } in tile
 * coords. Returns the x of the user whose name contains `needle`, or null.
 */
const posX = (page, name) =>
  page.evaluate((needle) => {
    const u = window.__campfire_users ?? {};
    for (const rec of Object.values(u))
      if (rec.name && rec.name.includes(needle)) return rec.x;
    return null;
  }, name);

/** How many users does the page's own roster currently hold? */
const userCount = (page) =>
  page.evaluate(() => Object.keys(window.__campfire_users ?? {}).length);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // docs/dev/testing.md: fake media, no permission prompts.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      // Dev cert: headless over TCP must skip the interstitial.
      "--ignore-certificate-errors",
      // ...and the SPKI pin makes the QUIC handshake pass too (see
      // devCertSpki above).
      ...(devCertSpki() ? [`--ignore-certificate-errors-spki-list=${devCertSpki()}`] : []),
      // Force the HTTP/3 path (the dev server has no Alt-Svc history).
      "--origin-to-force-quic-on=localhost:8443",
      "--enable-features=WebTransportAllowThreaded",
    ],
  });
  try {
    // Two separate browser contexts: storage (localStorage with the saved
    // identity) is per-context, and boot prefers the stored name over the
    // `?name=` param — one shared context would make B re-join as A.
    const contextA = await browser.createBrowserContext();
    const contextB = await browser.createBrowserContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    pageA.on("pageerror", (e) => console.error("pageA error:", e.message));
    pageB.on("pageerror", (e) => console.error("pageB error:", e.message));

    console.log("1. join both pages (URL params, HTTP/3 forced)…");
    await pageA.goto(`${URL_BASE}/?room=${ROOM}&name=${NAME_A}&color=%23e05f38`, {
      waitUntil: "domcontentloaded",
    });
    await pageB.goto(`${URL_BASE}/?room=${ROOM}&name=${NAME_B}&color=%23388ee0`, {
      waitUntil: "domcontentloaded",
    });

    console.log("2. presence: each page sees both users…");
    await waitUntil(async () => {
      const a = await presenceNames(pageA);
      return a.some((n) => n?.includes(NAME_B));
    }, "A sees B in presence");
    await waitUntil(async () => {
      const b = await presenceNames(pageB);
      return b.some((n) => n?.includes(NAME_A));
    }, "B sees A in presence");
    // The first load joins over the TCP bootstrap, then the client reloads
    // over HTTP/3 (`?alt=1`); the stale session sits in the server's
    // reconnect window for a while, as do any users of a run that ended
    // seconds ago (their avatars would share our spawn tile and join our
    // bubble; a headless close can hold a QUIC connection open for up to
    // ~90 s before the server notices). Wait until each page sees exactly
    // A + B.
    await waitUntil(async () => {
      const names = await presenceNames(pageA);
      return names.length === 2 && names.filter((n) => n?.includes(NAME_A)).length === 1;
    }, "A sees exactly A + B", 90_000);
    await waitUntil(async () => {
      const names = await presenceNames(pageB);
      return names.length === 2 && names.filter((n) => n?.includes(NAME_B)).length === 1;
    }, "B sees exactly A + B", 90_000);
    console.log("   presence ok");

    console.log("3. chat broadcast A → B…");
    await pageA.evaluate((stamp) => {
      const input = document.querySelector(".cf-chat-input");
      const form = document.querySelector(".cf-chat-form");
      input.value = `e2e-hello-${stamp}`;
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }, STAMP);
    await waitUntil(async () =>
      (await chatLines(pageB)).some((t) => t?.includes(`e2e-hello-${STAMP}`)),
    "B receives chat");
    console.log("   chat ok");

    console.log("4. bubble call (fake media) — both idle on spawn tile…");
    await waitUntil(
      async () =>
        (await badgeFor(pageA, NAME_A)) &&
        (await badgeFor(pageA, NAME_B)) &&
        (await badgeFor(pageB, NAME_B)),
      "🎧 badge for both users on both pages",
      30_000,
    );
    // The peer connections live inside the client module scope; media is
    // not asserted here (the MoQ suite, tools/e2e/moq.js, covers it). Probe
    // via the presence badge (server-authoritative call membership,
    // docs/arch/protocol.md) and require it to stay up for 3 s (not a churn blip).
    await sleep(3_000);
    const still = await badgeFor(pageA, NAME_B);
    if (!still) throw new Error("call badge disappeared — bubble did not hold");
    console.log("   bubble call established and held");

    console.log("5. movement survives a peer tab refresh…");
    // Control: B walks east from spawn; A must see B's tile position move
    // (proves the movement pipeline works before any refresh).
    const x0 = await posX(pageA, NAME_B);
    await pageB.keyboard.down("ArrowRight");
    await sleep(3_000);
    await pageB.keyboard.up("ArrowRight");
    const x1 = await posX(pageA, NAME_B);
    if (x0 == null || x1 == null || x1 - x0 < 2)
      throw new Error(`control: A did not see B walk (x ${x0} → ${x1})`);
    console.log(`   A sees B walk east (x ${x0.toFixed(1)} → ${x1.toFixed(1)})`);

    // The regression: B refreshes. The token rejoin starts the movement
    // sequence from 0 again and the server resets its counter to match
    // (world.rs `join`). A's per-user sequence guard used to keep B's
    // pre-refresh lastSeq, so every new-epoch entry (s = 0,1,2…) was
    // dropped and B's avatar froze on A. B walks again — A must still see
    // B move.
    await pageB.reload({ waitUntil: "domcontentloaded" });
    await waitUntil(async () => (await userCount(pageB)) >= 2, "B re-joined after reload", 30_000);
    await sleep(1_000); // let B's game loop settle at its restored position
    const x2 = await posX(pageA, NAME_B);
    await pageB.keyboard.down("ArrowLeft");
    await sleep(2_000);
    await pageB.keyboard.up("ArrowLeft");
    const x3 = await posX(pageA, NAME_B);
    if (x2 == null || x3 == null || Math.abs(x3 - x2) < 2)
      throw new Error(`regression: A stopped seeing B after B's refresh (x ${x2} → ${x3})`);
    console.log(`   A still sees B walk after refresh (x ${x2.toFixed(1)} → ${x3.toFixed(1)})`);

    console.log("6. walk-away leave…");
    // Move B far from spawn via synthetic arrow keys (movement validator is
    // server-authoritative; synthetic key events are what a real user does).
    await pageB.keyboard.down("ArrowRight");
    await sleep(4_000);
    await pageB.keyboard.up("ArrowRight");
    // B then leaves the room entirely: with B gone no new bubble can
    // re-form, so the badge stays gone (a B that rejoined within bubble
    // radius would legitimately re-enter the call). It also covers a lost
    // walk-away (datagrams are unreliable): B's seat then drains with its
    // 30 s reconnect window and the call ends at the purge.
    await pageB.close();
    await waitUntil(
      async () => !(await badgeFor(pageA, NAME_B)),
      "B's 🎧 badge gone from A after walk-away",
      60_000,
    );
    console.log("   bubble torn down after walk-away");

    console.log("E2E PASS");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("E2E FAIL:", err.message);
  process.exit(1);
});

# Testing findings — 2026-11-12: analysis and fix plan

Each section keeps the original finding, adds the analysis (what the code
actually does, with file references) and a plan. Priority at the bottom.

---

# graceful close

## Finding

When closing a tab, using browser back, or opening a different page, the
avatar should leave immediately, e.g. by catching the `beforeunload` event.

## Analysis

- The client installs one lifecycle hook: a `pagehide` listener
  (`client/src/net/connection.ts:124-129`) that closes the WebTransport
  without sending anything. There is no `beforeunload`/`unload` handler, and
  the MoQ session is never explicitly closed.
- The server notices the dead command stream and marks the member
  `gone_at` (`crates/campfire-server/src/realtime.rs:330-339` →
  `World::discard`), but the member — avatar, roster entry, call seat — is
  only removed by the 30 s reconnect-window sweep
  (`world.rs:33 RECONNECT_WINDOW`, tick sweep `world.rs:548-561`). Hence the
  ghost avatar lasting up to 30 s.
- The explicit leave path already exists and is immediate:
  `ClientMsg::Leave` → `World::leave` → `remove_from_room` + `Left`
  broadcast + call-end (`realtime.rs:419-430`, `world.rs:465-472`). A room
  leave also covers call membership (`remove_from_room` calls
  `leave_call`), so one message is enough.
- Constraint: `pagehide` with `event.persisted === true` (back/forward
  cache) must **not** send `leave`. The `pageshow` restore path
  (`connection.ts:130-138`) re-joins with the sessionStorage token, which
  only works while the server-side membership survives
  (`world.rs:308-351`).
- The MoQ session rides a second QUIC connection. On a hard tab close the OS
  drops the UDP socket without a QUIC close, so the server only notices via
  idle timeout — the session task (and its clone of the call's fanout
  origin) lingers. An explicit client-side `moq.stop()` closes it cleanly
  (`moq.ts:441-471`).

## Plan

1. `connection.ts` `pagehide` handler: if `event.persisted === false`,
   first write `{ t: "leave" }` on the command stream (best effort — QUIC
   flushes it in the same packet batch as the close), then close the
   transport as today. For `persisted === true`, keep the current behavior
   exactly (close only, so bfcache restore re-joins via token).
2. Wire the same event into the call manager: on hard hide, stop the MoQ
   session (`CallManager` → `MoqCall.stop()`) so the server's MoQ session
   ends with a clean close instead of sitting out the idle timeout.
3. Server side: the `leave` path gains a grace map. `World::leave` removes
   the avatar at once (the room hears `Left`, no ghost) but parks the
   member's identity under `(room, token)` for the reconnect window, so a
   page reload — which is a `pagehide` leave followed by a token re-join
   within seconds — restores the same id, name and position (the room hears
   a fresh `Joined` for the unchanged id). The 30 s window still bounds the
   bfcache/restore and crashed-tab cases. `World::leave` is guarded by the
   leaving session's id: a late in-flight `leave` from the old session must
   not clobber a member a newer session already restored (unit-tested).
4. Test: close a tab (hard unload), assert the server sends `Left` within a
   second (e2e: second client observes `onLeft`), assert a bfcache
   back/forward round-trip still re-joins with the same identity, and assert
   a reload (pagehide leave + token re-join) comes back as the same user
   (e2e step 9; unit tests cover the grace expiry and the stale-session
   guard).

---

# latency view

## Finding

The latency values are not refreshed and only measured once. Jitter is
always 100 ms. Also: a small plot of the time series.

## Analysis

The 1 s refresh wiring is fine; the values are constant because the input
signal is dead. Chain:

1. The tile label (`client/src/call/callui.ts:229-234`) shows
   `sync.out.delay` and `sync.out.jitter` from
   `MoqCall.viewOf` (`client/src/call/moq.ts:529-541`), refreshed at 1 Hz
   (`call/manager.ts:479` stats timer, `moq.ts:254` hook timer).
2. `@moq/watch`'s `Sync` sets jitter to `max(20 ms, minRTT × 1.25)` once a
   PROBE RTT exists, else a flat 100 ms default
   (`node_modules/@moq/watch/player-B6mw85kT.js`, constants `Pe = 20 ms`,
   `W = 100 ms`). With no probe RTT, jitter = 100 ms forever, and with no
   registered rendition jitter, delay = jitter = 100 ms forever. The label
   is constant, which reads as "measured once".
3. The RTT comes from `session.probe` (`moq.ts:281`): the Lite02 PROBE
   message, which is the *publisher's* report of its connection
   (`@moq/net/lite/probe.d.ts`: "the publisher's current view of the
   connection"). For our downlinks the publisher is the SFU.
4. The SFU never reports an RTT anyway: moq-net only fills PROBE `rtt`
   when the transport stats provide one
   (`third_party/moq-net/src/lite/publisher.rs:489-495`), and the h3 bridge
   does not implement `web_transport_trait::Session::stats()`
   (`crates/campfire-server/src/moq/h3wt.rs` has no `stats()` override;
   trait default `StatsUnavailable`,
   `web-transport-trait-0.4.0/src/lib.rs:134`).
5. **Deeper: the negotiated version has no PROBE at all.** Both ends run
   **moq-lite-02** (server log `version=Lite(Lite02)`; the browser is
   pinned to it — h3 0.0.8 only accepts `:protocol` `webtransport` /
   `connect-udp`, so `@moq/net` takes its legacy in-band-SETUP browser
   compat path, `docs/moq-sfu.md` Phase 2 notes). In lite-01/02 there is
   no PROBE message; lite-03 carries bitrate only; the RTT field is added
   in lite-04 (`@moq/net/lite/version.js hasProbeRtt`,
   `third_party/moq-net/src/lite/version.rs`). So
   `session.probe` is **always empty on the versions we negotiate** —
   even a server that implemented `stats()` would have no PROBE stream to
   put it in. The 100 ms constant is structural in lite-02, not a missing
   metric.
6. What *is* available in lite-02:
   - `WebTransport.getStats(): Promise<WebTransportConnectionStats>` on
     every `WebTransport` object (`smoothedRtt`, `minRtt`,
     `rttVariation`, `bytesSent`, `estimatedSendRate`, ...) —
     transport-level, independent of the MoQ version. There is **no `rtt`
     event** on `WebTransport` (the instance API is only
     closed/congestionControl/datagrams/draining/incoming*/protocol/ready/
     reliability plus methods incl. `getStats` — MDN and the W3C spec,
     verified) — the RTT comes from polling `getStats()`. We own the
     realtime `/wt` WebTransport (`client/src/net/connection.ts`, `WTConn`),
     so we can poll it. (The MoQ session's `WebTransport` is internal to
     `@moq/net`; `Established.transport` is only a string label. Same
     host/path, different QUIC connection — a close proxy.) Caveat: Chrome
     has not enabled `getStats()` by default yet (Chromium issue 573538454,
     the `WebTransportStats` runtime feature) — the code guards
     (`typeof getStats === "function"`) and treats RTT as optional
     (absent → the label omits the RTT part).
   - `Established.stats(): Promise<Stats>` snapshots the session's
     `WebTransport.getStats()` on demand
     (`@moq/net/connection/established.d.ts`): `estimatedSendRate`,
     `bytesSent`, ... — local measurements, no PROBE involved. Its
     `transportStats` swallows a failing `getStats()` and returns `{}`, so
     polling is unconditionally safe; the same Chrome caveat applies.

## Plan

1. Client: make the two numbers meaningful — the tile label shows e2e
   playback delay (`sync.out.delay`, how far the canvas trails the live
   edge) plus transport RTT. The RTT comes from **polling
   `getStats()`** on the `WebTransport` object in `WTConn`
   (`client/src/net/connection.ts`) — there is no `rtt` event on
   `WebTransport` (MDN/spec verified; the `rtt` event does not exist in
   the instance API), and `getStats()` is not enabled by default in Chrome
   yet (Chromium 573538454) — so the code guards
   (`typeof getStats === "function"`) and treats RTT as optional:
   `Connection.getRtt(): Promise<number | null>` (the `/wt` WebTransport
   only; the SSE fallback returns `null`), `smoothedRtt` in ms. It is
   transport-level, independent of the MoQ version, so it is populated in
   lite-02 where `session.probe` is always empty (see analysis 5). Cache
   the latest poll in `WTConn`; refresh on the existing 1 Hz stats timer
   (`manager.ts`). The `/wt` connection is a second QUIC connection to the
   same host and path, so it rides the same path (and the same zScaler
   link) as the MoQ session — a close proxy for it.
2. Sparkline: per-peer ring buffer of delay samples (~90 samples at 1 Hz),
   drawn as a small polyline (SVG or a 60×20 canvas in the tile footer),
   redrawn on the same 1 Hz tick. Plot delay (e2e); RTT as a second line
   or on hover.
3. Note for the display: after the 1 s entry delay from the video-catch-up
   work below, the delay figure starts near 1000 ms and settles to the
   steady delay (≈ 300 ms after the shrink) — that is the correct e2e
   number, not a bug.
4. Demoted to a follow-up: implementing `stats()` on the h3wt bridge
   (`quinn::Connection::stats()` → moq-net PROBE) has no effect in
   lite-01/02 — there is no PROBE message to carry it (analysis 5). It
   only becomes live once both ends negotiate lite-04+ (bitrate in
   lite-03, the RTT field in lite-04), which is blocked on the server's
   h3 0.0.8 pinning the `:protocol` values the browser accepts (→ lite-02).
   Park as a research item tied to the h3 upgrade; once the version
   moves, swap `session.probe.rtt` into the label in place of the `/wt`
   proxy.

---

# screenshare broken

## Finding

When sharing my screen, the other side sees the screenshare but my
videostream breaks: they only see my screen, not me.

Refined reproduction: works with two tabs/profiles side by side on one
machine; breaks when both clients are behind zScaler. Reproducible there:
start sharing → the screenshare is delivered, but the peer's **camera and
audio freeze immediately**. So: not a slow degradation, and audio is
affected too.

## Analysis

- All three renditions ride one hang: camera `v`, mic `a`, screen `s`
  (`client/src/call/moq.ts:391-405`; the camera is deliberately **not**
  muted, `call/manager.ts:165-168`).
- The "camera source falls back to the wrong rendition" theory (the
  documented `@moq/watch` trap, `docs/moq-sfu.md` Phase 3 notes) cannot be
  the whole story: it would kill the camera canvas only, not audio.
- The pattern — the **new** track (`s`) is delivered, the **existing**
  tracks (`v`, `a`) freeze the moment the share starts — points at the
  catalog re-announce. Adding `s` changes the hang catalog, so the
  publisher re-announces the hang. In the SFU (moq-net), a re-announce
  re-routes the hang; the existing per-track subscriptions for `v`/`a` are
  invalidated and die — the same bug family as the Phase 3 known issue
  (`docs/moq-sfu.md`: a re-announced hang is not re-routed for existing
  consumers, "B stays dark until both sessions tear down"). The receiver's
  `Watch.Video/Audio.Source`s track the resolved rendition *name*
  (`out.track` still says `"v"`), so they never re-subscribe. The new `s`
  subscription is created after the re-announce and works.
- Demand gate (Phase 2 notes): `@moq/publish` renditions encode only while
  a subscriber is attached. If the SFU's `v`/`a` subscriptions die, the
  sender stops encoding `v`/`a` as well — the freeze becomes permanent
  even on a healthy transport.
- Why it only shows behind zScaler: on LAN the re-announce/re-resolution
  round-trip is sub-millisecond and any transient is hidden (the next
  keyframe is ≤ 1 s away). Over the zScaler path (higher RTT/loss) the
  re-subscribe path does not complete. Consistent with the Phase 3
  observation that a re-routed hang stays dark indefinitely. (A 30 s LAN
  check of the receiver's `frames` counter during share start settles
  whether LAN also dips briefly.)
- The stale server comment `world.rs:667-668` ("the camera video track is
  replaced by the screen, no renegotiation") does not describe the actual
  model and gets fixed along with the change.

## Plan

1. Diagnose on the immediate zScaler repro (no soak needed):
   - Receiver: `__campfire_moq_down` — confirm camera `frames` and audio
     bytes freeze while `screenFrames` rises.
   - Server: enable moq-net debug tracing; on share start, watch the
     re-ANNOUNCE on the hang path and the SUBSCRIBE/route events for
     `v`/`a`/`s`. Does the SFU kill the existing `v`/`a` subscriptions?
   - **Discriminator (server-side vs receiver-side):** right after the
     share starts, subscribe to the same hang out-of-band with the spike
     subscriber (`--no-publish` mode). If it also gets no `v`/`a` frames,
     the break is in the SFU re-route; if it does, the receiver client is
     failing to re-subscribe.
   - Sender: check whether the publisher stops encoding `v`/`a` (demand
     gate); expose the renditions' demand state in the `__campfire_moq`
     hook.
2. Fix (primary): **separate the screen into its own hang.** Publish `s`
   under its own namespace (e.g. `call/<room>/<id>.screen.hang`, single
   rendition), so starting/stopping a share never mutates the camera/mic
   hang's catalog: no re-announce, no subscription invalidation, no
   demand-gate drop. Client-only change — the server fan-out is
   namespace-agnostic (per-call origin). Concretely: a second uplink
   `Publish.Broadcast` for the screen, and a second downlink
   `Watch.Broadcast` per peer for it; the `call_screen` presence message
   and tile wiring are unchanged. On stop, the screen hang is unannounced
   and the receiver's screen gate goes idle as today.
3. Fix (defensive, regardless of the diagnosis): make the downlink sources
   re-announce-proof. Subscribe to `broadcast.out.catalog` changes; on a
   catalog-identity change, force re-resolution of `v` and `a` (flip the
   source's `target` getter, or rebuild the `Source` under a fresh effect)
   while keeping the resolved track name so tiles do not blank out. This
   also covers a peer's session re-announcing (the Phase 3 reload issue)
   on the main hang.
4. e2e: start-share → assert camera `frameCount` and audio bytes keep
   rising while `screenFrames` rises; stop-share → screen stops,
   camera/audio unaffected. Run the suite both clean and under
   `netem delay ~150 ms` (namespace harness, as the spike used) so the
   timing-dependent variant is caught in CI.
5. Fix the `world.rs:667-668` comment to describe the actual model (after
   the fix: camera+mic on the main hang, screen on its own hang).

---

# latency of other avatars

## Finding

The movement of other avatars has a lot of lag.

## Analysis

- Send path: the local player sends movement datagrams at 15 Hz while
  moving, 2 Hz when idle (`client/src/main.ts:26-27`, `SEND_EVERY_MS = 66`).
- Server: one room-wide batch per 50 ms tick, split into ≤1200 B datagrams
  (`crates/campfire-server/src/world.rs:26 TICK`, `544-608 tick()`). Fine.
- Render path is the problem. `AvatarManager.movement()` stores two
  snapshots stamped with **client arrival time**
  (`client/src/world/avatars.ts:252-277`); `update()` interpolates
  `t = (now - prevT) / (curT - prevT)` clamped to 1
  (`avatars.ts:300-322`). At render time `now >= curT` always holds (rAF
  runs after datagram processing), so `t == 1` always: the displayed
  position is a **step function at the 15 Hz arrival rate**. The
  interpolation and the `SNAP_MAX_LAG_MS` / `SNAP_THRESHOLD_TILES` branches
  are dead code in steady state. 15 Hz steps plus up to ~100–150 ms of
  pipeline delay (send interval + tick + network) with no smoothing is
  exactly the perceived lag.

## Plan

1. Real interpolation with a render delay (client only,
   `world/avatars.ts`):
   - Keep a small per-avatar history of the last ~10 snapshots
     `{x, y, dir, moving, t}` (arrival-time stamped, ~1 s deep).
   - Render at `tRender = now - LOOKAHEAD` with `LOOKAHEAD ≈ 120–150 ms`
     (≈ 2× the 66 ms send interval): find the two snapshots bracketing
     `tRender` and interpolate. If the history is older than
     LOOKAHEAD + margin (sender stopped, or gap), extrapolate along the
     last direction at the last speed for up to one margin, then stop.
   - The local player keeps rendering from its own input (no lookback).
2. This turns 15 Hz updates into smooth 60 fps motion and absorbs one tick
   of network jitter. No server change needed.
3. Only if still visibly rough on a slow WAN: raise the local send rate to
   20 Hz while moving (66 → 50 ms, cheap), or add a server batch
   timestamp so clients interpolate on the server timeline instead of
   arrival time. Measure before doing either.

---

# skipping when falling behind the video stream

## Finding

When the client falls behind the video stream, skipping the video is fine,
but the **audio** must not be skipped — it should play faster (time
compression) to catch up. When entering a room, playback should start
delayed by 1 s to ease the initial sync.

## Analysis

- Playback: per-peer `Watch.Video.Source` → `Decoder` → `Renderer` into a
  canvas, audio through the library's decode → ring → AudioWorklet
  pipeline, all paced by one `Watch.Sync` (`client/src/call/moq.ts:279-331`).
- **Video skip (accepted, no change).** `Sync.wait(ts)` returns
  immediately for any frame past the playhead and the renderer presents the
  newest decoded frame per rAF tick — a video backlog is dropped to live.
  That stays as is.
- **Audio skip (the bug).** Three places drop audio backlog today:
  1. Transport: the subscription's `maxAge` = `sync.out.maxAge` = delay +
     `buffer` input; with `buffer` unset (0) and the dead probe
     (latency-view issue) delay ≈ 100 ms, so the transport drops audio
     older than ~100 ms from the live edge before it is decoded.
  2. Ring reader (shared path): `SharedRingBuffer.read()` in non-buffered
     mode skips the excess — `if (!buffered && latency > 0 &&
     buffered > latency) read = write - latency` — i.e. the backlog is
     dropped at read time.
  3. Writer: `insert()` drops samples older than the read cursor and
     overflow advances the cursor (`#advance`). The postMessage-fallback
     ring (`AudioRingBuffer`, used when SharedArrayBuffer is unavailable —
     which is the path the dev loop actually runs, per the Phase 3 notes)
     has no read skip but also no speed-up, so a backlog there means
     permanent drift.
- **The lever is `Sync.in.buffer`** (bundle, `Sync` effects `#a`/`#o`/`#s`):
  - `maxAge = out.delay + in.buffer` — grows the transport backlog budget
    for *all* tracks of the subscription;
  - `out.buffered = (in.delay ≠ "instant" && in.buffer > 0)` — switches the
    ring into buffered mode: capacity = 2 × depth, and the read skip
    above is disabled (the backlog stays in the ring instead of being
    dropped — it then *must* be drained faster, which is exactly the fix);
  - ring depth follows `out.delay` (`ringSamples(rate, delay)`,
    `audio/latency.d.ts`).
- **Capacity invariant.** Backlog that can arrive ≈ `maxAge − delay =
  buffer`; ring capacity = 2 × delay (buffered mode). The backlog fits
  without writer drops iff `buffer ≤ 2 × delay`. Drive both from one knob:
  entry delay 1000 ms → buffer 2000 ms (maxAge 3 s, capacity 2 s); steady
  delay 300 ms → buffer 600 ms (maxAge 900 ms, capacity 600 ms).
- **Where the speed-up must live.** The backlog sits in the ring, drained
  by an AudioWorklet that produces exactly one 128-sample render quantum
  per tick. A `PlaybackRateNode` downstream cannot accelerate a live
  worklet (it starves: the input only arrives at real time). So the
  catch-up goes into the ring reader itself: while
  `excess = (WRITE − READ) − LATENCY > 0`, consume `rate = min(1 + excess
  / LATENCY, 2.5)` quanta's worth of samples per output quantum via linear
  interpolation (fractional read cursor); otherwise read 1:1. The worklet
  already has WRITE/READ/LATENCY in its control slots — the decision is
  self-contained, no main-thread round trip.
- Costs/notes: the worklet is an embedded Blob string inside the
  `@moq/watch` bundle, so this means patching the npm package
  (patch-package or a vendored copy) — same mechanism as the h3-quinn
  patch in the leaky section, both ring classes need it (shared +
  postMessage). Time compression without a time-stretch DSP raises pitch
  with the rate (2× = +1 octave); acceptable for a catch-up transient
  (bounded by the backlog size), note it in a code comment. A/V: video
  jumps to live immediately, audio compresses behind it; the transient
  skew decays to zero as the ring drains — accepted per the requirement
  (no audio skips outranks A/V tightness).
- Entry: today `delay: "auto"` sizes the buffer from the (dead) probe →
  ~100 ms; the first burst of late frames re-anchors the clock
  (`Sync.received`), giving the choppy start.

## Plan

1. **1 s entry delay.** `Sync.in.delay` is a `Getter<Delay>` — drive it
   from a signal: start each downlink at `Time.Milli(1000)`; after a
   stability window (e.g. 4–5 s without `decoder.out.stalled` and no
   late-frame spikes), shrink it to the steady value (e.g. 300 ms, or back
   to `"auto"` once the probe RTT is real — see the latency-view server
   fix). The Sync wait loop wakes on delay changes (the bundle's wait
   watches `in.delay.changed`), so the shrink takes effect live; the ring
   resize on shrink keeps the newest samples (library behavior).
2. **Backlog budget.** Drive `Sync.in.buffer` = 2 × delay from the same
   signal (entry: 2000 ms, steady: 600 ms). This switches the rings into
   buffered mode (no read skip) and grows `maxAge` so the backlog reaches
   the decoder instead of being dropped.
3. **Video: no change.** Keep the library's drop-to-live (skip) —
   explicitly accepted.
4. **Audio time compression (the core fix).** Patch the ring readers in
   `@moq/watch` (patch-package or vendored copy under `third_party/`):
   - `SharedRingBuffer.read()` (worklet, shared path): remove the
     non-buffered skip; while `excess = (WRITE − READ) − LATENCY > 0`,
     read `rate = min(1 + excess / LATENCY, 2.5)` samples per output
     sample (linear interpolation, fractional read cursor), else 1:1.
   - `AudioRingBuffer.read()` (postMessage fallback — the path actually
     used without SharedArrayBuffer): the same speed-up; without it,
     buffered mode there means permanent drift.
   - Control is self-contained in the worklet (WRITE/READ/LATENCY are
     already in the control slots); no new messages, no main-thread
     wiring. Diff is small (~30 lines in two classes).
5. **Test:** force a backlog (DevTools CPU throttle, or netem burst on the
   downlink); assert: audio underflow stays ~0 (the worklet already
   counts/logs it — no gaps), the ring depth drains back to LATENCY
   (expose it via the `__campfire_moq_down` hook), rate returns to 1,
   video skipped (sanity), A/V skew decays after the transient. Re-run
   under the postMessage path (no SAB) since that is the dev-loop default.
6. **Fallback if the patch proves invasive:** own audio pump — one shared
   `AudioContext` plus our own worklet with rate control (the Phase 4+
   concern noted in `docs/moq-sfu.md`); bigger build, and it would also
   fix the per-peer `AudioContext` budget (a 9-person bubble exceeds
   Chrome's 6-context limit). Keep as a documented follow-up.

---

# tcp fallback page is shown initially

## Finding

When freshly opening the page, Chrome still shows the fallback page.
Refreshing shows the app. It should automatically reload to QUIC.

## Analysis

- The app is served only from the HTTP/3 listener. TCP/443 is answered by
  hand in `crates/campfire-server/src/bootstrap.rs`: a first request
  (without `alt=1`) gets `302` to the same URL with `?alt=1` plus
  `Alt-Svc: h3=":<port>"; ma=86400` (`bootstrap.rs:42,86-89,134-142`); a
  request that still arrives over TCP **with** `alt=1` gets a static
  explanation page with no JS and no reload (`bootstrap.rs:120-133`).
- Fresh load: the browser has no cached Alt-Svc for the origin, so the
  first request goes over TCP; the 302 redirect rides the same TCP
  connection → fallback page. Refresh: Alt-Svc is already cached from the
  first response, so the navigation goes straight over QUIC. There is no
  retry logic anywhere (no client code reads `alt=1`).

## Plan

1. Make the fallback page self-healing (server, `bootstrap.rs`): embed a
   small script that after ~1.5 s does `location.replace(location.href)`,
   counting attempts in `sessionStorage` (e.g. `campfire-quic-retry`).
   After ~5 failures (≈8 s) stop and show the final "UDP to this port is
   not reachable" message (keep the current text for that case). By the
   time the script runs, the `Alt-Svc` header from the current response is
   cached, so the replacement navigation should land on QUIC. (A plain
   `<meta http-equiv="refresh">` is the fallback if the script must stay
   minimal — it cannot count attempts or stop.)
2. Verify: clean Chrome profile, fresh load reaches the app within ~3 s
   without a manual refresh; a UDP-blocked simulation (e.g. local proxy
   dropping UDP) ends on the final message, not a reload loop.

---

# videostreams should scale to throughput

## Finding

Can we scale down the video streams according to internet speed? Maybe by
enforcing a certain encoding (e.g. AV1) client-side so the server can
cheaply adjust resolution per client?

Scope (decision): for now only the **uplink** — what each client uploads —
needs automatic adjustment. The **downlink** (what each viewer receives)
stays as is; that part is deliberately deferred and still open (see the
last item of the Plan).

## Analysis

- Current uplink: capture ideal 720p30 (`client/src/call/media.ts:12-25`);
  the encoder config sets only `keyframeInterval: 1000`
  (`client/src/call/moq.ts:216-223` camera, `399-404` screen). No bitrate
  ceiling, no feedback.
- `@moq/publish` already supports what is needed: `Encoder.Config` accepts
  `codec, maxPixels, maxScale, maxBitrate, bitrateScale, frameRate`
  (`node_modules/@moq/publish/video/encoder.d.ts:16-24`), and
  `EncoderInput.bandwidth` takes a `Moq.Bandwidth.Handle`
  (`encoder.d.ts:26-30`): the encoder reserves its configured bitrate
  ceiling on the handle and caps the resolved target at the granted slice
  (bundle `encoder-rLv2ovr2.js`, grant applied via `Math.min` on the
  resolved bitrate). The client wires **neither** today.
- **The estimate must come from the local transport.** In the negotiated
  lite-02 there is no PROBE message (latency-view analysis 5), so neither
  `session.probe` (peer-measured) nor a server-side PROBE bitrate exists —
  the old "land the server `stats()` work first" prerequisite is moot.
  What does exist: `Established.stats(): Promise<Stats>`
  (`@moq/net/connection/established.d.ts:43`) snapshots the session's
  `WebTransport.getStats()` — `estimatedSendRate` (the congestion
  controller's send estimate, bps) and `bytesSent` (monotonic, no
  retransmissions or QUIC overhead). The library itself uses exactly this
  as its estimate source: the `Reload` wrapper polls `connection.stats()`
  every 100 ms and feeds `stats.estimatedSendRate` into its built-in
  `Bandwidth.Allocator` (`@moq/net/connection/reload.js`, the `BANDWIDTH_POLL`
  loop); and an `Allocator` whose estimate is `undefined` reports "no
  opinion, hold your rate" — so a browser without the field degrades to
  today's behavior instead of throttling to zero. `stats.js`
  (`transportStats`) swallows a failing/missing `getStats()` and returns
  an empty snapshot, so polling unconditionally is safe.
  - Caveat: `WebTransport.getStats()` is not enabled by default in Chrome
    yet (Chromium issue 573538454, "Ship WebTransport connection
    statistics", still open; the `WebTransportStats` runtime feature gates
    it). Verify in the dev loop; if `estimatedSendRate` is absent, fall
    back to the `bytesSent` diff over the poll interval × 8 (measured
    throughput — conservative: it reads below capacity while unsaturated,
    which is safe for a throttle).
- "The server adjusts resolution per client" (the deferred downlink part)
  is not cheap in this architecture: the SFU is plain fan-out and does not
  transcode; per-client adaptation would need simulcast or server
  re-encode, both explicitly out of scope (`docs/moq-sfu.md` §2
  non-goals). The adaptation that fits the architecture now is
  **client-side, per uplink**: each publisher scales its own encode to its
  own uplink. The `@moq/net` bandwidth allocator (`@moq/net/bandwidth.d.ts`:
  `Allocator`/`Handle`/`reserve`, strict-priority allocation, max-min fair
  within a priority tier) exists for exactly this.
- Codec: forcing AV1 is not clearly a win. Hardware AV1 encoding
  availability is uneven; the library already probes
  `VideoEncoder.isConfigSupported` and picks the best codec. Software AV1
  on a weak machine would trade network savings for dropped frames. Let
  the bandwidth adaptation do the scaling; codec stays unchanged.

## Plan

1. **Estimate** (client, `moq.ts`): one `Signal<number | undefined>` per
   MoQ session, updated on a ~1 Hz timer (skip the tick while a snapshot
   is pending, as `reload.js` does): `const s = await session.stats()` →
   `s.estimatedSendRate ?? bytesSent-diff × 8`. Expose both raw values on
   the `__campfire_moq` hook; log once if `estimatedSendRate` never
   appears in the test browser (decides whether the fallback is needed).
2. **Allocation** (client, `moq.ts`): one `Moq.Bandwidth.Allocator(estimate)`
   per session; pass the allocator to the `bandwidth` input of the camera
   (`v`) and screen (`s`) encoders (audio is fixed-bitrate — the
   allocator is advisory and ignores tracks that don't follow it). Camera
   and screen are both video kind, so they share one priority tier and
   the split is max-min fair; if camera-first bias matters in practice,
   give the screen rendition a lower configured bitrate ceiling so it
   claims less.
3. **Ceilings** (client, `moq.ts`): add `maxPixels: 1280 × 720`,
   `frameRate: 30` to the camera config and `frameRate: 15` to the screen
   config (screen capture already targets 15 fps, `media.ts:30-35`) so the
   auto-sizing has a bound.
4. **Test**: throttle the uplink (netem in the namespace harness, as the
   spike did); assert the encoder's `out.resolved`
   (`VideoEncoderConfig`: `width`/`height`/`videoBitsPerSecond`) steps down
   under throttle and back up when it clears, and the camera keeps
   delivering frames the whole time. Run the e2e suite once with a
   throttled uplink.
5. **Downlink (deferred by decision): no change.** Candidate designs for
   when this is reconsidered: (a) server-side simulcast with the receiver
   picking a rendition from its own downlink (measurable client-side from
   the `bytesReceived` arrival rate or decode stalls) — the only real fix,
   but it makes the SFU publish multiple renditions per origin, i.e. an
   SFU feature beyond plain fan-out; (b) feedback via PROBE
   `estimatedRecvRate` once the negotiated version is lite-03+ — still
   per-subscriber rather than per-viewer, so it only helps together with
   (a); (c) do nothing more: the library already drops frames under load,
   which is the de-facto downlink behavior today.
6. **Document**: scaling is per-uplink, client-side; the SFU does not
   transcode (README + plan doc §2 non-goals stay true).

---

# something is leaky

## Finding

After hanging in a call for a while, the connection gets very bad.
Re-joining helps, but the intervals between call breaks get shorter over
time. Server logs show `ConnectionError: Timeout`, `StreamClosed` write
errors, and repeated panics in `h3-quinn-0.0.10/src/lib.rs:394`
(`Option::unwrap()` on `None`).

## Analysis

Three distinct problems, all visible in the logs:

1. **The h3-quinn panic** (the task-death cause).
   `h3-quinn-0.0.10/src/lib.rs:394` is `RecvStream::stop_sending`:
   `self.stream.as_mut().unwrap()`. `poll_data` moves the stream out of
   that `Option` while a `read_chunk` is in flight
   (`lib.rs:376-384`); if h3 calls `stop_sending` on the same stream
   meanwhile — which is exactly what teardown does (connection timeout,
   peer reset; our `ConnectionError: Timeout` events) — the `Option` is
   `None` and the `unwrap` panics. The panic kills the tokio task driving
   that QUIC connection mid-teardown, so the session's own cleanup
   (`drop(session)`, metrics, `quic.close`,
   `crates/campfire-server/src/moq/session.rs:179-190`) is skipped.
   h3-quinn 0.0.10 is the **latest** release of the 0.0.x line — no
   upstream upgrade fixes it. `recv_id` (line 401) has the same latent
   `unwrap`.
2. **Idle MoQ connections get reaped.** `ConnectionError: Timeout` on
   `recv_stream.read` is the quinn idle timeout on a MoQ QUIC connection
   with no traffic (server default `idle_timeout_secs = 300`,
   `config.rs:28`; the log cadence 07:26:34 → 07:27:04 shows the running
   environment uses ~30 s). A call connection goes idle when media stops
   flowing — which is what happens when a media path is dead: the known
   Phase 3 issue (`docs/moq-sfu.md`, Phase 3 implementation notes) is that
   a re-announced hang (peer tab reload) is not re-routed by the SFU, so
   the peer's downlink stays dark. Then: idle → timeout →
   `moq session ended` → client reconnects (the `moq session admitted`
   pair at 07:30:48) → idle again. The `StreamClosed` write errors are the
   same teardown: the session task writing to a stream after the
   connection is gone. Nothing keeps a quiet MoQ session alive: no QUIC
   keep-alive on the endpoint, no app-level ping on the session.
3. **Unbounded `Fanout.origins` leak** (the "gets worse over time" cause).
   `moq/session.rs:137` creates the per-call origin after the
   `call_active` check but **before** the WebTransport upgrade. If the
   call ends in that window — or the upgrade/handshake fails — the
   call-end hook never fires for that id again, and the origin entry
   (driver task + 16 MiB cache pool, `moq/fanout.rs:23-24,41-62`) lives
   for the process lifetime. There is no TTL or sweeper on
   `Fanout.origins`. Join/leave churn accumulates entries: memory growth
   plus zombie driver tasks. Related zombie path: `h3wt.rs`
   `SendStream::closed` waits on `std::future::pending()` unless
   interrupted (`h3wt.rs:274-285`), and nothing times out a session task
   from outside, so a hung task holds a `Producer` clone of its origin and
   a quinn `Connection` clone forever — the origin is then never dropped
   either.

## Plan (in impact order)

1. **Patch h3-quinn** via `[patch.crates-io]` to a small fork (or a vendored
   copy under `third_party/`): in `RecvStream`, make `stop_sending` a no-op
   when `stream` is `None` (the in-flight read surfaces the termination on
   its own) and cache the stream id at construction so `recv_id` never
   touches the `Option`. Two-line patch, no behavior change otherwise.
   Verify with the timeout repro: no more `panicked` lines, and the
   session cleanup runs (`moq session ended` logged, metrics close).
2. **Keep-alive for quiet connections**: set
   `quinn::TransportConfig::keep_alive_interval(Some(15 s))` in
   `crates/campfire-server/src/tls.rs`. Quinn PING frames reset the idle
   timer on live-but-quiet connections (covers both `/moq` and `/wt`; the
   client's 25 s ping and the server's 300 s command-stream sweep already
   bound `/wt` independently). This alone kills the idle-timeout death
   spiral for healthy connections.
3. **Fix the re-route** (the Phase 3 known issue) — the root cause of
   *quiet* media: a re-announced hang after a peer reload is not re-routed
   by the SFU, leaving a dark downlink and hence an idle connection. The
   Phase 3 notes already rank the break candidates (a: new session does
   not re-announce, b: SFU does not re-route, c: the other peer's
   `Watch.Broadcast` does not re-resolve). If it is a moq-net behavior we
   cannot change, work around it: the server forces a re-subscribe when a
   hang is re-announced, or the client re-subscribes on re-announce
   detection. This is the fix for the recurring "call breaks" loop, and it
   shares its root with the "screenshare broken" issue: a re-announce
   (there: adding the `s` rendition) invalidates the existing `v`/`a`
   subscriptions the same way.
4. **Fanout leak:**
   a. Admission order: create the origin only after `upgrade.accept()`
      succeeds; on any setup failure after creation, drop it again
      (`fanout.drop_call`). Hold a `JoinHandle` per session task; if the
      task ends (or panics) before the call did, drop the origin if no
      live session references it.
   b. Sweeper: entries in `Fanout.origins` carry a `last_used` timestamp
      (updated in `origin()`); a periodic task (or a piggyback on the
      world tick) removes entries idle for ~5 min or whose call the world
      reports inactive. The `campfire_moq_origins` metric already exists —
      assert in the e2e that it tracks the number of active calls and
      returns to baseline after teardown.
5. **Contain session tasks**: register the `JoinHandle`s; on
   `JoinError` (panic) run the cleanup the task would have run (metrics,
   `quic.close`) and log the panic with the call id. No silent zombies,
   and any remaining leak becomes visible in the logs and metrics.
6. **Soak test**: extend `tools/e2e/moq.js` (or add a justfile target) with
   a 30-min soak — two clients in a call, camera on, quiet network. Assert:
   no `panicked` in server logs, no `moq session ended` without a
   client-side cause, `campfire_moq_origins` back at baseline after
   teardown, RSS growth within a gate. This is the regression net for the
   whole cluster.

## Verification

Run the e2e suite plus the soak; grep server logs for `panicked`,
`StreamClosed`, `ConnectionError: Timeout`; confirm a call survives well
past the previous ~10-minute breakage point with stable quality.

# infinite redirects on login

## Finding

When enabling authentication, after login and redirect I get a 302 again
from the server which starts the whole authentication over.

## Analysis

Flow: the client probes `/api/v1/auth` on boot (`boot.ts` `resolveForcedName`);
with auth on and no session it does `location.replace(/auth/login?return_to=…)`
→ 302 to the IdP → the IdP redirects to `/auth/callback?code&state` → on
success the server sets the `campfire_auth` cookie and 302s back to
`return_to`, where the probe now sees the name.

There is no other place the server 302s into the auth flow: the second 302
the user sees is the *client* re-running the probe with no valid cookie and
redirecting to `/auth/login` again. So the loop is: **the cookie the
callback set is not valid on the next probe**. Two root causes:

1. **The callback fails, and the failure is silent** (`api.rs`
   `auth_callback`): every `handle_callback` error 302s to `/` **without
   setting a cookie**. The probe then finds no session and sends the
   visitor to the IdP again — an infinite loop whose only trace is one
   `auth callback failed` WARN line in the server log. Every sub-failure
   looks identical to the user:
   - token-exchange failure (redirect URI mismatch against the IdP
     registration, wrong client secret, expired code);
   - `iss` validation failure — **a code bug**: `Auth::new` stores the
     configured issuer verbatim and uses it for `iss` validation, while
     the discovery URL is built with the trailing slash trimmed
     (`auth.rs` `discovery()`). A `--auth-openid-issuer=https://sso/`
     (trailing slash, a common way to type a URL) therefore fails `iss`
     against every IdP that issues the slash-less value — a guaranteed
     loop;
   - nonce mismatch (an IdP that omits the `nonce` claim in the
     `id_token`);
   - no usable name claim.
2. **The browser never stored the cookie** (deployment): a `Secure`
   cookie served over plain HTTP behind a terminating proxy, or a proxy
   stripping `Set-Cookie`. Not fixable in the code — but cause 1's silent
   302 makes every such deployment an unbreakable loop with no feedback.

## Plan

1. **Normalize the issuer** in `Auth::new`: store
   `issuer.trim_end_matches('/')`, so `iss` validation and the discovery
   URL always use the same canonical value (trailing-slash configs work).
2. **Break the loop on callback failure**: instead of the silent 302 to
   `/`, answer the callback error with a small 200 error page ("Sign-in
   failed: \<reason\>" + a *Try again* link to `/auth/login`). The reason
   is shown as-is: the audience is the operator, who needs it to fix the
   config. The server WARN is kept.
3. **Test** (new `tests/auth.rs`, mock IdP): a loopback mock IdP
   (discovery document, authorization endpoint that echoes `state`/`nonce`
   into a signed `id_token`, JWKS, token endpoint) plus the real server
   with auth enabled; drive the browser's steps with a cookie-keeping
   client:
   - full happy path: probe (no name) → `/auth/login` → mock IdP →
     `/auth/callback` → Set-Cookie → probe returns the forced name;
   - the same path with a **trailing-slash issuer** (regression for the
     `iss` bug);
   - a failed callback (unknown code) answers the error page, **not** a
     302 to `/`.

## Verification

`cargo test -p campfire-server` (the new `tests/auth.rs`), then a manual
run with a real IdP: first login lands on the requested page with the
forced name; a deliberately broken `--auth-openid-redirect-uri` shows the
error page instead of looping.

---

# Priority

| # | Issue | Priority | Why |
|---|---|---|---|
| 8 | leaky (h3-quinn patch, keep-alive, fanout leak, re-route) | P0 | stability; everything else rides on a connection that dies |
| 1 | graceful close | P0 | small, user-visible, 30 s ghost avatars |
| 4 | avatar lag (interpolation + render delay) | P1 | user-visible in every room |
| 5 | catch-up play-faster + 1 s entry delay | P1 | user-visible in every call |
| 2 | latency view (client RTT + sparkline) | P1 | small, client-only; server `stats()` demoted to follow-up (no PROBE in lite-02) |
| 3 | screenshare (camera dies on share start) | P1 | user-visible feature break |
| 6 | TCP fallback auto-reload | P2 | one-time annoyance per fresh browser |
| 7 | uplink throughput scaling (bandwidth adaptation) | P2 | quality feature, client-only; downlink part deferred |

Suggested order: 8 → 1 → 2 → 4 → 5 → 3 → 6 → 7, with the soak test landed
together with 8 and re-run after each of 3 and 5. #2 and #7 are now both
client-only and independent of each other (no shared server prerequisite
any more).

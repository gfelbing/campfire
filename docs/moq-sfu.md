# Media rebuild: SFU via Media-over-QUIC

Status: plan (approved direction). Supersedes the WebRTC/TURN media stack
(commit `7c640c4`, left in history as an accepted broken intermediate state).

## 1. Goal

Replace the WebRTC mesh + TURN relay with a server-side SFU speaking MoQ
(Media-over-QUIC) over WebTransport, so that:

- **All media transits the server, never P2P** — and never via a TURN relay.
- **Each client encodes once and uplinks once.** The SFU fans each track out
  to the bubble's other members.
- **The network surface shrinks to what the app already requires**: one port
  number (443), UDP for QUIC/HTTP/3 + WebTransport + MoQ, TCP for the TLS
  front (Alt-Svc bootstrap + TCP fallback). STUN, TURN, and the UDP relay
  port range (49152–65535) disappear.

| Surface | Today (`7c640c4`) | After |
|---|---|---|
| 443/UDP | QUIC/HTTP/3 + WebTransport + STUN | QUIC/HTTP/3 + WebTransport + MoQ |
| 443/TCP | TLS front: Alt-Svc bootstrap + TURN splice | TLS front: Alt-Svc bootstrap (TCP fallback) |
| TURN relay | UDP range 49152–65535 (broken: no UDP relay interface) | removed |
| STUN | WebRTC ICE only | removed |

What keeps working unchanged: proximity bubbles and `jitsiRoom` zones,
`silentZone` DND, screen share, mute/camera presence, the 9+ auto
voice-only degrade, reconnect-with-token, bystander headphone badge.

## 2. Non-goals

- **UDP-blocking / MITM networks.** MoQ over WebTransport needs UDP/443 —
  exactly what the app's core data path already needs. The TCP fallback
  carries the world (movement, chat, call signaling) but **no media**. This
  rebuild makes firewall approval trivial (one standard port number) but
  does not make media work where UDP is blocked; real-time media is
  fundamentally limited there.
- **End-to-end media encryption.** Today DTLS-SRTP means "the server can
  never decrypt it". An SFU handles encoded frames: media stays QUIC-
  encrypted in transit, but the server becomes a media party (it could
  forward or record). This is an accepted product decision and the README
  must say so (§7 of the plan).
- **WebRTC fallback.** Feature-detect WebTransport + WebCodecs; without
  them, calls are unavailable with a clear log line — no fallback path.
- **Scale tricks** (simulcast, selective forwarding, layer switching).
  Plain fan-out. Bandwidth per call is N×(N−1) streams, the same order as
  today's relayed mesh — no regression, no new ceiling.

## 3. Architecture

```
Browser A              campfire binary (one process, one port)          Browser B
───────────            ─────────────────────────────────────            ───────────
/webt realtime      ┌─ world (rooms, bubbles, 50 ms tick)  ────  realtime /wt
NDJSON (unchanged)  │   │  bubble state = SFU authorization        │ NDJSON
                    │   ▼
/wt → …            └─ SFU (new `moq` module)
/moq?ticket=…  ◄──►  │  track registry + per-track fan-out
WebTransport (own    │  media tickets (minted by world on call_start)
QUIC conn, 443/UDP)  ▼
encode once:        h3 endpoint (existing quinn endpoint, same socket)
getUserMedia →      ▲
VideoEncoder VP8 +  │
AudioEncoder Opus → │  announce a/v/s
subscribe a/v/s     │  subscribe a/v/s
of every peer  ◄────┘
```

- The realtime channel (`/wt`, NDJSON + movement datagrams) is untouched.
  It keeps doing what it does: world state, chat, and the call **signaling**
  that decides *who is in which bubble*.
- The MoQ session is a **separate WebTransport connection** to the same
  443, on path `/moq`. It carries only media. Per-connection
  `max_webtransport_sessions(1)` stays; two connections per client.
- The SFU has no media logic of its own beyond fan-out. **Bubble state is
  the authorization policy**: you may subscribe to a track iff you and the
  publisher are in the same room's active call.

## 4. Media model

Transport: MoQ over WebTransport per the IETF draft — **pinned to the draft
number chosen in Phase 0** and isolated behind the `moq` module so spec
churn stays contained.

- **Namespace:** `call/<room>/<user-id>` — one per user, stable for the
  duration of their call membership.
- **Tracks per user:**
  - `a` — Opus, 48 kHz, 20 ms frames; one object per frame.
  - `v` — camera, VP8, 640×360 default (720p if the encoder is hardware);
    one object per frame; keyframes ~every 2 s and on demand.
  - `s` — screen share, VP8; published only while sharing.
- Objects carry the publisher's media timestamp (µs) for A/V sync.
- **Subscription:** roster-driven. On `call_start` / member-join the client
  subscribes to `a`+`v` (and `s` where present) of every other member; on
  `call_leave` the subscriptions drop.
- **Fast-start:** the SFU caches the last keyframe of each video track and
  starts a new subscriber from it, so joins don't wait up to 2 s for the
  next periodic keyframe.
- **Mute / camera off:** the publisher stops emitting objects. Presence
  (badges, 🔇/📷 state) still flows over the existing `call_mute` messages.
- **Backpressure:** a subscriber that falls behind a video track is reset to
  the next keyframe (standard SFU behavior); audio is small enough that
  dropping frames is the last resort.

## 5. Server design (Rust)

New module `crates/campfire-server/src/moq/`:

- `session.rs` — one MoQ session per WebTransport session on `/moq`.
  Validates the media ticket on CONNECT (reject → close session). Holds the
  session's announced tracks and open subscriptions.
- `fanout.rs` — per-track fan-out task: incoming object → each subscriber's
  outgoing stream; keyframe cache; behind-keyframe reset; per-subscriber
  backpressure.
- `tickets.rs` — media tickets: random 32-byte id, 60 s TTL, maps to
  `(user, room)`. Minted by `world` on `call_start` and on the reconnect
  `hello` (fresh ticket each time); stored in the world or a small `Arc`
  registry next to it.

Integration points (existing files):

- `lib.rs::run` — construct SFU state next to the world; **no new socket**.
  MoQ sessions arrive on the existing quinn endpoint via h3.
- `api.rs` (router) — a `/moq` route that hands the WebTransport session to
  the SFU. (`realtime.rs::handle_wt` is the model to copy.)
- `world.rs` — remove `call_relay_offer/answer/ice`; add `mint_ticket` and
  `in_same_call(room, a, b)` used by the SFU's subscribe check.
- `metrics.rs` — MoQ sessions open, objects in/out, bytes, fan-out width.

**Library decision (Phase 0 research, settled 2026-11-09):**

- **SFU:** `moq-net` 0.3.22 (transport-agnostic MoQ networking layer:
  Producer/Consumer API, built-in fan-out and group caching, negotiates
  moq-lite or IETF MoQT — drafts 14+, incl. modern 17/18) driven by
  `moq-tokio` 0.19.35, served **over the existing h3/quinn endpoint** via a
  custom `web_transport_trait::poll` bridge over
  `h3::webtransport::Session`. Server intake:
  `moq_net::server::Server::accept_request(session)` → `Handshake`
  (exposes path, role, setup token) → media-ticket validation → `ok()` →
  `(Session, Driver)`. The bridge is the only protocol glue we write
  (~300–500 lines: streams + datagrams + close, poll-based).
- **Browser client:** `@moq/net` + `@moq/publish` + `@moq/watch` (npm,
  TypeScript). WebTransport on Chrome/Edge 97+ and Firefox 153+ (WebSocket
  fallback elsewhere). `@moq/publish` ships the capture→WebCodecs→publish
  pipeline; `@moq/watch` ships subscribe→decode→render (canvas + WebAudio).
  Same project as the Rust stack — its own reference interop pair.
- **Tier-1 native client:** `moq-tokio` `Client` (WebTransport over HTTP/3).
- **Draft pin:** IETF MoQT 17/18 and/or moq-lite, whatever the browser
  negotiates; the exact negotiated version is recorded in the spike results.
- **Rejected:** a raw-QUIC `moqt-*`-ALPN endpoint (ALPN collides with the
  app's `h3` on the one socket); `moq-relay` as a drop-in (standalone 14.5k-
  line app with its own listener/cluster — kept as SFU plumbing reference);
  `moq-transport`/`moq-native-ietf` as the base (superseded by moq-net for
  our needs); an own from-scratch codec (no longer needed).

## 6. Client design (TypeScript)

New `client/src/call/moq.ts` (split as needed), built on the Phase 0
libraries — the WebCodecs pipelines are **provided by `@moq/publish` /
`@moq/watch`**, not hand-rolled:

- `MoqSession` — `@moq/net` connection on `/moq?ticket=…` (WebTransport).
- **Uplink** (one per local stream): `@moq/publish` (or its headless
  `Publish.Broadcast` API below the `<moq-publish>` element) over
  `getUserMedia` / `getDisplayMedia`. Mute stops the published tracks; the
  PiP keeps using the raw `MediaStream` (unchanged). Encoder settings
  (VP8, hardware-first, bitrates) are configured per the spike findings.
- **Downlink** (per peer): `@moq/watch` (or its headless `Watch.Player`
  API) per remote track — decode to canvas + WebAudio is its job.
  - Video: the element's canvas (or the player's canvas) is exposed via
    `canvas.captureStream(30)` as a `MediaStream` so `callui.ts` tiles and
    the `PeerView.camera/screen: MediaStream` interface stay **unchanged**.
  - Audio: route the player's audio through a per-peer gain node on one
    shared `AudioContext` (the silent-zone mute is a gain-0 flip on that
    peer's node; `callui.ts` already has the AudioContext plumbing).
  - Sync: the library's pipeline handles it; the spike verifies the
    measured A/V skew against T2.
- **Reconnect:** the MoQ session dies with its connection. The existing
  `rejoinCall` path already handles "call survived, I'm back": it gets a
  fresh ticket from `hello`, reopens the session, re-announces,
  re-subscribes. No SDP, no ICE, no glare.
- `call/manager.ts` — the per-peer `RtcPeer` mesh (N connections, N offer/
  answer flows) becomes **one** MoQ session (N−1 subscriptions + 1–3
  announces). The phase machine, roster, presence handling, auto
  voice-only, and silent zones all stay; `onCallOffer/onCallAnswer/
  onCallIce` and `ensurePeer`/`offerTo` go.
- `PeerView.state/viaRelay` — one session means one connection state for
  all peers: `connecting` until the first object per track, `connected`
  after; "via relay" wording goes (everything is via the SFU now).

## 7. Protocol changes (`campfire-protocol`, `realtime.rs`, `world.rs`, `api.rs`)

- **Removed:** `call_offer`, `call_answer`, `call_ice` — client senders,
  `realtime.rs` dispatch arms, `world.rs` relay methods, `api.rs` TCP
  fallback arm, SDP/candidate size caps, and the integration tests that
  exercise them (`tests/call.rs`, `tests/huddle.rs`, `tests/reconnect.rs`
  offer/ice expectations).
- **Kept:** `bubble`, `call_mute`, `call_screen`, `call_leave`,
  `call_start`/`call_leave`/`call_end` broadcasts, the `sz` movement
  datagram.
- **Added:** `ticket: String` on `call_start` and in the reconnect
  `hello` call payload (server-minted media ticket). `you_offer` goes —
  there is no offerer in a subscribe model.
- **README** (Phase 4): §2 (one port — now literally true: QUIC + TLS
  front, no splice), §4 network surface, §5 protocol catalogue, §7 voice &
  video (new pipeline description), §11 security (server is now a media
  party; in-transit QUIC encryption, no E2E media claim), and the
  enterprise-network note (UDP/443 required for media; TCP fallback =
  world only).

## 8. Removal list (Phase 4)

Server: `src/turn.rs`, `src/stun.rs`, the STUN branch in `src/demux.rs`
(socket wrapper stays, QUIC-only), the splice logic in `src/bootstrap.rs`
(Alt-Svc bootstrap page stays), `POST /api/v1/turn/credential` +
`turn_secret` + `--turn-secret` in `api.rs`/`config.rs`, TURN wiring in
`lib.rs`, the `turn-server` dependency.

Client: `call/peer.ts`, `iceServers()` + `TurnCredential` in `call/media.ts`.

Deployment: chart and Docker need no port changes — UDP/443 ingress already
exists for the app core; there is no relay range to remove. Verify the
Helm values and README K8s section for stale TURN mentions.

## 9. Phases

**Phase 0 — Spike** (`tools/moq-spike/`, automated; no app changes)

Two tiers, both scripted. A justfile target runs the whole matrix, emits
JSON, and generates `docs/moq-spike-results.md`.

- **Tier 1 — no browser.** Spike binary on `127.0.0.1:4443/UDP` (reuses
  `certs/`): h3 + WebTransport on `/moq`, the moq-net SFU session over the
  custom h3 bridge, fan-out 1→N. `moq-tokio` `Client`s act as one publisher
  + N subscribers. Measures: protocol round-trips, SFU fan-out throughput
  and latency, loss behavior under netem in a private
  user+network namespace (`unshare -rn`, non-interactive, host `lo`
  untouched; 0/5/20 % loss + 100 ms jitter).
- **Tier 2 — headless browser.** Playwright-driven headless Chromium
  (dev-only dependency in `tools/moq-spike/`) with fake media
  (`--use-fake-ui-for-media-stream`
  `--use-fake-device-for-media-screen-capture`,
  `--autoplay-policy=no-user-gesture-required`): publisher tabs
  (`@moq/publish` over fake camera + mic), subscriber tabs (`@moq/watch`),
  1→3 fan-out. Measures: glass-to-glass latency p50/p95 (capture-side
  timestamp vs render time), CPU per direction, keyframe fast-start time,
  negotiated protocol version, loss behavior under `netem`, and feature
  detection (`VideoEncoder.isConfigSupported` for `hardware` vs
  `software`, `AudioEncoder`/`AudioDecoder` presence, transport `@moq`
  actually uses).
- **Decide:** codec config (hardware vs software VP8, bitrates), object
  layout (streams vs datagrams) for the app build; the library choice and
  draft pin are settled (§5) — the spike only verifies them.
- **Decision rule (agreed).** Gates, pass/fail:
  - G1: `VideoEncoder`/`VideoDecoder` and `AudioEncoder`/`AudioDecoder`
    all present in headless Chromium (there is no JS Opus encoder to fall
    back to — missing audio codecs forces a rethink, not a tune).
  - G2: end-to-end fan-out works over the existing h3/quinn endpoint
    (moq-net over the h3 bridge — §5).
  - G3: audio pipeline stable — no sustained `AudioDecoder`→WebAudio
    underrun over the 10-minute soak.
  Thresholds (LAN, no loss unless noted):
  - T1 audio glass-to-glass: p50 ≤ 250 ms, p95 ≤ 400 ms.
  - T2 video glass-to-glass: p50 ≤ 300 ms; A/V skew ≤ 90 ms.
  - T3 keyframe fast-start (new subscriber, first frame): p50 ≤ 500 ms,
    p95 ≤ 1 s.
  - T4 at 5 % loss + 100 ms jitter: audio p95 ≤ 600 ms; gaps > 100 ms
    ≤ 2/min.
  - T5 at 20 % loss: audio p95 ≤ 1 s, gaps ≤ 10/min; no video freeze
    > 2 s (this row is what decides streams vs datagrams, risk 5).
  - T6 10-minute soak (1→3 fan-out): RSS growth < 10 MB; no stall > 2 s.
  - T7 resubscribe after tab refresh, first frame: p50 ≤ 2 s.
  Per-direction CPU and SFU CPU are **informational only** — reported in
  the results doc, not gating; revisit if Phase 3 hits real-world limits.
  **GO** = all gates + all thresholds pass. A threshold failure allows one
  tuning pass (jitter-buffer depth, bitrates, keyframe interval, codec
  choice), then a re-measure. A gate failure, or a threshold failing twice,
  is **NO-GO** — escalate with the data.
- **Exit:** numbers and decisions in `docs/moq-spike-results.md`
  (generated from the run's JSON). The go/no-go for the full build is the
  only manual step — a decision on the numbers, not data collection.
- **Not automatable here (documented, not measured):** enterprise
  hardware-encoder matrix (the spike detects what this host's browser
  offers; the rest is handled by runtime feature detection) and
  Safari/Firefox codec availability (verified from release notes).

**Phase 1 — Server core in the app** (done, 2026-11-10)
- `moq/` module wired into the running server on the real 443; ticket
  minting on `call_start`; `/moq` route; metrics.
- **Accept:** a spike-style client can publish and subscribe through the
  dev-loop server with a minted ticket; a subscription from a user outside
  the call is rejected. — **passed:** `tests/moq.rs`
  (`publish_and_subscribe_within_a_call`,
  `outsider_without_ticket_is_rejected`,
  `stale_ticket_after_call_end_is_rejected`) run the Phase 0 tier-1 client
  shape (moq-net over `wtransport` WebTransport) against the real server:
  two co-located users form a bubble, each gets a minted ticket in
  `CallStart`, one publishes her `call/<room>/<user-id>` namespace, the
  other subscribes mid-stream and reads the live groups through the SFU;
  a room user outside the call is refused (no ticket, bogus ticket); a
  ticket whose call ended is refused until the re-formed call mints a
  fresh one.

**Phase 1 implementation notes**

- **Per-call origins, not per-room.** A room runs several concurrent calls
  (bubbles + zone calls), so the fan-out is one moq-net origin per call
  (`Fanout: HashMap<call_id, Producer>`), lazily created on the first
  `/moq` CONNECT for that call. The world fires a call-end hook
  (`World::on_call_end`) from every call-end path (`leave_call`,
  `update_bubbles` drops, room removal); the hook drops the origin, which
  ends its driver task and cache pool. Isolation between calls is
  structural: a session is wired only to its call's origin as publisher
  and subscriber, so a session of call C cannot see or write call D's
  namespaces.
- **Tickets are bearer.** A ticket is 32 random bytes (hex, 64 chars),
  60 s TTL, lazy-swept on mint, and maps to `(user, room, call_id)`. It
  only ever travels over the owner's own TLS session (`CallStart.ticket`
  for participants, `Hello.ticket` on a mid-call reconnect; bystanders
  get the roster with `ticket: None`). No single-use: the TTL is the
  lifetime.
- **Admission is two CONNECT-time checks**, both before
  `upgrade.accept()`, failing with HTTP 403 (no WebTransport session is
  opened): (1) the `?ticket=…` query names a live ticket; (2)
  `world.call_active(room, call_id, user)` — the call still exists with
  the ticket's user in it. A ticket outlives its call for up to its TTL;
  check 2 is what kills it early.
- **Known limitation (documented in `moq/session.rs`).** A session may
  announce any namespace on its call's origin: moq-net exposes no
  announce hook on the server handshake, so a participant cannot be
  pinned to their own `call/<room>/<user-id>`. The blast radius is one
  call (origins isolate calls); the client subscribes by roster id.
- **Lite02 delivery semantics (observed in the acceptance tests).** The
  negotiated version is moq-lite 02, whose SUBSCRIBE wire carries no
  max-age field and no frame timestamps. A new subscriber's cursor starts
  at the **live edge** (an absent `Group Start` means the latest group),
  with an unbounded serving budget — so there is **no backlog replay**:
  a subscriber joining after the publisher has produced groups gets the
  latest group and then follows live. Catch-up of older groups is not a
  transport feature in this version; if Phase 2/3 needs it (late joiner
  wants the in-flight call state), it is an app-level concern (keyframe
  on join) or a matter of negotiating a newer lite/IETF version.
- **Metrics** (`/metrics`, `campfire_moq_*`): `sessions` (gauge, open
  now), `sessions_total`, `sessions_rejected_total` (403 at CONNECT),
  `origins` (gauge, live per-call origins), and
  `objects_in/bytes_in/objects_out/bytes_out` counters from the moq-net
  stats registry (publisher role = media in, subscriber role = media
  out), tagged per session as `moq/call/<call_id>`.
- **Test harness.** `tests/common/mod.rs::start_server_with_world()`
  returns the server's `World` so tests can drive world state directly
  (e.g. `set_bubble` to make an outsider); the MoQ SFU is wired exactly
  as production (`AppState::with_metrics` shape). The tier-1 MoQ client
  is the spike's `client_wt.rs`, copied to `tests/moq_client_wt.rs`.

**Phase 2 — Client uplink** (done, 2026-11-10)
- Real browser in a real bubble: media acquired, MoQ session opened,
  `a`+`v` published; a subscriber (spike or decode page) sees it.
- **Accept:** walk into a bubble with another client; camera + mic reach
  the SFU and are forwarded. — **passed:** `just moq-e2e` (or
  `node tools/e2e/moq.js --url https://localhost:8443`) drives two real
  client pages (fake media) over HTTP/3 into a bubble; both uplinks go
  live on `moq-lite-02`, the Rust spike client joins as a third
  participant (admitted with B's ticket) and reads A's
  `call/island/<user-id>.hang` — 163 video + 398 audio objects over an
  8 s window, `campfire_moq_objects_in_total` moves, and A's uplink
  stops when B walks away. Decode proof: the third tab on
  `client/public/moq-subscriber.html` renders the same broadcast
  (WebCodecs, frames decoding, audio pumping).

**Phase 2 implementation notes**

- **Browser wire path.** h3 0.0.8 only accepts a `:protocol` of
  `webtransport` or `connect-udp`; a browser WebTransport session always
  negotiates `""`, so `@moq/net` 0.4.7 takes its browser-compat path —
  the legacy in-band bidi SETUP exchange — landing on **moq-lite-02**,
  the same wire the Rust spike negotiates. No server change was needed.
  Corollary: `connect()` must pass
  `webtransport: { protocols: undefined }`. Any protocols list makes
  Chromium send a `:protocol` the h3 stack cannot parse, and the
  extended CONNECT is then dropped silently (`wt.ready` hangs). The TS
  DOM lib has no `protocols` field, so the options object is cast.
- **Broadcast naming.** The client announces
  `call/<room>/<user-id>.hang` (the @moq/hang convention, a `@moq/net`
  `Path.Valid` via `Net.Path.from`) with tracks `v` (camera) and
  `a` (mic). The hang catalog is JSON and carries codec/dimensions per
  track, so the short names are fine. This replaces the spike-era raw
  `call/<room>/<user-id>` namespace (the server's fan-out is
  namespace-agnostic, so no server change).
- **Uplink lifecycle** (`client/src/call/moq.ts`, manager hooks). One
  one-shot `Net.Connection.connect` per call entry; no reconnect loop —
  the app's own reconnect (re-`hello`) mints a fresh ticket, and the
  manager restarts the uplink in `rejoinCall`. `enterCall` starts it
  with the `call_start` ticket, `reset`/`stopUplink` stop it, and an
  `uplinkSeq` counter drops an in-flight start that loses the race
  against a reset. The captures feed the manager's existing
  `localStream` tracks (`Video.Capture`/`Audio.Capture` accept a
  `MediaStreamTrack`), so mute/camera `track.enabled` toggles carry
  over unchanged. A `window.__campfire_moq` hook (url/name/version/
  state/error) serves the e2e and the dev loop.
- **Demand gate.** `@moq/publish` 0.5.6 renditions expose their live
  track only while a subscriber is attached, and the encoders encode
  only then: a participant nobody is watching announces the broadcast
  but ships no objects.
- **Spike additions for the e2e.** `--ticket <hex>` (admits the
  session with the app server's ticket), `--no-publish` (pure
  subscriber) and `--no-stamp` (do not strip the 8-byte send-stamp
  prefix: browser payloads are encoded media, so the receive time is
  the stamp and latency stats read ~0; the e2e asserts sample/byte
  counts, not latency).
- **Dev decode page.** `client/public/moq-subscriber.html` (vite
  `public/` → `dist/`; served by the SFU's own origin because
  WebTransport is same-origin) loads `@moq/watch` 0.6.6 from esm.sh at
  runtime — no npm dep, no build step. The element fires no
  load/error events, so the page polls `connection.status.peek()`,
  `catalog` and `video.out.stats.frameCount` for its status line. The
  SharedArrayBuffer console warning is benign (postMessage audio
  fallback).
- **Headless media.** The e2e browser flags need
  `--autoplay-policy=no-user-gesture-required`: the audio encoder
  pumps through an AudioContext, which browsers suspend until a user
  gesture.
- **E2E robustness.** Both e2e scripts wait for the room to contain
  exactly the two test users before the bubble forms: users of a run
  that ended seconds earlier sit on the spawn tile through the server's
  10 s reconnect window — longer when a headless close leaves the QUIC
  connection open (worst case observed ~90 s) — and would be pulled
  into the bubble, so the clean-room wait is budgeted at 90 s (a clean
  server passes it in ~1 s). In teardown, B closes its page after the
  walk-away — once B is out of the room no bubble can re-form (a
  rejoining B within bubble radius would legitimately start a fresh
  call), so "the call ended" is a terminal assertion.

**Phase 3 — Client downlink + full UX**
- Two real browsers, both directions, plus screen share, mute/camera,
  silent zone, auto voice-only at 9, hang-up, tab refresh (reconnect).
- **Accept:** the §7 feature checklist passes on the dev loop; latency
  matches the spike within tolerance.

  Implemented (client only; no server changes):
- **One session, both directions.** `MoqCall` (client/src/call/moq.ts)
  opens a single `@moq/net` connection on `/moq?ticket=…` with
  `publish: origin.consume()` and `consume: origin` on a local
  `Origin.Producer`, plus `discovery: true`: the session serves our
  uplink and feeds the peers' announced hangs into the same table the
  downlinks read. The uplink keeps the Phase 2 renditions (`v` camera,
  `a` mic) and gains a dynamic `s` (screen) rendition; the keyframe
  interval is 1 s so a late-joining downlink fast-starts at the next
  keyframe (T7).
- **Downlinks are composed, not `Player`'d.** One pipeline per
  participant: `Watch.Broadcast {announced: true}` → `Watch.Sync
  {delay: "auto", probe: session.probe}` → `Watch.Video.Source/Decoder/
  Renderer` for the camera canvas and the screen canvas (both created
  detached, the theater moves the element into its tile in place —
  rebuilding it would restart the decode) and `Watch.Audio.Source/
  Decoder` into our own WebAudio graph: `root → gain → destination`
  plus `root → MediaStreamDestination`, the stream feeding the tile's
  level meter. The gain is the silent zone (README §7: meter keeps
  showing, output is muted); the meter tap is pre-gain on purpose.
- **Two `@moq/watch` traps.** (1) The sources' `supported` input is
  optional, and omitted means *no support probing at all*: the
  availability effect returns early, no rendition is ever selected and
  the decoders sit at zero frames with no error. Pass
  `Video/Audio.Decoder.supported` (the WebCodecs probe). (2) When the
  target rendition name is not in the catalog, a source silently falls
  back to another rendition — the screen source decodes the camera
  while the peer does not share. Each video decoder is therefore
  gated on the track its source actually resolved (`enabled` follows
  `out.track === "v" | "s"`), so a missing rendition downloads nothing.
- **Mute / camera.** Both flip `track.enabled` on the local stream (the
  PiP and the uplink capture follow). The camera additionally gates the
  uplink's `v` rendition with a live signal, so an off camera is
  *omitted from the catalog*: subscribers stop receiving frames instead
  of decoding black ones (the downlink gate above keeps their canvas
  put). Presence still rides `call_mute`.
- **AudioContext budget.** The library creates one `AudioContext` per
  audio decoder (true for `<moq-watch>` as well) and closes it with the
  pipeline, so a full 9+ bubble holds ~8 contexts plus the theater's
  meter context. That exceeds Chrome's context limit (6): the surplus
  starts suspended and is resumed by our wiring (the `resume` is
  gesture-licensed by the join, `--autoplay-policy` in the e2e). The
  2-browser dev loop — the acceptance configuration — never reaches it;
  a production fix would mean one shared context and our own
  `AudioDecoder`→WebAudio pump, which is a Phase 4+ concern.
- **Screen share.** `getDisplayMedia`'s video track rides a third
  uplink rendition `s`, registered when the share starts and
  unregistered with `Encoder.close()` when it stops (the browser's own
  "stop sharing" button ends the track and the client listens for
  `ended`); `call_screen` presence reveals the peer's screen canvas in
  the theater. Headless e2e works with
  `--use-fake-ui-for-media-stream`, which also auto-approves the
  display picker (fake 800×600 monitor).
- **Tab refresh.** The sessionStorage token re-join restores the
  identity; `hello` carries `call` plus a fresh ticket, `rejoinCall`
  re-acquires the media (no new prompt — the permission persisted) and
  re-establishes the session. The peer's downlink needs no help:
  `Watch.Broadcast` resolves its path through
  `request(path, {announced: true})`, whose active consumer follows the
  table, so when A's old session retracts the route and the re-join
  re-announces it, the subscription comes back on its own (verified in
  the e2e's reload step). A re-join while a media prompt is still open
  (phase "joining") only updates the roster — tickets are multi-use
  for 60 s.
- **E2E.** `tools/e2e/moq.js` is now the full Phase 2+3 suite (11
  steps): uplinks, then downlinks both ways via the
  `window.__campfire_moq_down` hook (status / frames / screenFrames /
  audioBytes / delay / jitter, refreshed at 1 Hz), the spike subscriber
  and `/metrics` from Phase 2, screen share start/render/stop,
  mute/camera presence badges *and* catalog-driven delivery (the
  decoded frame count must plateau while the peer's camera is off and
  resume when it comes back), the tab-refresh reload, and the
  walk-away teardown. Latency is asserted as a sanity budget on the
  playback delay and jitter buffer (≤ 1 s); the glass-to-glass
  acceptance figure stays the spike's. Silent zone and the 9-person
  auto voice-only are not automatable here (they need map zones and a
  crowd) and ride the manual §7 checklist.
- **WebRTC gone client-side.** `client/src/call/peer.ts` is deleted;
  the manager is roster-driven (one downlink per other participant,
  synced from the server's `call_start`/`call_leave`), and the
  `call_offer`/`call_answer`/`call_ice` handlers are no-ops until the
  Phase 4 protocol removal. `tools/e2e/e2e.js` (presence, chat, bubble
  state, walk-away) is unchanged and still green.

**Phase 4 — Cutover + removal**
- Delete WebRTC/TURN/STUN end to end (§8), rewrite README, verify chart,
  clean up tests (bubble state, zones, presence, reconnect survive;
  offer/ice tests go).
- **Accept:** workspace tests + `npx tsc --noEmit` + `npm run build` +
  `cargo clippy` all green; `rg -i 'webrtc|turn|stun'` over the tree finds
  nothing outside history; two-machine call test passes; release (version
  bump + tag) cut.

## 10. Phase 0 findings (Tier 1)

Measured by the spike, in `tools/moq-spike/`, over `unshare -rn` netem
(0/5/20 % loss + 100 ms jitter, both directions) and the host (no loss).
These are the reasons the media path needed non-default quinn/moq-net
tuning, and the numbers behind the gate verdict in
`docs/moq-spike-results.md`.

### F1. quinn `send_fairness` scattered burst-served groups (the jitter-loss root cause)

The SFU origin cache fills under a jittery uplink and the serve loop drains
it in bursts of many group streams at once. Quinn's default per-stream send
fairness round-robins one chunk per pending stream per transmission and
requeues a stream with more data at the **tail**, so a 12 KB video group's
11 chunks spread across the whole burst drain — measured 0.7–4.9 s at
100+30 ms one-way delay. That blew the subscriber's max-age drift budget and
looked like loss.

Fix: `transport.send_fairness(false)`. Chunks then go back-to-back; per-group
spread is ~11 packet times. Measured effect (gate jitter, `--max-age 1s`):
video first→fin p99 4298 ms → 103 ms, drift skips 15–71 → 0, audio p95
299 ms with 0 gaps.

Trade-off, noted for the production SFU: without fairness, one stream with a
large backlog can starve the others. Fine for the spike (two tracks per
connection, a bounded serve burst); a busy production SFU needs either a
per-burst cap or fairness kept on with a smaller batch.

### F2. `Subscriber` max-age default 0 s delivers nothing

moq-net's `is_stale` compares `age = ts(edge) − reach(group)` against the
budget with `>=`, so a zero budget marks every in-order group stale the
instant a newer one arrives. The spike client default is now `1s`
(`--max-age`, reported as `max_age_ms` in the JSON). The budget is only
consumed when newer data is already that far ahead, so a 1 s budget rides out
the T4/T5 reordering window without adding steady-state delay.

### F3. Lite02 carries no frame timestamp; the consumer must reorder

The Lite02 group stream re-stamps local receive time, so the spike embeds a
u64-LE µs send stamp in the payload and the client reorders by it.
moq-net 0.3.22's `Subscriber::recv_group` hands groups out in **arrival
order** (the cursor walks the arrival deque; it does not wait on missing
sequences). The max-age drift budget is the drop mechanism. The browser
client (Tier 2) needs an equivalent reorder buffer + consumer reorder.

### F4. Loss detection: `packet_threshold(1000)`, `time_threshold(0.7)`

The default packet threshold (3) declares an in-flight packet lost as soon as
3 newer packets are acknowledged; 100+30 ms one-way delay reorders up to ~50
packets, so the default fired continuously and CUBIC treated every spurious
loss as congestion (F5). `1000` disables the count trigger. The time
threshold is a **factor of conservative RTT**: `0.7` retransmits a truly lost
packet in ~150–250 ms at the scenario RTTs. A spurious time-trigger under
jitter is harmless with the bandwidth-based controller (the receiver dedupes
the retransmission), so the threshold trades a little extra retransmit load
for a shorter loss tail — at `1.0` the 20 %-loss audio p95 measured 1026 ms,
just over the T5 gate; at `0.7` it measures 727 ms (results doc).

### F5. Stock congestion controllers fail this path; a small bandwidth-based one is used

- **CUBIC** (the default) halves the window on *every* declared loss. netem
  `loss random N%` is per-packet loss independent of load, so at 5 % the
  window halves ~13×/s and pins at the floor — measured 99 of 1500 audio
  groups delivered in 30 s (T4 collapse).
- **BBR** (marked `Experimental!` in quinn) sizes its window from a BDP
  computed with `min_rtt`. Under 100+30 ms jitter the minimum sample is a
  20–40 ms artifact (real RTT ~190 ms), the BDP collapses to ~6 KB and the
  rate cap cwnd/RTT ≈ 32 KB/s sits below the 316 KB/s media path, so the
  queue grows unbounded — measured audio p50 628 ms at 0 % loss.
- Quinn 0.11's **pacer is dead code** (constructed in `Path`, never consulted
  in the send path), so the congestion window is the only rate lever.

`MediaCc` (`tools/moq-spike/src/cc.rs`) runs the window at
`max(128 KB floor, 3 × BDP)`, BDP = delivery-rate EWMA × **smoothed** RTT; it
ignores isolated loss events and only halves on persistent congestion. That
is safe on the spike's model (no bottleneck to protect); a production SFU on a
real WAN needs a production loss-tolerant controller — a Phase 1 decision.
With `MediaCc` (final matrix run): T4 (5 %) audio p95 402 ms, 0 gaps; T5
(20 %) audio p95 727 ms, 0 gaps, max video freeze (rx-time) 1103 ms ≤ 2 s.

### F6. Delivery funnel is lossless under the gate config

Gate jitter, `--max-age 1s`, 30 s: 2114 groups ingested at the SFU (1 uplink
error drop) → 2113 served → 2113 ingested by the subscriber → 2113 delivered
(audio 1409, video 704). Zero downlink loss, zero drift skips. The publisher
emits at ~93 % of nominal rate because the tick loop includes write time — a
spike artifact, not a delivery loss (delivered == served == ingested).

### F7. T6 soak RSS: a one-time origin-pool fill, not a leak

The first 600 s soak exceeded the RSS gate: +16.3 MB over the run (gate:
<10 MB). The delta is the SFU's origin cache filling once, not a leak. The
default pool (`moq_net::cache::Config::default()`) holds published groups for
30 s of idle time and has no byte cap. At the spike's bitrate (~316 KB/s per
stream) 30 s of media is ~9.5 MB, cached once per group regardless of
subscriber count — that accounts for the whole delta, and growth stops once
fill rate meets expiry rate. The pool is what makes fast-start and late join
cheap (T3/T7): a subscriber arriving mid-stream is served recent groups from
the cache instead of waiting for the next one.

The tuning pass bounded it: the SFU builds its origin with a 10 s expiry and
a 16 MB byte cap (`server.rs`). 10 s of history still covers late joiners by
a wide margin (the T7 first-frame budget is 2 s); the cap bounds a bursty
publisher. Post-tuning 600 s soak: +1.96 MB total, ~2.0 MB by 30 s, flat to
the end (growth from the 2-minute mark to the end ≈ 0 MB), no rx-time stall
>46 ms.

Measurement note: a two-point before/after sample cannot distinguish a
fill-then-plateau from a slow leak, so `matrix.sh` now samples RSS every 30 s
during the soak (`soak-rss.json`: before, series, after). `gen_report.py`
reports the 2-minute → end growth as a diagnostic; the gate stays strict
(before/after delta <10 MB, no stall >2 s).

## 11. Risks

1. **No MoQ library serves a session over our h3/quinn endpoint** →
   Option B (own thin codec). The draft core is small; the spike settles
   it before any commitment.
2. **Browser codec availability** — WebCodecs video is broad (Chrome,
   Edge, Firefox 130+, Safari 16.4+); `AudioEncoder`/`AudioDecoder` are
   younger (verify the current matrix in the spike). Without them, no
   calls — feature-detect and say so in the UI log.
3. **Draft churn** → pin the draft number; the `moq` module is the only
   place it is touched.
4. **Software-encode CPU** on enterprise hardware → prefer hardware
   encoders, cap resolutions, treat screen share (high fps, large frames)
   as the worst case and measure it in the spike.
5. **Loss latency:** QUIC retransmission is slower than RTP's
   FEC/NACK path. If glass-to-glass suffers under `netem` loss, switch
   media objects to the draft's datagram (reliability-optional) path.
6. **The audio pipeline is the fiddliest piece** (AudioDecoder → AudioData
   → WebAudio, per peer, no gaps). It is in the spike from day one, not an
   afterthought.
7. **Security-model change** (server is now a media party) — must be
   explicit in README and release notes, not a quiet diff.

## 12. Open questions (answered in Phase 0)

- Streams vs datagrams for media objects (loss-latency trade-off, risk 5).
  **Answer (Tier 1, §10/F5):** reliable streams pass T4/T5 — with
  `send_fairness(false)`, time-based loss detection and the bandwidth-based
  window, 5 %/20 % netem loss costs a retransmission's delay, not a
  throughput or gap failure. No datagram path is needed for these targets;
  revisit if real-world RTTs make the retransmit budget (≲350 ms at T4)
  unmet.
- VP8 vs VP9 default (hardware availability on the target machines).
- Ticket TTL and re-mint cadence (60 s / per call event is the start).
- Keyframe cache: one frame or a few groups?
- One MoQ session per call vs per peer (plan: per call — it *is* the
  "uplink once" property).

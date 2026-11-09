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

**Library strategy — decided in Phase 0:**

- **Option A:** `moq-net` / `moq-rs` serving a session adapted onto our
  h3/quinn endpoint.
- **Option B:** a thin own MoQ codec (the draft core is a small
  stream/datagram framing: bidirectional control streams for
  ANNOUNCE/SUBSCRIBE, unidirectional streams for objects) implemented
  directly on `h3::webtransport::Session`. Insulates us from library API
  churn and pins the protocol exactly; the cost is owning ~1–2 k lines.
- **Option C:** `moq-native-ietf`.

Decision criterion: **can it serve a session over the existing h3/quinn
endpoint without a second port?** If none can cleanly, Option B.

## 6. Client design (TypeScript)

New `client/src/call/moq.ts` (split as needed):

- `MoqSession` — WebTransport on `/moq?ticket=…`, the MoQ client side
  (library from Phase 0, or a small TS codec mirroring the server).
- **Uplink** (one per local stream): `getUserMedia` / `getDisplayMedia` →
  `VideoEncoder` (VP8; try `hardware`, fall back `software`) +
  `AudioEncoder` (Opus). Frame loop: `track.requestFrame()` →
  `VideoFrame` → `encoder.encode` → MoQ object. Mute stops encoding; the
  PiP keeps using the raw `MediaStream` (unchanged).
- **Downlink** (per peer): `VideoDecoder`/`AudioDecoder` per track.
  - Video: draw frames to a per-tile canvas; expose
    `canvas.captureStream(30)` as a `MediaStream` so `callui.ts` tiles and
    the `PeerView.camera/screen: MediaStream` interface stay **unchanged**.
  - Audio: `AudioDecoder` → `AudioData` queue → per-peer gain node on one
    shared `AudioContext` (the silent-zone mute is a gain-0 flip on that
    peer's node; `callui.ts` already has the AudioContext plumbing).
  - Sync: audio is the reference; video plays with a small adaptive delay
    (≤ ~100 ms) so both sit on the same edge.
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
  `certs/`): h3 + WebTransport on `/moq`, the MoQ session logic, fan-out
  1→N. Rust MoQ clients (the Phase-0 library candidate itself) act as one
  publisher + N subscribers. Measures: protocol round-trips, SFU fan-out
  throughput and latency, loss behavior under netem in a private
  user+network namespace (`unshare -rn`, non-interactive, host `lo`
  untouched; 0/5/20 % loss + 100 ms jitter). Also answers the library-fit question
  empirically: can the candidate serve a session over our h3/quinn
  endpoint (options A/C), or does it force Option B (own codec)?
- **Tier 2 — headless browser.** Playwright-driven headless Chromium
  (dev-only dependency in `tools/moq-spike/`) with fake media
  (`--use-fake-ui-for-media-stream`
  `--use-fake-device-for-media-screen-capture`,
  `--autoplay-policy=no-user-gesture-required`): a publisher tab (fake
  camera + mic → WebCodecs → MoQ publish), subscriber tabs (MoQ → decode
  → canvas + WebAudio), 1→3 fan-out. Measures: glass-to-glass latency
  p50/p95 (publisher stamps at capture, subscriber at render), CPU per
  direction, keyframe fast-start time, loss behavior under `netem`, and
  feature detection (`VideoEncoder.isConfigSupported` for `hardware` vs
  `software`, `AudioEncoder`/`AudioDecoder` presence).
- **Decide:** library (A/B/C), codec config (hardware vs software VP8,
  bitrates), object layout (streams vs datagrams), draft version pin.
- **Decision rule (agreed).** Gates, pass/fail:
  - G1: `VideoEncoder`/`VideoDecoder` and `AudioEncoder`/`AudioDecoder`
    all present in headless Chromium (there is no JS Opus encoder to fall
    back to — missing audio codecs forces a rethink, not a tune).
  - G2: end-to-end fan-out works over the existing h3/quinn endpoint
    (library option A/C, or the Option B own codec).
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

**Phase 1 — Server core in the app**
- `moq/` module wired into the running server on the real 443; ticket
  minting on `call_start`; `/moq` route; metrics.
- **Accept:** a spike-style client can publish and subscribe through the
  dev-loop server with a minted ticket; a subscription from a user outside
  the call is rejected.

**Phase 2 — Client uplink**
- Real browser in a real bubble: media acquired, MoQ session opened,
  `a`+`v` published; a subscriber (spike tab or minimal page) sees it.
- **Accept:** walk into a bubble with another client; camera + mic reach
  the SFU and are forwarded.

**Phase 3 — Client downlink + full UX**
- Two real browsers, both directions, plus screen share, mute/camera,
  silent zone, auto voice-only at 9, hang-up, tab refresh (reconnect).
- **Accept:** the §7 feature checklist passes on the dev loop; latency
  matches the spike within tolerance.

**Phase 4 — Cutover + removal**
- Delete WebRTC/TURN/STUN end to end (§8), rewrite README, verify chart,
  clean up tests (bubble state, zones, presence, reconnect survive;
  offer/ice tests go).
- **Accept:** workspace tests + `npx tsc --noEmit` + `npm run build` +
  `cargo clippy` all green; `rg -i 'webrtc|turn|stun'` over the tree finds
  nothing outside history; two-machine call test passes; release (version
  bump + tag) cut.

## 10. Risks

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

## 11. Open questions (answered in Phase 0)

- Streams vs datagrams for media objects (loss-latency trade-off, risk 5).
- VP8 vs VP9 default (hardware availability on the target machines).
- Ticket TTL and re-mint cadence (60 s / per call event is the start).
- Keyframe cache: one frame or a few groups?
- One MoQ session per call vs per peer (plan: per call — it *is* the
  "uplink once" property).

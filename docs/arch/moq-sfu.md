# Media architecture: the MoQ SFU

All call media — voice, camera, screen share — transits the server: every
client publishes its stream once to the built-in SFU and subscribes to the
other participants' tracks. There is no P2P, no WebRTC, no STUN/TURN: media
rides the same one-port HTTP/3 path as everything else, on a second
WebTransport connection per client. Call state (who is in which call) is
computed by the world ([`protocol.md`](protocol.md)); the SFU is the relay
underneath it.

This doc describes the architecture as it is. The transport-tuning
measurements behind some choices are in
[`moq-spike-results.md`](moq-spike-results.md) (historical record).

## The shape

```
Browser A              campfire binary (one process, one port)          Browser B
───────────            ─────────────────────────────────────            ───────────
/wt realtime        ┌─ world (rooms, calls, 50 ms tick)  ──────  realtime /wt
NDJSON signaling    │      │  call state = SFU authorization     │ NDJSON signaling
                    │      ▼
/moq ◄──────────►   │  SFU (crates/campfire-server/src/moq/)
WebTransport (own   │  per-call origin: track registry + fan-out
QUIC conn, 443/UDP) │  media tickets (minted by the world)
                    ▼
getUserMedia →     h3 endpoint (the existing quinn endpoint, same socket)
VideoEncoder VP8 + Opus AudioEncoder → announce a/v/s
subscribe a/v/s of every peer ◄──────────────────────────────────────┘
```

- The realtime channel (`/wt`, NDJSON + movement datagrams) is untouched:
  world state, chat, and the call *signaling* that decides who is in which
  call.
- The MoQ session is a **separate WebTransport connection** to the same 443,
  on path `/moq` (admitted by ticket). Per-connection
  `max_webtransport_sessions(1)` holds, so each client runs two connections
  total.
- The SFU has no media logic of its own beyond fan-out. **Call state is the
  authorization policy**: you may subscribe to a track iff you and the
  publisher are in the same call.

## Media model

- **Namespace:** `call/<room>/<user-id>.hang` — one broadcast per user,
  stable for the duration of their call membership. The hang catalog (JSON)
  carries codec and dimensions per track.
- **Tracks per user:** `a` (mic, Opus), `v` (camera, VP8), `s` (screen share,
  VP8 — published only while sharing). The keyframe interval is 1 s so a
  late-joining downlink fast-starts at the next keyframe.
- **Subscription is roster-driven.** On `call_start` / member-join the client
  subscribes to `a`+`v` (and `s` where present) of every other member; on
  `call_leave` the subscriptions drop.
- **Mute / camera off** flip `track.enabled` on the local stream; the camera
  additionally gates the uplink's `v` rendition with a live signal, so an
  off camera is *omitted from the catalog*: subscribers stop receiving
  frames instead of decoding black ones. Presence (badges, 🔇/📷 state)
  still flows over the `call_mute` messages.
- **No backlog replay.** The negotiated wire is moq-lite 02, whose SUBSCRIBE
  carries no max-age field: a new subscriber's cursor starts at the live
  edge and follows live from there. Catch-up of older groups is not a
  transport feature; late joiners fast-start at the next keyframe.
- **End-to-end media encryption is not offered.** The SFU handles encoded
  frames: media stays QUIC-encrypted in transit, but the server is a media
  party (it can forward or record). Accepted product decision — surfaced in
  the README and release notes, not a quiet diff.

## Server design (`crates/campfire-server/src/moq/`)

- **`session.rs`** — one MoQ session per WebTransport session on `/moq`.
  Admission is two CONNECT-time checks, both before `upgrade.accept()`,
  failing with HTTP 403 (no WebTransport session is opened): (1) the
  `?ticket=…` query names a live ticket; (2) `world.call_active(room,
  call_id, user)` — the call still exists with the ticket's user in it. A
  ticket can outlive its call for up to its TTL; check 2 is what kills it
  early.
- **`fanout.rs`** — per-call origins (`Fanout: HashMap<call_id, Producer>`),
  lazily created on the first `/moq` CONNECT for that call. The world fires
  a call-end hook (`World::on_call_end`) from every call-end path
  (`leave_call`, `update_bubbles` drops, room removal); the hook drops the
  origin, ending its driver task and cache pool. Isolation between calls is
  structural: a session is wired only to its call's origin as publisher and
  subscriber, so a session of call C cannot see or write call D's
  namespaces.
- **Origin cache pool**: 10 s expiry, 16 MB byte cap — the pool is what
  makes fast-start and late join cheap (a subscriber arriving mid-stream is
  served recent groups from the cache); the cap bounds a bursty publisher.
- **`tickets.rs`** — media tickets: 32 random bytes (hex, 64 chars), 60 s
  TTL, lazy-swept on mint, mapping to `(user, room, call_id)`. Minted by the
  world on `call_start` and on the reconnect `hello` (a fresh ticket each
  time); bystanders get the roster with `ticket: None`. A ticket only ever
  travels over the owner's own TLS session. Not single-use — the TTL is the
  lifetime.
- **Known limitation** (documented in `session.rs`): a session may announce
  any namespace on its call's origin — moq-net exposes no announce hook on
  the server handshake, so a participant cannot be pinned to their own
  namespace. The blast radius is one call (origins isolate calls); the
  client subscribes by roster id.
- **No new socket.** MoQ sessions arrive on the existing quinn endpoint via
  h3; the `/moq` route in `api.rs` hands the WebTransport session to the
  SFU.

### Libraries

- **Server:** `moq-net` (transport-agnostic MoQ networking: Producer/
  Consumer API, built-in fan-out and group caching, negotiates moq-lite or
  IETF MoQT) driven by `moq-tokio`, served **over the existing h3/quinn
  endpoint** via a custom `web_transport_trait::poll` bridge over
  `h3::webtransport::Session` (streams + datagrams + close, poll-based).
  Server intake: `moq_net::server::Server::accept_request(session)` →
  `Handshake` (path, role, setup token) → ticket validation → `ok()` →
  `(Session, Driver)`.
- **Browser client:** `@moq/net` + `@moq/publish` + `@moq/watch` (npm,
  TypeScript). WebTransport on Chrome/Edge 97+ and Firefox 153+;
  `@moq/publish` ships the capture→WebCodecs→publish pipeline, `@moq/watch`
  ships subscribe→decode→render. Same project as the Rust stack — its own
  reference interop pair.
- **Pinned vendored copies:** `moq-net` is vendored under
  `third_party/moq-net` (see its `PATCH.md`); `h3-quinn` likewise. Wired via
  `[patch.crates-io]` in the workspace `Cargo.toml`.

## Client design (`client/src/call/moq.ts`)

- **One session, both directions.** `MoqCall` opens a single `@moq/net`
  connection on `/moq?ticket=…` with `publish: origin.consume()` and
  `consume: origin` on a local `Origin.Producer`, plus `discovery: true`:
  the session serves our uplink and feeds the peers' announced hangs into
  the same table the downlinks read.
- **Browser wire path:** h3 only accepts a `:protocol` of `webtransport` or
  `connect-udp`; a browser WebTransport session always negotiates `""`, so
  `@moq/net` takes its browser-compat path — the legacy in-band bidi SETUP
  exchange — landing on **moq-lite-02**, the same wire the Rust client
  negotiates. `connect()` must pass
  `webtransport: { protocols: undefined }`: any protocols list makes
  Chromium send a `:protocol` the h3 stack cannot parse, and the extended
  CONNECT is then dropped silently (`wt.ready` hangs).
- **Uplink** (one per call entry): `@moq/publish` over `getUserMedia` /
  `getDisplayMedia`; renditions `v` (camera), `a` (mic), and a dynamic `s`
  (screen) registered when the share starts and unregistered with
  `Encoder.close()` when it stops (the browser's own "stop sharing" button
  ends the track; the client listens for `ended`). Captures feed the
  manager's `localStream` tracks, so mute/camera `track.enabled` toggles
  carry over unchanged. A one-shot connection per call entry — no reconnect
  loop; the app's own reconnect (re-`hello`) mints a fresh ticket and the
  manager restarts the uplink in `rejoinCall`.
- **Demand gate:** `@moq/publish` renditions expose their live track only
  while a subscriber is attached, and the encoders encode only then: a
  participant nobody is watching announces the broadcast but ships no
  objects.
- **Downlinks are composed, not `Player`'d.** One pipeline per participant:
  `Watch.Broadcast {announced: true}` → `Watch.Sync {delay: "auto"}` →
  `Watch.Video.Source/Decoder/Renderer` for the camera canvas and the screen
  canvas (both created detached; the theater moves the element into its tile
  in place — rebuilding it would restart the decode), and
  `Watch.Audio.Source/Decoder` into our own WebAudio graph:
  `root → gain → destination` plus `root → MediaStreamDestination`, the
  stream feeding the tile's level meter. The gain is the silent zone (the
  meter keeps showing, output is muted); the meter tap is pre-gain on
  purpose.
- **Two `@moq/watch` traps** (gating logic in `moq.ts`): (1) the sources'
  `supported` input omitted means *no support probing at all* — decoders sit
  at zero frames with no error; pass the WebCodecs probe. (2) When the
  target rendition name is not in the catalog, a source silently falls back
  to another rendition — each video decoder is therefore gated on the track
  its source actually resolved (`out.track === "v" | "s"`), so a missing
  rendition downloads nothing.
- **AudioContext budget:** the library creates one `AudioContext` per audio
  decoder, so a full 9+ bubble holds ~8 contexts plus the theater's meter
  context — above Chrome's limit of 6; the surplus starts suspended and is
  resumed by our wiring (the join is the user gesture). A shared context
  with an own `AudioDecoder`→WebAudio pump is a future concern.
- **Dev decode page:** `client/public/moq-subscriber.html` loads `@moq/watch`
  from esm.sh at runtime (no npm dep) and renders a broadcast standalone.

## Metrics

`/metrics`, `campfire_moq_*` (`metrics.rs`):

- `sessions` (gauge, open now), `sessions_total`,
  `sessions_rejected_total` (403 at CONNECT),
- `origins` (gauge, live per-call origins),
- `objects_in`/`bytes_in`/`objects_out`/`bytes_out` counters from the
  moq-net stats registry (publisher role = media in, subscriber role =
  media out), tagged per session as `moq/call/<call_id>`.

## Testing

- **Integration:** `crates/campfire-server/tests/moq.rs` runs a moq-net
  client (`tests/moq_client_wt.rs`) against the real server: publish +
  subscribe within a call, outsider without/with bogus ticket rejected,
  stale ticket after call end rejected.
- **Browser E2E:** `tools/e2e/moq.js` — uplinks, downlinks both ways
  (via the `window.__campfire_moq` / `__campfire_moq_down` hooks), the Rust
  subscriber joining mid-stream, `/metrics`, screen share start/render/
  stop, mute/camera presence *and* catalog-driven delivery (frame count
  plateaus while the peer's camera is off), the tab-refresh reload, and the
  walk-away teardown. Run with `just moq-e2e`.

## Known issue: the peer's downlink after a tab refresh

After A reloads, A's *own* downlink (A receives B) recovers, but B never
re-receives A's re-announced broadcast (`moq.js` step 10 fails
consistently; ruled out: machine load, accumulated server state,
regressions). Server log shows A's re-joined session admitted to the SFU,
but no re-announce activity follows and B stays dark until both sessions
tear down. Break candidates, in order: (a) A's new session does not
re-announce its hang on the call origin, (b) the SFU retracts the hang
route on session end and does not re-route it when the hang is
re-announced, (c) B's `Watch.Broadcast {announced: true}` consumer does not
re-resolve after the route retraction. Diagnose with the
`__campfire_moq` / `__campfire_moq_down` hooks.

# Campfire

A virtual-office-style virtual office — avatars walking around 2D tile maps **talking and video-calling in real time** — with the entire backend in **Rust**, deployed as **one binary** listening on **one port number (443, UDP + TCP)**.

> **Status: Phase 4 complete (web client MVP).** This document is the implementation plan. Phases in [§11](#11-implementation-plan) are the ordered work items; each phase has an acceptance criterion and ends in a demoable state. Phase progress is tracked in the git history (`git log --oneline`).
>
> **Requirement update (2026-11-06):** voice/video calls are the headline feature. Opening 443 **TCP** in addition to 443 **UDP** is accepted; it is used for exactly one thing — the TURN/TLS media relay ([§6.2](#62-nat-traversal-everything-fits-in-443-tcpudp)).

---

## 1. What we are building

**In scope for v1 (a "usable virtual-office"):**

- **Voice + video calls — the headline feature**: proximity "bubbles" — walk close to someone and you are in a call together (WebRTC, P2P mesh with an embedded STUN/TURN fallback); walk away or opt out to leave. ([§6](#6-voice--video-calls))
- 2D tile-map worlds rendered in the browser (Tiled JSON map format)
- Your avatar + all other users' avatars, positions synced in real time with smooth interpolation
- Presence: see who is in the room, who is in a call (headphone badge), join/leave events
- Room chat (reliable, ordered) with a short history for late joiners
- Multiple maps, each with a room; room list API
- Anonymous usage: pick a nickname on entry, no accounts
- Single self-contained binary that serves the web client, the API, the realtime channel, and the STUN/TURN relay

**Explicit non-goals for v1 (see [§17 Backlog](#17-backlog-post-v1)):**

- Call recording and any server-side media processing — media is end-to-end encrypted (DTLS-SRTP) and the server never sees it; recording would require an SFU/MCU, which is a product decision, not an implementation detail
- Calls larger than ~12 participants (mesh ceiling; the UI degrades to voice-only earlier — [§6](#6-voice--video-calls))
- Accounts, private messages, permissions
- Whiteboards, notes, and other collaboration widgets
- Server-side persistence (presence is ephemeral; no database in v1)

## 2. Hard constraints and their consequences

| Constraint | Consequence |
|---|---|
| Written in Rust | Server is 100% Rust (one pragmatic exception noted in [§10](#10-key-technical-decisions)) |
| Single service | One binary, in-memory state, no sidecars, no database. The web client is *embedded into the binary* so the deploy artifact is a single file. STUN and TURN are embedded in the same process, not separate daemons |
| One port number: 443 | The process opens **exactly two sockets: 443/UDP (QUIC/HTTP/3 + STUN) and 443/TCP (a TLS front: Alt-Svc bootstrap + TURN splice)**. No other listeners. All application traffic — page, assets, API, health, metrics, realtime, call signaling — goes over HTTP/3 on UDP; TCP exists to let browsers discover HTTP/3 (they need an `Alt-Svc` header over TCP to switch) and so the media relay can pass locked-down networks |
| Media is P2P | WebRTC media flows browser-to-browser over *client-ephemeral* UDP. The server opens no media port range, relays media only when P2P fails (TURN), and can never decrypt it |

Because of the HTTP/3-only data path:

- **No WebSockets.** WebSocket is defined over an HTTP/1.1 upgrade and has no HTTP/3 variant. The modern replacement — the one that rides on HTTP/3 natively — is **WebTransport** (RFC 9220 / W3C WebTransport API): bidirectional streams *and* unordered datagrams on top of QUIC. Browsers expose it as `new WebTransport("https://host/wt")`. Call signaling is just another message type on this channel — no separate signaling protocol or port.
- **TLS is mandatory** (QUIC is always TLS 1.3, and browsers only allow WebRTC + WebTransport in secure contexts). Certificate handling is part of the design ([§15](#15-hosting--operations)).
- **The UDP socket carries two protocols** — QUIC and STUN — demultiplexed by STUN header validation (magic cookie; a GREASE'd QUIC 1-RTT packet may carry any first byte below 0x80, so the first byte alone cannot disambiguate) ([§6.2](#62-nat-traversal-everything-fits-in-443-tcpudp)).
- Health checks and curl-based debugging need `curl --http3`.
- **Honest limitation:** a network that blocks UDP entirely cannot use the app at all — QUIC itself is UDP, and so is the SSE fallback. The TCP port saves *media* on networks that allow 443/TCP but not P2P media; it does not make the app reachable without UDP. That is the inherent price of "HTTP/3 only", accepted by design.

## 3. Architecture

```
                    one port number: 443 (UDP + TCP)
 ┌──────────────────┐                 ┌──────────────────┐
 │   browser A      │                 │   browser B      │
 │   avatar + call  │◄───────────────►│   avatar + call  │
 └────────┬─────────┘  WebRTC media   └────────┬─────────┘
          │            P2P, ephemeral UDP       │
          │            (DTLS-SRTP, e2e)         │
          │            or via TURN relay ↓      │
          │            (443/TCP, encrypted,     │
          │             server can't decrypt)   │
          ▼  all app traffic + call signaling, HTTP/3/QUIC  ▼
 ┌────────────────────────────────────────────────────────────┐
 │                campfire (single binary)                    │
 │                                                            │
 │  443/UDP:  QUIC/HTTP/3 router (static, /api, /healthz,     │
 │            /metrics) + WebTransport sessions (streams +    │
 │            datagrams) + STUN binding responder (demuxed)   │
 │  443/TCP:  TLS front — Alt-Svc bootstrap (browsers discover │
 │            HTTP/3 here) + TURN splice (embedded turn-rs)   │
 │                                                            │
 │  in-memory: rooms, users, 50 ms tick loop, room calls      │
 └────────────────────────────────────────────────────────────┘
```

- **HTTP/3 router** (`h3` + `h3-quinn` + `h3-axum`): serves the embedded web client, the JSON API, health and metrics. `h3-axum` gives an Axum-style router on HTTP/3, so the routing layer is ordinary async Rust.
- **WebTransport sessions** (`h3-webtransport`, same socket family): each browser user holds one session. Reliable **bidirectional streams** carry commands, events, and **call signaling** (join, chat, SDP, ICE); **QUIC datagrams** carry high-frequency movement updates (loss-tolerant by design).
- **STUN responder + TURN relay**: embedded in the same process, co-located on 443 so NAT traversal needs no extra ports ([§6.2](#62-nat-traversal-everything-fits-in-443-tcpudp)).
- **World state**: plain in-memory Rust. A 50 ms tick loop collects movement deltas per room and fans them out as batched datagrams; call state is a per-room set driven by signaling events.

### A session's life, end to end

1. Browser does `GET https://office.example.com/` → the binary serves `index.html` + assets over HTTP/3 (all embedded, no filesystem at runtime).
2. Browser does `GET /api/v1/maps` → picks a world, loads the Tiled JSON from `GET /api/v1/maps/{id}`.
3. Browser opens `new WebTransport("https://office.example.com/wt")` → extended CONNECT over the *same* port → session established.
4. Browser sends `{"t":"join","room":"office-1","name":"georg"}` on a reliable stream → server answers with `{"t":"hello","you":…,"token":…,"users":[…],"chat":[…],"call":[…]}` (current room state + chat history + the user's reconnect token + the current call roster).
5. Client moves at up to 15 Hz; server runs a 50 ms tick; each tick, per room, one batched datagram (≤ 1200 B) containing all users' deltas is sent to every member of the room.
6. Chat and call signaling go over the reliable stream: ordered, lossless.
7. A call: signaling (SDP offers/answers, ICE candidates) is relayed over the same stream; **media flows browser-to-browser** — P2P over the users' own UDP where possible, via the 443/TCP TURN relay otherwise. The server never touches media content.
8. On disconnect (QUIC connection close) the server marks the user gone, broadcasts a leave, and drops the user from any call.

## 4. Network surface (everything on the one port number)

**Listeners**

| Socket | Protocol | Purpose |
|---|---|---|
| 443/UDP | QUIC/HTTP/3 (ALPN `h3`) | all application traffic + WebTransport realtime + call signaling |
| 443/UDP | STUN (RFC 5389), demuxed on the same socket | reflexive address discovery for WebRTC ([§6.2](#62-nat-traversal-everything-fits-in-443-tcpudp)) |
| 443/TCP | TLS front: Alt-Svc bootstrap + TURN splice (`turns:`, RFC 7065 / RFC 6062) | browsers discover HTTP/3 only via an `Alt-Svc` header, which must arrive over TCP — the front answers HTTP/1.1 with `Alt-Svc: h3=…` and reloads the visitor into QUIC; STUN-over-TLS streams (magic cookie at bytes 4–8) are spliced to TURN's plaintext loopback listener, the media relay fallback for locked-down networks ([§6.2](#62-nat-traversal-everything-fits-in-443-tcpudp)) |

**HTTP/3 endpoints**

| Path | Method(s) | Purpose |
|---|---|---|
| `/` | GET | `index.html` (embedded) |
| `/assets/*` | GET | JS/CSS/images (embedded) |
| `/api/v1/maps` | GET | List maps: `{id, name, thumb}` |
| `/api/v1/maps/{id}` | GET | Tiled JSON for one map |
| `/api/v1/rooms` | GET | Active rooms: `{room, map, users}` |
| `/api/v1/turn/credential` | POST | Short-lived TURN credentials: `{urls, username, credential, expires_in}` (RFC 8489, HMAC-signed, 1 h TTL, rate-limited) |
| `/healthz` | GET | Liveness: `{status, users, rooms, uptime}` |
| `/metrics` | GET | Prometheus text (scrapable over h3) |
| `/wt` | CONNECT (`:protocol webtransport`) | The realtime session (streams + datagrams) |
| `/rt/sse` + `/rt/event` | GET / POST | Fallback realtime for browsers without WebTransport ([§8](#8-the-web-client)) |

## 5. Realtime protocol

**Transport split**

- *Reliable stream (1 per user, JSON lines):* join/leave, chat, typing, **call signaling**, errors, hello. Ordered and lossless — exactly what these need.
- *Datagrams:* movement only. A stale position is worthless, so loss and reordering are fine (each entry carries a sequence number; the client keeps the newest).

**Client → server**

```jsonc
// reliable stream
{"t":"join",   "room":"office-1", "name":"georg", "avatar":{"color":"#e05f38"}}
              // …plus "token":"…" on a reconnect (restores the previous identity)
{"t":"leave"}                          // leave the room immediately (no reconnect grace)
{"t":"chat",   "text":"hi all"}
{"t":"typing", "on":true}
// datagram (compact; fields may go binary in a later protocol version)
{"m":[{"id":"u_1f3a9c02","x":41.5,"y":12.75,"d":"e","mv":1,"s":4821}]}
```

**Server → client**

```jsonc
// reliable stream
{"t":"hello",  "you":"u_1f3a9c02", "room":"office-1",
 "token":"9f3ab1c2…",
 "users":[{"id":"u_77ab…","name":"jules","x":40.0,"y":12.0,"d":"s"}],
 "chat":[{"from":"u_77ab…","name":"jules","text":"welcome!","ts":1762410000}],
 "call":[{"id":"u_77ab…","name":"jules"}]}   // current call roster (empty when no call)
{"t":"joined", "user":{"id":"u_…","name":"jules"}}
{"t":"left",   "id":"u_…"}
{"t":"chat",   "from":"u_…", "name":"jules", "text":"welcome!", "ts":1762410000}
{"t":"typing", "id":"u_…", "on":true}
{"t":"error",  "code":"rate_limited"}
// datagram: one batch per tick per room, all deltas for that room
{"m":[{"id":"u_1f3a9c02","x":41.6,"y":12.75,"d":"e","mv":1,"s":4822}, …]}
```

**Call signaling** (reliable stream; the server relays only between members of the *same room/call*, with size caps — SDP is a few KB, ICE candidates a few hundred bytes; cross-room or non-member signaling is rejected):

```jsonc
// client → server
{"t":"bubble",        "off":true}                  // opt out of proximity calls (or back in with false)
{"t":"call_offer",    "to":"u_…", "sdp":"…"}
{"t":"call_answer",   "to":"u_…", "sdp":"…"}
{"t":"call_ice",      "to":"u_…", "candidate":"…"}
{"t":"call_mute",     "audio":false, "video":true} // presence only (track.enabled flip)
{"t":"call_leave"}
// server → client
{"t":"call_start",    "room":"office-1", "participants":[{"id":"u_…","name":"jules"}, …],
                                                  "you_offer":true}   // you are the designated offerer
{"t":"call_leave",    "id":"u_…"}
{"t":"call_end",      "reason":"last_left"}
{"t":"call_offer",    "from":"u_…", "sdp":"…"}     // relayed
{"t":"call_answer",   "from":"u_…", "sdp":"…"}
{"t":"call_ice",      "from":"u_…", "candidate":"…"}
{"t":"call_mute",     "id":"u_…", "audio":false, "video":true}
```

**Call scope & bubble joining.** Call *state* (`call_start` / `call_leave` / `call_end`) is **room-wide** — every member of the room receives it, because it powers the headphone badge on avatars, not just the in-call UI. Call *presence* (`call_offer` / `call_answer` / `call_ice` / `call_mute`) stays **call-scoped**: relayed only between participants of the room's bubble. The server computes bubbles from avatar positions in the 50 ms tick (README §6.3); the client never asks to join. The **joiner is always the offerer** — they open one fresh `RTCPeerConnection` (and one SDP offer) to every existing member, who never renegotiate; the `you_offer` flag on `call_start` marks the designated offerer (the joiner; on creation the smaller user id). A `call_start` is also the catch-up a mid-call *room* joiner or a reconnecting participant receives, so their badge is correct from the start.

**Movement rules (server-enforced):** coordinates are tile space at 0.1-tile resolution; max speed 8 tiles/s (walk 4, run 8); destinations must be walkable (collision layer) and inside map bounds; client sends at most 15 Hz, server accepts at most 30/s.

**Datagram budgeting:** movement entries are ~15–20 B each → ~50–70 deltas per 1200 B datagram. If a room tick exceeds one datagram, the remainder goes on the reliable stream (rare, large rooms only).

**Reconnect:** the server keeps a disconnected user's identity for 30 s (token, room, position, call membership) and notifies nobody — to the room the user is just still there (no leave/join flicker). The client retries the join with the token from the last `hello`; on expiry the user becomes a fresh one. The `hello`'s `call` roster is the authoritative catch-up: a mid-call reconnect reads it and rejoins the call with a fresh direct offer to every existing participant ([§6.3](#63-call-model--ux)). An explicit `leave` skips the grace period entirely (used for room switching).

## 6. Voice & video calls

### 6.1 Topology: P2P mesh, not an SFU

Every call participant holds one `RTCPeerConnection` per other participant. Audio is Opus (always on while in a call); video is VP8/VP9 at 720p (only while the camera is on, and off in large groups).

**Why no SFU in v1:** an SFU (LiveKit, mediasoup, Janus) is a second service that owns its own UDP port range — it breaks the single-service constraint. A mesh is correct for virtual-office-style bubble sizes, keeps the server entirely out of the media path, and scales linearly with group size. An SFU is the documented escape hatch for large calls ([§17](#17-backlog-post-v1)).

**Group-size guidance (enforced in the UI, not the server):**

- Voice only: comfortable up to ~10–12 participants (each participant uplinks ~(N-1) × ~24 kbps).
- Video: ~5–8 participants (each video participant uplinks ~(N-1) × ~1 Mbps). At 9+ participants the app automatically drops video and keeps audio (overridable in settings).

**What the server does in a call:**

- **Signaling only** — relays SDP offers/answers and ICE candidates over the existing WebTransport stream ([§5](#5-realtime-protocol)). No new signaling protocol, no new port.
- **Call state** — who is in which call (per-room `Call`), drives `call_start/join/leave/end`, powers the headphone badge on avatars.
- **NAT traversal** — co-located STUN + TURN ([6.2](#62-nat-traversal-everything-fits-in-443-tcpudp)) and short-lived TURN credentials.
- **Nothing media-related** — media is DTLS-SRTP, end-to-end encrypted between browsers. Even the TURN relay (our own process) cannot decrypt call content. The server therefore *cannot record calls in v1* — a privacy property, not a gap.

### 6.2 NAT traversal (everything fits in 443 TCP/UDP)

| Layer | Where it lives | Notes |
|---|---|---|
| P2P media | browser ↔ browser, client-ephemeral UDP | The common path; the server is not involved |
| STUN (reflexive candidates) | **443/UDP, co-located with QUIC** | Small in-process responder. Demux by STUN header: a datagram that parses as a STUN message (message type + magic cookie, RFC 5389) is answered here, everything else is QUIC. The first byte alone cannot disambiguate — a GREASE'd (RFC 9287) QUIC 1-RTT packet may carry any first byte below 0x80, including the 0x00/0x01 STUN classes. A ~200-line `AsyncUdpSocket` proxy feeds QUIC packets to quinn and answers STUN Binding itself |
| TURN (relay fallback) | **443/TCP**, TLS (`turns:`, RFC 7065) | Embedded **turn-rs** (pure Rust; RFC 5766/6062/8489; actively maintained, v4.x). The relay leg toward the peer is UDP *outbound* from the server — no extra port |

What that buys us:

- **Open networks:** host/srflx candidates connect P2P directly; TURN is unused.
- **Locked-down networks** (outbound UDP allowed only on 443, or no UDP to peer ports): P2P media to the peer's ephemeral port fails → ICE falls back to the relay: browser → `turns:host:443` (indistinguishable from ordinary HTTPS to a firewall) → relay forwards UDP toward the peer. `turns:` on 443/TCP is the industry-standard last-resort path — Whereby, LiveKit, and Jitsi all run it.
- **UDP fully blocked:** the app itself is unreachable (QUIC is UDP) — the inherent price of the HTTP/3-only choice, accepted ([§2](#2-hard-constraints-and-their-consequences)).

Client ICE configuration (credentials from `POST /api/v1/turn/credential`):

```js
iceServers: [
  { urls: "stun:host:443" },
  { urls: "turns:host:443?transport=tcp", username, credential },
]
```

ICE priority does the selection: host → server-reflexive → relay; the relay tier is used only when cheaper paths fail.

### 6.3 Call model & UX

virtual-office-style **proximity bubbles** — calls form from where avatars stand, with no buttons:

- **Auto-join on approach:** the server computes bubbles in the 50 ms tick from avatar positions. Two eligible users within a **join radius of 3.5 tiles** form a bubble; anyone who walks within it joins. Joining is automatic, so the microphone permission prompt happens on the **first auto-join** — walking close *is* the user's intent. One bubble per room.
- **Walk away to leave:** a participant who drifts beyond the **leave radius of 4.5 tiles** (hysteresis around the join radius, so edge-hover doesn't flicker) is dropped after a **2 s grace delay**. Explicitly hanging up works too. A bubble dissolves (`call_end {reason:"last_left"}`) when ≤ 1 participant remains.
- **Opt-out toggle:** a 🔊/🔇 button in the status panel sends `bubble{off}` — the user is dropped from the current bubble at once and never pulled into a new one until they toggle back on.
- **Glare-free offers:** the joiner offers every existing member (on creation the smaller user id offers); `you_offer` marks it. A reconnected member gets `you_offer:true` in the catch-up: their old peer connections are dead, so they re-offer a fresh connection to everyone.
- **Mid-call events:** a newcomer opens N-1 fresh peer connections and re-ICEs (existing members don't renegotiate); a leaver's connections are torn down and everyone is notified; a mid-call reconnect rejoins with a fresh offer; mute/camera toggles flip `track.enabled` and broadcast `call_mute` — no renegotiation.
- **Quality UI:** active-speaker indicator (per-remote audio level), mute/camera/hang-up bar, per-peer connection state ("connecting / connected / via relay"), headphone badge on in-call avatars, participant panel showing mute/camera state.
- **Capture:** `getUserMedia` with `echoCancellation, noiseSuppression, autoGainControl` for audio; video capped at 720p.

## 7. World model (server state)

```
World
└── rooms: Map<RoomId, Room>          // RoomId = map id (v1: one instance per map)
    └── Room
        ├── map: MapData              // parsed Tiled JSON + walkability grid
        ├── users: Map<UserId, User>  // id, name, avatar, pos, dir, moving, seq
        ├── chat: RingBuffer<ChatMsg> // last 100, sent to joiners
        └── call: Option<Call>        // the room's bubble: participants + audio/video flags
                                      // (computed from positions in the tick, README §6.3)
```

- Pure in-memory, no locks on the hot path: one owner task per room (the tick loop), messages in via an `mpsc` channel.
- The tick loop (50 ms) is the only writer of outbound movement batches; everything else (chat, presence, call state) is event-driven.
- Call state is deliberately trivial — a set plus flags; every transition is driven by the tick's proximity check or a signaling message, validated (same room, sender is a participant).
- No persistence: restart = empty world. By design for v1.

## 8. The web client

- **TypeScript + Vite + PixiJS** (WebGL). Map rendering from Tiled JSON (tileset; collision layer used by the server, ignored by the renderer).
- Local input (WASD/arrows) with client-side prediction at 60 fps; remote avatars interpolated between 10 Hz snapshots (dead-reckoning + snap when error > 0.3 tile).
- Name labels above avatars; simple walk animation; room switcher + chat panel; headphone badge on in-call avatars.
- **Call layer:** `RTCPeerConnection` manager (one peer per call mate, clean teardown, leak-checked in tests), `getUserMedia` with AEC/NS/AGC, bubble participant panel, active-speaker meter, mute/camera/hang-up bar, bubble on/off toggle.
- Realtime: `WebTransport` if available (all evergreen browsers since ~2025: Chrome, Firefox ≥ 114, Safari ≥ 18.2), otherwise the **SSE + POST fallback** on `/rt/sse` + `/rt/event` (same port, still HTTP/3). The fallback degrades older browsers only — it does *not* help on UDP-blocking networks, because it is also QUIC.
- Built with Vite, then **embedded into the Rust binary** (`include_dir`/`rust-embed`) → zero static-file configuration at deploy time.

> **Decision point D1 — client language.** "Written in Rust" is interpreted as *the service* being Rust (it is, 100%). A 2D browser client in Rust→WASM is possible (wgpu/wasm-bindgen) but several times the effort for no user-visible benefit — and WebRTC media is done by the browser either way. Default: TypeScript. If you want Rust end-to-end, swap in Phase 4 — the server contract (§5) is language-agnostic.

## 9. Repository layout

```
campfire/
├── Cargo.toml                # workspace
├── rust-toolchain.toml
├── justfile                  # dev/test/build/docker/certs helpers
├── Dockerfile                # multi-stage → static image (EXPOSE 443/udp + 443/tcp)
├── .github/workflows/ci.yml  # fmt, clippy, test, release build, docker push
├── crates/
│   ├── campfire-server/      # the binary: sockets, h3 router, WT sessions, world, calls, API
│   │   └── src/
│   │       ├── main.rs
│   │       ├── config.rs           # clap + env (incl. --external-host, --turn-secret)
│   │       ├── transport/
│   │       │   ├── quic.rs         # quinn endpoint, rustls TLS, h3-axum router, WT accept
│   │       │   ├── stun.rs         # 443/UDP demux proxy + STUN binding responder
│   │       │   └── turn.rs         # embedded turn-rs (443/TCP, TLS, REST auth)
│   │       ├── world/
│   │       │   ├── room.rs         # users, chat ring buffer
│   │       │   ├── tick.rs         # 50 ms loop, datagram fan-out
│   │       │   ├── movement.rs     # speed/walkability/bounds validation
│   │       │   └── call.rs         # per-room call state machine, signaling relay
│   │       └── api/                # maps, rooms, turn credential, healthz, metrics
│   ├── campfire-protocol/    # message enums + codec + versioning (no IO; unit-testable)
│   └── campfire-maps/        # Tiled JSON parsing, walkability grid, bounds
├── client/                   # Vite + TS + PixiJS → dist/ embedded by the server
│   └── src/
│       ├── world/            # map rendering, avatars, interpolation
│       ├── net/              # WebTransport, SSE fallback, reconnect
│       └── call/             # peer connections, getUserMedia, bubble UI
├── maps/                     # bundled Tiled JSON maps + thumbnails
└── tools/
    └── loadtest/             # N simulated users + call groups over real QUIC (perf harness)
```

## 10. Key technical decisions

| # | Decision | Choice | Alternatives considered |
|---|---|---|---|
| Q1 | QUIC/HTTP/3 stack | **quinn + h3 + h3-quinn + h3-axum** | `quiche`/`tokio-quiche` (Cloudflare-grade, but BoringSSL/CMake build dep); `s2n-quic` (no good WebTransport pairing) |
| Q2 | WebTransport server | **h3-webtransport** (hyperium/h3 repo) | `wtransport` (most downloads, but self-declared not production-ready); `web-transport-quiche` (young, pairs with the quiche stack). `h3-webtransport` is the one that pools WebTransport sessions alongside normal HTTP/3 requests on the same connection family — exactly the single-port requirement |
| Q3 | HTTP/3 routing | **h3-axum** (Axum router on h3) | hand-rolled request dispatch |
| Q4 | Realtime transport | **WebTransport** (streams + datagrams) | WebSocket over TCP (violates single-port/HTTP/3); SSE-only (no clean low-latency uplink) |
| Q5 | TLS | **rustls** (via quinn; shared with turn-rs for the 443/TCP listener) | BoringSSL/OpenSSL — rejected: native build deps for a single-binary goal |
| Q6 | Map format | **Tiled JSON** (parse with serde) | virtual-office's TMD (custom, later if needed) |
| C1 | Call media topology | **P2P mesh** (no SFU in v1) | SFU via LiveKit sidecar or webrtc-rs: better for large calls, but a second service + a UDP port range → breaks single-service. Kept as the documented escape hatch ([§17](#17-backlog-post-v1)) |
| C2 | STUN/TURN | **turn-rs** embedded in-process (443/TCP TLS) + **own STUN binding responder** co-located on 443/UDP | coturn (C, separate daemon → breaks single-service); public third-party TURN (no control over credentials, abuse, or availability); no STUN (direct-connect rate collapses behind NATs) |
| C3 | Relay transport | **TCP/TLS only** (`turns:`) | UDP TURN on a separate port (not allowed — one port number); UDP TURN on 443/UDP (impossible — that socket is QUIC's). TCP relay is the last ICE tier anyway, so it only pays for itself on locked-down networks |
| D1 | Client language | **TypeScript** (see §8) | Rust→WASM |

Crate versions are pinned in `Cargo.toml` at Phase 0. `h3`/`h3-axum`/`h3-webtransport` are upstream-"experimental" and turn-rs is a smaller project — accepted, with the integration test suite ([§12](#12-testing-strategy)) as the safety net and version pins so upgrades are explicit.

## 11. Implementation plan

One developer, estimates in days. **MVP (walking + presence) = Phases 0–4 (≈ 13–14 days). Full MVP including calls = Phases 0–6 (≈ 20–21 days).**

### Phase 0 — Scaffolding (0.5 d)
- Cargo workspace (`campfire-server`, `campfire-protocol`, `campfire-maps`), toolchain pin, `justfile`, clippy+fmt, CI (fmt, `clippy -D warnings`, `cargo test`, release build).
- Pin crate versions (quinn, h3, h3-quinn, h3-axum, h3-webtransport, turn-server, rustls, tokio, clap, tracing, thiserror).
- **Done when:** empty binary boots, CI is green, `cargo test` runs.

### Phase 1 — HTTP/3 server core (2 d)
- Quinn UDP endpoint + TLS (rustls) + `h3-axum` router on one socket.
- Endpoints: `/` + `/assets/*` (empty embedded client for now), `/healthz`, `/api/v1/maps` (lists `maps/`).
- Config: `--listen`, `--cert`, `--key`; `just certs` for self-signed dev certs.
- **Done when:** `curl --http3 https://localhost:8443/healthz` returns 200; a browser loads the page over HTTP/3 (DevTools → Network shows `h3`).

### Phase 2 — WebTransport session layer (3 d)
- `CONNECT /wt` route → `h3-webtransport` session; per-session task with clean shutdown.
- Codec (JSON lines on the reliable stream; datagram frames in `campfire-protocol`).
- Handshake: `join` → `hello` (empty room for now); session lifecycle (connect/disconnect events logged).
- Rate limits + message size caps from day one.
- **Done when:** a Rust test client (WebTransport client over the same port) and the browser both complete join/hello/leave; rate-limit rejection is observable.

### Phase 3 — World state + movement (3 d)
- `campfire-maps`: Tiled JSON parsing, walkability grid, bounds.
- Rooms + users in `World`; 50 ms tick loop; batched datagram fan-out; movement validation (speed, walkability, bounds) per §5.
- Join/leave broadcast; chat history ring buffer; proximity bubble engine in the tick (README §6.3).
- Two bundled maps (a small office, an island) authored in Tiled and committed.
- **Done when:** integration test — 2 in-process clients join the same room, move, and each receives the other's deltas; an invalid move is rejected; chat round-trips with history for a third joiner.

### Phase 4 — Web client MVP (5 d)  → **MVP (walking + presence) demoable**
- Vite + TS + PixiJS scaffold; map loading + tile rendering; name labels.
- Local avatar with WASD + prediction; WebTransport connection with SSE+POST fallback; reconnection.
- Remote avatars: dead-reckoning + interpolation; join/leave pop-in/out.
- Client embedded into the binary (`include_dir`); `just dev` runs client (HMR) + server.
- **Done when:** two browser windows on the same machine show each other walking in real time through the single UDP port, with correct behavior after killing the network mid-walk.

### Phase 5 — 1:1 voice/video calls (4 d)
- Call signaling types in `campfire-protocol`; `world/call.rs` state machine; relay validation (same room, participants only, size caps).
- STUN co-location: `AsyncUdpSocket` proxy + STUN binding responder (RFC 5389; tested against RFC 5769 vectors).
- Embed turn-rs on 443/TCP with TLS + TURN REST auth secret; `POST /api/v1/turn/credential` (1 h TTL, per-IP rate limit).
- Client: peer-connection wrapper, `getUserMedia` (AEC/NS/AGC, 720p cap), mute/camera/hang-up bar.
- **Done when:** two browsers hold a 1:1 audio+video call; a headless page with `iceTransportPolicy: "relay"` and outbound UDP blocked completes the call over `turns:`; `icecandidateerror` events are captured and logged.

### Phase 6 — Proximity bubbles (3 d)  → **full MVP demoable**
- Bubble engine in the tick (join radius 3.5, leave radius 4.5 with a 2 s grace delay, one bubble per room, one join per tick); per-participant mesh management (N-1 connections, teardown with zero leaks — asserted in tests); participant panel; avatar headphone badge; mute/camera indicators; bubble on/off toggle.
- Mid-call events: newcomer re-ICE without disturbing existing members; mid-call drop/reconnect; walk-away leave.
- Auto voice-only degradation at 9+ participants.
- **Done when:** 6-participant bubble with video on 6 machines (or headless fakes); a mid-call join plus a mid-call drop/reconnect; no leaked peer connections; auto voice-only engages at 10 participants.
- *Delivery note:* everything the **server** does for bubbles (auto-forming from positions, one-joiner-per-tick growth with the joiner as offerer, room-wide call state, mid-call join/drop, walk-away leave, last-leave, fresh bubble on a cleared room) is covered by the `huddle` integration test over real QUIC. The **WebRTC** half (N-1 `RTCPeerConnection`s per member, zero leaked connections, auto voice-only at 9+) is browser-only and verified manually with six windows; the headless E2E lands in Phase 9 (§12).

### Phase 7 — Chat + presence polish (2 d)
- Chat UI (input, bubbles, typing indicator, history on join), room list + room switcher UI, presence panel (who's here, who's in a call).
- Reconnect-with-token (30 s window) per §5.
- **Done when:** chat is reliable under 5 % simulated packet loss (streams); a dropped connection rejoins without a leave/join flicker.
- *Delivery note:* reconnect-with-token is implemented end-to-end — `join` carries an optional `token`, `hello` returns the token plus the current `call` roster, a dropped session marks the member *gone* (not removed) for a 30 s window with no `left` broadcast, and a `tick` after the window turns it into a real leave. A new `ClientMsg::leave` skips the window (room switching). The `reconnect` integration test (real QUIC) proves the drop → rejoin keeps id/token/position/call-membership with zero `left`/`joined` seen by room-mates, and the same suite drives chat + a bubble's room-wide `call_start` through a local UDP relay dropping 1 in 20 datagrams each direction. The browser half (mid-call reconnect re-offers every participant, the presence panel's 🎧 badge, the room switcher) is manual for now; headless E2E lands in Phase 9 (§12).

### Phase 8 — Ops (2.5 d)
- Prometheus `/metrics` (connections, users/room, tick duration, datagrams in/out, rate-limit hits, call count, TURN allocations/relay bytes).
- Structured logs (tracing, JSON), graceful shutdown, full config via env+clap (`--external-host` for STUN XOR-mapped-address + TURN external announcement — required when the box sits behind NAT/LB).
- Docker: multi-stage → static image; `EXPOSE 443/udp 443/tcp`; deploy doc with firewall + DNS + TLS instructions ([§15](#15-hosting--operations)).
- **Done when:** `docker run -p 443:443/udp -p 443:443/tcp … campfire` serves the full MVP from a clean machine.
- *Delivery note:* all shipped — hand-rolled `/metrics` (no metrics crate; counters behind one `Arc`, world gauges read at scrape time, TURN numbers observed at the TLS front since the embedded relay exposes no stats API), `--log-json` structured logs, graceful shutdown (Ctrl-C stops the accept loop, closes open QUIC connections, 1 s drain), and a multi-stage `Dockerfile` (Vite build + cargo release build → `debian:stable-slim`). Docker `run` itself is unverified locally (no daemon in the dev environment); the deploy doc in [§15](#15-hosting--operations) reflects what is implemented.

### Phase 9 — Hardening (3.5 d)
- Load harness (`tools/loadtest`): walking users + call groups over real QUIC, ramped to the targets in [§13](#13-performance-targets); forced-relay variant (UDP blocked) to soak the TURN path; profile the tick loop and relay forwarding.
- Security pass: final limits, input validation audit, TURN credential abuse limits ([§14](#14-security--abuse-limits)), TLS config review, dependency audit.
- E2E suite (headless browser over HTTP/3, fake media) covering movement, chat, bubble join/leave.
- **Done when:** targets in [§13](#13-performance-targets) met on 2 vCPU; CI (including scheduled E2E) green for a week.
- *Delivery note:* shipped in adapted form:
  - **Load harness** `tools/loadtest` (`cargo run -p campfire-loadtest -- --url https://127.0.0.1:8443/wt --users 50 --ramp 6 --groups 3 --group-size 3`): ramps real QUIC/WebTransport bots that join real map rooms, walk at the client's cadence (0.4-tile steps @ 60 ms, under the 8 tiles/s gate), chat within the 1/s room limit, and park clusters on the spawn tile so the bubble engine forms calls whose members then relay fake SDP — the full server path minus real WebRTC. Verified against the dev server: 50 users, 2 rooms, 2 live bubbles, mean tick 0.16 ms (`campfire_tick_seconds_total`/`campfire_ticks_total`), zero connect errors/drops. The forced-relay soak variant and a 2 vCPU target rig remain manual (single dev machine here).
  - **Security pass:** every [§14](#14-security--abuse-limits) limit verified present in code (movement 30/s + 8 tiles/s speed gate, chat 1/s, stream 50/s, 256 KB/s, datagram ≤ 1 200 B, SDP 64 KB, ICE 1 KB, room cap 2 048, TURN mint limiter with per-IP cache); TLS 1.3-only rustls with `h3`-only ALPN on UDP. `cargo audit` (0.22): no vulnerabilities; one allowed warning (`rustls-pemfile` unmaintained — it only parses our own PEM files at boot, and its removal is tied to quinn/rustls helper churn upstream; tracked).
  - **Headless E2E** `tools/e2e/e2e.js` (puppeteer-core driving the installed Brave/Chromium headless with `--use-fake-device-for-media-stream`, `--origin-to-force-quic-on`): two pages auto-join via URL params, each sees the other in presence, a chat line broadcasts A → B, the co-located pair forms a bubble call (🎧 badges) that holds, and B's walk-away tears it down. Passing against the dev server. The browser half that stays manual: relay-only (`iceTransportPolicy: "relay"`) variant and the 9+ voice-only downgrade.

## 12. Testing strategy

- **Unit** (`campfire-protocol`, `campfire-maps`, `world`): codec round-trips, Tiled parsing fixtures, movement validator (speed/walkability/bounds), tick batching and datagram budgeting, call state machine transitions (incl. rejected cross-room signaling).
- **STUN/TURN:** STUN binding against RFC 5769 test vectors; TURN allocate/refresh/relay round-trip against the embedded turn-rs with a raw UDP socket; `turns:` path exercised with a TLS client.
- **Integration** (in-process server on ephemeral ports + real QUIC/WebTransport clients from Rust): join/hello/leave, movement ordering, invalid-move rejection, rate limiting, datagram loss (client keeps newest seq), SSE fallback equivalence, signaling relay policy.
- **WebRTC E2E** (headless Chromium with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, over HTTP/3): two pages — a proximity bubble reaches `connectionState === "connected"` with media flowing; 3+ pages, walk-away leave mid-call; relay variant with `iceTransportPolicy: "relay"`.
- **Load** (`tools/loadtest`, manual + nightly): ramp users and call groups, measure tick latency, relay bandwidth, CPU; output a small report per run.
- **E2E** (`tools/e2e/e2e.js`, puppeteer-core + the installed Brave/Chromium in headless mode with fake media and `--origin-to-force-quic-on`): two pages join via URL params, assert presence, chat broadcast, a held bubble call (🎧 badges) and walk-away teardown. Needs `npm i` in `tools/e2e`; the server must be running (`just server`).

## 13. Performance targets (Phase 9 gate)

| Metric | Target |
|---|---|
| Concurrent users (one room) | 1 000 avatars, 50 ms tick |
| Concurrent users (server total) | 10 000 across rooms |
| Concurrent bubble participants (server total) | 200, of which 30 % with video |
| Tick processing (p99, 1 000-user room) | < 20 ms CPU |
| Movement update rate | 10 Hz broadcast / 15 Hz accepted per user |
| Per-user downlink (busy room) | < 1 Mbit/s |
| TURN relay | 1 Gbit/s forwarding, 5 000 active allocations |
| Audio glass-to-glass (p95) | < 250 ms P2P; < 350 ms via relay |
| Ring → connected (p95) | < 3 s open network; < 10 s forced relay |
| Host | 2 vCPU / 2 GB RAM, Linux |

Numbers are verified with `tools/loadtest`, not assumed; binary movement encoding and mesh size caps are the main tuning levers if we miss.

## 14. Security & abuse limits

- TLS 1.3 mandatory on both sockets; same certificate for QUIC and TURN; only `h3` ALPN offered on UDP.
- Per-session rate limits: movement ≤ 30 msg/s, chat ≤ 1 msg/s, stream messages ≤ 50 msg/s, inbound ≤ 256 KB/s, single datagram ≤ 1 200 B, chat ≤ 500 chars, name ≤ 24 chars, SDP ≤ 64 KB, ICE candidates ≤ 1 KB.
- Server is authoritative for movement validity (speed + walkability), room membership, and call membership; the client is a pure presenter.
- **TURN credentials** (RFC 8489): HMAC-signed with a server secret (`--turn-secret`, auto-generated if absent), 1 h TTL, a fresh pair minted at most once per 10 min per IP — repeats inside that window (the whole office behind one NAT) get the cached pair, so every user of a shared IP still gets working relay credentials. Known accepted risk: the endpoint is anonymous in v1, so a determined attacker can mint relay credentials and burn bandwidth — mitigated by the mint rate limit, TURN allocation monitoring, and short TTLs; per-user quotas would need accounts (backlog).
- No unbounded allocations: all incoming messages parse through size-bounded buffers; per-room user cap (default 2 048) with a clear `error` to joiners beyond it.
- **Privacy:** media is DTLS-SRTP end-to-end; the server — including its own TURN relay — cannot decrypt calls. No recording capability exists in v1. Logs are identity-free (user ids are random).

## 15. Hosting & operations

- **Artifact:** one static binary (+ the Docker image, multi-stage build in `Dockerfile`: the client is built with Vite in the build stage so the binary embeds it; the runtime stage is `debian:stable-slim` + the one binary + CA certs).
  ```
  docker run -d \
    -p 443:443/udp -p 443:443/tcp \
    -v /etc/campfire/certs:/certs \
    campfire --listen 0.0.0.0:443 \
             --cert /certs/cert.pem --key /certs/key.pem \
             --external office.example.com:443
  ```
  (`--external` is the CLI flag — the public `host:port` STUN/TURN advertise.)
  Env: `RUST_LOG=info` (or `debug`) controls log level; `--log-json` switches
  to one JSON object per line. Graceful shutdown: SIGINT/SIGTERM stops the
  accept loop, closes open QUIC connections cleanly, and drains for 1 s.
- **Firewall:** allow `443/udp` and `443/tcp` (and nothing else for this service).
- **DNS:** A/AAAA record for the hostname; the TLS name must match (browsers verify it for both QUIC and `turns:`).
- **`--external`** matters whenever the box sits behind NAT/LB: STUN answers with the public address (XOR-MAPPED-ADDRESS) and TURN announces it to clients.
- **TLS / ACME:**
  - Dev: `just certs` (local CA + signed localhost cert) and `just trust` (CA into the NSS store). One caveat, verified in a Brave netlog: **Chromium trusts only its built-in roots for QUIC** — a user-installed CA verifies fine over TCP but always fails the QUIC handshake (`CERTIFICATE_VERIFY_FAILED`), so the dev loop launches the browser with the cert pinned by SPKI: `just brave` (`--origin-to-force-quic-on` + `--ignore-certificate-errors-spki-list`). The dev server binds `[::]:8443` because browsers resolve `localhost` to `::1` first.
  - Prod: Let's Encrypt. Note that **HTTP-01 validation is impossible** — it requires plaintext HTTP over TCP, which this server deliberately does not listen on. Use **DNS-01** (via `acme2-rs` with your DNS provider, or `certbot --manual`/DNS plugin on the host) and mount the PEM. A publicly-trusted cert needs no browser flags for QUIC.
- **Health check:** `curl --http3 -s https://host/healthz` (or the `/metrics` endpoint for probes).
- **Monitoring:** Prometheus scrapes `/metrics` over HTTP/3 (Prometheus ≥ 2.45): connections/WebTransport sessions (gauge + total), users/rooms/active bubbles, datagrams in/out with bytes, rate-limit rejections, tick time (`campfire_tick_seconds_total` / `campfire_ticks_total` → mean tick cost), and TURN splice count + relayed bytes as observed at the TLS front (the embedded TURN server exposes no stats API of its own). Structured JSON logs: run with `--log-json` (one object per line on stdout).
- **Scaling:** v1 is single-instance by design (state is in memory; the TURN relay is stateful). A future multi-node deployment means sharding rooms + instances across nodes + a TURN pool — out of scope, just noted.

## 16. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `h3`/`h3-axum`/`h3-webtransport` are upstream-"experimental" | API churn, bugs | Pin versions; integration suite as safety net; Phase 1 spike validates the stack before any product code |
| STUN co-location on the QUIC socket is subtle socket code | Broken STUN or QUIC | RFC 5769 vectors + integration tests; fallback: drop STUN entirely (direct-connect rate falls, relay still works) |
| P2P mesh ceiling (~12 voice / ~8 video) | Big bubbles degrade | Enforced UI guidance + auto voice-only; SFU escape hatch (explicitly breaks single-service; backlog) |
| turn-rs: relay is TCP/TLS-only, smaller upstream | Locked-down clients rely on it | It is the last ICE tier by design; monitor releases; relay path is E2E-tested in Phase 9 |
| TURN credential endpoint is anonymous in v1 | Bandwidth abuse via relay | Rate limits, 1 h TTL, allocation/byte monitoring; per-user quotas once accounts exist (backlog) |
| WebRTC in CI (headless, fake media) can be flaky | Noisy CI | E2E runs on a schedule (nightly), not as a merge gate |
| WebTransport edge-case bugs in browsers | Broken realtime for some users | SSE+POST fallback on the same port; feature-detect and log which path each client uses |
| UDP blocked by a user's network | App unreachable (QUIC is UDP) | Accepted trade-off of the HTTP/3-only constraint; the TCP port helps *media* on networks that allow 443/TCP but not P2P UDP |
| BoringSSL-free build goal vs quiche alternative | — | quinn/rustls chosen precisely to keep the toolchain pure Rust (Q1/Q5) |
| Tiled JSON format variety (many exporters) | Map parsing breakage | Fixed fixtures per parser version; accept a subset (orthogonal tiles, 1 collision layer) and document it |

## 17. Backlog (post-v1)

- **SFU for large calls** (LiveKit sidecar or a webrtc-rs relay): 15+ participant bubbles, simulcast, load-balanced relay. Deliberate trade: a second service and a UDP port range — the single-service constraint is what keeps it out of v1
- **Call recording** — requires server-side media processing (SFU/MCU); a product + privacy decision
- Screen sharing; spatial audio; phone/SIP gateway
- Accounts (OAuth) + private messages + per-map permissions + per-user TURN quotas
- Avatar customization (skins, hats, colors as first-class objects)
- Multiple room *instances* per map + per-room URLs
- Whiteboard / notes / meeting widgets
- TMD (virtual-office) map import for map portability
- Map upload API (behind auth) + lightweight in-browser map editor
- Persistence (chat archives, favorite maps), i18n
- Multi-node sharding if room counts ever demand it

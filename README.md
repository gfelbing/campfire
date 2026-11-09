# Campfire

A virtual office — avatars walking around 2D tile maps **talking and video-calling in real time** — with the entire backend in **Rust**, deployed as **one binary** listening on **one port number** (UDP for QUIC/HTTP/3 + STUN, TCP for the Alt-Svc bootstrap and the TURN media relay).

> **Status: working MVP.** Walking avatars on tileset-rendered maps, proximity-video bubbles, chat, reconnect across reloads and the browser back/forward cache, metrics, a QUIC load harness and a headless E2E suite. See the [roadmap](#roadmap) for what is next.

---

## 1. Quick start

```sh
just dev          # dev certs (if missing) + vite --watch + server on [::]:8443
just brave        # launch Chromium/Brave with the dev cert pinned for QUIC
```

Then open `https://localhost:8443/`. The landing page asks for a name and a map; joining navigates to `/play/<map-path>/?name=…&color=…`, and that URL is the room: reloading or sending it to a colleague lands directly on the same map with the same identity (name, color and reconnect token live in `sessionStorage`).

Examples:

- `https://localhost:8443/play/office/office.json` — the office map
- `https://localhost:8443/play/interiors/conference.tmj` — a Tiled map

Other tasks: `just check` (fmt + clippy + tests), `just build` (release binary with embedded client), `just docker`, `just test`.

## 2. Hard constraints

| Constraint | Consequence |
|---|---|
| Written in Rust | Server is 100% Rust |
| Single service | One binary, in-memory state, no sidecars, no database. The web client is embedded into the binary at compile time; `--static-dir` overrides it at runtime for the dev loop. STUN and TURN are embedded in the same process |
| One port number | Exactly two sockets: UDP (QUIC/HTTP/3 + WebTransport + STUN, demuxed) and TCP (a TLS front that serves the `Alt-Svc` bootstrap page and splices TURN media). Everything else — page, assets, API, realtime, call signaling — is HTTP/3 on UDP |
| Media is P2P | WebRTC flows browser-to-browser; the server relays only when P2P fails (TURN) and can never decrypt it |

Consequences of the HTTP/3-only data path: no WebSockets (WebTransport instead), TLS everywhere, `curl --http3` for debugging, and the honest limitation that a network blocking all UDP cannot reach the app at all — the TCP port rescues *media* on networks that allow 443/TCP but not peer-to-peer UDP.

## 3. Architecture

```
                    one port number (UDP + TCP)
 ┌────────────────┐                  ┌────────────────┐
 │   browser A    │                  │   browser B    │
 │ avatar + call  │◄──── WebRTC ────►│ avatar + call  │
 └───────┬────────┘  P2P or via TURN  └───────┬────────┘
         │      all app traffic + signaling   │
         │            over HTTP/3/QUIC        │
 ┌───────▼────────────────────────────────────▼───────┐
 │                campfire (single binary)            │
 │  UDP: QUIC/HTTP/3 router (static, /api, /healthz,  │
 │       /metrics, /play) + WebTransport sessions     │
 │       (streams + datagrams) + STUN responder       │
 │  TCP: TLS front — Alt-Svc bootstrap + TURN splice  │
 │  in-memory: rooms, users, 50 ms tick, room bubbles │
 └────────────────────────────────────────────────────┘
```

- **HTTP/3 router** (`quinn` + `h3` + `h3-axum`): serves the client, the JSON API, health and metrics.
- **WebTransport sessions** (`h3-webtransport`, same socket): one per browser. Reliable **streams** carry join/chat/signaling; **datagrams** carry movement.
- **STUN + TURN** embedded in-process (see below).
- **World state**: plain in-memory Rust. A 50 ms tick fans out per-room movement batches as datagrams and runs the proximity-bubble engine.

### A session's life

1. `GET /` → `index.html` + assets (embedded, or `--static-dir`).
2. The browser may first hit the TCP front: a bootstrap page answers with `Alt-Svc` and reloads once (keeping the full request target) so HTTP/3 takes over.
3. `GET /api/v1/maps` lists the maps; the map JSON comes from `GET /api/v1/maps/<map path>`.
4. `new WebTransport("…/wt")` → `{"t":"join","room":…,"name":…}` on a stream → `{"t":"hello", …}` with the room state, chat history, call roster and a reconnect token.
5. Movement goes out as datagrams at up to 15 Hz; each tick the server broadcasts one batched datagram (≤ 1200 B) per room.
6. On disconnect the member is marked *gone* (not removed) for the **10 s reconnect window**: no `left` broadcast, seat in the room and bubble kept. A re-join with the token restores identity, position and call membership instantly (and resets the movement sequence — a fresh page starts counting at 0). After the window the member is removed with a normal leave.

## 4. Network surface

| Socket | Protocol | Purpose |
|---|---|---|
| UDP | QUIC/HTTP/3 (ALPN `h3`) | all application traffic + WebTransport realtime + call signaling |
| UDP | STUN (demuxed on the same socket) | reflexive address discovery for WebRTC |
| TCP | TLS front | `Alt-Svc` bootstrap (browsers discover HTTP/3 only over TCP) + TURN splice (`turns:`) |

**HTTP/3 endpoints**

| Path | Purpose |
|---|---|
| `/` and `/assets/*` | the web client |
| `/play/{*rest}` | the SPA; the map is named in the path (`/play/office/office.json`) |
| `/api/v1/maps` | list maps: `{id, name, thumb}` |
| `/api/v1/maps/{*rest}` | the Tiled JSON (`office`, `interiors/conference`) or a file from the map's directory (`office/tiles.png`) |
| `/api/v1/rooms` | active rooms with member counts |
| `/api/v1/turn/credential` | short-lived TURN credentials (HMAC, 1 h TTL, rate-limited) |
| `/healthz`, `/metrics` | liveness; Prometheus text |
| `/wt` | the WebTransport realtime session |
| `/rt/sse` + `/rt/event` | SSE+POST fallback for browsers without WebTransport |

## 5. Realtime protocol

Reliable stream (JSON lines): join/leave, chat, typing, call signaling, errors. Datagrams: movement only (each entry carries a sequence number; stale ones are dropped).

```jsonc
// client → server (stream)
{"t":"join", "room":"office", "name":"georg", "avatar":{"color":"#e05f38"}}
             // "token":"…" restores the previous identity on reconnect
{"t":"leave"} {"t":"chat","text":"hi"} {"t":"typing","on":true}
{"t":"bubble","off":true}                    // opt out of proximity calls
{"t":"call_offer"/"call_answer"/"call_ice"/"call_mute"/"call_leave", …}

// server → client (stream)
{"t":"hello", "you":"u_…", "room":"office", "token":"…", "users":[…], "chat":[…], "call":[…]}
{"t":"joined"/"left"} {"t":"chat", …} {"t":"typing", …} {"t":"error","code":"…"}
{"t":"call_start", "participants":[…], "you_offer":true}
{"t":"call_leave","id":"u_…"} {"t":"call_end","reason":"last_left"}
{"t":"call_offer"/"call_answer"/"call_ice"/"call_mute", …}   // relayed

// datagrams (both directions)
{"m":[{"id":"u_…","x":41.5,"y":12.75,"d":"e","mv":1,"s":4821}, …]}
```

Call *state* (`call_start`/`call_leave`/`call_end`) is room-wide (it powers the headphone badge); call *signaling* is relayed only between participants of the same room's bubble. The **joiner is always the offerer**; `you_offer` marks the designated offerer. Movement is server-validated: tile space, max 8 tiles/s, walkable tiles only, ≤ 30 moves/s per user.

## 6. Maps

Maps live on disk, mounted at runtime — never bundled into the binary:

- `--maps-dir` (default `maps/`) is scanned **recursively**; every `*.json`/`*.tmj` file that parses as a Tiled orthogonal map becomes a map. Files that fail to parse are skipped, so a bad map cannot take the server down.
- **Map id = the file's path under `maps/`, minus the extension, minus a final segment that repeats its parent** (`office/office.json` → `office`, `interiors/conference.tmj` → `interiors/conference`). The id is the room id and the URL path segment.
- Tileset images are served next to the map JSON, so Tiled's relative `image` paths resolve as-is.
- The parser accepts the `collision` *and* `collisions` layer names (the latter is the Tiled convention) and the client flattens Tiled **group layers** in draw order.

In deployment, mount a directory of map folders with `--maps-dir /mnt/maps`; for development the repo's `maps/` is used. `maps/interiors/example/` is vendored with its own license files.

## 7. Voice & video calls

P2P mesh — one `RTCPeerConnection` per pair of participants, no SFU. The server relays signaling only; media is DTLS-SRTP end-to-end (even our TURN relay cannot decrypt it). NAT traversal: STUN co-located on the QUIC socket; TURN (`turns:` over 443/TCP, embedded turn-rs) as the last ICE tier.

**Proximity bubbles**, computed by the server in the 50 ms tick:

- A bubble is the **one-tile-radius circle around the centroid of its participants** (the client draws exactly that circle).
- **Creation:** two opted-in users closer than one tile.
- **Joining:** automatic — closer than one tile to the bubble's center pulls you in (at most one join per tick; the joiner is the offerer). The mic permission prompt happens on the first auto-join: walking close *is* the intent.
- **Leaving:** at the radius or beyond (or the bubble toggle) drops you **immediately** — no grace delay, no hysteresis. One bubble per room; the last leave ends it (`call_end {reason:"last_left"}`).
- A disconnected member keeps their seat for the reconnect window; their stale position is excluded from the centroid. A member who re-enters via their token gets a 2 s re-entry grace before the radius check applies again, so the reconnect promise (call membership survives) holds.
- Voice-only degradation at 9+ participants (UI-enforced); mute/camera toggles flip `track.enabled` and broadcast `call_mute` — no renegotiation.

## 8. The web client

- **TypeScript + Vite + PixiJS** (WebGL/WebGPU). Tilesets are rendered as sprites: the client loads each tileset sheet from `/api/v1/maps/<id>/<image>`, cuts per-tile frames (`firstgid`, `columns`, `margin`, `spacing`) and draws every visible tile layer in Tiled draw order, honoring horizontal/vertical tile flips. Collision layers shape walkability, not the picture.
- Local movement (WASD/arrows) with client-side prediction; remote avatars interpolated between batches; name labels; headphone badge on in-call avatars; the proximity bubble drawn as a translucent one-tile circle.
- Boot overlay: name, map picker, avatar color. A map named in the URL path suppresses the picker; joining from the landing page navigates to `/play/<map>/?name=…&color=…`.
- Realtime: WebTransport when available, otherwise the SSE+POST fallback on the same port. Reconnect-with-token survives page reloads (`sessionStorage`) and back/forward-cache navigation (the transport is closed on `pagehide` and rebuilt on `pageshow`; transport generations keep stale death callbacks from racing the live one).
- The built client is embedded into the binary; `just dev` serves `client/dist` from disk instead.

## 9. Repository layout

```
campfire/
├── crates/
│   ├── campfire-server/      # the binary: sockets, h3 router, WT sessions, world, bubbles, API
│   │   └── src/              # api.rs, world.rs (+ world/call.rs), realtime.rs, bootstrap.rs,
│   │                         # transport/ (quic, stun, turn), config.rs, metrics.rs, main.rs
│   ├── campfire-protocol/    # message enums + codec (no IO; unit-tested)
│   └── campfire-maps/        # runtime map loading (Maps::load), Tiled parsing, walkability
├── client/                   # Vite + TS + PixiJS → dist/, embedded by the server
│   └── src/
│       ├── world/            # mapdata.ts (Tiled subset), render.ts (sprites + bubble), avatars.ts
│       ├── net/              # WebTransport + SSE fallback, reconnect, token persistence
│       ├── call/             # peer connections, getUserMedia, bubble state machine
│       └── ui/               # boot overlay, chat, presence
├── maps/                     # mounted at runtime; one folder per map, tilesets alongside
├── tools/
│   ├── loadtest/             # QUIC bot swarm: joins rooms, walks, forms bubbles, relays SDP
│   └── e2e/                  # headless-browser E2E (presence, chat, bubble lifecycle)
├── justfile                  # dev/test/build/docker/certs helpers
└── Dockerfile                # multi-stage → runtime image (443/udp + 443/tcp)
```

## 10. Testing & operations

- **Unit**: protocol codec round-trips, Tiled parsing, walkability, movement validation (speed/walkability/bounds/staleness), bubble engine transitions, room-id validation.
- **Integration** (real QUIC/WebTransport clients on ephemeral ports): join/hello/leave, movement batching, bubble lifecycle (six-member huddle, mid-call drop/reconnect, walk-away), reconnect identity with zero flicker, chat under 5% packet loss, HTTP/3 API surface.
- **E2E** (`tools/e2e`, headless Chromium with fake media over HTTP/3): two pages join via URL, chat broadcasts, a bubble forms and tears down on walk-away.
- **Load** (`tools/loadtest`): ramped QUIC bots; verified 50 users / 2 rooms / 2 live bubbles with mean tick 0.16 ms.

Ops in brief: one release binary or the Docker image (`-p 443:443/udp -p 443:443/tcp`, certs mounted); Prometheus scrapes `/metrics` over HTTP/3; `RUST_LOG` + `--log-json` for logs; graceful shutdown on SIGINT/SIGTERM. Production TLS via Let's Encrypt **DNS-01** (HTTP-01 is impossible without a plaintext listener). Chromium trusts only built-in roots for QUIC — dev uses `just brave` with SPKI pinning; production needs a publicly-trusted cert.

## 11. Security & limits

TLS 1.3 only, `h3`-only ALPN on UDP. Per-session limits: movement 30/s, chat 1/s, stream messages 50/s, inbound 256 KB/s, datagram ≤ 1200 B, SDP ≤ 64 KB, ICE ≤ 1 KB, name ≤ 24 chars, room cap 2048. The server is authoritative for movement, membership and call state. TURN credentials are HMAC-signed, 1 h TTL, mint-limited per IP. No persistence, no accounts, identity-free logs (random user ids).

---

## Roadmap

### 1. UI redesign

Replace the floating panels with a structured layout:

- **Collapsible sidebar next to the map** (not overlapping it), with tabs:
  - *Main Menu* — what the status panel shows today (bubble toggle, room switcher), mic/camera toggles, device settings, bubble on/off.
  - *Players* — everyone on the map, with in-call badges,
  - *Chat* — the existing chat UI, moved in,
  The map canvas resizes with the sidebar instead of being covered.
- **Call theater overlapping the map**: while in a video call, remote video streams stack in a column on the right side, over the map. **Screen sharing** creates an additional video tile in that column (`getDisplayMedia` added to the mesh as one more local track). Clicking a stream **focuses** it: the selected stream shows large in the center overlay, the rest stay in the column; clicking again (or Escape) unfocuses.

### 2. Map enhancements

Treat maps as applications, not just floor plans:

- **Map properties**: honor Tiled map/layer properties
  - `jitsiRoom`: when entering, the player enters a rectangular bubble that has the size of the zone with that property, emulating a meeting room.
  - `start`: spawn area selection
  - `exitUrl` (walking onto the tile navigates to another map/URL, composing with the `/play/…` scheme).
- **Special zones**:
  - `silentZone` areas (drawn as ordinary layers with zone properties) mute proximity audio inside their bounds — position-based, computed in the same tick as bubbles.
- **Zoom**: scroll-wheel zoom of the map canvas (clamped, centered on the cursor), the camera keeping the local avatar centered unless panned.
- **Click-to-walk**: clicking a point on the map sends the avatar there along the **shortest walkable path** (BFS/A* over the collision grid on the client; the server's speed/walkability gates already accept the resulting step stream).
- Currently, there are small gaps rendered between the tiles, these should be cleanly aligned w/o gaps.

### 3. Custom avatars

Players pick an avatar instead of a flat color:

- A tileset of avatar sprites ships **bundled with the client** (part of the Vite build, not the map data).
- The boot overlay offers a visual picker of the available avatars.
- The chosen avatar and the name are **stored in the browser** (`localStorage`, keyed alongside the existing name/color persistence) and restored on every visit — no re-choosing, no accounts.
- The avatar choice rides the existing `join.avatar` payload (extended from `{color}` to a sprite reference); the server treats it as opaque presence data, and other clients render the same sprite for the avatar.


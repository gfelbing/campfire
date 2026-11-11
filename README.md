# Campfire

A virtual office — avatars walking around 2D tile maps **talking and video-calling in real time** — with the entire backend in **Rust**, deployed as **one binary** listening on **one port number** (UDP for QUIC/HTTP/3, TCP for the Alt-Svc bootstrap).

> **Status: working MVP.** Walking avatars on tileset-rendered maps, proximity-video bubbles and zone-based meeting-room calls (media over the MoQ SFU), silent zones with do-not-disturb, chat, map navigation between rooms, zoom and click-to-walk, a collapsible sidebar with a call theater, reconnect across reloads and the browser back/forward cache, metrics, a QUIC load harness and a headless E2E suite. See the [roadmap](#roadmap) for what is next.

---

## 1. Quick start

```sh
just dev          # dev certs (if missing) + vite --watch + server on [::]:8443
just brave        # launch Chromium/Brave with the dev cert pinned for QUIC
```

Then open `https://localhost:8443/`. The landing page asks for a name and a map; joining navigates to `/play/<map-path>/?name=…&color=…`, and that URL is the room: reloading or sending it to a colleague lands directly on the same map with the same identity (name, color and reconnect token live in `sessionStorage`).

Examples:

- `https://localhost:8443/play/office/office.json` — the office map
- `https://localhost:8443/play/interiors/conference.tmj` — a map from a local `maps/` subdirectory

Other tasks: `just check` (fmt + clippy + tests), `just build` (release binary with embedded client), `just docker`, `just test`.

## 2. Hard constraints

| Constraint | Consequence |
|---|---|
| Written in Rust | Server is 100% Rust |
| Single service | One binary, in-memory state, no sidecars, no database. The web client is embedded into the binary at compile time; `--static-dir` overrides it at runtime for the dev loop |
| One port number | Exactly two sockets: UDP (QUIC/HTTP/3 + WebTransport) and TCP (a TLS front that answers the `Alt-Svc` bootstrap with a 302). Everything else — page, assets, API, realtime, media — is HTTP/3 on UDP |
| Media is relayed | All call media transits the server-side MoQ SFU (never P2P); every client publishes its stream once and subscribes to the other participants |

Consequences of the HTTP/3-only data path: no WebSockets (WebTransport instead), TLS everywhere, and `curl --http3` for debugging. Media rides the same UDP port, so a network blocking all UDP cannot reach the app at all.

## 3. Architecture

```
                    one port number (UDP + TCP)
 ┌────────────────┐                  ┌────────────────┐
 │   browser A    │                  │   browser B    │
 │ avatar + call  │◄─── MoQ media ──►│ avatar + call  │
 └───────┬────────┘      via SFU     └───────┬────────┘
         │  all app traffic over HTTP/3/QUIC │
 ┌───────▼───────────────────────────────────▼────────┐
 │                campfire (single binary)            │
 │  UDP: QUIC/HTTP/3 router (static, /api, /healthz,  │
 │       /metrics, /play) + WebTransport sessions     │
 │       (streams + datagrams) + MoQ SFU sessions     │
 │  TCP: TLS front — Alt-Svc bootstrap                │
 │  in-memory: rooms, users, 50 ms tick, room bubbles │
 └────────────────────────────────────────────────────┘
```

- **HTTP/3 router** (`quinn` + `h3` + `h3-axum`): serves the client, the JSON API, health and metrics.
- **WebTransport sessions** (`h3-webtransport`, same socket): one per browser. Reliable **streams** carry join/chat/call-state; **datagrams** carry movement.
- **MoQ SFU** (a second WebTransport session per browser, docs/moq-sfu.md): publishes each participant's media once and re-serves it to the other participants.
- **World state**: plain in-memory Rust. A 50 ms tick fans out per-room movement batches as datagrams and runs the proximity-bubble engine.

### A session's life

1. `GET /` → `index.html` + assets (embedded, or `--static-dir`).
2. The browser may first hit the TCP front: it answers `302` back to the same target (with an `alt=1` marker) carrying `Alt-Svc`, so the browser caches the HTTP/3 alternative and follows the redirect over UDP. A request that still lands over TCP (marker present) gets an explanation page — UDP is unreachable there.
3. `GET /api/v1/maps` lists the maps; the map JSON comes from `GET /api/v1/maps/<map path>`.
4. `new WebTransport("…/wt")` → `{"t":"join","room":…,"name":…}` on a stream → `{"t":"hello", …}` with the room state, chat history, call roster and a reconnect token.
5. Movement goes out as datagrams at up to 15 Hz; each tick the server broadcasts one batched datagram (≤ 1200 B) per room.
6. On disconnect the member is marked *gone* (not removed) for the **30 s reconnect window**: no `left` broadcast, seat in the room and bubble kept. A re-join with the token restores identity, position and call membership instantly (and resets the movement sequence — a fresh page starts counting at 0). After the window the member is removed with a normal leave.

## 4. Network surface

| Socket | Protocol | Purpose |
|---|---|---|
| UDP | QUIC/HTTP/3 (ALPN `h3`) | all application traffic + WebTransport realtime + MoQ media |
| TCP | TLS front | `Alt-Svc` bootstrap (browsers discover HTTP/3 only over TCP) |

**HTTP/3 endpoints**

| Path | Purpose |
|---|---|
| `/` and `/assets/*` | the web client |
| `/play/{*rest}` | the SPA; the map is named in the path (`/play/office/office.json`) |
| `/api/v1/maps` | list maps: `{id, name, thumb}` |
| `/api/v1/maps/{*rest}` | the Tiled JSON (`office`, `interiors/conference`) or a file from the map's directory (`office/tiles.png`) |
| `/api/v1/rooms` | active rooms with member counts |
| `/healthz`, `/metrics` | liveness; Prometheus text |
| `/wt` | the WebTransport realtime session |
| `/moq` | the MoQ SFU media session (admitted by ticket, docs/moq-sfu.md §7) |
| `/rt/sse` + `/rt/event` | SSE+POST fallback for browsers without WebTransport |

## 5. Realtime protocol

Reliable stream (JSON lines): join/leave, chat, typing, call state, keepalive ping, errors. Datagrams: movement only (each entry carries a sequence number; stale ones are dropped).

```jsonc
// client → server (stream)
{"t":"join", "room":"office", "name":"georg", "avatar":{"color":"#e05f38"}}
             // "token":"…" restores the previous identity on reconnect
{"t":"leave"} {"t":"chat","text":"hi"} {"t":"typing","on":true}
{"t":"bubble","off":true}                    // opt out of calls
{"t":"call_mute"/"call_screen"/"call_leave", …}   // call presence
{"t":"ping"}                                 // keepalive: resets the idle timeout

// server → client (stream)
{"t":"hello", "you":"u_…", "room":"office", "token":"…", "users":[…], "chat":[…], "call":[…]}
{"t":"joined"/"left"} {"t":"chat", …} {"t":"typing", …} {"t":"error","code":"…"}
{"t":"call_start", "participants":[…], "zone":"MeetingRoom", "ticket":"…"}
{"t":"call_leave","id":"u_…", "zone":"…"} {"t":"call_end","reason":"last_left","zone":"…"}
{"t":"call_mute"/"call_screen", …}          // participant presence

// datagrams (both directions)
{"m":[{"id":"u_…","x":41.5,"y":12.75,"d":"e","mv":1,"s":4821,"sz":true}, …]}
                                     // "sz": inside a silentZone (only when true)
```

Call *state* (`call_start`/`call_leave`/`call_end`) is room-wide (it powers the headphone badge and the zone-rectangle highlight); `zone` marks a zone call (a room can carry several concurrent calls — one per occupied jitsi zone plus the proximity bubble). `ticket` rides `call_start` per participant (docs/moq-sfu.md §7) and admits the media session. Movement is server-validated: tile space, max 8 tiles/s, walkable tiles only, ≤ 30 moves/s per user.

## 6. Maps

Maps live on disk, mounted at runtime — never bundled into the binary:

- `--maps-dir` (default `maps/`) is scanned **recursively**; every `*.json`/`*.tmj` file that parses as a Tiled orthogonal map becomes a map. Files that fail to parse are skipped, so a bad map cannot take the server down.
- **Map id = the file's path under `maps/`, minus the extension, minus a final segment that repeats its parent** (`office/office.json` → `office`, `interiors/conference.tmj` → `interiors/conference`). The id is the room id and the URL path segment.
- Tileset images are served next to the map JSON, so Tiled's relative `image` paths resolve as-is.
- The parser accepts the `collision` *and* `collisions` layer names (the latter is the convention some Tiled maps use) and the client flattens Tiled **group layers** in draw order.

**Zones** — objects in Tiled *object layers*, rectangles in pixel coordinates divided by the tile size:

- `jitsiRoom` (string): a **meeting room** — everyone inside the rectangle is in the zone's call (it forms with the first occupant; walking in joins). The call area is the zone rectangle, not a circle.
- `silentZone` (or a truthy `silent`): **do not disturb** — occupants never form or join a proximity bubble, drop out of one they were in, are marked with a 🔇 badge, and their audio is muted for everyone nearby.
- `exitUrl` (string): walking onto the object navigates to another map. The URL is **relative to the current map's directory** (`conference.tmj` from `interiors/office` targets `interiors/conference`); a leading `/` targets from the `maps/` root, `..` climbs. A `#fragment` is allowed and ignored. Name and color survive the hop.
- An object named `start` marks the **spawn area**: the nearest walkable tile to its center (falling back outward in a ring) is the spawn point, used identically by server and client.

In deployment, mount a directory of map folders with `--maps-dir /mnt/maps`; for development the repo's `maps/` is used. Map folders you add locally are ignored by git and are yours to manage.

## 7. Voice & video calls

MoQ SFU — every client publishes one media stream to the server and subscribes to the other call participants; the server relays all media (WebTransport/443, docs/moq-sfu.md). No P2P, no WebRTC, no TURN.

**Calls**, computed by the server in the 50 ms tick — a room carries **at most one proximity bubble plus one call per occupied jitsi zone**; a user is in at most one call at a time:

- **Zone calls**: every occupied `jitsiRoom` zone runs its own call bounded by the zone rectangle — a lone occupant starts it, anyone who walks in joins. The client highlights each live zone's rectangle (visible to bystanders too).
- **Proximity bubbles**: the one-tile-radius circle around the centroid of the participants (the client draws exactly that circle). **Creation:** two opted-in users closer than one tile. **Joining:** automatic — closer than one tile to the center pulls you in (at most one join per tick across all calls). The mic permission prompt happens on the first auto-join: walking close *is* the intent.
- **Leaving:** outside your call's area (the zone rect or the bubble radius — or the bubble toggle) drops you **immediately** — no grace delay, no hysteresis. The last leave ends that call (`call_end {reason:"last_left","zone":…}`).
- **Silent zones**: occupants of a `silentZone` are excluded from proximity bubbles entirely — they never form or join one, and walking into the zone drops them out of a bubble they were in. Zone calls are unaffected (the two zone types are meant to be disjoint).
- A disconnected member keeps their seat for the reconnect window; their stale position is excluded from the centroid. A member who re-enters via their token gets a 2 s re-entry grace before the radius check applies again, so the reconnect promise (call membership survives) holds.
- Voice-only degradation at 9+ participants (UI-enforced); mute/camera toggles broadcast `call_mute` — presence only, the media track catalog follows.

## 8. The web client

- **TypeScript + Vite + PixiJS** (WebGL/WebGPU). Tilesets are rendered as sprites: the client loads each tileset sheet from `/api/v1/maps/<id>/<image>`, cuts per-tile frames (`firstgid`, `columns`, `margin`, `spacing`) and draws every visible tile layer in Tiled draw order, honoring horizontal/vertical tile flips. Collision layers shape walkability, not the picture.
- **Layout**: a collapsible sidebar next to the map (Main Menu / Players / Chat tabs) and a call theater overlapping the map while in a video call — remote streams stack in a column, screen sharing adds a tile, clicking a stream focuses it. The canvas resizes with the sidebar (`ResizeObserver`), not beneath it.
- **Local movement** (WASD/arrows) with client-side prediction; remote avatars interpolated between batches; name labels. **Click-to-walk**: a click routes the avatar along the shortest walkable path (BFS over the collision grid); keyboard input cancels. **Zoom**: scroll-wheel scaling of the map canvas, camera keeping the local avatar centered.
- **Zone visuals**: live call zones drawn as translucent green rectangles, proximity bubbles as a translucent one-tile circle, silent zones tinted gray; 🔇 do-not-disturb badge on avatars inside a `silentZone` (mirrored in the sidebar's presence list); audio from silent-zone peers muted locally.
- Boot overlay: name, map picker, avatar color. A map named in the URL path suppresses the picker; joining from the landing page navigates to `/play/<map>/?name=…&color=…`.
- Realtime: WebTransport when available, otherwise the SSE+POST fallback on the same port. Reconnect-with-token survives page reloads (`sessionStorage`) and back/forward-cache navigation (the transport is closed on `pagehide` and rebuilt on `pageshow`; transport generations keep stale death callbacks from racing the live one).
- The built client is embedded into the binary; `just dev` serves `client/dist` from disk instead.

## 9. Repository layout

```
campfire/
├── crates/
│   ├── campfire-server/      # the binary: sockets, h3 router, WT sessions, world, bubbles, API
│   │   └── src/              # api.rs, world.rs (+ world/call.rs), realtime.rs, bootstrap.rs,
│   │                         # demux.rs (quic socket), moq/ (SFU), config.rs, metrics.rs
│   ├── campfire-protocol/    # message enums + codec (no IO; unit-tested)
│   └── campfire-maps/        # runtime map loading (Maps::load), Tiled parsing, walkability
├── client/                   # Vite + TS + PixiJS → dist/, embedded by the server
│   └── src/
│       ├── world/            # mapdata.ts (Tiled subset), render.ts (sprites + bubble), avatars.ts
│       ├── net/              # WebTransport + SSE fallback, reconnect, token persistence
│       ├── call/             # MoQ media (uplink + downlink), getUserMedia, bubble state machine
│       └── ui/               # boot overlay, chat, presence
├── maps/                     # mounted at runtime; one folder per map, tilesets alongside
├── tools/
│   ├── loadtest/             # QUIC bot swarm: joins rooms, walks, forms bubbles
│   └── e2e/                  # headless-browser E2E (presence, chat, bubble lifecycle)
├── justfile                  # dev/test/build/docker/certs helpers
└── Dockerfile                # multi-stage → runtime image (443/udp + 443/tcp)
```

## 10. Testing & operations

- **Unit**: protocol codec round-trips, Tiled parsing, walkability, movement validation (speed/walkability/bounds/staleness), bubble engine transitions, room-id validation.
- **Integration** (real QUIC/WebTransport clients on ephemeral ports): join/hello/leave, movement batching, bubble lifecycle (six-member huddle, mid-call drop/reconnect, walk-away), reconnect identity with zero flicker, chat under 5% packet loss, HTTP/3 API surface.
- **E2E** (`tools/e2e`, headless Chromium with fake media over HTTP/3): two pages join via URL, chat broadcasts, a bubble forms and tears down on walk-away.
- **Load** (`tools/loadtest`): ramped QUIC bots; verified 50 users / 2 rooms / 2 live bubbles with mean tick 0.16 ms.

Ops in brief: one release binary or the Docker image (`-p 443:443/udp -p 443:443/tcp`, certs mounted); Prometheus scrapes `/metrics` over HTTP/3; `RUST_LOG` + `--log-json` for logs; graceful shutdown on SIGINT/SIGTERM. Production TLS via Let's Encrypt **DNS-01** (HTTP-01 is impossible without a plaintext listener). Chromium trusts only built-in roots for QUIC — dev uses `just brave` with SPKI pinning; production needs a publicly-trusted cert. On Kubernetes, use the [Helm chart](#kubernetes-helm).

## 11. Security & limits

TLS 1.3 only, `h3`-only ALPN on UDP. Per-session limits: movement 30/s, chat 1/s, stream messages 50/s, inbound 256 KB/s, datagram ≤ 1200 B, name ≤ 24 chars, room cap 2048. The server is authoritative for movement, membership and call state. No persistence, no accounts, identity-free logs (random user ids).

---

### Kubernetes (Helm)

Deploy the chart from GHCR (published with every version tag):

```sh
helm install campfire \
  oci://ghcr.io/gfelbing/helm/campfire --version 0.1.0 \
  --set domain=campfire.example.com \
  --set certificate.issuerRef.name=letsencrypt-prod
```

The chart's default image is `ghcr.io/gfelbing/campfire` with an empty tag —
that resolves to the chart's `appVersion`, which follows the release tag. If
the GHCR package is private, log in first (`helm registry login ghcr.io` with
a token holding `read:packages`; the cluster also needs `imagePullSecrets`).

The chart deploys a single instance on port 443 TCP + UDP, fronted by Traefik
(TCP TLS-passthrough on SNI + raw UDP forwarding) and expecting either
cert-manager or an existing TLS secret — see
[`deploy/helm/campfire/README.md`](deploy/helm/campfire/README.md) for the
requirements, key values and local (`helm install deploy/helm/campfire …`)
instructions.

## License

Campfire is licensed under the **GNU Affero General Public License v3** with the
**Commons Clause** license condition — see [`LICENSE`](LICENSE). In short: you
may use, study, modify, and redistribute the code under AGPL-3.0 terms, but you
may not sell a product whose value derives entirely or substantially from the
software itself. Note that Commons Clause software is not open source by the
OSI definition.

## Roadmap

The UI redesign (collapsible sidebar + call theater with screen sharing) and the
map enhancements (zones: `jitsiRoom` meeting rooms, `silentZone`, `start` spawn
areas, `exitUrl` navigation, zoom, click-to-walk) are shipped — see
[§6 Maps](#6-maps), [§7 Voice & video calls](#7-voice--video-calls) and
[§8 The web client](#8-the-web-client). What is left:

### Media: SFU via MoQ — shipped

Media is a server-side SFU speaking MoQ (Media-over-QUIC) over the existing
WebTransport/443 path; WebRTC, TURN and STUN are removed. Full plan:
[`docs/moq-sfu.md`](docs/moq-sfu.md) (its §10 known issue: the peer's downlink
after a tab refresh needs a follow-up fix).

### Map rendering polish

Small gaps between adjacent tiles are visible; tiles should align seamlessly.

### Custom avatars

Players pick an avatar instead of a flat color:

- A tileset of avatar sprites ships **bundled with the client** (part of the Vite build, not the map data).
- The boot overlay offers a visual picker of the available avatars.
- The chosen avatar and the name are **stored in the browser** (`localStorage`, keyed alongside the existing name/color persistence) and restored on every visit — no re-choosing, no accounts.
- The avatar choice rides the existing `join.avatar` payload (extended from `{color}` to a sprite reference); the server treats it as opaque presence data, and other clients render the same sprite for the avatar.


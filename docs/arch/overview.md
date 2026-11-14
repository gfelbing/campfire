# Architecture overview

Campfire is a single Rust binary on one port number (UDP + TCP), serving the
web client, the JSON API, the realtime WebTransport sessions and all call
media itself. State is in-memory; there is no database, no sidecar, no
external dependency.

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

- **HTTP/3 router** (`quinn` + `h3` + `h3-axum`): serves the client, the JSON
  API, health and metrics.
- **WebTransport sessions** (`h3-webtransport`, same socket): one per browser.
  Reliable **streams** carry join/chat/call-state; **datagrams** carry
  movement.
- **MoQ SFU** ([`moq-sfu.md`](moq-sfu.md)): a second WebTransport session per
  browser. Publishes each participant's media once and re-serves it to the
  other participants — no P2P, no WebRTC, no TURN.
- **World state**: plain in-memory Rust
  (`crates/campfire-server/src/world.rs`). A 50 ms tick fans out per-room
  movement batches as datagrams and runs the proximity-bubble engine.

## Network surface

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
| `/api/v1/auth` | auth status `{enabled, name?}` — always 200; the client probes it on boot |
| `/auth/login` | OIDC login: 302 to the IdP (only when auth is enabled) |
| `/auth/callback` | OIDC callback: code exchange, session cookie, 302 back (only when auth is enabled) |
| `/auth/logout` | drop the session, clear the cookie, 302 to `/` |
| `/healthz`, `/metrics` | liveness; Prometheus text |
| `/wt` | the WebTransport realtime session |
| `/moq` | the MoQ SFU media session (admitted by ticket, [`moq-sfu.md`](moq-sfu.md)) |
| `/rt/sse` + `/rt/event` | SSE+POST fallback for browsers without WebTransport |

## A session's life

1. `GET /` → `index.html` + assets (embedded, or `--static-dir`).
2. The browser may first hit the TCP front: it answers `302` back to the same
   target (with an `alt=1` marker) carrying `Alt-Svc`, so the browser caches
   the HTTP/3 alternative and follows the redirect over UDP. A request that
   still lands over TCP (marker present) gets an explanation page — UDP is
   unreachable there.
3. `GET /api/v1/maps` lists the maps; the map JSON comes from
   `GET /api/v1/maps/<map path>`.
4. `new WebTransport("…/wt")` → `{"t":"join","room":…,"name":…}` on a stream →
   `{"t":"hello", …}` with the room state, chat history, call roster and a
   reconnect token.
5. Movement goes out as datagrams at up to 15 Hz; each tick the server
   broadcasts one batched datagram (≤ 1200 B) per room.
6. On disconnect the member is marked *gone* (not removed) for the **30 s
   reconnect window**: no `left` broadcast, seat in the room and bubble kept.
   A re-join with the token restores identity, position and call membership
   instantly (and resets the movement sequence — a fresh page starts counting
   at 0). After the window the member is removed with a normal leave.

The wire format of every step is catalogued in [`protocol.md`](protocol.md);
the client side is described in [`client.md`](client.md); why the system is
built this way in [`decisions.md`](decisions.md).

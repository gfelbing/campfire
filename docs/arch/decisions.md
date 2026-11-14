# Architecture decisions — and why

Campfire's constraints are deliberate. Each decision below names the constraint
it serves and the consequences it forces on everything else.

## The four hard constraints

| Constraint | Why | Consequence |
|---|---|---|
| Written in Rust | single self-contained binary, predictable latency, no GC pauses for the 50 ms world tick; `quinn`/`h3` are the most mature QUIC/HTTP-3 stack | the server is 100% Rust; the client is TS but is built at compile time into the same binary |
| Single service, no database | a virtual office is ephemeral by nature: rooms, presence and calls all evaporate when the process dies. Persistence would add a moving part without a use case | in-memory state only; a restart empties the office. The web client is embedded into the binary at compile time; `--static-dir` overrides it at runtime for the dev loop |
| One port number | every extra port multiplies the operational surface (firewalls, ingress, DNS, certificates). One UDP port with everything multiplexed on it deploys anywhere a single HTTPS service deploys | exactly two sockets: UDP (QUIC/HTTP/3 + WebTransport) and TCP (a TLS front that answers the `Alt-Svc` bootstrap with a 302). Everything else — page, assets, API, realtime, media — is HTTP/3 on UDP |
| Media is relayed, not P2P | NAT traversal (STUN/TURN) is operationally heavy, and P2P fan-out floods uplinks for group calls. An SFU keeps each client to one upload regardless of group size | all call media transits the server-side MoQ SFU; every client publishes its stream once and subscribes to the other participants |

## Consequences of the HTTP/3-only data path

- No WebSockets — realtime uses **WebTransport** instead (with an SSE+POST
  fallback for browsers without WebTransport support).
- TLS everywhere, by definition of HTTP/3 (TLS 1.3, `h3`-only ALPN on UDP).
- Debugging uses `curl --http3` and browser devtools with WebTransport support.
- **A network blocking all UDP cannot reach the app at all.** Media rides the
  same UDP port, so there is no fallback.
- Reverse proxies must forward the ClientHello untouched. Terminating TLS in
  front of Campfire breaks both the HTTP/3 path and the WebTransport session:
  the client binds its session to the exact certificate chain the server
  presents. The Helm chart therefore uses Traefik with `tls.passthrough: true`
  on TCP and raw UDP forwarding.
- Let's Encrypt via HTTP-01 is impossible without a plaintext listener —
  production TLS uses **DNS-01**.
- Browsers trust only built-in root CAs for QUIC: self-signed and private-CA
  certificates work for TCP but silently fail HTTP/3. Dev loops pin the dev
  cert's SPKI in Chromium (`just brave`); production needs a publicly-trusted
  certificate.

## The MoQ SFU instead of WebRTC

WebRTC was removed in favour of **Media over QUIC (MoQ)** on the existing
WebTransport/443 path. The SFU never transcodes: each publisher adapts its
own uplink by sampling `WebTransport.getStats()` and dividing its estimated
send rate across video renditions; the downlink a viewer receives is the
publisher's rendition as-is. Full design: [`moq-sfu.md`](moq-sfu.md).

## Maps on disk, never bundled

Maps are mounted at runtime (`--maps-dir`), not compiled into the binary: map
folders are content, not code — a deployment swaps maps without a rebuild, and
the repo's `maps/` stays tiny. The directory is scanned recursively **at
startup and then immutable**: a map that fails to parse is skipped rather than
failing the boot, so a bad map cannot take the server down. See
[`../ops/maps.md`](../ops/maps.md).

## Server-authoritative world

The server owns movement, membership and call state:

- Movement is validated per datagram: tile space, max 8 tiles/s, walkable
  tiles only, ≤ 30 moves/s per user; stale sequence numbers are dropped.
- Call membership (proximity bubbles + zone calls) is computed by the server
  in the 50 ms tick; clients only render what the server broadcasts.
- Limits are enforced per session (movement 30/s, chat 1/s, stream messages
  50/s, inbound 256 KB/s, datagram ≤ 1200 B, name ≤ 24 chars, room cap 2048).

## Identity-free by default

No accounts, no persistence: users are random ids, logs are identity-free.
When a deployment wants accountability, optional **OpenID Connect**
authentication forces the display name from the IdP's `id_token`
([`../ops/README.md`](../ops/README.md)) — identity comes from the organisation
that already has it, not from Campfire.

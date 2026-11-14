# Campfire

A virtual office: your team as **avatars on a 2D tile map**, talking and
video-calling in real time — proximity video bubbles where you stand, dedicated
meeting rooms you walk into, silent do-not-disturb zones, chat, and clickable
navigation between rooms. The whole backend is one **Rust** binary listening on
**one port** (UDP 443 for QUIC/HTTP/3, TCP 443 as the HTTP/3 bootstrap), with
all media relayed by the built-in MoQ SFU — never peer-to-peer.

> **Status: working MVP.** See [`docs/`](docs/README.md) for architecture,
> development and operations details.

## Quick start

### Kubernetes (Helm)

```sh
helm install campfire \
  oci://ghcr.io/gfelbing/helm/campfire --version 0.1.0 \
  --set domain=campfire.example.com \
  --set certificate.issuerRef.name=letsencrypt-prod
```

The chart deploys a single instance on 443 TCP + UDP, fronted by Traefik
(TCP TLS-passthrough + raw UDP forwarding) and issuing the TLS certificate via
cert-manager. Alternatives — a bring-your-own TLS secret, `hostPath` maps
storage, OpenID Connect authentication — are in the
[chart README](deploy/helm/campfire/README.md).

### Docker

```sh
docker run --rm \
  -p 443:443/udp -p 443:443/tcp \
  -v $PWD/certs:/certs:ro \
  ghcr.io/gfelbing/campfire \
  --listen 0.0.0.0:443 --cert /certs/tls.crt --key /certs/tls.key \
  --external <your-public-IP>:443
```

Mount your TLS certificate (see requirements below) and a maps directory with
`-v /path/to/maps:/maps:ro --maps-dir /maps`. Image and chart are published
from every version tag; details in [`docs/ops/`](docs/ops/README.md).

## Requirements

The entire data path is **HTTP/3 over QUIC/UDP** — this shapes what Campfire
needs to run:

1. **UDP must be reachable.** Every request — the web page, the API, realtime,
   call media — rides the same UDP port. A network that blocks all UDP cannot
   reach Campfire at all. TCP 443 is only the `Alt-Svc` bootstrap that makes a
   regular browser discover the HTTP/3 endpoint.
2. **A publicly-trusted TLS certificate for your domain.** Browsers accept
   only certificates built into the OS/browser trust store for QUIC (Chromium
   trusts only built-in roots), so a self-signed or private-CA certificate will
   not work. For Let's Encrypt that means **DNS-01** — Campfire never opens a
   plaintext HTTP listener, so HTTP-01 is impossible.
3. **An HTTPS DNS resource record advertising HTTP/3.** So that clients can go
   straight to HTTP/3 instead of first connecting over TCP, publish an
   [RFC 9460](https://www.rfc-editor.org/rfc/rfc9460) record for the domain:

   ```
   campfire.example.com. HTTPS 1 . alpn="h3",no-default-alpn
   ```

   The TCP front also announces `Alt-Svc: h3=":443"; ma=86400` on every
   response, which is the fallback path for clients without HTTPS-RR support.
4. **A maps directory** — see below.

## Maps

Maps are **Tiled maps** ([`tiled` editor](https://mapeditor.org), `*.json` /
`*.tmj`), i.e. regular tiled 2D maps you can draw and edit yourself, not
compiled assets:

- A map folder holds the map JSON plus its tileset images, served next to it.
- The server scans its maps directory (`--maps-dir`, default `maps/`)
  recursively **at startup**; every map file that parses becomes a room. A map
  that fails to parse is skipped, so a broken map cannot take the server down.
- Special rectangle zones in Tiled object layers drive behaviour:
  `jitsiRoom` (a meeting room: everyone inside is in its call), `silentZone`
  (do-not-disturb), `exitUrl` (walk onto it to navigate to another map), and a
  `start` object (the spawn point).
- Players open a map at `https://<host>/play/<map-id>` — for example
  `/play/office` or `/play/interiors/conference`. The URL *is* the room:
  reloading or sharing it lands on the same map with the same identity.

How to build and edit maps — Tiled setup, zones, collision layers, the bundled
starter kit — is documented in [`docs/ops/maps.md`](docs/ops/maps.md).

## Documentation

| Path | Contents |
|---|---|
| [`docs/arch/`](docs/arch/README.md) | technical architecture and the *why* behind major decisions |
| [`docs/dev/`](docs/dev/README.md) | developing the service: dev loop, tests, repository layout |
| [`docs/ops/`](docs/ops/README.md) | deployment and administration: Docker/Helm, TLS, auth, metrics, **building maps** |
| [`CHANGELOG.md`](CHANGELOG.md) | release history |

## License

Campfire is licensed under the **GNU Affero General Public License v3** with
the **Commons Clause** license condition — see [`LICENSE`](LICENSE). In short:
you may use, study, modify, and redistribute the code under AGPL-3.0 terms, but
you may not sell a product whose value derives entirely or substantially from
the software itself. Note that Commons Clause software is not open source by
the OSI definition.

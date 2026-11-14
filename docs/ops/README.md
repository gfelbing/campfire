# Operations

Running Campfire in production. Development is covered by
[`../dev/README.md`](../dev/README.md), building maps by
[`maps.md`](maps.md), the Helm chart by
[`../../deploy/helm/campfire/README.md`](../../deploy/helm/campfire/README.md).

## What a deployment is

- One binary or container, two sockets: **443/udp** (QUIC/HTTP/3 — all
  traffic) and **443/tcp** (the `Alt-Svc` bootstrap).
- TLS material mounted at runtime — never baked into an image layer.
- A maps directory mounted at runtime (see [`maps.md`](maps.md)).

## Docker

```sh
docker run --rm \
  -p 443:443/udp -p 443:443/tcp \
  -v $PWD/certs:/certs:ro \
  -v /srv/campfire/maps:/maps:ro \
  ghcr.io/gfelbing/campfire \
  --listen 0.0.0.0:443 --cert /certs/tls.crt --key /certs/tls.key \
  --maps-dir /maps --external <your-public-IP>:443
```

- UDP is not forwarded by `docker run -p` unless you ask for `/udp`
  explicitly — hence both flags.
- `--external` is the address advertised in the `Alt-Svc` bootstrap; it
  defaults to `--listen` (correct in dev, wrong behind NAT/firewall). It
  accepts `ip:port` or a bare `ip` (the port then falls back to `--listen`'s).

## Kubernetes (Helm)

```sh
helm install campfire \
  oci://ghcr.io/gfelbing/helm/campfire --version 0.1.0 \
  --set domain=campfire.example.com \
  --set certificate.issuerRef.name=letsencrypt-prod
```

The chart deploys a single instance (`Deployment` with `Recreate` — state is
in-memory) on 443 TCP + UDP, fronted by Traefik
(`IngressRouteTCP` with `tls.passthrough: true` + SNI, `IngressRouteUDP`
forwarding raw datagrams) and either issuing a `Certificate` via cert-manager
or mounting an existing `kubernetes.io/tls` secret. Full value reference,
wildcard-cert and private-GHCR notes: the
[chart README](../../deploy/helm/campfire/README.md).

Why TLS must not be terminated in front of the pod (proxy TLS offload breaks
HTTP/3 and the WebTransport session): [`../arch/decisions.md`](../arch/decisions.md).

## TLS and DNS

- **Certificate must be publicly trusted** for browser QUIC (Chromium trusts
  only built-in roots). Let's Encrypt via **DNS-01** — HTTP-01 is impossible,
  Campfire has no plaintext listener. `cert-manager` with a DNS-01 issuer does
  this; a wildcard secret works too.
- **HTTPS DNS resource record** (RFC 9460) so clients can skip the TCP
  bootstrap and go straight to HTTP/3:

  ```
  campfire.example.com. HTTPS 1 . alpn="h3",no-default-alpn
  ```

  Without it, the TCP front's `Alt-Svc` header still gets browsers onto HTTP/3
  (one extra roundtrip over TCP first).

## CLI reference

| Flag | Default | Purpose |
|---|---|---|
| `--listen` | `127.0.0.1:8443` | UDP bind address for the QUIC/HTTP/3 socket |
| `--cert` / `--key` | — | TLS certificate chain / private key (PEM: PKCS#8, PKCS#1 or SEC1) |
| `--maps-dir` | `maps` | maps directory, scanned recursively at startup |
| `--static-dir` | — | serve the web client from disk instead of the embedded build (dev loop) |
| `--external` | = `--listen` | externally visible address for the `Alt-Svc` bootstrap |
| `--quic-idle-timeout` | `300` | QUIC idle timeout, seconds |
| `--log-json` | off | structured JSON logs (one object per line) for log shippers |
| `--auth-openid-enabled` | off | OpenID Connect auth — see below |

## Logging and metrics

- Logs on stderr via `tracing`; verbosity with `RUST_LOG` (e.g.
  `RUST_LOG=info`), `--log-json` for shippers.
- Prometheus scrapes `/metrics` **over HTTP/3** (it is part of the UDP data
  path — the scraper needs `--http3` support or the TCP bootstrap path).
- `/healthz` is the liveness probe.
- Graceful shutdown on `SIGINT`/`SIGTERM`.

## Authentication (OpenID Connect)

Disabled by default — identity-free by default
([`../arch/decisions.md`](../arch/decisions.md)). Enabled with:

```sh
--auth-openid-enabled \
--auth-openid-issuer https://idp.example.com \
--auth-openid-client-id campfire \
--auth-openid-client-secret …    # or $CAMPFIRE_AUTH_CLIENT_SECRET
--auth-openid-redirect-uri https://campfire.example.com/auth/callback
```

- Standard authorization-code flow for a confidential client:
  `/auth/login` 302s to the IdP (random `state` + `nonce`),
  `/auth/callback` exchanges the code and verifies the `id_token`
  (JWKS signature, `iss`, `aud`, `exp`, `nonce`), minting an HttpOnly
  `campfire_auth` session cookie (8 h TTL, **in-memory** — a restart signs
  everyone out).
- While enabled, a join without a valid session is refused (401) and the
  display name is **forced** from the id_token
  (`preferred_username` > `name` > email local-part > `sub`). The client
  probes `/api/v1/auth` on boot and redirects unsigned-in visitors to the IdP.
- In Helm: `auth.openid.*` values, secret preferably via `secretRef`
  (a Kubernetes Secret), never inline in values.yaml. The redirect URI is
  derived from `domain` and must be registered with the IdP exactly.

## Security and limits

TLS 1.3 only, `h3`-only ALPN on UDP. Per-session limits: movement 30/s,
chat 1/s, stream messages 50/s, inbound 256 KB/s, datagram ≤ 1200 B, name
≤ 24 chars, room cap 2048. The server is authoritative for movement,
membership and call state. No persistence, no accounts by default,
identity-free logs (random user ids).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Page loads, then "UDP unreachable" explanation page | the network blocks all UDP — HTTP/3 is the only data path |
| Page works, calls/realtime do not | the browser reached the server over TCP only; check the HTTPS DNS record and `Alt-Svc` (`curl --http3 -sv https://…`) |
| QUIC fails with a valid-looking cert | not publicly trusted — browsers reject private CAs for QUIC |
| Chart installs, no traffic | Traefik CRDs must be watched for the chart's namespace (the official chart watches all by default); both 443 entrypoints (TCP + UDP) must exist |
| New map not visible | maps are scanned **at startup** — restart the pod/process after adding files; parse errors are skipped silently by design (check server logs) |

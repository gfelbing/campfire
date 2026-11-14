# Campfire Helm chart

Deploys Campfire as a **single instance** (state is in-memory — rooms and
presence are stateful; see docs/ops/README.md) on its one port: 443 **TCP + UDP**.

## What it creates

| Resource | Purpose |
|---|---|
| `Namespace` | created when `namespace.create: true` (default) — every chart resource lands there; `create: false` keeps resources in the release namespace |
| `Deployment` (Recreate) | one pod: `campfire --listen 0.0.0.0:443 --cert /certs/tls.crt --key /certs/tls.key` |
| `Service` | port 443 TCP (`appProtocol: https`) + 443 UDP (`appProtocol: kubernetes.io/h3c`) |
| `Certificate` (cert-manager.io/v1, optional) | `certificate.create: true` issues `secretName` for `values.domain` via your issuer; set `false` to mount an existing `kubernetes.io/tls` secret instead (e.g. a wildcard cert). Either way the secret is mounted read-only at `/certs` in the pod |
| `IngressRouteTCP` (traefik.io/v1alpha1) | routes 443/tcp from the Traefik entrypoint to the service with **`tls.passthrough: true`** and an SNI match on `values.domain` — Traefik never terminates TLS; the pod does (QUIC/WebTransport require the server's own certificate in the handshake) |
| `IngressRouteUDP` (traefik.io/v1alpha1) | forwards 443/udp datagrams raw to the service (QUIC/HTTP/3) |

## Requirements

- Traefik v2+ with the CRDs installed and **two entrypoints published on
  port 443**: a TCP one (`traefik.tcp.entrypoint`, default `websecure`) and
  a UDP one (`traefik.udp.entrypoint`, default `quic`).
- TLS material for the pod: either cert-manager (chart creates the
  `Certificate`) or an existing `kubernetes.io/tls` secret — e.g. a wildcard
  cert you already requested (set `certificate.create: false` and
  `certificate.secretName`). The cert must be publicly trusted for browser
  QUIC (Chromium trusts only built-in roots for UDP/QUIC — docs/arch/decisions.md).
  Note the TCP route is TLS **passthrough**, so Traefik's own
  `certResolver` cannot serve this route: the pod terminates TLS itself.

## Using an existing wildcard certificate

```yaml
certificate:
  create: false
  secretName: wildcard-example-com-tls  # type kubernetes.io/tls
domain: campfire.example.com           # still the SNI match on the TCP route
```

The pod serves the wildcard chain for `campfire.example.com`; both the
TCP front and the QUIC listener use it.

## Install

```bash
helm install campfire deploy/helm/campfire \
  --set image.repository=ghcr.io/you/campfire \
  --set image.tag=0.1.0 \
  --set domain=campfire.example.com \
  --set certificate.issuerRef.name=letsencrypt-prod
```

## Maps storage

The server scans its maps directory (`--maps-dir`) recursively at startup;
every Tiled `*.json`/`*.tmj` becomes a map and tileset images are served
from files next to the map JSON. The chart mounts the directory and always
passes `--maps-dir` explicitly:

- Default `maps.kind: persistentVolume` — the chart creates a PVC
  (`maps.size`, `maps.accessModes`, `maps.storageClass`) and mounts it at
  `maps.mountPath` (default `/maps`). Put your map folders there
  (`kubectl cp` / rsync / a git-sync sidecar).
- `maps.kind: hostPath` — mounts a node-local directory
  (`maps.hostPath.path`, default `/srv/campfire/maps`) instead; the PVC is
  not created. Pin the pod to the node that has the directory.

## Authentication (OpenID Connect)

Disabled by default. When enabled, a visitor must sign in through the
configured IdP (authorization-code flow, confidential client) before joining
a room, and the display name is **forced** from the IdP's `id_token` — a
client can no longer choose its own.

```yaml
auth:
  openid:
    enabled: true
    client:
      issuer: https://idp.example.com   # the id_token's `iss`; discovery is
                                        # fetched from its /.well-known/...
      id: campfire
      secretRef:                        # preferred: a Kubernetes Secret
        name: campfire-oidc
        key: client-secret
      # secret: "inline-value"          # or inline (secretRef wins if both set)
```

Notes:

- The redirect URI is derived from `domain` as
  `https://<domain>/auth/callback` and must be registered with the IdP
  exactly.
- Prefer `secretRef` over the inline `secret`: values.yaml is usually in
  VCS, the secret never is.
- Sessions live in the server process (in-memory) behind an HttpOnly
  `campfire_auth` cookie (8 h TTL); a pod restart signs everyone out.

## Key values

```yaml
namespace:
  create: true                     # chart creates + uses its own namespace
  name: campfire
image:
  repository: localhost/campfire   # Docker image to run
  tag: ""                          # empty = chart appVersion
domain: campfire.example.com       # cert dnsName + IngressRouteTCP SNI match
external: ""                       # public "IP:port" for --external (Alt-Svc);
                                   # empty = flag omitted
certificate:
  create: true                     # false = bring your own kubernetes.io/tls secret
  secretName: campfire-tls
  issuerRef:
    name: my-issuer
    kind: ClusterIssuer
traefik:
  tcp: { entrypoint: websecure }
  udp: { entrypoint: quic }
service: { type: ClusterIP }
resources: {}
extraArgs: []                      # extra campfire CLI args, e.g. [--log-json]
maps: { kind: persistentVolume }   # or hostPath: { path: /srv/campfire/maps }
auth:                              # OpenID Connect; see "Authentication"
  openid: { enabled: false }
```

Note: the Traefik CRDs (routes) live in the chart's namespace and reference
the Service there — make sure Traefik's `kubernetesCRD` provider watches
that namespace (the official chart watches all namespaces by default).

## Why no TLS offload

Traefik must forward the ClientHello untouched (`tls.passthrough`): the
server shares one port between HTTP/3 (QUIC, TLS 1.3 by definition) and
the TCP HTTPS bootstrap, and the client binds its WebTransport session to
the exact certificate chain the server presents. Terminating TLS at
Traefik would break both (docs/arch/decisions.md).

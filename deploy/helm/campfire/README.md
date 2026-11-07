# Campfire Helm chart

Deploys Campfire as a **single instance** (state is in-memory — rooms,
presence and the embedded TURN relay are stateful; see README §15) on its
one port: 443 **TCP + UDP**.

## What it creates

| Resource | Purpose |
|---|---|
| `Deployment` (Recreate) | one pod: `campfire --listen 0.0.0.0:443 --cert /certs/tls.crt --key /certs/tls.key` |
| `Service` | port 443 TCP (`appProtocol: https`) + 443 UDP (`appProtocol: kubernetes.io/h3c`) |
| `Certificate` (cert-manager.io/v1) | issues `values.certificate.secretName` for `values.domain` via your existing issuer; the same secret is mounted read-only at `/certs` in the pod |
| `IngressRouteTCP` (traefik.io/v1alpha1) | routes 443/tcp from the Traefik entrypoint to the service with **`tls.passthrough: true`** and an SNI match on `values.domain` — Traefik never terminates TLS; the pod does (QUIC/WebTransport require the server's own certificate in the handshake) |
| `IngressRouteUDP` (traefik.io/v1alpha1) | forwards 443/udp datagrams raw to the service (QUIC, STUN, TURN) |

## Requirements

- Traefik v2+ with the CRDs installed and **two entrypoints published on
  port 443**: a TCP one (`traefik.tcp.entrypoint`, default `websecure`) and
  a UDP one (`traefik.udp.entrypoint`, default `quic`).
- cert-manager with an `Issuer`/`ClusterIssuer` that can issue for
  `values.domain` (the pod serves TLS, so the cert must be publicly
  trusted for browser QUIC — see the cert-trust notes in README §6.2/§15).

## Install

```bash
helm install campfire deploy/helm/campfire \
  --set image.repository=ghcr.io/you/campfire \
  --set image.tag=0.1.0 \
  --set domain=campfire.example.com \
  --set certificate.issuerRef.name=letsencrypt-prod
```

## Key values

```yaml
image:
  repository: localhost/campfire   # Docker image to run
  tag: ""                          # empty = chart appVersion
domain: campfire.example.com       # cert dnsName + IngressRouteTCP SNI match
external: ""                       # public "IP:port" for TURN (--external);
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
  namespace: ""                    # set if the CRDs should live in Traefik's namespace
service: { type: ClusterIP }
resources: {}
extraArgs: []                      # extra campfire CLI args, e.g. [--log-json]
```

## Why no TLS offload

Traefik must forward the ClientHello untouched (`tls.passthrough`): the
server shares one port between HTTP/3 (QUIC, TLS 1.3 by definition),
STUN/TURN and the TCP HTTPS bootstrap, and the client binds its
WebTransport/WebRTC session to the exact certificate chain the server
presents. Terminating TLS at Traefik would break all three (README §6.2).

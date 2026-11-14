# Developing Campfire

## Prerequisites

- **Rust** pinned by [`rust-toolchain.toml`](../../rust-toolchain.toml)
  (1.99.1, `rustup` picks it up automatically).
- **Node 22 LTS** for the client (`client/`, Vite + TypeScript + PixiJS).
- **just** for the task runner, and either `docker` or `podman` for images.
- A local TLS setup for HTTP/3: `just certs` creates a dev CA + server cert;
  `just trust` installs the CA in the browser trust store (TCP only —
  Chromium never trusts user-installed CAs for QUIC, so `just brave` pins the
  dev cert's SPKI for the HTTP/3 dev loop).

## The dev loop

```sh
just dev          # dev certs (if missing) + vite --watch + server on [::]:8443
just brave        # launch Chromium/Brave with the dev cert pinned for QUIC
```

Then open `https://localhost:8443/`. `just dev` keeps `vite build --watch`
rebuilding `client/dist` while the server serves it from disk
(`--static-dir`), so the server does **not** recompile on client changes.

## `just` tasks

| Task | What it does |
|---|---|
| `just fmt` / `just lint` / `just test` | rustfmt / clippy `-D warnings` / workspace tests |
| `just check` | all three |
| `just client-build` | `npm ci` + vite build → `client/dist` |
| `just dev` | dev certs + vite watch + server (see above) |
| `just build` | release build with the embedded client |
| `just docker` | container image build (podman, BuildKit cache mounts; extra args pass through) |
| `just certs` / `just trust` | dev CA + server cert / install the CA |
| `just brave` | Chromium with the dev cert pinned for QUIC |
| `just loadtest` | the QUIC bot swarm against a running server |
| `just e2e` | headless-browser E2E against a running server |
| `just moq-e2e` | MoQ call E2E: two real browser clients ↔ SFU |

## Repository layout

```
campfire/
├── crates/
│   ├── campfire-server/      # the binary: sockets, h3 router, WT sessions, world, bubbles, API
│   │   └── src/              # api.rs, world.rs (+ world/call.rs), realtime.rs, bootstrap.rs,
│   │                         # demux.rs (quic socket), moq/ (SFU), config.rs, metrics.rs
│   ├── campfire-protocol/    # message enums + codec (no IO; unit-tested)
│   └── campfire-maps/        # runtime map loading (Maps::load), Tiled parsing, walkability
├── client/                   # Vite + TS + PixiJS → dist/, embedded by the server
│   ├── src/                  # see docs/arch/client.md
│   └── public/               # moq-subscriber.html (dev/ops tool to render a call)
├── maps/                     # mounted at runtime; one folder per map, tilesets alongside
├── tools/
│   ├── loadtest/             # QUIC bot swarm: joins rooms, walks, forms bubbles
│   └── e2e/                  # headless-browser E2E (presence, chat, bubble lifecycle)
├── third_party/              # vendored, patched crates — see below
├── justfile                  # dev/test/build/docker/certs helpers
└── Dockerfile                # multi-stage → runtime image (443/udp + 443/tcp)
```

## Workspace and dependency policy

- Dependency pins are centralized in the workspace `Cargo.toml`
  (`[workspace.dependencies]`) — bump there, nowhere else.
- `third_party/` holds vendored copies patched locally:
  `moq-net` (SFU protocol, [`third_party/moq-net/PATCH.md`](../../third_party/moq-net/PATCH.md)),
  `h3-quinn` (panic fix, [`third_party/h3-quinn/PATCH.md`](../../third_party/h3-quinn/PATCH.md)),
  plus the client-side `moq-watch`/`moq-publish` patch scripts (run from the
  client's `postinstall` after `npm ci`). Wired via `[patch.crates-io]`.
- The tools (`tools/loadtest`) are workspace members: cargo loads every
  member's manifest before building, so their sources must exist even when
  only the server is compiled (`-p campfire-server` skips compiling their
  binaries but not their manifests).

## Client development

The client is plain Vite: `cd client && npm ci && npm run build`. The built
`dist/` is embedded into the binary (`include_dir`); `--static-dir client/dist`
serves it from disk for the dev loop. A map named in the URL path skips the
boot overlay's map picker. `client/public/moq-subscriber.html` is a standalone
dev tool that subscribes to a MoQ call and renders it.

## CI

`.github/workflows/check.yml` runs `just check` plus the headless e2e suite;
`docker.yml` builds and pushes the image and (with a version tag) the Helm
chart to GHCR.

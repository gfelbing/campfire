# Changelog

All notable releases of campfire. Versions follow calendar-agnostic
semver; releases are cut by tagging `vX.Y.Z` (the Docker image is built
and pushed to GHCR on each tag).

## [0.0.6] — 2026-11-11

Patch release: the image build is now warning-free.

### Changed

- The image build installs Node 22 LTS (NodeSource) instead of the
  Debian apt node 20, which sat below vitest's engine requirement and
  made npm warn `EBADENGINE` for the whole install. Node 22 matches the
  CI workflow.
- The vendored moq-net now uses the renamed `AtomicUsize::try_update`
  (the 0.3.23 source called the deprecated `fetch_update`, which the
  pinned Rust 1.99.1 warns about).
- The client build filters one upstream Rollup warning: zod (via
  `@moq/*`) writes `@__PURE__` annotations at positions Rollup cannot
  parse — the package targets esbuild, Rollup drops the comment and the
  bundle is correct.

### Fixed

- Quieted the remaining build noise: `npm ci` runs with
  `--no-audit --no-fund` in the image (the 10 moderate audit findings
  are dev-only eslint-chain `minimatch` issues, never shipped), and the
  entry chunk size hint gets a 1000 kB limit that still flags real
  bloat (the single entry chunk is the whole embedded client by design;
  Pixi is already dynamic-imported).

## [0.0.5] — 2026-11-11

### Added

- Full MoQ e2e green: the browser↔SFU e2e now covers 10 stages (join,
  presence, bubble call, MoQ sessions, downlinks both ways, SFU metrics,
  screen share, mute/camera-off presence and delivery, tab refresh,
  walk-away) and passes against the release build.
- Vendored `moq-net` 0.3.23 under `third_party/moq-net` with a local
  patch (`PATCH.md` documents the fix and how to re-vendor): Lite01/02
  publishers now register burst-announced routes in the live table, so a
  retraction ends them and a re-announce restarts them instead of
  re-sending an `Active` the peer rejects as a duplicate. This fixes the
  tab-refresh re-announce failure (the peer closed with
  `duplicate announce for …`).

### Changed

- Applied the remaining audit findings (S2, S3, B2, Q1, Q4–Q6, C7/U8,
  C13, C14, C15, X3, X4, X6) across the server, the client, CI and the
  tooling.
- The client's binary line reader was rewritten over raw bytes; the CSP
  now allows `blob:` media for rendered video.
- The e2e harness converges on steady-state downlink delay/jitter before
  asserting, and absorbs the server's reconnect window after a previous
  run.

### Removed

- `tools/moq-spike` (the Phase 0 spike tool) — superseded by the app
  build and the browser e2e. `docs/moq-spike-results.md` stays as the
  historical Phase 0 artifact.

### Fixed

- The Dockerfile no longer copies the removed spike directory and now
  copies `third_party/moq-net`, which the `[patch.crates-io]` entry in
  the workspace `Cargo.toml` points at.

## [0.0.4] — 2026-11-11

### Added

- Optional OpenID Connect sign-in with a forced display name.
- The call theater shows each remote tile's downlink latency.
- Bubble sounds: a bing on entering the bubble, a bong on leaving.
- Spawn-area map objects honor their `start` property.

### Fixed

- Reconnect keeps the identity across transport drops and long idleness.
- The ground-layer GID off-by-one that rendered water as nothing.
- TCP fallback now answers the Alt-Svc bootstrap with a 302 redirect
  instead of a 200 document.
- Tiled flip bits render in place instead of as unflipped tiles.
- The black grid lines between tiles are gone.

## [0.0.3] — 2026-11-11

### Fixed

- Restored the TLS front spawn in `run()` (Alt-Svc bootstrap was not
  listening).
- The Dockerfile `apt-get update` now runs before `apt-get copy`
  steps.
- Helm: `extraArgs` is a list, not a string.

### Changed

- PEM parsing switched from `rustls-pemfile` to `rustls-pki-types`.

## [0.0.2] — 2026-11-10

### Added

- The media stack was rebuilt around a MoQ SFU (docs/moq-sfu.md):
  - Phase 0: the `tools/moq-spike` Tier-1 matrix (fan-out, fast-start,
    loss) came back **GO**; findings recorded in
    `docs/moq-spike-results.md`.
  - Phase 1: the MoQ module in the app server — call tickets, the
    `/moq/{ticket}` endpoint, per-call origins, object metrics.
  - Phase 2: the browser client publishes its uplink to the SFU.
  - Phase 3: MoQ downlinks in the client with the full call UX
    (video, audio, screen, presence).

### Removed

- WebRTC, TURN and STUN end to end — the MoQ SFU is the only media
  path.

### Fixed

- The movement sequence guard now resets on a peer epoch restart, so a
  re-announced peer does not freeze on the receiver.

### Changed

- Until the MoQ cutover, WebRTC media was forced through the TURN relay
  (no P2P).
- The Dockerfile compiles only the server package and copies the spike
  into the build context.

## [0.0.1] — 2026-11-09

Initial release.

- A virtual office in one Rust binary: HTTP/3 + WebTransport on one
  port, WebSocket fallback behind the Alt-Svc bootstrap.
- Maps as self-contained directories loaded from disk at runtime; Tiled
  tilesets rendered as sprites.
- Proximity bubble calls with a call theater, screen share and a
  sidebar UI.
- Map extensions: `jitsiRoom` zones, `silentZone`, `start` spawn,
  `exitUrl`, zoom and click-to-walk.
- Reconnect: a 10 s reconnect window, bfcache-safe, with the token
  persisted per room and the identity restored on return.
- Docker image and Helm chart (own namespace, bundled or hostPath maps),
  built and pushed to GHCR on version tags.
- Licensed AGPL-3.0 with the Commons Clause.

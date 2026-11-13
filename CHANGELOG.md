# Changelog

All notable releases of campfire. Versions follow calendar-agnostic
semver; releases are cut by tagging `vX.Y.Z` (the Docker image is built
and pushed to GHCR on each tag).

## [0.0.9] — 2026-11-13

The call-quality release: the theater tiles tell the truth (real
resolution and real delay), and a round of chat, status and sidebar
repairs from the issues.md audit.

### Fixed

- Call theater resolution: the 800x600 cap now holds end to end. The
  live track is re-constrained after `getUserMedia` (some cameras
  deliver 1280x720 despite max constraints), and the vendored
  `@moq/publish` Capture reports the frame's *display* dimensions to
  the encoder — Chrome's `MediaStreamTrackProcessor` keeps delivering
  native coded frames (1280x720) after `applyConstraints` downsizes the
  track, so the encoder sized its renditions from the coded dims and
  the pixel budget auto-scaled a 16:9 frame to 912x512. Tiles now stay
  within the cap.
- Call delay indicator: computed from the root catalog's `clock` (PTS
  zero mapped to the moq epoch wall clock) instead of `out.reference`.
  The wire timestamps are the publisher's page clock and watch anchors
  against the viewer's own `performance.now()`, so the old indicator
  carried the two pages' load-time offset — one tab showed +4-5 s,
  another -4.3 s.
- Chat UI: the bubble chat accordion shares the sidebar pane with the
  room chat (it collapsed to zero height and squeezed the input forms
  out of view), a broken `.cf-chat` selector kept the panel from
  filling its accordion body (long chats pushed the input out of
  view), and a short message list no longer spreads over the whole
  height (align-content pinned to start).
- Chat panel CSS classes renamed to `cf-chat*`: Brave Shields' filter
  lists hide elements matching generic `.chat*` selectors.
- Auto-away keys off window focus/blur instead of visibilitychange and
  restores `online` only from an automatic away — a manually chosen
  `away`/`dnd` never changes on its own.
- Sidebar Users list: a status change now updates the sender's own row
  (the server never echoed `status` back), and a rename/color change
  survives the reload re-join (the token-restore path applied the
  parked member's stale name/avatar instead of the join's).

### Changed

- Call-scoped chat hardened: system and log lines surface as toasts
  instead of chat lines; joining a call opens the bubble chat
  accordion automatically.

## [0.0.8] — 2026-11-13

The UI redesign release: a one-line top bar, an accordion sidebar, a
profile menu, and presence statuses that shape call behavior.

### Added

- One-line top bar (Google Chat style): burger + Campfire logo + map
  switcher on the left; global 🎤/📷 mute/camera buttons (they work in
  and out of a call and persist across calls), a 🖥 screen-share button
  (in-call only) and the profile button on the right.
- Sidebar collapsed to an icon rail by default (per session) with
  exactly two accordion sections — Users and Chat; the rail icons
  expand it, the section headers collapse individual sections.
- Profile menu: name + avatar color edits (drafted, applied on "Done"
  via a rejoin) and presence status rows — online / away / do not
  disturb, persisted in `localStorage`.
- Presence statuses drive call behavior: `away` auto-joins calls with
  mic + camera disabled, `dnd` opts out of proximity calls entirely
  (the server syncs `bubble_off`), `online` is the normal path. The
  user list shows a status dot for every member.
- Auto-away: hiding the tab with no active call switches to `away`;
  focusing it again restores `online` (only from an auto-away, never
  over a manual status).
- Call-scoped chat: a message sent inside a call reaches only that
  call's participants; messages sent outside reach everyone not in a
  call. Both the live relay and the reconnect history filter the same
  way.
- The call theater keeps only the hangup control in its header; focus
  and resize behavior unchanged.

### Changed

- The landing page (`#boot` form) is gone: `GET /` redirects (303) to
  the first map, joining without settings picks the first map and a
  random adjective+noun name with a random color.
- Identity (name, color) and status persist in `localStorage` instead
  of URL get params; URL params remain a fallback so e2e drivers keep
  working with fresh profiles.
- New wire fields (backward-compatible, omitted when default):
  `status` on `Join`/`UserBrief`/`UserState`, the `Status` message
  pair, and status-scoped chat delivery.

## [0.0.7] — 2026-11-12

Patch release: the MoQ leak cluster behind the ~10-minute call breakage,
the login redirect loop, and the image build.

### Added

- A 30-minute soak gate (`just soak`, part of the e2e suite): two
  clients in a call with camera on; asserts per-window delivery, stable
  session/origin gauges, no panics or unexplained session ends,
  post-teardown gauges back to zero, and an RSS growth gate. First run:
  19.9k frames, RSS +0.4 MB.
- E2E stages for screen share, mute/camera-off presence and delivery,
  tab-refresh identity (re-join as the same user), and walk-away.
- Latency view: per-peer RTT plus a jitter sparkline.
- Integration tests for the OpenID Connect flow against a loopback mock
  IdP: the full happy path, a trailing-slash issuer, and a failed
  callback (the error page, not a redirect).

### Changed

- Vendored `h3-quinn` 0.0.10 under `third_party/h3-quinn` (patch
  documented in its `PATCH.md`): `stop_sending` no longer unwraps the
  in-flight stream, so a teardown-race panic can no longer skip the
  session task's cleanup.
- Client patches under `third_party/moq-watch` and
  `third_party/moq-publish` (run from the `npm` postinstall, each
  documented in its `PATCH.md`): a bounded decoder pacing wait with a
  ring-reset re-anchor, and a pinned catalog `stalled` flag that stops
  the screen-share re-announce churn (the encoder reinit storm).
- Catch-up audio: a driven 1 s entry / 300 ms steady delay; the ring
  drains backlogs at up to 2.5x instead of skipping frames.
- Keep-alive at `idle_timeout/3`; the fanout sweep drops origins of
  dead calls; session admission is reordered behind a 60 s fallback
  sweeper; a session-task watchdog closes the QUIC connection on panic.
- Graceful close: `pagehide` sends a leave, so the avatar leaves at
  once; `World::leave` holds the identity under the token for the
  reconnect window (session-guarded), so a reload re-joins as the same
  user.
- Avatar movement interpolates instead of snapping; the uplink bitrate
  scales from the measured send rate; the TCP fallback page self-heals
  when QUIC becomes reachable.

### Fixed

- The connection/session/origin leaks behind the ~10-minute call
  breakage (the Changed items above: keep-alive, fanout sweep, sweeper,
  watchdog, vendored h3-quinn) — the 30-minute soak passes clean.
- The audio flatline on the screen-share re-route.
- Infinite redirects on login: `Auth::new` now normalizes the issuer,
  so a trailing-slash `--auth-openid-issuer` no longer fails `iss`
  validation against every IdP; and a failed callback answers an error
  page with the reason instead of a silent 302 to `/` that re-triggered
  the client's login loop.
- The image build: the build stage now copies `third_party/h3-quinn`
  (a `[patch.crates-io]` path cargo needs to load) and
  `third_party/moq-watch` / `third_party/moq-publish` (the client
  postinstall's patch scripts).

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

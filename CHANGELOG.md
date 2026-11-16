# Changelog

All notable releases of campfire. Versions follow calendar-agnostic
semver; releases are cut by tagging `vX.Y.Z` (the Docker image is built
and pushed to GHCR on each tag).

## [0.0.19] — 2026-11-16

The honest-clocks release: the call's delay indicators now tell the
truth about what you see and hear, the video playhead skips to the live
edge instead of parking behind a buffer, the a/v offset is measured and
asserted, and the startup spike that came from anchoring playback in
the past is gone. The full analysis lives in
`docs/dev/latency-optimization.md` §9–§10.

### Changed

- Both delay indicators (the call tiles' `video/audio ms`) are now
  **playout-based**: the audio ring's playhead and the video decoder's
  presented frame, not the arrival lag. The old video number could read
  400 ms while playback trailed by seconds — the buffer backlog it
  hid. The two numbers' difference is the true a/v offset.
- The video clock tightens: `VIDEO_DELAY_MS` 400 → 200 with a 2×
  skip-stale backlog (maxAge ≈ 600 ms) — beyond it the Sync reference
  re-anchors and the playhead jumps to near the live edge (the
  "skipping images" trade: visible frame jumps instead of drift).
  Audio keeps its 4× buffer depth — it is the priority.
- The camera's auto-sizing bound drops 800×600 → 480×360 (−65% pixel
  work on the software encode + decode path); bitrate was the wrong
  lever for the CPU spikes (OpenH264 ignores bitrate without
  frame-skip — its own configure warning).
- The re-announce guard pulses the downlink gates on the *symptom*
  (decoded audio frozen ≥ 2 s while the broadcast is live — a re-route)
  instead of on every catalog change: the old trigger fired on the
  peer's warmup catalog churn too, tearing down and re-anchoring the
  subscriptions — the join-time spikes.

### Added

- A/v offset assertion in the e2e suite (|video − audio| playout ≤
  500 ms; fresh run 248 ms) plus a join-transient sampler and a
  console probe (doc §10.2) for diagnosing startup behavior in a real
  setup.
- `--delay-join-b-ms` in the MoQ e2e harness: reproduces walking into
  a call where the peer has been publishing for minutes.

### Fixed

- **Startup audio spike (up to 20 s, decaying over 10–20 s)**: the
  moq-lite-02 wire serves groups newest-first, so the publisher's held
  head arrived after the live edge and the audio ring anchored at the
  *oldest* released frame. The audio decode loop now drops frames older
  than the newest arrival minus the sync budget before decode (the
  ring anchors at the live edge), and the SFU's serving budget for
  lite-02 subscriptions honors the requested value instead of the
  upstream-unbounded default — live media is served at the live edge
  (vendored moq-net deviation, documented in its PATCH.md; catalog and
  fetch/replay paths unaffected).
- The OpenH264 reinit storm: the media-estimate module wrote its
  estimate into the catalog on any monotonic bump, re-announcing the
  hang and rebuilding every encoder. Writes are rate-limited to 1/s
  with ≥ 25% hysteresis (vendored `@moq/publish` patch) — the camera
  encoder now constructs once per call.
- Stale e2e selectors (`.call-*` → `#mic-btn`/`#cam-btn`/`#screen-btn`,
  broken since the topbar redesign) and the camera-off delivery gate
  for the 4× playback buffer.

## [0.0.18] — 2026-11-16

The sound-check release: audio gets its bitrate and buffer balance
(final tuning of the latency work), and the call pipeline now has a
headless test that transmits an actual audio file and verifies it
survives — the "can you hear me properly" check, automated.

### Changed

- Audio playback delay settles at 40 ms with 20 ms Opus frames (down
  from the instant-mode experiments that destabilized the ring: below
  ~20 ms the catch-up drain rate spikes, the playhead outruns the
  arrivals, and every frame is dropped — the full analysis and the
  accepted trade-offs live in `docs/dev/latency-optimization.md` §8).
- The audio ring holds 4× its playback floor (vendored `@moq/watch`
  patch, buffer pool and resize path) and the playback budget follows
  (`Sync.in.buffer` = 4 × delay): arrival bursts up to ~160 ms are
  absorbed and recovered by the catch-up drain instead of gapping.
- The uplink Opus encoder runs at 48 kbps (stock 32 k): the in-band FEC
  layer was starved at the old rate and never actually reconstructed
  lost frames. Group batching follows the 20 ms frames (60 ms groups).

### Added

- E2E audio intelligibility test (`tools/e2e/moq.js` step 5b): the fake
  media device plays a generated syllable WAV as the microphone, the
  e2e client records each downlink's decoded PCM, and the harness
  cross-correlates the recording against the source (best of five
  voiced windows, ≥ 70% = content survived) and asserts continuity
  (no silence gap > 150 ms). Found and fixed a recorder bug on the way:
  an audio-graph rewire rebuilt the decoder's AudioContext and the
  cross-context tap reconnect threw inside `wireAudio`, which could
  flatline audio — the tap now detects a context change and rebuilds,
  and a recorder failure can never break audio.
- The e2e environment: the fake video device renders a static y4m file
  instead of Chromium's animated generator (which burned ~5 cores in
  the browser process and pushed the transport ~800 ms behind the live
  edge), and the harness carries debug-only budget overrides
  (`__campfire_audio_ms`, `__campfire_video_maxpx`) so latency-
  sensitive assertions run against a budget that fits the headless
  environment — production budgets untouched.

### Fixed

- Stale e2e selectors: the topbar redesign moved the call buttons to
  `#mic-btn` / `#cam-btn` / `#screen-btn`; the suite's mute/camera/
  screen steps still queried the pre-redesign `.call-*` classes.
- The camera-off delivery gate accounts for the 4× playback buffer
  (a ~2 s ≈ 60-frame tail presents after the catalog lands, not the
  15 frames the old 2× budget allowed).
- Node 24 LTS in the check workflow and Docker build; actions/checkout
  v5, actions/setup-node v5.

## [0.0.17] — 2026-11-16

The instant-audio release: the call's audio path sheds every adjustable
millisecond — playback delay down to one ring floor, per-media clocks,
minimum browser buffers — and the call tiles show both media's latency
so a spike can be blamed on the right medium. The full analysis and the
stage-by-stage budget live in `docs/dev/latency-optimization.md`.

### Changed

- Call audio plays in instant mode: the ring floor is 20 ms (two 10 ms
  Opus frames, the smallest value the ring's catch-up drain tolerates
  stably — a 3 ms floor destabilized it and dropped every frame, seen as
  a runaway delay number), with the tile's audio number now reading
  ~25–40 ms instead of 100+. Audio and video run on separate playback
  clocks (100/400 ms targets became ~20/400), so a video buffer burst
  can no longer hold audio back; a/v sync is explicitly secondary.
- The uplink Opus encoder emits 10 ms frames (the browser default is
  20 ms, and a frame is only emitted when full) with in-band FEC
  (`useinbandfec`, `packetlossperc` 10) — packetization halved, loss
  reconstructed from the next frame's redundancy since there is no
  retransmission budget.
- Both AudioContexts (publish capture and watch decoder) run with
  `latencyHint: 0` instead of `"interactive"` — the smallest output
  buffer Chrome honors, ~10–20 ms less per side. Extended the vendored
  `@moq/watch` patch (new main-chunk replacement) and `@moq/publish`
  patch (now a replacement table).
- The audio uplink batches 5 frames per group (`groupDuration` 50 ms):
  the stock per-frame groups made the SFU open one QUIC stream per 10 ms
  frame — 50 opens + FINs per second per subscriber, now 10/s. Frames
  still stream out of the open group as they encode, so no delivery wait
  is added. Video already batches per keyframe via the legacy container.

### Added

- The call tiles show both media's e2e playback delay — video number,
  then audio number, each in its own color (video blue, audio green)
  matching the tile sparkline's two lines (video upper band, audio lower
  band), with RTT and resolution appended. Both numbers ride the two
  free-drifting Sync clocks; `delay` keeps meaning the audio clock
  downstream, e2e hooks included.
- A pipeline audit and optimization plan (`docs/dev/latency-optimization.md`
  §6–§7): the stage-by-stage mouth-to-ear budget, the library constraints
  that rule out literal `"instant"` mode, and the remaining (mostly
  hardware-bound) floor.

### Fixed

- Dependencies: moq-tokio 0.19.36 (pairs with the vendored moq-net
  0.3.23), @moq/net 0.4.8, pixi.js 8.23, eslint 10.15, vite 6.4.6.

## [0.0.16] — 2026-11-16

The latency release: call audio gets priority everywhere — in the
playback clock, on the wire's congestion window, and in the deployment's
datagram path — while the video tracks stop monopolizing the connection.
The analysis behind every number lives in `docs/dev/latency-optimization.md`.

### Changed

- Call audio plays 100 ms behind the live edge instead of the shared
  300 ms (the bulk of the observed mouth-to-ear latency even on a clean
  link), and camera/screen run on their own playback clock at 400 ms:
  a/v sync is explicitly secondary, so a video buffer burst can no
  longer hold audio playback back. The downlink `delay`/`jitter` shown
  in the roster (and read by the e2e hooks) now report the audio clock,
  the conversational metric. The uplink Opus encoder enables in-band
  FEC (`useinbandfec`, `packetlossperc` 10) — the audio budget has no
  room for retransmission, so a lost frame is reconstructed from the
  next frame's redundancy instead.
- Video renditions carry hard bitrate caps (1.5 Mbps camera, 800 kbps
  screen). Without a cap a rendition could claim the entire uplink
  estimate, and each 1 s keyframe flight then saturated the shared
  connection's congestion window — stalling every audio stream on the
  connection at once, the "spikes hit both incoming streams
  simultaneously" signature.
- The QUIC endpoint runs BBR congestion control instead of quinn's
  Cubic default: Cubic is loss-driven, so a keyframe flight collapsed
  the window and queued burst behind burst; BBR paces to the estimated
  bottleneck bandwidth, keeps queues shallow, and recovers without the
  multiplicative collapse. Flow-control windows stay at quinn's
  defaults (verified generous: unbounded connection receive, 1.25 MiB
  per stream).
- The demux socket hands datagrams to quinn in batches (`poll_recv`
  drains the whole queue into the buffer array quinn offers) and
  recycles its buffers through a pool — no per-packet allocation, one
  copy each side, instead of a fresh `Vec` plus two mutex hops and two
  copies per datagram on every call's hot path.

### Added

- Helm chart `network.kind: hostNetwork` (the new default) runs the pod
  on the host's network stack: the server's QUIC/UDP and TCP sockets are
  the node's 443, with no Service and no Traefik routes — nothing
  relays, NATs or conntracks the media path (the UDP entry hop was a
  latency source and conntrack garbage collection could drop live QUIC
  flows). `network.kind: traefik` keeps the previous shape for
  multi-node deployments; the cert-manager certificate flow is
  unchanged in both modes.

### Fixed

- Expected WebTransport stream teardown (camera toggle, re-announce
  pulse, session-close race) no longer spams the server log with
  `h3wt bridge error op=send_stream.write err=StreamClosed` warnings:
  stream-level terminal errors log at debug, connection-level failures
  keep warning.

## [0.0.15] — 2026-11-15

The icon release: the functional UI emoji move out, replaced by a
proper pixel icon set.

### Changed

- All functional icons now come from the `pixelarticons` package
  (MIT, halfmage) — the same pixel language as the character
  avatars, drawn properly instead of OS-vendor emoji. Only the ten
  icons the UI needs are imported (Vite `?raw`), so they bundle as
  small svg strings; `currentColor` keeps the on/off button styling
  in CSS. Wired across the app: the top bar's mic/camera/screen
  toggles and the sidebar burger, the theater's hang-up button and
  tile badges, the presence list's in-call/do-not-disturb badges,
  the avatar's in-call badge, and the sidebar's collapsed rail plus
  accordion labels (users / chat / bubble chat). The 🔥 wordmark and
  the accordion carets stay text.

## [0.0.14] — 2026-11-15

The friction release: the call stack sheds its busywork, and remote
avatars stop walking when you actually stop.

### Changed

- Call-stack lean-up (a review pass over the video path): downlink
  status transitions ("subscribing…" → "live") fire straight from the
  broadcast's status signal instead of a 1 Hz poll; the audio level
  meter taps the decoder's own AudioContext instead of a second one
  per participant (the meterStream hop is gone, silent zones keep
  their meters); the entry-delay ramp — whose entry and steady values
  had drifted to the same 300 ms — is deleted; screen shares keyframe
  every 2 s instead of every second (the camera keeps its 1 s
  fast-start interval); the theater's 1 Hz roster push only touches
  the DOM when a tile's text actually changed; the local PiP hides
  while the camera is off, like the remote tiles do; and the 1 Hz RTT
  poll can no longer stack overlapping `getStats()` calls into
  back-to-back roster pushes.

### Fixed

- Releasing the walk key now sends the final `mv=0` datagram
  immediately instead of waiting out the 2 Hz idle send gate. Before,
  the stop could take 500 ms to leave, during which other clients
  dead-reckoned along the last velocity and then froze mid-walk — the
  avatar visibly jumped on halt when the stop landed.

## [0.0.13] — 2026-11-15

The rehearsal release: no behavior change, just CI keeping its own
promises — and the repo gains the release checklist as a skill.

### Changed

- The release checklist (verify CI, bump every version file, write the
  changelog entry, tag) now lives in the repo as an agent skill
  instead of tribal memory.

### Fixed

- The MoQ SFU acceptance suite flaked in CI: the stale-ticket test hung
  up a call and expected the bubble to re-form within a 500 ms receive
  window, but the world's 2 s re-entry grace for a leaver
  (`BUBBLE_RETURN_GRACE`) keeps the bubble engine from re-forming until
  it expires. The test now waits out the grace before expecting the
  fresh ticket.

## [0.0.12] — 2026-11-14

The avatar release: real top-down pixel-art characters replace the
plain circles, and identity becomes something you pick.

### Added

- Pixel-art avatars: 40 top-down characters (Jephed, Game Between
  The Lines — free pack, credits in the README and next to the
  sheets), 4 directions × 3-frame walk cycle, rendered at 1.5×
  (30×48 px) with nearest sampling; the user's profile color is baked
  into the outfit band of their frames. Each user gets a stable
  variant — a hash of their room-visible name — and overlapping
  avatars sort by depth.
- Character picker: the profile settings are now a full-page layer
  (shown over the app while it loads when the identity is not fully
  picked yet, and over the running game from the profile button)
  with name, color and a 2×-thumbnail character grid. The pick rides
  the existing identity flow (`Avatar.character` on the wire) and
  persists in localStorage; other clients render the chosen
  character from the roster.
- The profile button shows the joined character instead of the
  name's initial.

### Changed

- Silent zones no longer draw the 🔇 badge above the avatar — their
  occupants are dnd since 0.0.11, so the red status dot marks them
  (the Users-list 🔇 and the local mute stay).

### Fixed

- The status dot and the 🎧 badge hung off the name label's baseline
  and read as detached; both anchor to the label's center now.
- The character picker's grid overflowed the popover horizontally;
  it fits and scrolls vertically only.

## [0.0.11] — 2026-11-14

The process release: silent zones hush presence, the dev loop gets
QUIC-proof cert handling, and CI shrinks to one `just` target per job.

### Added

- Flame favicon: an inline SVG in the accent palette (no asset fetch).
- Silent zones set presence to dnd: occupants show the 🔇 do-not-disturb
  badge (was `away`), so nobody expects a call answer from inside one.

### Fixed

- Hang up no longer re-pulls you into the bubble you just left: a leaver
  standing inside the bubble radius armed the proximity engine again on
  the next tick (roster broadcast plus a fresh call membership). Hang-up
  now arms the 2 s re-entry grace, and the bubble-join paths honor it.
- `just brave` failed the QUIC handshake: `just spki` captured the certs
  recipe's command echo into the SPKI flag, so the pin was garbage. The
  certs recipe is silent now, and `just trust` drops a stale CA nickname
  first, so it stays idempotent across cert rotations.

### Changed

- The check workflow's jobs do nothing but set up a toolchain and run one
  `just` target (`ci`, `ci-e2e`); all logic lives in the justfile. The
  rust and client gates merged into one job (the server embeds
  client/dist at compile time), just installs via `taiki-e/install-action`
  (just 1.59 dropped the bare binary asset), and the e2e driver runs the
  two pages in separate browser contexts with the dev cert's SPKI pinned
  for QUIC.
- Docs restructured into a user/dev/ops split.

## [0.0.10] — 2026-11-13

The presence release: chat reaches you even with the sidebar folded,
and the map shows everyone's status at a glance.

### Added

- Chat toasts: a message arriving while its chat panel is hidden
  surfaces as a toast (bold sender name) with a short synthesized
  "blob" blip (a sine sliding 320→140 Hz); an open panel stays quiet.
- Presence dots on the map: every avatar's name label carries a small
  status dot left of the name, in the Users-list palette (online green,
  away amber, dnd red) — set from the rosters, live-updated on `status`
  events, and applied to our own avatar on a status change.
- Chat unread dot on the collapsed sidebar's rail icons: the 💬 and 🗣
  rail buttons carry the same dot as the accordion headers, so new
  messages are visible while the sidebar is folded.

### Fixed

- `/moq/{ticket}` refused with auth enabled: the handler required a
  session cookie, but Chromium attaches none to a WebTransport
  handshake (the same reason `/wt` mints `?ticket=` auth tickets) —
  every CONNECT died as `net::ERR_QUIC_PROTOCOL_ERROR`. The single-use
  media ticket is the gate (minted only for an authenticated user's
  call membership, 30 s TTL, membership re-checked on CONNECT).
- Room chat never reported activity (only the bubble channel was
  wired), so the global unread dot — header and rail — never fired.

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

# Latency optimization plan

Status: draft. Goal: cut conversational latency in call sessions. Audio latency is the
priority; a/v sync is secondary (explicit product decision).

## 1. Analysis: where the latency comes from

### 1.1 The client buffer is the dominant term (local test)

`client/src/call/moq.ts` plays every rendition 300 ms behind the live edge:

```ts
const DELAY_MS = 300;
const BACKLOG_FACTOR = 2;
```

`Sync` gets `delay = 300 ms` and `buffer = 600 ms`; the audio ring switches to buffered
mode (`buffer ≤ 2 × delay` invariant) and the transport `maxAge` grows so a backlog
reaches the ring instead of being dropped. The observed "300 ms+ even locally with two
tabs" is this buffer plus encode/network overhead — it is a configured value, not a
bottleneck in the pipeline. Any local measurement below ~300 ms is impossible today.

### 1.2 Both incoming streams stall together (remote 3-person test)

Every participant runs **one** MoQ session per call (`MoqCall.start` →
`Net.Connection.connect`), which means one QUIC connection carries the uplink and *all*
downlinks. Consequences:

- The server→client path shares a single congestion window. A large send (video
  keyframe, 1 s GOP, both camera and possibly screen rendition) fills it; every stream
  on the connection stalls until the window opens again. Two incoming streams spiking
  simultaneously is exactly this, not a coincidence.
- Stream scheduling is FIFO: `crates/campfire-server/src/moq/h3wt.rs`
  `SendStream::set_priority` is a documented no-op ("h3 0.0.8 cannot re-prioritize an
  already-open QUIC stream; MoQ importance degrades to FIFO"). Audio waits behind video
  bursts with no way to overtake.
- moq-lite-02 wire: audio frames go as groups over unidirectional QUIC streams (the
  publish lib defaults `groupDuration = 0` for Opus, so one frame per group — good for
  pacing, but the transport is still ordered/reliable and shares the window).

### 1.3 Server transport is untuned

`crates/campfire-server/src/tls.rs` builds the quinn `TransportConfig` from defaults:
idle timeout + keep-alive only. Nothing sets receive/stream windows, send window,
datagram receive buffer, or the congestion controller. quinn's defaults are conservative
for bulk media; a bursty keyframe flight shrinks the effective window and amplifies the
queueing in 1.2.

### 1.4 The demux socket is a per-datagram serialization point

`crates/campfire-server/src/demux.rs` (deliberately, for burst-draining):

- every received datagram is copied into a freshly allocated `Vec<u8>`,
- pushed through a shared `Mutex<VecDeque>` handoff,
- copied a second time into quinn's buffer in `poll_recv`,
- and quinn receives **one datagram per `poll_recv` call** (the `RecvMeta` stride is one;
  no batching into the `IoSliceMut` array quinn offers).

Under a multi-connection burst (3+ participants) this adds a lock hop, two copies and a
task wakeup per packet, on top of the tokio runtime scheduling — measurable jitter
budget at high packet rates.

### 1.5 Traefik in front of QUIC adds a hop and conntrack

`deploy/helm/campfire/templates/ingressroute-udp.yaml` routes 443/udp through Traefik's
UDP entrypoint to a ClusterIP service. Cost per datagram: userspace relay + conntrack
(NAT) + kube-proxy DNAT. Two failure modes beyond constant overhead:

- UDP conntrack garbage collection can drop live QUIC flows under load (spikes),
- every in-flight datagram is doubled through conntrack state.

The TCP side (`ingressroute-tcp.yaml`, `tls.passthrough`) only carries the Alt-Svc
bootstrap and the first HTTP request; the QUIC/UDP side is where media latency is paid.

### 1.6 The `h3wt` WARN spam

`WARN campfire_server::moq::h3wt: h3wt bridge error op=send_stream.write
err=StreamClosed` fires whenever the SFU writes into a subscriber stream that the peer
already closed/reset (late teardown, camera toggle, the re-announce pulse in
`moq.ts`). This is expected, normal churn — logged at the wrong level. It also runs
through `log_err` on the hot write path.

## 2. Plan

Ordered by expected impact / effort. Each step is independently testable; measure with
the existing e2e hooks (`__campfire_moq_down`: `delay`, `jitter`, `bufferedMs`) before
and after each change, one change at a time.

### Step 1 — Audio-first playback delay (client, biggest win)

**Change:** replace the single `DELAY_MS` with per-medium targets:

- audio: the minimum the audio ring tolerates without underrun; start at 80–100 ms
  (`Sync` supports `"auto"`, which sizes the jitter buffer from probe RTT + rendition
  jitter — evaluate it for audio, fall back to a small fixed value if it overshoots).
- video (camera/screen): may stay higher (e.g. 300–500 ms) — the user explicitly
  deprioritized a/v sync, and decoupling the clocks means a video buffer burst can never
  delay audio playback.

This requires one `Sync` instance per medium in `moq.ts` (currently cam/scr/aud share a
single `sync` per downlink) or two clocks with the video one free to drift.

**Also:** enable Opus resilience for lossy paths — `Publish.Audio.Encoder` accepts an
`OpusConfig` with `useinbandfec: true` and `packetlossperc`; set both (`frameDuration`
stays default). FEC costs bitrate but keeps speech intelligible exactly when latency
spikes force drops.

**Acceptance:** local two-tab end-to-end mouth-to-ear delay measured (e.g. clap test /
oscilloscope recording) drops from ~350 ms to ~150 ms; `bufferedMs` drains to the new
floor after a spike.

### Step 2 — Deploy with hostNetwork, drop Traefik from the media path (helm)

Single-node k3s exists for deployment convenience and cert issuance only; Traefik adds
a hop without adding value (TLS is end-to-end passthrough anyway).

**Change in the chart:**

- New value, e.g. `network.kind: hostNetwork | traefik` (default `hostNetwork` for the
  single-node deployment; keep `traefik` available for multi-node).
- `hostNetwork` mode: `hostNetwork: true` + `dnsPolicy: ClusterFirstWithHostNet` on the
  pod, bind `--listen 0.0.0.0:443`. The pod's UDP socket is then the node's socket —
  no conntrack, no DNAT, no userspace relay.
- Do not create Service, IngressRouteTCP, IngressRouteUDP in this mode. Keep the
  cert-manager Certificate flow unchanged (certs still land in the pod's secret
  volume — the server terminates TLS itself either way).
- `domain`/`external` handling: with hostNetwork the client hits the node IP; document
  that `--external` must be the node's address and the domain (if any) resolves to it.
- TCP 443 must still reach the pod for the Alt-Svc bootstrap (hostNetwork covers it on
  the same socket); no ingress resource needed.

**Acceptance:** `kubectl get svc/ingressroute` shows nothing in hostNetwork mode; a
three-tab call shows fewer correlated delay spikes (verify against step-4 baseline —
conntrack drops were a suspected cause).

### Step 3 — Tune the quinn transport (server)

**Change in `tls.rs::server_config`:**

- `receive_window` / `stream_receive_window`: raise so a video burst cannot exhaust the
  connection-level window and back-pressure every stream (order of 1–8 MB; measure).
- `send_window`: raise symmetrically for the server→client direction.
- `datagram_receive_buffer_size`: set explicitly once datagram use grows (step 6).
- Congestion controller: quinn 0.11 supports alternative CCs behind feature flags
  (`bbr`, `copa`). BBR-style CC tolerates bursty real-time media better than Cubic's
  sawtooth; evaluate — it changes the *client's* shared-window behavior only
  indirectly (the server's upload CC is per-connection to each client). Keep Cubic as
  the baseline until step 4 results exist.

This is a `values.yaml`/`extraArgs`-independent server change; no config surface needed
initially (constants with comments, tuned once).

**Acceptance:** steady-state `jitter` and spike magnitude in the e2e hooks shrink on a
3-tab local call with one participant sharing screen (worst case for window contention).

### Step 4 — Prioritize audio over video on the shared connection (server + wire)

The root cause of correlated stalls is window sharing + FIFO. Two independent levers:

1. **Shrink the video contribution** (client, cheap):
   - `maxBitrate` cap on both video encoders (e.g. 1.5 Mbps camera, screen lower) so
     the allocator's grant has a hard ceiling instead of "the whole uplink estimate".
   - keyframe interval 1 s → 2 s for the camera during multi-party calls (fast-start
     budget still met; halve the per-second full-frame burst).
2. **Get audio out of the ordered path** (wire-level, bigger win):
   - moq-lite supports per-track **datagrams** ("best-effort, unordered, never blocks
     a group"; `lite/datagram.rs`, and the browser `WebTransport` datagram path). An
     Opus frame (≈60–200 bytes) fits the 1200-byte datagram budget comfortably.
   - Investigate whether `@moq/watch`'s audio decoder can consume datagram-delivered
     groups; if yes, publish audio with datagram delivery (client) or have the SFU's
     subscriber role serve audio tracks as datagrams (server, `lite/publisher.rs`).
     Datagrams bypass stream HOL entirely: lost/delayed audio never blocks anything.
   - If the wire/client libs don't support it end-to-end yet, the fallback is a
     separate low-latency QUIC connection (or unidirectional stream priority if a
     future h3 lands `set_priority`) — treat as an epic.

**Acceptance:** during a screen-share + camera + speech test, audio `jitter`/spikes
stop tracking the video bursts; the "spikes hit both incoming streams simultaneously"
signature disappears.

### Step 5 — Fix the h3wt WARN noise (server, trivial)

**Change in `crates/campfire-server/src/moq/h3wt.rs`:**

- `StreamClosed` (and other per-stream terminal states) on `send_stream.write` /
  `recv_stream.read` are expected teardown: log at `debug!`, not `warn!`. Keep `warn!`
  for genuine connection-level errors (`Error::Connection`).
- While there: the `write` loop retries zero-byte sends until capacity; confirm that
  path can't spin hot when the stream is dying (a StreamClosed check before the retry
  would bound it).

**Acceptance:** `grep 'h3wt bridge error' logs | grep -c WARN` goes to ~0 in steady
state; no error is hidden (connection errors still warn).

### Step 6 — Demux socket: batch and de-allocate (server, medium effort)

**Change in `crates/campfire-server/src/demux.rs`:**

- `poll_recv`: drain the whole handoff queue into the `bufs`/`meta` arrays quinn
  provides (batch of N per call instead of 1) — this is the same shape quinn's own
  `UdpSocketPoller` uses with GRO.
- Replace the per-datagram `Vec::to_vec()` allocation with a small recycled buffer
  pool (or store `Bytes`-like chunks), removing one copy: reader task copies kernel
  buffer → pool slot, quinn reads the slot without a second copy.
- Optional, only if profiling still shows contention: multiple reader tasks via
  `SO_REUSEPORT` sharded sockets. Do not do this preemptively.

**Acceptance:** under the 3-party load test, `target/` flamegraphs show the demux hop
out of the hot path; packet-rate ceiling before queue growth rises.

## 3. Explicitly out of scope (for this plan)

- TURN/ICE/WebRTC: the MoQ-only transport is an architecture decision (docs/arch);
  not revisited here.
- Multi-replica SFU or sharding: single-instance is the supported shape.
- Upgrading the h3/h3-quinn line to get real `set_priority`: tracked as the step-4
  fallback, not the first move.
- The moq-net vendor patch: unrelated to latency.

## 4. Measurement protocol

1. Baseline before any change: two tabs local + three clients remote; record per
   downlink `delay`, `jitter`, `bufferedMs` (e2e hooks) plus server log WARN counts.
2. Apply one step, re-run the same scenario, compare.
3. Mouth-to-ear audio latency: record both a beep and the received sound on one
   machine's mic, measure offset (works for local tabs; remote estimate comes from
   `delay` + probe RTT).
4. Keep the deltas in this file's changelog section as results land.

## 5. Implementation status

- **Step 1 — done** (`client/src/call/moq.ts`): `AUDIO_DELAY_MS = 100`,
  `VIDEO_DELAY_MS = 400`, two `Sync` clocks per downlink (audio and video drift
  freely); downlink `delay`/`jitter` in the roster and e2e hooks now report the
  audio clock. Uplink Opus gets `useinbandfec: true`, `packetlossperc: 10`.
- **Step 2 — done** (`deploy/helm/campfire`): `network.kind: hostNetwork` (default)
  runs the pod on the host network stack, Service/IngressRoutes skipped;
  `network.kind: traefik` keeps the old shape.
- **Step 3 — done** (`tls.rs`): BBR congestion controller. Flow-control windows were
  verified against quinn 0.11.19 defaults (connection receive unbounded, stream
  1.25 MiB, send 8 × stream) and left untouched; `send_fairness` is already on.
- **Step 4 — partially done** (`client/src/call/moq.ts`): hard `maxBitrate` caps
  (1.5 Mbps camera, 800 kbps screen). The camera keyframe interval stays at 1 s
  (2 s would risk the T7 fast-start budget). Datagram-delivered audio is blocked:
  neither `@moq/watch` nor `@moq/publish` touches datagrams, and the SFU only
  relays what publishers send — both ends would need patched client libs. Epic.
- **Step 5 — done** (`h3wt.rs`): stream-level errors log at debug, connection-level
  at warn.
- **Step 6 — done** (`demux.rs`): batched `poll_recv` drains the handoff queue into
  quinn's buffer array; queued buffers recycle through a pool inside the same
  mutex (no per-packet allocation, one copy each side).

Remaining follow-ups (not in this pass): the datagram-audio epic (step 4), the
measurement runs of §4 against a real deployment (steps 1–6 are implemented but
their effect is unverified until measured), and the SO_REUSEPORT reader sharding
only if profiling still shows demux contention.

## 6. Audio latency floor (step 7)

Observation after steps 1–3: on a clean local link (two tabs on one machine), audio
still lands at ~100+ ms mouth-to-ear, while the target for near-lossless links is
15–20 ms. The remaining budget is a stack of fixed floors, each verified in the
vendored `@moq` sources:

| Stage | Cost today | Where |
|---|---|---|
| Opus packetization | 20 ms (frame emitted only when full) | `@moq/publish` `frameDuration` default (`pe = 20ms`; allowed: 2.5/5/10/20/40/60) |
| Playback delay target | 100 ms (`AUDIO_DELAY_MS`, fixed) | `moq.ts`; the audio ring **parks** until buffered ≥ the delay target, then plays the whole target behind the live edge — this is the dominant term |
| Ring capacity headroom | 0 extra (capacity 2×delay, but playback sits `delay` behind WRITE) | `@moq/watch` `SharedRingBuffer` (`LATENCY` control = `sync.out.delay`) |
| AudioContext output | ~10–20 ms (`latencyHint: "interactive"`, already minimal) | `@moq/watch` audio decoder |
| Capture + codec + QUIC transport | ~5–10 ms on localhost | AudioWorklet quanta + frame group emission + one-RTT delivery |

With `AUDIO_DELAY_MS = 100`, the observed 100+ ms is the configured floor — same
conclusion as step 1, just at a lower setting. To reach 15–20 ms:

1. **Adaptive audio delay: `delay: "auto"` instead of the fixed 100.**
   `@moq/watch`'s Sync computes `auto` as `max(20 ms, minRTT × 1.25) + rendition
   jitter` from the connection probe — a 20 ms floor exactly on healthy links,
   growing automatically on poor ones. A fixed tiny value (e.g. 15 ms) would
   underrun on any real network; `auto` keeps local at the floor and remote
   calls usable without a config surface. The `Sync.in.buffer` input must become
   a small fixed value (e.g. 50 ms) instead of `2 × AUDIO_DELAY_MS`: it is the
   *backlog* budget (how far ahead of the live edge buffered media may sit), not
   a latency term, and the ring's catch-up drain (already implemented) recovers
   the backlog by playing faster instead of skipping.
2. **Opus `frameDuration: 10` on the uplink encoder.** Halves packetization
   (20 → 10 ms) for 50 frames/s — still trivial bandwidth. 2.5/5 ms exist but
   Chromium's Opus encoder quality collapses and per-frame overhead climbs; 10 ms
   is the sweet spot.
3. **Verification.** Local two-tab beep test (§4 protocol): expect ≈ 20 ms delay
   target + 10 ms packetization + ~15 ms output/capture hardware = 45 ms wall
   mouth-to-ear, with the *adjustable* software budget at ~30 ms. The hardware
   capture/output latency (mic pipeline with `echoCancellation`, speaker buffer)
   is not reachable from the app and bounds the ideal below ~40 ms total.

Note on what "delay" means in the UI after this change: the tile's audio number
drops to ~20–40 ms and the video number stays at 400 ms — the two clocks drift by
design (product decision: audio latency outranks a/v sync), so the a/v divergence
growing from 300 to ~380 ms is expected and acceptable.

Explicitly not in this step: `"instant"` mode (zero delay) — it disables the ring
and pacing entirely; any hiccup is a hard underrun. `auto`'s 20 ms floor is the
cheapest safety margin that meets the target.

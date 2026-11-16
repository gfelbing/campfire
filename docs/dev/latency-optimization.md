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
- **Step 8 — done** (§7 audit): `latencyHint: 0` on both AudioContexts (watch
  decoder + publish capture, via the two vendored patches — new main-chunk
  replacement in moq-watch, new replacement table in moq-publish); audio uplink
  `groupDuration: 50 ms` (per-frame groups closed per 10 ms frame before → 50
  QUIC stream opens/s per subscriber at the SFU, now 10/s). Video needed no
  batching — `Legacy.Producer` groups per keyframe already. Track priority was
  already wired end-to-end (`PRIORITY.audio` 80 > video 60, negotiated in
  TRACK_INFO and honored by the SFU's group-open ordering); the h3wt comment
  claiming "importance degrades to FIFO" was stale and now records the actual
  mechanism.

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
conclusion as step 1, just at a lower setting.

**Decision (supersedes the `"auto"` option below): instant mode.** The original
plan proposed `delay: "auto"` (a 20 ms RTT-derived floor). The user chose true
instant playback instead. Verified against the library, literal
`Sync delay = "instant"` cannot carry audio in `@moq/watch` 0.6.6:

- the audio decoder disables its decode loop entirely and resets the ring when
  `in.delay === "instant"` — silence by construction (the type comment says so:
  *"a ring with no depth underruns, so whoever wants this mode is expected to
  turn audio off"*),
- the postMessage ring (`AudioRingBuffer`, used without `crossOriginIsolated`,
  which is campfire's reality — no COOP/COEP headers) throws on a 0-sample
  latency (`invalid latency` / `empty buffer`),
- the SharedArrayBuffer ring parks forever (`#resume` requires `latency > 0`).

And zero is physically meaningless regardless: the worklet drains in 128-sample
quanta (~2.7 ms), so the smallest floor that exists is one quantum. Implemented
therefore:

- ~~`AUDIO_DELAY_MS = 3`~~ **revised to 20** after a live regression: at a 3 ms
  floor the ring's catch-up drain (`rate = 1 + excess/floor`, capped 2.5×) went
  unstable — the floor sits at roughly one worklet quantum, so any backlog
  spiked the rate to its cap, the playhead outran the arrivals, and every
  subsequent frame was dropped by the ring's `behind` guard. The observable was
  a runaway delay number (1000–2000 ms and climbing): the newest *received*
  frame's timestamp stopped advancing while the playhead ran 2.5× real time.
  The floor must dominate quantum + frame size; 20 ms — two 10 ms frames, and
  exactly the library's `"auto"` floor — keeps the drain gentle (a one-frame
  backlog is rate ≈ 1.5×, decaying). Still sub-perceptual as pacing; the tile's
  audio number should now read ~20–40 ms.
- `frameDuration: 10` on the uplink Opus encoder — packetization 20 → 10 ms.
  (Kept through the 3 ms regression — the instability was the drain rate, not
  the frame size.)
- Accepted trade-off, made explicit: the jitter buffer is thin (~20 ms). A late
  frame beyond it is a hard underrun (the catch-up drain cannot help what has
  not arrived); on lossy links this means gaps instead of drift.
  `packetlossperc`/in-band FEC remains the loss mitigation.

Expected budget after this step: ≈ 10 ms packetization + ≤ 20 ms ring floor +
~15 ms output/capture hardware ≈ 45 ms wall mouth-to-ear on a clean link; the
software-adjustable portion is ~30 ms. The hardware capture/output latency
(mic pipeline with `echoCancellation`, speaker buffer) is not reachable from the
app and bounds the ideal below that.

~~The original `"auto"` proposal~~ (kept for the record): `delay: "auto"` sizes
the jitter buffer from the connection probe (`max(20 ms, minRTT × 1.25) +
rendition jitter`) and would have been the safe choice for lossy networks; it
was rejected in favor of the fixed instant floor above. If remote links turn out
to gap too much, `auto` is the one-line rollback.

## 7. Pipeline audit (step 8)

State after step 7: local two-tab audio mouth-to-ear ≈ 50–100 ms. This is an
end-to-end audit of the a/v pipeline, stage by stage, with what is app-tunable
and what is not. Sources: `@moq/publish` (capture/encoder), the moq-lite wire
(both JS and the vendored `moq-net` SFU), `@moq/watch` (ring/decoder), and the
browser audio stack.

### What is not tunable (bounds)

| Stage | Cost | Why |
|---|---|---|
| Mic pipeline (AEC + NS + AGC) | ~20–40 ms | Chrome processes the mic track before it reaches the app; `echoCancellation` is required (calls play through speakers). Removing it would cause echo for anyone without headphones. |
| AudioContext output buffer | ~10–20 ms | `latencyHint: "interactive"` is already the smallest *stable* hint Chrome honors well. |
| Worklet quanta | 2.7 ms | 128 samples; the granularity everything below inherits. |
| QUIC transport on localhost | ~1 ms/RT | one RTT per flight, negligible. |

### Tunable findings, ranked

1. **AudioContext `latencyHint` → `0`** (two sites: the publish capture context
   and the watch decoder context — both hardcode `"interactive"`).
   `latencyHint: 0` asks Chrome for the minimum output buffer; on many setups it
   shaves 5–10 ms off both capture and playback. Requires extending the vendored
   `patch.mjs` (these sites are in the *main* chunk, not the worklet blob the
   patch currently covers). Reversible per-site; keep a fallback if Chrome
   glitches (audible buffer thrash) on some hardware.

2. **Batch audio groups: `groupDuration: 50 ms` on the uplink audio encoder.**
   Today every 10 ms Opus frame becomes its own group with an immediate close
   (`#v`: `groupDuration = 0` → `c.close()`), and the SFU opens **one QUIC
   unidirectional stream per group** (`poll_open_uni` in the Serve state) —
   50 stream opens + FINs per second per subscriber, each with its own
   priority handle and h3 framing. `groupDuration: 50` batches 5 frames per
   group → 10 streams/s. Verified: the subscriber reads frames from an *open*
   group stream (`readFrame()` loop, frames pushed to the track's `frames`
   signal on write) — batching adds **no** delivery wait, only coarser
   fallback/catch-up granularity (a mid-group catch-up replays up to 50 ms).
   Expected win: a few ms of CPU/scheduling jitter per frame and less FIN/ACK
   churn; the real benefit is stability under load.

3. **Same batching for video: `groupDuration: 100 ms`** (video encoders also
   emit per-frame groups — 30 streams/s at 30 fps). Video is not the priority,
   but this is the same one-line change with the same rationale.

4. **Video delay trim (optional, product decision): `VIDEO_DELAY_MS` 400 →
   200.** The video clock is decoupled from audio, so nothing but visual
   "liveness" is at stake; 400 ms is conservative for the current SFU. Halve it
   only if the ring stays stable — video underruns show as frozen frames, not
   audio gaps.

5. **Track priority: mark the audio rendition higher than video.** moq-net
   carries a `PriorityHandle` per stream (`send_order`); all renditions share
   one tier today, so the SFU interleaves by creation order. With per-frame
   groups after finding 2, giving audio a higher order means a video burst
   queues *behind* audio instead of displacing it — the client-side complement
   of the step-4 bitrate caps. Needs checking what `@moq/net`/moq-lite expose
   per rendition (moq.ts comments say importance degrades to FIFO over the
   current h3 stack — verify whether the lite `priority` parameter is actually
   negotiated on our wire before promising this).

### Explicitly not worth it

- Opus `complexity`/bitrate tuning: CPU-only wins, no latency.
- Dropping `echoCancellation`/`noiseSuppression`: latency win ~20 ms, breaks
  speaker playback for everyone else in the call. No.
- `Sync.wait` threshold (5 ms) and worklet quantum: library/browser constants.
- Demux/BBR (steps 3/6): already done; nothing further visible at 3-party load.

### Order of attack

Findings 1 → 2 → 3 → 5, measuring the beep test after each (§4 protocol).
Expected end state: audio number ~25–40 ms, wall mouth-to-ear ~45–60 ms with
the remainder dominated by the mic pipeline.

## 8. Audio quality: underruns and the bitrate question (step 9)

After step 8 the *speed* was right but the audio played with disruptions —
jitter-buffer underruns, not loss: an arrival gap beyond the ring's depth is
played as silence. Reducing the bitrate was the proposed remedy and is the
wrong lever: the audio stream is ~32–40 kbps (bandwidth was never the
constraint), and Opus's in-band FEC *needs* bitrate headroom — starving it
weakens exactly the loss robustness covering the gaps. Implemented instead,
all four levers:

1. **Ring depth decoupled from the playback floor** (vendored `@moq/watch`
   patch, three sites): `AudioRingBuffer.#capacityFor` and the main-thread
   wrapper's initial capacity (`Math.max(rate, floor × 4)`) and resize path
   grow the buffered ring to **4× the floor** instead of 2×. `Sync.in.buffer`
   = 4 × delay (`BACKLOG_FACTOR = 4`) matches. Playback still sits at the
   floor; the ring just holds ~4× longer arrival bursts, and the catch-up
   drain recovers at up to 2.5×.
2. **Opus bitrate 48 kbps** (stock 32 k): room for the LBRR redundancy layer,
   so `useinbandfec` actually reconstructs lost frames instead of dropping.
3. **`AUDIO_DELAY_MS` 20 → 40**: two frames of depth *and* drain stability
   (see 4) — the +20 ms latency bought deliberately for quality.
4. **`frameDuration` back to 20 ms** (from 10): fewer, larger frames — drain
   ratio per frame `excess/floor = 0.5` (was 1.5), 3× fewer encode/insert/
   publish events at the same `groupDuration` (now 60 ms = 3 frames), gap per
   lost frame 20 ms — reconstructed by FEC with the new bitrate headroom.

Grouped effect on the numbers: ring floor 40 ms, ring depth 160 ms, packet-
ization 20 ms, uplink ~48 kbps + FEC. Expected wall mouth-to-ear ~50–65 ms
(the step-7 win partially traded back for robustness), with underrun
exposure extended from ~40 ms to ~160 ms of arrival jitter. The 10 ms-frame
instant configuration remains documented above if speed is ever again worth
more than continuity.

## 9. A/v sync + video CPU (step 10)

Observation after step 8/9: audio is good, but video visibly trails 1–2 s
behind the sound, while the tile shows "video 400 ms / audio 100 ms". And
CPU spikes accompany video. Two separate root causes.

### 9.1 Why video trails: the indicator measures the wrong clock

`delayOf` computes the per-medium delay from `sync.out.timestamp` — the
**newest received frame's** timestamp (arrival lag + the delay target).
For audio that is ≈ the playout position, because the audio ring's
playback sits only the 40 ms floor behind arrivals. For video it is not:
the video playhead presents frames when the Sync clock passes their
timestamps, and the Sync reference is allowed to trail arrivals by up to
`maxAge` = delay + buffer = 400 + 1600 = **2000 ms** (the 4× backlog
budget from §8). A burst of backlog is *held* (not skipped), played out
gradually — so video playout sits arrival+400 to arrival+2000 behind
live, while the tile's video number (arrival+400) barely moves. The
1–2 s perceived offset is the buffer, invisible in the UI.

Fixes, in order:

1. **Honest indicator**: the video decoder exposes its own playout
   timestamp (`camDecoder.out.timestamp` — the frame being presented,
   the video equivalent of the audio ring's playhead). Compute the
   video delay from it (same wall-clock math as `delayOf`), so the tile
   shows the true playout lag. This alone makes the problem visible.
2. **Tighten the video clock** (the "skipping images" the product wants):
   `VIDEO_DELAY_MS` 400 → 200, and give the video medium its own backlog
   factor: video `Sync.in.buffer` = 2 × delay (maxAge ≈ 600 ms) instead
   of the shared 4×. Beyond ~600 ms of backlog the Sync reference
   re-anchors — stale frames are skipped and the playhead jumps to near
   the live edge. Visible as occasional frame jumps; audio untouched
   (its 4× depth stays, it is the priority).
3. **Test**: extend the e2e step 5b with an a/v-offset assertion — both
   media's playout lags (audio ring playhead, video decoder playout
   timestamp) must agree within 500 ms. The environment's transport lag
   hits both media equally, so their *difference* is the sync metric
   that matters.

### 9.2 CPU spikes: bitrate is the wrong lever

The spikes come from the video pipeline, and reducing the bitrate does
not cut them:

- OpenH264 (the software encoder) ignores bitrate without frame-skip —
  its own warning runs on every configure
  ("bitrate can't be controlled for RC_QUALITY_MODE/RC_BITRATE_MODE
  without enabling skip frame"). A lower `maxBitrate` shrinks the
  transport bursts, not the CPU cost.
- The CPU is driven by pixels × fps on **both ends** (software encode
  AND software decode: 800×600 × 30 fps each way, two tabs), by the
  **keyframe frequency** (1 s GOP: a full-frame burst every second),
  and by the **OpenH264 reinit storm** — dozens of
  `CWelsH264SVCEncoder::Initialize(), reinitialize` warnings per run,
  each a full encoder rebuild. That storm is churn: something mutates
  the catalog or the resolved encoder config repeatedly (auto-sizing
  oscillation against the bandwidth grant, or the periodic catalog
  estimate write — `this.#m.flush()` → `catalog.set(...)` in the
  publish encoder), and every catalog change re-announces the hang,
  re-routes it, and rebuilds the subscriber's encoder.

Fixes, in order:

1. **Shrink the pixel budget** (config, cheap): camera `maxPixels`
   800×600 → 480×360 (−65% pixel work on encode and decode), keep
   30 fps (chat needs lip sync; 24 fps is the fallback lever).
2. **Diagnose the churn** (the real fix): run with the existing
   `E2E_DIAG=1` encoder wrap (logs every `VideoEncoder.configure` with a
   stack) and identify the mutation source. Then patch the vendored
   `@moq/publish`: hysteresis the auto-sizing (only re-resolve when the
   resolved dimensions change by ≥ 25%) and/or debounce the catalog
   estimate write (once per second at most). Both are one-site patches
   in the same file as the existing `stalled` pin.
3. **Keyframe interval** (optional, product trade-off): camera GOP 1 s →
   2 s halves the per-second full-frame burst; costs late-joiner
   fast-start (T7 budget rides the 1 s keyframe). Only if spikes remain
   visible after 1+2.

Explicitly rejected: reducing the *original* stream's bitrate (the
proposal) — see above, it moves bytes around without touching CPU;
the burst pressure is already capped (`maxBitrate` 1.5 M/800 k) and
BBR paces it.

### 9.3 Order

1 (indicator) → 2 (video clock) → e2e a/v-offset assertion → 9.2.1
(pixels) → 9.2.2 (churn diagnosis → patch). Measure each with the e2e
suite + a manual two-tab run.

### 9.4 Implementation status

- **9.1 — done**: both tile numbers are playout-based (audio ring
  playhead / video presented frame); the arrival formula stays as the
  warmup fallback. `VIDEO_DELAY_MS` 400 → 200 with a 2× skip-stale
  backlog (maxAge ≈ 600 ms) — backlog beyond it re-anchors the Sync
  reference, i.e. stale frames are skipped. E2E step 5b asserts the
  a/v offset (|video − audio| playout difference ≤ 500 ms); fresh run:
  248 ms.
- **9.2.1 — done**: camera `maxPixels` 480×360 (−65% pixel work);
  30 fps kept.
- **9.2.2 — done, partially**: the estimate module's catalog writes are
  rate-limited to 1/s and hysteretic (≥ 25% growth) in the vendored
  `@moq/publish` patch — the camera encoder now constructs ONCE per
  call (was: dozens of OpenH264 reinit warnings). Residual: the
  *screen-share* encoder still rebuilds ~10× per share (a different
  churn path — the encode effect re-runs on per-frame signal changes
  and reconfigures with an identical config); screen is not the
  priority, tracked as follow-up.
- **Rejected with data**: bitrate-only reduction — OpenH264 ignores
  bitrate without frame-skip (its own configure warning), so it moves
  bytes without touching CPU; the burst pressure is already capped and
  BBR-paced.

## 10. Join-time spikes (step 11)

Observation: a/v is close and stable in steady state, but the first
10–20 s of a call shows large delay spikes, especially on the audio
number, then everything settles. Steady state is what the previous
steps tuned; the join transient was never designed — several mechanisms
converge at once, each with a *different spike shape*. The shape tells
which mechanism is responsible, so the plan starts with measurement.

### 10.1 Mechanism candidates (ranked, each with its signature)

1. **Decode-loop pacing resets during ring warmup** — most likely for
   the *audio* number. The audio ring parks (STALLED) until the 40 ms
   floor fills; the decode loop's insert pacing waits for the ring
   playhead. The vendored bounded-pacing patch gives that wait a 2 s
   grace, then **resets the ring** (re-anchor at the newest frame). At
   join, the ring is empty/parked for a while (the first groups still
   travel, the AudioContext resumes, the decoder warms up), so the
   2 s grace can fire repeatedly: reset → re-anchor → play a burst →
   park again — the playout delay swings for seconds until every stage
   is warm. Signature: **oscillation** (delay swings up/down every
   ~2 s), `audStalled` flipping, resets visible via `audClock` jumps.
2. **Subscription opens before the Sync budget is final** — the
   media Sources subscribe with `maxAge = sync.out.maxAge`
   (delay + buffer). If the subscription opens while the budget signal
   still carries a different value (the audio override in e2e, or an
   initial "auto" evaluation), the SFU delivers whatever that first
   value allowed and a later SUBSCRIBE_UPDATE has to walk it back —
   backlog already buffered then drains (or drops). Signature:
   **instant high, decaying** (a fixed backlog at anchor time).
3. **Video keyframe hunt contaminating the shared start** — the first
   delivered video group starts at the previous keyframe (up to one GOP
   behind the live edge); the first `received()` anchors the Sync
   reference at that age, and everything after holds until the
   re-anchor logic pulls it in. One-time, decays within the first
   seconds. Signature: video number high *first*, audio following via
   the shared startup churn.
4. **Pipeline warmup, not a buffer problem** — OpenH264's first GOPs
   are slow, the audio decoder's wasm (libav polyfill) compiles on
   first use, the AudioContext starts, the SFU origin is created on the
   first admitted session and its pool/cache fills. For the first
   seconds the *consumer* is slower than real time, so a backlog forms
   that the budget then skips. Signature: **delayed peak** (delay grows
   for a few seconds, then falls to steady state).

### 10.2 Step 1 — measure the shape

**In e2e** (`tools/e2e/moq.js` step 5a, added): after the downlink goes
live, sample `delay`/`videoDelay`/`jitter`/`audClock`/`audBuf`/
`audStalled`/`bufferedMs` every 250 ms for 30 s and print a summary
(max, settle time, ring-reset count). The audio budget override is now
env-controlled: `E2E_AUDIO_MS=0` runs the *production* budget (the
step-5b recording assertions are skipped — the headless environment
cannot hold a live-budget fidelity check; its own delivery variance
makes them flaky).

**Findings from the e2e runs** (both override and production budget):
the curve is a **flat plateau with sporadic bursts, zero ring resets,
zero stalls** — Shape A (pacing resets) is ruled out; the plateau is
the environment's own transport lag plus the override target, and the
bursts are its CPU contention. The e2e environment cannot reproduce the
production startup spike (its audio decode loop starves behind video
decode + software WebGL, trailing seconds *steadily* rather than
spiking at start).

**In production** (the real two-tab setup), run the e2e-built client
(`just e2e-build`, then the dev server serves the embedded debug hooks)
and paste this into the console right after joining the call; call
`__avprobe_stop()` after ~30 s:

```js
(() => {
  const s = []; const t0 = performance.now(); let last = null, resets = 0, stalls = 0;
  window.__avprobe_stop = () => {
    clearInterval(iv);
    const a = s.map((x) => x.a).filter(Number.isFinite);
    console.log("samples", s.length,
      "| start", s[0]?.a, "| max", Math.max(...a, 0),
      "| settled<300ms:", (s.find((x) => x.t >= 5000 && x.a < 300)?.t ?? "never") + "ms",
      "| ring resets", resets, "| stalls", stalls);
    console.log(s.filter((_, i) => i % 8 === 0)
      .map((x) => `${(x.t / 1000).toFixed(1)}s  audio=${x.a}  video=${x.v}  backlog=${x.buf}${x.stall ? "  STALLED" : ""}`)
      .join("\n"));
    window.__avprobe = s;
  };
  const iv = setInterval(() => {
    const h = window.__campfire_moq_down; if (!h) return;
    const d = Object.values(h)[0]; if (!d) return;
    if (last !== null && d.audClock != null && Math.abs(d.audClock - last) > 1000) resets++;
    if (d.audStalled) stalls++;
    last = d.audClock;
    s.push({ t: Math.round(performance.now() - t0), a: Math.round(d.delay), v: Math.round(d.videoDelay), buf: Math.round(d.bufferedMs), stall: d.audStalled });
  }, 250);
  console.log("a/v probe: sampling every 250 ms — call __avprobe_stop() after ~30 s");
})();
```

The curve classifies the mechanism per §10.1: oscillation ~2 s = Shape
A (pacing resets — the vendored-patch fix); instant-high-decaying =
Shape B (stale subscription budget); delayed-peak = Shape D (warmup).
`audio`/`video` are playout positions, `backlog` is the undelivered
span — a backlog that grows *before* the peak and drains after points
at the decode loop (Shape D or CPU starvation), a delay that starts
high and decays monotonically points at the anchor (Shape B/C).

### 10.3 Likely fixes (per shape)

- **Shape A (oscillation, resets)** — the bounded-pacing reset is the
  trigger. Fix in the vendored `@moq/watch` patch: during warmup (no
  anchor yet, or ring length 0 since the last reset), don't count the
  grace from zero repeatedly — anchor on the newest frame immediately
  when the wait expires and the ring is empty (that is what the reset
  does), but suppress the intermediate park/unpark churn by keeping the
  ring stalled until the floor fills *before* releasing the decode
  loop. Concretely: gate the decode loop's insert pacing on
  `!ring.stalled` so it never waits against an empty ring, removing the
  2 s grace path at startup entirely.
- **Shape B (instant high, decaying)** — the subscription opened with a
  stale budget. Fix in the client: wire the Sources' subscribe step to
  wait for the Sync budget to be settled (the budget signal is set in
  the Sync constructor, so this may already be fine — the measurement
  decides), or issue one immediate SUBSCRIBE_UPDATE with the final
  budget right after the subscription opens.
- **Shape C (video first)** — nothing to do if the skip budget keeps
  the total under the a/v offset gate; the 10.3-A fix removes the audio
  swings that make it visible.
- **Shape D (delayed peak)** — warmup work is the cost of entry; the
  budget skips the backlog once it forms. If the peak is large, shrink
  the warmup itself (precompile the libav wasm at page load, defer the
  first video decode until the audio ring is anchored) — only if
  measurement shows it dominates.

### 10.4 Acceptance

- e2e: the new sampling step asserts a settled bound instead of a
  single-shot reading — e.g. within 15 s of the downlink going live,
  audio playout delay < 300 ms and no 2 s-period oscillation (audClock
  monotonic modulo resets).
- Manual: the first seconds of a two-tab call stay within ~300 ms of
  the steady-state numbers; the tile numbers don't swing.


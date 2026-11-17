//! MoQ call session (docs/arch/moq-sfu.md): one session per call,
//! both directions.
//!
//! One `@moq/net` connection on `/moq/{ticket}` carries the uplink (our
//! `call/<room>/<user-id>.hang` broadcast: renditions `v` = camera, `a` =
//! mic, `s` = screen while sharing) and every downlink (one `@moq/watch`
//! pipeline per participant: Broadcast → Video Source/Decoder/Renderer →
//! canvas, and Audio Source/Decoder → a WebAudio graph into the speakers,
//! tapped into a MediaStream for the level meter).
//!
//! Every participant's session is wired into the call's SFU origin
//! (server side, `crates/campfire-server/src/moq/fanout.rs`), so a
//! participant's hang becomes visible in our table as soon as it is
//! announced; the downlinks wait for that announcement before subscribing.
//!
//! Wire note: our h3 stack never negotiates a WebTransport subprotocol
//! (`:protocol` must be exactly `webtransport` or `connect-udp`), so the
//! session's `protocol` is `""` and `@moq/net` takes its browser-compat
//! path: the legacy in-band SETUP exchange, landing on moq-lite-02 — the
//! same wire the Rust spike negotiates. Any non-empty `protocols` list
//! would make Chromium send a `:protocol` the server cannot parse, which
//! drops the CONNECT silently; it must stay absent (`undefined`).

import * as Net from "@moq/net";
import * as Publish from "@moq/publish";
import * as Watch from "@moq/watch";
import { Catalog } from "@moq/hang";
import { Signal } from "@moq/signals";

/** Playback delay behind the live edge, per medium (docs/dev/
 *  latency-optimization.md §6–§9). A fixed offset lets a burst of
 *  frames land in the jitter buffer instead of re-anchoring the clock
 *  mid-burst.
 *
 *  Audio runs in instant mode: 40 ms is the balance point between the
 *  ring's drain stability and playback liveness (§8). Below ~20 ms the
 *  catch-up drain destabilized (3 ms dropped every frame); 20 ms was
 *  still too thin for arrival bursts and played with gaps. 40 ms —
 *  two 20 ms Opus frames — rides out an arrival burst of that size, the
 *  drain ratio per frame is gentle (excess/floor = 0.5), and the ring
 *  has 4× its depth (§8 finding 1) to absorb longer bursts before the
 *  drain recovers at up to 2.5×.
 *
 *  Video trails further (200 ms) — a/v sync is explicitly secondary
 *  (docs/dev/latency-optimization.md), and separate `Sync` clocks mean a
 *  video buffer burst can never hold audio playback back. The tighter
 *  budget is the point (§9.1): backlog beyond it is skipped (the Sync
 *  reference re-anchors), so the video playhead jumps to near the live
 *  edge instead of parking up to 2 s behind it.
 *
 *  Each medium's `Sync.in.buffer` = its backlog factor × its delay.
 *  Audio: 4×, matching the ring's 4× capacity (§8 finding 1) so the
 *  writer never has to drop either. Video: 2×. */
const AUDIO_DELAY_MS = 40;
const VIDEO_DELAY_MS = 200;
/** Backlog budget as a multiple of the delay: audio 4× (matches the
 *  ring's 4× capacity, §8 finding 1); video 2× (skip-stale budget,
 *  §9.1). */
const AUDIO_BACKLOG_FACTOR = 4;
const VIDEO_BACKLOG_FACTOR = 2;

/** Options for one call session. */
export interface MoqCallOpts {
  /** Full `/moq/{ticket}` URL. */
  url: string;
  /** Our broadcast path: `call/<room>/<user-id>.hang`. */
  name: string;
  /** Room name (downlink paths `call/<room>/<peer-id>.hang`). */
  room: string;
  /** The local media to publish (the manager's `localStream`). */
  stream: MediaStream;
  /** Log lines for the call UI. */
  onLog: (text: string) => void;
  /** A participant's audio level (0-255 average of the frequency bins,
   *  10 Hz; the call UI's "speaking" pulse). */
  onLevel?: (id: string, level: number) => void;
  /** A participant's downlink changed state (the manager re-pushes the
   *  roster so the UI tile flips "subscribing…" → "live"). */
  onDownlinkChange?: (id: string, status: DownlinkStatus) => void;
  /** The MoQ session closed unexpectedly (network drop, server close).
   *  Not called for a clean `stop()` — the manager uses it to request a
   *  fresh ticket and restart the media session mid-call. */
  onEnded?: () => void;
}

/** Downlink pipeline status, from the watch broadcast. */
export type DownlinkStatus = "subscribing" | "live" | "offline";

/** What the manager reads per downlink (roster views + debug hook). */
export interface DownlinkView {
  status: DownlinkStatus;
  /** Canvas the camera rendition paints into. */
  canvas: HTMLCanvasElement;
  /** Canvas the screen rendition paints into (blank until the peer shares). */
  screenCanvas: HTMLCanvasElement;
  /** Decoded frames, camera and screen (debug/e2e). */
  frames: number;
  screenFrames: number;
  /** Encoded audio bytes received (debug/e2e). */
  audioBytes: number;
  /** How far playback trails wall-clock time, ms — the **playout**
   *  position (audio ring playhead; what you hear), not the arrival lag:
   *  the old arrival-based number hid the backlog the playhead holds
   *  (docs/dev/latency-optimization.md §9.1). Computed from the root
   *  catalog's `clock` (see `delayOf`), not `out.reference`: the wire
   *  timestamps are the *publisher's* page clock, so `out.reference`
   *  anchors each viewer to its own load time and two tabs of the same
   *  stream disagreed by seconds (observed +5 s vs -4.3 s). Falls back
   *  to the arrival-based formula when the playhead has not started. */
  delay: number;
  /** Same, on the video clock (camera/screen; the presented frame's
   *  timestamp — the video playhead). The two media drift freely by
   *  design; the *difference* of the two numbers is the a/v offset. */
  videoDelay: number;
  /** Jitter buffer depth, ms (audio clock). */
  jitter: number;
  /** Decoded frame resolution, px (0x0 until the first frame). */
  width: number;
  height: number;
}

/** State exposed for the e2e harness (debug hook; the `build:e2e` client
 *  only, C14). */
export interface MoqDebugInfo {
  url: string;
  name: string;
  /** Negotiated wire version (e.g. `moq-lite-02`), once the session is up. */
  version: string | null;
  state: "starting" | "live" | "stopped" | "failed";
  error: string | null;
  /** Last `session.stats()` snapshot plus the derived estimate (bps); the
   *  uplink-scaling check (issues.md "videostreams should scale to
   *  throughput") reads this. `estimate` is what the allocator divides. */
  stats?: {
    estimatedSendRate: number | null;
    bytesSent: number | null;
    estimate: number | null;
  } | null;
  /** Encoder output totals (demand-gated): frozen `aud.bytes` means no
   *  subscriber is attached to the rendition's track, i.e. the uplink
   *  side of the delivery path is dead. */
  enc?: {
    cam: { frames: number; bytes: number } | null;
    aud: { frames: number; bytes: number } | null;
    audActive: boolean | null;
  } | null;
}

/** Per-participant downlink state for the e2e harness (debug hook; the
 *  `build:e2e` client only, C14). */
export interface MoqDownHook {
  status: DownlinkStatus;
  frames: number;
  screenFrames: number;
  audioBytes: number;
  delay: number;
  /** Video playout delay, ms (the presented frame; see DownlinkView) —
   *  the a/v-offset assertion reads the difference of the two. */
  videoDelay: number;
  jitter: number;
  /** Audio ring backlog, ms (the span of buffered media): the catch-up
   *  test watches this drain back to the delay floor after a spike. */
  bufferedMs: number;
  // Diagnostics (step 7 audio-flatline root cause): which rendition each
  // source resolved, and the decoder gate/active states.
  camTrack: string | undefined;
  audTrack: string | undefined;
  audEnabled: boolean;
  audStalled: boolean;
  audRoot: boolean;
  /** AudioContext state ("running"/"suspended"/"closed") of the audio
   *  decoder's context: a suspended context stops the render worklet,
   *  which freezes the ring playhead and the paced decode loop. */
  audCtx: string | null;
  /** The AudioContext's `currentTime` (s): advances while the context
   *  renders (the worklet's process loop is being pulled); frozen means
   *  the context is no longer rendering even though `state` says
   *  "running". */
  audCtxTime: number | null;
  /** Ring playhead, ms (the audio presentation position the decode loop
   *  paces inserts against): frozen while audio is flat. */
  audClock: number | null;
  /** Buffered media ranges on the media timeline (ms), consumer + decoded:
   *  where the undelivered audio sits relative to `audClock`. */
  audBuf: { start: number; end: number }[] | null;
  /** The shared playback clock (ms) and its max-age floor. */
  syncTs: number | null;
  syncMaxAge: number | null;
  mainStatus: string;
  scrStatus: string;
}

declare global {
  interface Window {
    /** E2e diagnostics: how often wireAudio/attachRecorder ran. */
    __campfire_wire_count?: number;
    /** E2e diagnostics: how often wireAudio/attachRecorder ran. */
    __campfire_attach_count?: number;
    /** E2e video-budget override (maxPixels for the camera encoder). */
    __campfire_video_maxpx?: number;
    /** E2e recorder: per-downlink fill-complete flags (see attachRecorder). */
    __campfire_record_done?: Record<string, boolean>;
    __campfire_moq?: MoqDebugInfo;
    __campfire_moq_down?: Record<string, MoqDownHook>;
    /** E2e audio-quality recorder (build:e2e only): set true before the
     *  call to record every wired downlink's decoded audio (moq.ts
     *  attachRecorder); `__campfire_record_ms` caps the sample budget and
     *  `__campfire_audio_ms` overrides the audio playback-delay target
     *  (the e2e environment's transport lag exceeds the production
     *  budget). */
    __campfire_record?: boolean;
    __campfire_record_ms?: number;
    __campfire_audio_ms?: number;
    __campfire_audio_data?: Record<
      string,
      { rate: number; chunks: Float32Array[] }
    >;
    /** The harness's read-out: base64 Float32 samples for one downlink. */
    __campfire_audio_capture?: (
      id: string,
    ) => Promise<{ rate: number; base64: string } | null>;
  }
}

/** Write a patch into the e2e debug hook. No-op in the production bundle
 *  (C14): the hook only exists in the `build:e2e` client. */
function setHook(patch: Partial<MoqDebugInfo>): void {
  if (!__CAMPFIRE_DEBUG__) return;
  window.__campfire_moq = {
    url: "",
    name: "",
    version: null,
    state: "stopped",
    error: null,
    ...window.__campfire_moq,
    ...patch,
  };
}

/** Base64 of an ArrayBuffer without the call-stack limits of
 *  `btoa(String.fromCharCode(...bytes))` (chunked, binary safe). */
function btoaArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    parts.push(
      String.fromCharCode(...bytes.subarray(i, i + 0x8000)),
    );
  }
  return btoa(parts.join(""));
}

/** One participant's downlink pipeline (all handles for teardown). */
interface Downlink {
  id: string;
  broadcast: Watch.Broadcast;
  /** The peer's screen share (its own hang, `*.screen.hang`); null-side
   *  counterpart of the uplink's `screenBroadcast`. */
  scrBroadcast: Watch.Broadcast;
  /** Video playback clock (camera + screen; trails VIDEO_DELAY_MS). */
  sync: Watch.Sync;
  /** Audio playback clock (trails AUDIO_DELAY_MS; deliberately separate
   *  from `sync`, see AUDIO_DELAY_MS — the two media drift freely). */
  audSync: Watch.Sync;
  camSource: Watch.Video.Source;
  camDecoder: Watch.Video.Decoder;
  camRenderer: Watch.Video.Renderer;
  scrSource: Watch.Video.Source;
  scrDecoder: Watch.Video.Decoder;
  scrRenderer: Watch.Video.Renderer;
  audSource: Watch.Audio.Source;
  audDecoder: Watch.Audio.Decoder;
  canvas: HTMLCanvasElement;
  screenCanvas: HTMLCanvasElement;
  /** Audio graph nodes owned by this downlink (recreated on rewiring). */
  nodes: AudioNode[];
  gain: GainNode | null;
  /** Level meter tap (the decoder's own audio context; see wireAudio). */
  analyser: AnalyserNode | null;
  levelData: Uint8Array<ArrayBuffer> | null;
  /** Stall-watchdog state (the re-announce pulse trigger, §10): last
   *  decoded-audio total and the seconds it has been frozen. */
  stallSeconds: number;
  lastAudioBytes: number;
  /** Decode-level stall watchdog: last ring playhead (ms on the media
   *  timeline) and how long it has been frozen. A frozen playhead with
   *  bytes still arriving is the delivery-alive-but-decode-stuck state
   *  (the re-anchor storm: the peer's timeline resets mid-call and the
   *  decode pipeline never re-anchors) — the off→on pulse cannot recover
   *  it, only a full downlink rebuild can (see checkStalls). */
  lastClockMs: number | null;
  clockStallSeconds: number;
  /** How many times this downlink has been rebuilt by the watchdog, and
   *  the wall time of the last rebuild (the flap guard). */
  rebuilds: number;
  lastRebuildAt: number;
  /** E2e recorder tap for this downlink (build:e2e only; re-attached by
   *  wireAudio when the audio graph rewires). */
  recorderProc: ScriptProcessorNode | null;
  /** Silent zone: output muted (the meter keeps showing). */
  muted: boolean;
  /** Last status reported to `onDownlinkChange` (transition guard). */
  lastStatus: DownlinkStatus;
  /** Decoder `enabled` gates, owned here so the re-announce guard can
   *  pulse them off→on to force a re-subscribe (plan 3). */
  camEnabled: Signal<boolean>;
  scrEnabled: Signal<boolean>;
  audEnabled: Signal<boolean>;
  /** Debounce timer for the re-announce pulse; null when none pending. */
  pulseTimer: number | null;
  unsubs: Array<() => void>;
}

/** A live call session: the MoQ connection plus both media directions. */
export class MoqCall {
  /** The negotiated wire version ("" until the session is established). */
  version = "";

  private session: Awaited<ReturnType<typeof Net.Connection.connect>> | null =
    null;
  private origin: Net.Origin.Producer | null = null;
  private broadcast: Publish.Broadcast | null = null;
  /** The uplink hang path without its `.hang` suffix (`call/<room>/<id>`).
   *  The screen share publishes under `<base>.screen.hang` (separate
   *  broadcast: starting/stopping a share must not mutate the camera/mic
   *  hang's catalog — a catalog change re-announces the hang and the SFU
   *  re-routes it, which kills the receivers' existing v/a subscriptions;
   *  issues.md "screenshare broken"). */
  private baseName = "";
  /** Uplink screen broadcast (its own hang, one `s` rendition); null when
   *  not sharing. */
  private screenBroadcast: Publish.Broadcast | null = null;
  private videoCapture: Publish.Video.Capture | null = null;
  private videoEncoder: Publish.Video.Encoder | null = null;
  /** Uplink camera rendition gate (camera off → omitted from the catalog). */
  private videoEnabled: Signal<boolean> | null = null;
  private audioCapture: Publish.Audio.Capture | null = null;
  private audioEncoder: Publish.Audio.Encoder | null = null;
  private screenCapture: Publish.Video.Capture | null = null;
  private screenEncoder: Publish.Video.Encoder | null = null;
  /** Uplink bandwidth estimate (bps, issues.md "videostreams should scale
   *  to throughput"): the congestion controller's `estimatedSendRate`, or
   *  measured `bytesSent` throughput when the browser omits the field
   *  (Chrome gates `getStats()` behind `WebTransportStats`, 573538454).
   *  Feeds the allocator the video encoders reserve against; `undefined`
   *  tells them "no opinion, hold your rate". */
  private estimate = new Signal<number | undefined>(undefined);
  /** Divides the estimate between the camera and screen renditions (both
   *  video kind, one priority tier, max-min fair split). */
  private allocator: Net.Bandwidth.Allocator | null = null;
  /** ~1 Hz poll timer for `session.stats()`; null when the session is down. */
  private statTimer: number | null = null;
  /** Last `bytesSent` sample and its wall-clock time (throughput fallback). */
  private lastBytesSent: number | null = null;
  private lastStatMs: number | null = null;
  private downlinks = new Map<string, Downlink>();
  private room: string;
  private onDownlinkChange?: (id: string, status: DownlinkStatus) => void;
  private onLevel?: (id: string, level: number) => void;
  /** Unexpected session death (the manager restarts with a fresh ticket). */
  private onEnded?: () => void;
  /** 10 Hz level-meter poll (see wireAudio); null when the session is down. */
  private levelTimer: number | null = null;
  private hookTimer: number | null = null;
  /** Stall watchdog (the re-announce pulse trigger), 1 Hz. */
  private stallTimer: number | null = null;
  /** Set by a clean `stop()`: `closed` then reports nothing to `onEnded`. */
  private cleanStop = false;

  private constructor(
    room: string,
    onDownlinkChange?: (id: string, status: DownlinkStatus) => void,
    onLevel?: (id: string, level: number) => void,
    onEnded?: () => void,
  ) {
    this.room = room;
    this.onDownlinkChange = onDownlinkChange;
    this.onLevel = onLevel;
    this.onEnded = onEnded;
  }

  /** Open the session and start the uplink. Rejects if the session cannot
   *  be established or the stream has no usable track. */
  static async start(opts: MoqCallOpts): Promise<MoqCall> {
    const call = new MoqCall(
      opts.room,
      opts.onDownlinkChange,
      opts.onLevel,
      opts.onEnded,
    );
    setHook({ url: opts.url, name: opts.name, version: null, state: "starting", error: null });
    try {
      const origin = new Net.Origin.Producer();
      const table = origin.consume();
      // TS's DOM lib has no `protocols` field, but Chromium sends the list
      // when it is set — and our h3 stack cannot parse it, so it must be
      // absent. `undefined` in the library's options spread removes the
      // default list.
      const webtransport = {
        protocols: undefined,
      } as Net.Connection.ConnectProps["webtransport"];
      // One session, both directions: `publish` serves our origin's
      // broadcasts, `consume` feeds the peer's announced broadcasts (the
      // other participants' hangs) into the same table.
      const session = await Net.Connection.connect({
        url: new URL(opts.url),
        webtransport,
        websocket: { enabled: false },
        // Our SFU announces the call's hangs on the shared per-call
        // origin (the spike relies on the same announcements).
        discovery: true,
        publish: table,
        consume: origin,
      });
      call.session = session;
      call.origin = origin;
      call.version = session.version;
      call.baseName = opts.name.replace(/\.hang$/, "");
      // Uplink scaling (issues.md "videostreams should scale to
      // throughput"): one allocator per session. The camera and screen
      // encoders reserve their bitrate ceilings on it; the ~1 Hz stats
      // poll below feeds it the transport's send-rate estimate, so the
      // two video renditions share the uplink instead of each targeting
      // all of it. Audio is fixed-bitrate and does not reserve.
      const allocator = new Net.Bandwidth.Allocator(call.estimate);
      call.allocator = allocator;

      const broadcast = new Publish.Broadcast({
        origin,
        name: Net.Path.from(opts.name),
        enabled: true,
        announce: true,
      });
      call.broadcast = broadcast;

      const video = opts.stream.getVideoTracks()[0];
      const audio = opts.stream.getAudioTracks()[0];
      if (video) {
        call.buildVideo(video);
      }
      if (audio) {
        call.buildAudio(audio);
      }
      if (!call.videoEncoder && !call.audioEncoder) {
        throw new Error("no video or audio track to publish");
      }

      setHook({ version: session.version, state: "live", error: null });
      opts.onLog(`moq call live (${session.version} → ${opts.name})`);
      // Surface an unexpected session death (network drop, server close);
      // a clean stop() is expected and says nothing.
      void session.closed.then((err) => {
        if (err && call.session === session && !call.cleanStop) {
          opts.onLog(`moq session closed: ${err.message}`);
          call.onEnded?.();
        }
      });
      // Uplink scaling: sample the transport's send-rate estimate at
      // ~1 Hz into the allocator the video encoders reserve against.
      call.startStatsPoll(session);
      // 10 Hz audio-level poll (the call UI's speaking pulse).
      call.startLevelPoll();
      // 1 Hz timer: refreshes the e2e downlink hook only (C14). The UI's
      // status transitions are signal-driven (see addParticipant), so
      // there is nothing to poll in the production bundle.
      if (__CAMPFIRE_DEBUG__) {
        call.refreshDownlinks();
        call.hookTimer = window.setInterval(() => call.refreshDownlinks(), 1000);
        // The audio-quality harness reads recordings back through here
        // (base64 of the Float32 chunk buffers; see attachRecorder). A
        // recording is handed over only when its budget is met — the
        // attachRecorder marks it done; the harness polls.
        window.__campfire_record_done = {};
        window.__campfire_audio_capture = async (id) => {
          if (!window.__campfire_record_done?.[id]) return null;
          const rec = window.__campfire_audio_data?.[id];
          if (!rec || rec.chunks.length === 0) return null;
          const total = rec.chunks.reduce((n, c) => n + c.length, 0);
          const data = new Float32Array(total);
          let at = 0;
          for (const c of rec.chunks) {
            data.set(c, at);
            at += c.length;
          }
          return { rate: rec.rate, base64: btoaArrayBuffer(data.buffer) };
        };
      }
      return call;
    } catch (err) {
      call.stop();
      const msg = String(err);
      setHook({ state: "failed", error: msg });
      throw new Error(`moq call failed: ${msg}`, { cause: err });
    }
  }

  /** Build (or rebuild) the camera capture + encoder for `track` on the
   *  call's broadcast. Config identical across rebuilds — a device swap
   *  must not silently change rendition settings. */
  private buildVideo(track: MediaStreamTrack): void {
    if (!this.broadcast) return;
    const capture = new Publish.Video.Capture({
      source: track as Publish.Video.StreamTrack,
    });
    this.videoCapture = capture;
    const enabled = new Signal(true);
    this.videoEnabled = enabled;
    this.videoEncoder = new Publish.Video.Encoder("v", {
      broadcast: this.broadcast,
      capture,
      enabled,
      // The allocator divides the uplink estimate between the video
      // renditions; the encoder caps its resolved bitrate at the
      // granted slice (advisory: the transport sheds whatever excess
      // slips through).
      bandwidth: this.allocator ?? undefined,
      // A keyframe about every second: a late-joining downlink starts
      // decoding at the next keyframe (fast-start, docs §10 T7).
      config: {
        keyframeInterval: Net.Time.Milli(1000),
        // Auto-sizing bound (the capture is capped at 800x600):
        // nothing above it, so the bandwidth grant has a ceiling to
        // scale down from. 480x360 (§9.2): the software pipeline
        // (OpenH264 encode + WebCodecs decode, both ends) is the CPU
        // driver, and pixels × fps is what it scales with — bitrate
        // alone does not cut it (OpenH264 ignores bitrate without
        // frame-skip). −65% pixel work vs 800x600. The e2e harness
        // overrides this (320x240, see the launch args).
        maxPixels:
          (__CAMPFIRE_DEBUG__ && window.__campfire_video_maxpx) ||
          480 * 360,
        frameRate: 30,
        // Hard bitrate cap (docs/dev/latency-optimization.md §2 step 4):
        // without it a video rendition may claim the entire uplink
        // estimate, and every 1 s keyframe flight then saturates the
        // shared connection's congestion window and stalls the audio
        // streams too. The cap leaves headroom for mic + screen even
        // on a small uplink; the allocator's grant can only go lower.
        maxBitrate: 1_500_000,
      },
    });
  }

  /** Build (or rebuild) the mic capture + encoder for `track` (see
   *  `buildVideo`). */
  private buildAudio(track: MediaStreamTrack): void {
    if (!this.broadcast) return;
    const capture = new Publish.Audio.Capture({
      source: track as Publish.Audio.StreamTrack,
      enabled: true,
    });
    this.audioCapture = capture;
    this.audioEncoder = new Publish.Audio.Encoder("a", {
      broadcast: this.broadcast,
      capture,
      enabled: true,
      // 60 ms of frames per group (3 × 20 ms). The stock default
      // (groupDuration 0) closes a group after every frame, and the
      // SFU opens one QUIC unidirectional stream per group — one
      // stream open + FIN per frame. Batching cuts that 3x. Frames
      // still stream out of the open group as they encode
      // (`readFrame()` on the watch side), so batching adds no
      // delivery wait; it only coarsens catch-up granularity (a
      // mid-group join replays up to 60 ms).
      // (docs/dev/latency-optimization.md §7 finding 2)
      groupDuration: Net.Time.Milli(60),
      // In-band FEC: the audio latency budget (AUDIO_DELAY_MS on the
      // downlink) has no room for retransmission, so a lost frame is
      // lost — FEC lets the decoder reconstruct it from the redundancy
      // of the following frames instead (docs/dev/latency-optimization.md
      // §2 step 1). Costs bitrate; worth it on lossy paths.
      codec: {
        mime: "opus",
        // 20 ms frames: two frames per 40 ms ring floor, gentle drain
        // ratio (excess/floor = 0.5), fewer encode/insert/publish
        // events; a lost frame is a 20 ms gap, reconstructed by FEC
        // (docs/dev/latency-optimization.md §8 finding 4).
        frameDuration: Net.Time.Milli(20),
        // 48 kbps: the stock 32 kbps starved the in-band FEC layer —
        // LBRR redundancy barely fits at 10 ms frames, so "lost"
        // frames were never reconstructed. 48 k gives the redundancy
        // room (docs/dev/latency-optimization.md §8 finding 2).
        bitrate: 48_000,
        useinbandfec: true,
        packetlossperc: 10,
      },
    });
  }

  /** Swap the camera mid-call: tear the capture + encoder down, rebuild
   *  from the new track on the same broadcast. The catalog updates (the
   *  new encoder re-registers the `v` rendition) → re-announce →
   *  receivers' stall watchdog re-subscribes; the canvas keeps its last
   *  frame during the gap. */
  swapVideo(track: MediaStreamTrack, on: boolean): void {
    this.videoEncoder?.close();
    this.videoEncoder = null;
    this.videoCapture?.close();
    this.videoCapture = null;
    this.buildVideo(track);
    // The new encoder gates on its own signal; re-apply the camera
    // toggle so an off camera stays off across the swap.
    this.videoEnabled?.set(on);
  }

  /** Swap the microphone mid-call (see `swapVideo`). */
  swapAudio(track: MediaStreamTrack): void {
    this.audioEncoder?.close();
    this.audioEncoder = null;
    this.audioCapture?.close();
    this.audioCapture = null;
    this.buildAudio(track);
  }

  /** Poll the transport's send-rate estimate into `estimate` at ~1 Hz
   *  (issues.md "videostreams should scale to throughput"). The transport
   *  has no event for the estimate, so it is sampled on a timer, skipping a
   *  tick while the previous snapshot is outstanding (the library's Reload
   *  does the same at 100 ms; 1 Hz is ample for a bitrate grant). Prefers
   *  the congestion controller's `estimatedSendRate`; when the browser
   *  omits it (Chrome gates `WebTransport.getStats()` behind the
   *  `WebTransportStats` runtime flag, Chromium 573538454) it falls back to
   *  measured `bytesSent` throughput — conservative: it reads below
   *  capacity while unsaturated, which keeps the grant tight, never loose.
   *  `getStats()` failures are swallowed by the library (empty snapshot);
   *  the estimate simply holds its last value. */
  private startStatsPoll(session: NonNullable<typeof this.session>): void {
    if (this.statTimer !== null) return;
    let pending = false;
    let samples = 0;
    let withRate = 0;
    let warned = false;
    const sample = async (): Promise<void> => {
      if (pending || this.session !== session) return;
      pending = true;
      try {
        const s = await session.stats();
        if (this.session !== session) return;
        const now = performance.now();
        let est: number | undefined = s.estimatedSendRate;
        if (est === undefined && s.bytesSent !== undefined) {
          if (this.lastBytesSent !== null && this.lastStatMs !== null) {
            const dtMs = now - this.lastStatMs;
            if (dtMs > 0 && s.bytesSent > this.lastBytesSent) {
              est = ((s.bytesSent - this.lastBytesSent) * 8 * 1000) / dtMs;
            }
          }
        }
        if (s.bytesSent !== undefined) this.lastBytesSent = s.bytesSent;
        this.lastStatMs = now;
        if (est !== undefined) this.estimate.set(est);
        samples++;
        if (s.estimatedSendRate !== undefined) withRate++;
        // Decide whether the fallback is in play: after ten samples without
        // the field, say so once (dev loop / e2e read this to confirm which
        // estimate source the test browser provides).
        if (!warned && samples >= 10 && withRate === 0) {
          warned = true;
          if (this.estimate.peek() !== undefined) {
            console.info(
              "campfire: WebTransport stats have no estimatedSendRate; uplink scaling uses measured bytesSent throughput",
            );
          }
        }
        if (__CAMPFIRE_DEBUG__) {
          setHook({
            stats: {
              estimatedSendRate: s.estimatedSendRate ?? null,
              bytesSent: s.bytesSent ?? null,
              estimate: est ?? null,
            },
            enc: {
              cam: this.videoEncoder?.out.stats.peek() ?? null,
              aud: this.audioEncoder?.out.stats.peek() ?? null,
              audActive: this.audioEncoder?.out.active.peek() ?? null,
            },
          });
        }
      } catch {
        // getStats() absent or failing: hold the last estimate.
      } finally {
        pending = false;
      }
    };
    void sample();
    this.statTimer = window.setInterval(() => void sample(), 1000);
  }

  /** Create (or reuse) the downlink pipeline for a participant. The
   *  canvases are created detached; the theater inserts them into tiles. */
  addParticipant(id: string): DownlinkView {
    const existing = this.downlinks.get(id);
    if (existing) return this.viewOf(existing);
    const origin = this.origin!;
    const session = this.session!;
    const broadcast = new Watch.Broadcast({
      origin,
      name: Net.Path.from(`call/${this.room}/${id}.hang`),
      enabled: true,
      // Wait for the call origin's announcement of this hang before
      // subscribing (blind when the relay does not announce).
      announced: true,
    });
    // The peer's screen share rides its own hang (the sender's
    // startScreen publishes `<base>.screen.hang`): watching it here keeps
    // the camera/mic hang's catalog static for the peer's whole share,
    // so no re-announce/re-route touches the v/a subscriptions. Before the
    // peer shares (and after they stop) the hang is unannounced and the
    // source simply never resolves — the screen gate stays off.
    const scrBroadcast = new Watch.Broadcast({
      origin,
      name: Net.Path.from(`call/${this.room}/${id}.screen.hang`),
      enabled: true,
      announced: true,
    });
    // The playback delay is per medium (see AUDIO_DELAY_MS / VIDEO_DELAY_MS);
    // each medium's `buffer` = its backlog factor × its delay. Two clocks:
    // video (camera + screen) and audio, free to drift apart. The e2e
    // audio-quality harness
    // overrides the audio budget (build:e2e only): its environment
    // delivers audio with ~150–200 ms of transport lag — beyond the
    // production 40 ms target, live playback correctly drops frames older
    // than maxAge, and a fidelity recording under that budget would just
    // document the dropping. The override gives the test a buffer that
    // fits its environment; the delay assertion scales with it
    // (tools/e2e/moq.js step 5b).
    const audioDelayTarget =
      (__CAMPFIRE_DEBUG__ && window.__campfire_audio_ms) || AUDIO_DELAY_MS;
    const delaySig = new Signal<Net.Time.Milli>(Net.Time.Milli(VIDEO_DELAY_MS));
    const bufferSig = new Signal<Net.Time.Milli>(
      Net.Time.Milli(VIDEO_DELAY_MS * VIDEO_BACKLOG_FACTOR),
    );
    const sync = new Watch.Sync({
      delay: delaySig,
      buffer: bufferSig,
      probe: session.probe,
    });
    const audDelaySig = new Signal<Net.Time.Milli>(
      Net.Time.Milli(audioDelayTarget),
    );
    const audBufferSig = new Signal<Net.Time.Milli>(
      Net.Time.Milli(audioDelayTarget * AUDIO_BACKLOG_FACTOR),
    );
    const audSync = new Watch.Sync({
      delay: audDelaySig,
      buffer: audBufferSig,
      probe: session.probe,
    });
    const camSource = new Watch.Video.Source({
      broadcast,
      target: { name: "v" },
      supported: Watch.Video.Decoder.supported,
    });
    // The screen source watches the peer's separate screen hang, not the
    // main broadcast: it can never fall back onto the camera rendition,
    // and an unannounced hang simply never resolves (gate stays off).
    const scrSource = new Watch.Video.Source({
      broadcast: scrBroadcast,
      target: { name: "s" },
      supported: Watch.Video.Decoder.supported,
    });
    const audSource = new Watch.Audio.Source({
      broadcast,
      target: { name: "a" },
      supported: Watch.Audio.Decoder.supported,
    });
    // The camera source falls back to the next rendition when the target
    // name is not in the catalog (a peer with the camera off offers no
    // video rendition at all, so this mostly guards a mid-toggle race).
    // Gate each decoder on the track it actually resolved, so only its own
    // rendition is downloaded and rendered.
    const camEnabled = new Signal(false);
    const scrEnabled = new Signal(false);
    // The audio decoder runs on its own enable signal (not a literal
    // true) so the re-announce guard can pulse it: toggling `enabled`
    // off→on re-runs the decoder's subscribe effect, re-subscribing the
    // track on the broadcast's current consumer (issues.md "screenshare
    // broken", plan 3 — the re-announce-proofing).
    const audEnabled = new Signal(true);
    const camDecoder = new Watch.Video.Decoder({
      enabled: camEnabled,
      source: camSource,
      sync,
    });
    const scrDecoder = new Watch.Video.Decoder({
      enabled: scrEnabled,
      source: scrSource,
      sync,
    });
    const audDecoder = new Watch.Audio.Decoder({
      enabled: audEnabled,
      source: audSource,
      sync: audSync,
    });
    const canvas = document.createElement("canvas");
    const screenCanvas = document.createElement("canvas");
    const camRenderer = new Watch.Video.Renderer({
      decoder: camDecoder,
      canvas,
      visible: "always",
    });
    const scrRenderer = new Watch.Video.Renderer({
      decoder: scrDecoder,
      canvas: screenCanvas,
      visible: "always",
    });
    const d: Downlink = {
      id,
      broadcast,
      scrBroadcast,
      sync,
      audSync,
      camSource,
      camDecoder,
      camRenderer,
      scrSource,
      scrDecoder,
      scrRenderer,
      audSource,
      audDecoder,
      canvas,
      screenCanvas,
      nodes: [],
      gain: null,
      analyser: null,
      levelData: null,
      recorderProc: null,
      stallSeconds: 0,
      lastAudioBytes: 0,
      lastClockMs: null,
      clockStallSeconds: 0,
      rebuilds: 0,
      lastRebuildAt: 0,
      muted: false,
      lastStatus: "subscribing",
      camEnabled,
      scrEnabled,
      audEnabled,
      pulseTimer: null,
      unsubs: [],
    };
    // The decoder's context/root are created when the audio rendition
    // resolves; wire them to the speakers (through the silent-zone gain)
    // and a MediaStreamDestination the level meter reads. `subscribe`
    // fires on every change; the initial call covers a root that is
    // already present (normally undefined at this point).
    d.unsubs.push(d.audDecoder.out.root.subscribe(() => this.wireAudio(d)));
    this.wireAudio(d);
    // Initial gate state, then follow the resolved track as the catalog
    // changes (screen share starts/stops, camera toggles).
    d.unsubs.push(
      camSource.out.track.subscribe((t) => camEnabled.set(t === "v")),
      scrSource.out.track.subscribe((t) => scrEnabled.set(t === "s")),
    );
    camEnabled.set(camSource.out.track.peek() === "v");
    scrEnabled.set(scrSource.out.track.peek() === "s");
    // Status transitions drive the UI tile's state label directly from
    // the broadcast's status signal (instant, no polling; the 1 Hz
    // hookTimer below is the e2e client only).
    d.unsubs.push(
      d.broadcast.out.status.subscribe((s) => {
        const next = s === "live" ? "live" : s === "offline" ? "offline" : "subscribing";
        if (next === d.lastStatus) return;
        d.lastStatus = next;
        this.onDownlinkChange?.(id, next);
      }),
    );
    // Re-announce guard (plan 3 → §10): a re-announce re-routes the hang
    // server-side, which kills the existing v/a subscriptions (the track
    // keeps its name, the subscription is dead — the library only
    // re-subscribes on an identity or deep-unequal config change). The
    // original guard watched the catalog and pulsed the three `enabled`
    // gates on every change — but at startup the peer's catalog churns
    // anyway (dimensions settling, estimates), so each warmup re-announce
    // tore the subscriptions down and re-anchored the ring: the
    // join-time spikes. The trigger is now the *symptom*: decoded audio
    // frozen for ≥ 2 s while the broadcast is live → pulse once
    // (cooldown after). Mute does not false-positive (the sender keeps
    // encoding silence frames); camera-off omits the rendition without
    // touching audio.
    // The stall watchdog tick (1 s), one interval for the whole session:
    // addParticipant used to start a fresh interval per downlink (the
    // handle was overwritten, the old one leaked — one leaked 1 Hz tick
    // per participant, each iterating every downlink).
    if (this.stallTimer === null) {
      this.stallTimer = window.setInterval(() => this.checkStalls(), 1000);
    }
    this.downlinks.set(id, d);
    this.refreshDownlinks();
    return this.viewOf(d);
  }

  /** The stall watchdog tick (1 s). Two freezes, two escalations:
   *
   *  1. **Delivery frozen** (no decoded-audio bytes while the broadcast is
   *     live): the re-announce re-route killed the subscription and the
   *     library only re-subscribes on an identity change → pulse the
   *     off→on gates once (cooldown after). The pre-existing recovery.
   *  2. **Decode frozen** (bytes keep arriving, the ring playhead does not
   *     move): the decode pipeline is stuck past its re-anchor (the peer's
   *     timeline reset mid-call — the group counter restarts and the
   *     consumer never admits the new epoch). The pulse only re-subscribes
   *     the same stuck pipeline and demonstrably cannot recover it (3-way
   *     e2e: delay climbs 1 s/s forever), so rebuild the whole downlink:
   *     fresh broadcast, subscription, decoder graph, audio context and
   *     ring. A fresh downlink re-anchors reliably; the canvas element
   *     keeps its identity through the manager's roster push. Cooldown
   *     via `lastRebuildAt` so a stubborn case retries at most once per
   *     5 s instead of flapping. */
  private checkStalls(): void {
    for (const d of this.downlinks.values()) {
      if (this.statusOf(d) !== "live") {
        d.stallSeconds = 0;
        d.lastAudioBytes = 0;
        d.clockStallSeconds = 0;
        d.lastClockMs = null;
        continue;
      }
      // Escalation 2: bytes flow, playhead frozen. Check first: the
      // delivery watchdog below resets its own counters, and a downlink
      // can be in both states in one tick (bytes moved while the ring
      // stayed parked).
      const clock = d.audDecoder.out.timestamp.peek() ?? null;
      if (clock !== null && clock === d.lastClockMs) {
        d.clockStallSeconds++;
        // One decode-stall second of grace: the ring parks briefly on a
        // latency rise or a join anchor; only a parked playhead that
        // outlives the pulse path escalates to a rebuild. The flap guard
        // backs off exponentially per rebuild of this downlink (5 s, 10 s,
        // 20 s … capped at 60 s), so a wedge that comes back keeps the
        // recovery churn bounded instead of rebuilding every 5 s forever.
        if (d.clockStallSeconds >= 2) {
          const now = Date.now();
          const backoff = Math.min(5_000 << Math.min(d.rebuilds, 4), 60_000);
          if (now - d.lastRebuildAt >= backoff) {
            d.rebuilds++;
            d.lastRebuildAt = now;
            d.clockStallSeconds = 0;
            d.lastClockMs = null;
            d.stallSeconds = -2; // also cool the delivery watchdog
            this.rebuildDownlink(d.id);
            continue;
          }
        }
      } else {
        d.clockStallSeconds = 0;
      }
      d.lastClockMs = clock;
      // Escalation 1: delivery frozen → pulse once, and if the pulses
      // don't revive delivery (two failed cycles), rebuild the downlink
      // like the decode-stall path — a dead subscription is a dead
      // pipeline no matter where it wedged (cooldown via the negative
      // count).
      const bytes = d.audDecoder.out.stats.peek()?.bytesReceived ?? 0;
      if (bytes > 0 && bytes === d.lastAudioBytes) {
        d.stallSeconds++;
        if (d.stallSeconds === 2 || d.stallSeconds === 6) {
          d.stallSeconds = -2; // cooldown: no re-pulse for ~4 s
          const now = Date.now();
          const backoff = Math.min(5_000 << Math.min(d.rebuilds, 4), 60_000);
          if (d.stallSeconds === 6 && now - d.lastRebuildAt >= backoff) {
            d.rebuilds++;
            d.lastRebuildAt = now;
            d.clockStallSeconds = 0;
            d.lastClockMs = null;
            this.rebuildDownlink(d.id);
          } else {
            this.schedulePulse(d);
          }
        }
      } else {
        d.stallSeconds = 0;
      }
      d.lastAudioBytes = bytes;
    }
  }

  /** Tear a downlink down and build it back from scratch (the decode-stall
   *  recovery): a fresh Watch.Broadcast, subscription, decoders, audio
   *  context and ring. The silent-zone mute and the UI canvases carry
   *  over: `removeParticipant` drops the old pipeline, `addParticipant`
   *  builds a new one, and the manager's `onPeers` push swaps the fresh
   *  canvases into the tiles. */
  private rebuildDownlink(id: string): void {
    const d = this.downlinks.get(id);
    if (!d) return;
    const muted = d.muted;
    this.removeParticipant(id);
    this.addParticipant(id);
    this.setMuted(id, muted);
    if (__CAMPFIRE_DEBUG__) {
      console.info(`campfire: rebuilt downlink for ${id} (decode stall, rebuild #${d.rebuilds})`);
    }
  }

  /** Remove a participant's downlink (they left the call). */
  removeParticipant(id: string): void {
    const d = this.downlinks.get(id);
    if (!d) return;
    this.downlinks.delete(id);
    this.teardown(d);
    this.refreshDownlinks();
  }

  /** Gate the uplink camera rendition (camera off / auto voice-only: the
   *  rendition is omitted from the catalog, so subscribers stop receiving
   *  video instead of black frames). */
  setVideoEnabled(on: boolean): void {
    this.videoEnabled?.set(on);
  }

  /** Register the screen-share rendition `s` on its **own** hang
   *  (`<base>.screen.hang`, a separate broadcast). Keeping it off the
   *  camera/mic hang is the fix: adding `s` to that hang's catalog would
   *  re-announce it, the SFU would re-route it, and the receivers' existing
   *  `v`/`a` subscriptions would die (issues.md "screenshare broken"). A
   *  distinct hang never mutates the main catalog. The receiver's screen
   *  gate (`scrEnabled`) follows the separate downlink broadcast. */
  startScreen(stream: MediaStream): void {
    if (this.screenEncoder || !this.origin || !this.baseName) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const capture = new Publish.Video.Capture({
      source: track as Publish.Video.StreamTrack,
    });
    this.screenCapture = capture;
    const screen = new Publish.Broadcast({
      origin: this.origin,
      name: Net.Path.from(`${this.baseName}.screen.hang`),
      enabled: true,
      announce: true,
    });
    this.screenBroadcast = screen;
    this.screenEncoder = new Publish.Video.Encoder("s", {
      broadcast: screen,
      capture,
      enabled: true,
      // Shares the uplink estimate with the camera rendition (one
      // allocator, max-min fair split between the two video tracks).
      bandwidth: this.allocator ?? undefined,
      config: {
        // Screen content compresses well and its join is not the
        // camera's fast-start path (issues.md §10 T7 budget rides the
        // 1 s camera keyframe): 2 s keyframes halve the per-second
        // full-frame cost of what is usually a large, quiet surface.
        keyframeInterval: Net.Time.Milli(2000),
        // Screen capture targets 15 fps (media.ts); bound it so the
        // auto-sizing and the bandwidth grant have a ceiling.
        frameRate: 15,
        // Bitrate cap, same rationale as the camera's (a screen burst
        // must not eat the shared window the audio streams need).
        maxBitrate: 800_000,
      },
    });
  }

  /** Unregister the screen rendition: close its hang so the SFU stops
   *  routing it and the receivers' screen gates go idle (no re-announce on
   *  the main hang). */
  stopScreen(): void {
    this.screenEncoder?.close();
    this.screenEncoder = null;
    this.screenCapture?.close();
    this.screenCapture = null;
    this.screenBroadcast?.close();
    this.screenBroadcast = null;
  }

  /** Silent zone (README roadmap "Map enhancements"): mute this
   *  participant's output locally; the level meter keeps showing. */
  setMuted(id: string, on: boolean): void {
    const d = this.downlinks.get(id);
    if (!d) return;
    d.muted = on;
    if (d.gain) d.gain.gain.value = on ? 0 : 1;
  }

  /** Current state of a downlink, or null when none is wired. */
  view(id: string): DownlinkView | null {
    const d = this.downlinks.get(id);
    return d ? this.viewOf(d) : null;
  }

  /** The participant ids that currently have a downlink. */
  participantIds(): string[] {
    return [...this.downlinks.keys()];
  }

  /** Whether a downlink is wired for the participant. */
  hasParticipant(id: string): boolean {
    return this.downlinks.has(id);
  }

  /** Tear everything down and close the session. Idempotent. */
  stop(): void {
    this.cleanStop = true;
    for (const d of [...this.downlinks.values()]) {
      this.downlinks.delete(d.id);
      this.teardown(d);
    }
    this.screenEncoder?.close();
    this.screenEncoder = null;
    this.screenCapture?.close();
    this.screenCapture = null;
    this.screenBroadcast?.close();
    this.screenBroadcast = null;
    this.videoEncoder?.close();
    this.videoEncoder = null;
    this.videoCapture?.close();
    this.videoCapture = null;
    this.audioEncoder?.close();
    this.audioEncoder = null;
    this.audioCapture?.close();
    this.audioCapture = null;
    this.broadcast?.close();
    this.broadcast = null;
    this.session?.close();
    this.session = null;
    this.origin?.close();
    this.origin = null;
    this.version = "";
    if (this.hookTimer !== null) {
      window.clearInterval(this.hookTimer);
      this.hookTimer = null;
    }
    if (this.statTimer !== null) {
      window.clearInterval(this.statTimer);
      this.statTimer = null;
    }
    if (this.levelTimer !== null) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    if (this.stallTimer !== null) {
      window.clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    this.allocator?.close();
    this.allocator = null;
    this.estimate.set(undefined);
    this.lastBytesSent = null;
    this.lastStatMs = null;
    if (__CAMPFIRE_DEBUG__) window.__campfire_moq_down = {};
    setHook({ state: "stopped" });
  }

  /** (Re)wire the downlink's audio graph to the current decoder context:
   *  speakers (through the silent-zone gain) plus an analyser tap for the
   *  level meter. The tap sits before the gain, so a silent zone mutes
   *  the output while the meter keeps showing.
   *  Note: the library creates one `AudioContext` per audio decoder (the
   *  same is true for `<moq-watch>`); past the browser's context limit
   *  new ones start suspended — the `resume` below reactivates them,
   *  which the join gesture permits. */
  private wireAudio(d: Downlink): void {
    const ctx = d.audDecoder.out.context.peek();
    const root = d.audDecoder.out.root.peek();
    for (const n of d.nodes) {
      try {
        n.disconnect();
      } catch {
        // the context already went away with the nodes
      }
    }
    d.nodes = [];
    d.gain = null;
    d.analyser = null;
    d.levelData = null;
    if (!ctx || !root) return;
    // Browsers suspend AudioContexts until a user gesture has occurred;
    // the call was entered by walking (a gesture), but ask anyway.
    void ctx.resume().catch(() => {});
    const gain = ctx.createGain();
    gain.gain.value = d.muted ? 0 : 1;
    gain.connect(ctx.destination);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    root.connect(gain);
    root.connect(analyser);
    d.nodes = [gain, analyser];
    d.gain = gain;
    d.analyser = analyser;
    d.levelData = new Uint8Array(analyser.frequencyBinCount);
    if (__CAMPFIRE_DEBUG__) {
      try {
        this.attachRecorder(d, ctx, root);
      } catch (e) {
        // The recorder must never break the audio graph: a bug there
        // would surface as audio flatline, not a test failure.
        console.warn(`[recorder] attach failed: ${e}`);
      }
    }
  }

  /** E2e audio-quality recorder (the `build:e2e` client only; the audio
   *  intelligibility test in tools/e2e/moq.js drives it): when the page
   *  sets `window.__campfire_record = true`, tap this downlink's decoder
   *  root through a ScriptProcessor and accumulate PCM until the sample
   *  budget is met (default 8 s), then `window.__campfire_audio_capture(
   *  id)` hands `{rate, base64}` to the harness. Re-attached on every
   *  `wireAudio` (the re-announce pulse rebuilds the audio graph, and a
   *  recorder left on the old root would silently stop filling);
   *  accumulated samples live in the page hook, so they survive a
   *  downlink teardown. Inert in the production bundle. */
  private attachRecorder(d: Downlink, ctx: AudioContext, root: AudioNode): void {
    if (!window.__campfire_record || !window.__campfire_audio_data) return;
    window.__campfire_wire_count = (window.__campfire_wire_count ?? 0) + 1;
    window.__campfire_attach_count = (window.__campfire_attach_count ?? 0) + 1;
    const maxSamples = Math.ceil(
      (ctx.sampleRate * (window.__campfire_record_ms ?? 8000)) / 1000,
    );
    const store = window.__campfire_audio_data[d.id];
    if (store) {
      const filled = store.chunks.reduce((n, c) => n + c.length, 0);
      if (filled >= maxSamples) return; // done
    } else {
      window.__campfire_audio_data[d.id] = {
        rate: ctx.sampleRate,
        chunks: [],
      };
    }
    let proc = d.recorderProc;
    // The decoder rebuilds its AudioContext on a rewire; a tap from the
    // old context cannot connect to the new root (cross-context connect
    // throws) — drop it and make a fresh one. Its already-recorded
    // samples live in the page-hook store.
    if (proc && proc.context !== ctx) {
      try {
        proc.disconnect();
      } catch {
        // the old context already went away
      }
      proc = null;
      d.recorderProc = null;
    }
    if (!proc) {
      // ScriptProcessorNode is deprecated but exactly right here: an
      // audio-worklet would need the module-source dance, and this is
      // the debug build only. Pushed onto d.nodes, so a rewire
      // disconnects it and the re-attach below reconnects it.
      proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => {
        const self = d.recorderProc;
        if (!self) return;
        const s = window.__campfire_audio_data?.[d.id];
        if (!s) return;
        const filled = s.chunks.reduce((n, c) => n + c.length, 0);
        if (filled >= maxSamples) return;
        s.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        const now = s.chunks.reduce((n, c) => n + c.length, 0);
        if (now >= maxSamples) {
          self.onaudioprocess = null;
          window.__campfire_record_done![d.id] = true;
          try {
            self.disconnect(ctx.destination);
          } catch {
            // already gone with the context
          }
        }
      };
      d.recorderProc = proc;
      root.connect(proc);
      proc.connect(ctx.destination);
      d.nodes.push(proc);
    } else {
      // Re-attach to the new root (the rewire above disconnected it).
      try {
        proc.disconnect();
      } catch {
        // already gone with the context
      }
      root.connect(proc);
      proc.connect(ctx.destination);
    }
  }

  /** Push each participant's audio level (0-255, the average of the
   *  analyser's frequency bins) to the UI at 10 Hz. Runs while the
   *  session is up; downlinks without a wired audio graph are skipped. */
  private startLevelPoll(): void {
    if (this.levelTimer !== null) return;
    this.levelTimer = window.setInterval(() => {
      for (const [id, d] of this.downlinks) {
        const a = d.analyser;
        const data = d.levelData;
        if (!a || !data) continue;
        a.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        this.onLevel?.(id, sum / data.length);
      }
    }, 100);
  }

  /** Debounce the re-announce pulse: a re-route surfaces as several
   *  catalog/consumer changes in a short window; one pulse is enough. */
  private schedulePulse(d: Downlink): void {
    // BISECT (audio-flatline root cause): the harness can disable the
    // pulse entirely to test whether the re-route alone kills the audio.
    if (
      (globalThis as { __CAMPFIRE_NOPULSE__?: boolean }).__CAMPFIRE_NOPULSE__
    )
      return;
    if (d.pulseTimer !== null) window.clearTimeout(d.pulseTimer);
    d.pulseTimer = window.setTimeout(() => {
      d.pulseTimer = null;
      this.pulseDownlink(d);
    }, 250);
  }

  /** Force the downlink's subscriptions to re-open on the broadcast's
   *  current consumer (the re-announce guard, plan 3). Toggle the decoder
   *  `enabled` gates off, then restore them on the next macrotask — the
   *  off→on edge re-runs each decoder's subscribe effect, which closes the
   *  (dead) subscription and re-subscribes the same track. The off window
   *  is covered by the playback buffer (audio keeps playing) and the
   *  canvas keeps its last frame. Audio is pulsed only when its track is
   *  actually resolved, so a pulse racing the first settle can't strand
   *  the audio gate off. */
  private pulseDownlink(d: Downlink): void {
    if (this.downlinks.get(d.id) !== d) return; // torn down meanwhile
    d.camEnabled.set(false);
    d.scrEnabled.set(false);
    if (d.audSource.out.track.peek() === "a") d.audEnabled.set(false);
    window.setTimeout(() => {
      if (this.downlinks.get(d.id) !== d) return;
      d.camEnabled.set(d.camSource.out.track.peek() === "v");
      d.scrEnabled.set(d.scrSource.out.track.peek() === "s");
      d.audEnabled.set(true);
    }, 100);
  }

  private teardown(d: Downlink): void {
    if (d.pulseTimer !== null) {
      window.clearTimeout(d.pulseTimer);
      d.pulseTimer = null;
    }
    for (const u of d.unsubs) u();
    d.unsubs = [];
    d.camRenderer.close();
    d.scrRenderer.close();
    d.camDecoder.close();
    d.scrDecoder.close();
    d.audDecoder.close();
    d.camSource.close();
    d.scrSource.close();
    d.audSource.close();
    for (const n of d.nodes) {
      try {
        n.disconnect();
      } catch {
        // already gone
      }
    }
    d.nodes = [];
    d.analyser = null;
    d.levelData = null;
    d.recorderProc = null;
    d.sync.close();
    d.audSync.close();
    d.broadcast.close();
    d.scrBroadcast.close();
  }

  /** Playback delay behind the live edge, ms, on the given medium's clock
   *  (audio: the conversational metric — see AUDIO_DELAY_MS; video: the
   *  camera/screen clock — see VIDEO_DELAY_MS). The wire media timestamps
   *  are the publisher's `performance.now()` (page uptime), so
   *  `out.reference` (viewer-now minus frame-ts) bakes in the offset
   *  between the two pages' load times. The root catalog carries the
   *  real mapping instead: `clock.wall` is PTS zero in `timescale` units
   *  since the moq epoch, so a frame's wall time is `wall + timestamp`,
   *  directly comparable to our own wall clock
   *  (`performance.timeOrigin - moq epoch + performance.now()`).
   *  Falls back to the clockless formula when the catalog or the
   *  timestamp has not arrived yet.
   *
   *  Playout vs arrival: the Sync timestamp is the newest *received*
   *  frame (arrival lag + the delay target) — for audio ≈ the playout
   *  position (the ring plays only the floor behind arrivals), but for
   *  video the playhead may trail arrivals by up to the whole backlog
   *  budget, which the arrival number hides. When the decoder exposes a
   *  playout timestamp (audio ring playhead / video presented frame),
   *  the delay is computed from it instead — the number then says how
   *  far what you *see/hear* trails live (docs/dev/latency-optimization.md
   *  §9.1). */
  private delayOf(d: Downlink, sync: Watch.Sync, playoutTs?: number | null): number {
    const fallback = () =>
      Number(sync.out.reference.peek() ?? 0) + Number(sync.out.delay.peek());
    const ts = playoutTs ?? sync.out.timestamp.peek();
    if (ts === undefined) return fallback();
    const clock = d.broadcast.out.catalog.peek()?.clock;
    if (!clock) return fallback();
    const frameWallMs = (clock.wall / clock.timescale) * 1000 + Number(ts);
    const nowWallMs =
      performance.timeOrigin - Catalog.MOQ_EPOCH_UNIX_MILLIS + performance.now();
    // Playout timestamp: how far the presented media trails the live edge,
    // full stop — the delay target is already inside the playhead position,
    // adding it again would double-count.
    if (playoutTs !== undefined && playoutTs !== null) {
      return nowWallMs - frameWallMs;
    }
    return nowWallMs - frameWallMs + Number(sync.out.delay.peek());
  }

  private viewOf(d: Downlink): DownlinkView {
    return {
      status: this.statusOf(d),
      canvas: d.canvas,
      screenCanvas: d.screenCanvas,
      frames: d.camDecoder.out.stats.peek()?.frameCount ?? 0,
      screenFrames: d.scrDecoder.out.stats.peek()?.frameCount ?? 0,
      audioBytes: d.audDecoder.out.stats.peek()?.bytesReceived ?? 0,
      delay: this.delayOf(d, d.audSync, d.audDecoder.out.timestamp.peek()),
      videoDelay: this.delayOf(d, d.sync, d.camDecoder.out.timestamp.peek()),
      jitter: Number(d.audSync.out.jitter.peek()),
      width: d.canvas.width,
      height: d.canvas.height,
    };
  }

  private statusOf(d: Downlink): DownlinkStatus {
    switch (d.broadcast.out.status.peek()) {
      case "live":
        return "live";
      case "offline":
        return "offline";
      default:
        return "subscribing";
    }
  }

  /** Refresh the e2e downlink hook (the `build:e2e` client only, C14).
   *  Production is signal-driven (see addParticipant) and never calls
   *  this. */
  private refreshDownlinks(): void {
    if (!__CAMPFIRE_DEBUG__) return;
    const down: Record<string, MoqDownHook> = {};
    for (const [id, d] of this.downlinks) {
      const v = this.viewOf(d);
      down[id] = {
          status: v.status,
          frames: v.frames,
          screenFrames: v.screenFrames,
          audioBytes: v.audioBytes,
          delay: v.delay,
          videoDelay: v.videoDelay,
          jitter: v.jitter,
          bufferedMs: this.bufferedMsOf(d),
          camTrack: d.camSource.out.track.peek(),
          audTrack: d.audSource.out.track.peek(),
          audEnabled: d.audEnabled.peek(),
          audStalled: d.audDecoder.out.stalled.peek(),
          audRoot: d.audDecoder.out.root.peek() !== undefined,
          audCtx: d.audDecoder.out.context.peek()?.state ?? null,
          audCtxTime: d.audDecoder.out.context.peek()?.currentTime ?? null,
          audClock: d.audDecoder.out.timestamp.peek() ?? null,
          audBuf: d.audDecoder.out.buffered.peek() ?? null,
          syncTs: d.audDecoder.sync.out.timestamp.peek() ?? null,
          syncMaxAge: d.audDecoder.sync.out.maxAge.peek() ?? null,
          mainStatus: d.broadcast.out.status.peek(),
          scrStatus: d.scrBroadcast.out.status.peek(),
      };
    }
    window.__campfire_moq_down = down;
  }

  /** The audio ring's backlog in ms: the total span of buffered media.
   *  E2e/diagnostic only (the catch-up test asserts it drains back to the
   *  delay floor after a spike). */
  private bufferedMsOf(d: Downlink): number {
    let ms = 0;
    for (const r of d.audDecoder.out.buffered.peek() ?? []) ms += r.end - r.start;
    return ms;
  }
}

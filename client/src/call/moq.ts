//! MoQ call session (docs/moq-sfu.md §9, Phases 2–3): one session per call,
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

/** Catch-up (issues.md "skipping when falling behind"): playback enters a
 *  call 1 s behind the live edge, so the initial burst of frames lands in
 *  the jitter buffer instead of re-anchoring the clock mid-burst. After
 *  the stability window the delay shrinks to the steady value;
 *  `Sync.wait` wakes on the change (the bundle watches
 *  `in.delay.changed`), so the shrink takes effect live and the ring
 *  resize on shrink keeps the newest samples. */
const ENTRY_DELAY_MS = 300;
const STEADY_DELAY_MS = 300;
/** How long the entry delay is held: long enough for a slow start to
 *  settle, short enough to be unnoticeable. */
const ENTRY_WINDOW_MS = 5000;
/** Backlog budget as a multiple of the delay: `Sync.in.buffer` = 2 ×
 *  delay, which switches the audio ring into buffered mode (no read skip,
 *  capacity 2 × delay) and grows the transport `maxAge` so a backlog
 *  reaches the ring instead of being dropped. The invariant
 *  `buffer ≤ 2 × delay` keeps the backlog inside the ring capacity, so
 *  the writer never has to drop either. */
const BACKLOG_FACTOR = 2;

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
  /** A participant's downlink changed state (the manager re-pushes the
   *  roster so the UI tile flips "subscribing…" → "live"). */
  onDownlinkChange?: (id: string, status: DownlinkStatus) => void;
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
  /** The downlink's audio as a MediaStream (level meter), once the audio
   *  pipeline is up. */
  stream: MediaStream | null;
  /** Decoded frames, camera and screen (debug/e2e). */
  frames: number;
  screenFrames: number;
  /** Encoded audio bytes received (debug/e2e). */
  audioBytes: number;
  /** How far playback trails wall-clock time, ms: the latest media's
   *  arrival lag behind the live edge plus the sync target (`out.delay`).
   *  Both move with the network — a fixed target (`in.delay`) alone would
   *  sit flat. Computed from the root catalog's `clock` (see
   *  `delayOf`), not `out.reference`: the wire timestamps are the
   *  *publisher's* page clock, so `out.reference` anchors each viewer to
   *  its own load time and two tabs of the same stream disagreed by
   *  seconds (observed +5 s vs -4.3 s). */
  delay: number;
  /** Jitter buffer depth, ms. */
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
    __campfire_moq?: MoqDebugInfo;
    __campfire_moq_down?: Record<string, MoqDownHook>;
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

/** One participant's downlink pipeline (all handles for teardown). */
interface Downlink {
  id: string;
  broadcast: Watch.Broadcast;
  /** The peer's screen share (its own hang, `*.screen.hang`); null-side
   *  counterpart of the uplink's `screenBroadcast`. */
  scrBroadcast: Watch.Broadcast;
  sync: Watch.Sync;
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
  meterStream: MediaStream | null;
  /** Silent zone: output muted (the meter keeps showing). */
  muted: boolean;
  /** Last status reported to `onDownlinkChange` (transition guard). */
  lastStatus: DownlinkStatus;
  /** Entry-delay ramp (see ENTRY_DELAY_MS): the signals driving
   *  `sync.in.delay` / `sync.in.buffer`, and whether the shrink to the
   *  steady value already happened. */
  delaySig: Signal<Net.Time.Milli>;
  bufferSig: Signal<Net.Time.Milli>;
  /** When the downlink was created (the entry window's start). */
  bornMs: number;
  /** True once the entry delay shrank to STEADY_DELAY_MS (one-shot). */
  steady: boolean;
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
  private hookTimer: number | null = null;

  private constructor(room: string, onDownlinkChange?: (id: string, status: DownlinkStatus) => void) {
    this.room = room;
    this.onDownlinkChange = onDownlinkChange;
  }

  /** Open the session and start the uplink. Rejects if the session cannot
   *  be established or the stream has no usable track. */
  static async start(opts: MoqCallOpts): Promise<MoqCall> {
    const call = new MoqCall(opts.room, opts.onDownlinkChange);
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
        const capture = new Publish.Video.Capture({
          source: video as Publish.Video.StreamTrack,
        });
        call.videoCapture = capture;
        const enabled = new Signal(true);
        call.videoEnabled = enabled;
        call.videoEncoder = new Publish.Video.Encoder("v", {
          broadcast,
          capture,
          enabled,
          // The allocator divides the uplink estimate between the video
          // renditions; the encoder caps its resolved bitrate at the
          // granted slice (advisory: the transport sheds whatever excess
          // slips through).
          bandwidth: allocator,
          // A keyframe about every second: a late-joining downlink starts
          // decoding at the next keyframe (fast-start, docs §10 T7).
          config: {
            keyframeInterval: Net.Time.Milli(1000),
            // Auto-sizing bound (the capture is capped at 800x600):
            // nothing above it, so the bandwidth grant has a ceiling to
            // scale down from.
            maxPixels: 800 * 600,
            frameRate: 30,
          },
        });
      }
      if (audio) {
        const capture = new Publish.Audio.Capture({
          source: audio as Publish.Audio.StreamTrack,
          enabled: true,
        });
        call.audioCapture = capture;
        call.audioEncoder = new Publish.Audio.Encoder("a", {
          broadcast,
          capture,
          enabled: true,
          codec: "opus",
        });
      }
      if (!call.videoEncoder && !call.audioEncoder) {
        throw new Error("no video or audio track to publish");
      }

      setHook({ version: session.version, state: "live", error: null });
      opts.onLog(`moq call live (${session.version} → ${opts.name})`);
      // Surface an unexpected session death (network drop, server close);
      // a clean stop() is expected and says nothing.
      void session.closed.then((err) => {
        if (err && call.session === session) {
          opts.onLog(`moq session closed: ${err.message}`);
        }
      });
      // Uplink scaling: sample the transport's send-rate estimate at
      // ~1 Hz into the allocator the video encoders reserve against.
      call.startStatsPoll(session);
      // 1 Hz timer: refreshes the e2e downlink hook (gated by the debug
      // flag) and polls downlink status for the UI tile's state label.
      call.refreshDownlinks();
      call.hookTimer = window.setInterval(() => call.refreshDownlinks(), 1000);
      return call;
    } catch (err) {
      call.stop();
      const msg = String(err);
      setHook({ state: "failed", error: msg });
      throw new Error(`moq call failed: ${msg}`, { cause: err });
    }
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
    // The playback delay is driven, not fixed: a 1 s entry delay (see
    // ENTRY_DELAY_MS) shrinks to the steady value after the stability
    // window in `refreshDownlinks`. `buffer` = 2 × delay keeps the
    // backlog budget inside the ring capacity (see BACKLOG_FACTOR).
    const delaySig = new Signal<Net.Time.Milli>(Net.Time.Milli(ENTRY_DELAY_MS));
    const bufferSig = new Signal<Net.Time.Milli>(
      Net.Time.Milli(ENTRY_DELAY_MS * BACKLOG_FACTOR),
    );
    const sync = new Watch.Sync({
      delay: delaySig,
      buffer: bufferSig,
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
      sync,
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
      meterStream: null,
      muted: false,
      lastStatus: "subscribing",
      delaySig,
      bufferSig,
      bornMs: performance.now(),
      steady: false,
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
    // Re-announce guard (plan 3): the main hang can be re-announced while
    // the peer stays in the call (their session reloads, or the SFU
    // re-routes it), which re-routes the hang server-side and kills the
    // existing v/a subscriptions. The library only re-subscribes when the
    // active consumer's identity or a deep-unequal config changes; a
    // same-content re-announce changes neither, so the track keeps its
    // name but the subscription is dead. Watching the catalog and the
    // active consumer and pulsing the three `enabled` gates off→on forces
    // each decoder's subscribe effect to re-run, re-subscribing the same
    // track on the current consumer (the canvas keeps its last frame; the
    // off window is covered by the playback buffer). The first change of
    // each signal is the initial load, not a re-announce, so it is
    // skipped.
    let catalogFirst = true;
    let activeFirst = true;
    d.unsubs.push(
      d.broadcast.out.catalog.subscribe(() => {
        if (catalogFirst) {
          catalogFirst = false;
          return;
        }
        this.schedulePulse(d);
      }),
      d.broadcast.out.active.subscribe(() => {
        if (activeFirst) {
          activeFirst = false;
          return;
        }
        this.schedulePulse(d);
      }),
    );
    this.downlinks.set(id, d);
    this.refreshDownlinks();
    return this.viewOf(d);
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
        keyframeInterval: Net.Time.Milli(1000),
        // Screen capture targets 15 fps (media.ts); bound it so the
        // auto-sizing and the bandwidth grant have a ceiling.
        frameRate: 15,
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
    this.allocator?.close();
    this.allocator = null;
    this.estimate.set(undefined);
    this.lastBytesSent = null;
    this.lastStatMs = null;
    if (__CAMPFIRE_DEBUG__) window.__campfire_moq_down = {};
    setHook({ state: "stopped" });
  }

  /** (Re)wire the downlink's audio graph to the current decoder context.
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
    d.meterStream = null;
    if (!ctx || !root) return;
    // Browsers suspend AudioContexts until a user gesture has occurred;
    // the call was entered by walking (a gesture), but ask anyway.
    void ctx.resume().catch(() => {});
    const gain = ctx.createGain();
    gain.gain.value = d.muted ? 0 : 1;
    gain.connect(ctx.destination);
    const meter = ctx.createMediaStreamDestination();
    root.connect(gain);
    root.connect(meter);
    d.nodes = [gain, meter];
    d.gain = gain;
    d.meterStream = meter.stream;
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
    d.sync.close();
    d.broadcast.close();
    d.scrBroadcast.close();
  }

  /** Playback delay behind the live edge, ms. The wire media timestamps
   *  are the publisher's `performance.now()` (page uptime), so
   *  `out.reference` (viewer-now minus frame-ts) bakes in the offset
   *  between the two pages' load times. The root catalog carries the
   *  real mapping instead: `clock.wall` is PTS zero in `timescale` units
   *  since the moq epoch, so a frame's wall time is `wall + timestamp`,
   *  directly comparable to our own wall clock
   *  (`performance.timeOrigin - moq epoch + performance.now()`).
   *  Falls back to the clockless formula when the catalog or the
   *  timestamp has not arrived yet. */
  private delayOf(d: Downlink): number {
    const fallback = () =>
      Number(d.sync.out.reference.peek() ?? 0) + Number(d.sync.out.delay.peek());
    const ts = d.sync.out.timestamp.peek();
    if (ts === undefined) return fallback();
    const clock = d.broadcast.out.catalog.peek()?.clock;
    if (!clock) return fallback();
    const frameWallMs = (clock.wall / clock.timescale) * 1000 + Number(ts);
    const nowWallMs =
      performance.timeOrigin - Catalog.MOQ_EPOCH_UNIX_MILLIS + performance.now();
    return nowWallMs - frameWallMs + Number(d.sync.out.delay.peek());
  }

  private viewOf(d: Downlink): DownlinkView {
    return {
      status: this.statusOf(d),
      canvas: d.canvas,
      screenCanvas: d.screenCanvas,
      stream: d.meterStream,
      frames: d.camDecoder.out.stats.peek()?.frameCount ?? 0,
      screenFrames: d.scrDecoder.out.stats.peek()?.frameCount ?? 0,
      audioBytes: d.audDecoder.out.stats.peek()?.bytesReceived ?? 0,
      delay: this.delayOf(d),
      jitter: Number(d.sync.out.jitter.peek()),
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

  /** Poll downlink state once: notify the manager on a status transition
   *  (it re-pushes the roster so the UI tile's state label updates) and,
   *  in the e2e client only, refresh the `__campfire_moq_down` hook
   *  (C14). */
  private refreshDownlinks(): void {
    const down: Record<string, MoqDownHook> = {};
    const now = performance.now();
    for (const [id, d] of this.downlinks) {
      // Entry-delay ramp (one-shot): once the stability window has passed
      // and the downlink is actually live, shrink the delay — and its 2×
      // backlog budget — to the steady value. `Sync.wait` wakes on the
      // delay change, so the shrink applies to the running playback clock
      // immediately (no re-subscribe).
      if (
        !d.steady &&
        now - d.bornMs >= ENTRY_WINDOW_MS &&
        d.broadcast.out.status.peek() === "live"
      ) {
        d.steady = true;
        d.delaySig.update(() => Net.Time.Milli(STEADY_DELAY_MS));
        d.bufferSig.update(() => Net.Time.Milli(STEADY_DELAY_MS * BACKLOG_FACTOR));
      }
      const v = this.viewOf(d);
      if (__CAMPFIRE_DEBUG__) {
        down[id] = {
          status: v.status,
          frames: v.frames,
          screenFrames: v.screenFrames,
          audioBytes: v.audioBytes,
          delay: v.delay,
          jitter: v.jitter,
          bufferedMs: this.bufferedMsOf(d),
          camTrack: d.camSource.out.track.peek(),
          audTrack: d.audSource.out.track.peek(),
          audEnabled: d.audEnabled.peek(),
          audStalled: d.audDecoder.out.stalled.peek(),
          audRoot: d.audDecoder.out.root.peek() !== undefined,
          audCtx: d.audDecoder.out.context.peek()?.state ?? null,
          audClock: d.audDecoder.out.timestamp.peek() ?? null,
          audBuf: d.audDecoder.out.buffered.peek() ?? null,
          syncTs: d.audDecoder.sync.out.timestamp.peek() ?? null,
          syncMaxAge: d.audDecoder.sync.out.maxAge.peek() ?? null,
          mainStatus: d.broadcast.out.status.peek(),
          scrStatus: d.scrBroadcast.out.status.peek(),
        };
      }
      // Notify the manager on a status transition (it re-pushes the
      // roster so the UI tile's state label updates).
      if (v.status !== d.lastStatus) {
        d.lastStatus = v.status;
        this.onDownlinkChange?.(id, v.status);
      }
    }
    if (__CAMPFIRE_DEBUG__) window.__campfire_moq_down = down;
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

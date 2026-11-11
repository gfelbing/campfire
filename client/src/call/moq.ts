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
import { Signal } from "@moq/signals";

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
  /** Playback delay from the live edge, ms (the latency budget lives here). */
  delay: number;
  /** Jitter buffer depth, ms. */
  jitter: number;
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
  private videoCapture: Publish.Video.Capture | null = null;
  private videoEncoder: Publish.Video.Encoder | null = null;
  /** Uplink camera rendition gate (camera off → omitted from the catalog). */
  private videoEnabled: Signal<boolean> | null = null;
  private audioCapture: Publish.Audio.Capture | null = null;
  private audioEncoder: Publish.Audio.Encoder | null = null;
  private screenCapture: Publish.Video.Capture | null = null;
  private screenEncoder: Publish.Video.Encoder | null = null;
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
          // A keyframe about every second: a late-joining downlink starts
          // decoding at the next keyframe (fast-start, docs §10 T7).
          config: { keyframeInterval: Net.Time.Milli(1000) },
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
    const sync = new Watch.Sync({
      delay: "auto",
      probe: session.probe,
    });
    const camSource = new Watch.Video.Source({
      broadcast,
      target: { name: "v" },
      supported: Watch.Video.Decoder.supported,
    });
    const scrSource = new Watch.Video.Source({
      broadcast,
      target: { name: "s" },
      supported: Watch.Video.Decoder.supported,
    });
    const audSource = new Watch.Audio.Source({
      broadcast,
      target: { name: "a" },
      supported: Watch.Audio.Decoder.supported,
    });
    // The sources fall back to the next rendition when the target name is
    // not in the catalog (the screen source would decode the camera while
    // the peer does not share; the camera source a peer's screen while
    // their camera is off). Gate each decoder on the track it actually
    // resolved, so only its own rendition is downloaded and rendered.
    const camEnabled = new Signal(false);
    const scrEnabled = new Signal(false);
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
      enabled: true,
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

  /** Register the screen-share rendition `s` (the catalog picks it up at
   *  the next encoder tick; subscribers see it immediately). */
  startScreen(stream: MediaStream): void {
    if (this.screenEncoder || !this.broadcast) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const capture = new Publish.Video.Capture({
      source: track as Publish.Video.StreamTrack,
    });
    this.screenCapture = capture;
    this.screenEncoder = new Publish.Video.Encoder("s", {
      broadcast: this.broadcast,
      capture,
      enabled: true,
      config: { keyframeInterval: Net.Time.Milli(1000) },
    });
  }

  /** Unregister the screen rendition (closes its active tracks). */
  stopScreen(): void {
    this.screenEncoder?.close();
    this.screenEncoder = null;
    this.screenCapture?.close();
    this.screenCapture = null;
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

  private teardown(d: Downlink): void {
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
      delay: Number(d.sync.out.delay.peek()),
      jitter: Number(d.sync.out.jitter.peek()),
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
    for (const [id, d] of this.downlinks) {
      const v = this.viewOf(d);
      if (__CAMPFIRE_DEBUG__) {
        down[id] = {
          status: v.status,
          frames: v.frames,
          screenFrames: v.screenFrames,
          audioBytes: v.audioBytes,
          delay: v.delay,
          jitter: v.jitter,
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
}

//! MoQ uplink (docs/moq-sfu.md §9, Phase 2): publish the local media to
//! the SFU as a MoQ broadcast that subscribers can watch.
//!
//! One uplink per call entry: a session is opened on `/moq?ticket=…`
//! (the ticket is the owner's bearer, checked once at CONNECT admission),
//! the `call/<room>/<user-id>.hang` broadcast is announced, and the
//! manager's `localStream` tracks are encoded into it (track `v` = camera,
//! `a` = mic). The manager owns the lifecycle: start on `enterCall` /
//! `rejoinCall`, stop on `reset`.
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

/** Options for one uplink session. */
export interface MoqUplinkOpts {
  /** Full `/moq?ticket=…` URL. */
  url: string;
  /** Broadcast path: `call/<room>/<user-id>.hang` (@moq/hang convention). */
  name: string;
  /** The local media to publish (the manager's `localStream`). */
  stream: MediaStream;
  /** Log lines for the call UI. */
  onLog: (text: string) => void;
}

/** State exposed for the e2e harness and the dev loop (debug hook). */
export interface MoqDebugInfo {
  url: string;
  name: string;
  /** Negotiated wire version (e.g. `moq-lite-02`), once the session is up. */
  version: string | null;
  state: "starting" | "live" | "stopped" | "failed";
  error: string | null;
}

declare global {
  interface Window {
    __campfire_moq?: MoqDebugInfo;
  }
}

function setHook(patch: Partial<MoqDebugInfo>): void {
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

/** A live uplink: the MoQ session plus its capture/encode pipeline. */
export class MoqUplink {
  /** The negotiated wire version ("" until the session is established). */
  version = "";

  private session: Awaited<ReturnType<typeof Net.Connection.connect>> | null =
    null;
  private origin: Net.Origin.Producer | null = null;
  private broadcast: Publish.Broadcast | null = null;
  private videoCapture: Publish.Video.Capture | null = null;
  private videoEncoder: Publish.Video.Encoder | null = null;
  private audioCapture: Publish.Audio.Capture | null = null;
  private audioEncoder: Publish.Audio.Encoder | null = null;

  private constructor() {}

  /** Open the session and start encoding. Rejects if the session cannot
   *  be established or the stream has no usable track. */
  static async start(opts: MoqUplinkOpts): Promise<MoqUplink> {
    const uplink = new MoqUplink();
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
      const session = await Net.Connection.connect({
        url: new URL(opts.url),
        webtransport,
        websocket: { enabled: false },
        publish: table,
      });
      uplink.origin = origin;
      uplink.session = session;
      uplink.version = session.version;

      const broadcast = new Publish.Broadcast({
        origin,
        name: Net.Path.from(opts.name),
        enabled: true,
        announce: true,
      });
      uplink.broadcast = broadcast;

      const video = opts.stream.getVideoTracks()[0];
      const audio = opts.stream.getAudioTracks()[0];
      if (video) {
        const capture = new Publish.Video.Capture({
          source: video as Publish.Video.StreamTrack,
        });
        uplink.videoCapture = capture;
        uplink.videoEncoder = new Publish.Video.Encoder("v", {
          broadcast,
          capture,
          enabled: true,
        });
      }
      if (audio) {
        const capture = new Publish.Audio.Capture({
          source: audio as Publish.Audio.StreamTrack,
          enabled: true,
        });
        uplink.audioCapture = capture;
        uplink.audioEncoder = new Publish.Audio.Encoder("a", {
          broadcast,
          capture,
          enabled: true,
          codec: "opus",
        });
      }
      if (!uplink.videoEncoder && !uplink.audioEncoder) {
        throw new Error("no video or audio track to publish");
      }

      setHook({ version: session.version, state: "live", error: null });
      opts.onLog(
        `moq uplink live (${session.version} → ${opts.name})`,
      );
      // Surface an unexpected session death (network drop, server close);
      // a clean stop() is expected and says nothing.
      void session.closed.then((err) => {
        if (err && uplink.session === session) {
          opts.onLog(`moq session closed: ${err.message}`);
        }
      });
      return uplink;
    } catch (err) {
      uplink.stop();
      const msg = String(err);
      setHook({ state: "failed", error: msg });
      throw new Error(`moq uplink failed: ${msg}`);
    }
  }

  /** Tear the pipeline down and close the session. Idempotent. */
  stop(): void {
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
    setHook({ state: "stopped" });
  }
}

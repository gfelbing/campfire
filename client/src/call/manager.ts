//! Proximity-call state machine — "bubbles" (docs/arch/protocol.md).
//!
//! Media is one MoQ SFU session per call (docs/arch/moq-sfu.md): the client
//! publishes its own `call/<room>/<user-id>.hang` (the uplink) and watches
//! one downlink per other participant. There is no mesh and no signaling —
//! the server's bubble engine computes the call, and every participant's
//! media transits the SFU (Phase 4 removed the WebRTC signaling messages).
//!
//! Call *state* (`call_start` / `call_leave` / `call_end`) is room-wide: it
//! powers the avatars' headphone badge, so a bystander hears it too.
//!
//! Joining is automatic: the server pulls nearby avatars into a bubble and
//! the client asks for the mic (`getUserMedia`) on the first auto-join —
//! walking close is the user's intent. A user can opt out entirely with
//! the bubble toggle (`sendBubble`).
import type { UserBrief } from "../net/types";
import { MoqCall, type DownlinkStatus, type DownlinkView } from "./moq";
import { getLocalMedia, getScreenMedia, loadMediaPrefs, saveMediaPrefs, type MediaPrefs } from "./media";
import { Denoiser } from "./denoiser";

/** Participant count at which the call degrades to voice-only (docs/ops/maps.md:
 *  "9+"; the done-when's "engages at 10" is satisfied, the 📷 button
 *  overrides back to video). */
const VOICE_ONLY_AT = 9;

export type CallPhase =
  | { p: "idle" }
  /** Media is being acquired for an auto-join. */
  | { p: "joining" }
  | { p: "in-call"; participants: UserBrief[] };

/** A participant's downlink state (docs/arch/protocol.md: "subscribing…/live"). */
export type DownlinkState = DownlinkStatus;

/** One remote participant as the UI needs it (grid tile). */
export interface PeerView {
  id: string;
  name: string;
  /** The camera downlink's paint target (the SFU renders into it). */
  camera: HTMLCanvasElement | null;
  /** The screen-share downlink's paint target (only while they share). */
  screen: HTMLCanvasElement | null;
  state: DownlinkState;
  /** Downlink playback delay from the live edge, ms (0 while no downlink).
   *  Audio clock — the conversational metric. */
  delay: number;
  /** Same on the video clock (the two `Sync` instances drift freely by
   *  design — see moq.ts AUDIO_DELAY_MS / VIDEO_DELAY_MS). */
  delayVideo: number;
  /** Downlink jitter buffer depth, ms (0 while no downlink). */
  jitter: number;
  /** Decoded camera-frame resolution, px (0x0 until the first frame). */
  width: number;
  height: number;
  /** Presence from `call_mute` (default on). */
  audioOn: boolean;
  videoOn: boolean;
  /** Presence from `call_screen`: the peer is sharing their screen. */
  screenOn: boolean;
  /** Transport RTT (ms) of our signaling connection, or `null` when
   *  unsupported (SSE fallback, or no `WebTransport.getStats()`). Same
   *  value on every tile — it is our connection's RTT, a proxy for the
   *  path to the SFU, shown next to each downlink's e2e delay. */
  rtt: number | null;
}

/** What the manager tells the UI. */
export interface CallUiHooks {
  onPhase: (phase: CallPhase) => void;
  /** Local media acquired (for the PiP video) or released. */
  onLocalStream: (stream: MediaStream | null) => void;
  /** Full roster of remote participants (grid rebuild/update). */
  onPeers: (peers: PeerView[]) => void;
  /** A peer's audio level (0-255 average, 10 Hz; the "speaking" pulse). */
  onPeerLevel: (id: string, level: number) => void;
  /** Our own mute/camera state changed (button styling). */
  onLocalMute: (audio: boolean, video: boolean) => void;
  /** Our screen share started/stopped (button styling). */
  onLocalScreen: (on: boolean) => void;
  /** A local log/system line (errors, connection issues). */
  onLog: (text: string) => void;
  /** Bubble notification sound: `"enter"` on entering, `"leave"` on leaving. */
  onCallSound: (sound: "enter" | "leave") => void;
}

/** The signaling surface the manager needs (implemented by `Connection`). */
export interface CallSignaling {
  /** Opt out of bubbles (or back in with false). */
  sendBubble(off: boolean): void;
  sendCallMute(audio: boolean, video: boolean): void;
  sendCallScreen(on: boolean): void;
  sendCallLeave(): void;
  /** Ask the server for a fresh media ticket (docs/arch/moq-sfu.md): the
   *  reply arrives as `onTicket`. The media session asks when it dies
   *  mid-call — its original ticket is single-use and a stable roster
   *  sends no new `call_start`. */
  requestTicket(): void;
  /** Transport RTT in ms (the `/wt` QUIC connection), `null` when the
   *  transport can't measure it (SSE fallback, or no `getStats()`). */
  getRtt(): Promise<number | null>;
}

export class CallManager {
  phase: CallPhase = { p: "idle" };
  /** Our mute/camera state. These are user preferences (the top-bar 🎤/📷
   *  buttons work outside a call too): they persist across calls, are
   *  applied to freshly acquired media, and are announced to the call on
   *  entry via `call_mute`. */
  audioOn = true;
  videoOn = true;
  /** True while `videoOn` is false because of the auto voice-only
   *  degradation (not the user's 📷 button): leaving the call restores
   *  video, an explicit camera-off does not. */
  private autoVoicedOff = false;
  /** True while the camera video track carries our screen. */
  screenOn = false;

  private selfId = "";
  /** Per-participant `call_mute`/`call_screen` presence. */
  private presence = new Map<string, { audio: boolean; video: boolean; screen: boolean }>();
  /** Our screen share (when `screenOn`). */
  private screenStream: MediaStream | null = null;
  /** The persisted media preferences (device selection + noise
   *  suppression; the topbar dropdowns). */
  private mediaPrefs = loadMediaPrefs();
  /** `sz` (README roadmap "Map enhancements"): peers inside a silentZone. */
  private silent = new Set<string>();
  /** The call roster including ourselves (from `call_start`/`call_join`). */
  private roster: UserBrief[] = [];
  private localStream: MediaStream | null = null;
  /** The raw mic track (before the noise-gate chain): mute toggles and
   *  `getSettings().deviceId` read this — the processed track the
   *  publisher sees reports no device and ignores `enabled`. */
  private micRaw: MediaStreamTrack | null = null;
  /** The uplink noise-gate chain (null: the gate could not load — the
   *  raw track rides straight through). */
  private denoiser: Denoiser | null = null;
  /** The one MoQ session for the current call (uplink + downlinks). */
  private moq: MoqCall | null = null;
  /** Monotonic guard for in-flight session starts (a reset must not let a
   *  late start attach). */
  private sessionSeq = 0;
  /** 1 s refresh of the tiles' latency labels while in the call (the
   *  downlink delay and the transport RTT move on their own, not with
   *  roster events). */
  private statsTimer: number | null = null;
  /** Last measured transport RTT (ms), or `null` when unsupported. */
  private rtt: number | null = null;
  /** Room name (broadcast path `call/<room>/<user-id>.hang`). */
  private room: string;

  constructor(
    private send: CallSignaling,
    private hooks: CallUiHooks,
    room: string,
  ) {
    this.room = room;
    // Graceful close (README): on a hard page close (tab closed / navigated
    // away, not a bfcache hide) stop the MoQ media session so its QUIC
    // connection ends with a clean close. The `/moq` connection is a second
    // socket the OS drops without a QUIC close on tab close, so without this
    // the server only notices the session ended via its idle timeout. The
    // room-level `leave` is sent by `Connection`'s own pagehide hook; this
    // covers the media connection.
    window.addEventListener("pagehide", (e) => {
      if (!(e as PageTransitionEvent).persisted) this.stopMediaSession();
    });
  }

  /** Our own user id (from `hello`). */
  setSelfId(id: string): void {
    this.selfId = id;
  }

  /** Whether we are currently in a call. */
  inCall(): boolean {
    return this.phase.p === "in-call";
  }

  /** Stop the MoQ media session (idempotent). Exposed for the pagehide
   *  graceful-close hook: a clean session close beats waiting out the
   *  server's idle timeout on a dropped second QUIC socket. */
  stopMediaSession(): void {
    this.stopSession();
  }

  // --- user actions ---------------------------------------------------------

  /** Opt out of proximity bubbles (docs/arch/protocol.md): the server drops us from
   *  the current bubble at once and never pulls us back in. */
  setBubble(off: boolean): void {
    this.send.sendBubble(off);
  }

  /** Presence status changed (the profile menu, or auto-away):
   *  `away` = calls auto-join muted (mic + camera off); `online` = normal
   *  calls (mic + camera on); `dnd` = opt out of bubbles entirely. The
   *  live tracks follow where applicable, and an in-call mute is
   *  re-announced. The 🎤/📷 button prefs are restored by `online`. */
  setStatus(status: "online" | "away" | "dnd"): void {
    if (status === "dnd") {
      this.send.sendBubble(true);
      return;
    }
    this.send.sendBubble(false);
    const want = status === "online";
    if (this.audioOn !== want || this.videoOn !== want) {
      this.audioOn = want;
      this.videoOn = want;
      this.autoVoicedOff = false;
      // Mute rides the RAW mic track: the processed track comes from an
      // AudioContext destination and ignores `enabled`.
      if (this.micRaw) this.micRaw.enabled = want;
      for (const t of this.localStream?.getVideoTracks() ?? []) t.enabled = want;
      this.moq?.setVideoEnabled(want);
      if (this.phase.p === "in-call") this.send.sendCallMute(want, want);
      this.hooks.onLocalMute(want, want);
    }
  }

  /** Hang up: leave the current bubble (the server dissolves it when ≤ 1
   *  participant remains). */
  hangup(): void {
    this.send.sendCallLeave();
    this.reset();
  }

  toggleMute(): void {
    this.audioOn = !this.audioOn;
    // Disable the local track: the uplink encodes silence and the PiP
    // reflects it too. No stream yet (the top-bar button outside a call):
    // acquireMedia applies the preference when a call starts. Mute rides
    // the RAW mic track — the processed track (an AudioContext
    // destination) ignores `enabled`, the raw capture goes silent, and
    // the gate sees silence end to end.
    if (this.micRaw) this.micRaw.enabled = this.audioOn;
    if (this.phase.p === "in-call") this.send.sendCallMute(this.audioOn, this.videoOn);
    this.hooks.onLocalMute(this.audioOn, this.videoOn);
  }

  toggleCamera(): void {
    this.videoOn = !this.videoOn;
    this.autoVoicedOff = false;
    for (const t of this.localStream?.getVideoTracks() ?? []) t.enabled = this.videoOn;
    // Omit the uplink's video rendition so subscribers stop receiving
    // black frames rather than a stream of them.
    this.moq?.setVideoEnabled(this.videoOn);
    if (this.phase.p === "in-call") this.send.sendCallMute(this.audioOn, this.videoOn);
    this.hooks.onLocalMute(this.audioOn, this.videoOn);
  }

  /** Screen share (README roadmap "UI redesign"): the screen rides as a
   *  third uplink rendition (`s`) — the camera keeps flowing, so others
   *  see BOTH streams. The 🖥 badge on the other side comes from the
   *  `call_screen` presence, which reveals their screen downlink canvas. */
  toggleScreen(): void {
    if (this.phase.p !== "in-call") return;
    if (this.screenOn) {
      this.stopScreenShare();
      return;
    }
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await getScreenMedia();
      } catch {
        // user dismissed the picker (or it is unavailable): no share
        return;
      }
      if (this.phase.p !== "in-call") {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.screenStream = stream;
      const track = stream.getVideoTracks()[0];
      // The browser's own "stop sharing" button ends the track: share off.
      track?.addEventListener("ended", () => {
        if (this.screenOn) this.stopScreenShare();
      });
      this.moq?.startScreen(stream);
      this.screenOn = true;
      this.send.sendCallScreen(true);
      this.hooks.onLocalScreen(true);
      this.hooks.onLog("screen share started");
    })();
  }

  /** Unregister the uplink's screen rendition and release the capture. */
  private stopScreenShare(): void {
    if (!this.screenOn) return;
    this.screenOn = false;
    this.moq?.stopScreen();
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.send.sendCallScreen(false);
    this.hooks.onLocalScreen(false);
    this.hooks.onLog("screen share stopped");
  }

  // --- server messages (docs/arch/protocol.md) ------------------------------------------

  /** Room-wide (headphone badge) and, when we are in the roster, our
   *  authoritative bubble state: created or joined (auto-join on approach,
   *  docs/arch/protocol.md), or a roster re-sync while we are already in. */
  onCallStart(participants: UserBrief[], ticket?: string): void {
    const selfIn = participants.some((u) => u.id === this.selfId);
    if (!selfIn) {
      // Bystander: badge only (the avatar layer reads the roster from
      // main.ts's `onCallStart`); nothing to do here.
      return;
    }
    if (this.phase.p === "in-call") {
      // Re-sync: a newcomer joined. Open a downlink for anyone we do not
      // have one to once the session is up.
      this.roster = participants;
      this.syncDownlinks();
      this.maybeAutoVoiceOnly();
      // The roster re-broadcast carries a fresh media ticket. If our MoQ
      // session is not up — it was never started (a ticketless catch-up
      // `call_start` entered the call), or it died (the uplink aborted, a
      // dropped QUIC connection that outlived the 30 s reconnect grace,
      // the reload race) — (re)start it with the fresh ticket. A live
      // session is kept: restarting it would tear down every peer's
      // downlink to us for nothing.
      if (ticket && !this.moq) this.startSession(ticket);
      this.pushPeers();
      return;
    }
    if (this.phase.p !== "idle") return;
    // Auto-join: the server pulled us into a bubble. `getUserMedia` here —
    // walking close is the user's intent (docs/arch/protocol.md relaxed prompt).
    this.setPhase({ p: "joining" });
    void (async () => {
      const stream = await this.acquireMedia();
      if (!stream) {
        // No media, no call: leave so the server does not keep our seat
        // open with a silent ghost (docs/arch/protocol.md).
        this.send.sendCallLeave();
        this.reset();
        return;
      }
      this.enterCall(participants, ticket);
    })();
  }

  /** A participant left (room-wide; includes us, for our own badge). */
  onCallLeave(id: string): void {
    if (this.phase.p !== "in-call") return;
    if (id === this.selfId) {
      this.hooks.onCallSound("leave");
      this.reset("you left the call");
      return;
    }
    this.roster = this.roster.filter((u) => u.id !== id);
    this.presence.delete(id);
    this.silent.delete(id);
    this.syncDownlinks();
    this.pushPeers();
    // If we are the last one left the server sends `call_end`.
  }

  /** The room's call ended (room-wide). */
  onCallEnd(reason: string): void {
    if (this.phase.p === "idle") return;
    // Leave sound only if we had actually entered: an in-flight rejoin
    // ("joining") never did, and a self `call_leave` that reached us
    // first already played its own (its reset made us "idle").
    if (this.phase.p === "in-call") this.hooks.onCallSound("leave");
    this.reset(`call ended (${reason})`);
  }

  /** Reconnect-with-token (docs/arch/protocol.md): the `hello` after a dropped
   *  connection (or a tab refresh) says the room's call survived and we
   *  are still in it. The MoQ session died with the old connection, so it
   *  is torn down and re-established with the fresh ticket. A refresh
   *  loses `localStream`, so the media is re-acquired (the mic permission
   *  was granted on the original join, so no new prompt). */
  async rejoinCall(participants: UserBrief[], ticket?: string): Promise<void> {
    if (this.phase.p === "joining") {
      // An auto-join is already in flight (media prompt open): let it
      // finish with its own ticket (tickets are valid for 30 s).
      this.roster = participants;
      return;
    }
    if (!this.localStream) {
      // "joining" also blocks a `call_start` catch-up from starting a
      // second auto-join (and a second prompt) while this one is open.
      this.setPhase({ p: "joining" });
      const stream = await this.acquireMedia();
      if (!stream) {
        this.hooks.onLog("call ended while you were disconnected");
        this.reset();
        return;
      }
    }
    this.stopSession();
    this.roster = participants;
    const others = participants.filter((u) => u.id !== this.selfId);
    this.setPhase({ p: "in-call", participants: others });
    this.maybeAutoVoiceOnly();
    // Re-announce our mute/camera state on the fresh connection.
    this.send.sendCallMute(this.audioOn, this.videoOn);
    this.pushPeers();
    this.hooks.onLog("rejoined the call");
    this.startSession(ticket);
  }

  /** Presence only (call-scoped; the server does not echo it to us). */
  onCallMute(id: string, audio: boolean, video: boolean): void {
    if (id === this.selfId) return;
    const cur = this.presence.get(id) ?? { audio: true, video: true, screen: false };
    this.presence.set(id, { ...cur, audio, video });
    this.pushPeers();
  }

  /** Presence only (call-scoped): a peer started/stopped screen sharing.
   *  Reveals (or hides) that peer's screen downlink canvas in the UI. */
  onCallScreen(id: string, on: boolean): void {
    if (id === this.selfId) return;
    const cur = this.presence.get(id) ?? { audio: true, video: true, screen: false };
    this.presence.set(id, { ...cur, screen: on });
    this.pushPeers();
  }

  /** A validation error: a signaling message was refused. */
  onError(code: string): void {
    if (code !== "call_not_allowed") return;
    if (this.phase.p === "joining") {
      this.hooks.onLog("call refused by the server");
      this.reset();
    }
  }

  /** Movement datagram (README roadmap "Map enhancements"): `sz` flags —
   *  a peer inside a `silentZone` is muted locally. */
  setSilent(id: string, on: boolean): void {
    if (id === this.selfId) return;
    const changed = on ? this.silent.add(id) : this.silent.delete(id);
    if (!changed) return;
    this.moq?.setMuted(id, on);
    this.pushPeers();
  }

  // --- internals ------------------------------------------------------------

  /** Acquire local media; log and return null on refusal. The 🎤/📷
   *  preferences (they may have been set before the call) gate the fresh
   *  tracks right away. */
  private async acquireMedia(): Promise<MediaStream | null> {
    let stream: MediaStream;
    try {
      stream = await getLocalMedia(this.mediaPrefs);
    } catch (err) {
      this.hooks.onLog(`cannot access microphone/camera: ${String(err)}`);
      return null;
    }
    // The noise-gate chain: the processed track replaces the raw one in
    // the stream the UI and the publish pipeline see. The raw track is
    // kept apart — mute (`enabled`) and the device-id settings read it,
    // and the publish encoder would otherwise see a stereo destination
    // track with no device id.
    const [raw] = stream.getAudioTracks();
    const [video] = stream.getVideoTracks();
    let processed: MediaStreamTrack | null = null;
    if (raw) {
      this.micRaw = raw;
      this.denoiser?.stop();
      this.denoiser = await Denoiser.create(raw, this.mediaPrefs.noiseSuppression, (t) =>
        this.hooks.onLog(t),
      );
      processed = this.denoiser?.track ?? null;
    }
    this.localStream = processed
      ? new MediaStream([...(video ? [video] : []), processed])
      : stream;
    // A stored device id is an `ideal` constraint: a vanished device
    // falls back to the OS default. Clear the stale id so the dropdown
    // does not keep advertising it.
    this.validateDevicePrefs();
    if (this.micRaw) this.micRaw.enabled = this.audioOn;
    for (const t of this.localStream.getVideoTracks()) t.enabled = this.videoOn;
    this.hooks.onLocalStream(this.localStream);
    return this.localStream;
  }

  /** After acquisition: a stored id that the browser did not honor (the
   *  device vanished, or `ideal` fell back) is cleared from the prefs. */
  private validateDevicePrefs(): void {
    if (!this.localStream) return;
    let dirty = false;
    const audio = this.micRaw;
    const [video] = this.localStream.getVideoTracks();
    if (this.mediaPrefs.micId && audio?.getSettings().deviceId !== this.mediaPrefs.micId) {
      this.mediaPrefs.micId = undefined;
      dirty = true;
    }
    if (this.mediaPrefs.cameraId && video?.getSettings().deviceId !== this.mediaPrefs.cameraId) {
      this.mediaPrefs.cameraId = undefined;
      dirty = true;
    }
    if (dirty) saveMediaPrefs(this.mediaPrefs);
  }

  /** Enumerate the media devices for the topbar dropdowns. Labels are
   *  only populated once capture permission is granted — the menus
   *  exist while in a call, which implies it. */
  async listMediaDevices(): Promise<{
    mics: MediaDeviceInfo[];
    cams: MediaDeviceInfo[];
    micId?: string;
    camId?: string;
    noise: boolean;
  }> {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    return {
      mics: devices.filter((d) => d.kind === "audioinput"),
      cams: devices.filter((d) => d.kind === "videoinput"),
      micId: this.currentMicId(),
      camId: this.currentCamId(),
      noise: this.mediaPrefs.noiseSuppression,
    };
  }

  /** The *active* mic/camera id: the stored preference if the acquired
   *  track honored it, else the track's actual device (the OS default
   *  the menu should then mark). */
  private currentMicId(): string | undefined {
    // The RAW track: the processed (AudioContext destination) track
    // reports no device id.
    return this.micRaw?.getSettings().deviceId ?? this.mediaPrefs.micId;
  }

  private currentCamId(): string | undefined {
    const [video] = this.localStream?.getVideoTracks() ?? [];
    return video?.getSettings().deviceId ?? this.mediaPrefs.cameraId;
  }

  /** Switch the microphone mid-call: fresh track, swapped into the
   *  stream and the publish pipeline (the encoder rebuilds on the same
   *  broadcast — receivers' stall watchdog re-subscribes). The mute
   *  state survives. */
  async selectMic(deviceId: string): Promise<void> {
    const track = await this.acquireTrack("audio", deviceId);
    if (!track) return;
    this.mediaPrefs.micId = deviceId;
    saveMediaPrefs(this.mediaPrefs);
    // Re-wrap the fresh raw track in the gate chain and swap the
    // processed track into the stream the publisher sees.
    this.denoiser?.stop();
    this.denoiser = await Denoiser.create(track, this.mediaPrefs.noiseSuppression, (t) =>
      this.hooks.onLog(t),
    );
    const processed = this.denoiser?.track ?? track;
    this.micRaw = track;
    const [old] = this.localStream?.getAudioTracks() ?? [];
    for (const t of this.localStream?.getAudioTracks() ?? []) t.stop();
    this.localStream?.removeTrack(old);
    this.localStream?.addTrack(processed);
    track.enabled = this.audioOn;
    this.hooks.onLocalStream(this.localStream!);
    this.moq?.swapAudio(processed);
    this.hooks.onLog(`microphone switched: ${track.label || deviceId}`);
  }

  /** Switch the camera mid-call (see `selectMic`). The camera-off state
   *  survives the swap (the new track is gated by the preference). */
  async selectCamera(deviceId: string): Promise<void> {
    const track = await this.acquireTrack("video", deviceId);
    if (!track) return;
    this.mediaPrefs.cameraId = deviceId;
    saveMediaPrefs(this.mediaPrefs);
    const [old] = this.localStream?.getVideoTracks() ?? [];
    for (const t of this.localStream?.getVideoTracks() ?? []) t.stop();
    this.localStream?.removeTrack(old);
    this.localStream?.addTrack(track);
    track.enabled = this.videoOn;
    this.hooks.onLocalStream(this.localStream!);
    this.moq?.swapVideo(track, this.videoOn);
    this.hooks.onLog(`camera switched: ${track.label || deviceId}`);
  }

  /** Acquire a single replacement track of `kind` from `deviceId`
   *  (`ideal`: a vanished device falls back to the default rather than
   *  failing the switch). */
  private async acquireTrack(
    kind: "audio" | "video",
    deviceId: string,
  ): Promise<MediaStreamTrack | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        [kind]: kind === "audio"
          ? {
              echoCancellation: true,
              autoGainControl: true,
              deviceId: { ideal: deviceId },
            }
          : {
              width: { ideal: 800, max: 800 },
              height: { ideal: 600, max: 600 },
              frameRate: { ideal: 30, max: 30 },
              deviceId: { ideal: deviceId },
            },
      });
      return kind === "audio"
        ? stream.getAudioTracks()[0]
        : stream.getVideoTracks()[0];
    } catch (err) {
      this.hooks.onLog(`cannot switch ${kind}: ${String(err)}`);
      return null;
    }
  }

  /** Toggle browser-side noise suppression on the live mic track
   *  (`applyConstraints`: Chrome reconfigures the audio processing on a
   *  running track). Persisted; a fresh acquisition picks it up. */
  async setNoiseSuppression(on: boolean): Promise<void> {
    this.mediaPrefs.noiseSuppression = on;
    saveMediaPrefs(this.mediaPrefs);
    // The toggle drives the campfire gate only. The browser's own
    // `noiseSuppression` is left at its default either way — turning the
    // gate off must keep the browser default, not strip the mic of its
    // processing (the browser's APM is the better stage for most mics;
    // the gate is the loud fan / steady hum specialist).
    this.denoiser?.setEnabled(on);
  }

  /** The current preferences snapshot (the dropdown menus' state). */
  mediaState(): MediaPrefs {
    return { ...this.mediaPrefs };
  }

  /** We are in the bubble with `participants` (including us): enter the
   *  call and open the MoQ session. */
  private enterCall(participants: UserBrief[], ticket?: string): void {
    this.roster = participants;
    const others = participants.filter((u) => u.id !== this.selfId);
    this.setPhase({ p: "in-call", participants: others });
    this.maybeAutoVoiceOnly();
    // Announce our mute/camera preference (it may predate the call).
    this.send.sendCallMute(this.audioOn, this.videoOn);
    this.pushPeers();
    this.hooks.onCallSound("enter");
    this.startSession(ticket);
  }

  /** (Re)start the MoQ session with the call's fresh ticket. No ticket
   *  (server predates the MoQ SFU) means the session is off. */
  private startSession(ticket?: string): void {
    this.stopSession();
    if (!ticket) return;
    if (!this.localStream) return;
    const seq = ++this.sessionSeq;
    // The ticket is single-use and rides the path, never a query string
    // (docs/arch/moq-sfu.md).
    const url = `${location.origin}/moq/${ticket}`;
    const name = `call/${this.room}/${this.selfId}.hang`;
    void MoqCall.start({
      url,
      name,
      room: this.room,
      stream: this.localStream,
      onLog: (t) => this.hooks.onLog(t),
      onLevel: (id, level) => this.hooks.onPeerLevel(id, level),
      onDownlinkChange: () => this.pushPeers(),
      // The session died unexpectedly (network drop, server close): while
      // we are still in the call, ask the server for a fresh ticket and
      // restart. A clean stop() (leaving the call) notifies nothing.
      onEnded: () => this.onSessionEnded(seq),
    })
      .then((c) => {
        // A reset raced the async start: drop the orphaned session.
        if (seq !== this.sessionSeq) c.stop();
        else {
          this.moq = c;
          // Camera off / auto voice-only while the session was in flight:
          // apply the gate now. A screen share started in flight rides the
          // fresh session.
          c.setVideoEnabled(this.videoOn);
          if (this.screenStream) c.startScreen(this.screenStream);
        }
        this.syncDownlinks();
        this.pushPeers();
      })
      .catch((err) => {
        this.hooks.onLog(String(err));
      });
  }

  /** The MoQ session died while we are still in the call (network drop,
   *  server close, the SFU aborting the session). The ticket it carried is
   *  single-use and a stable roster sends no new `call_start`, so the only
   *  way back is a fresh ticket (`docs/arch/moq-sfu.md` `ticket` request).
   *  A short backoff keeps a rapidly dying session from spinning the
   *  request; leaving the call cancels the retry via `sessionSeq`. */
  private onSessionEnded(seq: number): void {
    if (seq !== this.sessionSeq) return; // stale session, already replaced
    if (this.phase.p !== "in-call") return;
    if (!this.moq) return;
    this.moq = null;
    const delay = 1000;
    window.setTimeout(() => {
      if (this.phase.p !== "in-call") return;
      this.send.requestTicket();
    }, delay);
  }

  /** A fresh media ticket arrived (docs/arch/moq-sfu.md): restart the
   *  media session with it. */
  onTicket(ticket: string): void {
    if (this.phase.p !== "in-call") return;
    if (this.moq) return; // a live session is not ours to replace
    this.startSession(ticket);
  }

  /** Stop the MoQ session (idempotent). */
  private stopSession(): void {
    this.sessionSeq++;
    this.moq?.stop();
    this.moq = null;
  }

  /** Ensure the session has exactly one downlink per other participant:
   *  add the missing, drop the stale. */
  private syncDownlinks(): void {
    const moq = this.moq;
    if (!moq) return;
    const wanted = new Set(
      this.roster.filter((u) => u.id !== this.selfId).map((u) => u.id),
    );
    for (const id of [...moq.participantIds()]) {
      if (!wanted.has(id)) moq.removeParticipant(id);
    }
    for (const id of wanted) {
      if (!moq.hasParticipant(id)) moq.addParticipant(id);
    }
  }

  /** docs/ops/maps.md: at 9+ participants degrade to voice-only (camera off).
   *  The 📷 button overrides back to video. */
  private maybeAutoVoiceOnly(): void {
    const total = this.roster.length; // includes us
    if (total >= VOICE_ONLY_AT && this.videoOn && this.localStream) {
      this.videoOn = false;
      this.autoVoicedOff = true;
      for (const t of this.localStream.getVideoTracks()) t.enabled = false;
      this.moq?.setVideoEnabled(false);
      this.send.sendCallMute(this.audioOn, this.videoOn);
      this.hooks.onLocalMute(this.audioOn, this.videoOn);
      this.hooks.onLog(
        `auto voice-only: ${total} people in the call (camera off — tap 📷 to re-enable)`,
      );
    }
  }

  /** Push the remote roster (state, downlink canvases, presence) to the UI. */
  private pushPeers(): void {
    const views: PeerView[] = this.roster
      .filter((u) => u.id !== this.selfId)
      .map((u) => {
        const dl: DownlinkView | null = this.moq?.view(u.id) ?? null;
        const pres = this.presence.get(u.id) ?? { audio: true, video: true, screen: false };
        return {
          id: u.id,
          name: u.name,
          camera: dl?.canvas ?? null,
          screen: pres.screen ? (dl?.screenCanvas ?? null) : null,
          state: dl?.status ?? "subscribing",
          delay: dl?.delay ?? 0,
          delayVideo: dl?.videoDelay ?? 0,
          jitter: dl?.jitter ?? 0,
          width: dl?.width ?? 0,
          height: dl?.height ?? 0,
          audioOn: pres.audio,
          videoOn: pres.video,
          screenOn: pres.screen,
          rtt: this.rtt,
        };
      });
    this.hooks.onPeers(views);
  }

  private setPhase(phase: CallPhase): void {
    this.phase = phase;
    // The tiles' latency labels refresh on a 1 s tick while in the call:
    // the downlink delay/jitter move on their own, not with roster or
    // presence events, so a periodic re-push keeps them current.
    if (phase.p === "in-call" && this.statsTimer === null) {
      // One getStats in flight at a time: a slow WebTransport.getStats()
      // must not stack calls that each end in a roster push.
      let rttPending = false;
      this.statsTimer = window.setInterval(() => {
        // Refresh the transport RTT, then push the roster with the fresh
        // value. `getRtt()` resolves immediately on the SSE fallback
        // (null) and rejects-to-null when `getStats()` is unavailable.
        if (rttPending) return;
        rttPending = true;
        void this.send
          .getRtt()
          .catch(() => null)
          .then((v) => {
            rttPending = false;
            this.rtt = v;
            this.pushPeers();
          });
      }, 1000);
    } else if (phase.p !== "in-call" && this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.hooks.onPhase(phase);
  }

  /** Tear everything down with zero leftovers (docs/dev/testing.md: "no
   *  leaked peer connections" — the session closes, every track stopped). */
  private reset(reason?: string): void {
    this.stopSession();
    this.presence.clear();
    this.silent.clear();
    this.roster = [];
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    // The gate chain rides the raw track's lifetime; stopping both
    // releases the device and the AudioContext.
    this.denoiser?.stop();
    this.denoiser = null;
    this.micRaw?.stop();
    this.micRaw = null;
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.screenOn = false;
    this.hooks.onLocalScreen(false);
    this.hooks.onLocalStream(null);
    this.hooks.onPeers([]);
    // Leaving the call: the 🎤/📷 preferences persist (the top-bar buttons
    // are global); only the auto voice-only degradation is undone.
    if (this.autoVoicedOff) {
      this.videoOn = true;
      this.autoVoicedOff = false;
    }
    this.hooks.onLocalMute(this.audioOn, this.videoOn);
    if (reason) this.hooks.onLog(reason);
    this.setPhase({ p: "idle" });
  }
}

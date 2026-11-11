//! Proximity-call state machine — "bubbles" (README §6.3).
//!
//! Media is one MoQ SFU session per call (docs/moq-sfu.md §9): the client
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
import { getLocalMedia, getScreenMedia } from "./media";

/** Participant count at which the call degrades to voice-only (README §6.1:
 *  "9+"; the done-when's "engages at 10" is satisfied, the 📷 button
 *  overrides back to video). */
const VOICE_ONLY_AT = 9;

export type CallPhase =
  | { p: "idle" }
  /** Media is being acquired for an auto-join. */
  | { p: "joining" }
  | { p: "in-call"; participants: UserBrief[] };

/** A participant's downlink state (README §7: "subscribing…/live"). */
export type DownlinkState = DownlinkStatus;

/** One remote participant as the UI needs it (grid tile). */
export interface PeerView {
  id: string;
  name: string;
  /** The camera downlink's paint target (the SFU renders into it). */
  camera: HTMLCanvasElement | null;
  /** The camera downlink's audio as a MediaStream (the level meter). */
  cameraStream: MediaStream | null;
  /** The screen-share downlink's paint target (only while they share). */
  screen: HTMLCanvasElement | null;
  state: DownlinkState;
  /** Downlink playback delay from the live edge, ms (0 while no downlink). */
  delay: number;
  /** Downlink jitter buffer depth, ms (0 while no downlink). */
  jitter: number;
  /** Presence from `call_mute` (default on). */
  audioOn: boolean;
  videoOn: boolean;
  /** Presence from `call_screen`: the peer is sharing their screen. */
  screenOn: boolean;
}

/** What the manager tells the UI. */
export interface CallUiHooks {
  onPhase: (phase: CallPhase) => void;
  /** Local media acquired (for the PiP video) or released. */
  onLocalStream: (stream: MediaStream | null) => void;
  /** Full roster of remote participants (grid rebuild/update). */
  onPeers: (peers: PeerView[]) => void;
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
}

export class CallManager {
  phase: CallPhase = { p: "idle" };
  /** Our mute/camera state (presence, relayed via `call_mute`). */
  audioOn = true;
  videoOn = true;
  /** True while the camera video track carries our screen. */
  screenOn = false;

  private selfId = "";
  /** Per-participant `call_mute`/`call_screen` presence. */
  private presence = new Map<string, { audio: boolean; video: boolean; screen: boolean }>();
  /** Our screen share (when `screenOn`). */
  private screenStream: MediaStream | null = null;
  /** `sz` (README roadmap "Map enhancements"): peers inside a silentZone. */
  private silent = new Set<string>();
  /** The call roster including ourselves (from `call_start`/`call_join`). */
  private roster: UserBrief[] = [];
  private localStream: MediaStream | null = null;
  /** The one MoQ session for the current call (uplink + downlinks). */
  private moq: MoqCall | null = null;
  /** Monotonic guard for in-flight session starts (a reset must not let a
   *  late start attach). */
  private sessionSeq = 0;
  /** 1 s refresh of the tiles' latency labels while in the call (the
   *  downlink delay/jitter move on their own, not with roster events). */
  private statsTimer: number | null = null;
  /** Room name (broadcast path `call/<room>/<user-id>.hang`). */
  private room: string;

  constructor(
    private send: CallSignaling,
    private hooks: CallUiHooks,
    room: string,
  ) {
    this.room = room;
  }

  /** Our own user id (from `hello`). */
  setSelfId(id: string): void {
    this.selfId = id;
  }

  get selfIdValue(): string {
    return this.selfId;
  }

  /** Whether we are currently in a call. */
  inCall(): boolean {
    return this.phase.p === "in-call";
  }

  // --- user actions ---------------------------------------------------------

  /** Opt out of proximity bubbles (README §6.3): the server drops us from
   *  the current bubble at once and never pulls us back in. */
  setBubble(off: boolean): void {
    this.send.sendBubble(off);
  }

  /** Hang up: leave the current bubble (the server dissolves it when ≤ 1
   *  participant remains). */
  hangup(): void {
    this.send.sendCallLeave();
    this.reset();
  }

  toggleMute(): void {
    if (this.phase.p !== "in-call" || !this.localStream) return;
    this.audioOn = !this.audioOn;
    // Disable the local track: the uplink encodes silence and the PiP
    // reflects it too.
    for (const t of this.localStream.getAudioTracks()) t.enabled = this.audioOn;
    this.send.sendCallMute(this.audioOn, this.videoOn);
    this.hooks.onLocalMute(this.audioOn, this.videoOn);
  }

  toggleCamera(): void {
    if (this.phase.p !== "in-call" || !this.localStream) return;
    this.videoOn = !this.videoOn;
    for (const t of this.localStream.getVideoTracks()) t.enabled = this.videoOn;
    // Omit the uplink's video rendition so subscribers stop receiving
    // black frames rather than a stream of them.
    this.moq?.setVideoEnabled(this.videoOn);
    this.send.sendCallMute(this.audioOn, this.videoOn);
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

  // --- server messages (README §5) ------------------------------------------

  /** Room-wide (headphone badge) and, when we are in the roster, our
   *  authoritative bubble state: created or joined (auto-join on approach,
   *  README §6.3), or a roster re-sync while we are already in. */
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
      this.pushPeers();
      return;
    }
    if (this.phase.p !== "idle") return;
    // Auto-join: the server pulled us into a bubble. `getUserMedia` here —
    // walking close is the user's intent (README §6.3 relaxed prompt).
    this.setPhase({ p: "joining" });
    void (async () => {
      const stream = await this.acquireMedia();
      if (!stream) {
        // No media, no call: leave so the server does not keep our seat
        // open with a silent ghost (README §6.3).
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

  /** Reconnect-with-token (README §5): the `hello` after a dropped
   *  connection (or a tab refresh) says the room's call survived and we
   *  are still in it. The MoQ session died with the old connection, so it
   *  is torn down and re-established with the fresh ticket. A refresh
   *  loses `localStream`, so the media is re-acquired (the mic permission
   *  was granted on the original join, so no new prompt). */
  async rejoinCall(participants: UserBrief[], ticket?: string): Promise<void> {
    if (this.phase.p === "joining") {
      // An auto-join is already in flight (media prompt open): let it
      // finish with its own ticket (tickets are valid for 60 s).
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

  /** Acquire local media; log and return null on refusal. */
  private async acquireMedia(): Promise<MediaStream | null> {
    try {
      this.localStream = await getLocalMedia();
    } catch (err) {
      this.hooks.onLog(`cannot access microphone/camera: ${String(err)}`);
      return null;
    }
    this.hooks.onLocalStream(this.localStream);
    return this.localStream;
  }

  /** We are in the bubble with `participants` (including us): enter the
   *  call and open the MoQ session. */
  private enterCall(participants: UserBrief[], ticket?: string): void {
    this.roster = participants;
    const others = participants.filter((u) => u.id !== this.selfId);
    this.setPhase({ p: "in-call", participants: others });
    this.maybeAutoVoiceOnly();
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
    const url = `${location.origin}/moq?ticket=${encodeURIComponent(ticket)}`;
    const name = `call/${this.room}/${this.selfId}.hang`;
    void MoqCall.start({
      url,
      name,
      room: this.room,
      stream: this.localStream,
      onLog: (t) => this.hooks.onLog(t),
      onDownlinkChange: () => this.pushPeers(),
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

  /** README §6.1: at 9+ participants degrade to voice-only (camera off).
   *  The 📷 button overrides back to video. */
  private maybeAutoVoiceOnly(): void {
    const total = this.roster.length; // includes us
    if (total >= VOICE_ONLY_AT && this.videoOn && this.localStream) {
      this.videoOn = false;
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
          cameraStream: dl?.stream ?? null,
          screen: pres.screen ? (dl?.screenCanvas ?? null) : null,
          state: dl?.status ?? "subscribing",
          delay: dl?.delay ?? 0,
          jitter: dl?.jitter ?? 0,
          audioOn: pres.audio,
          videoOn: pres.video,
          screenOn: pres.screen,
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
      this.statsTimer = window.setInterval(() => this.pushPeers(), 1000);
    } else if (phase.p !== "in-call" && this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.hooks.onPhase(phase);
  }

  /** Tear everything down with zero leftovers (README §11 Phase 6: "no
   *  leaked peer connections" — the session closes, every track stopped). */
  private reset(reason?: string): void {
    this.stopSession();
    this.presence.clear();
    this.silent.clear();
    this.roster = [];
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.screenOn = false;
    this.hooks.onLocalScreen(false);
    this.hooks.onLocalStream(null);
    this.hooks.onPeers([]);
    this.audioOn = true;
    this.videoOn = true;
    this.hooks.onLocalMute(true, true);
    if (reason) this.hooks.onLog(reason);
    this.setPhase({ p: "idle" });
  }
}

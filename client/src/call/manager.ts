//! Proximity-call state machine — "bubbles" (README §6.3).
//!
//! One `RTCPeerConnection` per remote participant (mesh, README §6.1).
//! The *joiner* is always the offerer — each newcomer offers every
//! existing member, who never renegotiate (README §6.3). On bubble
//! creation the server designates the smaller id.
//!
//! Call *state* (`call_start` / `call_leave` / `call_end`) is room-wide: it
//! powers the avatars' headphone badge, so a bystander hears it too. Call
//! *signaling* (offer/answer/ice/mute) is call-scoped.
//!
//! Joining is automatic: the server pulls nearby avatars into a bubble and
//! the client asks for the mic (`getUserMedia`) on the first auto-join —
//! walking close is the user's intent. A user can opt out entirely with
//! the bubble toggle (`sendBubble`).
import type { UserBrief } from "../net/types";
import { getLocalMedia, iceServers } from "./media";
import { RtcPeer, type PeerState } from "./peer";

/** Participant count at which the call degrades to voice-only (README §6.1:
 *  "9+"; the done-when's "engages at 10" is satisfied, the 📷 button
 *  overrides back to video). */
const VOICE_ONLY_AT = 9;

export type CallPhase =
  | { p: "idle" }
  /** Media is being acquired for an auto-join. */
  | { p: "joining" }
  | { p: "in-call"; participants: UserBrief[] };

/** One remote participant as the UI needs it (grid tile). */
export interface PeerView {
  id: string;
  name: string;
  stream: MediaStream | null;
  state: PeerState;
  viaRelay: boolean;
  /** Presence from `call_mute` (default on). */
  audioOn: boolean;
  videoOn: boolean;
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
  /** A local log/system line (errors, ICE errors). */
  onLog: (text: string) => void;
}

/** The signaling surface the manager needs (implemented by `Connection`). */
export interface CallSignaling {
  /** Opt out of bubbles (or back in with false). */
  sendBubble(off: boolean): void;
  sendCallOffer(to: string, sdp: string): void;
  sendCallAnswer(to: string, sdp: string): void;
  sendCallIce(to: string, candidate: string): void;
  sendCallMute(audio: boolean, video: boolean): void;
  sendCallLeave(): void;
}

export class CallManager {
  phase: CallPhase = { p: "idle" };
  /** Our mute/camera state (presence, relayed via `call_mute`). */
  audioOn = true;
  videoOn = true;

  private selfId = "";
  /** One peer per remote participant of *our* call (empty when idle). */
  private peers = new Map<string, RtcPeer>();
  /** Remote media per participant. */
  private streams = new Map<string, MediaStream | null>();
  /** Per-participant `call_mute` presence. */
  private presence = new Map<string, { audio: boolean; video: boolean }>();
  /** Per-participant connection state (quality UI). */
  private connState = new Map<string, { state: PeerState; viaRelay: boolean }>();
  /** The call roster including ourselves (from `call_start`/`call_join`). */
  private roster: UserBrief[] = [];
  private localStream: MediaStream | null = null;
  /** ICE servers for the current call (fetched with the local media). */
  private servers: RTCIceServer[] | null = null;

  constructor(
    private send: CallSignaling,
    private hooks: CallUiHooks,
  ) {}

  /** Our own user id (from `hello`). */
  setSelfId(id: string): void {
    this.selfId = id;
  }

  get selfIdValue(): string {
    return this.selfId;
  }

  /** Whether we currently hold peers (i.e. are in a call). */
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
    // The same track objects are added to every peer: one flip covers all.
    for (const t of this.localStream.getAudioTracks()) t.enabled = this.audioOn;
    this.send.sendCallMute(this.audioOn, this.videoOn);
    this.hooks.onLocalMute(this.audioOn, this.videoOn);
  }

  toggleCamera(): void {
    if (this.phase.p !== "in-call" || !this.localStream) return;
    this.videoOn = !this.videoOn;
    for (const t of this.localStream.getVideoTracks()) t.enabled = this.videoOn;
    this.send.sendCallMute(this.audioOn, this.videoOn);
    this.hooks.onLocalMute(this.audioOn, this.videoOn);
  }

  // --- server messages (README §5) ------------------------------------------

  /** Room-wide (headphone badge) and, when we are in the roster, our
   *  authoritative bubble state: created or joined (auto-join on approach,
   *  README §6.3), or a roster re-sync while we are already in.
   *
   *  `youOffer` marks us as the designated offerer: a fresh joiner offers
   *  every existing member; on a join catch-up after a reconnect our old
   *  peer connections are dead, so we re-offer. */
  onCallStart(participants: UserBrief[], youOffer: boolean): void {
    const selfIn = participants.some((u) => u.id === this.selfId);
    if (!selfIn) {
      // Bystander: badge only (the avatar layer reads the roster from
      // main.ts's `onCallStart`); nothing to do here.
      return;
    }
    if (this.phase.p === "in-call") {
      // Re-sync: a newcomer joined (they offer, we wait) — open a peer for
      // anyone we do not have one to. When `youOffer` (reconnect catch-up:
      // our old paths are dead) re-offer to the ones missing a peer.
      this.roster = participants;
      for (const u of participants) {
        if (u.id === this.selfId) continue;
        if (!this.peers.has(u.id)) {
          this.ensurePeer(u);
          if (youOffer) void this.offerTo(u);
        }
      }
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
      this.enterCall(participants, youOffer);
    })();
  }

  /** A participant left (room-wide; includes us, for our own badge). */
  onCallLeave(id: string): void {
    if (this.phase.p !== "in-call") return;
    if (id === this.selfId) {
      this.reset("you left the call");
      return;
    }
    this.roster = this.roster.filter((u) => u.id !== id);
    this.peers.get(id)?.close();
    this.peers.delete(id);
    this.streams.delete(id);
    this.presence.delete(id);
    this.connState.delete(id);
    this.pushPeers();
    // If we are the last one left the server sends `call_end`.
  }

  /** The room's call ended (room-wide). */
  onCallEnd(reason: string): void {
    if (this.phase.p === "idle") return;
    this.reset(`call ended (${reason})`);
  }

  /** Reconnect-with-token (README §5): the `hello` after a dropped
   *  connection says the room's call survived and we are still in it. The
   *  old peers' network paths are dead, so close them all and re-establish
   *  from scratch: we act as the fresh joiner and offer every existing
   *  member a direct connection (they answer; their stale peers are
   *  replaced by `onCallOffer`). */
  async rejoinCall(participants: UserBrief[]): Promise<void> {
    if (!this.localStream) {
      // Media was released while we were away (e.g. the tab slept): we
      // cannot rejoin without a fresh mic prompt (explicit join, README
      // §6.3) — the user can "Join call" from the status panel.
      this.hooks.onLog("call ended while you were disconnected");
      this.reset();
      return;
    }
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.streams.clear();
    this.presence.clear();
    this.connState.clear();
    this.roster = participants;
    this.servers = await iceServers();
    const others = participants.filter((u) => u.id !== this.selfId);
    for (const u of others) {
      this.ensurePeer(u);
      void this.offerTo(u);
    }
    this.setPhase({ p: "in-call", participants: others });
    this.maybeAutoVoiceOnly();
    this.pushPeers();
    this.hooks.onLog("rejoined the call");
  }

  /** A relayed offer from a call participant.
   *
   *  The peer is reused only while it is fresh (`new`/`connecting` — a
   *  huddle joiner that just opened it, or our own 1:1 in flight). Anything
   *  else (no peer, or a peer whose network path died during a connection
   *  drop) is closed and rebuilt from the roster: a rejoiner after a drop
   *  offers us a *fresh* connection (README §5 reconnect). */
  onCallOffer(from: string, sdp: string): void {
    const existing = this.peers.get(from);
    const st = this.connState.get(from)?.state ?? "new";
    if (existing && st !== "new" && st !== "connecting") {
      existing.close();
      this.peers.delete(from);
      const u = this.roster.find((r) => r.id === from);
      if (u) this.ensurePeer(u);
    }
    const peer = this.peers.get(from);
    if (!peer) return;
    void (async () => {
      await peer.setRemoteOffer(sdp);
      const answer = await peer.createAnswer();
      this.send.sendCallAnswer(from, answer);
    })();
  }

  onCallAnswer(from: string, sdp: string): void {
    void this.peers.get(from)?.setRemoteAnswer(sdp);
  }

  onCallIce(from: string, candidate: string): void {
    void this.peers.get(from)?.addIceCandidate(candidate);
  }

  /** Presence only (call-scoped; the server does not echo it to us). */
  onCallMute(id: string, audio: boolean, video: boolean): void {
    if (id === this.selfId) return;
    this.presence.set(id, { audio, video });
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

  // --- internals ------------------------------------------------------------

  /** Acquire local media + ICE servers; log and return null on refusal. */
  private async acquireMedia(): Promise<MediaStream | null> {
    try {
      this.localStream = await getLocalMedia();
    } catch (err) {
      this.hooks.onLog(`cannot access microphone/camera: ${String(err)}`);
      return null;
    }
    this.servers = await iceServers();
    this.hooks.onLocalStream(this.localStream);
    return this.localStream;
  }

  /** We are in the bubble with `participants` (including us): open a peer
   *  to every other member, and (when `offer`) send each of them our
   *  offer (the joiner offers, README §6.3). */
  private enterCall(participants: UserBrief[], offer: boolean): void {
    this.roster = participants;
    const others = participants.filter((u) => u.id !== this.selfId);
    for (const u of others) {
      this.ensurePeer(u);
      if (offer) void this.offerTo(u);
    }
    this.setPhase({ p: "in-call", participants: others });
    this.maybeAutoVoiceOnly();
    this.pushPeers();
  }

  /** Open (or reuse) the peer to `user`; tracks are added once per peer. */
  private ensurePeer(user: UserBrief): void {
    if (this.peers.has(user.id) || !this.localStream || !this.servers) return;
    const servers = this.servers;
    const stream = this.localStream;
    this.peers.set(
      user.id,
      new RtcPeer(stream, servers, {
        onRemoteStream: (s) => {
          this.streams.set(user.id, s);
          this.pushPeers();
        },
        onIceCandidate: (c) => this.send.sendCallIce(user.id, c),
        onStateChange: (state, viaRelay) => {
          this.connState.set(user.id, { state, viaRelay });
          this.pushPeers();
        },
        onIceError: (detail) => this.hooks.onLog(`ICE error (${user.name}): ${detail}`),
      }),
    );
  }

  /** Offer side: create the offer and send it to `user`. */
  private async offerTo(user: UserBrief): Promise<void> {
    const peer = this.peers.get(user.id);
    if (!peer) return;
    try {
      const sdp = await peer.createOffer();
      this.send.sendCallOffer(user.id, sdp);
    } catch (err) {
      this.hooks.onLog(`offer to ${user.name} failed: ${String(err)}`);
    }
  }

  /** README §6.1: at 9+ participants degrade to voice-only (camera off).
   *  The 📷 button overrides back to video. */
  private maybeAutoVoiceOnly(): void {
    const total = this.roster.length; // includes us
    if (total >= VOICE_ONLY_AT && this.videoOn && this.localStream) {
      this.videoOn = false;
      for (const t of this.localStream.getVideoTracks()) t.enabled = false;
      this.send.sendCallMute(this.audioOn, this.videoOn);
      this.hooks.onLocalMute(this.audioOn, this.videoOn);
      this.hooks.onLog(
        `auto voice-only: ${total} people in the call (camera off — tap 📷 to re-enable)`,
      );
    }
  }

  /** Push the remote roster (state, streams, presence) to the UI grid. */
  private pushPeers(): void {
    const views: PeerView[] = this.roster
      .filter((u) => u.id !== this.selfId)
      .map((u) => {
        const st = this.connState.get(u.id) ?? { state: "new" as PeerState, viaRelay: false };
        const pres = this.presence.get(u.id) ?? { audio: true, video: true };
        return {
          id: u.id,
          name: u.name,
          stream: this.streams.get(u.id) ?? null,
          state: st.state,
          viaRelay: st.viaRelay,
          audioOn: pres.audio,
          videoOn: pres.video,
        };
      });
    this.hooks.onPeers(views);
  }

  private setPhase(phase: CallPhase): void {
    this.phase = phase;
    this.hooks.onPhase(phase);
  }

  /** Tear everything down with zero leftovers (README §11 Phase 6: "no
   *  leaked peer connections" — every peer is closed, every track stopped). */
  private reset(reason?: string): void {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.streams.clear();
    this.presence.clear();
    this.connState.clear();
    this.roster = [];
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.servers = null;
    this.hooks.onLocalStream(null);
    this.hooks.onPeers([]);
    this.audioOn = true;
    this.videoOn = true;
    this.hooks.onLocalMute(true, true);
    if (reason) this.hooks.onLog(reason);
    this.setPhase({ p: "idle" });
  }
}

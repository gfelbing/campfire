//! Call state machine: 1:1 calls + room huddles (README §5/§6.3).
//!
//! One `RTCPeerConnection` per remote participant (mesh, README §6.1).
//! In a 1:1 the caller (the one who rang) is always the offerer; in a
//! huddle the *joiner* is always the offerer — each newcomer offers every
//! existing member, who never renegotiate (README §6.3).
//!
//! Call *state* (`call_start` / `call_join` / `call_leave` / `call_end`) is
//! room-wide: it powers the avatars' headphone badge, so a bystander hears
//! it too. Call *signaling* (offer/answer/ice/mute) is call-scoped.
//!
//! Explicit join (README §6.3): `getUserMedia` is only requested inside
//! `ring()`, `accept()` and `joinHuddle()` — on the user's own action.

import { ROOM_TARGET } from "../net/types";
import type { UserBrief } from "../net/types";
import { getLocalMedia, iceServers } from "./media";
import { RtcPeer, type PeerState } from "./peer";

/** Participant count at which the call degrades to voice-only (README §6.1:
 *  "9+"; the done-when's "engages at 10" is satisfied, the 📷 button
 *  overrides back to video). */
const VOICE_ONLY_AT = 9;

export type CallPhase =
  | { p: "idle" }
  | { p: "outgoing"; peer: string; name: string }
  | { p: "incoming"; from: string; name: string }
  | { p: "joining" }
  | { p: "in-call"; kind: "1:1" | "huddle"; participants: UserBrief[] };

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
  sendCallRing(to: string): void;
  sendCallRingStop(to: string): void;
  sendCallAccept(to: string): void;
  sendCallDecline(to: string): void;
  /** `to` is a user id, or `ROOM_TARGET` ("room") to create/join a huddle. */
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
  /** A call we joined is not confirmed yet (`call_start` pending). */
  private awaitingStart: "huddle" | "1:1" | null = null;

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

  /** Ring `user` (1:1). Explicit join: the mic prompt happens here. */
  async ring(user: UserBrief): Promise<void> {
    if (this.phase.p !== "idle" || user.id === this.selfId) return;
    const stream = await this.acquireMedia();
    if (!stream) return;
    this.setPhase({ p: "outgoing", peer: user.id, name: user.name });
    this.send.sendCallRing(user.id);
  }

  /** Create or join the room's huddle. Explicit join: mic prompt here.
   *  The joiner is the offerer to every existing member (README §6.3). */
  async joinHuddle(): Promise<void> {
    if (this.phase.p !== "idle") return;
    const stream = await this.acquireMedia();
    if (!stream) return;
    this.setPhase({ p: "joining" });
    this.awaitingStart = "huddle";
    this.send.sendCallOffer(ROOM_TARGET, "");
  }

  /** Cancel an outgoing ring, decline an incoming one, hang up a call, or
   *  bail on an in-flight huddle join. */
  hangup(): void {
    switch (this.phase.p) {
      case "outgoing":
        this.send.sendCallRingStop(this.phase.peer);
        this.reset();
        break;
      case "incoming":
        this.send.sendCallDecline(this.phase.from);
        this.reset();
        break;
      case "joining":
        // The join may already be registered server-side; `call_leave` is a
        // no-op there if it is not (README §5: server validates).
        this.send.sendCallLeave();
        this.reset();
        break;
      case "in-call":
        this.send.sendCallLeave();
        this.reset();
        break;
      default:
        break;
    }
  }

  /** Accept an incoming 1:1 ring. Explicit join: the mic prompt here. */
  async accept(): Promise<void> {
    if (this.phase.p !== "incoming") return;
    const from = this.phase.from;
    const stream = await this.acquireMedia();
    if (!stream) {
      this.send.sendCallDecline(from);
      this.reset();
      return;
    }
    // `call_start` (with us in the roster) follows; we wait for the
    // caller's offer — the caller is always the offerer in a 1:1.
    this.setPhase({ p: "joining" });
    this.awaitingStart = "1:1";
    this.send.sendCallAccept(from);
  }

  decline(): void {
    if (this.phase.p !== "incoming") return;
    this.send.sendCallDecline(this.phase.from);
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

  onCallRing(from: string, name: string): void {
    if (this.phase.p !== "idle") return; // server enforces one call per room
    this.setPhase({ p: "incoming", from, name });
  }

  /** Room-wide (headphone badge) and, when we are in the roster, our
   *  authoritative call state: 1:1 accepted, huddle created or joined, or
   *  catch-up for a mid-call *room* joiner (badge only in that case). */
  onCallStart(participants: UserBrief[]): void {
    const selfIn = participants.some((u) => u.id === this.selfId);
    switch (this.phase.p) {
      case "outgoing": {
        // The callee accepted our 1:1 ring: we rang, so we are the offerer.
        if (!selfIn) return;
        this.enterCall(participants, true, "1:1");
        break;
      }
      case "joining": {
        // Huddle create/join (we offer: the joiner is the offerer) or 1:1
        // accept (the caller offers; we wait).
        if (!selfIn) return; // server rejected; an error message follows
        const huddle = this.awaitingStart === "huddle";
        this.enterCall(participants, huddle, huddle ? "huddle" : "1:1");
        break;
      }
      case "in-call": {
        // Re-synchronise the roster (defensive; state is incremental).
        this.roster = participants;
        this.pushPeers();
        break;
      }
      default:
        // Bystander or mid-call room joiner: badge only (main.ts).
        break;
    }
  }

  /** A participant joined the room's call (room-wide). If we are in the
   *  call, the newcomer opens N-1 fresh connections and offers each of us
   *  — we just wait for their offer (README §6.3). */
  onCallJoin(user: UserBrief): void {
    if (this.phase.p !== "in-call") return; // badge only (main.ts)
    if (this.roster.some((u) => u.id === user.id)) return;
    this.roster = [...this.roster, user];
    this.ensurePeer(user);
    this.maybeAutoVoiceOnly();
    this.pushPeers();
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

  onCallOffer(from: string, sdp: string): void {
    const peer = this.peers.get(from);
    if (!peer) return; // not our peer: 1:1 caller (we are the offerer) etc.
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

  /** A validation error: an in-flight join or ring was refused. */
  onError(code: string): void {
    if (code !== "call_not_allowed") return;
    if (this.awaitingStart !== null || this.phase.p === "outgoing") {
      this.hooks.onLog("call refused by the server");
      this.reset();
    }
  }

  /** The realtime connection dropped: the server dropped us from the call
   *  and we cannot hear `call_end`, so tear down locally. */
  onConnectionDown(): void {
    if (this.phase.p !== "idle") {
      this.hooks.onLog("connection lost — call ended");
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

  /** We are in the call with `participants` (including us): open a peer to
   *  every other member, and (when `offer`) send each of them our offer. */
  private enterCall(participants: UserBrief[], offer: boolean, kind: "1:1" | "huddle"): void {
    this.roster = participants;
    const others = participants.filter((u) => u.id !== this.selfId);
    for (const u of others) {
      this.ensurePeer(u);
      if (offer) void this.offerTo(u);
    }
    this.awaitingStart = null;
    this.setPhase({ p: "in-call", kind, participants: others });
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
    this.awaitingStart = null;
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

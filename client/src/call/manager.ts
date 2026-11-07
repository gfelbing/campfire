//! 1:1 call signaling state machine (README §5/§6.3, Phase 5).
//!
//! The server relays and validates; this class drives the local
//! `RTCPeerConnection` and the UI. The caller (the one who rang) is always
//! the offerer — the server's `call_accept` requires the callee to answer
//! the caller, so "who speaks first" is fixed by the ring (README §7).
//!
//! Explicit join (README §6.3): `getUserMedia` is only requested inside
//! `ring()` and `accept()`, i.e. on the user's own action.

import type { UserBrief } from "../net/types";
import { getLocalMedia, iceServers } from "./media";
import { RtcPeer, type PeerState } from "./peer";

export type CallPhase =
  | { p: "idle" }
  | { p: "outgoing"; peer: string; name: string }
  | { p: "incoming"; from: string; name: string }
  | { p: "in-call"; peer: string; name: string };

/** What the manager tells the UI. */
export interface CallUiHooks {
  onPhase: (phase: CallPhase) => void;
  /** Local media acquired (for the PiP video) or released. */
  onLocalStream: (stream: MediaStream | null) => void;
  /** Remote media (video + audio) or gone. */
  onRemoteStream: (stream: MediaStream | null) => void;
  /** Peer connection state + whether the selected pair is the relay. */
  onPeerState: (state: PeerState, viaRelay: boolean) => void;
  /** The other participant's mute/camera presence changed. */
  onPeerMute: (audio: boolean, video: boolean) => void;
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
  private peer: RtcPeer | null = null;
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

  // --- user actions ---------------------------------------------------------

  /** Ring `user`. Explicit join: the mic prompt happens here. */
  async ring(user: UserBrief): Promise<void> {
    if (this.phase.p !== "idle" || user.id === this.selfId) return;
    try {
      this.localStream = await getLocalMedia();
    } catch (err) {
      this.hooks.onLog(`cannot access microphone/camera: ${String(err)}`);
      return;
    }
    this.servers = await iceServers();
    this.hooks.onLocalStream(this.localStream);
    this.setPhase({ p: "outgoing", peer: user.id, name: user.name });
    this.send.sendCallRing(user.id);
  }

  /** Cancel an outgoing ring, or hang up an active call. */
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
      case "in-call":
        this.send.sendCallLeave();
        this.reset();
        break;
      default:
        break;
    }
  }

  /** Accept an incoming ring. Explicit join: the mic prompt happens here. */
  async accept(): Promise<void> {
    if (this.phase.p !== "incoming") return;
    const from = this.phase.from;
    const name = this.phase.name;
    let stream: MediaStream;
    try {
      stream = await getLocalMedia();
    } catch (err) {
      this.hooks.onLog(`cannot access microphone/camera: ${String(err)}`);
      this.send.sendCallDecline(from);
      this.reset();
      return;
    }
    this.localStream = stream;
    this.servers = await iceServers();
    this.hooks.onLocalStream(stream);
    this.peer = new RtcPeer(stream, this.servers, this.peerHooks());
    this.send.sendCallAccept(from);
    this.setPhase({ p: "in-call", peer: from, name });
  }

  decline(): void {
    if (this.phase.p !== "incoming") return;
    this.send.sendCallDecline(this.phase.from);
    this.reset();
  }

  toggleMute(): void {
    if (this.phase.p !== "in-call" || !this.localStream) return;
    this.audioOn = !this.audioOn;
    this.peer?.setAudioEnabled(this.audioOn);
    this.send.sendCallMute(this.audioOn, this.videoOn);
    this.hooks.onLocalMute(this.audioOn, this.videoOn);
  }

  toggleCamera(): void {
    if (this.phase.p !== "in-call" || !this.localStream) return;
    this.videoOn = !this.videoOn;
    this.peer?.setVideoEnabled(this.videoOn);
    this.send.sendCallMute(this.audioOn, this.videoOn);
    this.hooks.onLocalMute(this.audioOn, this.videoOn);
  }

  // --- server messages (README §5) ------------------------------------------

  onCallRing(from: string, name: string): void {
    if (this.phase.p !== "idle") return; // server enforces one call per room
    this.setPhase({ p: "incoming", from, name });
  }

  /** Both sides hear it when the callee accepts; the caller then offers. */
  onCallStart(participants: UserBrief[]): void {
    const other = participants.find((u) => u.id !== this.selfId);
    if (!other) return;
    if (this.phase.p === "outgoing" && other.id === this.phase.peer) {
      // The callee accepted. We rang, so we are the offerer.
      if (!this.localStream || !this.servers) {
        this.reset();
        return;
      }
      this.peer = new RtcPeer(this.localStream, this.servers, this.peerHooks());
      this.setPhase({ p: "in-call", peer: other.id, name: other.name });
      void (async () => {
        const sdp = await this.peer!.createOffer();
        this.send.sendCallOffer(other.id, sdp);
      })();
    }
    // Callee side: the offer follows; nothing to do yet.
  }

  onCallOffer(from: string, sdp: string): void {
    if (this.phase.p !== "in-call" || from !== this.phase.peer) return;
    if (!this.peer) return;
    void (async () => {
      await this.peer!.setRemoteOffer(sdp);
      const answer = await this.peer!.createAnswer();
      this.send.sendCallAnswer(from, answer);
    })();
  }

  onCallAnswer(from: string, sdp: string): void {
    if (this.phase.p !== "in-call" || from !== this.phase.peer) return;
    void this.peer?.setRemoteAnswer(sdp);
  }

  onCallIce(from: string, candidate: string): void {
    if (this.phase.p !== "in-call" || from !== this.phase.peer) return;
    void this.peer?.addIceCandidate(candidate);
  }

  onCallMute(id: string, audio: boolean, video: boolean): void {
    if (this.phase.p !== "in-call" || id !== this.phase.peer) return;
    this.hooks.onPeerMute(audio, video);
  }

  onCallEnd(reason: string): void {
    if (this.phase.p === "idle") return;
    this.hooks.onLog(`call ended (${reason})`);
    this.reset();
  }

  /** A participant left an ongoing call (huddles, Phase 6). In a 1:1 the
   *  server ends the call instead, so this is defensive here. */
  onCallLeave(id: string): void {
    if (this.phase.p === "in-call" && id === this.phase.peer) this.reset();
  }

  /** A participant joined (huddles, Phase 6). No-op for 1:1. */
  onCallJoin(_user: UserBrief): void {}

  /** The realtime connection dropped: the server dropped us from the call
   *  and we cannot hear `call_end`, so tear down locally. */
  onConnectionDown(): void {
    if (this.phase.p !== "idle") {
      this.hooks.onLog("connection lost — call ended");
      this.reset();
    }
  }

  // --- internals ------------------------------------------------------------

  private peerHooks() {
    return {
      onRemoteStream: (s: MediaStream | null) => this.hooks.onRemoteStream(s),
      onIceCandidate: (c: string) => {
        if (this.phase.p === "in-call") this.send.sendCallIce(this.phase.peer, c);
      },
      onStateChange: (state: PeerState, viaRelay: boolean) =>
        this.hooks.onPeerState(state, viaRelay),
      onIceError: (detail: string) =>
        this.hooks.onLog(`ICE error: ${detail}`),
    };
  }

  private setPhase(phase: CallPhase): void {
    this.phase = phase;
    this.hooks.onPhase(phase);
  }

  private reset(): void {
    this.peer?.close();
    this.peer = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.servers = null;
    this.hooks.onLocalStream(null);
    this.hooks.onRemoteStream(null);
    this.audioOn = true;
    this.videoOn = true;
    this.hooks.onLocalMute(true, true);
    this.setPhase({ p: "idle" });
  }
}

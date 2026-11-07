//! One `RTCPeerConnection` to one call peer (README §6.1: mesh, not SFU).
//!
//! The wrapper owns exactly one connection: local tracks added once, remote
//! tracks surfaced to the UI, ICE candidates JSON-encoded for the wire
//! (README §5 `call_ice`), and `icecandidateerror` captured and logged
//! (README §11 Phase 5 "done when").

/** Connection state as shown to the user (README §6.3 quality UI). */
export type PeerState =
  | "new"
  | "connecting"
  | "connected"
  | "failed"
  | "disconnected"
  | "closed";

export interface PeerHooks {
  /** The remote MediaStream (video + audio), or null when gone. */
  onRemoteStream?: (stream: MediaStream | null) => void;
  /** One local ICE candidate, JSON-encoded for the `call_ice` wire field. */
  onIceCandidate?: (candidate: string) => void;
  /** Connection state flipped (drives the "connecting / connected" label). */
  onStateChange?: (state: PeerState, viaRelay: boolean) => void;
  /** An ICE candidate could not be processed (README §11 Phase 5). */
  onIceError?: (detail: string) => void;
}

export class RtcPeer {
  readonly pc: RTCPeerConnection;

  constructor(
    /** Our local media; its tracks are added to the connection once. */
    private localStream: MediaStream,
    /** STUN + `turns:` relay servers (README §6.2). */
    servers: RTCIceServer[],
    private hooks: PeerHooks = {},
  ) {
    this.pc = new RTCPeerConnection({ iceServers: servers });
    for (const track of localStream.getTracks()) this.pc.addTrack(track, localStream);

    this.pc.onicecandidate = (e) => {
      if (e.candidate) hooks.onIceCandidate?.(JSON.stringify(e.candidate));
    };
    this.pc.onicecandidateerror = (e) => {
      // README §11 Phase 5: capture and log ICE errors (relay tier issues,
      // blocked UDP toward the peer, …).
      console.warn(
        "icecandidateerror:",
        e.url,
        e.address,
        e.port,
        e.errorCode,
        e.errorText,
      );
      hooks.onIceError?.(e.errorText ?? `error code ${e.errorCode}`);
    };
    this.pc.ontrack = (e) => hooks.onRemoteStream?.(e.streams[0] ?? null);
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState as PeerState;
      void this.reportState(state);
    };
  }

  /** True when the selected candidate pair uses the TURN relay. */
  private async viaRelay(): Promise<boolean> {
    try {
      const stats = await this.pc.getStats();
      let localId: string | undefined;
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && s.nominated && s.selected) {
          localId = s.localCandidateId;
        }
      });
      if (!localId) return false;
      let relay = false;
      stats.forEach((s) => {
        if (s.id === localId && s.type === "local-candidate") {
          relay = s.candidateType === "relay";
        }
      });
      return relay;
    } catch {
      return false;
    }
  }

  private async reportState(state: PeerState): Promise<void> {
    this.hooks.onStateChange?.(state, await this.viaRelay());
  }

  /** Offer side: create + apply the offer, return the SDP for the wire. */
  async createOffer(): Promise<string> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer.sdp ?? "";
  }

  /** Answer side: apply the remote offer (answer is created by the caller
   *  of `createAnswer`). */
  async setRemoteOffer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "offer", sdp });
  }

  /** Answer side: create + apply the answer, return the SDP for the wire. */
  async createAnswer(): Promise<string> {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer.sdp ?? "";
  }

  /** Offer side: apply the remote answer. */
  async setRemoteAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
  }

  /** Apply one relayed candidate (JSON `RTCIceCandidateInit` from the wire). */
  async addIceCandidate(raw: string): Promise<void> {
    try {
      const cand = JSON.parse(raw) as RTCIceCandidateInit;
      await this.pc.addIceCandidate(cand);
    } catch (err) {
      console.warn("bad relayed ICE candidate:", raw, err);
    }
  }

  /** Mute / camera off: flip `track.enabled` — presence only, the server
   *  relays `call_mute`, no renegotiation (README §6.3). */
  setAudioEnabled(on: boolean): void {
    for (const t of this.localStream.getAudioTracks()) t.enabled = on;
  }

  setVideoEnabled(on: boolean): void {
    for (const t of this.localStream.getVideoTracks()) t.enabled = on;
  }

  close(): void {
    try {
      this.pc.close();
    } catch {
      // already closed
    }
  }
}

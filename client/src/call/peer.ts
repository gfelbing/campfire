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
  /** A remote track arrived: `videoIndex` counts video tracks per peer
   *  (0 = camera, 1 = screen share); audio is reported as index 0. */
  onRemoteTrack?: (stream: MediaStream, kind: string, videoIndex: number) => void;
  /** The connection needs renegotiation (a screen track was added or
   *  removed after the initial offer/answer round). */
  onNegotiationNeeded?: () => void;
  /** One local ICE candidate, JSON-encoded for the `call_ice` wire field. */
  onIceCandidate?: (candidate: string) => void;
  /** Connection state flipped (drives the "connecting / connected" label). */
  onStateChange?: (state: PeerState, viaRelay: boolean) => void;
  /** An ICE candidate could not be processed (README §11 Phase 5). */
  onIceError?: (detail: string) => void;
}

export class RtcPeer {
  readonly pc: RTCPeerConnection;
  /** True while our own offer is in flight (setLocalDescription'd, no
   *  answer yet) — the glare detector for perfect-negotiation-lite. */
  private localOfferPending = false;

  constructor(
    /** Our local media; its tracks are added to the connection once. */
    private localStream: MediaStream,
    /** STUN + `turns:` relay servers (README §6.2). */
    servers: RTCIceServer[],
    private hooks: PeerHooks = {},
    /** Perfect-negotiation-lite for the reconnect glare: when BOTH peers
     *  rejoin an active call they both offer (README §6.3 rejoin). The
     *  polite side (deterministically the smaller user id) rolls back its
     *  own offer and answers the incoming one; the impolite side keeps
     *  its offer and ignores the incoming one (its answer is in flight). */
    private polite = false,
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
    this.pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      let videoIndex = 0;
      if (e.track.kind === "video") {
        // Video tracks in transceiver-creation order: 0 = camera,
        // 1 = screen share (both sides create them in that order).
        videoIndex = Math.max(
          0,
          this.pc
            .getTransceivers()
            .filter((t) => (t.receiver.track?.kind ?? t.sender.track?.kind) === "video")
            .indexOf(e.transceiver),
        );
      }
      hooks.onRemoteTrack?.(stream, e.track.kind, videoIndex);
    };
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
    this.localOfferPending = true;
    return offer.sdp ?? "";
  }

  /** Answer side: apply the remote offer, rolling back our own pending
   *  offer when we are the polite side of a glare (both peers offered). */
  async setRemoteOffer(sdp: string): Promise<void> {
    if (this.localOfferPending) {
      if (!this.polite) throw new Error("glare: keeping our own offer");
      // Rollback our local offer, then treat the peer's offer as new.
      await this.pc.setLocalDescription({
        type: "rollback",
      } as unknown as RTCLocalSessionDescriptionInit);
    }
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    this.localOfferPending = false;
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
    this.localOfferPending = false;
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

  /** Screen share (README roadmap "UI redesign"): the screen rides as a
   *  SECOND video track next to the camera (both streams stay up). Adding
   *  a track renegotiates — `onNegotiationNeeded` drives a fresh offer. */
  addScreenTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.pc.addTrack(track, stream);
    this.negotiateOnChange();
  }

  /** Stop sending the screen (the camera keeps flowing). */
  removeScreenTrack(): void {
    const sender = this.pc.getSenders().find(
      (s) => s.track?.kind === "video" && !this.localStream.getVideoTracks().includes(s.track),
    );
    if (!sender) return;
    this.pc.removeTrack(sender);
    this.negotiateOnChange();
  }

  /** Renegotiate only for post-initial changes: the initial tracks are
   *  covered by the explicit offer/answer round, and an answerer that
   *  auto-offered would glare with every joiner. */
  private negotiateOnChange(): void {
    this.pc.onnegotiationneeded = () => this.hooks.onNegotiationNeeded?.();
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

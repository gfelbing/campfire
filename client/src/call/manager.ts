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
import { MoqUplink } from "./moq";
import { getLocalMedia, getScreenMedia, iceServers } from "./media";
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
  /** Remote media per slot (README roadmap "UI redesign": a participant
   *  can send camera AND screen at the same time). */
  camera: MediaStream | null;
  screen: MediaStream | null;
  state: PeerState;
  viaRelay: boolean;
  /** Presence from `call_mute` (default on). */
  audioOn: boolean;
  videoOn: boolean;
  /** Presence from `call_screen`: the camera track carries a screen share. */
  screenOn: boolean;
  /** `sz` (README roadmap "Map enhancements"): the sender stands inside a
   *  `silentZone` — their audio is muted locally. */
  silent: boolean;
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
  /** One peer per remote participant of *our* call (empty when idle). */
  private peers = new Map<string, RtcPeer>();
  /** Remote media per participant (camera slot + screen slot). */
  private streams = new Map<string, { camera: MediaStream | null; screen: MediaStream | null }>();
  /** Per-participant `call_mute`/`call_screen` presence. */
  private presence = new Map<string, { audio: boolean; video: boolean; screen: boolean }>();
  /** Our screen share (when `screenOn`). */
  private screenStream: MediaStream | null = null;
  /** Per-participant connection state (quality UI). */
  private connState = new Map<string, { state: PeerState; viaRelay: boolean }>();
  /** `sz` (README roadmap "Map enhancements"): peers inside a silentZone. */
  private silent = new Set<string>();
  /** The call roster including ourselves (from `call_start`/`call_join`). */
  private roster: UserBrief[] = [];
  private localStream: MediaStream | null = null;
  /** ICE servers for the current call (fetched with the local media). */
  private servers: RTCIceServer[] | null = null;
  /** MoQ uplink (docs/moq-sfu.md §9 Phase 2): publishes `localStream` to
   *  the SFU while in a call. */
  private moq: MoqUplink | null = null;
  /** Monotonic guard for in-flight uplink starts (a reset must not let a
   *  late start attach). */
  private uplinkSeq = 0;
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

  /** Screen share (README roadmap "UI redesign"): the screen rides as a
   *  second video track in every peer — the camera keeps flowing, so
   *  others see BOTH streams. Adding/removing tracks renegotiates (the
   *  sharer offers again, the others answer); the 🖥 badge on the other
   *  side comes from `call_screen` presence. */
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
      track.addEventListener("ended", () => {
        if (this.screenOn) this.stopScreenShare();
      });
      for (const p of this.peers.values()) p.addScreenTrack(track, stream);
      this.screenOn = true;
      this.send.sendCallScreen(true);
      this.hooks.onLocalScreen(true);
      this.hooks.onLog("screen share started");
    })();
  }

  /** Drop the screen track everywhere and release the capture. */
  private stopScreenShare(): void {
    if (!this.screenOn) return;
    this.screenOn = false;
    for (const p of this.peers.values()) p.removeScreenTrack();
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.send.sendCallScreen(false);
    this.hooks.onLocalScreen(false);
    this.hooks.onLog("screen share stopped");
  }

  // --- server messages (README §5) ------------------------------------------

  /** Room-wide (headphone badge) and, when we are in the roster, our
   *  authoritative bubble state: created or joined (auto-join on approach,
   *  README §6.3), or a roster re-sync while we are already in.
   *
   *  `youOffer` marks us as the designated offerer: a fresh joiner offers
   *  every existing member; on a join catch-up after a reconnect our old
   *  peer connections are dead, so we re-offer. */
  onCallStart(participants: UserBrief[], youOffer: boolean, ticket?: string): void {
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
      this.enterCall(participants, youOffer, ticket);
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
  async rejoinCall(participants: UserBrief[], ticket?: string): Promise<void> {
    if (!this.localStream) {
      // Media was released while we were away (e.g. the tab slept): we
      // cannot rejoin without a fresh mic prompt (explicit join, README
      // §6.3) — the user can "Join call" from the status panel.
      this.hooks.onLog("call ended while you were disconnected");
      this.reset();
      return;
    }
    // The MoQ session died with the dropped connection; the fresh ticket
    // from `hello` re-admits a new one (docs/moq-sfu.md §9 Phase 2).
    this.stopUplink();
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
    this.startUplink(ticket);
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
      try {
        await peer.setRemoteOffer(sdp);
        const answer = await peer.createAnswer();
        this.send.sendCallAnswer(from, answer);
      } catch (err) {
        // Expected in the impolite glare case ("keeping our own offer") —
        // our answer to *their* offer of ours is already in flight.
        this.hooks.onLog(`offer from ${from} not applied: ${String(err)}`);
      }
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
    const cur = this.presence.get(id) ?? { audio: true, video: true, screen: false };
    this.presence.set(id, { ...cur, audio, video });
    this.pushPeers();
  }

  /** Presence only (call-scoped): a peer started/stopped screen sharing. */
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
    if (changed) this.pushPeers();
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
  private enterCall(participants: UserBrief[], offer: boolean, ticket?: string): void {
    this.roster = participants;
    const others = participants.filter((u) => u.id !== this.selfId);
    for (const u of others) {
      this.ensurePeer(u);
      if (offer) void this.offerTo(u);
    }
    this.setPhase({ p: "in-call", participants: others });
    this.maybeAutoVoiceOnly();
    this.pushPeers();
    this.startUplink(ticket);
  }

  /** (Re)start the MoQ uplink with the call's fresh ticket. No ticket
   *  (server predates Phase 2) means uplink off — the WebRTC mesh still
   *  carries the call. */
  private startUplink(ticket?: string): void {
    this.stopUplink();
    if (!ticket) return;
    if (!this.localStream) return;
    const seq = ++this.uplinkSeq;
    const url = `${location.origin}/moq?ticket=${encodeURIComponent(ticket)}`;
    const name = `call/${this.room}/${this.selfId}.hang`;
    void MoqUplink.start({
      url,
      name,
      stream: this.localStream,
      onLog: (t) => this.hooks.onLog(t),
    })
      .then((u) => {
        // A reset raced the async start: drop the orphaned session.
        if (seq !== this.uplinkSeq) u.stop();
        else this.moq = u;
      })
      .catch((err) => {
        this.hooks.onLog(String(err));
      });
  }

  /** Stop the MoQ uplink (idempotent). */
  private stopUplink(): void {
    this.uplinkSeq++;
    this.moq?.stop();
    this.moq = null;
  }

  /** Open (or reuse) the peer to `user`; tracks are added once per peer. */
  private ensurePeer(user: UserBrief): void {
    if (this.peers.has(user.id) || !this.localStream || !this.servers) return;
    const servers = this.servers;
    const stream = this.localStream;
    this.peers.set(
      user.id,
      // Deterministic politeness: the lexicographically smaller id rolls
      // back on a rejoin glare, the larger keeps its own offer.
      new RtcPeer(stream, servers, {
        onRemoteTrack: (s, kind, videoIndex) => {
          const cur =
            this.streams.get(user.id) ?? { camera: null, screen: null };
          if (kind === "audio" || videoIndex === 0) cur.camera = s;
          else cur.screen = s;
          this.streams.set(user.id, cur);
          this.pushPeers();
        },
        onNegotiationNeeded: () => {
          // A screen track was added/removed after the initial round: we
          // offer again (the other side answers — no glare, only the
          // sharer renegotiates).
          void this.offerTo(user);
        },
        onIceCandidate: (c) => this.send.sendCallIce(user.id, c),
        onStateChange: (state, viaRelay) => {
          this.connState.set(user.id, { state, viaRelay });
          this.pushPeers();
        },
        onIceError: (detail) => this.hooks.onLog(`ICE error (${user.name}): ${detail}`),
      }, user.id < this.selfId),
    );
    // Sharing already? Then the new peer gets the screen track too.
    if (this.screenStream) {
      const t = this.screenStream.getVideoTracks()[0];
      if (t) this.peers.get(user.id)!.addScreenTrack(t, this.screenStream);
    }
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
        const pres = this.presence.get(u.id) ?? { audio: true, video: true, screen: false };
        return {
          id: u.id,
          name: u.name,
          camera: this.streams.get(u.id)?.camera ?? null,
          screen: this.streams.get(u.id)?.screen ?? null,
          state: st.state,
          viaRelay: st.viaRelay,
          audioOn: pres.audio,
          videoOn: pres.video,
          screenOn: pres.screen,
          silent: this.silent.has(u.id),
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
    this.stopUplink();
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.streams.clear();
    this.presence.clear();
    this.connState.clear();
    this.silent.clear();
    this.roster = [];
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.screenOn = false;
    this.hooks.onLocalScreen(false);
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

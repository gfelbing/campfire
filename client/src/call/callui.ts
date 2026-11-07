//! Call UI (README §6.3): incoming/outgoing overlays, the active-call
//! panel with video, the mute/camera/hang-up bar, per-peer connection
//! state, and the active-speaker indicator.

import type { CallPhase } from "./manager";
import type { PeerState } from "./peer";

export interface CallUiActions {
  onAccept(): void;
  onDecline(): void;
  onHangup(): void;
  onToggleMute(): void;
  onToggleCamera(): void;
}

export interface CallUI {
  setPhase(phase: CallPhase): void;
  setLocalStream(stream: MediaStream | null): void;
  setRemoteStream(stream: MediaStream | null): void;
  setPeerState(state: PeerState, viaRelay: boolean): void;
  setPeerMute(audio: boolean, video: boolean): void;
  setLocalMute(audio: boolean, video: boolean): void;
}

function stateText(state: PeerState, viaRelay: boolean): string {
  switch (state) {
    case "connected":
      return viaRelay ? "connected (via relay)" : "connected";
    case "connecting":
    case "new":
      return "connecting…";
    case "disconnected":
      return "reconnecting…";
    case "failed":
      return "connection failed";
    default:
      return state;
  }
}

export function createCallUI(container: HTMLElement, actions: CallUiActions): CallUI {
  const root = document.createElement("div");
  root.className = "call";
  root.innerHTML = `
    <div class="call-incoming hidden">
      <div class="call-incoming-card">
        <div class="call-incoming-icon">📞</div>
        <div class="call-incoming-name"></div>
        <div class="call-incoming-sub">incoming call</div>
        <div class="call-incoming-actions">
          <button class="call-accept">Accept</button>
          <button class="call-decline">Decline</button>
        </div>
      </div>
    </div>
    <div class="call-outgoing hidden">
      <span class="call-outgoing-text"></span>
      <button class="call-cancel">Cancel</button>
    </div>
    <div class="call-panel hidden">
      <div class="call-panel-header">
        <span class="call-peer-name"></span>
        <span class="call-peer-state">connecting…</span>
      </div>
      <div class="call-video-wrap">
        <video class="call-remote-video" autoplay playsinline></video>
        <video class="call-local-video" autoplay playsinline muted></video>
        <span class="call-badge call-badge-mute hidden">🔇 muted</span>
        <span class="call-badge call-badge-cam hidden">📷 camera off</span>
      </div>
      <div class="call-controls">
        <button class="call-btn call-mute" title="mute / unmute (🎤)">🎤</button>
        <button class="call-btn call-camera" title="camera on / off (📷)">📷</button>
        <button class="call-btn call-hangup" title="hang up">📞</button>
      </div>
    </div>`;
  container.appendChild(root);

  const incoming = root.querySelector<HTMLElement>(".call-incoming")!;
  const incomingName = root.querySelector<HTMLElement>(".call-incoming-name")!;
  const outgoing = root.querySelector<HTMLElement>(".call-outgoing")!;
  const outgoingText = root.querySelector<HTMLElement>(".call-outgoing-text")!;
  const panel = root.querySelector<HTMLElement>(".call-panel")!;
  const peerName = root.querySelector<HTMLElement>(".call-peer-name")!;
  const peerState = root.querySelector<HTMLElement>(".call-peer-state")!;
  const remoteVideo = root.querySelector<HTMLVideoElement>(".call-remote-video")!;
  const localVideo = root.querySelector<HTMLVideoElement>(".call-local-video")!;
  const muteBadge = root.querySelector<HTMLElement>(".call-badge-mute")!;
  const camBadge = root.querySelector<HTMLElement>(".call-badge-cam")!;
  const muteBtn = root.querySelector<HTMLButtonElement>(".call-mute")!;
  const camBtn = root.querySelector<HTMLButtonElement>(".call-camera")!;

  root.querySelector<HTMLButtonElement>(".call-accept")!.addEventListener("click", () => {
    actions.onAccept();
  });
  root.querySelector<HTMLButtonElement>(".call-decline")!.addEventListener("click", () => {
    actions.onDecline();
  });
  root.querySelector<HTMLButtonElement>(".call-cancel")!.addEventListener("click", () => {
    actions.onHangup();
  });
  muteBtn.addEventListener("click", () => actions.onToggleMute());
  camBtn.addEventListener("click", () => actions.onToggleCamera());
  root.querySelector<HTMLButtonElement>(".call-hangup")!.addEventListener("click", () => {
    actions.onHangup();
  });

  // --- active-speaker indicator (README §6.3): an analyser on the remote
  // --- audio track lights up the video border while the peer talks.
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let levelTimer: number | null = null;

  function stopLevelMeter(): void {
    if (levelTimer !== null) {
      window.clearInterval(levelTimer);
      levelTimer = null;
    }
    analyser?.disconnect();
    analyser = null;
    void audioCtx?.close().catch(() => {});
    audioCtx = null;
    remoteVideo.classList.remove("speaking");
  }

  function startLevelMeter(stream: MediaStream): void {
    stopLevelMeter();
    const audio = stream.getAudioTracks()[0];
    if (!audio || typeof AudioContext === "undefined") return;
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(new MediaStream([audio])).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    levelTimer = window.setInterval(() => {
      analyser!.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const level = sum / data.length;
      remoteVideo.classList.toggle("speaking", level > 24);
    }, 100);
  }

  return {
    setPhase(phase) {
      incoming.classList.toggle("hidden", phase.p !== "incoming");
      outgoing.classList.toggle("hidden", phase.p !== "outgoing");
      panel.classList.toggle("hidden", phase.p !== "in-call");
      if (phase.p === "incoming") incomingName.textContent = phase.name;
      if (phase.p === "outgoing") outgoingText.textContent = `Calling ${phase.name}…`;
      if (phase.p === "in-call") {
        peerName.textContent = phase.name;
        peerState.textContent = "connecting…";
        muteBadge.classList.add("hidden");
        camBadge.classList.add("hidden");
        muteBtn.classList.remove("off");
        camBtn.classList.remove("off");
      }
    },
    setLocalStream(stream) {
      localVideo.srcObject = stream;
    },
    setRemoteStream(stream) {
      remoteVideo.srcObject = stream;
      if (stream) startLevelMeter(stream);
      else stopLevelMeter();
    },
    setPeerState(state, viaRelay) {
      peerState.textContent = stateText(state, viaRelay);
      panel.dataset.state = state;
    },
    setPeerMute(audio, video) {
      muteBadge.classList.toggle("hidden", audio);
      camBadge.classList.toggle("hidden", video);
    },
    setLocalMute(audio, video) {
      muteBtn.classList.toggle("off", !audio);
      camBtn.classList.toggle("off", !video);
    },
  };
}

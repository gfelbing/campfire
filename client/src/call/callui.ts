//! Call UI (README §6.3): the active-bubble panel with a video grid (one
//! tile per remote participant + local PiP), per-tile connection state /
//! mute / camera / active-speaker indicators, and the mute/camera/hang-up
//! bar. Joining is automatic (proximity), so there are no ring/accept
//! overlays — walking away is how you leave.

import type { CallPhase, PeerView } from "./manager";
import type { PeerState } from "./peer";

export interface CallUiActions {
  onHangup(): void;
  onToggleMute(): void;
  onToggleCamera(): void;
}

export interface CallUI {
  setPhase(phase: CallPhase): void;
  setLocalStream(stream: MediaStream | null): void;
  /** Update the grid from the manager's roster (create/update/remove tiles). */
  setPeers(peers: PeerView[]): void;
  setLocalMute(audio: boolean, video: boolean): void;
}

/** Aggregate the per-peer states into one panel-level label. */
function aggregateState(peers: PeerView[]): { text: string; state: PeerState } {
  if (peers.length === 0) return { text: "waiting for peers…", state: "new" };
  const has = (s: PeerState) => peers.some((p) => p.state === s);
  if (has("failed")) return { text: "connection problem", state: "failed" };
  const connected = peers.filter((p) => p.state === "connected");
  const viaRelay = connected.some((p) => p.viaRelay);
  if (connected.length === peers.length) {
    return { text: viaRelay ? "connected (via relay)" : "connected", state: "connected" };
  }
  if (has("disconnected")) return { text: "reconnecting…", state: "disconnected" };
  return { text: "connecting…", state: "connecting" };
}

interface Tile {
  id: string;
  el: HTMLElement;
  video: HTMLVideoElement;
  nameEl: HTMLElement;
  stateEl: HTMLElement;
  muteEl: HTMLElement;
  camEl: HTMLElement;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  data: Uint8Array<ArrayBuffer> | null;
}

export function createCallUI(container: HTMLElement, actions: CallUiActions): CallUI {
  const root = document.createElement("div");
  root.className = "call";
  root.innerHTML = `
    <div class="call-panel hidden">
      <div class="call-panel-header">
        <span class="call-peer-name"></span>
        <span class="call-peer-state">connecting…</span>
      </div>
      <div class="call-grid"></div>
      <video class="call-pip" autoplay playsinline muted></video>
      <div class="call-controls">
        <button class="call-btn call-mute" title="mute / unmute (🎤)">🎤</button>
        <button class="call-btn call-camera" title="camera on / off (📷)">📷</button>
        <button class="call-btn call-hangup" title="leave the call">📞</button>
      </div>
    </div>`;
  container.appendChild(root);

  const panel = root.querySelector<HTMLElement>(".call-panel")!;
  const peerName = root.querySelector<HTMLElement>(".call-peer-name")!;
  const peerState = root.querySelector<HTMLElement>(".call-peer-state")!;
  const grid = root.querySelector<HTMLElement>(".call-grid")!;
  const pip = root.querySelector<HTMLVideoElement>(".call-pip")!;
  const muteBtn = root.querySelector<HTMLButtonElement>(".call-mute")!;
  const camBtn = root.querySelector<HTMLButtonElement>(".call-camera")!;

  muteBtn.addEventListener("click", () => actions.onToggleMute());
  camBtn.addEventListener("click", () => actions.onToggleCamera());
  root.querySelector<HTMLButtonElement>(".call-hangup")!.addEventListener("click", () => {
    actions.onHangup();
  });

  // --- tiles: one per remote participant, created/updated in place -------
  // --- (rebuilding <video> elements would restart the streams).
  const tiles = new Map<string, Tile>();
  /** Shared AudioContext for the per-tile level meters (README §6.3). */
  let audioCtx: AudioContext | null = null;
  let levelTimer: number | null = null;

  function ensureCtx(): AudioContext | null {
    if (typeof AudioContext === "undefined") return null;
    if (!audioCtx) {
      audioCtx = new AudioContext();
      void audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function makeTile(p: PeerView): Tile {
    const el = document.createElement("div");
    el.className = "call-tile";
    el.innerHTML = `
      <video autoplay playsinline></video>
      <div class="call-tile-info"><span class="tile-name"></span><span class="tile-state"></span></div>
      <span class="call-badge tile-mute hidden">🔇</span>
      <span class="call-badge tile-cam hidden">📷 off</span>`;
    const video = el.querySelector<HTMLVideoElement>("video")!;
    const tile: Tile = {
      id: p.id,
      el,
      video,
      nameEl: el.querySelector<HTMLElement>(".tile-name")!,
      stateEl: el.querySelector<HTMLElement>(".tile-state")!,
      muteEl: el.querySelector<HTMLElement>(".tile-mute")!,
      camEl: el.querySelector<HTMLElement>(".tile-cam")!,
      stream: null,
      source: null,
      analyser: null,
      data: null,
    };
    grid.appendChild(el);
    return tile;
  }

  /** Detach the tile's level meter (audio source + analyser). */
  function stopMeter(t: Tile): void {
    t.source?.disconnect();
    t.source = null;
    t.analyser?.disconnect();
    t.analyser = null;
    t.data = null;
    t.video.classList.remove("speaking");
    if (tiles.size === 0) {
      if (levelTimer !== null) {
        window.clearInterval(levelTimer);
        levelTimer = null;
      }
      void audioCtx?.close().catch(() => {});
      audioCtx = null;
    }
  }

  function destroyTile(t: Tile): void {
    stopMeter(t);
    t.el.remove();
  }

  /** Attach (or re-attach) the tile's level meter to its stream. */
  function startMeter(t: Tile, stream: MediaStream): void {
    stopMeter(t);
    const ctx = ensureCtx();
    const audio = stream.getAudioTracks()[0];
    if (!ctx || !audio) return;
    const source = ctx.createMediaStreamSource(new MediaStream([audio]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    t.source = source;
    t.analyser = analyser;
    t.data = new Uint8Array(analyser.frequencyBinCount);
    if (levelTimer === null) {
      // 10 Hz (README §6.3): one pass over all tiles per tick.
      levelTimer = window.setInterval(() => {
        for (const tile of tiles.values()) {
          if (!tile.analyser || !tile.data) {
            tile.video.classList.remove("speaking");
            continue;
          }
          tile.analyser.getByteFrequencyData(tile.data);
          let sum = 0;
          for (let i = 0; i < tile.data.length; i++) sum += tile.data[i];
          tile.video.classList.toggle("speaking", sum / tile.data.length > 24);
        }
      }, 100);
    }
  }

  function updateTile(t: Tile, p: PeerView): void {
    t.nameEl.textContent = p.name;
    t.stateEl.textContent = stateText(p.state, p.viaRelay);
    t.muteEl.classList.toggle("hidden", p.audioOn);
    t.camEl.classList.toggle("hidden", p.videoOn);
    if (p.stream !== t.stream) {
      t.stream = p.stream;
      t.video.srcObject = p.stream;
      if (p.stream) startMeter(t, p.stream);
      else stopMeter(t);
    }
  }

  return {
    setPhase(phase) {
      panel.classList.toggle("hidden", phase.p !== "in-call" && phase.p !== "joining");
      if (phase.p === "in-call") {
        peerName.textContent = `Proximity call · ${phase.participants.length + 1}`;
      }
      if (phase.p === "joining") {
        peerName.textContent = "Joining call…";
        peerState.textContent = "connecting…";
        panel.dataset.state = "connecting";
      }
      if (phase.p === "in-call" || phase.p === "joining") {
        muteBtn.classList.remove("off");
        camBtn.classList.remove("off");
      }
    },
    setLocalStream(stream) {
      pip.srcObject = stream;
    },
    setPeers(peers) {
      const seen = new Set<string>();
      for (const p of peers) {
        seen.add(p.id);
        let t = tiles.get(p.id);
        if (!t) {
          t = makeTile(p);
          tiles.set(p.id, t);
        }
        updateTile(t, p);
      }
      for (const [id, t] of tiles) {
        if (!seen.has(id)) {
          tiles.delete(id);
          destroyTile(t);
        }
      }
      if (phaseVisible()) {
        const agg = aggregateState(peers);
        peerState.textContent = agg.text;
        panel.dataset.state = agg.state;
      }
    },
    setLocalMute(audio, video) {
      muteBtn.classList.toggle("off", !audio);
      camBtn.classList.toggle("off", !video);
    },
  };

  function phaseVisible(): boolean {
    return !panel.classList.contains("hidden");
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
}

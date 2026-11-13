//! Call theater (README roadmap "UI redesign"): while in a bubble, remote
//! video streams stack in a column on the right side, over the map, with a
//! local PiP tile. The mic/camera/screen controls live in the top bar
//! (global buttons); the theater itself only keeps the hang-up button.
//! Every stream is its own tile — a participant can send camera AND screen
//! at once, so a sharer appears twice. Remote video is a `<canvas>` the MoQ
//! downlink paints (docs/moq-sfu.md §9 Phase 3); the local PiP stays a
//! `<video>` on `localStream`. Clicking a stream focuses it large in
//! the center overlay; clicking again (or Escape) unfocuses. Joining is
//! automatic (proximity), so there are no ring or accept overlays —
//! walking away is how you leave.

import type { CallPhase, DownlinkState, PeerView } from "./manager";

export interface CallUiActions {
  onHangup(): void;
}

export interface CallUI {
  setPhase(phase: CallPhase): void;
  setLocalStream(stream: MediaStream | null): void;
  /** Update the column from the manager's roster (create/update/remove). */
  setPeers(peers: PeerView[]): void;
}

interface Tile {
  /** Tile key: `<peerId>:cam` or `<peerId>:scr`. */
  key: string;
  el: HTMLElement;
  /** The downlink's paint target (a `<canvas>`), once wired. */
  media: HTMLCanvasElement | null;
  nameEl: HTMLElement;
  stateEl: HTMLElement;
  /** Downlink latency label (e2e delay + transport RTT), live tiles only. */
  latencyEl: HTMLElement;
  /** E2e-delay sparkline (the last ~90 s at the 1 Hz refresh). */
  spark: HTMLCanvasElement | null;
  /** Delay samples behind the sparkline (ring; trimmed at SPARK_LEN). */
  sparkSamples: number[];
  muteEl: HTMLElement;
  camEl: HTMLElement;
  screenEl: HTMLElement;
  /** The downlink's audio MediaStream (level meter), once wired. */
  stream: MediaStream | null;
  /** Only camera tiles get a level meter (the screen stream has no audio). */
  meter: boolean;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  data: Uint8Array<ArrayBuffer> | null;
}

/** Aggregate the per-peer states into one column-level label. */
function aggregateState(peers: PeerView[]): { text: string; state: DownlinkState } {
  if (peers.length === 0) return { text: "waiting for peers…", state: "subscribing" };
  const has = (s: DownlinkState) => peers.some((p) => p.state === s);
  if (has("offline")) return { text: "connection problem", state: "offline" };
  if (peers.every((p) => p.state === "live")) {
    return { text: "live", state: "live" };
  }
  return { text: "subscribing…", state: "subscribing" };
}

function stateText(state: DownlinkState): string {
  switch (state) {
    case "live":
      return "live";
    case "subscribing":
      return "subscribing…";
    case "offline":
      return "no signal";
    default:
      return state;
  }
}

/** Sparkline length (samples): ~90 s at the 1 Hz roster refresh. */
const SPARK_LEN = 90;
/** Sparkline canvas size (CSS px = canvas px; the tile is small). */
const SPARK_W = 60;
const SPARK_H = 20;

/** Draw the tile's e2e-delay history (last SPARK_LEN samples, right edge =
 *  now). A flat delay renders as a flat line near the bottom; the y-scale
 *  is the running max so a delay spike is visible without reflow. */
function drawSpark(t: Tile): void {
  const c = t.spark;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const s = t.sparkSamples;
  ctx.clearRect(0, 0, SPARK_W, SPARK_H);
  if (s.length < 2) return;
  let max = 0;
  for (const v of s) max = Math.max(max, v);
  // Floor the scale at the entry delay (1 s, video-catch-up work) so the
  // line is readable from the first second and does not reflow as the
  // entry sample ages out of the ring.
  max = Math.max(max, 1000);
  ctx.beginPath();
  const step = SPARK_W / (SPARK_LEN - 1);
  for (let i = 0; i < s.length; i++) {
    const x = SPARK_W - (s.length - 1 - i) * step;
    const y = SPARK_H - 1 - (s[i] / max) * (SPARK_H - 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function createCallUI(container: HTMLElement, actions: CallUiActions): CallUI {
  const root = document.createElement("div");
  root.className = "theater hidden";
  root.innerHTML = `
    <div class="theater-col">
      <div class="theater-resize" title="drag to resize"></div>
      <div class="theater-header">
        <span class="theater-name"></span>
        <span class="theater-state">connecting…</span>
        <button class="call-btn call-hangup" title="leave the call">📞</button>
      </div>
      <div class="theater-tiles">
        <div class="theater-tile local"><video class="theater-pip" autoplay playsinline muted></video>
          <div class="theater-tile-info"><span class="tile-name">you</span></div></div>
      </div>
    </div>
    <div class="theater-focus hidden">
      <div class="theater-focus-slot"></div>
      <div class="theater-focus-hint">click or press Escape to unfocus</div>
    </div>`;
  container.appendChild(root);

  const col = root.querySelector<HTMLElement>(".theater-col")!;
  const theaterName = root.querySelector<HTMLElement>(".theater-name")!;
  const theaterState = root.querySelector<HTMLElement>(".theater-state")!;
  const tilesEl = root.querySelector<HTMLElement>(".theater-tiles")!;
  const localTile = root.querySelector<HTMLElement>(".theater-tile.local")!;
  const pip = root.querySelector<HTMLVideoElement>(".theater-pip")!;
  const focus = root.querySelector<HTMLElement>(".theater-focus")!;
  const focusSlot = root.querySelector<HTMLElement>(".theater-focus-slot")!;

  root.querySelector<HTMLButtonElement>(".call-hangup")!.addEventListener("click", () => {
    actions.onHangup();
  });

  // --- tiles: one per stream slot, created/updated in place ---------------
  // --- (rebuilding <video> elements would restart the streams).
  const tiles = new Map<string, Tile>();
  /** Shared AudioContext for the per-tile level meters (README §6.3). */
  let audioCtx: AudioContext | null = null;
  let levelTimer: number | null = null;
  /** Key of the tile currently shown large in the center overlay. */
  let focused: string | null = null;

  function ensureCtx(): AudioContext | null {
    if (typeof AudioContext === "undefined") return null;
    if (!audioCtx) {
      audioCtx = new AudioContext();
      void audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  /** Detach the tile's level meter (audio source + analyser). */
  function stopMeter(t: Tile): void {
    t.source?.disconnect();
    t.source = null;
    t.analyser?.disconnect();
    t.analyser = null;
    t.data = null;
    t.media?.classList.remove("speaking");
    if (levelTimer !== null && ![...tiles.values()].some((x) => x.analyser)) {
      window.clearInterval(levelTimer);
      levelTimer = null;
      void audioCtx?.close().catch(() => {});
      audioCtx = null;
    }
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
          if (!tile.meter || !tile.analyser || !tile.data) {
            tile.media?.classList.remove("speaking");
            continue;
          }
          tile.analyser.getByteFrequencyData(tile.data);
          let sum = 0;
          for (let i = 0; i < tile.data.length; i++) sum += tile.data[i];
          tile.media?.classList.toggle("speaking", sum / tile.data.length > 24);
        }
      }, 100);
    }
  }

  function makeTile(key: string, name: string, screen: boolean): Tile {
    const el = document.createElement("div");
    el.className = `theater-tile${screen ? " screen" : ""}`;
    el.innerHTML = `
      <div class="theater-tile-info"><span class="tile-name"></span><span class="tile-state"></span><canvas class="tile-spark" width="${SPARK_W}" height="${SPARK_H}"></canvas><span class="tile-latency hidden"></span></div>
      <span class="call-badge tile-mute hidden">🔇</span>
      <span class="call-badge tile-cam hidden">📷 off</span>
      <span class="call-badge tile-screen hidden">🖥</span>`;
    const tile: Tile = {
      key,
      el,
      media: null,
      nameEl: el.querySelector<HTMLElement>(".tile-name")!,
      stateEl: el.querySelector<HTMLElement>(".tile-state")!,
      latencyEl: el.querySelector<HTMLElement>(".tile-latency")!,
      spark: el.querySelector<HTMLCanvasElement>(".tile-spark"),
      sparkSamples: [],
      muteEl: el.querySelector<HTMLElement>(".tile-mute")!,
      camEl: el.querySelector<HTMLElement>(".tile-cam")!,
      screenEl: el.querySelector<HTMLElement>(".tile-screen")!,
      stream: null,
      meter: !screen,
      source: null,
      analyser: null,
      data: null,
    };
    tile.nameEl.textContent = screen ? `${name} · screen` : name;
    tile.screenEl.classList.toggle("hidden", !screen);
    // Focus toggle: click a tile to show it large in the center; click the
    // focused one again (or Escape) to unfocus.
    el.addEventListener("click", () => {
      if (focused === key) unfocus();
      else focusTile(key);
    });
    // New tiles go above the local PiP tile (the local one stays last).
    tilesEl.insertBefore(el, localTile);
    return tile;
  }

  function updateTile(t: Tile, name: string, state: DownlinkState, canvas: HTMLCanvasElement | null, stream: MediaStream | null, audioOn: boolean, videoOn: boolean, delay: number, rtt: number | null, width = 0, height = 0): void {
    t.nameEl.textContent = t.key.endsWith(":scr") ? `${name} · screen` : name;
    t.stateEl.textContent = stateText(state);
    // Latency: e2e playback delay (how far the canvas trails the live
    // edge) plus the transport RTT of our signaling connection — a proxy
    // for the path to the SFU. The RTT part is omitted when the transport
    // cannot measure it (SSE fallback, or no `WebTransport.getStats()`).
    // The sparkline tracks the e2e delay over the last ~90 s.
    if (state === "live") {
      t.latencyEl.textContent =
        rtt != null
          ? `${Math.round(delay)} ms · RTT ${Math.round(rtt)} ms`
          : `${Math.round(delay)} ms`;
      if (width > 0 && height > 0) t.latencyEl.textContent += ` · ${width}×${height}`;
      t.latencyEl.classList.remove("hidden");
      t.sparkSamples.push(delay);
      if (t.sparkSamples.length > SPARK_LEN) t.sparkSamples.shift();
      drawSpark(t);
    } else {
      t.latencyEl.classList.add("hidden");
      t.sparkSamples.length = 0;
      drawSpark(t);
    }
    t.muteEl.classList.toggle("hidden", audioOn);
    t.camEl.classList.toggle("hidden", videoOn);
    // Camera off (issues.md #3): the canvas keeps the last decoded frame;
    // hide it so the stale image does not show to others' viewers.
    t.media?.classList.toggle("hidden", !videoOn);
    // The downlink's canvas is the paint target; move it in when it first
    // appears (rebuilding it would restart the decode pipeline).
    if (canvas !== t.media) {
      t.media?.remove();
      t.media = canvas;
      if (canvas) t.el.prepend(canvas);
    }
    if (stream !== t.stream) {
      t.stream = stream;
      if (stream && t.meter) startMeter(t, stream);
      else stopMeter(t);
    }
  }

  // --- focus overlay --------------------------------------------------------

  function focusTile(key: string): void {
    const t = tiles.get(key);
    if (!t || !t.media) return;
    focused = key;
    focusSlot.appendChild(t.media); // the same element: decoding keeps going
    focus.classList.remove("hidden");
  }

  function unfocus(): void {
    const t = focused !== null ? tiles.get(focused) : undefined;
    focused = null;
    focus.classList.add("hidden");
    if (t?.media) t.el.prepend(t.media); // back into the column
  }

  focus.addEventListener("click", () => unfocus());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && focused !== null) unfocus();
  });

  // --- width adjustment -----------------------------------------------------
  // Drag the left-edge handle; the width persists in the browser. The tiles
  // follow the width, keeping their 16:9 aspect ratio (pure CSS).
  col.addEventListener("pointerdown", (e) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>(".theater-resize");
    if (!handle) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = col.getBoundingClientRect().width;
    const move = (ev: PointerEvent): void => {
      // The handle sits on the column's LEFT edge: dragging left widens.
      const w = Math.round(
        Math.min(640, Math.max(180, startW + (startX - ev.clientX))),
      );
      col.style.width = `${w}px`;
    };
    const up = (ev: PointerEvent): void => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      try {
        localStorage.setItem("campfire.theater.width", col.style.width);
      } catch {
        // private mode etc.: the width just does not persist
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  try {
    const w = parseInt(localStorage.getItem("campfire.theater.width") ?? "", 10);
    if (Number.isFinite(w) && w >= 180 && w <= 640) col.style.width = `${w}px`;
  } catch {
    // no persistence: stay with the default width
  }

  return {
    setPhase(phase) {
      root.classList.toggle("hidden", phase.p !== "in-call" && phase.p !== "joining");
      if (phase.p === "joining") {
        theaterName.textContent = "Joining call…";
        theaterState.textContent = "connecting…";
        col.dataset.state = "connecting";
      }
      if (phase.p === "in-call") {
        theaterName.textContent = `Proximity call · ${phase.participants.length + 1}`;
      }
      // Call over (or participant tile gone) → drop the focus overlay.
      if (phase.p === "idle") unfocus();
    },
    setLocalStream(stream) {
      pip.srcObject = stream;
    },
    setPeers(peers) {
      // One view per stream slot: camera always, screen when present.
      interface View {
        key: string;
        name: string;
        screen: boolean;
        canvas: HTMLCanvasElement | null;
        stream: MediaStream | null;
        state: DownlinkState;
        delay: number;
        rtt: number | null;
        audioOn: boolean;
        videoOn: boolean;
        /** Decoded resolution, px (0x0 until the first frame). */
        width: number;
        height: number;
      }
      const views: View[] = [];
      for (const p of peers) {
        views.push({
          key: `${p.id}:cam`,
          name: p.name,
          screen: false,
          canvas: p.camera,
          stream: p.cameraStream,
          state: p.state,
          delay: p.delay,
          rtt: p.rtt,
          audioOn: p.audioOn,
          videoOn: p.videoOn,
          width: p.width,
          height: p.height,
        });
        if (p.screen) {
          views.push({
            key: `${p.id}:scr`,
            name: p.name,
            screen: true,
            canvas: p.screen,
            stream: null, // the screen share carries no audio
            state: p.state,
            delay: p.delay,
            rtt: p.rtt,
            audioOn: true,
            videoOn: true,
            width: p.width,
            height: p.height,
          });
        }
      }
      const seen = new Set<string>();
      for (const v of views) {
        seen.add(v.key);
        let t = tiles.get(v.key);
        if (!t) {
          t = makeTile(v.key, v.name, v.screen);
          tiles.set(v.key, t);
        }
        updateTile(t, v.name, v.state, v.canvas, v.stream, v.audioOn, v.videoOn, v.delay, v.rtt, v.width, v.height);
      }
      for (const [key, t] of tiles) {
        if (!seen.has(key)) {
          if (focused === key) unfocus();
          tiles.delete(key);
          stopMeter(t);
          t.el.remove();
        }
      }
      const agg = aggregateState(peers);
      theaterState.textContent = agg.text;
      // Map onto the column's CSS state colors (green/red).
      col.dataset.state =
        agg.state === "live" ? "connected" : agg.state === "offline" ? "failed" : "connecting";
      tilesEl.dataset.empty = peers.length === 0 ? "1" : "0";
    },
  };
}

//! Call theater (README roadmap "UI redesign"): while in a bubble, remote
//! video streams stack in a column on the right side, over the map, with a
//! local PiP tile. The mic/camera/screen controls live in the top bar
//! (global buttons); the theater itself only keeps the hang-up button.
//! Every stream is its own tile — a participant can send camera AND screen
//! at once, so a sharer appears twice. Remote video is a `<canvas>` the MoQ
//! downlink paints (docs/arch/moq-sfu.md); the local PiP stays a
//! `<video>` on `localStream`. Clicking a stream focuses it large in
//! the center overlay; clicking again (or Escape) unfocuses. Joining is
//! automatic (proximity), so there are no ring or accept overlays —
//! walking away is how you leave.

import type { CallPhase, DownlinkState, PeerView } from "./manager";
import { iconNode } from "../ui/pixicons";

export interface CallUiActions {
  onHangup(): void;
}

export interface CallUI {
  setPhase(phase: CallPhase): void;
  setLocalStream(stream: MediaStream | null): void;
  /** Our camera toggled: the local PiP hides while off (a frozen last
   *  frame, like the remote tiles hide theirs). */
  setLocalVideo(on: boolean): void;
  /** Update the column from the manager's roster (create/update/remove). */
  setPeers(peers: PeerView[]): void;
  /** A camera tile's audio level (0-255 average, 10 Hz): toggles the
   *  tile's "speaking" highlight. */
  setPeerLevel(id: string, level: number): void;
}

interface Tile {
  /** Tile key: `<peerId>:cam` or `<peerId>:scr`. */
  key: string;
  el: HTMLElement;
  /** The downlink's paint target (a `<canvas>`), once wired. */
  media: HTMLCanvasElement | null;
  nameEl: HTMLElement;
  stateEl: HTMLElement;
  /** Downlink latency label (video/audio e2e delays + transport RTT),
   *  live tiles only. */
  latencyEl: HTMLElement;
  latencyVEl: HTMLElement;
  latencyAEl: HTMLElement;
  /** E2e-delay sparkline, video + audio (the last ~90 s at the 1 Hz
   *  refresh). */
  spark: HTMLCanvasElement | null;
  /** Delay samples behind the sparklines (rings; trimmed at SPARK_LEN). */
  sparkVideo: number[];
  sparkAudio: number[];
  muteEl: HTMLElement;
  camEl: HTMLElement;
  screenEl: HTMLElement;
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
/** Sparkline + latency-label colors, video and audio: the tile's latency
 *  spans reuse the same two values, so the numbers and their lines read
 *  as a pair (video = blue, audio = the speaking-pulse green). */
const SPARK_VIDEO_COLOR = "#6cb0e0";
const SPARK_AUDIO_COLOR = "#4d9e57";

/** Draw the tile's e2e-delay history (last SPARK_LEN samples, right edge =
 *  now): one line per medium, video (blue) in the upper band, audio
 *  (green) in the lower band, both sharing the running max scale so a
 *  delay spike is visible without reflow. A flat delay renders as a flat
 *  line near its band's bottom. */
function drawSpark(t: Tile): void {
  const c = t.spark;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const v = t.sparkVideo;
  const a = t.sparkAudio;
  ctx.clearRect(0, 0, SPARK_W, SPARK_H);
  if (v.length < 2 && a.length < 2) return;
  let max = 0;
  for (const s of v) max = Math.max(max, s);
  for (const s of a) max = Math.max(max, s);
  // Floor the scale at the steady video delay (400 ms) so the lines are
  // readable and do not reflow as small samples age out of the ring.
  max = Math.max(max, 400);
  // Two bands, audio underneath: half the canvas height each (minus a
  // px of padding), so the lines never overdraw each other.
  const bandH = Math.floor(SPARK_H / 2) - 1;
  const draw = (samples: number[], color: string, bandTop: number): void => {
    if (samples.length < 2) return;
    ctx.beginPath();
    const step = SPARK_W / (SPARK_LEN - 1);
    for (let i = 0; i < samples.length; i++) {
      const x = SPARK_W - (samples.length - 1 - i) * step;
      const y = bandTop + bandH - 1 - (samples[i] / max) * (bandH - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  draw(v, SPARK_VIDEO_COLOR, 0);
  draw(a, SPARK_AUDIO_COLOR, bandH + 1);
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
        <button class="call-btn call-hangup" title="leave the call"></button>
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

  root.querySelector<HTMLButtonElement>(".call-hangup")!.replaceChildren(
    iconNode("hangup", 16),
  );
  root.querySelector<HTMLButtonElement>(".call-hangup")!.addEventListener("click", () => {
    actions.onHangup();
  });

  // --- tiles: one per stream slot, created/updated in place ---------------
  // --- (rebuilding <video> elements would restart the streams).
  const tiles = new Map<string, Tile>();
  /** Key of the tile currently shown large in the center overlay. */
  let focused: string | null = null;

  function makeTile(key: string, name: string, screen: boolean): Tile {
    const el = document.createElement("div");
    el.className = `theater-tile${screen ? " screen" : ""}`;
    el.innerHTML = `
      <div class="theater-tile-info"><span class="tile-name"></span><span class="tile-state"></span><canvas class="tile-spark" width="${SPARK_W}" height="${SPARK_H}"></canvas><span class="tile-latency hidden"><span class="tile-lat-v"></span>/<span class="tile-lat-a"></span><span class="tile-lat-extra"></span></span></div>
      <span class="call-badge tile-mute hidden" title="microphone muted"></span>
      <span class="call-badge tile-cam hidden" title="camera off"></span>
      <span class="call-badge tile-screen hidden" title="sharing their screen"></span>`;
    const tile: Tile = {
      key,
      el,
      media: null,
      nameEl: el.querySelector<HTMLElement>(".tile-name")!,
      stateEl: el.querySelector<HTMLElement>(".tile-state")!,
      latencyEl: el.querySelector<HTMLElement>(".tile-latency")!,
      latencyVEl: el.querySelector<HTMLElement>(".tile-lat-v")!,
      latencyAEl: el.querySelector<HTMLElement>(".tile-lat-a")!,
      spark: el.querySelector<HTMLCanvasElement>(".tile-spark"),
      sparkVideo: [],
      sparkAudio: [],
      muteEl: el.querySelector<HTMLElement>(".tile-mute")!,
      camEl: el.querySelector<HTMLElement>(".tile-cam")!,
      screenEl: el.querySelector<HTMLElement>(".tile-screen")!,
    };
    tile.nameEl.textContent = screen ? `${name} · screen` : name;
    tile.screenEl.classList.toggle("hidden", !screen);
    // Pixel badges (the old emoji): drawn once per tile.
    tile.muteEl.replaceChildren(iconNode("mic-off", 14));
    tile.camEl.replaceChildren(iconNode("camera", 14));
    tile.screenEl.replaceChildren(iconNode("screen", 14));
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

  function updateTile(t: Tile, name: string, state: DownlinkState, canvas: HTMLCanvasElement | null, audioOn: boolean, videoOn: boolean, delayVideo: number, delayAudio: number, rtt: number | null, width = 0, height = 0): void {
    const label = t.key.endsWith(":scr") ? `${name} · screen` : name;
    // 1 Hz roster pushes: only touch the DOM when the text changed.
    if (t.nameEl.textContent !== label) t.nameEl.textContent = label;
    const stateLabel = stateText(state);
    if (t.stateEl.textContent !== stateLabel) t.stateEl.textContent = stateLabel;
    // Latency: e2e playback delay per medium (how far the playback trails
    // the live edge, on the video and audio clocks — the two Sync
    // instances drift freely by design) plus the transport RTT of our
    // signaling connection — a proxy for the path to the SFU. The RTT
    // part is omitted when the transport cannot measure it (SSE
    // fallback, or no `WebTransport.getStats()`). The two numbers' colors
    // match the sparkline's two lines (video = blue, audio = green).
    // The sparklines track the per-medium e2e delay over the last ~90 s.
    if (state === "live") {
      const v = `${Math.round(delayVideo)}`;
      const a = `${Math.round(delayAudio)}`;
      if (t.latencyVEl.textContent !== v) t.latencyVEl.textContent = v;
      if (t.latencyAEl.textContent !== a) t.latencyAEl.textContent = a;
      const extra = [
        rtt != null ? `RTT ${Math.round(rtt)} ms` : null,
        width > 0 && height > 0 ? `${width}×${height}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const extraText = extra ? ` ms · ${extra}` : " ms";
      if (t.latencyEl.dataset.extra !== extraText) {
        t.latencyEl.dataset.extra = extraText;
        t.latencyEl.lastElementChild!.textContent = extraText;
      }
      t.latencyEl.classList.remove("hidden");
      t.sparkVideo.push(delayVideo);
      t.sparkAudio.push(delayAudio);
      if (t.sparkVideo.length > SPARK_LEN) t.sparkVideo.shift();
      if (t.sparkAudio.length > SPARK_LEN) t.sparkAudio.shift();
      drawSpark(t);
    } else {
      t.latencyEl.classList.add("hidden");
      t.latencyEl.dataset.extra = "";
      t.latencyVEl.textContent = "";
      t.latencyAEl.textContent = "";
      t.sparkVideo.length = 0;
      t.sparkAudio.length = 0;
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
    setLocalVideo(on) {
      pip.classList.toggle("hidden", !on);
    },
    setPeers(peers) {
      // One view per stream slot: camera always, screen when present.
      interface View {
        key: string;
        name: string;
        screen: boolean;
        canvas: HTMLCanvasElement | null;
        state: DownlinkState;
        /** E2e playback delay, video and audio clocks (ms). */
        delayVideo: number;
        delayAudio: number;
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
          state: p.state,
          delayVideo: p.delayVideo,
          delayAudio: p.delay,
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
            state: p.state,
            delayVideo: p.delayVideo,
            delayAudio: p.delay,
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
        updateTile(t, v.name, v.state, v.canvas, v.audioOn, v.videoOn, v.delayVideo, v.delayAudio, v.rtt, v.width, v.height);
      }
      for (const [key, t] of tiles) {
        if (!seen.has(key)) {
          if (focused === key) unfocus();
          tiles.delete(key);
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
    setPeerLevel(id, level) {
      // Camera tiles only (the screen share carries no audio). The level
      // comes from the downlink's analyser (moq.ts), 10 Hz.
      const t = tiles.get(`${id}:cam`);
      t?.media?.classList.toggle("speaking", level > 24);
    },
  };
}

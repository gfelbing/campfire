// Top bar (Google Chat style, one line across the whole app). Left: the
// burger toggling the sidebar + the Campfire logo + the map switcher (list
// from `GET /api/v1/maps`; picking one navigates through the same
// leave-and-reload as room switching). Right: the global 🎤/📷 buttons
// (mute and camera work in and out of a call; the preference is applied
// when a call starts), the 🖥 screen-share button (in-call only) and the
// profile button — it opens the full-page identity layer
// (`ui/profile.ts`); the presence status lives in its own menu here.
//
// Identity changes rejoin the room (the identity is fixed at join, so
// a change navigates away and back with the new values); status applies
// immediately and also governs call behavior (see call/manager.ts).

import type { OwnStatus } from "../net/types";
import type { SidebarUI } from "./sidebar";
import { previewCell, variantFor } from "../world/characters";
import type { Identity } from "./profile";

interface MapInfo {
  id: string;
  name: string;
}

const STATUSES: Array<{ id: OwnStatus; label: string }> = [
  { id: "online", label: "Online" },
  { id: "away", label: "Away" },
  { id: "dnd", label: "Do not disturb" },
];

export interface HeaderOptions {
  name: string;
  color: string;
  /** The chosen pixel-art character; `null` = derived from the name. */
  character: number | null;
  /** The joined presence status. */
  status: OwnStatus;
  onSwitchMap: (map: string) => void;
  /** Open the full-page identity layer (`ui/profile.ts`). */
  onOpenProfile: () => void;
  /** Presence status changed (persisted + announced by `setStatus`). */
  onStatusChange: (status: OwnStatus) => void;
  /** Global mic toggle (works in and out of a call). */
  onToggleMute(): void;
  /** Global camera toggle (works in and out of a call). */
  onToggleCamera(): void;
  /** Screen-share toggle (only offered while in a call). */
  onToggleScreen(): void;
}

export interface HeaderUI {
  /** The current presence status (no side effects). */
  status(): OwnStatus;
  /** Change the presence status (persisted, UI + `onStatusChange`). */
  setStatus(s: OwnStatus): void;
  /** Update the 🎤/📷 button styling from the call manager. */
  setMute(audio: boolean, video: boolean): void;
  /** Update the 🖥 button styling (our own share on/off). */
  setScreen(on: boolean): void;
  /** Show/hide the 🖥 screen-share button (offered only in a call). */
  setInCall(inCall: boolean): void;
  /** The confirmed identity (after a setup/edit layer): refreshes the
   *  profile button's character preview. */
  setIdentity(identity: Identity): void;
}

export function createHeader(
  sidebar: SidebarUI,
  currentMap: string,
  opts: HeaderOptions,
): HeaderUI {
  const topbar = document.getElementById("topbar")!;
  const burger = topbar.querySelector<HTMLButtonElement>("#burger")!;
  const mapBtn = topbar.querySelector<HTMLButtonElement>("#map-btn")!;
  const mapList = topbar.querySelector<HTMLElement>("#map-list")!;
  const micBtn = topbar.querySelector<HTMLButtonElement>("#mic-btn")!;
  const camBtn = topbar.querySelector<HTMLButtonElement>("#cam-btn")!;
  const screenBtn = topbar.querySelector<HTMLButtonElement>("#screen-btn")!;
  const profileBtn = topbar.querySelector<HTMLButtonElement>("#profile-btn")!;
  const statusBtn = topbar.querySelector<HTMLButtonElement>("#status-btn")!;
  const statusMenu = topbar.querySelector<HTMLElement>("#status-menu")!;

  // --- left: burger + logo --------------------------------------------------

  burger.addEventListener("click", () => sidebar.toggle());

  // --- right: global media buttons -------------------------------------------

  micBtn.addEventListener("click", () => opts.onToggleMute());
  camBtn.addEventListener("click", () => opts.onToggleCamera());
  screenBtn.addEventListener("click", () => opts.onToggleScreen());

  // --- map switcher -----------------------------------------------------------

  let maps: MapInfo[] = [];
  const current = currentMap;

  function mapName(id: string): string {
    return maps.find((m) => m.id === id)?.name ?? id;
  }

  function renderMapBtn(): void {
    mapBtn.textContent = `${mapName(current)} ▾`;
  }

  async function renderMapList(): Promise<void> {
    mapList.replaceChildren();
    try {
      const res = await fetch("/api/v1/maps");
      if (res.ok) maps = (await res.json()) as MapInfo[];
    } catch {
      // fetch failed: keep the previous list (possibly empty)
    }
    renderMapBtn();
    if (maps.length === 0) {
      const empty = document.createElement("div");
      empty.className = "map-empty";
      empty.textContent = "no maps found";
      mapList.appendChild(empty);
      return;
    }
    for (const m of maps) {
      const b = document.createElement("button");
      b.className = "map-item" + (m.id === current ? " current" : "");
      b.textContent = m.name;
      b.title = m.id;
      b.addEventListener("click", () => {
        closeAll();
        if (m.id !== current) opts.onSwitchMap(m.id);
      });
      mapList.appendChild(b);
    }
  }

  // --- right: profile ---------------------------------------------------------

  // The committed identity: the profile button renders its character
  // thumbnail; the draft editing happens in the full-page layer
  // (`ui/profile.ts`), opened by the button.
  const identity = { name: opts.name, color: opts.color, character: opts.character };
  let status = opts.status;

  // Status rows live in their own topbar popover (issues.md #1); the
  // identity drafts live in the full-page layer (`ui/profile.ts`).
  for (const s of STATUSES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "map-item profile-status";
    const dot = document.createElement("span");
    dot.className = `sdot ${s.id}`;
    const label = document.createElement("span");
    label.textContent = s.label;
    b.append(dot, label);
    b.addEventListener("click", () => {
      applyStatus(s.id);
      closeAll();
    });
    statusMenu.appendChild(b);
  }

  /** The profile button shows the joined character (the same thumbnail
   *  the picker uses) instead of the name's initial; the initial stays
   *  as the fallback for the sheets-not-loaded state. */
  function renderProfileAvatar(): void {
    profileBtn.querySelector<HTMLElement>(".sdot")!.className = `sdot ${status}`;
    profileBtn.title = STATUSES.find((s) => s.id === status)!.label;
    const initial = profileBtn.querySelector<HTMLElement>(".status-initial")!;
    const cell = previewCell(identity.character ?? variantFor(identity.name), identity.color);
    if (!cell) {
      initial.classList.remove("hidden");
      profileBtn.style.background = identity.color;
      return;
    }
    initial.classList.add("hidden");
    profileBtn.style.background = "#1c1f26";
    let canvas = profileBtn.querySelector<HTMLCanvasElement>("canvas.character-face");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "character-face";
      profileBtn.prepend(canvas);
    }
    canvas.width = cell.width;
    canvas.height = cell.height;
    canvas.getContext("2d")!.drawImage(cell, 0, 0);
  }

  function renderStatusRows(): void {
    for (let i = 0; i < statusMenu.children.length; i++) {
      (statusMenu.children[i] as HTMLElement).classList.toggle("current", STATUSES[i].id === status);
    }
    statusBtn.querySelector<HTMLElement>(".sdot")!.className = `sdot ${status}`;
  }

  /** Shared status-change path (popover clicks and `ui.setStatus`). */
  function applyStatus(s: OwnStatus): void {
    status = s;
    renderProfileAvatar();
    renderStatusRows();
    opts.onStatusChange(s);
  }

  // --- open / close ---------------------------------------------------------------

  function closeAll(): void {
    mapList.classList.add("hidden");
    statusMenu.classList.add("hidden");
  }

  mapBtn.addEventListener("click", () => {
    const willOpen = mapList.classList.contains("hidden");
    closeAll();
    if (willOpen) {
      mapList.classList.remove("hidden");
      void renderMapList();
    }
  });

  profileBtn.addEventListener("click", () => {
    closeAll();
    opts.onOpenProfile();
  });

  statusBtn.addEventListener("click", () => {
    const willOpen = statusMenu.classList.contains("hidden");
    closeAll();
    if (willOpen) {
      renderStatusRows();
      statusMenu.classList.remove("hidden");
    }
  });

  // A click outside the top bar, or Escape, closes the top bar's popovers
  // (the map and status menus); the identity layer manages itself.
  document.addEventListener("click", (e) => {
    if (!topbar.contains(e.target as Node)) closeAll();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAll();
  });

  renderMapBtn();
  renderProfileAvatar();
  renderStatusRows();

  return {
    status: () => status,
    setStatus: (s) => applyStatus(s),
    setIdentity: (next) => {
      Object.assign(identity, next);
      renderProfileAvatar();
    },
    setMute: (audio, video) => {
      micBtn.classList.toggle("off", !audio);
      micBtn.title = audio ? "mute the microphone (🎤)" : "unmute the microphone (🎤)";
      camBtn.classList.toggle("off", !video);
      camBtn.title = video ? "turn the camera off (📷)" : "turn the camera on (📷)";
    },
    setScreen: (on) => {
      screenBtn.classList.toggle("on", on);
      screenBtn.title = on ? "stop sharing the screen (🖥)" : "share the screen (🖥)";
    },
    setInCall: (inCall) => {
      screenBtn.classList.toggle("hidden", !inCall);
    },
  };
}

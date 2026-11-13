// Top bar (Google Chat style, one line across the whole app). Left: the
// burger toggling the sidebar + the Campfire logo + the map switcher (list
// from `GET /api/v1/maps`; picking one navigates through the same
// leave-and-reload as room switching). Right: the global 🎤/📷 buttons
// (mute and camera work in and out of a call; the preference is applied
// when a call starts), the 🖥 screen-share button (in-call only) and the
// profile button — a popover to change your name, avatar color and status
// (online / away / do not disturb).
//
// Name and color changes rejoin the room (the identity is fixed at join, so
// a change navigates away and back with the new values); status applies
// immediately and also governs call behavior (see call/manager.ts).

import { COLORS, saveIdentity, saveStatus } from "./boot";
import type { OwnStatus } from "../net/types";
import type { SidebarUI } from "./sidebar";

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
  /** The joined presence status. */
  status: OwnStatus;
  onSwitchMap: (map: string) => void;
  /** Rejoin the room with a new identity (name and/or color changed). */
  onIdentityChange: (name: string, color: string) => void;
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
  const profileMenu = topbar.querySelector<HTMLElement>("#profile-menu")!;

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

  // Identity drafts: they start at the joined values and only commit (rejoin)
  // on "Done". Status applies immediately via `setStatus`.
  let name = opts.name;
  let color = opts.color;
  const committedName = opts.name;
  const committedColor = opts.color;
  let status = opts.status;

  // Build the profile popover once; it is shown/hidden, not rebuilt, so the
  // name input keeps focus while editing.
  const nameInput = document.createElement("input");
  nameInput.className = "profile-name-input";
  nameInput.maxLength = 24;
  nameInput.placeholder = "your name";
  nameInput.autocomplete = "off";
  nameInput.value = name;
  const swatches = document.createElement("div");
  swatches.className = "profile-swatches";
  const statusRows = document.createElement("div");
  statusRows.className = "profile-status-rows";
  const nameError = document.createElement("div");
  nameError.className = "profile-error hidden";
  const doneBtn = document.createElement("button");
  doneBtn.className = "profile-done";
  doneBtn.textContent = "Done";

  nameInput.addEventListener("input", () => {
    name = nameInput.value;
    nameError.classList.add("hidden");
    renderProfileAvatar();
  });

  for (const c of COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.color = c;
    b.style.background = c;
    b.setAttribute("aria-label", `color ${c}`);
    b.addEventListener("click", () => {
      color = c;
      syncSwatchSelection();
      renderProfileAvatar();
    });
    swatches.appendChild(b);
  }

  for (const s of STATUSES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "profile-status";
    const dot = document.createElement("span");
    dot.className = `sdot ${s.id}`;
    const label = document.createElement("span");
    label.textContent = s.label;
    b.append(dot, label);
    b.addEventListener("click", () => {
      applyStatus(s.id);
    });
    statusRows.appendChild(b);
  }

  doneBtn.addEventListener("click", () => {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 24) {
      nameError.textContent = "Name must be 1–24 characters.";
      nameError.classList.remove("hidden");
      return;
    }
    name = trimmed;
    saveIdentity(name, color);
    closeAll();
    if (name !== committedName || color !== committedColor) {
      opts.onIdentityChange(name, color);
    }
  });

  // Assemble the popover (labels built as text nodes to stay XSS-safe).
  const label = (t: string): HTMLDivElement => {
    const d = document.createElement("div");
    d.className = "profile-label";
    d.textContent = t;
    return d;
  };
  profileMenu.append(
    label("Name"),
    nameInput,
    nameError,
    label("Color"),
    swatches,
    label("Status"),
    statusRows,
    doneBtn,
  );

  function renderProfileAvatar(): void {
    profileBtn.style.background = color;
    profileBtn.querySelector<HTMLElement>(".status-initial")!.textContent =
      name.trim().charAt(0).toUpperCase();
    profileBtn.querySelector<HTMLElement>(".sdot")!.className = `sdot ${status}`;
    profileBtn.title = STATUSES.find((s) => s.id === status)!.label;
  }

  function renderStatusRows(): void {
    for (let i = 0; i < statusRows.children.length; i++) {
      (statusRows.children[i] as HTMLElement).classList.toggle("current", STATUSES[i].id === status);
    }
  }

  function syncSwatchSelection(): void {
    for (const s of swatches.children) {
      (s as HTMLElement).classList.toggle("selected", (s as HTMLElement).dataset.color === color);
    }
  }

  /** Shared status-change path (row clicks and `ui.setStatus`). */
  function applyStatus(s: OwnStatus): void {
    status = s;
    saveStatus(s);
    renderProfileAvatar();
    renderStatusRows();
    opts.onStatusChange(s);
  }

  // --- open / close ---------------------------------------------------------------

  function closeAll(): void {
    mapList.classList.add("hidden");
    profileMenu.classList.add("hidden");
  }

  function discardDraft(): void {
    name = committedName;
    color = committedColor;
    nameInput.value = name;
    syncSwatchSelection();
    renderProfileAvatar();
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
    const willOpen = profileMenu.classList.contains("hidden");
    closeAll();
    if (willOpen) {
      renderProfileAvatar();
      renderStatusRows();
      syncSwatchSelection();
      profileMenu.classList.remove("hidden");
    }
  });

  // A click outside the top bar, or Escape, closes the popovers; closing the
  // profile without "Done" discards the unapplied name/color draft.
  document.addEventListener("click", (e) => {
    if (!topbar.contains(e.target as Node)) {
      if (!profileMenu.classList.contains("hidden")) discardDraft();
      closeAll();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!profileMenu.classList.contains("hidden")) discardDraft();
      closeAll();
    }
  });

  renderMapBtn();
  renderProfileAvatar();
  renderStatusRows();

  return {
    status: () => status,
    setStatus: (s) => applyStatus(s),
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

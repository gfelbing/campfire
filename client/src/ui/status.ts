// Connection + room status, top right (README §8), with the call button:
// a room-mate picker when no call is running, a "Join call" action when a
// huddle is active and we are not in it, hidden while we are in a call
// (README §6.3). Plus the room switcher (README §11 Phase 7): lists the
// active rooms from `GET /api/v1/rooms`; switching leaves this room
// immediately and reloads into the other one.

import type { UserBrief } from "../net/types";

export type ConnState = "connected" | "reconnecting" | "disconnected";

interface RoomInfo {
  room: string;
  map: string;
  users: number;
}

export interface StatusUI {
  setRoom(room: string): void;
  setUsers(n: number): void;
  bumpUsers(delta: number): void;
  /** Room-mates we can ring (already excludes ourselves). */
  setCallTargets(users: UserBrief[]): void;
  /** Is the room's call running, and are we in it? */
  setCallState(active: boolean, inCall: boolean): void;
  setConn(s: ConnState): void;
}

function userText(n: number): string {
  return `${n} user${n === 1 ? "" : "s"}`;
}

export function createStatus(
  container: HTMLElement,
  onCall: (u: UserBrief) => void,
  onJoinHuddle: () => void,
  onSwitchRoom: (room: string) => void,
): StatusUI {
  const panel = document.createElement("div");
  panel.className = "status";
  panel.innerHTML = `
    <div class="status-room"></div>
    <div class="status-users"></div>
    <div class="status-conn"><span class="dot"></span><span class="text"></span></div>
    <div class="status-call-row">
      <button class="status-call-btn" title="Call someone in this room">📞</button>
      <button class="status-rooms-btn" title="Switch room">🚪</button>
    </div>
    <div class="status-call-list hidden"></div>
    <div class="status-room-list hidden"></div>`;
  container.appendChild(panel);

  const roomEl = panel.querySelector<HTMLElement>(".status-room")!;
  const usersEl = panel.querySelector<HTMLElement>(".status-users")!;
  const connEl = panel.querySelector<HTMLElement>(".status-conn")!;
  const connText = connEl.querySelector<HTMLElement>(".text")!;
  const callBtn = panel.querySelector<HTMLButtonElement>(".status-call-btn")!;
  const callList = panel.querySelector<HTMLElement>(".status-call-list")!;
  const roomsBtn = panel.querySelector<HTMLButtonElement>(".status-rooms-btn")!;
  const roomList = panel.querySelector<HTMLElement>(".status-room-list")!;

  let users = 0;
  let targets: UserBrief[] = [];
  let callActive = false;
  let inCall = false;
  let currentRoom = "";

  /** The button: hidden in a call, "Join call" when a huddle is running,
   *  ring-picker otherwise. */
  function renderCallButton(): void {
    if (inCall) {
      callBtn.classList.add("hidden");
      callList.classList.add("hidden");
      return;
    }
    callBtn.classList.remove("hidden");
    if (callActive) {
      callBtn.classList.add("join");
      callBtn.textContent = "📞 Join call";
      callBtn.title = "Join the room huddle";
      callList.classList.add("hidden");
    } else {
      callBtn.classList.remove("join");
      callBtn.textContent = "📞";
      callBtn.title = "Call someone in this room";
    }
  }

  function renderList(): void {
    callList.innerHTML = "";
    if (targets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "status-call-empty";
      empty.textContent = "no one else here";
      callList.appendChild(empty);
      return;
    }
    for (const u of targets) {
      const b = document.createElement("button");
      b.className = "status-call-user";
      b.textContent = u.name;
      b.addEventListener("click", () => {
        callList.classList.add("hidden");
        onCall(u);
      });
      callList.appendChild(b);
    }
  }

  callBtn.addEventListener("click", () => {
    if (callActive) {
      // A huddle is running: join it (the joiner is the offerer, README §6.3).
      onJoinHuddle();
      return;
    }
    roomList.classList.add("hidden");
    callList.classList.toggle("hidden");
    if (!callList.classList.contains("hidden")) renderList();
  });

  // --- room switcher (README §11 Phase 7) ---------------------------------
  // Lists the active rooms; picking one leaves this room immediately and
  // reloads into the other (main.ts does the navigate).
  async function renderRooms(): Promise<void> {
    roomList.innerHTML = "";
    let rooms: RoomInfo[] = [];
    try {
      const res = await fetch("/api/v1/rooms");
      if (res.ok) rooms = (await res.json()) as RoomInfo[];
    } catch {
      // fetch failed: fall through to the "no rooms" note
    }
    if (rooms.length === 0) {
      const empty = document.createElement("div");
      empty.className = "status-call-empty";
      empty.textContent = "only this room is active";
      roomList.appendChild(empty);
      return;
    }
    for (const r of rooms) {
      const b = document.createElement("button");
      b.className = "status-room-item";
      b.textContent = `${r.room} · ${r.users} ${r.users === 1 ? "user" : "users"}`;
      if (r.room === currentRoom) b.classList.add("current");
      b.addEventListener("click", () => {
        roomList.classList.add("hidden");
        if (r.room !== currentRoom) onSwitchRoom(r.room);
      });
      roomList.appendChild(b);
    }
  }

  roomsBtn.addEventListener("click", () => {
    callList.classList.add("hidden");
    roomList.classList.toggle("hidden");
    if (!roomList.classList.contains("hidden")) void renderRooms();
  });

  // Close the pickers on any click outside of them.
  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target as Node)) {
      callList.classList.add("hidden");
      roomList.classList.add("hidden");
    }
  });

  return {
    setRoom: (room) => {
      roomEl.textContent = room;
      currentRoom = room;
    },
    setUsers: (n) => {
      users = n;
      usersEl.textContent = userText(n);
    },
    bumpUsers: (delta) => {
      users = Math.max(0, users + delta);
      usersEl.textContent = userText(users);
    },
    setCallTargets: (list) => {
      targets = list;
      if (!callList.classList.contains("hidden")) renderList();
    },
    setCallState: (active, us) => {
      callActive = active;
      inCall = us;
      renderCallButton();
    },
    setConn: (s) => {
      panel.dataset.conn = s;
      connText.textContent = s;
    },
  };
}

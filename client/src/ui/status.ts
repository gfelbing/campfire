// Connection + room status, top right (README §8), with the bubble toggle
// (README §6.3): opt out of proximity calls entirely, or back in. Plus the
// room switcher (README §11 Phase 7): lists the active rooms from
// `GET /api/v1/rooms`; switching leaves this room immediately and reloads
// into the other one.

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
  /** Is the room's call running, and are we in it? (badge) */
  setCallState(active: boolean, inCall: boolean): void;
  setConn(s: ConnState): void;
}

function userText(n: number): string {
  return `${n} user${n === 1 ? "" : "s"}`;
}

export function createStatus(
  container: HTMLElement,
  onBubbleOff: (off: boolean) => void,
  onSwitchRoom: (room: string) => void,
): StatusUI {
  const panel = document.createElement("div");
  panel.className = "status";
  panel.innerHTML = `
    <div class="status-room"></div>
    <div class="status-users"></div>
    <div class="status-conn"><span class="dot"></span><span class="text"></span></div>
    <div class="status-call-row">
      <button class="status-bubble-btn" title="Proximity calls are on — click to turn them off">🔊</button>
      <button class="status-rooms-btn" title="Switch room">🚪</button>
    </div>
    <div class="status-room-list hidden"></div>`;
  container.appendChild(panel);

  const roomEl = panel.querySelector<HTMLElement>(".status-room")!;
  const usersEl = panel.querySelector<HTMLElement>(".status-users")!;
  const connEl = panel.querySelector<HTMLElement>(".status-conn")!;
  const connText = connEl.querySelector<HTMLElement>(".text")!;
  const bubbleBtn = panel.querySelector<HTMLButtonElement>(".status-bubble-btn")!;
  const roomsBtn = panel.querySelector<HTMLButtonElement>(".status-rooms-btn")!;
  const roomList = panel.querySelector<HTMLElement>(".status-room-list")!;

  let users = 0;
  let currentRoom = "";
  /** Our bubble opt-out state (README §6.3). */
  let bubbleOff = false;

  function renderBubbleButton(): void {
    bubbleBtn.textContent = bubbleOff ? "🔇" : "🔊";
    bubbleBtn.title = bubbleOff
      ? "Proximity calls are off — click to turn them back on"
      : "Proximity calls are on — click to turn them off";
    bubbleBtn.classList.toggle("off", bubbleOff);
  }

  bubbleBtn.addEventListener("click", () => {
    bubbleOff = !bubbleOff;
    renderBubbleButton();
    onBubbleOff(bubbleOff);
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
    roomList.classList.toggle("hidden");
    if (!roomList.classList.contains("hidden")) void renderRooms();
  });

  // Close the pickers on any click outside of them.
  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target as Node)) {
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
    setCallState: (active, us) => {
      // Kept for parity with the badge state in main.ts; the toggle here
      // only controls our own opt-out.
      void active;
      void us;
    },
    setConn: (s) => {
      panel.dataset.conn = s;
      connText.textContent = s;
    },
  };
}

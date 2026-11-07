// Connection + room status, top right (README §8), with the call button:
// a room-mate picker when no call is running, a "Join call" action when a
// huddle is active and we are not in it, hidden while we are in a call
// (README §6.3).

import type { UserBrief } from "../net/types";

export type ConnState = "connected" | "reconnecting" | "disconnected";

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
): StatusUI {
  const panel = document.createElement("div");
  panel.className = "status";
  panel.innerHTML = `
    <div class="status-room"></div>
    <div class="status-users"></div>
    <div class="status-conn"><span class="dot"></span><span class="text"></span></div>
    <div class="status-call-row">
      <button class="status-call-btn" title="Call someone in this room">📞</button>
    </div>
    <div class="status-call-list hidden"></div>`;
  container.appendChild(panel);

  const roomEl = panel.querySelector<HTMLElement>(".status-room")!;
  const usersEl = panel.querySelector<HTMLElement>(".status-users")!;
  const connEl = panel.querySelector<HTMLElement>(".status-conn")!;
  const connText = connEl.querySelector<HTMLElement>(".text")!;
  const callBtn = panel.querySelector<HTMLButtonElement>(".status-call-btn")!;
  const callList = panel.querySelector<HTMLElement>(".status-call-list")!;

  let users = 0;
  let targets: UserBrief[] = [];
  let callActive = false;
  let inCall = false;

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
    callList.classList.toggle("hidden");
    if (!callList.classList.contains("hidden")) renderList();
  });

  // Close the picker on any click outside of it.
  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target as Node)) callList.classList.add("hidden");
  });

  return {
    setRoom: (room) => {
      roomEl.textContent = room;
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

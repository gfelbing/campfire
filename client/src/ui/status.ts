// Connection + room status, top right (README §8).

export type ConnState = "connected" | "reconnecting" | "disconnected";

export interface StatusUI {
  setRoom(room: string): void;
  setUsers(n: number): void;
  bumpUsers(delta: number): void;
  setConn(s: ConnState): void;
}

function userText(n: number): string {
  return `${n} user${n === 1 ? "" : "s"}`;
}

export function createStatus(container: HTMLElement): StatusUI {
  const panel = document.createElement("div");
  panel.className = "status";
  panel.innerHTML = `
    <div class="status-room"></div>
    <div class="status-users"></div>
    <div class="status-conn"><span class="dot"></span><span class="text"></span></div>`;
  container.appendChild(panel);

  const roomEl = panel.querySelector<HTMLElement>(".status-room")!;
  const usersEl = panel.querySelector<HTMLElement>(".status-users")!;
  const connEl = panel.querySelector<HTMLElement>(".status-conn")!;
  const connText = connEl.querySelector<HTMLElement>(".text")!;

  let users = 0;

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
    setConn: (s) => {
      panel.dataset.conn = s;
      connText.textContent = s;
    },
  };
}

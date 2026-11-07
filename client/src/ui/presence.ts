// Presence roster, top left (README §8 Phase 7): who is in the room right
// now, with the 🎧 badge for users in the room's call. Full rebuild on
// every `hello` (reconnect/room-switch catch-up), incremental otherwise.

import type { UserBrief, UserState } from "../net/types";

export interface PresenceUI {
  /** Full roster + in-call set (hello / re-hello). */
  setUsers(users: UserState[], inCall: Set<string>): void;
  /** A new room member (`joined`). */
  addUser(u: UserBrief): void;
  /** A room member left (`left`). */
  removeUser(id: string): void;
  /** Re-render the 🎧 badges after a call-state change. */
  setInCall(inCall: Set<string>): void;
}

export function createPresence(container: HTMLElement): PresenceUI {
  const panel = document.createElement("div");
  panel.className = "presence";
  panel.innerHTML = `
    <div class="presence-title">in this room</div>
    <ul class="presence-list"></ul>`;
  container.appendChild(panel);

  const list = panel.querySelector<HTMLOListElement>(".presence-list")!;
  // Roster order is join order (server map order is stable enough for a
  // v1 roster); the call set only re-renders badges.
  const members = new Map<string, string>(); // id → name
  let inCall = new Set<string>();

  function badge(id: string): boolean {
    return inCall.has(id);
  }

  function row(id: string, name: string): HTMLLIElement {
    const li = document.createElement("li");
    li.dataset.id = id;
    const label = document.createElement("span");
    label.className = "presence-name";
    label.textContent = name;
    li.appendChild(label);
    if (badge(id)) {
      const b = document.createElement("span");
      b.className = "presence-call";
      b.textContent = "🎧";
      li.appendChild(b);
    }
    return li;
  }

  function renderAll(): void {
    list.replaceChildren(...[...members.entries()].map(([id, name]) => row(id, name)));
  }

  function renderBadges(): void {
    for (const li of list.children) {
      const id = (li as HTMLElement).dataset.id!;
      li.querySelector(".presence-call")?.remove();
      if (badge(id)) {
        const b = document.createElement("span");
        b.className = "presence-call";
        b.textContent = "🎧";
        li.appendChild(b);
      }
    }
  }

  return {
    setUsers: (users, call) => {
      inCall = new Set(call);
      members.clear();
      for (const u of users) members.set(u.id, u.name);
      renderAll();
    },
    addUser: (u) => {
      if (members.has(u.id)) return;
      members.set(u.id, u.name);
      list.appendChild(row(u.id, u.name));
    },
    removeUser: (id) => {
      if (!members.delete(id)) return;
      const li = list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(id)}"]`);
      li?.remove();
    },
    setInCall: (call) => {
      inCall = new Set(call);
      renderBadges();
    },
  };
}

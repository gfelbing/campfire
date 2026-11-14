// Presence roster, top left (docs/arch/client.md): who is in the room right
// now, with the 🎧 badge for users in the room's call. Full rebuild on
// every `hello` (reconnect/room-switch catch-up), incremental otherwise.

import type { OwnStatus, UserBrief, UserState } from "../net/types";

export interface PresenceUI {
  /** Full roster + in-call set (hello / re-hello). */
  setUsers(users: UserState[], inCall: Set<string>): void;
  /** A new room member (`joined`). */
  addUser(u: UserBrief): void;
  /** A room member left (`left`). */
  removeUser(id: string): void;
  /** Re-render the 🎧 badges after a call-state change. */
  setInCall(inCall: Set<string>): void;
  /** Toggle the 🔇 do-not-disturb badge (silentZone occupancy). */
  setDnd(id: string, on: boolean): void;
  /** A member's presence status changed (`status`); absent = `online`. */
  setStatus(id: string, status: OwnStatus): void;
}

export function createPresence(container: HTMLElement): PresenceUI {
  const panel = document.createElement("div");
  panel.className = "presence";
  panel.innerHTML = `<ul class="presence-list"></ul>`;
  container.appendChild(panel);

  const list = panel.querySelector<HTMLOListElement>(".presence-list")!;
  // Roster order is join order (server map order is stable enough for a
  // v1 roster); the call set only re-renders badges.
  const members = new Map<string, string>(); // id → name
  let inCall = new Set<string>();
  const dnd = new Set<string>();
  // id → presence status (absent = `online`).
  const statusOf = new Map<string, OwnStatus>();

  function badge(id: string): boolean {
    return inCall.has(id);
  }

  function decorate(li: HTMLLIElement, id: string): void {
    li.querySelector(".presence-call, .presence-dnd")?.remove();
    if (badge(id)) {
      const b = document.createElement("span");
      b.className = "presence-call";
      b.textContent = "🎧";
      li.appendChild(b);
    }
    if (dnd.has(id)) {
      const b = document.createElement("span");
      b.className = "presence-dnd";
      b.textContent = "🔇";
      li.appendChild(b);
    }
  }

  function row(id: string, name: string): HTMLLIElement {
    const li = document.createElement("li");
    li.dataset.id = id;
    const dot = document.createElement("span");
    dot.className = `presence-status ${statusOf.get(id) ?? "online"}`;
    const label = document.createElement("span");
    label.className = "presence-name";
    label.textContent = name;
    li.append(dot, label);
    decorate(li, id);
    return li;
  }

  function renderAll(): void {
    list.replaceChildren(...[...members.entries()].map(([id, name]) => row(id, name)));
  }

  function renderBadges(): void {
    for (const li of list.children) {
      const id = (li as HTMLElement).dataset.id!;
      decorate(li as HTMLLIElement, id);
    }
  }

  return {
    setUsers: (users, call) => {
      inCall = new Set(call);
      members.clear();
      statusOf.clear();
      for (const u of users) {
        members.set(u.id, u.name);
        if (u.status && u.status !== "online") statusOf.set(u.id, u.status);
        // The snapshot carries silentZone occupancy; stale ids fall away
        // with the roster.
        if (u.sz) dnd.add(u.id);
        else dnd.delete(u.id);
      }
      renderAll();
    },
    addUser: (u) => {
      if (members.has(u.id)) return;
      members.set(u.id, u.name);
      if (u.status && u.status !== "online") statusOf.set(u.id, u.status);
      list.appendChild(row(u.id, u.name));
    },
    removeUser: (id) => {
      if (!members.delete(id)) return;
      statusOf.delete(id);
      const li = list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(id)}"]`);
      li?.remove();
    },
    setInCall: (call) => {
      inCall = new Set(call);
      renderBadges();
    },
    setDnd: (id, on) => {
      if (on ? dnd.has(id) : !dnd.has(id)) return;
      if (on) dnd.add(id);
      else dnd.delete(id);
      const li = list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(id)}"]`);
      if (li) decorate(li as HTMLLIElement, id);
    },
    setStatus: (id, status) => {
      if (status === "online") statusOf.delete(id);
      else statusOf.set(id, status);
      const li = list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(id)}"]`);
      li?.querySelector(".presence-status")?.replaceWith(
        Object.assign(document.createElement("span"), {
          className: `presence-status ${statusOf.get(id) ?? "online"}`,
        }),
      );
    },
  };
}

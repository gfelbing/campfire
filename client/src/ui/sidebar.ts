//! Sidebar (README roadmap "UI redesign"): two accordion sections — Users,
//! Chat — next to the map, not over it. The map canvas resizes with it;
//! collapsing (the header's burger) folds it to a narrow icon rail, and a
//! section header collapses just that section.

export interface SidebarUI {
  /** The body element of a section (to mount a panel into). */
  pane(id: "players" | "chat"): HTMLElement;
  /** A chat mention-ish hint: dot on the Chat header while it is hidden. */
  chatActivity(on: boolean): void;
  /** Update the member count shown on the Users header. */
  setUserCount(n: number): void;
  /** Collapse/expand the whole rail (the header's burger); returns the new state. */
  toggle(): boolean;
}

export function createSidebar(): SidebarUI {
  const sidebar = document.getElementById("sidebar")!;
  const usersCount = sidebar.querySelector<HTMLElement>("#users-count")!;
  const chatSection = sidebar.querySelector<HTMLElement>('.accordion[data-acc="chat"]')!;
  const chatDot = chatSection.querySelector<HTMLElement>(".acc-dot")!;

  // Always start collapsed (the header's burger or a rail icon expands it);
  // the state is per-session, so a stale "open" can never stick around.
  sidebar.classList.add("collapsed");

  function section(id: string): HTMLElement {
    return sidebar.querySelector<HTMLElement>(`.accordion[data-acc="${id}"]`)!;
  }

  // A rail icon expands the sidebar and its section.
  for (const b of sidebar.querySelectorAll<HTMLButtonElement>(".sidebar-rail [data-open]")) {
    b.addEventListener("click", () => {
      sidebar.classList.remove("collapsed");
      section(b.dataset.open!).classList.remove("closed");
      if (b.dataset.open === "chat") chatDot.hidden = true;
    });
  }

  // A section header collapses/expands just that section.
  for (const h of sidebar.querySelectorAll<HTMLButtonElement>(".accordion-header")) {
    h.addEventListener("click", () => {
      const nowClosed = section(h.dataset.toggle!).classList.toggle("closed");
      if (h.dataset.toggle === "chat" && !nowClosed) chatDot.hidden = true;
    });
  }

  function chatVisible(): boolean {
    return !sidebar.classList.contains("collapsed") && !chatSection.classList.contains("closed");
  }

  return {
    pane: (id) => sidebar.querySelector<HTMLElement>(`[data-pane="${id}"]`)!,
    setUserCount: (n) => {
      usersCount.textContent = String(n);
    },
    chatActivity(on) {
      chatDot.hidden = !(on && !chatVisible());
    },
    toggle: () => sidebar.classList.toggle("collapsed"),
  };
}

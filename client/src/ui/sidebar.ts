//! Sidebar (README roadmap "UI redesign"): two accordion sections — Users,
//! Chat — next to the map, not over it. The map canvas resizes with it;
//! collapsing (the header's burger) folds it to a narrow icon rail, and a
//! section header collapses just that section.

export interface SidebarUI {
  /** The body element of a section (to mount a panel into). */
  pane(id: "players" | "chat" | "bubble"): HTMLElement;
  /** A chat mention-ish hint: dot on the Chat header while it is hidden. */
  chatActivity(on: boolean): void;
  /** A new bubble-chat line: dot on the Bubble chat header while hidden. */
  bubbleActivity(on: boolean): void;
  /** Whether the room chat panel is currently visible (toasts gate on it). */
  chatOpen(): boolean;
  /** Whether the bubble chat panel is currently visible. */
  bubbleOpen(): boolean;
  /** Show/hide the bubble chat (rail icon + accordion); only offered
   *  while in a call (issues.md #2). */
  setBubbleVisible(on: boolean): void;
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
  const bubbleSection = sidebar.querySelector<HTMLElement>('.accordion[data-acc="bubble"]')!;
  const bubbleDot = bubbleSection.querySelector<HTMLElement>(".acc-dot")!;
  const bubbleRail = sidebar.querySelector<HTMLButtonElement>('.sidebar-rail [data-open="bubble"]')!;
  // The rail icons carry the same unread dot as the section headers, so a
  // collapsed sidebar still shows new chat activity.
  const chatRailDot = sidebar.querySelector<HTMLElement>('.sidebar-rail [data-open="chat"] .acc-dot')!;
  const bubbleRailDot = sidebar.querySelector<HTMLElement>('.sidebar-rail [data-open="bubble"] .acc-dot')!;

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
      if (b.dataset.open === "chat") {
        chatDot.hidden = true;
        chatRailDot.hidden = true;
      }
      if (b.dataset.open === "bubble") {
        bubbleDot.hidden = true;
        bubbleRailDot.hidden = true;
      }
    });
  }

  // A section header collapses/expands just that section.
  for (const h of sidebar.querySelectorAll<HTMLButtonElement>(".accordion-header")) {
    h.addEventListener("click", () => {
      const nowClosed = section(h.dataset.toggle!).classList.toggle("closed");
      if (h.dataset.toggle === "chat" && !nowClosed) chatDot.hidden = true;
      if (h.dataset.toggle === "bubble" && !nowClosed) bubbleDot.hidden = true;
    });
  }

  function chatVisible(): boolean {
    return !sidebar.classList.contains("collapsed") && !chatSection.classList.contains("closed");
  }

  function bubbleVisible(): boolean {
    return !sidebar.classList.contains("collapsed") && !bubbleSection.classList.contains("closed");
  }

  return {
    pane: (id) => sidebar.querySelector<HTMLElement>(`[data-pane="${id}"]`)!,
    setUserCount: (n) => {
      usersCount.textContent = String(n);
    },
    chatActivity(on) {
      const show = on && !chatVisible();
      chatDot.hidden = !show;
      chatRailDot.hidden = !show;
    },
    bubbleActivity(on) {
      const show = on && !bubbleVisible();
      bubbleDot.hidden = !show;
      bubbleRailDot.hidden = !show;
    },
    chatOpen: chatVisible,
    bubbleOpen: bubbleVisible,
    setBubbleVisible(on) {
      bubbleRail.classList.toggle("hidden", !on);
      bubbleSection.classList.toggle("hidden", !on);
      // Arriving in a call opens the channel; leaving takes it away.
      if (on) bubbleSection.classList.remove("closed");
      else bubbleSection.classList.add("closed");
    },
    toggle: () => sidebar.classList.toggle("collapsed"),
  };
}

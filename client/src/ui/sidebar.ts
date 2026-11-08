//! Sidebar (README roadmap "UI redesign"): tabs — Main Menu (status, media
//! controls, devices), Players, Chat — next to the map, not over it. The
//! map canvas resizes with it; collapsing folds it away.

export interface SidebarUI {
  pane(id: "menu" | "players" | "chat"): HTMLElement;
  /** Show the chat tab (e.g. a new message arrives while another tab is up). */
  showTab(id: "menu" | "players" | "chat"): void;
  /** A chat mention-ish hint: dot on the chat tab while it is hidden. */
  chatActivity(on: boolean): void;
}

export function createSidebar(): SidebarUI {
  const sidebar = document.getElementById("sidebar")!;
  const tabs = sidebar.querySelectorAll<HTMLButtonElement>(".sidebar-tabs [data-tab]");
  const panes = sidebar.querySelectorAll<HTMLElement>(".sidebar-pane");
  const chatTab = sidebar.querySelector<HTMLButtonElement>('[data-tab="chat"]')!;
  let active = "chat";

  function activate(id: string): void {
    active = id;
    sidebar.classList.remove("collapsed");
    for (const t of tabs) t.classList.toggle("active", t.dataset.tab === id);
    for (const p of panes) p.classList.toggle("hidden", p.dataset.pane !== id);
    if (id === "chat") chatTab.classList.remove("dot");
  }

  for (const t of tabs) {
    t.addEventListener("click", () => activate(t.dataset.tab!));
  }
  sidebar.querySelector<HTMLButtonElement>("#sidebar-collapse")!.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
  });

  activate("chat"); // chat is the default pane (most often used)

  return {
    pane: (id) => sidebar.querySelector<HTMLElement>(`[data-pane="${id}"]`)!,
    showTab: activate,
    chatActivity(on) {
      const visible = !sidebar.classList.contains("collapsed") && active === "chat";
      chatTab.classList.toggle("dot", on && !visible);
    },
  };
}

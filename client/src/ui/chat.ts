// Chat panel: history, live lines, typing indicator, input (README §8).

import type { ChatMsg } from "../net/types";

export interface ChatUI {
  /** Append one live chat line (also used for history). */
  add(m: ChatMsg, myId: string): void;
  /** Seed the list with the room's history. */
  history(msgs: ChatMsg[], myId: string): void;
  /** Append a local system line (errors, status). */
  system(text: string): void;
  /** Someone started/stopped typing. */
  typing(id: string, on: boolean): void;
}

const MAX_LINES = 200;

export function createChat(
  container: HTMLElement,
  onSend: (text: string) => void,
  onTyping: (on: boolean) => void,
): ChatUI {
  const panel = document.createElement("div");
  panel.className = "chat";
  panel.innerHTML = `
    <div class="chat-list"></div>
    <div class="chat-typing hidden"></div>
    <form class="chat-form">
      <input class="chat-input" maxlength="500"
             placeholder="say something (Enter to send)" autocomplete="off" />
      <button type="submit">Send</button>
    </form>`;
  container.appendChild(panel);

  const list = panel.querySelector<HTMLElement>(".chat-list")!;
  const typingEl = panel.querySelector<HTMLElement>(".chat-typing")!;
  const input = panel.querySelector<HTMLInputElement>(".chat-input")!;
  const form = panel.querySelector<HTMLFormElement>(".chat-form")!;

  const typers = new Set<string>();

  function line(cls: string, name: string | null, text: string): void {
    const div = document.createElement("div");
    div.className = `chat-line ${cls}`.trim();
    if (name) {
      const n = document.createElement("span");
      n.className = "chat-name";
      n.textContent = name;
      div.appendChild(n);
    }
    const t = document.createElement("span");
    t.className = "chat-text";
    t.textContent = text;
    div.appendChild(t);
    list.appendChild(div);
    while (list.childElementCount > MAX_LINES) list.firstElementChild?.remove();
    list.scrollTop = list.scrollHeight;
  }

  const add = (m: ChatMsg, myId: string): void =>
    line(m.from === myId ? "me" : "", m.name, m.text);

  const history = (msgs: ChatMsg[], myId: string): void => {
    for (const m of msgs) add(m, myId);
  };

  const system = (text: string): void => line("system", null, text);

  const typing = (id: string, on: boolean): void => {
    if (on) typers.add(id);
    else typers.delete(id);
    typingEl.classList.toggle("hidden", typers.size === 0);
    typingEl.textContent =
      typers.size === 1 ? "Someone is typing…" : `${typers.size} people are typing…`;
  };

  // Report typing after the first character, stop on send or empty input.
  let typingSent = false;
  input.addEventListener("input", () => {
    if (input.value.length > 0 && !typingSent) {
      onTyping(true);
      typingSent = true;
    } else if (input.value.length === 0 && typingSent) {
      onTyping(false);
      typingSent = false;
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text.length === 0) return;
    onSend(text);
    input.value = "";
    if (typingSent) {
      onTyping(false);
      typingSent = false;
    }
  });

  return { add, history, system, typing };
}

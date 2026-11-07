// Boot overlay: name, map picker, avatar color (README §8).

export interface BootOptions {
  room: string;
  name: string;
  color: string;
}

interface MapInfo {
  id: string;
  name: string;
}

const NAME_KEY = "campfire.name";
const COLORS = ["#e05f38", "#4a90d9", "#58a858", "#9b59b6", "#d4a017", "#16a2a2"];

/** Show the boot overlay and resolve with the user's choices.
 *
 *  Room switching (README §11 Phase 7) reloads the page with the choices in
 *  the URL (`/?room=…&name=…&color=…`): when all three are present the form
 *  is skipped entirely and the values are returned as-is. */
export function boot(): Promise<BootOptions> {
  const root = document.getElementById("boot")!;

  const params = new URLSearchParams(window.location.search);
  const urlRoom = params.get("room");
  const urlName = params.get("name")?.trim();
  const urlColor = params.get("color");
  if (urlRoom && urlName && urlColor) {
    root.style.display = "none";
    return Promise.resolve({
      room: urlRoom,
      name: urlName.slice(0, 24),
      color: urlColor,
    });
  }

  root.style.display = "grid";
  root.innerHTML = `
    <main>
      <h1>🔥 Campfire</h1>
      <p class="tag">Hang out, chat and video-call on 2D maps.</p>
      <form id="join-form">
        <label>Name
          <input id="name" maxlength="24" required autocomplete="off" placeholder="your name" />
        </label>
        <label>Map
          <select id="map"></select>
        </label>
        <div class="swatches" id="swatches"></div>
        <button type="submit">Join</button>
        <p class="error" id="error"></p>
      </form>
    </main>`;

  const nameInput = root.querySelector<HTMLInputElement>("#name")!;
  const mapSelect = root.querySelector<HTMLSelectElement>("#map")!;
  const swatches = root.querySelector<HTMLElement>("#swatches")!;
  const error = root.querySelector<HTMLElement>("#error")!;
  const form = root.querySelector<HTMLFormElement>("#join-form")!;

  // Restore the last used name.
  try {
    nameInput.value = localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    // storage unavailable (private mode) — no persisted name
  }

  // Avatar color swatches.
  let color = COLORS[0];
  COLORS.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (i === 0 ? " selected" : "");
    b.style.background = c;
    b.setAttribute("aria-label", `color ${c}`);
    b.addEventListener("click", () => {
      color = c;
      for (const s of swatches.children) s.classList.remove("selected");
      b.classList.add("selected");
    });
    swatches.appendChild(b);
  });

  // Map picker: the bundled maps, with the well-known two as fallback.
  const fillMaps = (maps: MapInfo[]): void => {
    for (const m of maps) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      mapSelect.appendChild(opt);
    }
  };

  return new Promise<BootOptions>((resolve) => {
    fillMaps([{ id: "office", name: "Office" }, { id: "island", name: "Island" }]);
    void (async () => {
      try {
        const res = await fetch("/api/v1/maps");
        if (!res.ok) return;
        const maps = (await res.json()) as MapInfo[];
        if (maps.length > 0) {
          mapSelect.replaceChildren();
          fillMaps(maps);
        }
      } catch {
        // fetch failed: keep the fallback list
      }
    })();

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (name.length === 0 || name.length > 24) {
        error.textContent = "Please choose a name (1–24 characters).";
        return;
      }
      error.textContent = "";
      try {
        localStorage.setItem(NAME_KEY, name);
      } catch {
        // ignore storage failures
      }
      root.style.display = "none";
      resolve({ room: mapSelect.value, name, color });
    });
  });
}

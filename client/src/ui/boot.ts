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
/** A URL-provided color is only accepted as a plain CSS hex color
 *  (`#rgb`/`#rrggbb`); anything else falls through to the swatch picker. */
const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Show the boot overlay and resolve with the user's choices.
 *
 *  Room switching (README §11 Phase 7) reloads the page with the choices in
 *  the URL (`/?room=…&name=…&color=…`): when all three are present the form
 *  is skipped entirely and the values are returned as-is.
 *
 *  Auth (README §11): when the server has OpenID Connect enabled, the name is
 *  forced from the signed-in identity and a visitor without a session is
 *  redirected to the IdP. That check runs first, before the URL fast path. */
export function boot(): Promise<BootOptions> {
  const root = document.getElementById("boot")!;
  return resolveForcedName().then((forcedName) => runBoot(root, forcedName));
}

/** Probe `/api/v1/auth` (README §11).
 *
 *  - `null` — auth is disabled (or the probe failed), so the name is free.
 *  - a string — the signed-in identity's name, which overrides whatever the
 *    URL or form would have chosen (the server enforces it anyway).
 *
 *  When auth is on and the visitor has no session, the page is redirected to
 *  the IdP; if the navigation is still pending a moment later (network
 *  failure), boot degrades to a free name instead of hanging — the join
 *  will surface the server's 401.
 */
async function resolveForcedName(): Promise<string | null> {
  let data: { enabled: boolean; name?: string };
  try {
    const res = await fetch("/api/v1/auth", { credentials: "same-origin" });
    if (!res.ok) return null;
    data = (await res.json()) as { enabled: boolean; name?: string };
  } catch {
    return null; // probe failed (e.g. an older server): degrade to no-auth
  }
  if (!data.enabled) return null;
  if (data.name) return data.name;
  // Auth on, no session: send the visitor to the IdP, returning to this page.
  // Give the navigation a beat; a document that is really going away never
  // runs the timeout, so this only fires when the redirect cannot proceed.
  const returnTo = window.location.pathname + window.location.search;
  window.location.replace(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  await new Promise((r) => setTimeout(r, 500));
  return null;
}

function runBoot(root: HTMLElement, forcedName: string | null): Promise<BootOptions> {
  const params = new URLSearchParams(window.location.search);
  // The map id can be in the path: `/play/interiors/office.tmj` →
  // room `interiors/office` (the file's path under `maps/`, extension
  // dropped, a repeated directory name removed). `?room=` still works.
  const pathRoom = (() => {
    const m = /^\/play\/(.+?)\/?$/.exec(window.location.pathname);
    if (!m) return undefined;
    let id = m[1];
    id = id.replace(/\.(json|tmj)$/, "");
    const segments = id.split("/");
    if (segments.length > 1 && segments[segments.length - 1] === segments[segments.length - 2]) {
      segments.pop();
    }
    return segments.join("/");
  })();
  // Path segments are URL-encoded; a malformed escape (`%zz`) makes
  // decodeURIComponent throw, so decode defensively.
  const urlRoom = (() => {
    if (pathRoom !== undefined) {
      try {
        return decodeURIComponent(pathRoom);
      } catch {
        return pathRoom;
      }
    }
    return params.get("room") ?? undefined;
  })();
  // With auth on, the name comes from the signed-in identity (the server
  // enforces it), not from the URL.
  const urlName = forcedName ?? params.get("name")?.trim();
  const rawColor = params.get("color");
  const urlColor = rawColor !== null && COLOR_RE.test(rawColor) ? rawColor : undefined;
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

  // With auth on the name is the signed-in identity: prefilled, read-only.
  // Otherwise restore the last used name.
  if (forcedName) {
    nameInput.value = forcedName;
    nameInput.readOnly = true;
  } else {
    try {
      nameInput.value = localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      // storage unavailable (private mode) — no persisted name
    }
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

  // Map picker: hidden when the room is already in the path (`/play/…`).
  const hasPathRoom = pathRoom !== undefined;
  const mapLabel = root.querySelector<HTMLLabelElement>("label[for='map'], label:nth-of-type(2)")!;
  if (hasPathRoom) mapLabel.style.display = "none";

  // Map picker: the loaded maps, with the well-known two as fallback.
  const fillMaps = (maps: MapInfo[]): void => {
    for (const m of maps) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      mapSelect.appendChild(opt);
    }
  };

  return new Promise<BootOptions>((resolve) => {
    // Map picker: the server's list (`/api/v1/maps`) is the source of
    // truth — a placeholder holds until it loads (no hardcoded ids to
    // drift from the server's maps).
    const placeholder = document.createElement("option");
    placeholder.disabled = true;
    placeholder.textContent = "loading maps…";
    mapSelect.appendChild(placeholder);
    if (hasPathRoom) mapSelect.value = urlRoom!;
    void (async () => {
      let maps: MapInfo[] = [];
      try {
        const res = await fetch("/api/v1/maps");
        if (res.ok) maps = (await res.json()) as MapInfo[];
      } catch {
        // fetch failed: keep the placeholder
      }
      if (maps.length === 0) {
        error.textContent = "Could not load the map list. Reload to retry.";
        return;
      }
      mapSelect.replaceChildren();
      fillMaps(maps);
      if (hasPathRoom) {
        // The path picks the map; fall back to the picker only if the
        // path's map is not on the server.
        if (maps.some((m) => m.id === urlRoom)) {
          mapSelect.value = urlRoom!;
        } else {
          mapLabel.style.display = "";
        }
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
      // Don't persist an auth-forced name as the "last used" one.
      if (!forcedName) {
        try {
          localStorage.setItem(NAME_KEY, name);
        } catch {
          // ignore storage failures
        }
      }
      // From the landing page, the map id goes into the path (reload keeps
      // the name and color); with a path room the join happens right here.
      if (!hasPathRoom) {
        window.location.href =
          `/play/${encodeURIComponent(mapSelect.value)}/` +
          `?name=${encodeURIComponent(name)}&color=${encodeURIComponent(color)}`;
        return;
      }
      root.style.display = "none";
      resolve({ room: mapSelect.value, name, color });
    });
  });
}

// Boot: resolve the join settings (README §8). The landing page is gone —
// `/` is redirected to the first map by the server — so this is no longer a
// UI, just parameter resolution:
//
// * room — the `/play/<room>/` path segment, else the `?room=` param, else
//   the first map from `GET /api/v1/maps`.
// * name — `localStorage`, else the `?name=` param, else a random
//   adjective+noun.
// * color — `localStorage`, else the `?color=` param, else a random swatch.
//
// The resolved identity is saved back to localStorage, so a reload (the
// URL carries no name/color anymore) re-joins as the same user.
//
// Auth (README §11): when the server has OpenID Connect enabled, the name is
// forced from the signed-in identity and a visitor without a session is
// redirected to the IdP.

import type { OwnStatus } from "../net/types";

export interface BootOptions {
  room: string;
  name: string;
  color: string;
}

interface MapInfo {
  id: string;
  name: string;
}

export const COLORS = ["#e05f38", "#4a90d9", "#58a858", "#9b59b6", "#d4a017", "#16a2a2"];
/** A URL-provided color is only accepted as a plain CSS hex color
 *  (`#rgb`/`#rrggbb`); anything else is replaced by a random one. */
const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Identity persistence: the profile menu writes the edited name/color
 *  here, so a reload (no URL params anymore) re-joins as the same user. */
const NAME_KEY = "campfire.name";
const COLOR_KEY = "campfire.color";

/** Presence-status persistence (the profile menu). */
const STATUS_KEY = "campfire.status";

/** Every fresh load joins `online` (issues.md #1): a persisted `away`/`dnd`
 *  from the previous session no longer survives a reload. */
export function loadStatus(): OwnStatus {
  try {
    localStorage.removeItem(STATUS_KEY);
  } catch {
    // storage unavailable (private mode): the default
  }
  return "online";
}

function loadIdentity(): { name?: string; color?: string } {
  try {
    return {
      name: localStorage.getItem(NAME_KEY) ?? undefined,
      color: localStorage.getItem(COLOR_KEY) ?? undefined,
    };
  } catch {
    return {};
  }
}

export function saveIdentity(name: string, color: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
    localStorage.setItem(COLOR_KEY, color);
  } catch {
    // ignore storage failures
  }
}

const ADJECTIVES = [
  "amber", "brave", "calm", "dusty", "eager", "fuzzy", "gentle", "happy",
  "ivory", "jolly", "keen", "lucky", "mellow", "nifty", "opal", "plucky",
  "quirky", "rusty", "sunny", "tidy", "umbral", "vivid", "witty", "zesty",
];
const NOUNS = [
  "badger", "cactus", "cinder", "ember", "falcon", "fox", "heron", "juniper",
  "koala", "lantern", "lynx", "marten", "moth", "otter", "puffin", "raven",
  "rocket", "salmon", "sparrow", "tiger", "walrus", "wombat", "wren", "yarrow",
];

/** Random avatar name: adjective + noun ("lucky otter"). */
function randomName(): string {
  const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

/** Random avatar color from the swatch palette. */
function randomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

/** Resolve the join settings; never shows a form. */
export function boot(): Promise<BootOptions> {
  return resolveForcedName().then((forcedName) => runBoot(forcedName));
}

/** Probe `/api/v1/auth` (README §11).
 *
 *  - `null` — auth is disabled (or the probe failed), so the name is free.
 *  - a string — the signed-in identity's name, which overrides whatever the
 *    URL would have chosen (the server enforces it anyway).
 *
 * When auth is on and the visitor has no session, the page is redirected to
 * the IdP; if the navigation is still pending a moment later (network
 * failure), boot degrades to a free name instead of hanging — the join
 * will surface the server's 401.
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

async function runBoot(forcedName: string | null): Promise<BootOptions> {
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
    const q = params.get("room");
    return q !== null ? q : undefined;
  })();
  // With auth on, the name comes from the signed-in identity (the server
  // enforces it), not from the URL.
  const urlName = forcedName ?? params.get("name")?.trim().slice(0, 24);
  const rawColor = params.get("color");

  // No path room (the server normally redirects `/` to the first map):
  // take the first entry of the server's map list.
  let room = urlRoom;
  if (room === undefined) {
    try {
      const res = await fetch("/api/v1/maps");
      if (res.ok) {
        const maps = (await res.json()) as MapInfo[];
        room = maps[0]?.id;
      }
    } catch {
      // fetch failed: fall through to the hardcoded default
    }
  }
  // Last resort (no server list, no path): the demo map.
  if (room === undefined || room.length === 0) room = "office";

  // Identity: localStorage wins (it is what the profile menu edits), the
  // URL params back it up (e2e drivers, fresh profiles), random is last.
  const stored = loadIdentity();
  const named = [forcedName, stored.name, urlName].find((n) => n && n.length > 0);
  const name = named ?? randomName();
  const color =
    stored.color && COLOR_RE.test(stored.color)
      ? stored.color
      : rawColor !== null && COLOR_RE.test(rawColor)
        ? rawColor
        : randomColor();
  saveIdentity(name, color);

  return { room, name, color };
}

// Campfire client entry point: boot overlay → map load → Pixi world →
// realtime connection → game loop (docs/arch/client.md).

import { CallManager } from "./call/manager";
import { createCallUI } from "./call/callui";
import { playBlob, playCallSound } from "./call/sound";
import { attachKeys, desiredVelocity, keys } from "./input/keys";
import { Connection } from "./net/connection";
import type { ChatMsg, Dir, MovementBatch, OwnStatus, UserBrief } from "./net/types";
import { boot, loadStatus } from "./ui/boot";
import { createChat, type ChatUI } from "./ui/chat";
import { createHeader } from "./ui/header";
import { createPresence } from "./ui/presence";
import { createSidebar } from "./ui/sidebar";
import { isWalkablePoint, parseMap, tileAt, zoneContains, type MapData, type Zone } from "./world/mapdata";
import { createWorld, drawBubble, followCamera } from "./world/render";

declare global {
  interface Window {
    /** id → { name, x, y } — current tile position of every user (e2e). */
    __campfire_users?: Record<string, { name: string; x: number; y: number }>;
  }
}

/// Local position sends: 15 Hz while moving, 2 Hz while idle (docs/arch/protocol.md).
const SEND_EVERY_MS = 66; // 15 Hz — the docs/arch/protocol.md per-user cap (was 10 Hz)
const IDLE_EVERY_MS = 500;
/// Avatar radius in tiles for local collision checks.
const AVATAR_R = 0.3;

/** A transient toast (issues.md #2): system/log lines (errors, connection
 *  issues) no longer pollute the chats. Multiple toasts stack; each fades
 *  after 5 s. `name` renders bold before the text (chat toasts). */
function toast(text: string, name?: string): void {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = "toast";
  if (name !== undefined) {
    const b = document.createElement("b");
    b.textContent = name;
    el.appendChild(b);
  }
  el.append(text);
  host.appendChild(el);
  window.setTimeout(() => el.remove(), 5000);
}

/** True if an avatar centred at (x, y) overlaps a blocked tile. */
function blocked(map: MapData, x: number, y: number): boolean {
  return (
    !isWalkablePoint(map, x - AVATAR_R, y - AVATAR_R) ||
    !isWalkablePoint(map, x + AVATAR_R, y - AVATAR_R) ||
    !isWalkablePoint(map, x - AVATAR_R, y + AVATAR_R) ||
    !isWalkablePoint(map, x + AVATAR_R, y + AVATAR_R)
  );
}

/** BFS path from (sx, sy) to (tx, ty) over the walkable grid (4-neighbour),
 *  tile centers, or null when unreachable (README roadmap "Map enhancements":
 *  click-to-walk). */
function findPath(
  map: MapData,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): Array<[number, number]> | null {
  const W = map.width;
  const H = map.height;
  const walkable = (x: number, y: number): boolean =>
    tileAt(map, map.collision, x, y) === 0;
  const start = Math.floor(sy) * W + Math.floor(sx);
  const goal = Math.floor(ty) * W + Math.floor(tx);
  if (!walkable(goal % W, Math.floor(goal / W))) return null;
  if (start === goal) return [];
  const prev = new Map<number, number>();
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === goal) break;
    const cx = cur % W;
    const cy = Math.floor(cur / W);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (!walkable(nx, ny)) continue;
      const nk = ny * W + nx;
      if (seen.has(nk)) continue;
      seen.add(nk);
      prev.set(nk, cur);
      queue.push(nk);
    }
  }
  if (!seen.has(goal)) return null;
  const path: Array<[number, number]> = [];
  let cur: number | undefined = goal;
  while (cur !== undefined && cur !== start) {
    path.push([cur % W + 0.5, Math.floor(cur / W) + 0.5]);
    cur = prev.get(cur);
  }
  return path.reverse();
}

async function main(): Promise<void> {
  // The app only runs when the page was served over QUIC; a TCP fallback
  // page carries no JS. Clear the bootstrap retry counter (served by the
  // TLS front in crates/campfire-server/src/bootstrap.rs) so a later
  // QUIC outage starts its ~5-attempt reload cycle from scratch.
  try {
    sessionStorage.removeItem("campfire-quic-retry");
  } catch {
    // storage unavailable (private mode); the counter self-expires server-side
  }
  const opts = await boot();
  attachKeys();

  const res = await fetch(`/api/v1/maps/${encodeURIComponent(opts.room)}`);
  if (!res.ok) throw new Error(`map fetch failed: ${res.status}`);
  const map = parseMap(opts.room, await res.json());
  const world = await createWorld(map, opts.name, opts.color);
  // Click-to-walk (README roadmap "Map enhancements"): a click on the canvas
  // pathfinds to the clicked tile (unreachable → ignored).
  world.onClick.cb = (tx, ty) => {
    const path = findPath(map, x, y, tx, ty);
    if (path) walkPath = path;
  };

  // Local state, owned by the game loop below.
  let x = map.spawn[0];
  let y = map.spawn[1];
  let dir: Dir = "s";
  let moving = false;
  let myId = "";
  let chat: ChatUI | null = null;
  let bubbleChat: ChatUI | null = null;

  // Click-to-walk (README roadmap "Map enhancements"): the path queue the
  // game loop consumes; keyboard input clears it.
  let walkPath: Array<[number, number]> = [];

  // Room roster (id → brief).
  const roster = new Map<string, UserBrief>();

  // Debug hook (tools/e2e/e2e.js): `window.__campfire_users` = id → { name,
  // x, y } in tile coords. A plain object — page.evaluate JSON-serializes
  // Maps to {}. Refreshed from the connection callbacks (below) as well as
  // the render loop, so it stays current on background tabs whose rAF loop
  // is throttled; the positions are the last *received* ones (movement()),
  // not the interpolated ones (update()). Stripped from the production
  // bundle (C14): only the `build:e2e` client carries the hook.
  const refreshUsersHook = (): void => {
    if (!__CAMPFIRE_DEBUG__) return;
    const out: Record<string, { name: string; x: number; y: number }> = {};
    const tiles = world.manager.latestPositions();
    for (const [id, u] of roster) {
      let px = 0;
      let py = 0;
      if (id === myId) {
        px = x;
        py = y;
      } else {
        const p = tiles.get(id);
        if (p) {
          px = p[0];
          py = p[1];
        }
      }
      out[id] = { name: u.name, x: px, y: py };
    }
    window.__campfire_users = out;
  };

  // Active calls by zone key ("" = the proximity bubble): room-wide call
  // state, powers the avatars' headphone badge. Rooms can carry several
  // concurrent calls (one per occupied jitsi zone); a user is in at most
  // one of them.
  const calls = new Map<string, Set<string>>();
  const inCallAll = (): Set<string> => {
    const all = new Set<string>();
    for (const s of calls.values()) for (const id of s) all.add(id);
    return all;
  };
  /** Zone key of the call containing us, if any. */
  const myCallKey = (): string | undefined => {
    for (const [k, s] of calls) if (s.has(myId)) return k;
    return undefined;
  };
  const refreshCallUi = (): void => {
    const inCall = inCallAll();
    for (const id of roster.keys()) {
      if (id !== myId) world.manager.setInCall(id, inCall.has(id));
    }
    world.local.setInCall(inCall.has(myId));
    presence.setInCall(inCall);
  };

  const conn = new Connection(opts.room, opts.name, opts.color, loadStatus(), {
    onHello: (h) => {
      myId = h.you;
      const me = h.users.find((u) => u.id === h.you);
      if (me) {
        x = me.x;
        y = me.y;
        dir = me.d;
      }
      roster.clear();
      for (const u of h.users) roster.set(u.id, u);
      world.local.setDir(dir);
      world.manager.hello(h.users, h.you);
      // Presence dots on the map: every rostered avatar (ours included).
      for (const u of h.users) world.manager.setStatus(u.id, u.status ?? "online");
      if (me) world.local.setStatus(me.status ?? "online");
      refreshUsersHook();
      chat?.history(h.chat, h.you);
      bubbleChat?.history(h.call_chat ?? [], h.you);
      sidebar.setUserCount(roster.size);
      manager.setSelfId(h.you);
      presence.setUsers(h.users, new Set(h.call.map((u) => u.id)));
      // Reconnect-with-token (docs/arch/protocol.md): `hello.call` is the authoritative
      // roster of the call we were in (if it survived our drop). Zone
      // catch-up `call_start`s (sent right after) refine the zone key.
      calls.clear();
      calls.set("", new Set(h.call.map((u) => u.id)));
      const mine = calls.get("")!;
      if (mine.has(myId)) {
        void manager.rejoinCall(h.call, h.ticket);
      } else if (manager.inCall()) {
        manager.onCallEnd("ended while you were disconnected");
      }
      // A mid-call room joiner may already have received the room-wide
      // `call_start` catch-up before this `hello`; now that the roster is
      // known, light up the in-call badges (docs/arch/protocol.md).
      refreshCallUi();
    },
    onJoined: (u: UserBrief) => {
      world.manager.joined(u);
      roster.set(u.id, u);
      sidebar.setUserCount(roster.size);
      presence.addUser(u);
      refreshUsersHook();
    },
    onLeft: (id) => {
      world.manager.left(id);
      roster.delete(id);
      sidebar.setUserCount(roster.size);
      presence.removeUser(id);
      refreshUsersHook();
    },
    onChat: (c: ChatMsg) => {
      if ((c.scope ?? "room") === "call") bubbleChat?.add(c, myId);
      else chat?.add(c, myId);
    },
    onTyping: (id, on) => {
      chat?.typing(id, on);
      bubbleChat?.typing(id, on);
    },
    onUserStatus: (id, s) => {
      presence.setStatus(id, s);
      world.manager.setStatus(id, s);
      if (id === myId) world.local.setStatus(s);
    },
    onMovement: (batch: MovementBatch) => {
      world.manager.movement(batch.m);
      refreshUsersHook();
      // `sz` (README roadmap "Map enhancements"): a peer inside a silentZone
      // is muted locally.
      for (const e of batch.m) {
        manager.setSilent(e.id, e.sz === true);
        const dnd = e.sz === true;
        world.manager.setDnd(e.id, dnd);
        if (e.id === myId) world.local.setDnd(dnd);
        presence.setDnd(e.id, dnd);
      }
    },
    // Bubble state (docs/arch/protocol.md): the manager owns the state machine;
    // the room-wide call *state* also drives the headphone badges.
    onCallStart: (ps, zone, ticket) => {
      const key = zone ?? "";
      calls.set(key, new Set(ps.map((p) => p.id)));
      // A roster containing us replaces any stale provisional membership
      // (a user is in at most one call).
      if (calls.get(key)!.has(myId)) {
        for (const [k, s] of calls) {
          if (k !== key && s.has(myId)) calls.delete(k);
        }
        manager.onCallStart(ps, ticket);
      }
      refreshCallUi();
    },
    onCallLeave: (id, zone) => {
      const key = zone ?? "";
      const s = calls.get(key);
      if (s?.has(id)) {
        // A leaver from our call also tears down our media state.
        if (s.has(myId)) manager.onCallLeave(id);
        s.delete(id);
        if (s.size === 0) calls.delete(key);
      }
      refreshCallUi();
    },
    onCallEnd: (reason, zone) => {
      const key = zone ?? "";
      if (calls.get(key)?.has(myId)) manager.onCallEnd(reason);
      calls.delete(key);
      refreshCallUi();
    },
    onCallMute: (id, a, v) => manager.onCallMute(id, a, v),
    onCallScreen: (id, on) => manager.onCallScreen(id, on),
    // exitUrl zones (README roadmap "Map enhancements"): the server owns
    // the URL → map-id rule and tells us the target; same name + color.
    onNavigate: (map) => navigateToRoom(map, 50),
    onError: (code) => {
      toast(`server error: ${code}`);
      manager.onError(code);
    },
    onStatus: () => {
      // A dropped connection must NOT tear down the call locally: the
      // server keeps our call membership through the reconnect window, and
      // the next `hello.call` roster is the truth (docs/arch/protocol.md).
    },
  });

  /** Leave this room immediately (the server broadcasts `left` and tears
   *  the session down), then reload into `room`. The identity (name/color)
   *  lives in localStorage (boot.ts) and survives the reload, so a
   *  rejoin-with-new-identity is the same code path. The delay lets the
   *  `left` broadcast land before navigation kills the session
   *  (docs/dev/testing.md). */
  const navigateToRoom = (room: string, delayMs: number): void => {
    conn.sendLeave();
    window.setTimeout(() => {
      window.location.href = `/play/${room.split("/").map(encodeURIComponent).join("/")}/`;
    }, delayMs);
  };

  // Sidebar next to the map (README roadmap "UI redesign"): two accordion
  // sections — Users, Chat — each existing component mounts into its body.
  // The call theater overlays the map from `#ui`.
  const sidebar = createSidebar();
  const ui = document.getElementById("ui")!; // the theater's overlay layer
  const presence = createPresence(sidebar.pane("players"));
  chat = createChat(sidebar.pane("chat"), (t, scope) => conn.sendChat(t, scope), (on) => conn.sendTyping(on), {
    scope: "room",
    onActivity: (m) => {
      sidebar.chatActivity(true);
      // Off-screen chat arrives as a toast with the "blob" blip; the panel
      // itself stays quiet (the line is already in the list).
      if (!sidebar.chatOpen()) {
        toast(`${m.name}: ${m.text}`, m.name);
        playBlob();
      }
    },
  });
  // Bubble chat (issues.md #2): a second channel that exists only while in
  // a call; it sends with the `call` scope and shows the call history.
  bubbleChat = createChat(
    sidebar.pane("bubble"),
    (t, scope) => conn.sendChat(t, scope),
    (on) => conn.sendTyping(on),
    {
      scope: "call",
      onActivity: (m) => {
        sidebar.bubbleActivity(true);
        if (!sidebar.bubbleOpen()) {
          toast(`${m.name}: ${m.text}`, m.name);
          playBlob();
        }
      },
    },
  );
  const callUI = createCallUI(ui, {
    onHangup: () => manager.hangup(),
  });
  const manager = new CallManager(conn, {
    onPhase: (ph) => {
      callUI.setPhase(ph);
      header.setInCall(ph.p === "in-call" || ph.p === "joining");
      // The bubble chat exists only while in a call (issues.md #2).
      sidebar.setBubbleVisible(ph.p === "in-call");
    },
    onLocalStream: (s) => callUI.setLocalStream(s),
    onPeers: (ps) => callUI.setPeers(ps),
    onLocalMute: (a, v) => header.setMute(a, v),
    onLocalScreen: (on) => header.setScreen(on),
    onLog: (t) => toast(t),
    onCallSound: (s) => playCallSound(s),
  }, opts.room);
  // Top bar: the burger toggles the sidebar; the map switcher navigates the
  // same way room switching does; name/color edits rejoin with the new
  // identity; the global 🎤/📷/🖥 buttons wire to the manager and transport;
  // status changes are announced to the room and re-shape call behavior.
  const header = createHeader(sidebar, opts.room, {
    name: opts.name,
    color: opts.color,
    status: loadStatus(),
    onSwitchMap: (map) => navigateToRoom(map, 150),
    onIdentityChange: () => navigateToRoom(opts.room, 150),
    onStatusChange: (s) => {
      conn.sendStatus(s);
      manager.setStatus(s);
      // The server does not echo `status` back to the sender (their UI is
      // expected to already show it) — update our own Users-list row and
      // map avatar here.
      if (myId) presence.setStatus(myId, s);
      world.local.setStatus(s);
    },
    onToggleMute: () => manager.toggleMute(),
    onToggleCamera: () => manager.toggleCamera(),
    onToggleScreen: () => manager.toggleScreen(),
  });
  header.setMute(true, true);

  // Auto-away (issues.md #1): when the tab/window loses focus with no
  // active call and `online` status, switch to `away` — flagged as
  // automatic. On refocus, only an automatic `away` returns to `online`
  // (a status set manually stays). `dnd` never changes automatically,
  // either direction.
  let autoAway = false;
  window.addEventListener("blur", () => {
    if (!manager.inCall() && header.status() === "online") {
      autoAway = true;
      header.setStatus("away");
    }
  });
  window.addEventListener("focus", () => {
    if (autoAway) {
      autoAway = false;
      // Still inside a silent zone? Keep the zone's dnd and re-target the
      // restore (the blur's away is cancelled; leaving the zone later
      // returns us to online, not to a stale blur-away).
      if (inSilentZone && silentDnd) {
        prevSilentStatus = "online";
      } else {
        header.setStatus("online");
      }
    }
  });

  // Silent zones (README roadmap "Map enhancements"): standing inside one
  // is "do not disturb me here", so our presence goes dnd for as long as
  // we are inside — regardless of the status we had (dnd is idempotent);
  // leaving the zone restores what we came in with. The blur auto-away
  // above re-targets its own restore so the zone owns the status while we
  // stand in it. The proximity-audio muting for the zone's occupants is
  // unchanged (server-side `sz` flag).
  let silentDnd = false;
  let inSilentZone = false;
  let prevSilentStatus: OwnStatus | null = null;

  // Game loop: integrate local movement, draw, send at ≤15 Hz (2 Hz idle).
  let lastSend = 0;
  let prev = performance.now();
  const tick = (now: number): void => {
    // Schedule the next frame FIRST: a throw anywhere below (transport,
    // rendering) must never kill the loop — that once froze the whole game.
    requestAnimationFrame(tick);
    const dt = Math.min((now - prev) / 1000, 0.1);
    prev = now;

    const v = desiredVelocity(dt);
    if (v.moving) {
      walkPath = []; // keyboard input cancels click-to-walk
      moving = true;
      // Face the dominant axis.
      dir =
        Math.abs(v.vx) >= Math.abs(v.vy)
          ? v.vx > 0
            ? "e"
            : "w"
          : v.vy > 0
            ? "s"
            : "n";
      // Axis-separated collision: try x, then y.
      const nx = x + v.vx;
      const ny = y + v.vy;
      if (!blocked(map, nx, y)) x = nx;
      if (!blocked(map, x, ny)) y = ny;
    } else if (walkPath.length > 0) {
      // Click-to-walk (README roadmap "Map enhancements"): step toward the
      // next waypoint at walk speed (run speed with Shift held).
      const [tx, ty] = walkPath[0]!;
      const dx = tx - x;
      const dy = ty - y;
      const d = Math.hypot(dx, dy);
      if (d < 0.05) {
        walkPath.shift();
        if (walkPath.length === 0) moving = false; // the path is done
      } else {
        const speed = keys.run ? 8 : 4;
        const step = Math.min(speed * dt, d);
        const nx = x + (dx / d) * step;
        const ny = y + (dy / d) * step;
        moving = true;
        if (!blocked(map, nx, y)) x = nx;
        if (!blocked(map, x, ny)) y = ny;
        dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "e" : "w") : dy > 0 ? "s" : "n";
      }
    } else {
      // No key held, no path: stop bobbing and drop to the 2 Hz idle rate.
      moving = false;
    }

    // exitUrl zones (README roadmap "Map enhancements"): the server detects
    // the zone entry and sends `navigate` with the resolved map id.

    const ts = map.tileSize;
    world.local.setPos(x * ts, y * ts);
    world.local.setDir(dir);
    world.local.setMoving(moving, now);
    world.manager.update(now, ts);
    refreshUsersHook();
    followCamera(world, x, y);

    // The call area: every live zone call highlights its rectangle; the
    // proximity bubble is a one-tile circle at the centroid of our call's
    // participants (server computes membership from the same geometry).
    const inCall = inCallAll();
    const rects: Zone[] = [];
    for (const [k, s] of calls) {
      if (k === "" || s.size === 0) continue;
      const zone = map.zones.find((z) => z.jitsiRoom === k || z.name === k);
      if (zone) rects.push(zone);
    }
    const key = myCallKey();
    const myRoster = key !== undefined ? calls.get(key)! : undefined;
    if (inCall.size > 0 || rects.length > 0) {
      // The circle shows only our own proximity bubble; zone members in
      // other zones are already covered by their rects.
      const pts: Array<[number, number]> = [];
      if (myRoster && key === "") {
        if (myId !== "" && myRoster.has(myId)) pts.push([x, y]);
        const tiles = world.manager.positions();
        for (const id of myRoster) {
          if (id !== myId) {
            const p = tiles.get(id);
            if (p) pts.push(p);
          }
        }
      }
      drawBubble(world, rects, pts);
    } else {
      drawBubble(world, [], []);
    }

    if (now - lastSend >= (moving ? SEND_EVERY_MS : IDLE_EVERY_MS)) {
      lastSend = now;
      conn.sendMove(x, y, dir, moving);
    }

    // Silent-zone presence (see `silentDnd` above): edge-triggered on
    // entering/leaving a `silentZone`.
    const nowSilent = map.zones.some((z) => z.silent && zoneContains(z, x, y));
    if (nowSilent !== inSilentZone) {
      inSilentZone = nowSilent;
      if (nowSilent && header.status() !== "dnd") {
        prevSilentStatus = header.status();
        silentDnd = true;
        header.setStatus("dnd");
      } else if (!nowSilent && silentDnd) {
        silentDnd = false;
        const restore = prevSilentStatus;
        prevSilentStatus = null;
        if (restore !== null && header.status() === "dnd") header.setStatus(restore);
      }
    }
  };

  conn.start();
  requestAnimationFrame(tick);
}

main().catch((err) => {
  console.error(err);
  // textContent only: `err` can carry user-influenceable text (URL
  // params, server error bodies) — innerHTML would be a DOM XSS sink.
  const overlay = document.createElement("div");
  overlay.className = "fatal";
  const h1 = document.createElement("h1");
  h1.textContent = "🔥 Campfire";
  const p = document.createElement("p");
  p.textContent = `Something went wrong: ${String(err)}`;
  overlay.append(h1, p);
  document.body.appendChild(overlay);
});

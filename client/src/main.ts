// Campfire client entry point: boot overlay → map load → Pixi world →
// realtime connection → game loop (README §8).

import { CallManager } from "./call/manager";
import { createCallUI } from "./call/callui";
import { attachKeys, desiredVelocity, keys } from "./input/keys";
import { Connection } from "./net/connection";
import type { ChatMsg, Dir, MovementBatch, UserBrief } from "./net/types";
import { boot } from "./ui/boot";
import { createChat, type ChatUI } from "./ui/chat";
import { createPresence, type PresenceUI } from "./ui/presence";
import { createStatus } from "./ui/status";
import { createSidebar } from "./ui/sidebar";
import { isWalkablePoint, parseMap, tileAt, zoneContains, type MapData, type Zone } from "./world/mapdata";
import { createWorld, drawBubble, followCamera } from "./world/render";

/// Local position sends: 10 Hz while moving, 2 Hz while idle (README §5).
const SEND_EVERY_MS = 66; // 15 Hz — the README §5 per-user cap (was 10 Hz)
const IDLE_EVERY_MS = 500;
/// Avatar radius in tiles for local collision checks.
const AVATAR_R = 0.3;

/** True if an avatar centred at (x, y) overlaps a blocked tile. */
function blocked(map: MapData, x: number, y: number): boolean {
  return (
    !isWalkablePoint(map, x - AVATAR_R, y - AVATAR_R) ||
    !isWalkablePoint(map, x + AVATAR_R, y - AVATAR_R) ||
    !isWalkablePoint(map, x - AVATAR_R, y + AVATAR_R) ||
    !isWalkablePoint(map, x + AVATAR_R, y + AVATAR_R)
  );
}

/** Exit `exitUrl` → map id: strip extension, collapse a repeated final
 *  directory segment (the server's rule, `office/office.json` → `office`). */
function exitUrlToMapId(exitUrl: string): string {
  const path = exitUrl.split("#")[0]!;
  const parts = path.split("/").filter((p) => p !== "");
  const last = parts[parts.length - 1]!.replace(/\.\w+$/, "");
  if (parts.length > 1 && parts[parts.length - 2] === last) parts.pop();
  parts[parts.length - 1] = last;
  return parts.join("/");
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
  let presence: PresenceUI;

  // Click-to-walk (README roadmap "Map enhancements"): the path queue the
  // game loop consumes; keyboard input clears it.
  let walkPath: Array<[number, number]> = [];
  // The exitUrl zone we are currently standing in (README roadmap "Map
  // enhancements"): navigating again needs a fresh entry.
  let exitArmed: Zone | null = null;

  // Room roster (id → brief).
  const roster = new Map<string, UserBrief>();

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
    status.setCallState(inCall.size > 0, inCall.has(myId));
    presence.setInCall(inCall);
  };

  const conn = new Connection(opts.room, opts.name, opts.color, {
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
      chat?.history(h.chat, h.you);
      status.setUsers(h.users.length);
      manager.setSelfId(h.you);
      presence.setUsers(h.users, new Set(h.call.map((u) => u.id)));
      // Reconnect-with-token (README §5): `hello.call` is the authoritative
      // roster of the call we were in (if it survived our drop). Zone
      // catch-up `call_start`s (sent right after) refine the zone key.
      calls.clear();
      calls.set("", new Set(h.call.map((u) => u.id)));
      const mine = calls.get("")!;
      if (mine.has(myId)) {
        void manager.rejoinCall(h.call);
      } else if (manager.inCall()) {
        manager.onCallEnd("ended while you were disconnected");
      }
      // A mid-call room joiner may already have received the room-wide
      // `call_start` catch-up before this `hello`; now that the roster is
      // known, light up the in-call badges (README §6.3).
      refreshCallUi();
    },
    onJoined: (u: UserBrief) => {
      world.manager.joined(u);
      roster.set(u.id, u);
      status.bumpUsers(1);
      presence.addUser(u);
    },
    onLeft: (id) => {
      world.manager.left(id);
      roster.delete(id);
      status.bumpUsers(-1);
      presence.removeUser(id);
    },
    onChat: (c: ChatMsg) => {
      chat?.add(c, myId);
      if (c.from !== myId) sidebar.chatActivity(true);
    },
    onTyping: (id, on) => chat?.typing(id, on),
    onMovement: (batch: MovementBatch) => {
      world.manager.movement(batch.m);
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
    // Bubble state (README §6.3): the manager owns the state machine;
    // the room-wide call *state* also drives the headphone badges.
    onCallStart: (ps, youOffer, zone) => {
      const key = zone ?? "";
      calls.set(key, new Set(ps.map((p) => p.id)));
      // A roster containing us replaces any stale provisional membership
      // (a user is in at most one call).
      if (calls.get(key)!.has(myId)) {
        for (const [k, s] of calls) {
          if (k !== key && s.has(myId)) calls.delete(k);
        }
        manager.onCallStart(ps, youOffer);
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
    onCallOffer: (from, sdp) => manager.onCallOffer(from, sdp),
    onCallAnswer: (from, sdp) => manager.onCallAnswer(from, sdp),
    onCallIce: (from, c) => manager.onCallIce(from, c),
    onCallMute: (id, a, v) => manager.onCallMute(id, a, v),
    onCallScreen: (id, on) => manager.onCallScreen(id, on),
    onError: (code) => {
      chat?.system(`server error: ${code}`);
      manager.onError(code);
    },
    onStatus: (s) => {
      status.setConn(s);
      // A dropped connection must NOT tear down the call locally: the
      // server keeps our call membership through the reconnect window, and
      // the next `hello.call` roster is the truth (README §5).
    },
  });

  // Sidebar next to the map (README roadmap "UI redesign"): Main Menu
  // (status + media), Players, Chat — each existing component mounts into
  // its pane. The call theater overlays the map from `#ui`.
  const sidebar = createSidebar();
  const ui = document.getElementById("ui")!; // the theater's overlay layer
  presence = createPresence(sidebar.pane("players"));
  chat = createChat(sidebar.pane("chat"), (t) => conn.sendChat(t), (on) => conn.sendTyping(on));
  const callUI = createCallUI(ui, {
    onHangup: () => manager.hangup(),
    onToggleMute: () => manager.toggleMute(),
    onToggleCamera: () => manager.toggleCamera(),
    onToggleScreen: () => manager.toggleScreen(),
  });
  const manager = new CallManager(conn, {
    onPhase: (ph) => callUI.setPhase(ph),
    onLocalStream: (s) => callUI.setLocalStream(s),
    onPeers: (ps) => callUI.setPeers(ps),
    onLocalMute: (a, v) => callUI.setLocalMute(a, v),
    onLocalScreen: (on) => callUI.setLocalScreen(on),
    onLog: (t) => chat?.system(t),
  });
  const status = createStatus(
    sidebar.pane("menu"),
    (off) => manager.setBubble(off),
    (room) => {
      // Room switch (README §11 Phase 7): leave this room immediately
      // (the server broadcasts `left` and tears the session down), then
      // reload into the target room with the same name + color.
      conn.sendLeave();
      window.setTimeout(() => {
        window.location.href =
          `/play/${room.split("/").map(encodeURIComponent).join("/")}/` +
          `?name=${encodeURIComponent(opts.name)}` +
          `&color=${encodeURIComponent(opts.color)}`;
      }, 150);
    },
  );
  status.setRoom(opts.room);

  // Game loop: integrate local movement, draw, send at ≤10 Hz.
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
    }

    // exitUrl zones (README roadmap "Map enhancements"): walking onto the
    // tile navigates to the target map (the same name + color).
    const cur = map.zones.find((z) => z.exitUrl !== undefined && zoneContains(z, x, y));
    if (cur !== undefined && cur !== exitArmed) {
      exitArmed = cur;
      const target = exitUrlToMapId(cur.exitUrl!);
      conn.sendLeave();
      window.setTimeout(() => {
        window.location.href =
          `/play/${target.split("/").map(encodeURIComponent).join("/")}/` +
          `?name=${encodeURIComponent(opts.name)}` +
          `&color=${encodeURIComponent(opts.color)}`;
      }, 50);
      return;
    }
    if (cur === undefined) exitArmed = null;

    const ts = map.tileSize;
    world.local.setPos(x * ts, y * ts);
    world.local.setDir(dir);
    world.local.setMoving(moving, now);
    world.manager.update(now, ts);
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
  };

  conn.start();
  requestAnimationFrame(tick);
}

main().catch((err) => {
  console.error(err);
  const boot = document.getElementById("boot");
  if (boot) {
    boot.style.display = "grid";
    boot.innerHTML = `<main><h1>🔥 Campfire</h1><p>Something went wrong: ${String(err)}</p></main>`;
  }
});

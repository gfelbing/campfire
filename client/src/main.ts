// Campfire client entry point: boot overlay → map load → Pixi world →
// realtime connection → game loop (README §8).

import { attachKeys, desiredVelocity } from "./input/keys";
import { Connection } from "./net/connection";
import type { ChatMsg, Dir, MovementBatch, UserBrief } from "./net/types";
import { boot } from "./ui/boot";
import { createChat, type ChatUI } from "./ui/chat";
import { createStatus } from "./ui/status";
import { isWalkablePoint, parseMap, type MapData } from "./world/mapdata";
import { createWorld, followCamera } from "./world/render";

/// Local position sends: 10 Hz while moving, 2 Hz while idle (README §5).
const SEND_EVERY_MS = 100;
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

async function main(): Promise<void> {
  const opts = await boot();
  attachKeys();

  const res = await fetch(`/api/v1/maps/${encodeURIComponent(opts.room)}`);
  if (!res.ok) throw new Error(`map fetch failed: ${res.status}`);
  const map = parseMap(opts.room, await res.json());
  const world = await createWorld(map, opts.name, opts.color);

  // Local state, owned by the game loop below.
  let x = map.width / 2 + 0.5; // same formula as the server spawn
  let y = map.height / 2 + 0.5;
  let dir: Dir = "s";
  let moving = false;
  let myId = "";
  let chat: ChatUI | null = null;

  const conn = new Connection(opts.room, opts.name, opts.color, {
    onHello: (h) => {
      myId = h.you;
      const me = h.users.find((u) => u.id === h.you);
      if (me) {
        x = me.x;
        y = me.y;
        dir = me.d;
      }
      world.local.setDir(dir);
      world.manager.hello(h.users, h.you);
      chat?.history(h.chat, h.you);
      status.setUsers(h.users.length);
    },
    onJoined: (u: UserBrief) => {
      world.manager.joined(u);
      status.bumpUsers(1);
    },
    onLeft: (id) => {
      world.manager.left(id);
      status.bumpUsers(-1);
    },
    onChat: (c: ChatMsg) => chat?.add(c, myId),
    onTyping: (id, on) => chat?.typing(id, on),
    onMovement: (batch: MovementBatch) => world.manager.movement(batch.m),
    onError: (code) => chat?.system(`server error: ${code}`),
    onStatus: (s) => status.setConn(s),
  });

  const ui = document.getElementById("ui")!;
  chat = createChat(ui, (t) => conn.sendChat(t), (on) => conn.sendTyping(on));
  const status = createStatus(ui);
  status.setRoom(opts.room);

  // Game loop: integrate local movement, draw, send at ≤10 Hz.
  let lastSend = 0;
  let prev = performance.now();
  const tick = (now: number): void => {
    const dt = Math.min((now - prev) / 1000, 0.1);
    prev = now;

    const v = desiredVelocity(dt);
    moving = v.moving;
    if (moving) {
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
    }

    const ts = map.tileSize;
    world.local.setPos(x * ts, y * ts);
    world.local.setDir(dir);
    world.local.setMoving(moving, now);
    world.manager.update(now, ts);
    followCamera(world, x, y);

    if (now - lastSend >= (moving ? SEND_EVERY_MS : IDLE_EVERY_MS)) {
      lastSend = now;
      conn.sendMove(x, y, dir, moving);
    }
    requestAnimationFrame(tick);
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

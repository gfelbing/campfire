// Campfire client entry point: boot overlay → map load → Pixi world →
// realtime connection → game loop (README §8).

import { CallManager } from "./call/manager";
import { createCallUI } from "./call/callui";
import { attachKeys, desiredVelocity } from "./input/keys";
import { Connection } from "./net/connection";
import type { ChatMsg, Dir, MovementBatch, UserBrief } from "./net/types";
import { boot } from "./ui/boot";
import { createChat, type ChatUI } from "./ui/chat";
import { createPresence, type PresenceUI } from "./ui/presence";
import { createStatus } from "./ui/status";
import { isWalkablePoint, parseMap, type MapData } from "./world/mapdata";
import { createWorld, followCamera } from "./world/render";

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
  let presence: PresenceUI;

  // Room roster (id → brief).
  const roster = new Map<string, UserBrief>();

  // Who is in the room's bubble (room-wide call state, README §6.3): powers
  // the avatars' headphone badge.
  const inCall = new Set<string>();
  const refreshCallUi = (): void => {
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
      // call roster. If the call survived our drop and we are in it,
      // re-establish the media; if it died while we were away, tear down.
      inCall.clear();
      for (const u of h.call) inCall.add(u.id);
      if (inCall.has(myId)) {
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
    onChat: (c: ChatMsg) => chat?.add(c, myId),
    onTyping: (id, on) => chat?.typing(id, on),
    onMovement: (batch: MovementBatch) => world.manager.movement(batch.m),
    // Bubble state (README §6.3): the manager owns the state machine;
    // the room-wide call *state* also drives the headphone badges.
    onCallStart: (ps, youOffer) => {
      inCall.clear();
      for (const p of ps) inCall.add(p.id);
      refreshCallUi();
      manager.onCallStart(ps, youOffer);
    },
    onCallLeave: (id) => {
      inCall.delete(id);
      refreshCallUi();
      manager.onCallLeave(id);
    },
    onCallEnd: (reason) => {
      inCall.clear();
      refreshCallUi();
      manager.onCallEnd(reason);
    },
    onCallOffer: (from, sdp) => manager.onCallOffer(from, sdp),
    onCallAnswer: (from, sdp) => manager.onCallAnswer(from, sdp),
    onCallIce: (from, c) => manager.onCallIce(from, c),
    onCallMute: (id, a, v) => manager.onCallMute(id, a, v),
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

  const ui = document.getElementById("ui")!;
  presence = createPresence(ui);
  chat = createChat(ui, (t) => conn.sendChat(t), (on) => conn.sendTyping(on));
  const callUI = createCallUI(ui, {
    onHangup: () => manager.hangup(),
    onToggleMute: () => manager.toggleMute(),
    onToggleCamera: () => manager.toggleCamera(),
  });
  const manager = new CallManager(conn, {
    onPhase: (ph) => callUI.setPhase(ph),
    onLocalStream: (s) => callUI.setLocalStream(s),
    onPeers: (ps) => callUI.setPeers(ps),
    onLocalMute: (a, v) => callUI.setLocalMute(a, v),
    onLog: (t) => chat?.system(t),
  });
  const status = createStatus(
    ui,
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

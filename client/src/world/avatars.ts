// Avatars: our own + everyone else's, with dead-reckoning interpolation of
// remote positions between 10 Hz datagram snapshots (README §8).

import { Container, Graphics, Text } from "pixi.js";

import type { Dir, UserBrief, UserState } from "../net/types";

const SNAP_MAX_LAG_MS = 150;
const SNAP_THRESHOLD_TILES = 0.3;

export class AvatarView {
  readonly container = new Container();
  private body: Graphics;
  private facing: Graphics;
  label: Text;
  private baseX = 0;
  private baseY = 0;
  private bobbing = false;

  constructor(name: string, color: number) {
    this.body = new Graphics();
    this.facing = new Graphics();
    this.label = new Text({
      text: name,
      style: {
        fill: 0xffffff,
        fontSize: 11,
        fontWeight: "600",
        stroke: { color: 0x14161a, width: 3 },
      },
    });
    this.label.anchor.set(0.5, 1);
    this.label.y = -18;
    this.container.addChild(this.body, this.facing, this.label);
    this.setName(name);
    this.setColor(color);
  }

  setName(name: string): void {
    this.label.text = name;
  }

  setColor(color: number): void {
    this.body
      .clear()
      .circle(0, 0, 10)
      .fill({ color, alpha: 0.95 })
      .stroke({ width: 2, color: 0x14161a, alpha: 0.6 });
  }

  setDir(dir: Dir): void {
    const dx = dir === "e" ? 1 : dir === "w" ? -1 : 0;
    const dy = dir === "s" ? 1 : dir === "n" ? -1 : 0;
    this.facing
      .clear()
      .circle(dx * 6, dy * 6, 2.5)
      .fill({ color: 0xffffff, alpha: 0.9 });
  }

  /** Set the un-bobbed position in pixels. */
  setPos(x: number, y: number): void {
    this.baseX = x;
    this.baseY = y;
    this.apply();
  }

  /** Subtle bob while moving. */
  setMoving(moving: boolean, nowMs: number): void {
    this.bobbing = moving;
    const bob = moving ? Math.sin(nowMs / 90) * 1.2 : 0;
    this.container.position.set(this.baseX, this.baseY + bob);
  }

  private apply(): void {
    const bob = this.bobbing ? Math.sin(performance.now() / 90) * 1.2 : 0;
    this.container.position.set(this.baseX, this.baseY + bob);
  }
}

interface Remote {
  id: string;
  name: string;
  color: number;
  view: AvatarView;
  dir: Dir;
  moving: boolean;
  lastSeq: number;
  // Two newest snapshots for dead reckoning (tile coordinates).
  curX: number;
  curY: number;
  curT: number;
  prevX: number;
  prevY: number;
  prevT: number;
}

const REMOTE_PALETTE = [0xe05f38, 0x4a90d9, 0x58a858, 0x9b59b6, 0xd4a017, 0x16a2a2];

function colorFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return REMOTE_PALETTE[Math.abs(h) % REMOTE_PALETTE.length];
}

export class AvatarManager {
  private remotes = new Map<string, Remote>();
  private layer: Container;

  constructor(layer: Container) {
    this.layer = layer;
  }

  /** Replace the remote set with the hello snapshot (excluding ourself). */
  hello(users: UserState[], myId: string): void {
    const now = performance.now();
    for (const id of this.remotes.keys())
      if (!users.some((u) => u.id === id)) this.left(id);
    for (const u of users) {
      if (u.id === myId) continue;
      const existing = this.remotes.get(u.id);
      if (existing) {
        existing.name = u.name;
        existing.view.setName(u.name);
        existing.dir = u.d;
        existing.view.setDir(u.d);
        existing.curX = u.x;
        existing.curY = u.y;
        existing.curT = now;
      } else {
        const view = new AvatarView(u.name, colorFor(u.id));
        view.setDir(u.d);
        this.layer.addChild(view.container);
        this.remotes.set(u.id, {
          id: u.id,
          name: u.name,
          color: colorFor(u.id),
          view,
          dir: u.d,
          moving: false,
          lastSeq: 0,
          curX: u.x,
          curY: u.y,
          curT: now,
          prevX: u.x,
          prevY: u.y,
          prevT: now,
        });
      }
    }
  }

  joined(user: UserBrief): void {
    const now = performance.now();
    const view = new AvatarView(user.name, colorFor(user.id));
    this.layer.addChild(view.container);
    this.remotes.set(user.id, {
      id: user.id,
      name: user.name,
      color: colorFor(user.id),
      view,
      dir: "s",
      moving: false,
      lastSeq: 0,
      curX: 0,
      curY: 0,
      curT: now,
      prevX: 0,
      prevY: 0,
      prevT: now,
    });
  }

  left(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.layer.removeChild(r.view.container);
    r.view.container.destroy({ children: true });
    this.remotes.delete(id);
  }

  /** Apply one movement batch; keep only entries with a newer sequence. */
  movement(entries: { id: string; x: number; y: number; d: Dir; mv: number; s: number }[]): void {
    const now = performance.now();
    for (const e of entries) {
      const r = this.remotes.get(e.id);
      if (!r || e.s <= r.lastSeq) continue;
      r.lastSeq = e.s;
      r.prevX = r.curX;
      r.prevY = r.curY;
      r.prevT = r.curT;
      r.curX = e.x;
      r.curY = e.y;
      r.curT = now;
      r.dir = e.d;
      r.moving = e.mv === 1;
      r.view.setDir(e.d);
    }
  }

  /** Advance all remote avatars to `nowMs`. */
  update(nowMs: number, tileSize: number): void {
    for (const r of this.remotes.values()) {
      let px: number;
      let py: number;
      if (r.curT === r.prevT || (r.curX === r.prevX && r.curY === r.prevY)) {
        px = r.curX;
        py = r.curY;
      } else {
        const t = Math.min((nowMs - r.prevT) / (r.curT - r.prevT), 1);
        px = r.prevX + (r.curX - r.prevX) * t;
        py = r.prevY + (r.curY - r.prevY) * t;
        // Snap when we drift too far from the newest known position.
        if (Math.hypot(px - r.curX, py - r.curY) > SNAP_THRESHOLD_TILES) {
          px = r.curX;
          py = r.curY;
        }
      }
      r.view.setPos(px * tileSize, py * tileSize);
      r.view.setMoving(r.moving && nowMs - r.curT < SNAP_MAX_LAG_MS + 300, nowMs);
    }
  }
}

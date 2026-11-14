// Avatars: our own + everyone else's, with dead-reckoning interpolation of
// remote positions between 15 Hz datagram snapshots (docs/arch/client.md).

import { Container, Graphics, Text } from "pixi.js";

import type { Dir, OwnStatus, UserBrief, UserState } from "../net/types";

const SNAP_MAX_LAG_MS = 150;

/** How far in the past avatars are rendered (`tRender = now - LOOKAHEAD`).
 *  The snapshot history is then always slightly in the future of the
 *  render point, so each frame interpolates between two received
 *  snapshots instead of jumping to the newest one — a 15 Hz step
 *  function is what made the movement feel laggy. ≈ 2× the 66 ms send
 *  interval, so two snapshots usually bracket the render point. */
const RENDER_LOOKAHEAD_MS = 140;
/** How long to keep extrapolating along the last motion after snapshots
 *  stop arriving (the sender stopped moving) before freezing the avatar. */
const EXTRAPOLATE_MS = 250;
/** Snapshot history depth: ~10 ≈ 1 s at the 15 Hz send rate. */
const SNAP_HISTORY = 10;

export class AvatarView {
  readonly container = new Container();
  private body: Graphics;
  private facing: Graphics;
  label: Text;
  /** 🎧 shown above the label while the user is in a call (docs/arch/protocol.md). */
  private inCallBadge: Text;
  /** 🔇 shown above the label while the user stands in a silentZone. */
  private dndBadge: Text;
  /** Presence dot right of the name (same palette as the Users list). */
  private statusDot: Graphics;
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
    this.inCallBadge = new Text({
      text: "🎧",
      style: {
        fontSize: 11,
      },
    });
    this.inCallBadge.anchor.set(0.5, 1);
    this.inCallBadge.y = -30;
    this.inCallBadge.visible = false;
    this.dndBadge = new Text({
      text: "🔇",
      style: {
        fontSize: 11,
      },
    });
    this.dndBadge.anchor.set(0.5, 1);
    this.dndBadge.y = -42;
    this.dndBadge.visible = false;
    this.statusDot = new Graphics();
    this.container.addChild(
      this.body,
      this.facing,
      this.label,
      this.statusDot,
      this.inCallBadge,
      this.dndBadge,
    );
    this.setName(name);
    this.setColor(color);
    this.setStatus("online");
  }

  setName(name: string): void {
    this.label.text = name;
    this.layoutStatusDot();
  }

  /** Presence dot right of the name: green/amber/red like the Users
   *  list (`presence-status` in style.css). Absent status = `online`. */
  setStatus(status: OwnStatus): void {
    const color = status === "away" ? 0xd4a017 : status === "dnd" ? 0xe06060 : 0x58a858;
    this.statusDot.clear().circle(0, 0, 3).fill({ color }).stroke({ width: 1, color: 0x14161a, alpha: 0.6 });
    this.layoutStatusDot();
  }

  /** The dot sits just left of the (name-width-dependent) label. */
  private layoutStatusDot(): void {
    this.statusDot.position.set(-this.label.width / 2 - 5, -24);
  }

  /** Toggle the headphone badge (call state is room-wide, docs/arch/protocol.md). */
  setInCall(on: boolean): void {
    this.inCallBadge.visible = on;
  }

  /** Toggle the 🔇 do-not-disturb badge (silentZone occupancy). */
  setDnd(on: boolean): void {
    this.dndBadge.visible = on;
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

/** One received movement snapshot (tile coordinates, arrival-time
 *  stamped). */
interface Snap {
  x: number;
  y: number;
  t: number;
}

interface Remote {
  id: string;
  name: string;
  color: number;
  view: AvatarView;
  dir: Dir;
  moving: boolean;
  lastSeq: number;
  /** Snapshot history, oldest → newest (depth ~SNAP_HISTORY): the
   *  interpolation source for `update` (see RENDER_LOOKAHEAD_MS). */
  snap: Snap[];
}

const REMOTE_PALETTE = [0xe05f38, 0x4a90d9, 0x58a858, 0x9b59b6, 0xd4a017, 0x16a2a2];

function colorFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return REMOTE_PALETTE[Math.abs(h) % REMOTE_PALETTE.length];
}

/** Parse a `#rgb`/`#rrggbb` color string; `null` when malformed. */
function parseColor(color: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return parseInt(hex, 16);
}

/** The avatar's color: the user's chosen one (sent in the rosters) when
 *  present and valid, else a stable hash of their id. */
function colorOf(user: { id: string; color?: string }): number {
  const parsed = user.color !== undefined ? parseColor(user.color) : null;
  return parsed ?? colorFor(user.id);
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
        // The roster is the color authority: re-apply it on reconnect.
        existing.color = colorOf(u);
        existing.view.setColor(existing.color);
        existing.view.setStatus(u.status ?? "online");
        // The hello snapshot is authoritative: reset the history to it.
        existing.snap = [{ x: u.x, y: u.y, t: now }];
      } else {
        const color = colorOf(u);
        const view = new AvatarView(u.name, color);
        view.setDir(u.d);
        view.setStatus(u.status ?? "online");
        this.layer.addChild(view.container);
        this.remotes.set(u.id, {
          id: u.id,
          name: u.name,
          color,
          view,
          dir: u.d,
          moving: false,
          lastSeq: 0,
          snap: [{ x: u.x, y: u.y, t: now }],
        });
      }
    }
  }

  joined(user: UserBrief): void {
    const now = performance.now();
    const color = colorOf(user);
    const view = new AvatarView(user.name, color);
    view.setStatus(user.status ?? "online");
    this.layer.addChild(view.container);
    this.remotes.set(user.id, {
      id: user.id,
      name: user.name,
      color,
      view,
      dir: "s",
      moving: false,
      lastSeq: 0,
      snap: [{ x: 0, y: 0, t: now }],
    });
  }

  left(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.layer.removeChild(r.view.container);
    r.view.container.destroy({ children: true });
    this.remotes.delete(id);
    this.lastTiles.delete(id);
  }

  /** Toggle the headphone badge on one remote avatar (docs/arch/protocol.md). */
  setInCall(id: string, on: boolean): void {
    this.remotes.get(id)?.view.setInCall(on);
  }

  /** Toggle the 🔇 badge on one remote avatar (silentZone occupancy). */
  setDnd(id: string, on: boolean): void {
    this.remotes.get(id)?.view.setDnd(on);
  }

  /** Presence dot on one remote avatar (`status` events + rosters). */
  setStatus(id: string, status: OwnStatus): void {
    this.remotes.get(id)?.view.setStatus(status);
  }

  /** Apply one movement batch; keep only entries with a newer sequence. */
  movement(entries: { id: string; x: number; y: number; d: Dir; mv: number; s: number }[]): void {
    const now = performance.now();
    for (const e of entries) {
      const r = this.remotes.get(e.id);
      if (!r) continue;
      if (e.s < r.lastSeq) {
        // Downward jump: the sender's sequence restarted. A rejoin with
        // the token starts the movement sequence at 0 again, and the
        // server resets its own counter to match (world.rs `join`); its
        // stale guard rejects any older-epoch batch before broadcast, so
        // a lower sequence can only be a new epoch. Reset the guard.
        r.lastSeq = 0;
      }
      if (e.s <= r.lastSeq) continue;
      r.lastSeq = e.s;
      r.snap.push({ x: e.x, y: e.y, t: now });
      if (r.snap.length > SNAP_HISTORY) r.snap.shift();
      r.dir = e.d;
      r.moving = e.mv === 1;
      r.view.setDir(e.d);
    }
  }

  /** Last interpolated positions in tile coords (filled by `update`). */
  private lastTiles = new Map<string, [number, number]>();

  /** The avatars' current positions in tile coords (id → [x, y]). */
  positions(): Map<string, [number, number]> {
    return this.lastTiles;
  }

  /**
   * Last *received* positions in tile coords (id → [x, y]). Unlike
   * `positions` (interpolated, filled each frame by `update`), this is
   * refreshed by `movement` as datagrams arrive — so it stays current on
   * background tabs whose requestAnimationFrame loop is throttled.
   */
  latestPositions(): Map<string, [number, number]> {
    const out = new Map<string, [number, number]>();
    for (const [id, r] of this.remotes) {
      const n = r.snap[r.snap.length - 1];
      if (n) out.set(id, [n.x, n.y]);
    }
    return out;
  }

  /** Advance all remote avatars to `nowMs`. */
  update(nowMs: number, tileSize: number): void {
    this.lastTiles.clear();
    for (const [id, r] of this.remotes) {
      const [px, py] = this.interpolated(r, nowMs);
      this.lastTiles.set(id, [px, py]);
      r.view.setPos(px * tileSize, py * tileSize);
      const newest = r.snap[r.snap.length - 1];
      r.view.setMoving(
        r.moving && newest !== undefined && nowMs - newest.t < SNAP_MAX_LAG_MS + 300,
        nowMs,
      );
    }
  }

  /**
   * The position to render for `r` at `nowMs`.
   *
   * Renders the snapshot history at `nowMs - RENDER_LOOKAHEAD_MS` instead
   * of at `nowMs`. The history is then slightly in the future of the
   * render point, so each frame interpolates between the two snapshots
   * that bracket it — smooth 60 fps motion instead of a 15 Hz step
   * function (the old code clamped `t` to 1 because `now >= curT` always
   * held at render time, which is what made avatars lag).
   *
   * If no snapshot brackets the render point because the newest is older
   * than it (the sender stopped moving, or a gap), extrapolate along the
   * last motion for up to EXTRAPOLATE_MS, then freeze.
   */
  private interpolated(r: Remote, nowMs: number): [number, number] {
    const h = r.snap;
    const newest = h[h.length - 1];
    if (!newest) return [0, 0];
    // One snapshot cannot bracket or extrapolate: render it as-is. This is
    // the just-joined window (the history starts with a single entry),
    // where the render point is usually still ahead of it.
    if (h.length === 1) return [newest.x, newest.y];
    const target = nowMs - RENDER_LOOKAHEAD_MS;

    if (newest.t <= target) {
      // The render point is past the newest snapshot: the sender stopped.
      // While we still think they were moving, keep them going along the
      // last motion for a short margin, then freeze at the last position.
      const over = target - newest.t;
      if (r.moving && over <= EXTRAPOLATE_MS && h.length >= 2) {
        const prev = h[h.length - 2];
        const span = newest.t - prev.t;
        if (span > 0) {
          const vx = ((newest.x - prev.x) / span) * 1000;
          const vy = ((newest.y - prev.y) / span) * 1000;
          const dt = over / 1000;
          return [newest.x + vx * dt, newest.y + vy * dt];
        }
      }
      return [newest.x, newest.y];
    }

    // Walk back to the last snapshot at or before the render point, then
    // interpolate to the next. Clamp t to [0, 1] for the boundary cases
    // (a just-joined avatar whose whole history is after the render point,
    // or two snapshots at the same instant).
    let i = h.length - 1;
    while (i > 0 && h[i].t > target) i--;
    const a = h[i];
    const b = h[i + 1];
    const span = b.t - a.t;
    if (span <= 0) return [b.x, b.y];
    const t = Math.min(Math.max((target - a.t) / span, 0), 1);
    return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
  }
}

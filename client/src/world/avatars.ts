// Avatars: our own + everyone else's, with dead-reckoning interpolation of
// remote positions between 15 Hz datagram snapshots (docs/arch/client.md).

import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";

import type { Dir, OwnStatus, UserBrief, UserState } from "../net/types";
import { iconCanvas } from "../ui/pixicons";
import {
  CELL_H,
  IDLE_FRAME,
  LAYER_COUNT,
  TOP_LAYER,
  WALK_CYCLE,
  WALK_FRAME_MS,
  deriveLook,
  isHairRow,
  layerFrame,
  normalizeLook,
  type Look,
} from "./characters";

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

/** The sprites render at 1.5× (a 20×32 cell becomes 30×48 px — between
 *  one tile and the full WorkAdventure two-tile presence on the 32 px
 *  map); the nearest-scaled pixels stay crisp. */
const SPRITE_SCALE = 1.5;

export class AvatarView {
  readonly container = new Container();
  private body: Graphics;
  private facing: Graphics;
  /** The pixel-art sprite stack (one sprite per look layer: body,
   *  bottom, mid, head — framed cells of the avatar sheets); null until
   *  the sheets are loaded — the circle below is the fallback. */
  private sprites: Sprite[] | null = null;
  private look: Look | null = null;
  private color = 0xffffff;
  private dir: Dir = "s";
  private moving = false;
  label: Text;
  /** The pixel in-call badge above the label (docs/arch/protocol.md);
   *  rasterized from the pixel icon svg on demand (headless tests have
   *  no DOM to rasterize on). */
  private inCallBadge: Sprite | null = null;
  /** The requested badge state while the raster is in flight. */
  private inCallOn = false;
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
    // Above the sprite's head (its top sits at −CELL_H/2·SPRITE_SCALE),
    // with the call and dnd badges stacked over it in even steps. All the
    // overlays hang off the label's line (see `layoutStatusDot`).
    this.label.y = -24 * SPRITE_SCALE;
    this.statusDot = new Graphics();
    this.container.addChild(
      this.body,
      this.facing,
      this.label,
      this.statusDot,
    );
    this.setName(name);
    this.setColor(color);
    this.setStatus("online");
  }
  /** Attach the pixel-art sprite stack for `look` (body/bottom/mid/top):
   *  replaces the fallback circle once the avatar sheets are loaded. */
  setLook(rawLook: Look): void {
    // Clamp against the sheets: a bad wire value falls back to the caller's
    // (already valid) pick instead of crashing the renderer.
    const look = normalizeLook(rawLook, rawLook);
    if (
      this.look &&
      look.skin === this.look.skin &&
      look.top === this.look.top &&
      look.mid === this.look.mid &&
      look.bottom === this.look.bottom
    ) {
      return;
    }
    this.look = look;
    if (!this.sprites) {
      const stack: Sprite[] = [];
      for (let layer = 0; layer < LAYER_COUNT; layer++) {
        if (!layerFrame(layer, look, this.dir, IDLE_FRAME)) return; // sheets not loaded (or failed)
        // The feet stand on the avatar's tile: the cell bottom sits at the
        // tile's bottom edge (the position is the tile center, and the
        // cell height equals the tile size). Scaled up (`SPRITE_SCALE`),
        // the anchor keeps the feet planted where they were. Inserted in
        // ascending layer order so the layers draw body → bottom →
        // mid → top (hair/caps).
        const sprite = new Sprite();
        sprite.anchor.set(0.5, 1);
        sprite.scale.set(SPRITE_SCALE);
        sprite.y = CELL_H / 2;
        stack.push(sprite);
        this.container.addChildAt(sprite, layer);
      }
      this.sprites = stack;
      // The circle fallback (and its facing dot) only render when the
      // sheets are missing.
      this.body.visible = false;
      this.facing.visible = false;
    }
    this.refreshFrame(performance.now());
    // Hair carries the user's profile color; caps stay untinted (also on
    // a later look change, not just when the sprites are first built).
    this.sprites![TOP_LAYER]!.tint = isHairRow(look) ? this.color : 0xffffff;
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

  /** The dot sits just left of the (name-width-dependent) label, on the
   *  label's vertical center (the label is anchored at its bottom, so its
   *  center is half a text height above the anchor line). */
  private layoutStatusDot(): void {
    this.statusDot.position.set(
      -this.label.width / 2 - 5,
      this.label.y - this.label.height / 2,
    );
  }

  /** Toggle the headphone badge (call state is room-wide, docs/arch/protocol.md). */
  setInCall(on: boolean): void {
    this.inCallOn = on;
    if (
      on &&
      !this.inCallBadge &&
      typeof document !== "undefined"
    ) {
      // Rasterize the pixel icon once, on first use.
      void iconCanvas("headphones", 16).then((canvas) => {
        if (!this.inCallOn) return; // toggled off while rasterizing
        const badge = new Sprite(Texture.from(canvas));
        badge.anchor.set(0.5, 1);
        badge.y = this.label.y - 15;
        badge.visible = true;
        this.inCallBadge = badge;
        this.container.addChild(badge);
      });
    }
    if (this.inCallBadge) this.inCallBadge.visible = on;
  }

  setColor(color: number): void {
    this.color = color;
    if (this.sprites && this.look) {
      this.sprites[TOP_LAYER]!.tint = isHairRow(this.look) ? color : 0xffffff;
    }
    this.body
      .clear()
      .circle(0, 0, 10)
      .fill({ color, alpha: 0.95 })
      .stroke({ width: 2, color: 0x14161a, alpha: 0.6 });
  }

  setDir(dir: Dir): void {
    // Same-direction calls arrive every frame while the local avatar idles
    // (the tick unconditionally feeds setPos/setDir/setMoving); skip the
    // frame-keyed texture work when the direction did not change.
    if (dir === this.dir) return;
    this.dir = dir;
    this.refreshFrame(performance.now());
  }

  /** The cells for the current direction and walk phase: one cell per
   *  look layer (body, bottom, mid, top) from the sheets' direction
   *  block, cycling the 6-frame walk while moving, the contact cell
   *  while idle. */
  private refreshFrame(nowMs: number): void {
    if (!this.sprites || !this.look) return;
    const frame = this.moving
      ? WALK_CYCLE[Math.floor(nowMs / WALK_FRAME_MS) % WALK_CYCLE.length]
      : IDLE_FRAME;
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const tex = layerFrame(layer, this.look, this.dir, frame);
      if (!tex) continue; // a missing layer's sheet contributes nothing
      this.sprites[layer]!.texture = tex;
    }
  }

  /** Set the un-bobbed position in pixels. */
  setPos(x: number, y: number): void {
    this.baseX = x;
    this.baseY = y;
    this.apply();
  }

  /** Subtle bob while moving. */
  setMoving(moving: boolean, nowMs: number): void {
    const changed = moving !== this.moving;
    this.moving = moving;
    this.bobbing = moving;
    const bob = moving ? Math.sin(nowMs / 90) * 1.2 : 0;
    this.container.position.set(this.baseX, this.baseY + bob);
    // The walk cycle needs a re-pick only while the state is `moving`
    // (the cycle advances with the frame); an unchanged idle state redraws
    // the same idle cell every frame otherwise.
    if (changed || moving) this.refreshFrame(nowMs);
  }

  private apply(): void {
    const bob = this.bobbing ? Math.sin(performance.now() / 90) * 1.2 : 0;
    this.container.position.set(this.baseX, this.baseY + bob);
    // Overlapping avatars sort by their feet: the lower one draws last.
    // Skip the write when unchanged: `sortableChildren` makes Pixi resort
    // the layer's children when any zIndex changes, and a per-frame write
    // from every avatar forces that sort sixty times a second.
    if (this.container.zIndex !== this.baseY) this.container.zIndex = this.baseY;
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

/** The avatar's look: the user's chosen one (rosters carry it) when
 *  present, else a stable hash of their name (the id is random per
 *  session). */
function lookOf(user: { name: string; skin?: number; top?: number; mid?: number; bottom?: number }): Look {
  return normalizeLook(
    { skin: user.skin, top: user.top, mid: user.mid, bottom: user.bottom },
    deriveLook(user.name),
  );
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
    // Overlapping avatars sort by depth (the container's `zIndex`, set to
    // the un-bobbed y in `AvatarView.apply`).
    layer.sortableChildren = true;
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
        // The roster is the color/look authority: re-apply both on
        // reconnect (and after an identity change).
        existing.color = colorOf(u);
        existing.view.setColor(existing.color);
        existing.view.setLook(lookOf(u));
        existing.view.setStatus(u.status ?? "online");
        // The hello snapshot is authoritative: reset the history to it.
        existing.snap = [{ x: u.x, y: u.y, t: now }];
      } else {
        const color = colorOf(u);
        const view = new AvatarView(u.name, color);
        view.setDir(u.d);
        view.setStatus(u.status ?? "online");
        view.setLook(lookOf(u));
        this.layer.addChild(view.container);
        this.remotes.set(u.id, {
          id: u.id,
          name: u.name,
          color,
          view,
          dir: u.d,          moving: false,
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
    view.setLook(lookOf(user));
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

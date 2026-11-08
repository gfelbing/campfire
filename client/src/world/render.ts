// PixiJS world: tile map, avatars, camera.

import { Application, Assets, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";

import type { MapData, TilesetRef } from "./mapdata";
import { AvatarManager, AvatarView } from "./avatars";

/** Tiled stores flip flags in the GID's high bits (no diagonal support yet). */
const GID_MASK = 0x1fffffff;
const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;

export interface World {
  app: Application;
  map: MapData;
  world: Container;
  /** The proximity bubble: a one-tile circle at the participants' centroid. */
  bubble: Graphics;
  avatars: Container;
  local: AvatarView;
  manager: AvatarManager;
  /** Click-to-walk callback (README roadmap "Map enhancements"): set to
   *  receive the clicked tile coordinates; unset to ignore clicks. */
  onClick: { cb: ((x: number, y: number) => void) | null };
}

export async function createWorld(
  map: MapData,
  localName: string,
  localColor: string,
): Promise<World> {
  const app = new Application();
  await app.init({
    resizeTo: document.getElementById("app") ?? window,
    background: 0x0d0f12,
    antialias: true,
  });
  document.getElementById("app")!.appendChild(app.canvas);

  const world = new Container();
  app.stage.addChild(world);

  /** The tileset a GID belongs to, and the tile's local id in it. */
  const tilesetFor = (gid: number): { ts: TilesetRef; local: number } | undefined => {
    for (let i = map.tilesets.length - 1; i >= 0; i--) {
      const ts = map.tilesets[i]!;
      if (gid >= ts.firstgid) return { ts, local: gid - ts.firstgid };
    }
    return undefined;
  };

  // Load the tileset images (served next to the map JSON).
  const textures = new Map<string, Texture>();
  await Promise.all(
    map.tilesets.map(async (ts) => {
      try {
        textures.set(ts.image, await Assets.load(`/api/v1/maps/${map.id}/${ts.image}`));
      } catch {
        // missing image: the tileset simply contributes no pixels
      }
    }),
  );

  // One sprite per non-empty cell, layers in draw order.
  const tiles = new Container();
  const ts = map.tileSize;
  for (const layer of map.draw) {
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const raw = layer.data[y * map.width + x]!;
        const gid = raw & GID_MASK;
        if (gid === 0) continue;
        const hit = tilesetFor(gid);
        const texture = hit && textures.get(hit.ts.image);
        if (!hit || !texture) continue;
        const { ts: set, local } = hit;
        const sx = set.margin ?? 0;
        const sy = set.margin ?? 0;
        const frame = new Rectangle(
          sx + (local % set.columns) * (set.tilewidth + (set.spacing ?? 0)),
          sy + Math.floor(local / set.columns) * (set.tileheight + (set.spacing ?? 0)),
          set.tilewidth,
          set.tileheight,
        );
        const sprite = new Sprite({ texture: new Texture({ source: texture.source, frame }) });
        sprite.x = x * ts;
        sprite.y = y * ts;
        if (raw & FLIP_H) sprite.scale.x = -1;
        if (raw & FLIP_V) sprite.scale.y = -1;
        tiles.addChild(sprite);
      }
    }
  }
  world.addChild(tiles);

  const bubble = new Graphics();
  world.addChild(bubble);

  // Zone overlays (README roadmap "Map enhancements"): jitsi rooms in blue
  // (meeting rooms), silent zones in gray (muted proximity audio).
  const zones = new Graphics();
  for (const z of map.zones) {
    const [zx, zy, zw, zh] = z.rect;
    if (z.jitsiRoom !== undefined) {
      zones
        .rect(zx * ts, zy * ts, zw * ts, zh * ts)
        .fill({ color: 0x3f8fd8, alpha: 0.14 })
        .stroke({ width: 2, color: 0x3f8fd8, alpha: 0.6 });
    } else if (z.silent) {
      zones
        .rect(zx * ts, zy * ts, zw * ts, zh * ts)
        .fill({ color: 0x777c88, alpha: 0.18 })
        .stroke({ width: 2, color: 0x9aa0ad, alpha: 0.45 });
    }
  }
  world.addChild(zones);

  const avatars = new Container();
  world.addChild(avatars);

  const local = new AvatarView(localName, parseHex(localColor));
  avatars.addChild(local.container);

  // Zoom: the wheel scales the world container (1.0 = 1:1 tiles, 0.5–3).
  const applyZoom = (z: number): void => {
    const clamped = Math.min(3, Math.max(0.5, z));
    world.scale.set(clamped);
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    applyZoom(world.scale.x * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  };
  app.canvas.addEventListener("wheel", onWheel, { passive: false });

  // Click-to-walk (README roadmap "Map enhancements"): the callback returns
  // the clicked tile coordinates (world-space), or null for a miss.
  const onClick: { cb: ((x: number, y: number) => void) | null } = { cb: null };
  app.canvas.addEventListener("pointerdown", (e) => {
    if (!onClick.cb) return;
    // Screen → world: the world container's position + scale.
    const rect = app.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wx = (sx - world.position.x) / world.scale.x;
    const wy = (sy - world.position.y) / world.scale.y;
    onClick.cb(wx / ts, wy / ts);
  });

  return {
    app,
    map,
    world,
    bubble,
    avatars,
    local,
    manager: new AvatarManager(avatars),
    onClick,
  };
}

/** Draw the proximity bubble: a one-tile circle around the centroid of the
 *  participants' tile positions (README §6.3). Empty `pts` clears it. */
export function drawBubble(world: World, pts: Array<[number, number]>): void {
  world.bubble.clear();
  if (pts.length === 0) return;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;
  const ts = world.map.tileSize;
  world.bubble
    .circle(cx * ts, cy * ts, ts)
    .fill({ color: 0x58a858, alpha: 0.15 })
    .stroke({ width: 2, color: 0x58a858, alpha: 0.6 });
}

function parseHex(color: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  return m ? Number.parseInt(m[1], 16) : 0xe05f38;
}

/** Center the camera on our avatar (zoom-aware: the world container's
 *  position is the screen offset, so the scale divides it). */
export function followCamera(world: World, x: number, y: number): void {
  const ts = world.map.tileSize;
  const { width, height } = world.app.screen;
  const s = world.world.scale.x;
  world.world.position.set(width / 2 - x * ts * s, height / 2 - y * ts * s);
}

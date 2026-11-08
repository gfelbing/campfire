// PixiJS world: tile map, avatars, camera.

import { Application, Assets, Container, Rectangle, Sprite, Texture } from "pixi.js";

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
  avatars: Container;
  local: AvatarView;
  manager: AvatarManager;
}

export async function createWorld(
  map: MapData,
  localName: string,
  localColor: string,
): Promise<World> {
  const app = new Application();
  await app.init({
    resizeTo: window,
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

  const avatars = new Container();
  world.addChild(avatars);

  const local = new AvatarView(localName, parseHex(localColor));
  avatars.addChild(local.container);

  return {
    app,
    map,
    world,
    avatars,
    local,
    manager: new AvatarManager(avatars),
  };
}

function parseHex(color: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  return m ? Number.parseInt(m[1], 16) : 0xe05f38;
}

/** Center the camera on our avatar. */
export function followCamera(world: World, x: number, y: number): void {
  const ts = world.map.tileSize;
  const { width, height } = world.app.screen;
  world.world.position.set(width / 2 - x * ts, height / 2 - y * ts);
}

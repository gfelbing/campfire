// PixiJS world: tile map, avatars, camera.

import { Application, Container, Graphics } from "pixi.js";

import type { MapData } from "./mapdata";
import { AvatarManager, AvatarView } from "./avatars";

// Ground GID → color (matches scripts/gen_maps.py tileset).
const GROUND_COLORS: Record<number, number> = {
  0: 0x1d3557, // water
  1: 0xe9e4d8, // floor
  2: 0x4a4e57, // wall / rock
};

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

  // Tiles: one Graphics per map (a few thousand rects, fine for WebGL).
  const ts = map.tileSize;
  const tiles = new Graphics();
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const gid = map.ground[y * map.width + x];
      const color = GROUND_COLORS[gid] ?? GROUND_COLORS[1];
      tiles
        .rect(x * ts, y * ts, ts, ts)
        .fill(color)
        .rect(x * ts + 0.5, y * ts + 0.5, ts - 1, ts - 1)
        .stroke({ width: 1, color: 0x000000, alpha: 0.07 });
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

// The Tiled JSON subset the client consumes (orthogonal, tile layers).
// See campfire-maps for the server-side parser.

export interface TileLayer {
  type: "tilelayer" | "group" | "objectgroup";
  name: string;
  width: number;
  height: number;
  visible?: boolean;
  data?: number[];
  layers?: TileLayer[];
  /** Object layers only (README roadmap "Map enhancements"). */
  objects?: TiledObject[];
}

export interface TiledObject {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  properties?: Array<{ name: string; value: unknown }>;
}

/** One named rectangular zone (README roadmap "Map enhancements"): in tile
 *  units, `rect = (x, y, w, h)` of the top-left tile corner. */
export interface Zone {
  name: string;
  rect: [number, number, number, number];
  /** `jitsiRoom`: a meeting-room call covers this whole zone. */
  jitsiRoom?: string;
  /** `silentZone`: proximity audio is muted inside. */
  silent?: boolean;
  /** `exitUrl`: walking onto this zone navigates elsewhere. */
  exitUrl?: string;
  /** Spawn area: the object is named `start` or has a truthy `start`
   *  property. */
  start?: boolean;
}

export function zoneContains(z: Zone, x: number, y: number): boolean {
  const [zx, zy, zw, zh] = z.rect;
  return x >= zx && y >= zy && x < zx + zw && y < zy + zh;
}

function prop(o: TiledObject, name: string): unknown {
  return o.properties?.find((p) => p.name === name)?.value;
}

export interface TilesetRef {
  firstgid: number;
  name: string;
  tilewidth: number;
  tileheight: number;
  image: string;
  columns: number;
  count: number;
  /** Pixels from the sheet edge to the first tile, and between tiles. */
  margin?: number;
  spacing?: number;
}

/** One renderable tile layer, in draw order (bottom first). */
export interface DrawLayer {
  name: string;
  data: Uint32Array;
}

export interface TiledMap {
  type: "map";
  orientation: string;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TileLayer[];
  tilesets?: TilesetRef[];
}

export interface MapData {
  id: string;
  width: number;
  height: number;
  tileSize: number;
  /** Ground GIDs, row-major (y * width + x). 0 = water, 1 = floor, 2 = wall. */
  ground: Uint32Array;
  /** Collision GIDs, row-major. 0 = walkable, non-zero = blocked. */
  collision: Uint32Array;
  /** Tilesets referenced by the map (embedded; images relative to the map). */
  tilesets: TilesetRef[];
  /** Visible tile layers in draw order, collision layers excluded. */
  draw: DrawLayer[];
  /** Object-layer zones (README roadmap "Map enhancements"). */
  zones: Zone[];
  /** Spawn point in tile coordinates (the `start` area's center, else the
   *  map center — the server's spawn is authoritative; this is the same
   *  formula, so the first local position matches). */
  spawn: [number, number];
}

export function parseMap(id: string, raw: TiledMap): MapData {
  const width = raw.width;
  const height = raw.height;
  const cells = width * height;
  const ground = new Uint32Array(cells);
  const zones: Zone[] = [];
  const collision = new Uint32Array(cells);
  const draw: DrawLayer[] = [];
  // Walk the layer tree; group layers nest their children (depth-first, so
  // draw order follows the Tiled layer list).
  const visit = (layers: TileLayer[]): void => {
    for (const layer of layers) {
      if (layer.type === "group" && layer.layers) {
        visit(layer.layers);
        continue;
      }
      if (layer.type === "objectgroup") {
        for (const o of layer.objects ?? []) {
          const ts = raw.tilewidth;
          const jitsi = prop(o, "jitsiRoom");
          const silent = prop(o, "silentZone") || prop(o, "silent");
          const exit = prop(o, "exitUrl");
          // Spawn area: an object named `start`, or a truthy `start`
          // property — the server's `prop_bool` accepts any truthy value,
          // so match it here (a `start: "yes"` object is a spawn area on
          // both sides).
          const isStart = o.name === "start" || Boolean(prop(o, "start"));
          if (jitsi === undefined && !silent && exit === undefined && !isStart) continue;
          zones.push({
            name: o.name,
            rect: [o.x / ts, o.y / ts, o.width / ts, o.height / ts],
            jitsiRoom: typeof jitsi === "string" ? jitsi : undefined,
            silent: Boolean(silent),
            exitUrl: typeof exit === "string" ? exit : undefined,
            start: isStart,
          });
        }
        continue;
      }
      if (layer.type !== "tilelayer" || layer.data?.length !== cells) continue;
      if (layer.name === "ground" || layer.name === "floor1") ground.set(layer.data);
      if (layer.name === "collision" || layer.name === "collisions") {
        collision.set(layer.data);
        continue; // collision layers shape walkability, not the picture
      }
      if (layer.visible === false) continue;
      draw.push({ name: layer.name, data: Uint32Array.from(layer.data!) });
    }
  };
  visit(raw.layers);
  const tilesets: TilesetRef[] = raw.tilesets ?? [];
  // Spawn: the `start` area's center if walkable, else the map center (the
  // server's `spawn` is authoritative; this is the same formula, so the
  // first local position matches the server's).
  const start = zones.find((z) => z.start);
  let spawn: [number, number] = [width / 2, height / 2];
  if (start) {
    const [sx, sy, sw, sh] = start.rect;
    spawn = [sx + sw / 2, sy + sh / 2];
  }
  return {
    id,
    width,
    height,
    tileSize: raw.tilewidth,
    ground,
    collision,
    tilesets,
    draw,
    zones,
    spawn,
  };
}

export function tileAt(map: MapData, arr: Uint32Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return 1; // wall-ish default
  return arr[y * map.width + x];
}

/** Walkability of a point in tile coordinates. */
export function isWalkablePoint(map: MapData, x: number, y: number): boolean {
  return tileAt(map, map.collision, Math.floor(x), Math.floor(y)) === 0;
}

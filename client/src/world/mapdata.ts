// The Tiled JSON subset the client consumes (orthogonal, tile layers).
// See campfire-maps for the server-side parser.

export interface TileLayer {
  type: "tilelayer";
  name: string;
  width: number;
  height: number;
  data: number[];
}

export interface TilesetRef {
  firstgid: number;
  name: string;
  tilewidth: number;
  tileheight: number;
  image: string;
  columns: number;
  count: number;
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
}

export function parseMap(id: string, raw: TiledMap): MapData {
  const width = raw.width;
  const height = raw.height;
  const cells = width * height;
  const ground = new Uint32Array(cells);
  const collision = new Uint32Array(cells);
  for (const layer of raw.layers) {
    if (layer.type !== "tilelayer" || layer.data.length !== cells) continue;
    if (layer.name === "ground") ground.set(layer.data);
    else if (layer.name === "collision") collision.set(layer.data);
  }
  return {
    id,
    width,
    height,
    tileSize: raw.tilewidth,
    ground,
    collision,
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

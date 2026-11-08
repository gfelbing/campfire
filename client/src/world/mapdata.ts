// The Tiled JSON subset the client consumes (orthogonal, tile layers).
// See campfire-maps for the server-side parser.

export interface TileLayer {
  type: "tilelayer" | "group";
  name: string;
  width: number;
  height: number;
  visible?: boolean;
  data?: number[];
  layers?: TileLayer[];
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
}

export function parseMap(id: string, raw: TiledMap): MapData {
  const width = raw.width;
  const height = raw.height;
  const cells = width * height;
  const ground = new Uint32Array(cells);
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
  return {
    id,
    width,
    height,
    tileSize: raw.tilewidth,
    ground,
    collision,
    tilesets,
    draw,
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

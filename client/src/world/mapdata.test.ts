import { describe, expect, it } from "vitest";
import {
  isWalkablePoint,
  parseMap,
  tileAt,
  zoneContains,
  type TiledMap,
} from "./mapdata";

/** A 4x4 map (32 px tiles): ground + collision rows, one meeting zone, one
 *  silent zone, and a spawn area named `start` (center tile (2,2)). */
function testMap(): TiledMap {
  return {
    type: "map",
    orientation: "orthogonal",
    width: 4,
    height: 4,
    tilewidth: 32,
    tileheight: 32,
    tilesets: [
      {
        firstgid: 1,
        name: "tiles",
        tilewidth: 32,
        tileheight: 32,
        image: "tiles.png",
        columns: 8,
        count: 64,
      },
    ],
    layers: [
      {
        type: "tilelayer",
        name: "ground",
        width: 4,
        height: 4,
        data: [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1],
      },
      {
        type: "tilelayer",
        name: "collision",
        width: 4,
        height: 4,
        data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
      },
      {
        type: "objectgroup",
        name: "zones",
        width: 4,
        height: 4,
        objects: [
          {
            name: "meeting",
            x: 32,
            y: 32,
            width: 64,
            height: 64,
            properties: [{ name: "jitsiRoom", value: "team" }],
          },
          {
            name: "quiet",
            x: 0,
            y: 96,
            width: 32,
            height: 32,
            properties: [{ name: "silentZone", value: true }],
          },
          { name: "start", x: 32, y: 32, width: 64, height: 64 },
        ],
      },
    ],
  };
}

describe("parseMap", () => {
  const map = parseMap("test", testMap());

  it("parses zones with their properties", () => {
    expect(map.zones).toHaveLength(3);
    const meeting = map.zones.find((z) => z.jitsiRoom)?.jitsiRoom;
    expect(meeting).toBe("team");
    expect(map.zones.some((z) => z.silent)).toBe(true);
    expect(map.zones.some((z) => z.start)).toBe(true);
  });

  it("copies the ground row and sizes the map", () => {
    expect(map.width).toBe(4);
    expect(map.height).toBe(4);
    expect(map.tileSize).toBe(32);
    // Row-major: (x=1, y=1) → index 5.
    expect(map.ground[5]).toBe(0);
    expect(map.ground[10]).toBe(2);
  });

  it("spawns at the start area's center", () => {
    expect(map.spawn).toEqual([2, 2]);
  });
});

describe("zoneContains", () => {
  const map = parseMap("test", testMap());
  const meeting = map.zones.find((z) => z.jitsiRoom)!;

  it("is half-open: the far edge is outside", () => {
    expect(zoneContains(meeting, 2.5, 2.5)).toBe(true);
    expect(zoneContains(meeting, 0.5, 0.5)).toBe(false);
    // meeting's rect is (1,1,2,2): x=3 is the first outside tile.
    expect(zoneContains(meeting, 3.0, 1.5)).toBe(false);
  });
});

describe("tileAt / isWalkablePoint", () => {
  const map = parseMap("test", testMap());

  it("treats out-of-bounds as a wall", () => {
    expect(tileAt(map, map.ground, -1, 0)).toBe(1);
    expect(tileAt(map, map.ground, map.width, 0)).toBe(1);
  });

  it("floors the point to its tile before the collision check", () => {
    // Tile (2,2) carries collision GID 1.
    expect(isWalkablePoint(map, 2.9, 2.1)).toBe(false);
    expect(isWalkablePoint(map, 1.9, 0.9)).toBe(true);
  });
});

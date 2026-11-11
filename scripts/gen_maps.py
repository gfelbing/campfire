#!/usr/bin/env python3
"""Generate the bundled Campfire maps as Tiled JSON (orthogonal).

Layers:
- ground:     visual layer rendered by the client (tileset `campfire`, 3 tiles:
              0 water, 1 floor, 2 wall/rock)
- collision:  walkability layer used by the server (GID 0 walkable, non-zero
              blocked) — the client ignores it

Row-major data: index = y * width + x. Also writes the 32x96 tiles.png
tileset image used by the ground layer.
"""
import json
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "maps")

# Tile colors (r, g, b) for the 3-tile tileset.
WATER = (29, 53, 87)
FLOOR = (233, 228, 216)
WALL = (74, 78, 87)
TILE_SIZE = 32


def write_png(path, width, height, pixels):
    """Write an 8-bit RGB PNG (pixels: list of rows of (r,g,b))."""
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(
        b"\x00" + b"".join(bytes(px) for px in row) for row in pixels
    )
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def tile_pixels(base):
    """One 32x32 tile: a flat color. No per-tile outline — a 1px dark edge
    around every tile reads as black grid lines between tiles in the
    browser (it flickers with the sub-pixel camera offset), and adjacent
    same-color tiles should run together seamlessly."""
    return [[base] * TILE_SIZE for _ in range(TILE_SIZE)]


def write_tileset():
    """One self-contained tiles.png per map directory (each map carries
    its own tilesets; nothing lives in client/src/assets)."""
    tiles = [WATER, FLOOR, WALL]
    pixels = []
    for t in tiles:
        pixels.extend(tile_pixels(t))
    for map_id in ("office", "island"):
        path = os.path.join(OUT, map_id, "tiles.png")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write_png(path, TILE_SIZE, TILE_SIZE * len(tiles), pixels)
        print(path)


def tiled(w, h, ground, collision):
    return {
        "type": "map",
        "orientation": "orthogonal",
        "renderorder": "right-down",
        "tversion": 1.10,
        "width": w,
        "height": h,
        "tilewidth": TILE_SIZE,
        "tileheight": TILE_SIZE,
        "infinite": False,
        "nextlayerid": 3,
        "nextobjectid": 1,
        "layers": [
            {
                "id": 1,
                "name": "ground",
                "type": "tilelayer",
                "visible": True,
                "opacity": 1,
                "x": 0,
                "y": 0,
                "width": w,
                "height": h,
                "data": [c for row in ground for c in row],
            },
            {
                "id": 2,
                "name": "collision",
                "type": "tilelayer",
                "visible": True,
                "opacity": 1,
                "x": 0,
                "y": 0,
                "width": w,
                "height": h,
                "data": [c for row in collision for c in row],
            },
        ],
        "tilesets": [
            {
                "firstgid": 1,
                "name": "campfire",
                "tilewidth": TILE_SIZE,
                "tileheight": TILE_SIZE,
                "columns": 1,
                "count": 3,
                "image": "tiles.png",
                "imageheight": TILE_SIZE * 3,
                "imagewidth": TILE_SIZE,
            }
        ],
    }


def save(filename, doc):
    # maps/<map-id>/<map-id>.json — one self-contained directory per map.
    stem = os.path.splitext(filename)[0]
    path = os.path.join(OUT, stem, filename)
    with open(path, "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    print(path)


# --- office: 40x30, border walls + interior walls with door gaps -----------
w, h = 40, 30
collision = [[0] * w for _ in range(h)]
for x in range(w):
    collision[0][x] = 1
    collision[h - 1][x] = 1
for y in range(h):
    collision[y][0] = 1
    collision[y][w - 1] = 1
# Vertical wall at x=13 and x=26, with a door gap at y=11..15.
for x in (13, 26):
    for y in list(range(4, 11)) + list(range(16, 26)):
        collision[y][x] = 1
# Horizontal wall at y=14 across the middle, door at x=19.
for x in range(14, 26):
    if x != 19:
        collision[14][x] = 1
# Visual: floor everywhere, walls where the collision says so.
ground = [[2 if collision[y][x] else 1 for x in range(w)] for y in range(h)]
save("office.json", tiled(w, h, ground, collision))

# --- island: 36x28, water ring + a small rock cluster ----------------------
w, h = 36, 28
collision = [[0] * w for _ in range(h)]
for x in range(w):
    collision[0][x] = 1
    collision[h - 1][x] = 1
for y in range(h):
    collision[y][0] = 1
    collision[y][w - 1] = 1
# Rocks in the north, far from the center spawn.
for y in range(4, 7):
    for x in range(16, 19):
        collision[y][x] = 1
# Visual: water on the ring, floor on land, rocks where the collision says so.
ground = []
for y in range(h):
    row = []
    for x in range(w):
        if collision[y][x] == 1 and (
            x == 0 or x == w - 1 or y == 0 or y == h - 1
        ):
            row.append(0)  # water
        elif collision[y][x] == 1:
            row.append(2)  # rock
        else:
            row.append(1)  # floor
    ground.append(row)
save("island.json", tiled(w, h, ground, collision))

write_tileset()

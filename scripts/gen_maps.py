#!/usr/bin/env python3
"""Generate the bundled Campfire maps as Tiled JSON (orthogonal).

Walkability = collision tile layer: GID 0 walkable, non-zero blocked.
Row-major data: index = y * width + x.
"""
import json
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "maps")


def tiled(w, h, grid, name):
    return {
        "type": "map",
        "orientation": "orthogonal",
        "renderorder": "right-down",
        "tversion": 1.10,
        "width": w,
        "height": h,
        "tilewidth": 32,
        "tileheight": 32,
        "infinite": False,
        "nextlayerid": 2,
        "nextobjectid": 1,
        "layers": [
            {
                "id": 1,
                "name": name,
                "type": "tilelayer",
                "visible": True,
                "opacity": 1,
                "x": 0,
                "y": 0,
                "width": w,
                "height": h,
                "data": [c for row in grid for c in row],
            }
        ],
    }


def save(filename, doc):
    path = os.path.join(OUT, filename)
    with open(path, "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")
    print(path)


# --- office: 40x30, border walls + interior walls with door gaps -----------
w, h = 40, 30
office = [[0] * w for _ in range(h)]
for x in range(w):
    office[0][x] = 1
    office[h - 1][x] = 1
for y in range(h):
    office[y][0] = 1
    office[y][w - 1] = 1
# Vertical wall at x=13 and x=26, with a door gap at y=11..15.
for x in (13, 26):
    for y in list(range(4, 11)) + list(range(16, 26)):
        office[y][x] = 1
# Horizontal wall at y=14 across the middle, door at x=19.
for x in range(14, 26):
    if x != 19:
        office[14][x] = 1
save("office.json", tiled(w, h, office, "collision"))

# --- island: 36x28, water ring + a small rock cluster ----------------------
w, h = 36, 28
island = [[0] * w for _ in range(h)]
for x in range(w):
    island[0][x] = 1
    island[h - 1][x] = 1
for y in range(h):
    island[y][0] = 1
    island[y][w - 1] = 1
# Rocks in the north, far from the center spawn.
for y in range(4, 7):
    for x in range(16, 19):
        island[y][x] = 1
save("island.json", tiled(w, h, island, "collision"))

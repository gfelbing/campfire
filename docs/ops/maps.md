# Building maps

Campfire maps are regular **[Tiled](https://mapeditor.org)** maps (`*.json` /
`*.tmj`, orthogonal) you draw and edit yourself. The bundled maps in
[`maps/`](../../maps/) is the quickest way to begin.

## File layout and map ids

- One folder per map under `--maps-dir` (default `maps/`): the map JSON plus
  its tileset images **next to it**, because tileset `image` paths are
  relative to the map file and are served as-is
  (`/api/v1/maps/<id>/<file>`).
- The server scans the directory recursively **at startup and then
  immutable** — restart after adding or editing a map. Files that fail to
  parse are skipped (logged, not fatal), so a broken map cannot take the
  server down.
- **Map id** = the file's path under `maps/`, minus the extension, minus a
  final segment that repeats its parent:

  | File | Map id |
  |---|---|
  | `maps/office/office.json` | `office` |
  | `maps/interiors/conference.tmj` | `interiors/conference` |

  The id is the room id and the URL path segment (`/play/office`). The
  idempotent-segment rule keeps URLs readable no matter how the file is named.

## Layer conventions

- **Tile layers** are drawn in Tiled draw order; Tiled **group layers** are
  flattened in draw order. Flips (horizontal/vertical) are honored.
- **Collision**: the layer named `collision` — or `collisions` (the
  convention some Tiled maps use) — defines walkability. It shapes movement,
  not the picture.
- **Object layers** hold the zones below (rectangles, pixel coordinates,
  divided by the tile size when used).

## Zones (object layer rectangles)

| Object property | Meaning |
|---|---|
| `jitsiRoom` (string) | **Meeting room** — everyone inside the rectangle is in the zone's call. It forms with the first occupant; walking in joins. The call area is the zone rectangle, not a circle. |
| `silentZone` (or truthy `silent`) | **Do not disturb** — occupants never form or join a proximity bubble, drop out of one they were in, are marked with a 🔇 badge, and their audio is muted for everyone nearby. Zone calls are unaffected. |
| `exitUrl` (string) | Walking onto the object navigates to another map. **Relative to the current map's directory** (`second.tmj` from `office/first` targets `office/second`); a leading `/` targets from the maps root, `..` climbs. A `#fragment` is allowed and ignored. Name and color survive the hop. |
| name `start` (or truthy `start`) | **Spawn area** — the nearest walkable tile to its center (falling back outward in a ring) is the spawn point, used identically by server and client. |

## Tilesets

Ship the tileset image inside the map folder and reference it with the plain
relative path Tiled writes (`"image": "tiles.png"`). The client cuts per-tile
frames from the sheet using `firstgid`, `columns`, `margin`, `spacing` and
renders sprites — no build step, no atlas tooling.

## Deployment

- Local dev: the repo's `maps/` is used by default; map folders you add
  locally are git-ignored and yours to manage.
- Docker: mount a directory with `-v /srv/campfire/maps:/maps:ro --maps-dir
  /maps`.
- Kubernetes: `maps.kind: persistentVolume` (chart-created PVC; populate with
  `kubectl cp`/rsync/a git-sync sidecar) or `maps.kind: hostPath` — see the
  [chart README](../../deploy/helm/campfire/README.md).

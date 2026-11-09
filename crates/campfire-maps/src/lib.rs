//! Campfire map handling: Tiled JSON parsing, walkability grid, map bounds.
//!
//! The server uses the walkability grid to validate movement (README §5
//! "Movement rules"); the client renderer ignores it. Map data is parsed once
//! at startup and then immutable.
//!
//! Supported Tiled JSON subset: orthogonal maps with a tile layer named
//! `collision` whose GIDs decide walkability (0 = walkable, non-zero =
//! blocked). Maps without a collision layer are fully walkable.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;

/// Why a map file could not be used.
#[derive(Debug, Error)]
pub enum MapError {
    #[error("invalid map JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("map has an empty tile grid")]
    EmptyGrid,
    #[error("collision layer has the wrong number of cells")]
    CollisionSizeMismatch,
    #[error("map has no walkable tile for a spawn point")]
    NoSpawn,
}

/// A parsed map, immutable after construction.
pub struct MapData {
    /// Map id (the file stem); doubles as the room id.
    pub id: String,
    /// Display name (the Tiled `name` field, or the id).
    pub name: String,
    /// Tile grid width in tiles.
    pub width: u32,
    /// Tile grid height in tiles.
    pub height: u32,
    /// Walkability grid, row-major: `walkable[y * width + x]`.
    walkable: Vec<bool>,
    /// Spawn point in tile coordinates (tile center). A `start`-marked
    /// object area (README roadmap "Map enhancements") wins over the map
    /// center; otherwise the nearest walkable tile to the center.
    pub spawn: (f32, f32),
    /// Rectangular zones from object layers (README roadmap "Map
    /// enhancements"): `jitsiRoom` meeting areas, `silentZone` mutes.
    pub zones: Vec<Zone>,
    /// Original file contents, served verbatim by `GET /api/v1/maps/{id}`.
    pub raw: Vec<u8>,
}

/// One named rectangular zone (object-layer object) in tile units:
/// `rect = (x, y, width, height)` of the top-left tile corner.
#[derive(Debug, Clone)]
pub struct Zone {
    /// The Tiled object's name (e.g. the jitsi room label).
    pub name: String,
    pub rect: (f32, f32, f32, f32),
    /// `jitsiRoom` property: a meeting-room call covers this whole zone.
    pub jitsi_room: Option<String>,
    /// `silentZone` property (or a truthy `silent`): proximity audio is
    /// muted inside.
    pub silent: bool,
    /// `exitUrl` property: walking onto this zone navigates elsewhere.
    pub exit_url: Option<String>,
}

impl Zone {
    /// Whether the tile point lies inside the zone.
    pub fn contains(&self, x: f32, y: f32) -> bool {
        let (zx, zy, zw, zh) = self.rect;
        x >= zx && y >= zy && x < zx + zw && y < zy + zh
    }
}

/// Tiled JSON subset actually read by the parser.
#[derive(Deserialize)]
struct RawMap {
    width: u32,
    height: u32,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    layers: Vec<RawLayer>,
}

#[derive(Deserialize)]
struct RawLayer {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    data: Option<Vec<u32>>,
    #[serde(default)]
    objects: Vec<RawObject>,
    /// Group layers only (depth-first walk).
    #[serde(default)]
    layers: Vec<RawLayer>,
}

/// One object-layer object: a named rectangle in pixels with properties
/// (README roadmap "Map enhancements": zones).
#[derive(Deserialize)]
struct RawObject {
    #[serde(default)]
    name: String,
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default)]
    width: f32,
    #[serde(default)]
    height: f32,
    #[serde(default)]
    properties: Vec<RawProp>,
}

#[derive(Deserialize)]
struct RawProp {
    name: String,
    #[serde(default)]
    value: serde_json::Value,
}

impl RawObject {
    fn prop(&self, name: &str) -> Option<&serde_json::Value> {
        self.properties.iter().find(|p| p.name == name).map(|p| &p.value)
    }

    fn prop_str(&self, name: &str) -> Option<String> {
        self.prop(name).and_then(|v| v.as_str().map(str::to_owned))
    }

    fn prop_bool(&self, name: &str) -> bool {
        self.prop(name).and_then(|v| v.as_bool()).unwrap_or(false)
    }
}

impl RawMap {
    /// All object layers, group layers flattened (depth-first).
    fn object_layers(&self) -> Vec<&RawLayer> {
        fn walk<'a>(layers: &'a [RawLayer], out: &mut Vec<&'a RawLayer>) {
            for l in layers {
                if l.kind == "group" {
                    walk(&l.layers, out);
                } else if l.kind == "objectgroup" {
                    out.push(l);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.layers, &mut out);
        out
    }
}

impl MapData {
    /// Parse one Tiled JSON file. `id` is the file stem (and room id).
    pub fn parse(id: &str, data: &[u8]) -> Result<Self, MapError> {
        let raw: RawMap = serde_json::from_slice(data)?;
        if raw.width == 0 || raw.height == 0 {
            return Err(MapError::EmptyGrid);
        }
        let cells = (raw.width * raw.height) as usize;
        // First tile layer named "collision" (or "collisions", the
        // convention some Tiled maps use) decides walkability; without one the whole
        // map is walkable.
        let collision = raw
            .layers
            .iter()
            .find(|l| l.kind == "tilelayer" && (l.name == "collision" || l.name == "collisions"));
        let walkable = match collision.and_then(|l| l.data.as_ref()) {
            Some(gids) if gids.len() == cells => gids.iter().map(|&gid| gid == 0).collect(),
            Some(_) => return Err(MapError::CollisionSizeMismatch),
            None => vec![true; cells],
        };
        let spawn = spawn_point(raw.width, raw.height, &walkable)?;
        let zones = zones(&raw, raw.width, raw.height);
        // A `start`-marked object area selects the spawn point (README
        // roadmap "Map enhancements"): the area's center, snapped to a
        // walkable tile when the center itself is blocked.
        let spawn = zones
            .iter()
            .find(|z| z.name == "start")
            .map(|z| {
                let (zx, zy, zw, zh) = z.rect;
                let (cx, cy) = (zx + zw / 2.0, zy + zh / 2.0);
                if walkable_at(raw.width, raw.height, &walkable, cx, cy) {
                    (cx, cy)
                } else {
                    spawn_point(raw.width, raw.height, &walkable).expect("map has a spawn")
                }
            })
            .unwrap_or(spawn);
        Ok(Self {
            id: id.to_owned(),
            name: raw.name.unwrap_or_else(|| id.to_owned()),
            width: raw.width,
            height: raw.height,
            walkable,
            spawn,
            zones,
            raw: data.to_vec(),
        })
    }

    /// Whether the point lies inside the map bounds.
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= 0.0 && y >= 0.0 && (x as u32) < self.width && (y as u32) < self.height
    }

    /// Whether the point lies inside the map and its tile is walkable.
    pub fn is_walkable(&self, x: f32, y: f32) -> bool {
        self.contains(x, y) && self.tile_walkable(x as u32, y as u32)
    }

    /// Walkability of one tile; out-of-range tiles are not walkable.
    pub fn tile_walkable(&self, x: u32, y: u32) -> bool {
        (x < self.width && y < self.height)
            && self.walkable[(y as usize) * self.width as usize + x as usize]
    }
}

/// Walkability of a float point (tile floor), for the start-area snap.
fn walkable_at(width: u32, height: u32, walkable: &[bool], x: f32, y: f32) -> bool {
    let (x, y) = (x as u32, y as u32);
    (x < width && y < height)
        && walkable[(y as usize) * width as usize + x as usize]
}

/// Rectangular zones from object layers (README roadmap "Map
/// enhancements"): `jitsiRoom` meeting areas, `silentZone` mutes, `exitUrl`
/// portals. Objects at pixel coordinates divide by the tile size (32 px)
/// into tile units.
fn zones(raw: &RawMap, _width: u32, _height: u32) -> Vec<Zone> {
    const TILE: f32 = 32.0;
    let mut out = Vec::new();
    for layer in raw.object_layers() {
        for o in &layer.objects {
            let jitsi = o.prop_str("jitsiRoom");
            let silent = o.prop_bool("silentZone") || o.prop_bool("silent");
            let exit = o.prop_str("exitUrl");
            let is_start = o.name == "start";
            if jitsi.is_none() && !silent && exit.is_none() && !is_start {
                continue;
            }
            out.push(Zone {
                name: o.name.clone(),
                rect: (o.x / TILE, o.y / TILE, o.width / TILE, o.height / TILE),
                jitsi_room: jitsi,
                silent,
                exit_url: exit,
            });
        }
    }
    out
}

/// Center tile if walkable, otherwise the nearest walkable tile in an
/// expanding ring around the center.
fn spawn_point(width: u32, height: u32, walkable: &[bool]) -> Result<(f32, f32), MapError> {    let cx = width / 2;
    let cy = height / 2;
    let at = |x: u32, y: u32| walkable[(y as usize) * width as usize + x as usize];
    if at(cx, cy) {
        return Ok((cx as f32 + 0.5, cy as f32 + 0.5));
    }
    let radius = (width / 2).max(height / 2) + 1;
    for r in 1..=radius {
        for dy in -(r as i32)..=r as i32 {
            for dx in -(r as i32)..=r as i32 {
                if dx.abs().max(dy.abs()) != r as i32 {
                    continue; // only the ring itself
                }
                let (x, y) = (cx as i32 + dx, cy as i32 + dy);
                if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
                    continue;
                }
                if at(x as u32, y as u32) {
                    return Ok((x as f32 + 0.5, y as f32 + 0.5));
                }
            }
        }
    }
    Err(MapError::NoSpawn)
}

/// The loaded maps, keyed by the map file's path under the maps directory
/// (extension dropped; a file named after its directory collapses to the
/// directory name: `office/office.json` → `office`,
/// `interiors/conference.tmj` → `interiors/conference`). Loaded
/// from disk at startup (maps are mounted externally in deployment; dev uses
/// the local `maps/` folder).
pub struct Maps {
    /// The maps directory the maps were loaded from (also serves tileset
    /// assets: `maps_dir/<map file's directory>/<path>`).
    pub dir: PathBuf,
    /// Each map's file, relative to `dir` (the asset root is its parent).
    files: HashMap<String, PathBuf>,
    maps: HashMap<String, MapData>,
}

/// The map id for a map file at `path` under the maps directory: the
/// relative path without extension, minus a final segment repeating the
/// previous one (`office/office.json` → `office`).
#[doc(hidden)]
pub fn map_id(dir: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(dir).ok()?;
    let mut segments: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let stem = rel.file_stem()?.to_string_lossy().into_owned();
    segments.pop();
    if let Some(parent) = segments.last() {
        if *parent == stem {
            segments.pop();
        }
    }
    segments.push(stem);
    let id = segments.join("/");
    valid_id(&id).then_some(id)
}

impl Maps {
    /// Load every `*.json`/`*.tmj` file under `dir` (recursively), keyed by
    /// [`map_id`]. Files that fail to parse are skipped, so a bad map can't
    /// take the server down.
    pub fn load(dir: &Path) -> Self {
        let mut maps = HashMap::new();
        let mut files = HashMap::new();
        let mut walk: Vec<PathBuf> = vec![dir.to_owned()];
        while let Some(path) = walk.pop() {
            let Ok(entries) = std::fs::read_dir(&path) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk.push(path);
                } else if path.extension().is_some_and(|e| e == "json" || e == "tmj") {
                    let Some(id) = map_id(dir, &path) else {
                        continue;
                    };
                    let Ok(data) = std::fs::read(&path) else {
                        continue;
                    };
                    if let Ok(map) = MapData::parse(&id, &data) {
                        files.insert(
                            id.clone(),
                            path.strip_prefix(dir).unwrap_or(&path).to_owned(),
                        );
                        maps.insert(id, map);
                    }
                }
            }
        }
        Self {
            dir: dir.to_owned(),
            files,
            maps,
        }
    }

    /// The map with the given id.
    pub fn get(&self, id: &str) -> Option<&MapData> {
        self.maps.get(id)
    }

    /// Every map, sorted by id.
    pub fn all(&self) -> Vec<&MapData> {
        let mut maps: Vec<&MapData> = self.maps.values().collect();
        maps.sort_by(|a, b| a.id.cmp(&b.id));
        maps
    }

    /// A file belonging to one map's directory (a tileset image, for
    /// example), read from disk. `path` is relative to the map file's
    /// directory; `..` segments are refused.
    pub fn asset(&self, id: &str, path: &str) -> Option<Vec<u8>> {
        if path
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == "..")
        {
            return None;
        }
        // The map file's directory, not the id: the id may name a file
        // (`interiors/conference`), the assets sit next to it.
        let file = self.files.get(id)?;
        let base = file.parent().unwrap_or(Path::new(""));
        std::fs::read(self.dir.join(base).join(path)).ok()
    }
}

/// Whether the id is a valid room id (also used as a map directory name).
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.split('/').all(|seg| {
            !seg.is_empty()
                && seg.len() <= 32
                && seg
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One Tiled JSON map with a 3×3 grid and the given collision GIDs
    /// (row-major).
    fn tiled_json(cells: &[u32]) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "type": "map",
            "orientation": "orthogonal",
            "width": 3,
            "height": 3,
            "tilewidth": 32,
            "tileheight": 32,
            "layers": [{
                "type": "tilelayer",
                "name": "collision",
                "width": 3,
                "height": 3,
                "data": cells
            }]
        }))
        .unwrap()
    }

    #[test]
    fn parse_walkability_and_spawn() {
        // 3×3, center blocked.
        let m = MapData::parse("t", &tiled_json(&[0, 0, 0, 0, 1, 0, 0, 0, 0])).unwrap();
        assert_eq!((m.width, m.height), (3, 3));
        assert!(m.is_walkable(0.5, 0.5));
        assert!(!m.is_walkable(1.5, 1.5), "center tile is blocked");
        // Center is blocked, so spawn is the nearest walkable ring tile.
        assert!(m.is_walkable(m.spawn.0, m.spawn.1));
        assert_ne!(m.spawn, (1.5, 1.5));
    }

    #[test]
    fn parse_spawn_at_center_when_free() {
        let m = MapData::parse("t", &tiled_json(&[0; 9])).unwrap();
        assert_eq!(m.spawn, (1.5, 1.5));
    }

    #[test]
    fn contains_rejects_out_of_bounds() {
        let m = MapData::parse("t", &tiled_json(&[0; 9])).unwrap();
        assert!(m.contains(0.0, 0.0));
        assert!(m.contains(2.9, 2.9));
        assert!(!m.contains(3.0, 1.5));
        assert!(!m.contains(1.5, 3.0));
        assert!(!m.contains(-0.1, 1.5));
    }

    #[test]
    fn missing_collision_layer_is_fully_walkable() {
        let raw = serde_json::json!({
            "type": "map",
            "width": 2,
            "height": 2,
            "layers": []
        });
        let m = MapData::parse("open", &serde_json::to_vec(&raw).unwrap()).unwrap();
        assert!(m.is_walkable(0.5, 0.5) && m.is_walkable(1.5, 1.5));
    }

    #[test]
    fn bad_maps_are_reported() {
        assert!(matches!(
            MapData::parse("t", b"nope"),
            Err(MapError::InvalidJson(_))
        ));
        assert!(matches!(
            MapData::parse("t", &tiled_json(&[0, 0])),
            Err(MapError::CollisionSizeMismatch)
        ));
        assert!(matches!(
            MapData::parse("t", &tiled_json(&[1; 9])),
            Err(MapError::NoSpawn)
        ));
    }

    #[test]
    fn parse_zones_and_start_area() {
        let raw = serde_json::json!({
            "type": "map",
            "width": 8,
            "height": 8,
            "layers": [
                {"type": "tilelayer", "name": "collision", "width": 8, "height": 8,
                 "data": vec![0; 64]},
                {"type": "objectgroup", "name": "zones", "objects": [
                    {"name": "meeting", "x": 64, "y": 0, "width": 96, "height": 64,
                     "properties": [{"name": "jitsiRoom", "type": "string",
                                     "value": "team-meeting"}]},
                    {"name": "quiet", "x": 0, "y": 128, "width": 64, "height": 64,
                     "properties": [{"name": "silentZone", "type": "bool", "value": true}]},
                    {"name": "start", "x": 32, "y": 32, "width": 64, "height": 64},
                    {"name": "exit", "x": 0, "y": 0, "width": 32, "height": 32,
                     "properties": [{"name": "exitUrl", "type": "string",
                                     "value": "/play/office"}]}
                ]}
            ]
        });
        let m = MapData::parse("z", &serde_json::to_vec(&raw).unwrap()).unwrap();
        // 4 zones found (the start area is a zone marker, not a call zone).
        assert_eq!(m.zones.len(), 4);
        let meeting = m.zones.iter().find(|z| z.jitsi_room.is_some()).unwrap();
        assert_eq!(meeting.jitsi_room.as_deref(), Some("team-meeting"));
        assert_eq!(meeting.rect, (2.0, 0.0, 3.0, 2.0));
        assert!(m.zones.iter().find(|z| z.silent).is_some());
        assert!(m.zones.iter().find(|z| z.exit_url.is_some()).is_some());
        // The `start` area's center is the spawn point (rect (1,1,2,2) →
        // center (2,2)).
        assert_eq!(m.spawn, (2.0, 2.0));
        // Zone containment: point-in-rect.
        assert!(meeting.contains(2.5, 1.5));
        assert!(!meeting.contains(1.0, 1.0));
    }

    #[test]
    fn bundled_maps_are_loaded() {
        let maps = Maps::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../maps"
        )));
        assert!(maps.get("office").is_some(), "office map missing");
        assert!(maps.get("island").is_some(), "island map missing");
        let office = maps.get("office").unwrap();
        assert_eq!((office.width, office.height), (40, 30));
        let island = maps.get("island").unwrap();
        assert_eq!((island.width, island.height), (36, 28));
        for map in maps.all() {
            assert!(
                map.is_walkable(map.spawn.0, map.spawn.1),
                "{}: spawn must be walkable",
                map.id
            );
        }
    }

    #[test]
    fn asset_refuses_traversal() {
        let maps = Maps::load(Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../maps"
        )));
        assert!(maps.asset("island", "tiles.png").is_some());
        assert!(maps.asset("island", "../office/office.json").is_none());
    }

    /// Nested map ids: a map in a subdirectory is keyed by its relative
    /// path, and its assets sit next to the map file, not under the id.
    #[test]
    fn nested_map_ids_and_assets() {
        let dir = std::env::temp_dir().join("campfire-nested-maps-test");
        std::fs::create_dir_all(dir.join("interiors")).unwrap();
        let raw = serde_json::json!({
            "type": "map", "width": 2, "height": 2, "tilewidth": 32,
            "layers": [{"type": "tilelayer", "name": "collision",
                        "width": 2, "height": 2, "data": [0, 0, 0, 0]}]
        });
        std::fs::write(
            dir.join("interiors").join("conference.json"),
            serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.join("interiors").join("tiles.png"), b"png").unwrap();
        let maps = Maps::load(&dir);
        assert!(maps.get("interiors/conference").is_some());
        assert!(maps.asset("interiors/conference", "tiles.png").is_some());
    }
}

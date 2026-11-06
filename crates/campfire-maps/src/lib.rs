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

use include_dir::{Dir, include_dir};
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
    /// Spawn point in tile coordinates (tile center).
    pub spawn: (f32, f32),
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
}

impl MapData {
    /// Parse one Tiled JSON file. `id` is the file stem (and room id).
    pub fn parse(id: &str, data: &[u8]) -> Result<Self, MapError> {
        let raw: RawMap = serde_json::from_slice(data)?;
        if raw.width == 0 || raw.height == 0 {
            return Err(MapError::EmptyGrid);
        }
        let cells = (raw.width * raw.height) as usize;
        // First tile layer named "collision" decides walkability; without
        // one the whole map is walkable.
        let collision = raw
            .layers
            .iter()
            .find(|l| l.kind == "tilelayer" && l.name == "collision");
        let walkable = match collision.and_then(|l| l.data.as_ref()) {
            Some(gids) if gids.len() == cells => gids.iter().map(|&gid| gid == 0).collect(),
            Some(_) => return Err(MapError::CollisionSizeMismatch),
            None => vec![true; cells],
        };
        let spawn = spawn_point(raw.width, raw.height, &walkable)?;
        Ok(Self {
            id: id.to_owned(),
            name: raw.name.unwrap_or_else(|| id.to_owned()),
            width: raw.width,
            height: raw.height,
            walkable,
            spawn,
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

/// Center tile if walkable, otherwise the nearest walkable tile in an
/// expanding ring around the center.
fn spawn_point(width: u32, height: u32, walkable: &[bool]) -> Result<(f32, f32), MapError> {
    let cx = width / 2;
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

/// The `maps/` directory next to the workspace root, embedded at compile
/// time (single deploy artifact, README §3).
static MAPS: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../maps");

/// Parse every `*.json` in the embedded `maps/` directory, keyed by file
/// stem. Files that fail to parse are skipped, so a bad map can't take the
/// server down.
pub fn bundled() -> HashMap<String, MapData> {
    let mut maps = HashMap::new();
    for file in MAPS.files() {
        if file.path().extension().is_none_or(|e| e != "json") {
            continue;
        }
        let Some(stem) = file
            .path()
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
        else {
            continue;
        };
        if let Ok(map) = MapData::parse(&stem, file.contents()) {
            maps.insert(stem, map);
        }
    }
    maps
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
    fn bundled_maps_are_loaded() {
        let maps = bundled();
        assert!(maps.contains_key("office"), "office map missing");
        assert!(maps.contains_key("island"), "island map missing");
        let office = &maps["office"];
        assert_eq!((office.width, office.height), (40, 30));
        let island = &maps["island"];
        assert_eq!((island.width, island.height), (36, 28));
        for map in maps.values() {
            assert!(
                map.is_walkable(map.spawn.0, map.spawn.1),
                "{}: spawn must be walkable",
                map.id
            );
        }
    }
}

//! Campfire map handling: Tiled JSON parsing, walkability grid, map bounds.
//!
//! The server uses the walkability grid to validate movement (README §5
//! "Movement rules"); the client renderer ignores it. Map data is parsed once
//! at startup and then immutable.
//!
//! Phase 0 ships a skeleton; Tiled JSON parsing lands in Phase 3. Supported
//! subset (documented once implemented): orthogonal tilesets, one collision
//! layer per map.

/// A parsed map, immutable after construction.
///
/// Phase 3 fills this in (Tiled JSON fields + a walkability grid + bounds).
pub struct MapData {
    /// Map name as it appears in the Tiled file.
    pub name: String,
    /// Tile grid size in tiles (width, height).
    pub size: (u32, u32),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_data_carries_size() {
        let map = MapData {
            name: "office".into(),
            size: (10, 8),
        };
        assert_eq!(map.size, (10, 8));
    }
}

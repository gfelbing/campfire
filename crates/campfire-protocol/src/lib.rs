//! Wire protocol for Campfire's realtime channel.
//!
//! This crate is **pure data + codec** — no IO, no async. It defines the JSON
//! message types that travel over the WebTransport reliable stream (presence,
//! chat, call signaling) and over QUIC datagrams (movement). Keeping it free of
//! side effects makes it trivially unit-testable and lets the server, the test
//! clients, and (later) load-test tools share one definition of the protocol.
//!
//! See README §5 (Realtime protocol) and §6 (Voice & video calls) for the
//! message catalogue. Phase 0 ships an empty skeleton; message enums land in
//! Phase 2.

/// Marker documenting the wire encoding used across the protocol.
///
/// Realtime messages are **newline-delimited JSON** on the reliable stream;
/// movement batches are single JSON datagrams.
pub const WIRE_ENCODING: &str = "ndjson";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_encoding_is_declared() {
        assert_eq!(WIRE_ENCODING, "ndjson");
    }
}

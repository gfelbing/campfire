//! Wire protocol for Campfire's realtime channel.
//!
//! This crate is **pure data + codec** — no IO, no async. It defines the JSON
//! message types that travel over the WebTransport reliable stream (presence,
//! chat) and over QUIC datagrams (movement). Keeping it free of side effects
//! makes it trivially unit-testable and lets the server, the test clients, and
//! (later) load-test tools share one definition of the protocol.
//!
//! See README §5 (Realtime protocol) for the message catalogue. Call signaling
//! messages are added with Phase 5/6.
//!
//! Wire encoding: **newline-delimited JSON** on the reliable stream; one JSON
//! object per datagram.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Marker documenting the wire encoding used across the protocol.
pub const WIRE_ENCODING: &str = "ndjson";

/// Direction an avatar faces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Dir {
    #[serde(rename = "n")]
    North,
    #[serde(rename = "s")]
    South,
    #[serde(rename = "e")]
    East,
    #[serde(rename = "w")]
    West,
}

/// Visual customization chosen by the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Avatar {
    pub color: String,
}

/// Another user, by id and name only (presence events).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserBrief {
    pub id: String,
    pub name: String,
}

/// Full state of a user as seen in a room snapshot (`hello`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserState {
    pub id: String,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub d: Dir,
}

/// A chat message (history entries and live events share this shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMsg {
    pub from: String,
    pub name: String,
    pub text: String,
    /// Unix timestamp (seconds).
    pub ts: u64,
}

/// Why the server rejected something (README §5 `error`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Malformed or not allowed in the current state.
    BadMessage,
    /// Per-session rate limit exceeded.
    RateLimited,
    /// Room is at its user cap.
    RoomFull,
    /// Nickname exceeds the length limit.
    NameTooLong,
    /// Chat text exceeds the length limit.
    ChatTooLong,
    /// Room id exceeds the length limit.
    RoomTooLong,
}

/// Client → server, reliable stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    Join {
        room: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        avatar: Option<Avatar>,
    },
    Chat {
        text: String,
    },
    Typing {
        on: bool,
    },
}

/// Server → client, reliable stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    Hello {
        you: String,
        room: String,
        users: Vec<UserState>,
        chat: Vec<ChatMsg>,
    },
    Joined {
        user: UserBrief,
    },
    Left {
        id: String,
    },
    Chat {
        from: String,
        name: String,
        text: String,
        ts: u64,
    },
    Typing {
        id: String,
        on: bool,
    },
    Error {
        code: ErrorCode,
    },
}

/// One movement delta — datagram space, coordinates in 0.1-tile resolution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MovementEntry {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub d: Dir,
    /// Moving flag (`mv` on the wire).
    #[serde(rename = "mv")]
    pub moving: bool,
    /// Monotonic sequence number (`s`); the client keeps the newest entry.
    #[serde(rename = "s")]
    pub seq: u64,
}

/// Batch of movement deltas — one datagram per room per server tick.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MovementBatch {
    pub m: Vec<MovementEntry>,
}

#[derive(Debug, Error)]
#[error("invalid JSON message: {0}")]
pub struct CodecError(#[from] serde_json::Error);

/// Encode one message as a JSON line (including the trailing newline).
pub fn to_line<T: Serialize>(msg: &T) -> String {
    // JSON strings never contain raw newlines, so the line cannot split.
    let mut s = serde_json::to_string(msg).expect("protocol messages always serialize");
    s.push('\n');
    s
}

/// Decode one JSON line into a message.
pub fn from_line<T: DeserializeOwned>(line: &str) -> Result<T, CodecError> {
    Ok(serde_json::from_str(line)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_join_roundtrip() {
        let msg = ClientMsg::Join {
            room: "office-1".into(),
            name: "georg".into(),
            avatar: Some(Avatar {
                color: "#e05f38".into(),
            }),
        };
        let line = to_line(&msg);
        assert!(line.starts_with(r#"{"t":"join""#));
        assert!(line.ends_with('\n'));
        assert_eq!(from_line::<ClientMsg>(&line).unwrap(), msg);
    }

    #[test]
    fn server_hello_roundtrip() {
        let msg = ServerMsg::Hello {
            you: "u_1f3a9c02".into(),
            room: "office-1".into(),
            users: vec![UserState {
                id: "u_77ab".into(),
                name: "jules".into(),
                x: 40.0,
                y: 12.0,
                d: Dir::South,
            }],
            chat: vec![ChatMsg {
                from: "u_77ab".into(),
                name: "jules".into(),
                text: "welcome!".into(),
                ts: 1_762_410_000,
            }],
        };
        assert_eq!(from_line::<ServerMsg>(&to_line(&msg)).unwrap(), msg);
    }

    #[test]
    fn unknown_message_type_is_rejected() {
        assert!(from_line::<ClientMsg>(r#"{"t":"bogus"}"#).is_err());
    }

    #[test]
    fn movement_batch_roundtrip() {
        let msg = MovementBatch {
            m: vec![MovementEntry {
                id: "u_1".into(),
                x: 41.5,
                y: 12.75,
                d: Dir::East,
                moving: true,
                seq: 4821,
            }],
        };
        let line = to_line(&msg);
        assert!(line.contains(r#""mv":true"#) && line.contains(r#""s":4821"#));
        assert_eq!(from_line::<MovementBatch>(&line).unwrap(), msg);
    }

    #[test]
    fn avatar_is_optional_on_join() {
        let no_avatar = ClientMsg::Join {
            room: "r".into(),
            name: "n".into(),
            avatar: None,
        };
        assert_eq!(
            from_line::<ClientMsg>(&to_line(&no_avatar)).unwrap(),
            no_avatar
        );
        assert_eq!(
            from_line::<ClientMsg>(r#"{"t":"join","room":"r","name":"n"}"#).unwrap(),
            no_avatar
        );
    }
}

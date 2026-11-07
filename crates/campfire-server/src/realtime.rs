//! Realtime sessions over WebTransport (README §5).
//!
//! A session is one `CONNECT /wt` upgrade. The client opens exactly one
//! bidirectional stream — the **command stream** — and speaks newline-delimited
//! JSON on it (README §5): `join` → `hello`, then `chat`/`typing` events flow
//! both ways. Movement travels on QUIC datagrams in both directions:
//! inbound `MovementBatch` datagrams are validated into the world, outbound
//! tick batches (README §5) are pushed through a per-session datagram queue.
//!
//! The server is a pure relay here: every outbound message is queued on the
//! per-user channel owned by [`crate::world::World`], and a writer task drains
//! it onto the command stream. One stream in, one stream out, one datagram
//! pipe each way — no fan-out logic lives in this file.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use campfire_protocol::{
    ChatMsg, ClientMsg, ErrorCode, MovementBatch, ServerMsg, from_line, to_line,
};
use h3_axum::WebTransportSession;
use h3_webtransport::server::AcceptedBi;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::api::AppState;
use crate::world::World;

/// The session's `(room, user id)` once joined, shared between the command
/// task and the datagram tasks.
type Who = Arc<Mutex<Option<(String, String)>>>;

/// A JSON line longer than this is refused (README §14: no unbounded reads).
const MAX_LINE_BYTES: usize = 80 * 1024;
/// Close a session that sends nothing for this long (README §5 lifecycle).
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// First message (join) must arrive within this window.
const JOIN_TIMEOUT: Duration = Duration::from_secs(10);
/// Per-session stream message limit (README §14).
const MSGS_PER_SEC: usize = 50;
/// Per-session inbound byte limit (README §14).
const BYTES_PER_SEC: usize = 256 * 1024;
/// Per-session chat limit (README §14).
const CHAT_PER_SEC: usize = 1;
/// A chat line longer than this is refused (README §14).
pub(crate) const MAX_CHAT_CHARS: usize = 500;
/// Room id: `1..=32` chars of `[a-z0-9_-]` (README §5).
pub(crate) const MAX_ROOM_CHARS: usize = 32;
/// Name: trimmed, `1..=24` chars (README §14).
pub(crate) const MAX_NAME_CHARS: usize = 24;
/// Avatar color string cap.
pub(crate) const MAX_AVATAR_CHARS: usize = 16;

/// Handler for `CONNECT /wt`: accept the upgrade and hand the session to a
/// dedicated task. The handler must call [`WebTransportUpgrade::accept`]
/// before returning; after a successful claim the response is ignored by the
/// h3-axum dispatcher (the session owns the connection).
pub async fn handle_wt(
    State(state): State<AppState>,
    upgrade: h3_axum::WebTransportUpgrade,
) -> Response {
    match upgrade.accept().await {
        Ok(session) => {
            let session_id = session.session_id();
            info!(?session_id, "webtransport session opened");
            tokio::spawn(session_task(state.world, session));
            StatusCode::OK.into_response()
        }
        Err(err) => {
            warn!(error = %err, "webtransport handshake failed");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

/// Fixed 1-second-window token bucket: `allow(n, max)` admits up to `max`
/// units of `n` per second. Simple and good enough for per-session limits.
#[derive(Clone)]
pub(crate) struct RateLimit {
    window_start: Instant,
    used: usize,
}

impl RateLimit {
    pub(crate) fn new() -> Self {
        Self {
            window_start: Instant::now(),
            used: 0,
        }
    }

    pub(crate) fn allow(&mut self, n: usize, max: usize) -> bool {
        let now = Instant::now();
        if now.duration_since(self.window_start) >= Duration::from_secs(1) {
            self.window_start = now;
            self.used = 0;
        }
        self.used += n;
        self.used <= max
    }
}

/// One connected session: runs until the command stream (or the QUIC
/// connection) dies, then removes the user from the world.
async fn session_task(world: World, session: WebTransportSession) {
    // (room, user id) once joined, so the datagram tasks can attribute
    // inbound movement and nobody can move before joining.
    let who: Who = Arc::new(Mutex::new(None));

    // Inbound datagrams: movement batches (README §5).
    let mut datagrams = session.datagram_reader();
    let who_in = who.clone();
    let world_in = world.clone();
    let datagram_task = tokio::spawn(async move {
        while let Ok(dg) = datagrams.read_datagram().await {
            let Ok(batch) =
                from_line::<MovementBatch>(std::str::from_utf8(dg.payload()).unwrap_or(""))
            else {
                debug!("undecodable datagram ignored");
                continue;
            };
            if let Some((room, id)) = who_in.lock().unwrap().clone() {
                world_in.apply_movement(&room, &id, &batch.m);
            }
        }
    });

    // Outbound datagrams: the 50 ms tick pushes movement batches through this
    // queue (README §5).
    let (dtx, mut dtx_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let mut dtx_sender = session.datagram_sender();
    let datagram_sink = tokio::spawn(async move {
        while let Some(chunk) = dtx_rx.recv().await {
            if dtx_sender.send_datagram(Bytes::from(chunk)).is_err() {
                break; // connection is gone
            }
        }
    });

    // The first client-initiated bidi stream is the command stream.
    let command = loop {
        match session.accept_bi().await {
            Ok(Some(AcceptedBi::BidiStream(_sid, stream))) => break Some(stream),
            Ok(Some(AcceptedBi::Request(req, mut stream))) => {
                // Stray HTTP request inside the session: answer 404 politely.
                debug!(path = req.uri().path(), "non-wt request inside session");
                let resp = axum::http::Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(())
                    .unwrap();
                if stream.send_response(resp).await.is_err() {
                    break None;
                }
            }
            Ok(None) => {
                debug!("session closed before command stream");
                break None;
            }
            Err(_err) => {
                debug!("session closed before command stream");
                break None;
            }
        }
    };

    match command {
        Some(stream) => run_command_stream(&world, stream, who, dtx).await,
        None => debug!("no command stream"),
    }

    datagram_task.abort();
    datagram_sink.abort();
}

/// Read `join`/`chat`/`typing` lines, enforce limits, and relay through the
/// world. Returns when the stream ends, idles out, or breaks a hard limit.
async fn run_command_stream<S>(
    world: &World,
    stream: S,
    who: Who,
    dtx: mpsc::UnboundedSender<Vec<u8>>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let (mut rd, mut wr) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMsg>();

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if wr.write_all(to_line(&msg).as_bytes()).await.is_err() || wr.flush().await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
    });

    let mut session: Option<(String, String, String)> = None; // (room, user id, name)
    let mut msgs = RateLimit::new();
    let mut bytes = RateLimit::new();
    let mut chat = RateLimit::new();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut first_message = true;

    'read: loop {
        let timeout = if first_message {
            JOIN_TIMEOUT
        } else {
            IDLE_TIMEOUT
        };
        let read = tokio::time::timeout(timeout, rd.read(&mut chunk)).await;
        match read {
            Err(_) => {
                debug!("session idle timeout");
                break 'read;
            }
            Ok(Ok(0)) => break 'read, // EOF: client closed the command stream
            Ok(Ok(n)) => {
                first_message = false;
                if !bytes.allow(n, BYTES_PER_SEC) {
                    warn!("session exceeded inbound byte limit");
                    break 'read;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_LINE_BYTES {
                    warn!("session exceeded line size limit");
                    break 'read;
                }
                // Handle every complete line in the buffer.
                while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line[..line.len() - 1]);
                    if !msgs.allow(1, MSGS_PER_SEC) {
                        warn!("session exceeded message rate");
                        break 'read;
                    }
                    if !dispatch(world, &line, &tx, &mut session, &mut chat, &who, &dtx) {
                        break 'read;
                    }
                }
            }
            Ok(Err(_err)) => break 'read,
        }
    }

    if let Some((room, id, _)) = &session {
        world.leave(room, id);
        *who.lock().unwrap() = None; // no more movement for this session
        info!(user = %id, room = %room, "user left");
    }
    drop(tx); // writer task finishes and shuts the stream down
    let _ = writer.await;
}

/// Handle one command line. Returns `false` when the session must be torn
/// down (rate-limit break, or the send channel closed).
fn dispatch(
    world: &World,
    line: &str,
    tx: &mpsc::UnboundedSender<ServerMsg>,
    session: &mut Option<(String, String, String)>,
    chat_limit: &mut RateLimit,
    who: &Who,
    dtx: &mpsc::UnboundedSender<Vec<u8>>,
) -> bool {
    match campfire_protocol::from_line::<ClientMsg>(line) {
        Ok(ClientMsg::Join { room, name, avatar }) => {
            if session.is_some() {
                return send(tx, ErrorCode::BadMessage);
            }
            if !valid_room(&room) {
                return send(tx, ErrorCode::BadMessage);
            }
            let name = name.trim();
            if name.is_empty() || name.len() > MAX_NAME_CHARS {
                return send(tx, ErrorCode::NameTooLong);
            }
            if let Some(avatar) = &avatar
                && avatar.color.len() > MAX_AVATAR_CHARS
            {
                return send(tx, ErrorCode::BadMessage);
            }
            match world.join(&room, name, avatar.clone(), tx.clone(), dtx.clone()) {
                Ok(joined) => {
                    let you = joined.you;
                    *session = Some((room.clone(), you.clone(), name.to_owned()));
                    *who.lock().unwrap() = Some((room.clone(), you.clone()));
                    let msg = ServerMsg::Hello {
                        you,
                        room,
                        users: joined.users,
                        chat: joined.chat,
                    };
                    tx.send(msg).is_ok()
                }
                Err(crate::world::JoinError::RoomFull) => send(tx, ErrorCode::RoomFull),
                Err(crate::world::JoinError::UnknownRoom) => send(tx, ErrorCode::UnknownRoom),
            }
        }
        Ok(ClientMsg::Chat { text }) => {
            let Some((room, id, name)) = session.clone() else {
                return send(tx, ErrorCode::BadMessage);
            };
            if text.chars().count() > MAX_CHAT_CHARS {
                return send(tx, ErrorCode::ChatTooLong);
            }
            if !chat_limit.allow(1, CHAT_PER_SEC) {
                return send(tx, ErrorCode::RateLimited);
            }
            let msg = ChatMsg {
                from: id,
                name,
                text,
                ts: unix_ts(),
            };
            world.broadcast_chat(&room, msg);
            true
        }
        Ok(ClientMsg::Typing { on }) => {
            let Some((room, id, _)) = session.clone() else {
                return send(tx, ErrorCode::BadMessage);
            };
            world.broadcast_typing(&room, &id, on);
            true
        }
        Err(_err) => send(tx, ErrorCode::BadMessage),
    }
}

/// Room ids: `1..=32` chars of `[a-z0-9_-]`.
pub(crate) fn valid_room(room: &str) -> bool {
    (1..=MAX_ROOM_CHARS).contains(&room.len())
        && room
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Send one `error` message; `false` means the client is gone.
fn send(tx: &mpsc::UnboundedSender<ServerMsg>, code: ErrorCode) -> bool {
    tx.send(ServerMsg::Error { code }).is_ok()
}

/// Seconds since the Unix epoch (0 if the clock is before 1970 — harmless).
pub(crate) fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_ids_are_constrained() {
        assert!(valid_room("office-1"));
        assert!(valid_room("a_b-2"));
        assert!(!valid_room(""));
        assert!(!valid_room("UPPER"));
        assert!(!valid_room("has space"));
        assert!(!valid_room("über"));
        assert!(!valid_room(&"x".repeat(33)));
        assert!(valid_room(&"x".repeat(32)));
    }

    #[test]
    fn rate_limit_window_resets() {
        let mut rl = RateLimit::new();
        assert!(rl.allow(3, 5));
        assert!(!rl.allow(3, 5));
    }
}

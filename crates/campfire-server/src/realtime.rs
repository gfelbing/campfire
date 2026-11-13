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

use axum::Extension;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use campfire_protocol::{
    ChatMsg, ClientMsg, ErrorCode, MovementBatch, ServerMsg, from_line, to_line,
};
use h3_axum::WebTransportSession;
use std::collections::HashMap;
use h3_webtransport::server::AcceptedBi;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::api::AppState;
use crate::metrics::Metrics;
use crate::world::World;

/// The session's `(room, user id)` once joined, shared between the command
/// task and the datagram tasks.
type Who = Arc<Mutex<Option<(String, String)>>>;

/// A JSON line longer than this is refused (README §14: no unbounded reads).
const MAX_LINE_BYTES: usize = 80 * 1024;
/// Close a session that sends nothing on the command stream for this long
/// (README §5 lifecycle). Generous by design: the client's 25 s keepalive
/// ping (`ping`) is the liveness signal — a stationary user sends nothing
/// but pings, and the ping also resets the QUIC idle timeout, so this
/// mainly reaps clients whose process vanished without closing.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
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
/// Room id: `1..=64` chars of `[a-z0-9_-]` (README §5).
pub(crate) const MAX_ROOM_CHARS: usize = 64;
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
    Extension(conn): Extension<quinn::Connection>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
    upgrade: h3_axum::WebTransportUpgrade,
) -> Response {
    // Auth (README §11, issues.md #4): when enabled, the IdP name comes
    // either from a one-time `?ticket=` (the WebTransport handshake carries
    // no cookies in Chromium) or, failing that, the session cookie. A 401
    // here (before `accept`) rejects the upgrade outright.
    let forced_name = match params
        .get("ticket")
        .and_then(|t| crate::api::consume_wt_ticket(&state, t))
    {
        Some(name) => Some(name),
        None => match crate::api::enforce_auth(&state, &headers) {
            Ok(name) => name,
            Err(status) => return status.into_response(),
        },
    };
    match upgrade.accept().await {
        Ok(session) => {
            let session_id = session.session_id();
            info!(?session_id, "webtransport session opened");
            tokio::spawn(session_task(
                state.world,
                session,
                conn,
                state.metrics.clone(),
                forced_name,
            ));
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
///
/// `conn` is this session's QUIC connection: a WebTransport session owns the
/// whole HTTP/3 connection (`h3-axum` hands it over, and nothing accepts
/// further requests or sessions on it afterwards). When the session ends we
/// must close the QUIC connection explicitly — without that, the browser
/// keeps the dead connection open and every reconnect attempt opens another
/// session on it that can never be answered (observed as an endless
/// "Connection lost" reconnect storm).
async fn session_task(
    world: World,
    session: WebTransportSession,
    conn: quinn::Connection,
    metrics: Metrics,
    forced_name: Option<String>,
) {
    metrics.session_open();
    // (room, user id) once joined, so the datagram tasks can attribute
    // inbound movement and nobody can move before joining.
    let who: Who = Arc::new(Mutex::new(None));

    // Inbound datagrams: movement batches (README §5).
    let mut datagrams = session.datagram_reader();
    let who_in = who.clone();
    let world_in = world.clone();
    let metrics_in = metrics.clone();
    let datagram_task = tokio::spawn(async move {
        while let Ok(dg) = datagrams.read_datagram().await {
            metrics_in.datagram_in(dg.payload().len());
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
    let metrics_out = metrics.clone();
    let datagram_sink = tokio::spawn(async move {
        while let Some(chunk) = dtx_rx.recv().await {
            metrics_out.datagram_out(chunk.len());
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
        Some(stream) => {
            // One session id per connection (README §5 reconnect): a stale
            // session's disconnect must not clobber a newer session that
            // already restored the same token.
            let session_id = world.next_session_id();
            run_command_stream(
                &world,
                stream,
                who,
                dtx,
                session_id,
                metrics.clone(),
                forced_name,
            )
            .await
        }
        None => debug!("no command stream"),
    }

    datagram_task.abort();
    datagram_sink.abort();
    // Tell the browser this WebTransport session (and with it the whole
    // QUIC connection) is finished, so its reconnect opens a fresh
    // connection instead of sessions no one accepts. Harmless if the
    // connection is already gone.
    conn.close(quinn::VarInt::from_u32(0), b"campfire: session ended");
    // Pair the session_open() at the top: the live-session gauge must not
    // only ever grow.
    metrics.session_close();
}

/// Read `join`/`chat`/`typing` lines, enforce limits, and relay through the
/// world. Returns when the stream ends, idles out, or breaks a hard limit.
async fn run_command_stream<S>(
    world: &World,
    stream: S,
    who: Who,
    dtx: mpsc::UnboundedSender<Vec<u8>>,
    session_id: u64,
    metrics: Metrics,
    forced_name: Option<String>,
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
                    metrics.rate_limit_hit();
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
                        metrics.rate_limit_hit();
                        warn!("session exceeded message rate");
                        break 'read;
                    }
                    if !dispatch(
                        world,
                        &line,
                        &tx,
                        &mut session,
                        &mut chat,
                        &who,
                        &dtx,
                        session_id,
                        &metrics,
                        forced_name.as_deref(),
                    ) {
                        break 'read;
                    }
                }
            }
            Ok(Err(_err)) => break 'read,
        }
    }

    if let Some((room, id, _)) = &session {
        // The session is gone (README §5 reconnect): the user keeps their
        // identity for the reconnect window; the tick turns it into a real
        // leave if no rejoin with the token shows up in time.
        world.discard(room, id, session_id);
        *who.lock().unwrap() = None; // no more movement for this session
        info!(user = %id, room = %room, "session ended; reconnect window starts");
    }
    drop(tx); // writer task finishes and shuts the stream down
    let _ = writer.await;
}

/// Handle one command line. Returns `false` when the session must be torn
/// down (rate-limit break, or the send channel closed).
// Eight flat parameters on purpose: the world, the line, the session's two
// send channels + id, and the per-stream mutable state (current join, chat
// rate limit). Bundling them into structs would obscure what each arm reads.
#[allow(clippy::too_many_arguments)]
fn dispatch(
    world: &World,
    line: &str,
    tx: &mpsc::UnboundedSender<ServerMsg>,
    session: &mut Option<(String, String, String)>,
    chat_limit: &mut RateLimit,
    who: &Who,
    dtx: &mpsc::UnboundedSender<Vec<u8>>,
    session_id: u64,
    metrics: &Metrics,
    forced_name: Option<&str>,
) -> bool {
    match campfire_protocol::from_line::<ClientMsg>(line) {
        Ok(ClientMsg::Join {
            room,
            name,
            avatar,
            token,
            status,
        }) => {
            if session.is_some() {
                return send(tx, ErrorCode::BadMessage);
            }
            if !valid_room(&room) {
                return send(tx, ErrorCode::BadMessage);
            }
            // Auth (README §11): the IdP-forced name overrides the client's
            // (it is already trimmed and capped to MAX_NAME_CHARS).
            let name = match forced_name {
                Some(forced) => forced.to_owned(),
                None => {
                    let name = name.trim();
                    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
                        return send(tx, ErrorCode::NameTooLong);
                    }
                    name.to_owned()
                }
            };
            let name = name.as_str();
            if let Some(avatar) = &avatar
                && avatar.color.len() > MAX_AVATAR_CHARS
            {
                return send(tx, ErrorCode::BadMessage);
            }
            match world.join(
                &room,
                name,
                avatar.clone(),
                token.as_deref(),
                status.unwrap_or_default(),
                session_id,
                tx.clone(),
                dtx.clone(),
            ) {
                Ok(joined) => {
                    let you = joined.you;
                    *session = Some((room.clone(), you.clone(), name.to_owned()));
                    *who.lock().unwrap() = Some((room.clone(), you.clone()));
                    let msg = ServerMsg::Hello {
                        you,
                        token: joined.token,
                        room,
                        users: joined.users,
                        chat: joined.chat,
                        call_chat: joined.call_chat,
                        call: joined.call,
                        ticket: joined.ticket,
                    };
                    tx.send(msg).is_ok()
                }
                Err(crate::world::JoinError::RoomFull) => send(tx, ErrorCode::RoomFull),
                Err(crate::world::JoinError::UnknownRoom) => send(tx, ErrorCode::UnknownRoom),
            }
        }
        Ok(ClientMsg::Leave) => {
            let Some((room, id, _)) = session.clone() else {
                return send(tx, ErrorCode::BadMessage);
            };
            // Intentional leave: immediate `Left` broadcast (room switcher).
            // The identity is still held for the reconnect window (a reload
            // re-joins with the same token); the session is torn down.
            world.leave(&room, &id, session_id);
            *who.lock().unwrap() = None;
            *session = None;
            info!(user = %id, room = %room, "user left");
            false
        }
        Ok(ClientMsg::Chat { text, scope }) => {
            let Some((room, id, name)) = session.clone() else {
                return send(tx, ErrorCode::BadMessage);
            };
            if text.chars().count() > MAX_CHAT_CHARS {
                return send(tx, ErrorCode::ChatTooLong);
            }
            if !chat_limit.allow(1, CHAT_PER_SEC) {
                metrics.rate_limit_hit();
                return send(tx, ErrorCode::RateLimited);
            }
            let msg = ChatMsg {
                from: id,
                name,
                text,
                ts: unix_ts(),
                scope,
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
        Ok(ClientMsg::Status { status }) => {
            let Some((room, id, _)) = session.clone() else {
                return send(tx, ErrorCode::BadMessage);
            };
            call_result(world.set_status(&room, &id, status), tx)
        }
        // Call state + presence (README §5/§6.3): the world validates
        // (same room, sender involved); errors go back as `error` messages.
        Ok(ClientMsg::Bubble { off }) => {
            let Some((room, id, _)) = session.clone() else {
                return send(tx, ErrorCode::BadMessage);
            };
            call_result(world.set_bubble(&room, &id, off), tx)
        }
        Ok(ClientMsg::CallMute { audio, video }) => {
            let Some((room, id, _)) = session.clone() else {
                return send(tx, ErrorCode::BadMessage);
            };
            call_result(world.call_mute(&room, &id, audio, video), tx)
        }
        Ok(ClientMsg::CallScreen { on }) => {
            let Some((room, id, _)) = session.clone() else {
                return send(tx, ErrorCode::BadMessage);
            };
            call_result(world.call_screen(&room, &id, on), tx)
        }
        Ok(ClientMsg::CallLeave) => {
            let Some((room, id, _)) = session.clone() else {
                return send(tx, ErrorCode::BadMessage);
            };
            call_result(world.call_leave(&room, &id), tx)
        }
        // Keepalive: the read loop's idle timer already reset with the
        // bytes, so there is nothing to do (README §5).
        Ok(ClientMsg::Ping) => true,
        Err(_err) => send(tx, ErrorCode::BadMessage),
    }
}

/// Room ids: `1..=64` chars of `[a-z0-9_-]`.
pub(crate) fn valid_room(room: &str) -> bool {
    (1..=MAX_ROOM_CHARS).contains(&room.len())
        && room.split('/').all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        })
}

/// Send one `error` message; `false` means the client is gone.
fn send(tx: &mpsc::UnboundedSender<ServerMsg>, code: ErrorCode) -> bool {
    tx.send(ServerMsg::Error { code }).is_ok()
}

/// A world call-method result as a dispatch return value.
fn call_result(result: Result<(), ErrorCode>, tx: &mpsc::UnboundedSender<ServerMsg>) -> bool {
    match result {
        Ok(()) => true,
        Err(code) => send(tx, code),
    }
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
        assert!(!valid_room(&"x".repeat(65)));
        assert!(valid_room(&"x".repeat(64)));
        // Map ids are file paths under maps/: one slash-separated chain of
        // directory/file segments (interiors/conference).
        assert!(valid_room("interiors/conference"));
        assert!(valid_room("interiors/office"));
        assert!(!valid_room("interiors/example//conference"));
        assert!(!valid_room("/office"));
        assert!(!valid_room("office/"));
    }

    #[test]
    fn rate_limit_window_resets() {
        let mut rl = RateLimit::new();
        assert!(rl.allow(3, 5));
        assert!(!rl.allow(3, 5));
    }
}

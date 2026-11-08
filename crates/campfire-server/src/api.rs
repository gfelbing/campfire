//! HTTP/3 API: embedded web client, maps, rooms, health, WebTransport, and
//! the SSE+POST realtime fallback (README §4, §8).
//!
//! Everything is served from the single QUIC socket. The web client is
//! embedded at compile time from `client/dist` (single deploy artifact,
//! README §3); `--static-dir` overrides the source at runtime for the dev
//! loop (`just dev`).

use std::collections::HashMap;
use std::io::Read;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::http::Uri;
use axum::http::header;
use axum::response::sse::Event;
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{connect, get, post};
use axum::{Extension, Json, Router};
use bytes::Bytes;
use campfire_protocol::{Avatar, ChatMsg, ClientMsg, ErrorCode, ServerMsg, to_line};
use futures_util::StreamExt;
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_stream::wrappers::{IntervalStream, UnboundedReceiverStream};
use tokio_stream::{Stream, StreamMap};
use tracing::debug;

use crate::config::Config;
use crate::realtime::{
    MAX_AVATAR_CHARS, MAX_CHAT_CHARS, MAX_NAME_CHARS, RateLimit, handle_wt, unix_ts, valid_room,
};
use crate::world::{RoomInfo, World};

/// Web client, built by Vite and embedded at compile time (README §3).
static STATIC: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../client/dist");

static START: OnceLock<Instant> = OnceLock::new();

/// Router state: the world plus the optional runtime static dir.
#[derive(Clone)]
pub struct AppState {
    pub world: World,
    /// Serve static files from this directory instead of the embed (dev).
    pub static_dir: Option<PathBuf>,
    /// Shared TURN REST secret for minting relay credentials (README §6.2).
    pub turn_secret: String,
    /// Per-IP throttle for the TURN credential endpoint: a *fresh pair* is
    /// minted at most once per 10 min per IP; repeats within the window get
    /// the cached pair (many users behind one NAT legitimately share it —
    /// the mint limit is what throttles abuse, not uniqueness).
    pub turn_rate: Arc<std::sync::Mutex<HashMap<std::net::IpAddr, (Instant, TurnCredential)>>>,
    /// Shared metrics registry (README §11 Phase 8, `/metrics`).
    pub metrics: crate::metrics::Metrics,
}

impl AppState {
    pub fn new(cfg: &Config, turn_secret: String) -> Self {
        Self::with_metrics(cfg, turn_secret, crate::metrics::Metrics::new())
    }

    /// [`AppState::new`] with a shared metrics registry (the real server
    /// passes the same one the tick loop and TLS front feed).
    pub fn with_metrics(
        cfg: &Config,
        turn_secret: String,
        metrics: crate::metrics::Metrics,
    ) -> Self {
        Self {
            world: World::new(),
            static_dir: cfg.static_dir.clone(),
            turn_secret,
            turn_rate: Arc::new(std::sync::Mutex::new(HashMap::new())),
            metrics,
        }
    }
}

/// Call once at process start (used for the health payload).
pub fn mark_start() {
    let _ = START.set(Instant::now());
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    users: usize,
    rooms: usize,
    uptime_secs: u64,
}

#[derive(Serialize)]
struct MapInfo {
    id: String,
    name: String,
    thumb: Option<String>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        // Prometheus scrape endpoint (README §11 Phase 8).
        .route("/metrics", get(metrics_endpoint))
        .route("/api/v1/maps", get(list_maps))
        .route("/api/v1/maps/{id}", get(map_by_id))
        // Map-owned files (tileset images) relative to the map URL, so the
        // Tiled JSON's relative `image` paths resolve as-is (README §6.1).
        .route("/api/v1/maps/{id}/{*path}", get(map_asset))
        .route("/api/v1/rooms", get(list_rooms))
        // TURN REST credentials for the co-located relay (README §6.2).
        .route("/api/v1/turn/credential", post(turn_credential))
        // WebTransport realtime session (README §5).
        .route("/wt", connect(handle_wt))
        // Realtime fallback for browsers without WebTransport (README §8).
        .route("/rt/sse", get(sse_stream))
        .route("/rt/event", post(fallback_event))
        // Everything else is a static asset (or a 404).
        .fallback(handle_static)
        .with_state(state)
}

/// Prometheus text exposition (README §14); the world's gauges are read
/// here so they are consistent with the moment of the scrape.
async fn metrics_endpoint(State(state): State<AppState>) -> impl axum::response::IntoResponse {
    let (users, rooms) = state.world.stats();
    let calls = state.world.call_count();
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state
            .metrics
            .render((users as u64, rooms as u64, calls as u64)),
    )
}

async fn healthz(State(state): State<AppState>) -> Json<Health> {
    let (users, rooms) = state.world.stats();
    let uptime_secs = START.get().map(|s| s.elapsed().as_secs()).unwrap_or(0);
    Json(Health {
        status: "ok",
        users,
        rooms,
        uptime_secs,
    })
}

/// `GET /api/v1/maps` → one entry per bundled map, sorted by id.
async fn list_maps() -> Json<Vec<MapInfo>> {
    let mut maps: Vec<MapInfo> = campfire_maps::bundled()
        .values()
        .map(|m| MapInfo {
            id: m.id.clone(),
            name: m.name.clone(),
            thumb: None,
        })
        .collect();
    maps.sort_by(|a, b| a.id.cmp(&b.id));
    Json(maps)
}

/// `GET /api/v1/maps/{id}` → the Tiled JSON for one bundled map.
async fn map_by_id(UrlPath(id): UrlPath<String>) -> Result<impl IntoResponse, StatusCode> {
    campfire_maps::bundled()
        .get(&id)
        .map(|m| {
            (
                [(header::CONTENT_TYPE, "application/json")],
                Bytes::from(m.raw.clone()),
            )
        })
        .ok_or(StatusCode::NOT_FOUND)
}

/// `GET /api/v1/maps/{id}/{*path}` → a file from the map's own directory
/// (tileset images). Content type by extension, PNG as the only expected one.
async fn map_asset(
    UrlPath((id, path)): UrlPath<(String, String)>,
) -> Result<impl IntoResponse, StatusCode> {
    let bytes = campfire_maps::asset(&id, &path).ok_or(StatusCode::NOT_FOUND)?;
    let mime = match path.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    };
    Ok(([(header::CONTENT_TYPE, mime)], Bytes::from_static(bytes)))
}

/// `GET /api/v1/rooms` → the active rooms with member counts.
async fn list_rooms(State(state): State<AppState>) -> Json<Vec<RoomInfo>> {
    Json(state.world.rooms_list())
}

// ---------------------------------------------------------------------------
// TURN REST credentials (README §6.2)
// ---------------------------------------------------------------------------

/// Credentials live for one hour; the server does not validate the
/// timestamp inside the username (turn-server trusts the shared secret),
/// so expiry is enforced by us minting fresh ones and clients using them
/// for one call setup.
const TURN_TTL: Duration = Duration::from_secs(3600);
/// A fresh pair is minted at most once per ten minutes per peer address;
/// repeats inside the window get the cached pair (shared IPs, README §14).
const TURN_CRED_LIMIT: Duration = Duration::from_secs(600);

/// Public because it sits in `AppState::turn_rate`'s value type (tests
/// construct the state).
#[derive(Clone, Serialize)]
pub struct TurnCredential {
    username: String,
    credential: String,
    expires: u64,
}
/// `POST /api/v1/turn/credential` → a short-lived TURN REST pair.
///
/// The username is `"{expires_unix}:{peer_ip}"` per the TURN REST draft;
/// the credential is `base64(HMAC-SHA1(secret, username))`, which the
/// co-located turn-server verifies independently.
async fn turn_credential(
    State(state): State<AppState>,
    Extension(remote): Extension<SocketAddr>,
) -> Result<Json<TurnCredential>, (StatusCode, String)> {
    let ip = remote.ip();
    {
        let seen = state.turn_rate.lock().unwrap();
        let now = Instant::now();
        if let Some((last, cred)) = seen.get(&ip)
            && now.duration_since(*last) < TURN_CRED_LIMIT
            && cred.expires > now_unix().saturating_add(60)
        // still > 1 min of life left
        {
            // Same IP inside the mint window: hand back the cached pair.
            return Ok(Json(cred.clone()));
        }
    }
    let now_unix = now_unix();
    let expires = now_unix + TURN_TTL.as_secs();
    let username = format!("{expires}:{ip}");
    let credential = crate::stun::turn_rest_credential(&state.turn_secret, &username);
    let cred = TurnCredential {
        username,
        credential,
        expires,
    };
    state
        .turn_rate
        .lock()
        .unwrap()
        .insert(ip, (Instant::now(), cred.clone()));
    Ok(Json(cred))
}

/// Unix seconds now (0 if the clock is before the epoch).
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Realtime fallback: SSE down, POST up (README §8). Same message protocol as
// the WebTransport stream; movement (datagrams) is the one thing it cannot
// do, so fallback clients see presence, chat and calls but not movement.
// ---------------------------------------------------------------------------

/// POST /rt/event body: either a join or one relayed stream message.
#[derive(Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
enum FallbackReq {
    Join {
        room: String,
        name: String,
        #[serde(default)]
        avatar: Option<Avatar>,
        /// Reconnect token from a previous `hello` (README §5).
        #[serde(default)]
        token: Option<String>,
    },
    Msg {
        token: String,
        msg: ClientMsg,
    },
}

/// One fallback (SSE+POST) session, keyed by user id (== relay token).
struct FallbackSession {
    room: String,
    name: String,
    user_id: String,
    /// The world session this fallback session restored (guards against a
    /// stale timeout clobbering a newer session, README §5 reconnect).
    session_id: u64,
    /// 1 chat/s, like the WebTransport path.
    chat: Mutex<RateLimit>,
    /// The outbound receiver, taken exactly once by the /rt/sse stream.
    rx: Mutex<Option<mpsc::UnboundedReceiver<ServerMsg>>>,
}

type FallbackMap = Arc<Mutex<HashMap<String, FallbackSession>>>;

fn fallback_map() -> &'static FallbackMap {
    static MAP: OnceLock<FallbackMap> = OnceLock::new();
    MAP.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// `POST /rt/event` — join or relay one stream message.
async fn fallback_event(
    State(state): State<AppState>,
    Json(req): Json<FallbackReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let err = |code: ErrorCode| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": code })),
        )
    };
    match req {
        FallbackReq::Join {
            room,
            name,
            avatar,
            token,
        } => {
            if !valid_room(&room) {
                return Err(err(ErrorCode::BadMessage));
            }
            let name = name.trim();
            if name.is_empty() || name.len() > MAX_NAME_CHARS {
                return Err(err(ErrorCode::NameTooLong));
            }
            if let Some(avatar) = &avatar
                && avatar.color.len() > MAX_AVATAR_CHARS
            {
                return Err(err(ErrorCode::BadMessage));
            }
            let (tx, rx) = mpsc::unbounded_channel::<ServerMsg>();
            // Keep a clone: world.join stores the original in the member, and
            // we need a sender to push the hello into the session channel.
            let hello_tx = tx.clone();
            // Datagram channel is dropped immediately: the fallback has no
            // datagram path (movement is the one thing it cannot carry).
            let (dtx, _dtx_rx) = mpsc::unbounded_channel::<Vec<u8>>();
            let session_id = state.world.next_session_id();
            let user_id =
                match state
                    .world
                    .join(&room, name, avatar, token.as_deref(), session_id, tx, dtx)
                {
                    Ok(joined) => {
                        // The unbounded channel buffers the hello until the SSE
                        // stream claims the receiver.
                        let _ = hello_tx.send(ServerMsg::Hello {
                            you: joined.you.clone(),
                            token: joined.token,
                            room: room.clone(),
                            users: joined.users,
                            chat: joined.chat,
                            call: joined.call,
                        });
                        joined.you
                    }
                    Err(e) => {
                        let code = match e {
                            crate::world::JoinError::RoomFull => ErrorCode::RoomFull,
                            crate::world::JoinError::UnknownRoom => ErrorCode::UnknownRoom,
                        };
                        return Err(err(code));
                    }
                };
            fallback_map().lock().unwrap().insert(
                user_id.clone(),
                FallbackSession {
                    room: room.clone(),
                    name: name.to_owned(),
                    user_id: user_id.clone(),
                    session_id,
                    chat: Mutex::new(RateLimit::new()),
                    rx: Mutex::new(Some(rx)),
                },
            );

            // A join that never opens its SSE stream is a dead session.
            let world = state.world.clone();
            let map = fallback_map().clone();
            let user_id_bg = user_id.clone();
            let session_id_bg = session_id;
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let mut guard = map.lock().unwrap();
                // Only this join's session: a rejoin with the same token
                // replaces the map entry with a newer session id.
                if let Some(s) = guard.get(&user_id_bg)
                    && s.session_id == session_id_bg
                    && s.rx.lock().unwrap().is_some()
                {
                    guard.remove(&user_id_bg);
                    world.leave(&room, &user_id_bg);
                }
            });

            Ok(Json(serde_json::json!({ "token": user_id })))
        }
        FallbackReq::Msg { token, msg } => {
            let guard = fallback_map().lock().unwrap();
            let Some(session) = guard.get(&token) else {
                return Err(err(ErrorCode::BadMessage));
            };
            let (room, name) = (session.room.clone(), session.name.clone());
            match msg {
                ClientMsg::Chat { text } => {
                    if text.chars().count() > MAX_CHAT_CHARS {
                        return Err(err(ErrorCode::ChatTooLong));
                    }
                    let mut chat = session.chat.lock().unwrap();
                    if !chat.allow(1, 1) {
                        state.metrics.rate_limit_hit();
                        return Err(err(ErrorCode::RateLimited));
                    }
                    drop(chat);
                    state.world.broadcast_chat(
                        &room,
                        ChatMsg {
                            from: token,
                            name,
                            text,
                            ts: unix_ts(),
                        },
                    );
                }
                ClientMsg::Typing { on } => {
                    state.world.broadcast_typing(&room, &token, on);
                }
                // Bubble opt-out and call signaling: same world methods as
                // the WebTransport path (README §5); fallback clients get
                // presence, chat and calls.
                ClientMsg::Bubble { off } => {
                    let _ = state.world.set_bubble(&room, &token, off);
                }
                ClientMsg::CallOffer { to, sdp } => {
                    let _ = state.world.call_relay_offer(&room, &token, &to, sdp);
                }
                ClientMsg::CallAnswer { to, sdp } => {
                    let _ = state.world.call_relay_answer(&room, &token, &to, sdp);
                }
                ClientMsg::CallIce { to, candidate } => {
                    let _ = state.world.call_relay_ice(&room, &token, &to, candidate);
                }
                ClientMsg::CallMute { audio, video } => {
                    let _ = state.world.call_mute(&room, &token, audio, video);
                }
                ClientMsg::CallLeave => {
                    let _ = state.world.call_leave(&room, &token);
                }
                // Intentional leave (room switcher): immediate `Left`, and
                // the session is gone (the SSE stream ends with the member's
                // channel).
                ClientMsg::Leave => {
                    state.world.leave(&room, &token);
                    fallback_map().lock().unwrap().remove(&token);
                }
                ClientMsg::Join { .. } => return Err(err(ErrorCode::BadMessage)),
            }
            Ok(Json(serde_json::json!({})))
        }
    }
}

/// `?token=…` query for /rt/sse.
#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

/// `GET /rt/sse?token=…` — the reliable downlink for one fallback session.
async fn sse_stream(
    State(state): State<AppState>,
    Query(query): Query<TokenQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, (StatusCode, String)>
{
    let Some(token) = query.token else {
        return Err((StatusCode::BAD_REQUEST, "missing token".into()));
    };
    // Take the receiver under the same lock that guards it, so a token can
    // be claimed by at most one stream.
    let (room, user_id, rx, session_id) = {
        let guard = fallback_map().lock().unwrap();
        let session = guard
            .get(&token)
            .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown token {token}")))?;
        let rx = session
            .rx
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| (StatusCode::CONFLICT, "token already claimed".into()))?;
        (
            session.room.clone(),
            session.user_id.clone(),
            rx,
            session.session_id,
        )
    };

    let messages = UnboundedReceiverStream::new(rx)
        .map(|msg| Ok::<_, std::convert::Infallible>(Event::default().data(to_line(&msg))))
        .boxed();
    let keep_alive = IntervalStream::new(tokio::time::interval(Duration::from_secs(15)))
        .map(|_| Ok::<_, std::convert::Infallible>(Event::default().comment("ping")))
        .boxed();

    let mut interleaved = StreamMap::new();
    interleaved.insert("msg", messages);
    interleaved.insert("ping", keep_alive);

    let stream = CleanupOnEnd {
        inner: interleaved.map(|(_, ev)| ev).fuse(),
        world: state.world.clone(),
        room,
        user_id,
        session_id,
        cleaned: false,
    };
    Ok(Sse::new(stream))
}

/// Wraps an SSE stream so that when it ends (client disconnect, or the
/// message channel closing), the user enters the reconnect window (README
/// §5) instead of leaving immediately.
struct CleanupOnEnd<S> {
    inner: S,
    world: World,
    room: String,
    user_id: String,
    session_id: u64,
    cleaned: bool,
}

impl<S: Stream + Unpin> Stream for CleanupOnEnd<S> {
    type Item = S::Item;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match Pin::new(&mut self.inner).poll_next(cx) {
            Poll::Ready(None) => {
                if !self.cleaned {
                    self.cleaned = true;
                    self.world
                        .discard(&self.room, &self.user_id, self.session_id);
                    fallback_map().lock().unwrap().remove(&self.user_id);
                    debug!(user = %self.user_id, room = %self.room, "fallback session ended");
                }
                Poll::Ready(None)
            }
            other => other,
        }
    }
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

async fn handle_static(State(state): State<AppState>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    serve_static(&state, path).unwrap_or_else(|| {
        debug!(path, "static miss");
        StatusCode::NOT_FOUND.into_response()
    })
}

/// Serve one static file: the runtime dir (dev) when configured, otherwise
/// the compile-time embed.
fn serve_static(state: &AppState, path: &str) -> Option<Response> {
    // No path traversal.
    if Path::new(path)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return None;
    }
    let (bytes, mime) = if let Some(dir) = &state.static_dir {
        let mut buf = Vec::new();
        let mut file = std::fs::File::open(dir.join(path)).ok()?;
        file.read_to_end(&mut buf).ok()?;
        (buf, mime_for(path))
    } else {
        let file = STATIC.get_file(path)?;
        (file.contents().to_vec(), mime_for(path))
    };
    Some((StatusCode::OK, [(header::CONTENT_TYPE, mime)], bytes).into_response())
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, e)| e) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("txt") => "text/plain; charset=utf-8",
        Some("map") => "application/json",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

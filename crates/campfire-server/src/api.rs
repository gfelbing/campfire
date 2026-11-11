//! HTTP/3 API: embedded web client, maps, rooms, health, WebTransport, and
//! the SSE+POST realtime fallback (README §4, §8).
//!
//! Everything is served from the single QUIC socket. The web client is
//! embedded at compile time from `client/dist` (single deploy artifact,
//! README §3); `--static-dir` overrides the source at runtime for the dev
//! loop (`just dev`).

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::header;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::sse::Event;
use axum::response::{IntoResponse, Response, Sse};
use axum::routing::{connect, get, post};
use axum::{Json, Router};
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
use crate::moq::handle_moq;
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
    /// Shared metrics registry (README §11 Phase 8, `/metrics`).
    pub metrics: crate::metrics::Metrics,
    /// The MoQ SFU (docs/moq-sfu.md §5): one per process, wired to the
    /// world's call-end hook so call media origins are reaped.
    pub moq: std::sync::Arc<crate::moq::MoqSfu>,
    /// OpenID Connect authentication (README §11). `None` when disabled;
    /// when set, a join without a valid session cookie is refused and a
    /// valid one forces the display name from the IdP.
    pub auth: Option<std::sync::Arc<crate::auth::Auth>>,
}

impl AppState {
    /// [`AppState::with_metrics`] with a fresh metrics registry (tests).
    pub fn new(cfg: &Config) -> anyhow::Result<Self> {
        Self::with_metrics(cfg, crate::metrics::Metrics::new())
    }

    /// Build the full state, resolving the (optional) auth config from the
    /// CLI. Errors when auth is enabled but misconfigured.
    pub fn with_metrics(cfg: &Config, metrics: crate::metrics::Metrics) -> anyhow::Result<Self> {
        let auth = cfg
            .auth_openid()?
            .map(|a| crate::auth::Auth::new(a.issuer, a.client_id, a.client_secret, a.redirect_uri))
            .transpose()?
            .map(std::sync::Arc::new);
        Ok(Self::with_parts(cfg, metrics, auth))
    }

    /// The infallible core: build the state from an already-resolved auth
    /// handle (tests and the load-test tool pass `None`).
    pub fn with_parts(
        cfg: &Config,
        metrics: crate::metrics::Metrics,
        auth: Option<std::sync::Arc<crate::auth::Auth>>,
    ) -> Self {
        // The SFU is built next to the world and shares its ticket store;
        // the world's call-end hook reaps the SFU's per-call media origins
        // (docs/moq-sfu.md §5).
        let world = World::new(campfire_maps::Maps::load(&cfg.maps_dir));
        let moq = crate::moq::MoqSfu::new(world.clone(), metrics.clone());
        let world = world.on_call_end(moq.call_end_hook());
        Self {
            world,
            static_dir: cfg.static_dir.clone(),
            metrics,
            moq,
            auth,
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
        // The map id may contain slashes (`interiors/conference`), so
        // one wildcard serves both the map JSON and map-owned files (tileset
        // images relative to the map URL, README §6.1): `office`,
        // `office/tiles.png`.
        .route("/api/v1/maps/{*rest}", get(map_or_asset))
        .route("/api/v1/rooms", get(list_rooms))
        // OpenID Connect auth (README §11): status probe, login, callback,
        // logout. The status endpoint is always 200 (the client uses it to
        // decide whether to redirect to login).
        .route("/api/v1/auth", get(auth_status))
        .route("/auth/login", get(auth_login))
        .route("/auth/callback", get(auth_callback))
        .route("/auth/logout", get(auth_logout))
        // WebTransport realtime session (README §5).
        .route("/wt", connect(handle_wt))
        // MoQ SFU media session (docs/moq-sfu.md §5): a second WebTransport
        // connection carrying the call's media, admitted by ticket.
        .route("/moq", connect(handle_moq))
        // The map in the URL path: `/play/office/office.json` picks the
        // office map. The server serves the SPA; the client takes the room
        // id from the path segment.
        .route("/play/{*rest}", get(play))
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
    // SFU gauges: live origins + the media traffic through the moq-net
    // stats registry (docs/moq-sfu.md §5).
    let (objects_in, bytes_in, objects_out, bytes_out) = state.moq.traffic();
    let moq = crate::metrics::MoqGauges {
        origins: state.moq.live_origins(),
        objects_in,
        bytes_in,
        objects_out,
        bytes_out,
    };
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state
            .metrics
            .render((users as u64, rooms as u64, calls as u64), &moq),
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

/// `GET /api/v1/maps` → one entry per loaded map, sorted by id.
async fn list_maps(State(state): State<AppState>) -> Json<Vec<MapInfo>> {
    Json(
        state
            .world
            .maps()
            .all()
            .into_iter()
            .map(|m| MapInfo {
                id: m.id.clone(),
                name: m.name.clone(),
                thumb: None,
            })
            .collect(),
    )
}

/// `GET /api/v1/maps/{*rest}` → the map JSON (`office`,
/// `interiors/conference`) or a file from the map's own directory
/// (`office/tiles.png`; tileset images). Content type by extension.
async fn map_or_asset(
    State(state): State<AppState>,
    UrlPath(rest): UrlPath<String>,
) -> Result<impl IntoResponse, StatusCode> {
    // A map id (no extension, resolvable) serves the Tiled JSON.
    if !rest.contains('.')
        && let Some(m) = state.world.maps().get(&rest)
    {
        return Ok((
            [(header::CONTENT_TYPE, "application/json")],
            Bytes::from(m.raw.clone()),
        ));
    }
    // Otherwise the remainder after the map id is a file of the map's
    // directory: longest matching id first (ids may contain slashes).
    let maps = state.world.maps();
    for m in maps.all() {
        let Some(file) = rest.strip_prefix(&m.id).and_then(|r| r.strip_prefix('/')) else {
            continue;
        };
        let Some(bytes) = maps.asset(&m.id, file) else {
            return Err(StatusCode::NOT_FOUND);
        };
        let mime = match file.rsplit('.').next() {
            Some("png") => "image/png",
            Some("jpg" | "jpeg") => "image/jpeg",
            Some("webp") => "image/webp",
            Some("gif") => "image/gif",
            Some("json") => "application/json",
            _ => "application/octet-stream",
        };
        return Ok(([(header::CONTENT_TYPE, mime)], Bytes::from(bytes)));
    }
    Err(StatusCode::NOT_FOUND)
}

/// `GET /api/v1/rooms` → the active rooms with member counts.
async fn list_rooms(State(state): State<AppState>) -> Json<Vec<RoomInfo>> {
    Json(state.world.rooms_list())
}

// ---------------------------------------------------------------------------
// OpenID Connect auth (README §11, authorization-code flow). When enabled, a
// visitor signs in through the IdP; a session cookie maps to a verified name
// that is forced onto every join. See `crate::auth` for the protocol.
// ---------------------------------------------------------------------------

/// The session cookie name. HttpOnly: the client never reads it (it only
/// probes `/api/v1/auth`).
pub(crate) const AUTH_COOKIE: &str = "campfire_auth";

/// The value of the [`AUTH_COOKIE`], if the request carries it.
pub(crate) fn auth_cookie(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        if let Some(value) = part.trim().strip_prefix(&format!("{AUTH_COOKIE}=")) {
            return (!value.is_empty()).then_some(value.to_owned());
        }
    }
    None
}

/// The join gate (README §11). Returns the IdP-forced name when auth is
/// enabled, or `None` when auth is off (the caller uses the client's name).
/// A 401 when auth is on but the session cookie is missing or invalid.
pub(crate) fn enforce_auth(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<String>, StatusCode> {
    let Some(auth) = &state.auth else {
        return Ok(None);
    };
    let cookie = auth_cookie(headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let identity = auth
        .identity_for_cookie(&cookie)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Some(identity.name))
}

/// `return_to` must be a same-origin absolute path (no `//`, no backslash,
/// no CR/LF): an open redirect could bounce a signed-in user to another site.
fn valid_return_to(s: &str) -> bool {
    s.starts_with('/') && !s.starts_with("//") && s.len() <= 2048 && !s.contains(['\\', '\r', '\n'])
}

/// `GET /api/v1/auth` → whether auth is on and the signed-in name (if any).
/// Always 200: the client probes it on boot to decide whether to redirect to
/// login.
async fn auth_status(State(state): State<AppState>, headers: HeaderMap) -> Json<serde_json::Value> {
    let Some(auth) = &state.auth else {
        return Json(serde_json::json!({ "enabled": false }));
    };
    let name = auth_cookie(&headers).and_then(|c| auth.identity_for_cookie(&c).map(|i| i.name));
    Json(match name {
        Some(name) => serde_json::json!({ "enabled": true, "name": name }),
        None => serde_json::json!({ "enabled": true }),
    })
}

#[derive(Deserialize)]
struct LoginQuery {
    #[serde(default)]
    return_to: Option<String>,
}

/// `GET /auth/login?return_to=…` → 302 to the IdP's authorization endpoint
/// (with a random `state` + `nonce`).
async fn auth_login(State(state): State<AppState>, Query(q): Query<LoginQuery>) -> Response {
    let Some(auth) = &state.auth else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let return_to = q
        .return_to
        .filter(|s| valid_return_to(s))
        .unwrap_or_else(|| "/".to_owned());
    match auth.start_login(return_to).await {
        Ok(url) => (StatusCode::FOUND, [(header::LOCATION, url)]).into_response(),
        Err(err) => {
            tracing::warn!(error = %err, "auth login: IdP discovery failed");
            (StatusCode::BAD_GATEWAY, "upstream IdP error").into_response()
        }
    }
}

#[derive(Deserialize)]
struct CallbackQuery {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

/// `GET /auth/callback?code&state` → exchange the code, verify the id_token,
/// mint a session cookie, 302 back to the original page.
async fn auth_callback(State(state): State<AppState>, Query(q): Query<CallbackQuery>) -> Response {
    let Some(auth) = &state.auth else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (Some(code), Some(state)) = (q.code, q.state) else {
        return (StatusCode::BAD_REQUEST, "missing code or state").into_response();
    };
    match auth.handle_callback(&code, &state).await {
        Ok((cookie, _identity, return_to)) => {
            let set_cookie = format!(
                "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age={ttl}",
                name = AUTH_COOKIE,
                value = cookie,
                ttl = crate::auth::SESSION_TTL.as_secs()
            );
            (
                StatusCode::FOUND,
                [
                    (header::LOCATION, return_to),
                    (header::SET_COOKIE, set_cookie),
                ],
            )
                .into_response()
        }
        Err(err) => {
            tracing::warn!(error = %err, "auth callback failed");
            // Land on the page; the client sees auth enabled + unsigned in
            // `/api/v1/auth` and redirects to login again.
            (StatusCode::FOUND, [(header::LOCATION, "/")]).into_response()
        }
    }
}

/// `GET /auth/logout` → drop the session, clear the cookie, 302 to `/`.
async fn auth_logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let (Some(auth), Some(cookie)) = (&state.auth, auth_cookie(&headers)) {
        auth.logout(&cookie);
    }
    let clear = format!(
        "{name}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0",
        name = AUTH_COOKIE
    );
    (
        StatusCode::FOUND,
        [(header::LOCATION, "/"), (header::SET_COOKIE, &clear)],
    )
        .into_response()
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
    headers: HeaderMap,
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
            // Auth (README §11): when enabled, the name is forced from the
            // verified session cookie; a missing/invalid cookie is refused.
            let name = match enforce_auth(&state, &headers) {
                Ok(Some(forced)) => forced,
                Ok(None) => {
                    let name = name.trim();
                    if name.is_empty() || name.len() > MAX_NAME_CHARS {
                        return Err(err(ErrorCode::NameTooLong));
                    }
                    name.to_owned()
                }
                Err(status) => {
                    return Err((
                        status,
                        Json(serde_json::json!({ "error": "unauthenticated" })),
                    ));
                }
            };
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
                    .join(&room, &name, avatar, token.as_deref(), session_id, tx, dtx)
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
                            ticket: joined.ticket,
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
                    name: name.clone(),
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
                // Bubble opt-out and call mute/screen: same world methods
                // as the WebTransport path (README §5); fallback clients
                // get presence, chat and calls.
                ClientMsg::Bubble { off } => {
                    let _ = state.world.set_bubble(&room, &token, off);
                }
                ClientMsg::CallMute { audio, video } => {
                    let _ = state.world.call_mute(&room, &token, audio, video);
                }
                ClientMsg::CallScreen { on } => {
                    let _ = state.world.call_screen(&room, &token, on);
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
                // Keepalive (README §5): the session lives with the open SSE
                // stream, not a command-stream idle timer — nothing to do.
                ClientMsg::Ping => {}
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

/// `GET /play/{id}/...` → the SPA; the client takes the map id from the
/// path's second segment (`/play/office/office.json` → room `office`).
async fn play(State(state): State<AppState>) -> Response {
    serve_static(&state, "index.html").unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

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

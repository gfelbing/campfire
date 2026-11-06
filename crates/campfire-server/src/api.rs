//! HTTP/3 API: embedded static client, map list, health, WebTransport.
//!
//! Everything is served from the single QUIC socket (README §4). Health
//! reports live world state (users/rooms) starting with Phase 2.

use std::sync::OnceLock;
use std::time::Instant;

use axum::extract::State;
use axum::http::StatusCode;
use axum::http::Uri;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{connect, get};
use axum::{Json, Router};
use include_dir::{Dir, include_dir};
use serde::Serialize;
use tracing::debug;

use crate::realtime::handle_wt;
use crate::world::World;

/// Web client, embedded at compile time (README §3: single deploy artifact).
/// Phase 1: placeholder page; Phase 4 replaces the embed with `client/dist`.
static STATIC: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../static");

/// Bundled Tiled JSON maps (Phase 3 adds the first two).
static MAPS: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../maps");

static START: OnceLock<Instant> = OnceLock::new();

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

pub fn router(world: World) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/v1/maps", get(list_maps))
        // WebTransport realtime session (README §5).
        .route("/wt", connect(handle_wt))
        // Everything else is a static asset (or a 404).
        .fallback(handle_static)
        .with_state(world)
}

async fn healthz(State(world): State<World>) -> Json<Health> {
    let (users, rooms) = world.stats();
    let uptime_secs = START.get().map(|s| s.elapsed().as_secs()).unwrap_or(0);
    Json(Health {
        status: "ok",
        users,
        rooms,
        uptime_secs,
    })
}

/// `GET /api/v1/maps` → one entry per `*.json` in the embedded `maps/` dir.
async fn list_maps() -> Json<Vec<MapInfo>> {
    let maps = MAPS
        .files()
        .filter(|f| f.path().extension().is_some_and(|e| e == "json"))
        .map(|f| {
            let id = f
                .path()
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            MapInfo {
                name: id.clone(),
                thumb: None,
                id,
            }
        })
        .collect();
    Json(maps)
}

async fn handle_static(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    serve_static(path).unwrap_or_else(|| {
        debug!(path, "static miss");
        StatusCode::NOT_FOUND.into_response()
    })
}

fn serve_static(path: &str) -> Option<Response> {
    let file = STATIC.get_file(path)?;
    Some(
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, mime_for(path))],
            file.contents(),
        )
            .into_response(),
    )
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, e)| e) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

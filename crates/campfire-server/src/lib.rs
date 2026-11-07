//! Campfire server library: HTTP/3 transport, API, world (Phase 3+).
//!
//! The `campfire` binary (`src/main.rs`) is a thin wrapper: init tracing,
//! parse the CLI, call [`run`]. The library split keeps the accept loop and
//! endpoints reusable by integration tests and the load-test tool (README §12).

pub mod api;
pub mod config;
pub mod demux;
pub mod realtime;
pub mod stun;
pub mod tls;
pub mod turn;
pub mod world;

use std::sync::Arc;

use anyhow::Result;
use rand::RngCore;
use tracing::{debug, info, warn};

/// Run the server until Ctrl-C.
///
/// One port number, two protocols on it (README §2): QUIC/HTTP/3 + STUN
/// share the UDP socket through [`demux::DemuxSocket`], and the co-located
/// TURN server takes the same address over TCP.
pub async fn run(cfg: &config::Config) -> Result<()> {
    let quinn_conf = tls::server_config_from_files(&cfg.cert, &cfg.key, cfg.idle_timeout())?;
    let socket = demux::DemuxSocket::bind(cfg.listen)?;
    let local = socket.local_addr()?;
    let endpoint = make_endpoint(quinn_conf, socket)?;
    // TURN REST secret: `--turn-secret`, or generated (and logged once) so
    // the app still works without the flag.
    let turn_secret = match &cfg.turn_secret {
        Some(secret) => secret.clone(),
        None => {
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            let secret: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            warn!(%secret, "no --turn-secret configured; generated an ephemeral one (relay credentials reset on every restart)");
            secret
        }
    };
    turn::start(cfg, &turn_secret);
    let state = api::AppState::new(cfg, turn_secret);
    info!(%local, "campfire listening over HTTP/3 (QUIC) + STUN + TURN");
    let _tick = world::start_ticking(state.world.clone());
    run_endpoint(endpoint, api::router(state)).await;
    Ok(())
}

/// Build a QUIC server endpoint over the shared demux socket.
///
/// Exposed for integration tests, which also need the STUN/QUIC demux on
/// one socket.
pub fn make_endpoint(
    server_conf: quinn::ServerConfig,
    socket: Arc<demux::DemuxSocket>,
) -> std::io::Result<quinn::Endpoint> {
    quinn::Endpoint::new_with_abstract_socket(
        quinn::EndpointConfig::default(),
        Some(server_conf),
        socket,
        Arc::new(quinn::TokioRuntime),
    )
}

/// Accept loop for a ready endpoint (split out for tests).
///
/// Returns when the Ctrl-C signal arrives; in-flight connections are left to
/// drain (full graceful shutdown lands in Phase 8).
pub async fn run_endpoint(endpoint: quinn::Endpoint, app: axum::Router) {
    loop {
        let next = tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("shutting down");
                break;
            }
            next = endpoint.accept() => next,
        };
        let Some(incoming) = next else {
            break; // endpoint closed
        };
        let app = app.clone();
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(conn) => conn,
                Err(err) => {
                    debug!(%err, "QUIC handshake failed");
                    return;
                }
            };
            // h3-axum injects no ConnectInfo, so the per-peer remote
            // address rides in as an extension for rate limiting
            // (README §6.2: the TURN credential endpoint is per-IP).
            let app = app.layer(axum::Extension(conn.remote_address()));
            if let Err(err) = serve_http3(app, conn).await {
                debug!(error = %err, "HTTP/3 connection ended");
            }
        });
    }
}

/// Drive one QUIC connection as an HTTP/3 connection.
///
/// WebTransport, extended CONNECT and datagrams are advertised here so the
/// Phase 2 realtime session works on the same connection family (README §4).
async fn serve_http3(app: axum::Router, conn: quinn::Connection) -> Result<(), h3_axum::BoxError> {
    let mut builder = h3::server::builder();
    builder
        .enable_webtransport(true)
        .enable_extended_connect(true)
        .enable_datagram(true)
        .max_webtransport_sessions(1);
    let connection = builder.build(h3_quinn::Connection::new(conn)).await?;
    h3_axum::serve_h3_connection_with_axum(app, connection).await
}

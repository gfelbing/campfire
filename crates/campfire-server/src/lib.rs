//! Campfire server library: HTTP/3 transport, API, world (Phase 3+).
//!
//! The `campfire` binary (`src/main.rs`) is a thin wrapper: init tracing,
//! parse the CLI, call [`run`]. The library split keeps the accept loop and
//! endpoints reusable by integration tests and the load-test tool (README §12).

pub mod api;
pub mod config;
pub mod realtime;
pub mod tls;
pub mod world;

use anyhow::Result;
use tracing::{debug, info};

/// Run the server until Ctrl-C: bind the QUIC socket, accept connections,
/// and drive each one over HTTP/3 through the Axum router.
pub async fn run(cfg: &config::Config) -> Result<()> {
    let quinn_conf = tls::server_config_from_files(&cfg.cert, &cfg.key, cfg.idle_timeout())?;
    let endpoint = quinn::Endpoint::server(quinn_conf, cfg.listen)?;
    let local = endpoint.local_addr()?;
    let state = api::AppState::new(cfg);
    info!(%local, "campfire listening over HTTP/3 (QUIC)");
    let _tick = world::start_ticking(state.world.clone());
    run_endpoint(endpoint, api::router(state)).await;
    Ok(())
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

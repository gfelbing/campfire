//! Campfire server library: HTTP/3 transport, API, world (Phase 3+).
//!
//! The `campfire` binary (`src/main.rs`) is a thin wrapper: init tracing,
//! parse the CLI, call [`run`]. The library split keeps the accept loop and
//! endpoints reusable by integration tests and the load-test tool (docs/dev/testing.md).

pub mod api;
pub mod auth;
pub mod bootstrap;
pub mod config;
pub mod demux;
pub mod metrics;
pub mod moq;
pub mod realtime;
pub mod tls;
pub mod world;

use std::sync::Arc;

use anyhow::Result;
use tracing::{debug, info};

/// Run the server until Ctrl-C.
pub async fn run(cfg: &config::Config) -> Result<()> {
    let quinn_conf = tls::server_config_from_files(&cfg.cert, &cfg.key, cfg.idle_timeout())?;
    let socket = demux::DemuxSocket::bind(cfg.listen)?;
    let local = socket.local_addr()?;
    let endpoint = make_endpoint(quinn_conf, socket)?;
    let metrics = metrics::Metrics::new();
    // The public TCP port is a TLS front (`bootstrap`, docs/arch/decisions.md): it
    // serves the Alt-Svc bootstrap browsers need to discover HTTP/3.
    bootstrap::start(cfg)?;
    let state = api::AppState::with_metrics(cfg, metrics.clone())?;
    info!(%local, "campfire listening over HTTP/3 (QUIC)");
    let _tick = world::start_ticking_with(state.world.clone(), metrics.clone());
    run_endpoint_with_metrics(endpoint, api::router(state), metrics).await;
    Ok(())
}

/// Build a QUIC server endpoint over the shared demux socket.
///
/// Exposed for integration tests, which build the endpoint the same way.
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
    run_endpoint_with_metrics(endpoint, app, metrics::Metrics::new()).await;
}

/// [`run_endpoint`] with connection metrics and a graceful shutdown
/// (docs/ops/README.md): on Ctrl-C the endpoint stops accepting, every
/// open connection is closed with a NO_ERROR code (browsers reconnect and
/// keep their identity via the token), and the loop returns after the
/// drain window so the tick task dies with the process.
pub async fn run_endpoint_with_metrics(
    endpoint: quinn::Endpoint,
    app: axum::Router,
    metrics: metrics::Metrics,
) {
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
        metrics.conn_open();
        let metrics = metrics.clone();
        let app = app.clone();
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(conn) => conn,
                Err(err) => {
                    debug!(%err, "QUIC handshake failed");
                    metrics.conn_close();
                    return;
                }
            };
            // h3-axum injects no ConnectInfo, so the per-peer remote
            // address rides in as an extension for rate limiting
            // (docs/arch/decisions.md: the TURN credential endpoint is per-IP), and the
            // connection itself rides in so a WebTransport session can close
            // it when the session ends (its reconnect needs a fresh one).
            let app = app
                .layer(axum::Extension(conn.remote_address()))
                .layer(axum::Extension(conn.clone()));
            if let Err(err) = serve_http3(app, conn).await {
                debug!(error = %err, "HTTP/3 connection ended");
            }
            metrics.conn_close();
        });
    }
    // Graceful drain: stop accepting and close the open connections with a
    // well-formed QUIC close (not a process kill). The 1 s window lets the
    // close frames reach clients before the process exits.
    endpoint.close(quinn::VarInt::from_u32(0), b"server shutting down");
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
}

/// Drive one QUIC connection as an HTTP/3 connection.
///
/// WebTransport, extended CONNECT and datagrams are advertised here so the
/// Phase 2 realtime session works on the same connection family (docs/arch/overview.md).
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

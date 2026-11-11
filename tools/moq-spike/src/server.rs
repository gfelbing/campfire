//! Spike SFU server (docs/moq-sfu.md Phase 0, tier 1): the production
//! h3/quinn endpoint pattern (quinn + h3 + h3-axum WebTransport, one
//! session per connection) serving a moq-net session on `/moq`.
//!
//! All admitted sessions publish into and subscribe from one shared
//! origin — the SFU: every uplink lands in the origin once and is fanned
//! out to every subscriber. Ticket validation happens at the paused
//! handshake (the production design gates the same point, docs/moq-sfu.md
//! §5).

use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use anyhow::Result;
use axum::{
    Router,
    extract::{Extension, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::connect,
};
use clap::Parser;
use moq_spike::{Bridge, h3wt, tls};
use tracing::{debug, info, warn};

#[derive(Parser, Debug)]
#[command(
    name = "moq-spike-server",
    about = "MoQ SFU spike over h3/quinn WebTransport"
)]
struct Args {
    /// UDP listen address (QUIC/HTTP/3 + WebTransport).
    #[arg(long, default_value = "127.0.0.1:4443")]
    listen: SocketAddr,

    /// PEM certificate chain (CN must match the client URL host).
    #[arg(long, default_value = "certs/cert.pem")]
    cert: PathBuf,

    /// PEM private key.
    #[arg(long, default_value = "certs/key.pem")]
    key: PathBuf,
}

#[derive(Clone)]
struct MoqState {
    server: moq_net::Server,
    origin: Arc<moq_net::origin::Producer>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "moq_spike=debug,info".into()),
        )
        .init();

    let args = Args::parse();

    // The SFU: one shared origin. Client uplinks are written into it by
    // their sessions; the same origin's announcements are served back to
    // every subscriber session (moq-net handles fan-out and caching).
    //
    // The default pool keeps 30 s of idle media, ~10-16 MB at the spike's
    // bitrate — that one-time fill alone exceeds the T6 soak's 10 MB RSS
    // budget. A 10 s history covers late joiners (the T7 first-frame budget
    // is 2 s) and keeps the steady-state cache at a few MB; the 16 MB byte
    // cap bounds a bursty publisher. (Tuning pass 1 for the T6 gate.)
    let mut origin_config = moq_net::origin::Config::new(moq_net::Hop::random());
    origin_config.pool = moq_net::cache::Pool::new(
        moq_net::cache::Config::default()
            .with_expiry(Duration::from_secs(10))
            .with_capacity(Some(16 * 1024 * 1024)),
    );
    let (origin, origin_driver) = moq_net::origin::Producer::new(origin_config);
    let origin = Arc::new(origin);
    tokio::spawn(async move {
        let _ = moq_net::time::run(origin_driver).await;
    });

    let (certs, key) = tls::load_cert_and_key(&args.cert, &args.key)?;
    let quinn_conf = tls::server_quinn_config(certs, key, Duration::from_secs(300))?;
    let socket = std::net::UdpSocket::bind(args.listen)?;
    let endpoint = quinn::Endpoint::new(
        quinn::EndpointConfig::default(),
        Some(quinn_conf),
        socket,
        Arc::new(quinn::TokioRuntime),
    )?;
    info!(local = %endpoint.local_addr()?, "moq-spike listening (h3 + webtransport /moq)");

    let state = MoqState {
        server: moq_net::Server::new(),
        origin,
    };

    loop {
        let Some(incoming) = endpoint.accept().await else {
            break;
        };
        let state = state.clone();
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(conn) => conn,
                Err(err) => {
                    debug!(%err, "quic handshake failed");
                    return;
                }
            };
            // Same shape as the production endpoint: the quinn connection
            // rides in as an extension for the WebTransport handler (which
            // needs it to close the connection when the session ends). The
            // upgrade is an extended CONNECT, so the route is `connect`.
            let app = Router::new()
                .route("/moq", connect(handle_moq))
                .with_state(state)
                .layer(axum::Extension(conn.clone()));
            if let Err(err) = serve_http3(app, conn).await {
                debug!(%err, "http3 connection ended");
            }
        });
    }
    Ok(())
}

/// Accept the WebTransport upgrade and hand the session to moq-net.
async fn handle_moq(
    State(state): State<MoqState>,
    Extension(conn): Extension<quinn::Connection>,
    upgrade: h3_axum::WebTransportUpgrade,
) -> Response {
    let session = match upgrade.accept().await {
        Ok(session) => session,
        Err(err) => {
            warn!(%err, "webtransport upgrade failed");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    // Kept to close the QUIC connection when the MoQ session ends.
    let quic = conn.clone();
    let session = h3wt::Session::new(session, conn);
    let bridge = Bridge::new(session);
    tokio::spawn(async move {
        let now = std::time::Instant::now();
        let handshake = match state.server.accept_request(now, bridge).await {
            Ok(handshake) => handshake,
            Err(err) => {
                warn!(%err, "moq setup failed");
                return;
            }
        };
        let path = handshake.path().to_string();
        info!(%path, "moq handshake paused (setup received)");
        // Ticket check point: the production design validates the call
        // ticket here (docs/moq-sfu.md §5). The spike admits everything.
        let origin = (*state.origin).clone();
        let result = handshake
            .with_publisher(origin.clone())
            .with_subscriber(origin)
            .ok()
            .await;
        match result {
            Ok((session, driver)) => {
                // The handle stays alive until the driver finishes: dropping
                // it aborts the session with a "dropped" close.
                let version = session.version();
                info!(?version, "moq session admitted");
                let err = moq_net::time::run(driver).await;
                drop(session);
                if !matches!(err, moq_net::Error::Closed) {
                    warn!(%err, "moq session ended");
                }
            }
            Err(err) => warn!(%err, "moq handshake rejected"),
        }
        // One session per connection: tear the QUIC connection down so the
        // h3 task and the client's endpoint see the close.
        quic.close(quinn::VarInt::from_u32(0), b"moq session ended");
    });
    StatusCode::OK.into_response()
}

/// Drive one QUIC connection as an HTTP/3 connection (same builder flags as
/// the production endpoint: WebTransport + datagrams on).
async fn serve_http3(app: Router, conn: quinn::Connection) -> Result<(), h3_axum::BoxError> {
    let mut builder = h3::server::builder();
    builder
        .enable_webtransport(true)
        .enable_extended_connect(true)
        .enable_datagram(true)
        .max_webtransport_sessions(1);
    let connection = builder.build(h3_quinn::Connection::new(conn)).await?;
    h3_axum::serve_h3_connection_with_axum(app, connection).await
}

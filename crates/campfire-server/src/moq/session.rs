//! MoQ session admission on `/moq` (docs/moq-sfu.md §5).
//!
//! One MoQ session per WebTransport connection (the endpoint allows one
//! WebTransport session per connection; the realtime `/wt` channel rides a
//! second connection). Admission is a two-part check, both at CONNECT:
//!
//! 1. the `?ticket=…` query must name a live media ticket
//!    ([`super::tickets`]), and
//! 2. the ticket's call must still be active with the ticket's user in it
//!    — a ticket outlives its call for up to its TTL, and a call can end
//!    (or a user can walk away) before the client presents it.
//!
//! Then the session is wired into the call's origin
//! ([`super::fanout`]) as both publisher and subscriber; moq-net runs the
//! session from there. Isolation between calls is structural (per-call
//! origins), so the bubble-state policy (docs/moq-sfu.md §3) needs no
//! per-subscription check.
//!
//! Known limitation: a session may announce any namespace on its call's
//! origin — a participant cannot be pinned to their own
//! `call/<room>/<user-id>` namespace (moq-net exposes no announce hook on
//! the server handshake). The blast radius is one call; the client
//! subscribes by roster id.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Query, State};
use axum::Extension;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use moq_net::stats::{Registry as StatsRegistry, Tier};
use serde::Deserialize;
use tracing::{info, warn};

use crate::metrics::Metrics;
use crate::moq::fanout::Fanout;
use crate::moq::h3wt;
use crate::moq::tickets::TicketRegistry;
use crate::world::World;

/// The stats tier label for call media (docs/moq-sfu.md §5, metrics).
const STATS_TIER: &str = "moq";

/// The SFU: moq-net server + per-call origins + the ticket store. Cheap to
/// clone (every field is an `Arc` or a refcounted moq-net handle).
#[derive(Clone)]
pub struct MoqSfu {
    server: moq_net::Server,
    fanout: Fanout,
    tickets: TicketRegistry,
    world: World,
    metrics: Metrics,
    stats: StatsRegistry,
}

impl MoqSfu {
    /// Build the SFU next to the world (docs/moq-sfu.md §5: no new socket —
    /// MoQ sessions arrive on the existing quinn endpoint via h3).
    pub fn new(world: World, metrics: Metrics) -> Arc<Self> {
        Arc::new(Self {
            server: moq_net::Server::new(),
            fanout: Fanout::new(),
            // The world mints into its own store; the SFU validates against
            // the same one (a clone shares the registry's inner `Arc`).
            tickets: world.tickets().clone(),
            world,
            metrics,
            stats: StatsRegistry::new(moq_net::stats::Config::new()),
        })
    }

    /// The hook the world calls when a call ends: drop the call's origin so
    /// its driver task and cache pool go away.
    pub fn call_end_hook(&self) -> Arc<dyn Fn(u64) + Send + Sync> {
        let fanout = self.fanout.clone();
        Arc::new(move |call_id| fanout.drop_call(call_id))
    }

    /// The world's ticket store (one registry per process).
    pub fn tickets(&self) -> &TicketRegistry {
        &self.tickets
    }

    /// Live call origins (the fan-out width gauge).
    pub fn live_origins(&self) -> u64 {
        self.fanout.live() as u64
    }

    /// Cumulative media traffic through the SFU, from the moq-net stats
    /// registry: the publisher role is what sessions publish in, the
    /// subscriber role is what sessions receive out.
    pub fn traffic(&self) -> (u64, u64, u64, u64) {
        let mut objects_in = 0u64;
        let mut bytes_in = 0u64;
        let mut objects_out = 0u64;
        let mut bytes_out = 0u64;
        for (_tier, role, traffic) in self.stats.snapshot().traffic() {
            match role {
                moq_net::stats::Role::Publisher => {
                    objects_in += traffic.frames;
                    bytes_in += traffic.bytes;
                }
                moq_net::stats::Role::Subscriber => {
                    objects_out += traffic.frames;
                    bytes_out += traffic.bytes;
                }
            }
        }
        (objects_in, bytes_in, objects_out, bytes_out)
    }
}

/// `?ticket=…` query on `/moq`.
#[derive(Deserialize)]
pub struct MoqQuery {
    pub ticket: Option<String>,
}

/// Accept the WebTransport upgrade on `/moq`, admit the session (ticket +
/// call membership), and hand it to moq-net.
pub async fn handle_moq(
    State(state): State<crate::api::AppState>,
    Extension(conn): Extension<quinn::Connection>,
    Query(query): Query<MoqQuery>,
    upgrade: h3_axum::WebTransportUpgrade,
) -> Response {
    let sfu = &state.moq;
    // 1. Ticket: unknown, missing, or expired.
    let Some(ticket) = query.ticket else {
        sfu.metrics.moq_session_reject();
        return StatusCode::FORBIDDEN.into_response();
    };
    let Some(info) = sfu.tickets.validate(&ticket) else {
        sfu.metrics.moq_session_reject();
        return StatusCode::FORBIDDEN.into_response();
    };
    // 2. Membership: the ticket's call must still exist with the ticket's
    //    user in it.
    if !sfu.world.call_active(&info.room, info.call_id, &info.user) {
        sfu.metrics.moq_session_reject();
        return StatusCode::FORBIDDEN.into_response();
    }
    let origin = sfu.fanout.origin(info.call_id);

    let session = match upgrade.accept().await {
        Ok(session) => session,
        Err(err) => {
            warn!(error = %err, "webtransport upgrade failed");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    // Kept to close the QUIC connection when the MoQ session ends (one
    // session owns the connection; the client's endpoint must see the
    // close to reconnect cleanly — same shape as the `/wt` handler).
    let quic = conn.clone();
    let bridge = moq_tokio::transport::Session::new(h3wt::Session::new(session, conn));
    // Per-session stats context, scoped to the call.
    let ctx = sfu
        .stats
        .tier(Tier::new(STATS_TIER))
        .session(format!("call/{}", info.call_id));
    let server = sfu.server.clone().with_stats(ctx);
    let metrics = sfu.metrics.clone();
    tokio::spawn(async move {
        let handshake = match server.accept_request(Instant::now(), bridge).await {
            Ok(handshake) => handshake,
            Err(err) => {
                warn!(error = %err, "moq setup failed");
                quic.close(quinn::VarInt::from_u32(0), b"moq session ended");
                return;
            }
        };
        let result = handshake
            .with_publisher(origin.clone())
            .with_subscriber(origin)
            .ok()
            .await;
        match result {
            Ok((session, driver)) => {
                let version = session.version();
                info!(?version, call = info.call_id, "moq session admitted");
                metrics.moq_session_open();
                // The handle stays alive until the driver finishes: dropping
                // it aborts the session with a "dropped" close.
                let err = moq_net::time::run(driver).await;
                drop(session);
                metrics.moq_session_close();
                if !matches!(err, moq_net::Error::Closed) {
                    warn!(%err, "moq session ended");
                }
            }
            Err(err) => warn!(%err, "moq handshake rejected"),
        }
        // One session per connection: tear the QUIC connection down so the
        // client's endpoint sees the close.
        quic.close(quinn::VarInt::from_u32(0), b"moq session ended");
    });
    StatusCode::OK.into_response()
}

//! Co-located TURN server (README §6.2).
//!
//! The relay lives in this same binary behind the same port number (443/TCP
//! in production): `turns:host?transport=tcp` is indistinguishable from
//! ordinary HTTPS to a firewall, which is exactly what locked-down networks
//! need as the last-resort media path. The TLS for it terminates at the
//! public TCP front (`crate::bootstrap`, which also serves the HTTP/3
//! Alt-Svc bootstrap); TURN itself binds a *plaintext* loopback listener that
//! the front splices recognized STUN/TURN streams to. It is started as a
//! background task and never blocks the app — if it fails, the service still
//! works; only relayed calls on hostile networks degrade.
//!
//! Authentication is native TURN REST (RFC 8489): the server is given the
//! shared `secret` (our `--turn-secret`), and the handler verifies
//! `credential = base64(HMAC-SHA1(secret, username))` against the
//! long-term username the browser sends. Our credential endpoint
//! (`POST /api/v1/turn/credential`) mints exactly that pair.

use std::net::SocketAddr;

use tracing::{debug, error};
use turn_server::config::{Auth, Config, Interface, Log, Server};

/// Spawn the TURN server. `secret` is the shared TURN REST secret that
/// must match what [`crate::api::AppState`] mints credentials with.
/// `internal` is the plaintext loopback TCP listener the TLS front
/// ([`crate::bootstrap`]) splices STUN/TURN streams to.
pub fn start(cfg: &crate::config::Config, secret: &str, internal: SocketAddr) {
    // turn-server builds its TLS config via `ServerConfig::builder()`,
    // which resolves rustls' *global default* crypto provider.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let turn_cfg = Config {
        server: Server {
            // Ephemeral relay ports: the default ephemeral range.
            port_range: Default::default(),
            max_threads: 4,
            realm: "campfire".to_owned(),
            interfaces: vec![Interface::Tcp {
                // Plaintext loopback: TLS terminates at the public TLS front.
                listen: internal,
                external: cfg.external_addr(),
                idle_timeout: 60,
                ssl: None,
            }],
        },
        // Our own tracing stack owns the log output.
        log: Log {
            stdout: false,
            ..Default::default()
        },
        auth: Auth {
            static_auth_secret: Some(secret.to_owned()),
            ..Default::default()
        },
        ..Default::default()
    };
    debug!(
        listen = %cfg.listen,
        external = %cfg.external_addr(),
        "starting TURN server (TLS/TCP, TURN REST)"
    );
    tokio::spawn(async move {
        if let Err(err) = turn_server::start_server(turn_cfg).await {
            error!(%err, "TURN server stopped; relay calls will fail until restart");
        }
    });
}

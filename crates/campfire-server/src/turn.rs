//! Co-located TURN server (README §6.2).
//!
//! The relay lives in this same binary on the same port number (443/TCP in
//! production): `turns:host?transport=tcp` is indistinguishable from
//! ordinary HTTPS to a firewall, which is exactly what locked-down
//! networks need as the last-resort media path. It is started as a
//! background task and never blocks the app — if it fails, the service
//! still works; only relayed calls on hostile networks degrade.
//!
//! Authentication is native TURN REST (RFC 8489): the server is given the
//! shared `secret` (our `--turn-secret`), and the handler verifies
//! `credential = base64(HMAC-SHA1(secret, username))` against the
//! long-term username the browser sends. Our credential endpoint
//! (`POST /api/v1/turn/credential`) mints exactly that pair.

use tracing::{debug, error};
use turn_server::config::{Auth, Config, Interface, Log, Server, Ssl};

/// Spawn the TURN server. `secret` is the shared TURN REST secret that
/// must match what [`crate::api::AppState`] mints credentials with.
pub fn start(cfg: &crate::config::Config, secret: &str) {
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
                listen: cfg.listen,
                external: cfg.external_addr(),
                idle_timeout: 60,
                ssl: Some(Ssl {
                    private_key: cfg.key.to_string_lossy().into_owned(),
                    certificate_chain: cfg.cert.to_string_lossy().into_owned(),
                }),
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

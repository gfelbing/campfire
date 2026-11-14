//! campfire — the single Campfire service binary.
//!
//! One binary, one port number (docs/arch/decisions.md): QUIC/HTTP/3 + WebTransport + MoQ
//! media on UDP/443, the Alt-Svc TLS front on TCP/443. This file only boots
//! the library; all behaviour lives in `campfire_server` (lib.rs) so tests
//! and tooling can reuse it.

use anyhow::Result;
use campfire_server::config::Config;
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    let cfg = Config::parse();
    // Structured JSON logs (docs/ops/README.md) or the human default; the
    // filter always comes from RUST_LOG (default: info for this crate).
    let subscriber = tracing_subscriber::fmt().with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "campfire_server=info".into()),
    );
    if cfg.log_json {
        subscriber.json().init();
    } else {
        subscriber.init();
    }

    campfire_server::api::mark_start();
    campfire_server::run(&cfg).await
}

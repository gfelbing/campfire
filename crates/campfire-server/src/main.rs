//! campfire — the single Campfire service binary.
//!
//! One binary, one port number (README §2): QUIC/HTTP/3 + WebTransport + STUN
//! on UDP, TURN/TLS on TCP. This file only boots the library; all behaviour
//! lives in `campfire_server` (lib.rs) so tests and tooling can reuse it.

use anyhow::Result;
use campfire_server::config::Config;
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "campfire_server=info".into()),
        )
        .init();

    campfire_server::api::mark_start();
    let cfg = Config::parse();
    campfire_server::run(&cfg).await
}

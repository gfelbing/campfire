//! CLI configuration for the campfire binary.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use clap::Parser;

/// Campfire: virtual-office-style virtual office.
/// One binary, one port (UDP), HTTP/3 + WebTransport.
#[derive(Parser, Debug, Clone)]
#[command(version, about)]
pub struct Config {
    /// UDP address to bind the QUIC/HTTP/3 socket to.
    #[arg(long, default_value = "127.0.0.1:8443")]
    pub listen: SocketAddr,

    /// TLS certificate chain (PEM).
    #[arg(long)]
    pub cert: PathBuf,

    /// TLS private key (PEM: PKCS#8, PKCS#1 or SEC1).
    #[arg(long)]
    pub key: PathBuf,

    /// QUIC idle timeout in seconds.
    #[arg(long, default_value_t = 300)]
    pub idle_timeout_secs: u64,

    /// Serve the web client from this directory at runtime instead of the
    /// compile-time embed (dev loop: `vite build --watch` + server).
    #[arg(long)]
    pub static_dir: Option<PathBuf>,

    /// TURN REST shared secret (README §6.2). Clients fetch per-user
    /// credentials from `POST /api/v1/turn/credential`. When omitted, a
    /// random secret is generated at startup (logged once) — relay
    /// credentials then reset on every restart.
    #[arg(long)]
    pub turn_secret: Option<String>,

    /// Emit structured JSON logs (one object per line) instead of the
    /// human-readable default — for log shippers (README §11 Phase 8).
    #[arg(long)]
    pub log_json: bool,

    /// Externally visible address of this server, advertised by the TURN
    /// server for relayed allocations. Defaults to `listen` (correct for
    /// dev; set behind a NAT/firewall).
    #[arg(long)]
    pub external: Option<SocketAddr>,
}

impl Config {
    pub fn idle_timeout(&self) -> Duration {
        Duration::from_secs(self.idle_timeout_secs)
    }

    /// Address to advertise to peers (`--external` or `listen`).
    pub fn external_addr(&self) -> SocketAddr {
        self.external.unwrap_or(self.listen)
    }
}

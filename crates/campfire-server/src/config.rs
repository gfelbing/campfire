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
}

impl Config {
    pub fn idle_timeout(&self) -> Duration {
        Duration::from_secs(self.idle_timeout_secs)
    }
}

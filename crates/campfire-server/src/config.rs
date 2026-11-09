//! CLI configuration for the campfire binary.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use clap::Parser;

/// Campfire: virtual office.
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

    /// Maps directory: each direct subdirectory is a map (its own Tiled
    /// file plus tilesets). Mounted externally in deployment; dev defaults
    /// to the local `maps/` folder.
    #[arg(long, default_value = "maps")]
    pub maps_dir: PathBuf,

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
    /// dev; set behind a NAT/firewall). Accepts `ip:port` or a bare `ip`
    /// (the port then falls back to `--listen`'s).
    #[arg(long, value_parser = parse_external)]
    pub external: Option<SocketAddr>,
}

/// `--external` accepts `ip:port` or a bare `ip`. A bare IP is stored with
/// port 0 — [`Config::external_addr`] fills it in from `--listen`, since the
/// port is known only after all args are parsed.
fn parse_external(s: &str) -> Result<SocketAddr, String> {
    if let Ok(addr) = s.parse::<SocketAddr>() {
        return Ok(addr);
    }
    let ip: IpAddr = s
        .parse()
        .map_err(|_| format!("invalid socket address or IP: {s:?}"))?;
    Ok(SocketAddr::new(ip, 0))
}

impl Config {
    pub fn idle_timeout(&self) -> Duration {
        Duration::from_secs(self.idle_timeout_secs)
    }

    /// Address to advertise to peers (`--external` or `listen`). A bare-IP
    /// `--external` (parsed as port 0) inherits `--listen`'s port.
    pub fn external_addr(&self) -> SocketAddr {
        match self.external {
            Some(addr) if addr.port() == 0 => SocketAddr::new(addr.ip(), self.listen.port()),
            Some(addr) => addr,
            None => self.listen,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(listen: &str, external: Option<&str>) -> Config {
        let mut c = Config::parse_from([
            "campfire",
            "--listen",
            listen,
            "--cert",
            "certs/cert.pem",
            "--key",
            "certs/key.pem",
        ]);
        c.external = external.map(parse_external).transpose().unwrap();
        c
    }

    #[test]
    fn external_defaults_to_listen() {
        let c = cfg("127.0.0.1:8443", None);
        assert_eq!(c.external_addr().to_string(), "127.0.0.1:8443");
    }

    #[test]
    fn external_bare_ip_inherits_listen_port() {
        let c = cfg("0.0.0.0:443", Some("192.168.178.200"));
        assert_eq!(c.external_addr().to_string(), "192.168.178.200:443");
        // a different listen port carries over too
        let c = cfg("0.0.0.0:8443", Some("203.0.113.7"));
        assert_eq!(c.external_addr().to_string(), "203.0.113.7:8443");
    }

    #[test]
    fn external_full_socket_addr_wins() {
        let c = cfg("0.0.0.0:443", Some("203.0.113.7:8443"));
        assert_eq!(c.external_addr().to_string(), "203.0.113.7:8443");
    }

    #[test]
    fn external_rejects_garbage() {
        assert!(parse_external("campfire.example.com").is_err());
        assert!(parse_external("192.168.178.200:99999").is_err());
    }
}

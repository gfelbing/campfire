//! TLS + QUIC configuration (rustls → quinn).
//!
//! Crypto provider: ring (quinn's default). If a future feature prefers
//! aws-lc-rs as the global default, this file is the single place to
//! switch (README §10 Q5).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};

/// Build a plain rustls server config (TLS 1.3, ring provider) with the
/// given ALPN list. quinn consumes it via [`quinn::crypto::rustls::
/// QuicServerConfig`]; the TCP TLS front (`bootstrap`) uses it directly.
pub fn rustls_server_config(
    certs: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
    alpn: Vec<Vec<u8>>,
) -> Result<rustls::ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut rustls_conf = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    rustls_conf.alpn_protocols = alpn;
    Ok(rustls_conf)
}

/// Build the quinn server config from already-loaded TLS material.
///
/// Exposed (and used by the integration tests) so tests can hand in
/// rcgen-generated certificates instead of files on disk.
///
/// quinn 0.11 reads ALPN from the rustls config, so `h3` is advertised on the
/// rustls side. The WebTransport protocol id joins the list in Phase 2.
pub fn server_config(
    certs: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
    idle_timeout: Duration,
) -> Result<quinn::ServerConfig> {
    let rustls_conf = rustls_server_config(certs, key, vec![b"h3".to_vec()])?;

    let crypto = quinn::crypto::rustls::QuicServerConfig::try_from(rustls_conf)
        .with_context(|| "building QUIC-compatible crypto config")?;
    let mut config = quinn::ServerConfig::with_crypto(Arc::new(crypto));
    let mut transport = quinn::TransportConfig::default();
    transport.max_idle_timeout(Some(
        quinn::IdleTimeout::try_from(idle_timeout)
            .with_context(|| format!("idle timeout {idle_timeout:?} exceeds QUIC varint limit"))?,
    ));
    config.transport = Arc::new(transport);
    Ok(config)
}

/// Load PEM certificate + key from disk and build the quinn server config.
pub fn server_config_from_files(
    cert: &Path,
    key: &Path,
    idle_timeout: Duration,
) -> Result<quinn::ServerConfig> {
    let (certs, key) = load_pem(cert, key)?;
    server_config(certs, key, idle_timeout)
}

pub(crate) fn load_pem(
    cert: &Path,
    key: &Path,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
    // Small, read-once startup files: blocking IO is fine here.
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert)
        .with_context(|| format!("opening cert file {}", cert.display()))?
        .collect::<Result<_, _>>()
        .with_context(|| format!("parsing cert file {}", cert.display()))?;
    if certs.is_empty() {
        anyhow::bail!("no certificates found in {}", cert.display());
    }

    let key = PrivateKeyDer::from_pem_file(key)
        .with_context(|| format!("parsing key file {}", key.display()))?;

    Ok((certs, key))
}

//! TLS material for the spike: the repo's `certs/` (CN=localhost, SAN
//! localhost/127.0.0.1/::1) on both sides, ring provider like the app.

use std::{
    path::Path,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};

/// Load the PEM certificate chain and private key from disk.
pub fn load_cert_and_key(
    cert: &Path,
    key: &Path,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
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

/// Quinn server config advertising `h3` (WebTransport over HTTP/3).
pub fn server_quinn_config(
    certs: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
    idle_timeout: Duration,
) -> Result<quinn::ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let rustls_conf = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;
    let mut rustls_conf = rustls_conf;
    rustls_conf.alpn_protocols = vec![b"h3".to_vec()];

    let crypto = quinn::crypto::rustls::QuicServerConfig::try_from(rustls_conf)
        .with_context(|| "building QUIC-compatible crypto config")?;
    let mut config = quinn::ServerConfig::with_crypto(Arc::new(crypto));
    let mut transport = media_transport_config();
    transport.max_idle_timeout(Some(
        quinn::IdleTimeout::try_from(idle_timeout)
            .with_context(|| format!("idle timeout {idle_timeout:?} exceeds QUIC varint limit"))?,
    ));
    config.transport = Arc::new(transport);
    Ok(config)
}

/// Quinn transport config for the media paths. The default per-stream
/// receive window (1.25 MB, sized for 100 ms RTT) throttles group-stream
/// throughput to roughly window/RTT once h3's userspace buffering sits
/// behind it; under the spike's 100 ms-delay netem scenarios the subscriber
/// fell behind and the SFU's cache evicted undelivered groups. 8 MB per
/// stream keeps the window comfortably ahead of the BDP at WAN RTTs
/// (docs/moq-sfu.md Phase 0, loss/jitter findings).
pub fn media_transport_config() -> quinn::TransportConfig {
    let mut transport = quinn::TransportConfig::default();
    transport.stream_receive_window(quinn::VarInt::from_u32(8 * 1024 * 1024));
    transport.receive_window(quinn::VarInt::from_u32(16 * 1024 * 1024));
    // Loss detection must tolerate reordering: the default packet threshold
    // (3) declares in-flight packets lost as soon as 3 newer packets are
    // acknowledged, which the jitter scenarios trigger constantly (100+30 ms
    // one-way delay reorders up to ~50 packets). 1000 disables the
    // packet-count trigger; retransmission is driven by the time threshold.
    // The time threshold is a factor of the conservative RTT: 0.7
    // retransmits a truly lost packet in ~150-250 ms at the scenario RTTs.
    // A spurious time-trigger under jitter is harmless with the
    // bandwidth-based controller (below) - the receiver dedupes the
    // retransmission - so the threshold trades a little extra retransmit
    // load for a shorter loss tail, which the T5 20 %-loss audio-p95 gate
    // needs (docs/moq-sfu.md Phase 0, loss-detection finding).
    transport.packet_threshold(1000);
    transport.time_threshold(0.7);
    // Bandwidth-based congestion controller instead of the default CUBIC:
    // netem's `loss random` is independent per-packet loss, not congestion,
    // but every declared loss is a congestion event - at 5 % loss CUBIC
    // halves its window ~13 times per second and pins it at the floor,
    // starving the media path (measured: 99/1500 audio groups delivered).
    // Quinn's BBR is also unusable here: it sizes the window from a BDP
    // computed with min_rtt, which the 100+30 ms jitter distorts to a few
    // tens of ms, capping the rate below the 316 KB/s media path.
    // `MediaCc` (src/cc.rs) tracks the window at max(floor, 3 x BDP) from
    // the smoothed RTT and ignores isolated loss events.
    transport.congestion_controller_factory(Arc::new(crate::cc::MediaCcConfig));
    // Quinn's default per-stream send fairness round-robins chunks of all
    // pending streams, one chunk per stream per packet, requeueing a stream
    // with more data at the tail. The SFU serves a burst of group streams at
    // once (jittery uplink fills the origin cache, the serve loop drains it),
    // so with fairness on a 12 KB video group's 11 chunks spread across the
    // whole burst drain - measured up to ~5 s at 100+30 ms one-way delay -
    // which blows the subscriber's max-age drift budget. Off, a stream's
    // chunks go back-to-back and the per-group spread is ~11 packet times.
    // (docs/moq-sfu.md Phase 0, burst spread finding.)
    transport.send_fairness(false);
    transport
}

/// Rustls client config trusting the spike CA, advertising `h3`.
pub fn client_rustls_config(ca: &Path) -> Result<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let ca_certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(ca)
        .with_context(|| format!("opening CA file {}", ca.display()))?
        .collect::<Result<_, _>>()
        .with_context(|| format!("parsing CA file {}", ca.display()))?;
    if ca_certs.is_empty() {
        anyhow::bail!("no certificates found in {}", ca.display());
    }
    let mut roots = rustls::RootCertStore::empty();
    for cert in ca_certs {
        roots
            .add(cert)
            .with_context(|| format!("adding CA cert from {}", ca.display()))?;
    }
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h3".to_vec()];
    Ok(config)
}

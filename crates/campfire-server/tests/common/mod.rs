//! Shared test helpers: dev certs + a real server on an ephemeral port.

use std::net::SocketAddr;
use std::time::Duration;

use rustls::pki_types::{CertificateDer, PrivateKeyDer};

/// Self-signed cert for `localhost` + the matching root for client verification.
pub fn dev_certs() -> (
    Vec<CertificateDer<'static>>,
    PrivateKeyDer<'static>,
    CertificateDer<'static>,
) {
    let key_pair = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["localhost".into()])
        .unwrap()
        .self_signed(&key_pair)
        .unwrap();
    (
        vec![cert.der().to_vec().into()],
        PrivateKeyDer::Pkcs8(key_pair.serialize_der().into()),
        cert.der().to_vec().into(),
    )
}

/// Start the real server (quinn endpoint + accept loop) on an ephemeral port.
pub async fn start_server() -> (SocketAddr, CertificateDer<'static>) {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::level_filters::LevelFilter::INFO)
        .without_time()
        .try_init();
    let (certs, key, root) = dev_certs();
    let conf = campfire_server::tls::server_config(certs, key, Duration::from_secs(30)).unwrap();
    let endpoint = quinn::Endpoint::server(conf, "127.0.0.1:0".parse().unwrap()).unwrap();
    let addr = endpoint.local_addr().unwrap();
    let world = campfire_server::world::World::new();
    let app = campfire_server::api::router(world);
    tokio::spawn(campfire_server::run_endpoint(endpoint, app));
    (addr, root)
}

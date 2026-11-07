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

/// Start the real server (demux socket + quinn endpoint + accept loop) on
/// an ephemeral port. STUN binding requests on the same UDP port are
/// answered by the server's demux, exactly like in production.
pub async fn start_server() -> (SocketAddr, CertificateDer<'static>) {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::level_filters::LevelFilter::INFO)
        .without_time()
        .try_init();
    let (certs, key, root) = dev_certs();
    let conf = campfire_server::tls::server_config(certs, key, Duration::from_secs(30)).unwrap();
    let socket = campfire_server::demux::DemuxSocket::bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let addr = socket.local_addr().unwrap();
    let endpoint = campfire_server::make_endpoint(conf, socket).unwrap();
    let world = campfire_server::world::World::new();
    let _tick = campfire_server::world::start_ticking(world.clone());
    let state = campfire_server::api::AppState {
        world,
        static_dir: None,
        turn_secret: "test-turn-secret".to_owned(),
        turn_rate: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        metrics: campfire_server::metrics::Metrics::new(),
    };
    let app = campfire_server::api::router(state);
    tokio::spawn(campfire_server::run_endpoint(endpoint, app));
    (addr, root)
}

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
/// an ephemeral port.
#[allow(dead_code)]
pub async fn start_server() -> (SocketAddr, CertificateDer<'static>) {
    let (addr, root, _world) = start_server_with_world().await;
    (addr, root)
}

/// [`start_server`], but also returns the `World` the server ticks on, so
/// a test can drive world state directly (e.g. `set_bubble` to pull an
/// outsider into a call without racing the proximity engine).
pub async fn start_server_with_world() -> (
    SocketAddr,
    CertificateDer<'static>,
    campfire_server::world::World,
) {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .without_time()
        .try_init();
    let (certs, key, root) = dev_certs();
    let conf = campfire_server::tls::server_config(certs, key, Duration::from_secs(30)).unwrap();
    let socket = campfire_server::demux::DemuxSocket::bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let addr = socket.local_addr().unwrap();
    let endpoint = campfire_server::make_endpoint(conf, socket).unwrap();
    let metrics = campfire_server::metrics::Metrics::new();
    let world = campfire_server::world::World::new(campfire_maps::Maps::load(
        std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../maps")),
    ));
    // Wire the MoQ SFU exactly as production does: share the world's ticket
    // store, and let the world's call-end hook reap the SFU's media origins
    // (docs/moq-sfu.md §5).
    let moq = campfire_server::moq::MoqSfu::new(world.clone(), metrics.clone());
    let world = world.on_call_end(moq.call_end_hook());
    let _tick = campfire_server::world::start_ticking_with(world.clone(), metrics.clone());
    let state = campfire_server::api::AppState {
        world: world.clone(),
        static_dir: None,
        metrics: metrics.clone(),
        moq,
        auth: None,
        fallback: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
    };
    let app = campfire_server::api::router(state);
    tokio::spawn(campfire_server::run_endpoint_with_metrics(
        endpoint, app, metrics,
    ));
    (addr, root, world)
}

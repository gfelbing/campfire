//! Phase 1 acceptance test (README §11):
//!
//! > `curl --http3 https://localhost:8443/healthz` returns 200; a browser
//! > loads the page over HTTP/3.
//!
//! Performed here in-process over **real QUIC/HTTP/3** on an ephemeral UDP
//! port with an rcgen-generated self-signed certificate — no external tools
//! needed, so it runs on CI.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use bytes::Buf;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};

/// Self-signed cert for `localhost` + the matching root for client verification.
fn dev_certs() -> (
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
async fn start_server() -> (SocketAddr, CertificateDer<'static>) {
    let (certs, key, root) = dev_certs();
    let conf = campfire_server::tls::server_config(certs, key, Duration::from_secs(30)).unwrap();
    let endpoint = quinn::Endpoint::server(conf, "127.0.0.1:0".parse().unwrap()).unwrap();
    let addr = endpoint.local_addr().unwrap();
    let app = campfire_server::api::router();
    tokio::spawn(campfire_server::run_endpoint(endpoint, app));
    (addr, root)
}

/// One HTTP/3 GET against the server, verified against the rcgen root.
async fn get(addr: SocketAddr, root: &CertificateDer<'static>, uri: &str) -> (u16, String) {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(root.clone()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut client_conf = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_root_certificates(Arc::new(roots))
        .with_no_client_auth();
    client_conf.alpn_protocols = vec![b"h3".to_vec()];

    let crypto = quinn::crypto::rustls::QuicClientConfig::try_from(client_conf).unwrap();
    let qconf = quinn::ClientConfig::new(Arc::new(crypto));
    let mut endpoint = quinn::Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
    endpoint.set_default_client_config(qconf);

    let conn = endpoint.connect(addr, "localhost").unwrap().await.unwrap();
    let (h3_conn, mut send_req) = h3::client::builder()
        .build::<_, _, bytes::Bytes>(h3_quinn::Connection::new(conn))
        .await
        .unwrap();
    let mut res = send_req
        .send_request(
            http::Request::builder()
                .uri(format!("https://localhost{uri}"))
                .body(())
                .unwrap(),
        )
        .await
        .unwrap();
    res.finish().await.unwrap(); // no request body
    let response = res.recv_response().await.unwrap();
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = res.recv_data().await.unwrap() {
        body.extend_from_slice(chunk.chunk());
    }
    drop(h3_conn); // keep the connection alive while the body is read
    (status, String::from_utf8_lossy(&body).into_owned())
}

#[tokio::test]
async fn http3_healthz_index_and_maps() {
    campfire_server::api::mark_start();
    let (addr, root) = start_server().await;

    // /healthz — the Phase 1 acceptance check.
    let (status, body) = get(addr, &root, "/healthz").await;
    assert_eq!(status, 200, "healthz body: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["status"], "ok");

    // / — embedded static index over HTTP/3.
    let (status, body) = get(addr, &root, "/").await;
    assert_eq!(status, 200);
    assert!(body.contains("Campfire"));

    // /api/v1/maps — empty until Phase 3 ships the first maps.
    let (status, body) = get(addr, &root, "/api/v1/maps").await;
    assert_eq!(status, 200);
    assert_eq!(body, "[]");

    // Unknown path → 404.
    let (status, _) = get(addr, &root, "/nope").await;
    assert_eq!(status, 404);
}

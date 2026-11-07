//! Phase 5 acceptance tests (README §11): 1:1 call signaling over QUIC,
//! the STUN responder on the shared UDP port, and TURN REST credentials.
//!
//! The WebRTC media path (`getUserMedia`, `RTCPeerConnection`) is
//! browser-only, so browser-level acceptance (two windows talking and
//! seeing each other) is a manual check. Everything the *server* does for
//! calls — signaling relay, validation, call state machine, STUN binding,
//! credential minting — runs here over **real HTTP/3 on QUIC** against the
//! real server stack with `wtransport` as the client.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::{Buf, Bytes};
use campfire_protocol::{
    ClientMsg, ErrorCode, MAX_CANDIDATE_BYTES, MAX_SDP_BYTES, ServerMsg, to_line,
};
use campfire_server::stun;
use rustls::pki_types::CertificateDer;
use tokio::io::AsyncWriteExt;
use wtransport::Connection;

mod common;
use common::start_server;

/// Cap on any single wait, so a broken server fails the test instead of
/// hanging it.
const RECV_TIMEOUT: Duration = Duration::from_secs(5);
/// Matches the secret in `tests/common/mod.rs` (per-server-instance state,
/// so parallel tests do not interfere).
const TURN_SECRET: &str = "test-turn-secret";

/// A connected WebTransport client with its command stream open (same
/// shape as `tests/wt.rs` — each test binary is standalone).
struct TestClient {
    /// Held so the QUIC connection stays open (no datagrams in these tests).
    _conn: Connection,
    send: wtransport::SendStream,
    recv: wtransport::RecvStream,
}

impl TestClient {
    async fn connect(addr: SocketAddr) -> Self {
        let config = wtransport::ClientConfig::builder()
            .with_bind_address("127.0.0.1:0".parse().unwrap())
            .with_no_cert_validation()
            .build();
        let conn = wtransport::Endpoint::client(config)
            .unwrap()
            .connect(format!("https://{addr}/wt"))
            .await
            .unwrap();
        let (send, recv) = conn.open_bi().await.unwrap().await.unwrap();
        Self {
            _conn: conn,
            send,
            recv,
        }
    }

    async fn send(&mut self, msg: &ClientMsg) {
        self.send.write_all(to_line(msg).as_bytes()).await.unwrap();
        self.send.flush().await.unwrap();
    }

    /// Read exactly one NDJSON line and decode it.
    async fn recv(&mut self) -> ServerMsg {
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            tokio::time::timeout(RECV_TIMEOUT, self.recv.read_exact(&mut byte))
                .await
                .expect("timed out waiting for a server message")
                .unwrap();
            if byte[0] == b'\n' {
                break;
            }
            buf.push(byte[0]);
        }
        let line = std::str::from_utf8(&buf).unwrap();
        campfire_protocol::from_line(line).unwrap()
    }
}

/// Connect + join in one step, returning (client, own id).
async fn join(addr: SocketAddr, room: &str, name: &str) -> (TestClient, String) {
    let mut c = TestClient::connect(addr).await;
    c.send(&ClientMsg::Join {
        room: room.into(),
        name: name.into(),
        avatar: None,
    })
    .await;
    let ServerMsg::Hello { you, .. } = c.recv().await else {
        panic!("expected hello after join");
    };
    (c, you)
}

/// One HTTP/3 request against the server (any method, optional body).
async fn http3(
    addr: SocketAddr,
    root: &CertificateDer<'static>,
    method: &str,
    uri: &str,
    body: Option<Bytes>,
) -> (u16, String) {
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

    let body = body.unwrap_or_default();
    let mut builder = http::Request::builder()
        .method(method)
        .uri(format!("https://localhost{uri}"));
    if method == "POST" {
        builder = builder.header("content-type", "application/json");
    }
    // h3 0.0.8: the request body travels via `send_data`, not the
    // `Request`'s (discarded) body slot.
    let request = builder.body(()).unwrap();
    let mut res = send_req.send_request(request).await.unwrap();
    if !body.is_empty() {
        res.send_data(body).await.unwrap();
    }
    res.finish().await.unwrap();
    let response = res.recv_response().await.unwrap();
    let status = response.status().as_u16();
    let mut out = Vec::new();
    while let Some(chunk) = res.recv_data().await.unwrap() {
        out.extend_from_slice(chunk.chunk());
    }
    drop(h3_conn);
    (status, String::from_utf8_lossy(&out).into_owned())
}

#[tokio::test]
async fn call_signaling_roundtrip_over_quic() {
    let (addr, _root) = start_server().await;

    let (mut a, a_id) = join(addr, "office", "alice").await;
    let (mut b, b_id) = join(addr, "office", "bob").await;
    let ServerMsg::Joined { user } = a.recv().await else {
        panic!("expected alice to hear bob join");
    };
    assert_eq!(user.id, b_id);

    // Alice rings Bob: only Bob hears the ring, with Alice's name.
    a.send(&ClientMsg::CallRing { to: b_id.clone() }).await;
    match b.recv().await {
        ServerMsg::CallRing { from, name } => {
            assert_eq!(from, a_id);
            assert_eq!(name, "alice");
        }
        m => panic!("expected call_ring, got {m:?}"),
    }

    // Bob accepts: both sides hear the call start with the full roster.
    b.send(&ClientMsg::CallAccept { to: a_id.clone() }).await;
    let ServerMsg::CallStart { room, participants } = a.recv().await else {
        panic!("expected call_start for alice");
    };
    assert_eq!(room, "office");
    assert_eq!(participants.len(), 2);
    let ids: Vec<&str> = participants.iter().map(|u| u.id.as_str()).collect();
    assert!(ids.contains(&a_id.as_str()));
    assert!(ids.contains(&b_id.as_str()));
    let ServerMsg::CallStart { .. } = b.recv().await else {
        panic!("expected call_start for bob");
    };

    // SDP roundtrip: the caller offers, the callee answers (README §7).
    a.send(&ClientMsg::CallOffer {
        to: b_id.clone(),
        sdp: "v=0\r\no=alice".into(),
    })
    .await;
    match b.recv().await {
        ServerMsg::CallOffer { from, sdp } => {
            assert_eq!(from, a_id);
            assert_eq!(sdp, "v=0\r\no=alice");
        }
        m => panic!("expected call_offer, got {m:?}"),
    }
    b.send(&ClientMsg::CallAnswer {
        to: a_id.clone(),
        sdp: "v=0\r\no=bob".into(),
    })
    .await;
    match a.recv().await {
        ServerMsg::CallAnswer { from, sdp } => {
            assert_eq!(from, b_id);
            assert_eq!(sdp, "v=0\r\no=bob");
        }
        m => panic!("expected call_answer, got {m:?}"),
    }

    // ICE candidates relay both ways; the wire field is the JSON-encoded
    // RTCIceCandidateInit the client produced.
    let alice_cand = r#"{"candidate":"candidate:1 1 udp 2130706431 192.168.1.2 54321 typ host","sdpMid":"0","sdpMLineIndex":0}"#;
    a.send(&ClientMsg::CallIce {
        to: b_id.clone(),
        candidate: alice_cand.into(),
    })
    .await;
    match b.recv().await {
        ServerMsg::CallIce { from, candidate } => {
            assert_eq!(from, a_id);
            assert_eq!(candidate, alice_cand);
        }
        m => panic!("expected call_ice, got {m:?}"),
    }
    let bob_cand = r#"{"candidate":"candidate:2 1 udp 1694498815 10.0.0.7 50000 typ host","sdpMid":"0","sdpMLineIndex":0}"#;
    b.send(&ClientMsg::CallIce {
        to: a_id.clone(),
        candidate: bob_cand.into(),
    })
    .await;
    match a.recv().await {
        ServerMsg::CallIce { from, candidate } => {
            assert_eq!(from, b_id);
            assert_eq!(candidate, bob_cand);
        }
        m => panic!("expected call_ice, got {m:?}"),
    }

    // Mute is presence: broadcast to the other participant only — Alice
    // must NOT receive her own state change.
    a.send(&ClientMsg::CallMute {
        audio: false,
        video: true,
    })
    .await;
    match b.recv().await {
        ServerMsg::CallMute { id, audio, video } => {
            assert_eq!(id, a_id);
            assert!(!audio);
            assert!(video);
        }
        m => panic!("expected call_mute, got {m:?}"),
    }

    // Bob hangs up: in a 1:1 that ends the call for Alice.
    b.send(&ClientMsg::CallLeave).await;
    match a.recv().await {
        ServerMsg::CallEnd { reason } => assert_eq!(reason, "last_left"),
        m => panic!("expected call_end (last_left), got {m:?}"),
    }
}

#[tokio::test]
async fn call_validation_and_state_errors() {
    let (addr, _root) = start_server().await;

    let (mut a, a_id) = join(addr, "office", "alice").await;
    let (mut b, b_id) = join(addr, "office", "bob").await;
    let (mut c, _c_id) = join(addr, "office", "carol").await;
    // Presence noise: one `joined` per later joiner, per earlier joiner.
    let ServerMsg::Joined { .. } = a.recv().await else {
        panic!("expected joined");
    };
    let ServerMsg::Joined { .. } = b.recv().await else {
        panic!("expected joined");
    };
    let ServerMsg::Joined { .. } = a.recv().await else {
        panic!("expected joined");
    };

    // You cannot ring yourself.
    a.send(&ClientMsg::CallRing { to: a_id.clone() }).await;
    assert_err(&mut a, ErrorCode::CallNotAllowed).await;

    // Alice rings Bob.
    a.send(&ClientMsg::CallRing { to: b_id.clone() }).await;
    let ServerMsg::CallRing { from, .. } = b.recv().await else {
        panic!("expected call_ring");
    };
    assert_eq!(from, a_id);

    // One call per room: Carol cannot start her own while one is in flight.
    c.send(&ClientMsg::CallRing { to: a_id.clone() }).await;
    assert_err(&mut c, ErrorCode::CallNotAllowed).await;

    // Bob accepts; both sides get the roster.
    b.send(&ClientMsg::CallAccept { to: a_id.clone() }).await;
    let ServerMsg::CallStart { .. } = a.recv().await else {
        panic!("expected call_start");
    };
    let ServerMsg::CallStart { .. } = b.recv().await else {
        panic!("expected call_start");
    };

    // Carol is not in the call and cannot relay through it.
    c.send(&ClientMsg::CallOffer {
        to: a_id.clone(),
        sdp: "v=0".into(),
    })
    .await;
    assert_err(&mut c, ErrorCode::CallNotAllowed).await;

    // Size caps (checked before participation, README §5).
    a.send(&ClientMsg::CallOffer {
        to: b_id.clone(),
        sdp: "x".repeat(MAX_SDP_BYTES + 1),
    })
    .await;
    assert_err(&mut a, ErrorCode::SdpTooLong).await;
    a.send(&ClientMsg::CallIce {
        to: b_id.clone(),
        candidate: "x".repeat(MAX_CANDIDATE_BYTES + 1),
    })
    .await;
    assert_err(&mut a, ErrorCode::CandidateTooLong).await;

    // A valid offer still relays after the rejected ones.
    a.send(&ClientMsg::CallOffer {
        to: b_id.clone(),
        sdp: "v=0\r\no=alice".into(),
    })
    .await;
    match b.recv().await {
        ServerMsg::CallOffer { from, .. } => assert_eq!(from, a_id),
        m => panic!("expected call_offer, got {m:?}"),
    }

    // Bob leaves: the 1:1 ends for Alice.
    b.send(&ClientMsg::CallLeave).await;
    match a.recv().await {
        ServerMsg::CallEnd { reason } => assert_eq!(reason, "last_left"),
        m => panic!("expected call_end, got {m:?}"),
    }
}

/// Assert the client's next message is `Error { code }`.
async fn assert_err(c: &mut TestClient, code: ErrorCode) {
    match c.recv().await {
        ServerMsg::Error { code: got } => assert_eq!(got, code),
        m => panic!("expected error {code:?}, got {m:?}"),
    }
}

#[tokio::test]
async fn stun_binding_answered_on_shared_udp_port() {
    let (addr, _root) = start_server().await;

    // Raw UDP: a 20-byte STUN Binding request straight to the QUIC port —
    // the demux must route it to the STUN responder, not to quinn.
    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let client_addr = sock.local_addr().unwrap();
    let txn: [u8; 12] = [
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
    ];
    let mut req = Vec::with_capacity(20);
    req.extend_from_slice(&stun::MSG_BINDING_REQUEST.to_be_bytes());
    req.push(0);
    req.push(0); // no attributes
    req.extend_from_slice(&stun::MAGIC_COOKIE.to_be_bytes());
    req.extend_from_slice(&txn);
    sock.send_to(&req, addr).await.unwrap();

    let mut buf = [0u8; 512];
    let (n, _src) = tokio::time::timeout(RECV_TIMEOUT, sock.recv_from(&mut buf))
        .await
        .expect("no STUN reply on the shared UDP port")
        .unwrap();
    let reply = &buf[..n];

    let header = stun::parse_header(reply).expect("reply parses as a STUN message");
    assert_eq!(header.msg_type, stun::MSG_BINDING_RESPONSE);
    assert_eq!(header.transaction_id, txn);

    let mut mapped = None;
    let mut software = String::new();
    for (rtype, value) in stun::attributes(reply) {
        match rtype {
            stun::ATTR_XOR_MAPPED_ADDRESS => {
                mapped = stun::decode_xor_address(value, &header.transaction_id);
            }
            stun::ATTR_SOFTWARE => software = String::from_utf8_lossy(value).into_owned(),
            _ => {}
        }
    }
    // No --external in tests: the mapped address is the client's own.
    assert_eq!(mapped, Some(client_addr));
    assert!(
        software.starts_with("campfire/"),
        "SOFTWARE attribute: {software}"
    );
}

#[tokio::test]
async fn turn_credential_endpoint() {
    let (addr, root) = start_server().await;

    // First request: a fresh 1 h TURN REST pair for this peer address.
    let (status, body) = http3(addr, &root, "POST", "/api/v1/turn/credential", None).await;
    assert_eq!(status, 200, "body: {body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let username = v["username"].as_str().unwrap();
    let credential = v["credential"].as_str().unwrap();
    let expires = v["expires"].as_u64().unwrap();

    // Username is "{expires_unix}:{ip}" (TURN REST draft), ip = our address.
    let (stamp, ip) = username.split_once(':').expect("username is stamp:ip");
    assert_eq!(ip, "127.0.0.1");
    assert_eq!(stamp.parse::<u64>().unwrap(), expires);

    // The credential verifies against the shared secret.
    assert_eq!(
        credential,
        stun::turn_rest_credential(TURN_SECRET, username),
        "credential must be base64(HMAC-SHA1(secret, username))"
    );

    // Expiry is ~now + 1 h.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(
        expires >= now + 3590 && expires <= now + 3610,
        "expires {expires} vs now {now}"
    );

    // Rate limit: a second request from the same IP is rejected (1 / 10 min).
    let (status, body) = http3(addr, &root, "POST", "/api/v1/turn/credential", None).await;
    assert_eq!(status, 429, "body: {body}");
}

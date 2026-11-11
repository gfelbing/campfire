//! Phase 4 acceptance test (README §11): the SSE+POST fallback carries the
//! same protocol as the WebTransport stream (minus datagram movement).
//!
//! Verified over **real QUIC/HTTP/3** on an ephemeral port:
//! 1. `POST /rt/event` join returns a token;
//! 2. `GET /rt/sse?token=` delivers the `hello` snapshot;
//! 3. a second fallback client's chat arrives on the first client's SSE
//!    stream (and vice versa — chat is echoed to everyone, incl. the sender).

use std::sync::Arc;

use bytes::Buf;
use rustls::pki_types::CertificateDer;

mod common;
use common::start_server;

type H3Quinn = h3_quinn::Connection;
type H3Conn = h3::client::Connection<H3Quinn, bytes::Bytes>;
type SendReq = h3::client::SendRequest<h3_quinn::OpenStreams, bytes::Bytes>;
type RespStream = h3::client::RequestStream<h3_quinn::BidiStream<bytes::Bytes>, bytes::Bytes>;

/// One TLS/QUIC/HTTP3 connection, verified against the rcgen root.
async fn connect(addr: std::net::SocketAddr, root: &CertificateDer<'static>) -> (H3Conn, SendReq) {
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
    h3::client::builder()
        .build::<_, _, bytes::Bytes>(h3_quinn::Connection::new(conn))
        .await
        .unwrap()
}

/// `POST` one JSON body to /rt/event; returns status + complete body.
async fn post_json(send_req: &mut SendReq, payload: &str) -> (u16, String) {
    let mut res = send_req
        .send_request(
            http::Request::builder()
                .method("POST")
                .uri("https://localhost/rt/event")
                .header("content-type", "application/json")
                .body(())
                .unwrap(),
        )
        .await
        .unwrap();
    res.send_data(bytes::Bytes::from(payload.to_owned()))
        .await
        .unwrap();
    res.finish().await.unwrap();
    let response = res.recv_response().await.unwrap();
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = res.recv_data().await.unwrap() {
        body.extend_from_slice(chunk.chunk());
    }
    (status, String::from_utf8_lossy(&body).into_owned())
}

/// `GET` an SSE stream; returns status + the open response stream.
async fn get_sse(send_req: &mut SendReq, token: &str) -> (u16, RespStream) {
    let mut res = send_req
        .send_request(
            http::Request::builder()
                .uri(format!("https://localhost/rt/sse?token={token}"))
                .body(())
                .unwrap(),
        )
        .await
        .unwrap();
    res.finish().await.unwrap();
    let response = res.recv_response().await.unwrap();
    (response.status().as_u16(), res)
}

/// Read body chunks until `n` SSE `data:` events are complete.
async fn read_events(res: &mut RespStream, n: usize) -> Vec<String> {
    let mut buf = String::new();
    let mut events = Vec::new();
    while events.len() < n {
        let Some(chunk) = res.recv_data().await.unwrap() else {
            panic!("SSE stream ended after {} events", events.len());
        };
        buf.push_str(&String::from_utf8_lossy(chunk.chunk()));
        while let Some(pos) = buf.find("\n\n") {
            let event = buf[..pos].to_owned();
            buf = buf[pos + 2..].to_owned();
            // axum splits multi-line data across `data: ` fields; the lines
            // of one event are consecutive `data: ` lines. Rejoin them.
            let mut data = String::new();
            for line in event.lines() {
                if let Some(rest) = line.strip_prefix("data: ") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(rest);
                }
            }
            if !data.is_empty() {
                events.push(data);
            }
        }
    }
    events
}

#[tokio::test]
async fn sse_fallback_join_and_chat_roundtrip() {
    campfire_server::api::mark_start();
    let (addr, root) = start_server().await;
    let (mut _conn, mut send_req) = connect(addr, &root).await;

    // 1. Client A joins → token.
    let (status, body) = post_json(
        &mut send_req,
        r#"{"type":"join","payload":{"room":"office","name":"alice"}}"#,
    )
    .await;
    assert_eq!(status, 200, "join body: {body}");
    let va: serde_json::Value = serde_json::from_str(&body).unwrap();
    let token_a = va["token"].as_str().unwrap().to_owned();
    assert!(!token_a.is_empty());

    // 2. A opens the SSE downlink and receives its hello.
    let (status, mut sse) = get_sse(&mut send_req, &token_a).await;
    assert_eq!(status, 200, "sse should be 200");
    let events = read_events(&mut sse, 1).await;
    let hello: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
    assert_eq!(hello["t"], "hello");
    assert_eq!(hello["room"], "office");
    let you_a = hello["you"].as_str().unwrap().to_owned();
    // The join token is a per-session secret, not the room-public user id (S1).
    assert!(you_a.starts_with("u_"), "user id: {you_a}");
    assert_ne!(you_a, token_a);
    assert_eq!(hello["users"].as_array().unwrap().len(), 1);

    // 3. Client B joins; A's stream hears the `joined` event.
    let (status, body) = post_json(
        &mut send_req,
        r#"{"type":"join","payload":{"room":"office","name":"bob"}}"#,
    )
    .await;
    assert_eq!(status, 200, "join body: {body}");
    let vb: serde_json::Value = serde_json::from_str(&body).unwrap();
    let token_b = vb["token"].as_str().unwrap().to_owned();
    assert_ne!(token_b, token_a);

    let events = read_events(&mut sse, 1).await;
    let joined: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
    assert_eq!(joined["t"], "joined");
    assert_eq!(joined["user"]["name"], "bob");

    // 4. B opens its own downlink and receives its hello (2 users now).
    let (status, mut sse_b) = get_sse(&mut send_req, &token_b).await;
    assert_eq!(status, 200);
    let events = read_events(&mut sse_b, 1).await;
    let hello_b: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
    assert_eq!(hello_b["t"], "hello");
    let you_b = hello_b["you"].as_str().unwrap().to_owned();
    assert!(you_b.starts_with("u_"), "user id: {you_b}");
    assert_ne!(you_b, token_b);
    assert_eq!(hello_b["users"].as_array().unwrap().len(), 2);

    // 5. B chats; A hears it, and B hears its own echo.
    let (status, body) = post_json(
        &mut send_req,
        &format!(r#"{{"type":"msg","payload":{{"token":"{token_b}","msg":{{"t":"chat","text":"hi all"}}}}}}"#),
    )
    .await;
    assert_eq!(status, 200, "chat body: {body}");

    let events = read_events(&mut sse, 1).await;
    let chat: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
    assert_eq!(chat["t"], "chat");
    assert_eq!(chat["from"], you_b);
    assert_eq!(chat["text"], "hi all");

    let events = read_events(&mut sse_b, 1).await;
    let echo: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
    assert_eq!(echo["t"], "chat");
    assert_eq!(echo["text"], "hi all");

    // 6. Unknown token → 404; the room-public user id as a token → 400 (S1:
    //    the relay identity is the per-session secret, never the user id); a
    //    join with a bogus room → 400.
    let (status, _) = get_sse(&mut send_req, "u_bogus000").await;
    assert_eq!(status, 404);
    let (status, body) = post_json(
        &mut send_req,
        &format!(
            r#"{{"type":"msg","payload":{{"token":"{you_b}","msg":{{"t":"chat","text":"impersonation attempt"}}}}}}"#
        ),
    )
    .await;
    assert_eq!(status, 400, "user id is not a session token (S1): {body}");
    let (status, body) = post_json(
        &mut send_req,
        r#"{"type":"join","payload":{"room":"nope","name":"eve"}}"#,
    )
    .await;
    assert_eq!(status, 400, "bad room body: {body}");
}

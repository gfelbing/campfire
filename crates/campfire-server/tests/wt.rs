//! Phase 2 acceptance tests (README §11): WebTransport session layer.
//!
//! Uses `wtransport` — the reference Rust WebTransport implementation — as a
//! real, browser-grade client. Every scenario runs over **actual HTTP/3 on
//! QUIC** against the real server stack: join → hello, presence broadcast,
//! chat echo, typing relay, leave notification, per-session rate limits,
//! validation errors, and datagram tolerance.

use std::net::SocketAddr;
use std::time::Duration;

use bytes::Bytes;
use campfire_protocol::{ClientMsg, ErrorCode, ServerMsg, from_line, to_line};
use tokio::io::AsyncWriteExt;
use wtransport::Connection;

mod common;
use common::start_server;

/// Cap on any single wait, so a broken server fails the test instead of
/// hanging it.
const RECV_TIMEOUT: Duration = Duration::from_secs(5);

/// A connected WebTransport client with its command stream open.
struct TestClient {
    conn: Connection,
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
        Self { conn, send, recv }
    }

    async fn send(&mut self, msg: &ClientMsg) {
        self.send.write_all(to_line(msg).as_bytes()).await.unwrap();
        self.send.flush().await.unwrap();
    }

    /// Send raw bytes on the command stream (for malformed-message tests).
    async fn send_raw(&mut self, raw: &[u8]) {
        self.send.write_all(raw).await.unwrap();
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
        from_line(std::str::from_utf8(&buf).unwrap()).unwrap()
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

#[tokio::test]
async fn join_hello_presence_chat_typing_leave() {
    let (addr, _root) = start_server().await;

    // Alice joins first and gets a snapshot with just herself.
    let mut a = TestClient::connect(addr).await;
    a.send(&ClientMsg::Join {
        room: "office".into(),
        name: "alice".into(),
        avatar: None,
    })
    .await;
    let ServerMsg::Hello {
        you: a_id,
        room,
        users,
        chat,
    } = a.recv().await
    else {
        panic!("expected hello for alice");
    };
    assert_eq!(room, "office");
    assert_eq!(users.len(), 1, "hello should contain only alice");
    assert_eq!(users[0].id, a_id);
    assert_eq!(users[0].name, "alice");
    assert!(chat.is_empty());

    // Bob joins the same room: hello carries both users.
    let mut b = TestClient::connect(addr).await;
    b.send(&ClientMsg::Join {
        room: "office".into(),
        name: "bob".into(),
        avatar: None,
    })
    .await;
    let ServerMsg::Hello {
        you: b_id, users, ..
    } = b.recv().await
    else {
        panic!("expected hello for bob");
    };
    assert_eq!(users.len(), 2, "bob's hello should list alice and bob");

    // Alice is told about bob.
    let ServerMsg::Joined { user } = a.recv().await else {
        panic!("expected joined event for bob");
    };
    assert_eq!(user.id, b_id);
    assert_eq!(user.name, "bob");

    // Bob chats; both clients see the echo (sender included).
    b.send(&ClientMsg::Chat {
        text: "hello world".into(),
    })
    .await;
    let ServerMsg::Chat {
        from, name, text, ..
    } = a.recv().await
    else {
        panic!("expected chat at alice");
    };
    assert_eq!(from, b_id);
    assert_eq!(name, "bob");
    assert_eq!(text, "hello world");
    let ServerMsg::Chat { from, .. } = b.recv().await else {
        panic!("expected chat echo at bob");
    };
    assert_eq!(from, b_id, "sender must receive its own chat echo");

    // Alice types; only bob is notified.
    a.send(&ClientMsg::Typing { on: true }).await;
    let ServerMsg::Typing { id, on } = b.recv().await else {
        panic!("expected typing event at bob");
    };
    assert_eq!(id, a_id);
    assert!(on);

    // Alice disconnects; bob sees the leave.
    drop(a);
    let ServerMsg::Left { id } = b.recv().await else {
        panic!("expected left event after alice disconnected");
    };
    assert_eq!(id, a_id);
}

#[tokio::test]
async fn chat_rate_limit_allows_one_per_second() {
    let (addr, _root) = start_server().await;
    let (mut c, _) = join(addr, "r", "chatty").await;

    for i in 0..5 {
        c.send(&ClientMsg::Chat {
            text: format!("msg {i}"),
        })
        .await;
    }

    // Exactly one echo gets through; the other four are refused.
    let echo = c.recv().await;
    assert!(
        matches!(echo, ServerMsg::Chat { .. }),
        "expected one chat echo, got {echo:?}"
    );
    for _ in 0..4 {
        let err = c.recv().await;
        assert!(
            matches!(
                err,
                ServerMsg::Error {
                    code: ErrorCode::RateLimited
                }
            ),
            "expected rate_limited, got {err:?}"
        );
    }
}

#[tokio::test]
async fn validation_errors_are_reported() {
    let (addr, _root) = start_server().await;
    let mut c = TestClient::connect(addr).await;

    // Room id: uppercase not allowed.
    c.send(&ClientMsg::Join {
        room: "Office".into(),
        name: "alice".into(),
        avatar: None,
    })
    .await;
    assert!(matches!(
        c.recv().await,
        ServerMsg::Error {
            code: ErrorCode::BadMessage
        }
    ));

    // Name: empty after trimming.
    c.send(&ClientMsg::Join {
        room: "r".into(),
        name: "   ".into(),
        avatar: None,
    })
    .await;
    assert!(matches!(
        c.recv().await,
        ServerMsg::Error {
            code: ErrorCode::NameTooLong
        }
    ));

    // Name: over the 24-char limit.
    c.send(&ClientMsg::Join {
        room: "r".into(),
        name: "x".repeat(25),
        avatar: None,
    })
    .await;
    assert!(matches!(
        c.recv().await,
        ServerMsg::Error {
            code: ErrorCode::NameTooLong
        }
    ));

    // Chat/typing before joining is a state error.
    c.send(&ClientMsg::Chat {
        text: "too early".into(),
    })
    .await;
    assert!(matches!(
        c.recv().await,
        ServerMsg::Error {
            code: ErrorCode::BadMessage
        }
    ));

    // Not JSON at all.
    c.send_raw(b"this is not json\n").await;
    assert!(matches!(
        c.recv().await,
        ServerMsg::Error {
            code: ErrorCode::BadMessage
        }
    ));

    // Valid join, then an over-long chat.
    c.send(&ClientMsg::Join {
        room: "r".into(),
        name: "alice".into(),
        avatar: None,
    })
    .await;
    assert!(matches!(c.recv().await, ServerMsg::Hello { .. }));
    c.send(&ClientMsg::Chat {
        text: "y".repeat(501),
    })
    .await;
    assert!(matches!(
        c.recv().await,
        ServerMsg::Error {
            code: ErrorCode::ChatTooLong
        }
    ));

    // The session survived all of that: a normal chat still works.
    c.send(&ClientMsg::Chat {
        text: "recovered".into(),
    })
    .await;
    assert!(matches!(c.recv().await, ServerMsg::Chat { .. }));
}

#[tokio::test]
async fn datagrams_are_drained_without_breaking_the_session() {
    let (addr, _root) = start_server().await;
    let (mut c, _) = join(addr, "r", "mover").await;

    // Movement datagrams (Phase 3's payload) are discarded for now, but the
    // session must stay healthy afterwards.
    c.conn
        .send_datagram(Bytes::from_static(b"{\"m\":[]}"))
        .unwrap();

    c.send(&ClientMsg::Chat {
        text: "still here".into(),
    })
    .await;
    let ServerMsg::Chat { text, .. } = c.recv().await else {
        panic!("expected chat echo after datagram");
    };
    assert_eq!(text, "still here");
}

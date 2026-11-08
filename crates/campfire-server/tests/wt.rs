//! Phase 2 + 3 acceptance tests (README §11): WebTransport session layer and
//! world movement.
//!
//! Uses `wtransport` — the reference Rust WebTransport implementation — as a
//! real, browser-grade client. Every scenario runs over **actual HTTP/3 on
//! QUIC** against the real server stack: join → hello, presence broadcast,
//! chat echo, typing relay, leave notification, per-session rate limits,
//! validation errors, and datagram tolerance (Phase 2), plus movement
//! validation with datagram fan-out and chat history for a third joiner
//! (Phase 3).

use std::net::SocketAddr;
use std::time::Duration;

use bytes::Bytes;
use campfire_protocol::{
    ClientMsg, Dir, ErrorCode, MovementBatch, MovementEntry, ServerMsg, from_line, to_line,
};
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

    /// Read exactly one NDJSON line and decode it. Skips room-wide
    /// `call_start` broadcasts: users sharing the spawn tile are pulled
    /// into a proximity bubble by the tick (README §6.3), and that badge
    /// may interleave anywhere. No wt.rs test asserts on call state.
    async fn recv(&mut self) -> ServerMsg {
        loop {
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
            match from_line(std::str::from_utf8(&buf).unwrap()).unwrap() {
                ServerMsg::CallStart { .. } | ServerMsg::CallEnd { .. } => continue,
                msg => return msg,
            }
        }
    }
}

/// Connect + join in one step, returning (client, own id).
async fn join(addr: SocketAddr, room: &str, name: &str) -> (TestClient, String) {
    let mut c = TestClient::connect(addr).await;
    c.send(&ClientMsg::Join {
        room: room.into(),
        name: name.into(),
        avatar: None,
        token: None,
    })
    .await;
    let ServerMsg::Hello { you, .. } = c.recv().await else {
        panic!("expected hello after join");
    };
    (c, you)
}

/// Send one movement entry as a datagram (README §5 wire shape).
fn move_datagram(id: &str, x: f32, y: f32, seq: u64) -> Bytes {
    let batch = MovementBatch {
        m: vec![MovementEntry {
            id: id.to_owned(),
            x,
            y,
            d: Dir::East,
            moving: 1,
            seq,
            silent: false,
        }],
    };
    Bytes::from(serde_json::to_vec(&batch).unwrap())
}

/// Wait for a movement datagram that carries an entry for `who` and return
/// the position it reports. Batches for other users are skipped.
async fn recv_movement(conn: &Connection, who: &str) -> (f32, f32) {
    loop {
        let dg = tokio::time::timeout(RECV_TIMEOUT, conn.receive_datagram())
            .await
            .expect("timed out waiting for a movement datagram")
            .expect("connection died waiting for a datagram");
        let batch: MovementBatch =
            serde_json::from_slice(dg.payload().as_ref()).expect("datagram is a movement batch");
        if let Some(e) = batch.m.iter().find(|e| e.id == who) {
            return (e.x, e.y);
        }
    }
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
        token: None,
    })
    .await;
    let ServerMsg::Hello {
        you: a_id,
        room,
        users,
        chat,
        ..
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
        token: None,
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

    // Alice leaves explicitly (README §5 `leave`): bob sees the leave right
    // away. (A dropped connection no longer leaves immediately — it starts
    // the 30 s reconnect window; that path is covered by the `reconnect` test.)
    a.send(&ClientMsg::Leave).await;
    let ServerMsg::Left { id } = b.recv().await else {
        panic!("expected left event after alice left");
    };
    assert_eq!(id, a_id);
}

#[tokio::test]
async fn chat_rate_limit_allows_one_per_second() {
    let (addr, _root) = start_server().await;
    let (mut c, _) = join(addr, "island", "chatty").await;

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
        token: None,
    })
    .await;
    assert!(matches!(
        c.recv().await,
        ServerMsg::Error {
            code: ErrorCode::BadMessage
        }
    ));

    // Room id: not a known map.
    c.send(&ClientMsg::Join {
        room: "nowhere".into(),
        name: "alice".into(),
        avatar: None,
        token: None,
    })
    .await;
    assert!(matches!(
        c.recv().await,
        ServerMsg::Error {
            code: ErrorCode::UnknownRoom
        }
    ));

    // Name: empty after trimming.
    c.send(&ClientMsg::Join {
        room: "island".into(),
        name: "   ".into(),
        avatar: None,
        token: None,
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
        room: "island".into(),
        name: "x".repeat(25),
        avatar: None,
        token: None,
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
        room: "island".into(),
        name: "alice".into(),
        avatar: None,
        token: None,
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
    let (mut c, _) = join(addr, "island", "mover").await;

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

/// Phase 3 acceptance test (README §11): two in-process clients join the same
/// room, move, and each receives the other's deltas; an invalid move is
/// rejected; chat round-trips with history for a third joiner.
#[tokio::test]
async fn movement_relay_invalid_move_rejected_chat_history() {
    let (addr, _root) = start_server().await;

    let (mut a, a_id) = join(addr, "office", "alice").await;
    let (mut b, b_id) = join(addr, "office", "bob").await;
    // Alice is told about bob (her queue must be drained before the chat part).
    let ServerMsg::Joined { user } = a.recv().await else {
        panic!("expected joined event for bob");
    };
    assert_eq!(user.id, b_id);

    // Spawn is the office center (20.5, 15.5). Give the speed gate (8 tiles/s)
    // a 300 ms headroom before the first 1-tile step.
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Alice walks one tile east; Bob receives her delta on a datagram.
    a.conn
        .send_datagram(move_datagram(&a_id, 21.5, 15.5, 1))
        .unwrap();
    let (x, y) = recv_movement(&b.conn, &a_id).await;
    assert_eq!(
        (x, y),
        (21.5, 15.5),
        "bob must see alice at her new position"
    );

    // Alice "teleports" 14 tiles: far beyond 8 tiles/s, so the server rejects
    // it. Nothing is broadcast for the rejected move.
    a.conn
        .send_datagram(move_datagram(&a_id, 35.5, 15.5, 2))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Alice's next step from the *accepted* position is a normal 1-tile walk:
    // it is relayed, and it proves the teleport never moved her.
    a.conn
        .send_datagram(move_datagram(&a_id, 22.5, 15.5, 3))
        .unwrap();
    let (x, y) = recv_movement(&b.conn, &a_id).await;
    assert_eq!(
        (x, y),
        (22.5, 15.5),
        "bob must see the accepted step, never the rejected teleport"
    );

    // Bob became dirty on join (the room already had alice), so the first
    // tick broadcast his *spawn* position to everyone. Alice has buffered it
    // since; assert she learned bob's spawn from that broadcast.
    let (x, y) = recv_movement(&a.conn, &b_id).await;
    assert_eq!(
        (x, y),
        (20.5, 15.5),
        "alice learns bob's spawn from the dirty-on-join broadcast"
    );

    // Bob walks one tile west; Alice receives his delta (skipping the batches
    // that only carry alice's entries).
    b.conn
        .send_datagram(move_datagram(&b_id, 19.5, 15.5, 1))
        .unwrap();
    let (x, y) = recv_movement(&a.conn, &b_id).await;
    assert_eq!(
        (x, y),
        (19.5, 15.5),
        "alice must see bob at his new position"
    );

    // Chat round-trip; the third joiner gets the history.
    a.send(&ClientMsg::Chat { text: "hey".into() }).await;
    b.send(&ClientMsg::Chat { text: "yo".into() }).await;
    let ServerMsg::Chat { from, text, .. } = a.recv().await else {
        panic!("expected chat echo at alice");
    };
    assert_eq!((from.as_str(), text.as_str()), (a_id.as_str(), "hey"));
    let ServerMsg::Chat { from, text, .. } = b.recv().await else {
        panic!("expected chat echo at bob");
    };
    assert_eq!((from.as_str(), text.as_str()), (a_id.as_str(), "hey"));
    let ServerMsg::Chat { from, text, .. } = a.recv().await else {
        panic!("expected chat echo at alice");
    };
    assert_eq!((from.as_str(), text.as_str()), (b_id.as_str(), "yo"));
    let ServerMsg::Chat { from, text, .. } = b.recv().await else {
        panic!("expected chat echo at bob");
    };
    assert_eq!((from.as_str(), text.as_str()), (b_id.as_str(), "yo"));

    let mut c = TestClient::connect(addr).await;
    c.send(&ClientMsg::Join {
        room: "office".into(),
        name: "carol".into(),
        avatar: None,
        token: None,
    })
    .await;
    let ServerMsg::Hello { users, chat, .. } = c.recv().await else {
        panic!("expected hello for carol");
    };
    assert_eq!(users.len(), 3, "carol's hello lists all three users");
    let texts: Vec<&str> = chat.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(
        texts,
        vec!["hey", "yo"],
        "carol's hello carries the chat history"
    );
}

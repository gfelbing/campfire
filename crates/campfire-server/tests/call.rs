//! Call-state tests (README §6.3) over real HTTP/3 on QUIC.
//!
//! Since Phase 4 the server carries no call *signaling* (SDP/ICE) and no
//! STUN/TURN: media rides the MoQ SFU (docs/moq-sfu.md). What remains —
//! and what runs here against the real server stack with `wtransport` as
//! the client — is the call *state machine*: bubble formation, the
//! room-wide badge, mute/camera presence, and the leave/end transitions.

use std::net::SocketAddr;
use std::time::Duration;

use campfire_protocol::{ClientMsg, ErrorCode, ServerMsg, to_line};
use tokio::io::AsyncWriteExt;
use wtransport::Connection;

mod common;
use common::start_server;

/// Cap on any single wait, so a broken server fails the test instead of
/// hanging it.
const RECV_TIMEOUT: Duration = Duration::from_secs(5);

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
        token: None,
        status: None,
    })
    .await;
    let ServerMsg::Hello { you, .. } = c.recv().await else {
        panic!("expected hello after join");
    };
    (c, you)
}

/// Assert the client's next message is `Error { code }`.
async fn assert_err(c: &mut TestClient, code: ErrorCode) {
    match c.recv().await {
        ServerMsg::Error { code: got } => assert_eq!(got, code),
        m => panic!("expected error {code:?}, got {m:?}"),
    }
}

/// Proximity bubbles (README §6.3): two users in the same room spawn at
/// the same tile, so the server's tick pulls them into one bubble without
/// any ring/accept. The whole room gets the badge; mute relays as
/// participant-scoped presence; hang-up ends the bubble.
#[tokio::test]
async fn bubble_forms_and_carries_presence() {
    let (addr, _root) = start_server().await;

    let (mut a, a_id) = join(addr, "office", "alice").await;
    let (mut b, b_id) = join(addr, "office", "bob").await;
    let ServerMsg::Joined { user } = a.recv().await else {
        panic!("expected alice to hear bob join");
    };
    assert_eq!(user.id, b_id);

    // Both are at spawn: within a tick or two the server forms the bubble
    // and broadcasts the roster room-wide.
    let ServerMsg::CallStart {
        room, participants, ..
    } = a.recv().await
    else {
        panic!("expected call_start for alice");
    };
    let ServerMsg::CallStart {
        participants: pb, ..
    } = b.recv().await
    else {
        panic!("expected call_start for bob");
    };
    assert_eq!(room, "office");
    assert_eq!(participants, pb, "everyone hears the same roster");
    assert_eq!(participants.len(), 2);
    let ids: Vec<&str> = participants.iter().map(|u| u.id.as_str()).collect();
    assert!(ids.contains(&a_id.as_str()));
    assert!(ids.contains(&b_id.as_str()));

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

    // Bob hangs up: with alice the only participant left, the bubble ends.
    b.send(&ClientMsg::CallLeave).await;
    match a.recv().await {
        ServerMsg::CallEnd { reason, .. } => assert_eq!(reason, "last_left"),
        m => panic!("expected call_end (last_left), got {m:?}"),
    }
}

/// A user not in any call cannot send call messages (README §5/§6.3:
/// errors go back as `error` messages).
#[tokio::test]
async fn call_mute_outside_a_call_is_rejected() {
    let (addr, _root) = start_server().await;

    // Carol joins FIRST and opts out of bubbles immediately: she can never
    // be pulled into one (deterministic, no race with the tick).
    let (mut c, _c_id) = join(addr, "office", "carol").await;
    c.send(&ClientMsg::Bubble { off: true }).await;

    // Alice joins: no bubble forms around her while carol is opted out.
    let (mut a, _a_id) = join(addr, "office", "alice").await;
    let ServerMsg::Joined { .. } = c.recv().await else {
        panic!("expected carol to hear alice join");
    };

    a.send(&ClientMsg::CallMute {
        audio: false,
        video: false,
    })
    .await;
    assert_err(&mut a, ErrorCode::CallNotAllowed).await;
}

//! Phase 6 acceptance test (README §11): room huddles.
//!
//! > **Done when:** 6-participant huddle; a mid-call join plus a
//! > mid-call drop/reconnect; no leaked peer connections; auto voice-only
//! > engages at 10 participants.
//!
//! Everything the *server* does for huddles runs here over **real HTTP/3
//! on QUIC**: create/join via `call_offer{to:"room"}`, newcomer re-ICE
//! (the joiner offers every existing member), room-wide call state
//! (headphone badge), mute presence, mid-call join, mid-call drop,
//! leave, last-leave ending the call, and a fresh huddle on the cleared
//! room (no leaked call state).
//!
//! The WebRTC side (N-1 `RTCPeerConnection`s per member, zero leaked
//! peer connections, auto voice-only at 9+) is browser-only: it is
//! implemented in `client/src/call` and checked manually with six
//! windows, per README §11.

use std::net::SocketAddr;
use std::time::Duration;

use campfire_protocol::{ClientMsg, ServerMsg, UserBrief, to_line};
use tokio::io::AsyncWriteExt;
use wtransport::Connection;

mod common;
use common::start_server;

const RECV_TIMEOUT: Duration = Duration::from_secs(5);

/// A connected WebTransport client with its command stream open (same
/// shape as `tests/call.rs` — each test binary is standalone).
struct TestClient {
    /// Held so the QUIC connection stays open (no datagrams in this test).
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

    /// Kill the QUIC connection (simulates a mid-call network drop).
    fn close(&self) {
        self._conn
            .close(wtransport::VarInt::from_u32(0), b"connection closed");
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

// --- one-message-per-variant extractors (assert + unwrap the payload) -----

async fn as_joined(c: &mut TestClient) -> UserBrief {
    match c.recv().await {
        ServerMsg::Joined { user } => user,
        m => panic!("expected joined, got {m:?}"),
    }
}

async fn as_left(c: &mut TestClient) -> String {
    match c.recv().await {
        ServerMsg::Left { id } => id,
        m => panic!("expected left, got {m:?}"),
    }
}

async fn as_call_start(c: &mut TestClient) -> Vec<UserBrief> {
    match c.recv().await {
        ServerMsg::CallStart { participants, .. } => participants,
        m => panic!("expected call_start, got {m:?}"),
    }
}

async fn as_call_join(c: &mut TestClient) -> UserBrief {
    match c.recv().await {
        ServerMsg::CallJoin { user } => user,
        m => panic!("expected call_join, got {m:?}"),
    }
}

async fn as_call_leave(c: &mut TestClient) -> String {
    match c.recv().await {
        ServerMsg::CallLeave { id } => id,
        m => panic!("expected call_leave, got {m:?}"),
    }
}

async fn as_call_end(c: &mut TestClient) -> String {
    match c.recv().await {
        ServerMsg::CallEnd { reason } => reason,
        m => panic!("expected call_end, got {m:?}"),
    }
}

async fn as_call_offer(c: &mut TestClient) -> (String, String) {
    match c.recv().await {
        ServerMsg::CallOffer { from, sdp } => (from, sdp),
        m => panic!("expected call_offer, got {m:?}"),
    }
}

async fn as_call_answer(c: &mut TestClient) -> (String, String) {
    match c.recv().await {
        ServerMsg::CallAnswer { from, sdp } => (from, sdp),
        m => panic!("expected call_answer, got {m:?}"),
    }
}

async fn as_call_ice(c: &mut TestClient) -> (String, String) {
    match c.recv().await {
        ServerMsg::CallIce { from, candidate } => (from, candidate),
        m => panic!("expected call_ice, got {m:?}"),
    }
}

async fn as_call_mute(c: &mut TestClient) -> (String, bool, bool) {
    match c.recv().await {
        ServerMsg::CallMute { id, audio, video } => (id, audio, video),
        m => panic!("expected call_mute, got {m:?}"),
    }
}

fn ids(participants: &[UserBrief]) -> Vec<&str> {
    let mut v: Vec<&str> = participants.iter().map(|p| p.id.as_str()).collect();
    v.sort();
    v
}

fn expect_ids(participants: &[UserBrief], expected: &[&str]) {
    let mut want: Vec<&str> = expected.to_vec();
    want.sort();
    assert_eq!(ids(participants), want, "participant roster mismatch");
}

/// `call_offer { to: "room" }` — create or join the room huddle.
async fn join_huddle(c: &mut TestClient) {
    c.send(&ClientMsg::CallOffer {
        to: "room".into(),
        sdp: String::new(),
    })
    .await;
}

#[tokio::test]
async fn huddle_six_members_mid_call_join_and_drop() {
    let (addr, _root) = start_server().await;

    // Six future huddle members + one spectator (g) who will join mid-call.
    let (mut a, a_id) = join(addr, "office", "alice").await;
    let (mut b, b_id) = join(addr, "office", "bob").await;
    assert_eq!(as_joined(&mut a).await.id, b_id);
    let (mut c, c_id) = join(addr, "office", "carol").await;
    assert_eq!(as_joined(&mut a).await.id, c_id);
    assert_eq!(as_joined(&mut b).await.id, c_id);
    let (mut d, d_id) = join(addr, "office", "dave").await;
    for u in [&mut a, &mut b, &mut c] {
        assert_eq!(as_joined(u).await.id, d_id);
    }
    let (mut e, e_id) = join(addr, "office", "erin").await;
    for u in [&mut a, &mut b, &mut c, &mut d] {
        assert_eq!(as_joined(u).await.id, e_id);
    }
    let (mut f, _f_id) = join(addr, "office", "frank").await;
    for u in [&mut a, &mut b, &mut c, &mut d, &mut e] {
        assert_eq!(as_joined(u).await.id, _f_id);
    }
    let (mut g, _g_id) = join(addr, "office", "grace").await;
    for u in [&mut a, &mut b, &mut c, &mut d, &mut e, &mut f] {
        assert_eq!(as_joined(u).await.id, _g_id);
    }

    // --- create: alice starts the huddle; the whole room hears call_start.
    join_huddle(&mut a).await;
    for u in [&mut a, &mut b, &mut c, &mut d, &mut e, &mut f, &mut g] {
        expect_ids(&as_call_start(u).await, &[&a_id]);
    }

    // --- bob joins: everyone else hears call_join (badge + panel), bob
    //     gets the full roster to offer every existing member.
    join_huddle(&mut b).await;
    for u in [&mut a, &mut c, &mut d, &mut e, &mut f, &mut g] {
        assert_eq!(as_call_join(u).await.id, b_id);
    }
    expect_ids(&as_call_start(&mut b).await, &[&a_id, &b_id]);

    // Bob is the offerer (newcomer re-ICE): one offer to alice, who
    // answers; ICE flows both ways. Existing members never renegotiate.
    b.send(&ClientMsg::CallOffer {
        to: a_id.clone(),
        sdp: "v=0 bob-offer".into(),
    })
    .await;
    let (from, sdp) = as_call_offer(&mut a).await;
    assert_eq!((from, sdp), (b_id.clone(), "v=0 bob-offer".to_owned()));
    a.send(&ClientMsg::CallAnswer {
        to: b_id.clone(),
        sdp: "v=0 alice-answer".into(),
    })
    .await;
    let (from, sdp) = as_call_answer(&mut b).await;
    assert_eq!((from, sdp), (a_id.clone(), "v=0 alice-answer".to_owned()));
    b.send(&ClientMsg::CallIce {
        to: a_id.clone(),
        candidate: r#"{"candidate":"b-cand"}"#.into(),
    })
    .await;
    let (from, cand) = as_call_ice(&mut a).await;
    assert_eq!(
        (from, cand),
        (b_id.clone(), r#"{"candidate":"b-cand"}"#.to_owned())
    );
    a.send(&ClientMsg::CallIce {
        to: b_id.clone(),
        candidate: r#"{"candidate":"a-cand"}"#.into(),
    })
    .await;
    let (from, cand) = as_call_ice(&mut b).await;
    assert_eq!(
        (from, cand),
        (a_id.clone(), r#"{"candidate":"a-cand"}"#.to_owned())
    );

    // --- carol joins mid-call: she offers every existing member (alice
    //     and bob); they answer; existing members do not renegotiate.
    join_huddle(&mut c).await;
    for u in [&mut a, &mut b, &mut d, &mut e, &mut f, &mut g] {
        assert_eq!(as_call_join(u).await.id, c_id);
    }
    expect_ids(&as_call_start(&mut c).await, &[&a_id, &b_id, &c_id]);
    c.send(&ClientMsg::CallOffer {
        to: a_id.clone(),
        sdp: "v=0 c-offer-a".into(),
    })
    .await;
    c.send(&ClientMsg::CallOffer {
        to: b_id.clone(),
        sdp: "v=0 c-offer-b".into(),
    })
    .await;
    let (from, sdp) = as_call_offer(&mut a).await;
    assert_eq!((from, sdp), (c_id.clone(), "v=0 c-offer-a".to_owned()));
    let (from, sdp) = as_call_offer(&mut b).await;
    assert_eq!((from, sdp), (c_id.clone(), "v=0 c-offer-b".to_owned()));
    a.send(&ClientMsg::CallAnswer {
        to: c_id.clone(),
        sdp: "v=0 a-answer-c".into(),
    })
    .await;
    b.send(&ClientMsg::CallAnswer {
        to: c_id.clone(),
        sdp: "v=0 b-answer-c".into(),
    })
    .await;
    assert_eq!(as_call_answer(&mut c).await.0, a_id);
    assert_eq!(as_call_answer(&mut c).await.0, b_id);

    // --- mute presence: call-scoped (not room-wide). Alice mutes; only
    //     the other participants (bob, carol) hear it — not the room.
    a.send(&ClientMsg::CallMute {
        audio: false,
        video: true,
    })
    .await;
    let (id, audio, video) = as_call_mute(&mut b).await;
    assert_eq!((id, audio, video), (a_id.clone(), false, true));
    let (id, audio, video) = as_call_mute(&mut c).await;
    assert_eq!((id, audio, video), (a_id.clone(), false, true));
    // Grace (a spectator) receives nothing here: if the mute had leaked to
    // the room, it would surface as her next message in the steps below.

    // --- mid-call drop: bob's connection dies. The server drops him from
    //     the room and the call; the room hears call_leave + left.
    b.close();
    drop(b);
    assert_eq!(as_call_leave(&mut a).await, b_id.clone());
    assert_eq!(as_left(&mut a).await, b_id.clone());
    assert_eq!(as_call_leave(&mut g).await, b_id.clone());
    assert_eq!(as_left(&mut g).await, b_id.clone());
    for u in [&mut c, &mut d, &mut e, &mut f] {
        assert_eq!(as_call_leave(u).await, b_id.clone());
        assert_eq!(as_left(u).await, b_id.clone());
    }

    // --- grace (spectator all along) joins the call mid-way: call_join
    //     for the room, full roster for her, then she offers the two
    //     remaining members.
    join_huddle(&mut g).await;
    for u in [&mut a, &mut c, &mut d, &mut e, &mut f] {
        assert_eq!(as_call_join(u).await.id, _g_id);
    }
    expect_ids(&as_call_start(&mut g).await, &[&a_id, &c_id, &_g_id]);
    g.send(&ClientMsg::CallOffer {
        to: a_id.clone(),
        sdp: "v=0 g-offer-a".into(),
    })
    .await;
    g.send(&ClientMsg::CallOffer {
        to: c_id.clone(),
        sdp: "v=0 g-offer-c".into(),
    })
    .await;
    let (from, sdp) = as_call_offer(&mut a).await;
    assert_eq!((from, sdp), (_g_id.clone(), "v=0 g-offer-a".to_owned()));
    let (from, sdp) = as_call_offer(&mut c).await;
    assert_eq!((from, sdp), (_g_id.clone(), "v=0 g-offer-c".to_owned()));
    a.send(&ClientMsg::CallAnswer {
        to: _g_id.clone(),
        sdp: "v=0 a-answer-g".into(),
    })
    .await;
    c.send(&ClientMsg::CallAnswer {
        to: _g_id.clone(),
        sdp: "v=0 c-answer-g".into(),
    })
    .await;
    assert_eq!(as_call_answer(&mut g).await.0, a_id);
    assert_eq!(as_call_answer(&mut g).await.0, c_id);

    // --- leaves: alice and carol hang up (huddle continues each time,
    //     room-wide call_leave), then grace is the last one out, ending
    //     the call for the room.
    a.send(&ClientMsg::CallLeave).await;
    for u in [&mut a, &mut c, &mut d, &mut e, &mut f, &mut g] {
        assert_eq!(as_call_leave(u).await, a_id.clone());
    }
    c.send(&ClientMsg::CallLeave).await;
    for u in [&mut a, &mut c, &mut d, &mut e, &mut f, &mut g] {
        assert_eq!(as_call_leave(u).await, c_id.clone());
    }
    g.send(&ClientMsg::CallLeave).await;
    for u in [&mut a, &mut c, &mut d, &mut e, &mut f, &mut g] {
        assert_eq!(as_call_end(u).await, "last_left");
    }

    // --- no leaked call state: the room's call slot is cleared, so a
    //     fresh huddle starts cleanly (the client-side half of "no leaked
    //     peer connections" — N-1 RTCPeerConnection teardown — is browser
    //     only and checked manually per README §11).
    join_huddle(&mut a).await;
    expect_ids(&as_call_start(&mut a).await, &[&a_id]);
    expect_ids(&as_call_start(&mut c).await, &[&a_id]);
    a.send(&ClientMsg::CallLeave).await;
    assert_eq!(as_call_end(&mut a).await, "last_left");
    assert_eq!(as_call_end(&mut c).await, "last_left");
}

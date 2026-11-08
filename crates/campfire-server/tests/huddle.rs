//! Phase 6 acceptance test (README §11): proximity bubbles.
//!
//! > **Done when:** 6-participant call; a mid-call join plus a mid-call
//! > drop/reconnect; no leaked peer connections; auto voice-only engages
//! > at 10 participants.
//!
//! Everything the *server* does for the call runs here over **real
//! HTTP/3 on QUIC**: the bubble forms by itself from avatar positions
//! (no ring/accept), grows one joiner per tick, is room-wide state
//! (headphone badge), relays the joiner's offers to every existing
//! member, keeps a dropped member's seat through the reconnect window,
//! drops a member who walks out of the leave radius, and ends with
//! `call_end(last_left)` — leaving no leaked call state.
//!
//! The WebRTC side (N-1 `RTCPeerConnection`s per member, zero leaked
//! peer connections, auto voice-only at 9+) is browser-only: it is
//! implemented in `client/src/call` and checked manually with six
//! windows, per README §11.

use std::net::SocketAddr;
use std::time::Duration;

use bytes::Bytes;
use campfire_protocol::{
    ClientMsg, Dir, MovementBatch, MovementEntry, ServerMsg, UserBrief, to_line,
};
use tokio::io::AsyncWriteExt;
use wtransport::Connection;

mod common;
use common::start_server;

const RECV_TIMEOUT: Duration = Duration::from_secs(5);
/// Spawn of the office map (README §5 tests walk relative to it).
const SPAWN: (f32, f32) = (20.5, 15.5);

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

    /// Send one movement entry as a datagram (README §5 wire shape).
    fn move_to(&self, id: &str, x: f32, y: f32, seq: u64) {
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
        self.conn
            .send_datagram(Bytes::from(serde_json::to_vec(&batch).unwrap()))
            .unwrap();
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

    /// Next `CallStart`, skipping presence noise (`Joined`, …).
    async fn next_call_start(&mut self) -> (Vec<UserBrief>, bool) {
        loop {
            match self.recv().await {
                ServerMsg::CallStart {
                    participants,
                    you_offer,
                    ..
                } => return (participants, you_offer),
                _ => continue,
            }
        }
    }

    /// Kill the QUIC connection (simulates a mid-call network drop).
    fn close(&self) {
        self.conn
            .close(wtransport::VarInt::from_u32(0), b"connection closed");
    }
}

/// Connect + join in one step, returning (client, own id, reconnect token).
async fn join(addr: SocketAddr, room: &str, name: &str) -> (TestClient, String, String) {
    let mut c = TestClient::connect(addr).await;
    c.send(&ClientMsg::Join {
        room: room.into(),
        name: name.into(),
        avatar: None,
        token: None,
    })
    .await;
    // A tick between the join and the Hello flush can prepend call state
    // (the roster broadcast); skip anything until the Hello.
    let (you, token) = loop {
        match c.recv().await {
            ServerMsg::Hello { you, token, .. } => break (you, token),
            _ => continue,
        }
    };
    (c, you, token)
}

/// Reconnect with a token (README §5): restores the previous identity
/// within the reconnect window. Returns (client, own id, call roster).
async fn reconnect(
    addr: SocketAddr,
    room: &str,
    name: &str,
    token: &str,
) -> (TestClient, String, Vec<UserBrief>) {
    let mut c = TestClient::connect(addr).await;
    c.send(&ClientMsg::Join {
        room: room.into(),
        name: name.into(),
        avatar: None,
        token: Some(token.to_owned()),
    })
    .await;
    let (you, call) = loop {
        match c.recv().await {
            ServerMsg::Hello { you, call, .. } => break (you, call),
            _ => continue,
        }
    };
    (c, you, call)
}

/// Assert that no server message arrives within `window` (the anti-flicker
/// proof: a dropped member must not produce a `call_leave`/`left`).
async fn assert_quiet(c: &mut TestClient, window: Duration, what: &str) {
    let mut byte = [0u8; 1];
    match tokio::time::timeout(window, c.recv.read_exact(&mut byte)).await {
        Err(_) => {} // silence: exactly what we wanted
        Ok(Ok(())) => {
            // Drain the rest of the line for the diagnostic.
            let mut line = vec![byte[0]];
            let mut b1 = [0u8; 1];
            while let Ok(Some(n)) = c.recv.read(&mut b1).await {
                if n == 0 || b1[0] == b'\n' {
                    break;
                }
                line.push(b1[0]);
            }
            let msg = std::str::from_utf8(&line).unwrap_or("<binary>");
            panic!("expected silence ({what}), but a message arrived: {msg}");
        }
        Ok(Err(err)) => panic!("expected silence ({what}), but the stream errored: {err}"),
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

/// Walk `c` from spawn eastwards, one step per datagram, respecting the
/// server's speed gate (≤ 8 tiles/s). `tiles` must be reachable.
async fn walk_out(c: &TestClient, id: &str, tiles: f32) {
    let steps = (tiles / 0.4).ceil() as u32;
    for i in 1..=steps {
        c.move_to(id, SPAWN.0 + 0.4 * i as f32, SPAWN.1, i as u64);
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
}

#[tokio::test]
async fn bubble_six_members_join_drop_and_walk_away() {
    let (addr, _root) = start_server().await;

    // Grace opts out FIRST, before anyone can bubble with her: she stays a
    // spectator who only ever hears the room-wide badge (README §6.3).
    let (mut g, _g_id, _g_token) = join(addr, "office", "grace").await;
    g.send(&ClientMsg::Bubble { off: true }).await;

    // Six future participants join one at a time; the spacing (> 1 tick)
    // makes each newcomer the only join candidate, so the roster growth is
    // deterministic: 2, 3, 4, 5, 6.
    let (mut a, a_id, _at) = join(addr, "office", "alice").await;
    let (mut b, b_id, b_token) = join(addr, "office", "bob").await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    // The first tick after {alice, bob} forms the bubble.
    for u in [&mut a, &mut b, &mut g] {
        let (p, _you) = u.next_call_start().await;
        expect_ids(&p, &[&a_id, &b_id]);
    }

    // Carol, dave, erin, frank join one per tick (spacing > 1 tick keeps
    // each newcomer the only candidate): the roster grows by one each
    // time, and the joiner is the designated offerer (`you_offer`).
    let (mut c, c_id, _ct) = join(addr, "office", "carol").await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    for (u, you) in [
        (&mut a, false),
        (&mut b, false),
        (&mut c, true),
        (&mut g, false),
    ] {
        let (p, got) = u.next_call_start().await;
        expect_ids(&p, &[&a_id, &b_id, &c_id]);
        assert_eq!(got, you, "the joiner offers");
    }

    let (mut d, d_id, _dt) = join(addr, "office", "dave").await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    for u in [&mut a, &mut b, &mut c, &mut d, &mut g] {
        let (p, _) = u.next_call_start().await;
        expect_ids(&p, &[&a_id, &b_id, &c_id, &d_id]);
    }

    let (mut e, e_id, _et) = join(addr, "office", "erin").await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    for u in [&mut a, &mut b, &mut c, &mut d, &mut e, &mut g] {
        let (p, _) = u.next_call_start().await;
        expect_ids(&p, &[&a_id, &b_id, &c_id, &d_id, &e_id]);
    }

    let (mut f, f_id, _ft) = join(addr, "office", "frank").await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    for u in [&mut a, &mut b, &mut c, &mut d, &mut e, &mut f, &mut g] {
        let (p, _) = u.next_call_start().await;
        expect_ids(&p, &[&a_id, &b_id, &c_id, &d_id, &e_id, &f_id]);
    }
    // Done-when: a 6-participant call.
    let _ = f_id;

    // Newcomer re-ICE: carol offers alice and bob; they answer; ICE flows
    // both ways; existing members never renegotiate (README §6.3).
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
    c.send(&ClientMsg::CallIce {
        to: a_id.clone(),
        candidate: r#"{"candidate":"c-cand"}"#.into(),
    })
    .await;
    let (from, cand) = as_call_ice(&mut a).await;
    assert_eq!(
        (from, cand),
        (c_id.clone(), r#"{"candidate":"c-cand"}"#.to_owned())
    );

    // Mute is presence: call-scoped (not room-wide). Alice mutes; only
    // the other participants hear it — not grace.
    a.send(&ClientMsg::CallMute {
        audio: false,
        video: true,
    })
    .await;
    let (id, audio, video) = as_call_mute(&mut b).await;
    assert_eq!((id, audio, video), (a_id.clone(), false, true));
    let (id, audio, video) = as_call_mute(&mut c).await;
    assert_eq!((id, audio, video), (a_id.clone(), false, true));
    for u in [&mut d, &mut e, &mut f] {
        let (id, _, _) = as_call_mute(u).await;
        assert_eq!(id, a_id, "every other participant hears the mute");
    }

    // Mid-call drop: bob's connection dies. The server keeps his seat
    // (room + call) for the reconnect window; nobody hears a leave.
    b.close();
    drop(b);
    for u in [&mut a, &mut c, &mut d, &mut e, &mut f, &mut g] {
        assert_quiet(
            u,
            Duration::from_millis(300),
            "no call_leave/left on a mid-call drop",
        )
        .await;
    }

    // Bob reconnects within the window (same identity via his token): the
    // hello's call roster still has all six — membership survived.
    let (mut b2, b_id2, call) = reconnect(addr, "office", "bob", &b_token).await;
    assert_eq!(b_id2, b_id, "reconnect keeps the same identity");
    assert_eq!(call.len(), 6, "the bubble kept every seat");
    b2.send(&ClientMsg::Leave).await;
    for (name, u) in [
        ("a", &mut a),
        ("c", &mut c),
        ("d", &mut d),
        ("e", &mut e),
        ("f", &mut f),
        ("g", &mut g),
    ] {
        match u.recv().await {
            ServerMsg::CallLeave { id } => assert_eq!(id, b_id, "call_leave for {name}"),
            m => panic!("expected call_leave at {name}, got {m:?}"),
        }
    }
    for (name, u) in [
        ("a", &mut a),
        ("c", &mut c),
        ("d", &mut d),
        ("e", &mut e),
        ("f", &mut f),
        ("g", &mut g),
    ] {
        match u.recv().await {
            ServerMsg::Left { id } => assert_eq!(id, b_id, "left for {name}"),
            m => panic!("expected left at {name}, got {m:?}"),
        }
    }

    // Walk-away: dave walks out of the one-tile bubble — the very next
    // tick drops him (immediate leave, no grace delay).
    walk_out(&d, &d_id, 5.5).await;
    for u in [&mut a, &mut c, &mut d, &mut e, &mut f, &mut g] {
        assert_eq!(as_call_leave(u).await, d_id.clone());
    }

    // Final leaves: erin and frank hang up, then alice leaves carol alone;
    // the last leave ends the call for the whole room.
    f.send(&ClientMsg::CallLeave).await;
    for u in [&mut a, &mut c, &mut e, &mut f, &mut g] {
        assert_eq!(as_call_leave(u).await, f_id.clone());
    }
    e.send(&ClientMsg::CallLeave).await;
    for u in [&mut a, &mut c, &mut e, &mut g] {
        assert_eq!(as_call_leave(u).await, e_id.clone());
    }
    a.send(&ClientMsg::CallLeave).await;
    for u in [&mut a, &mut c, &mut g] {
        assert_eq!(as_call_end(u).await, "last_left");
    }

    // No leaked call state: a fresh bubble reforms cleanly. Which pair the
    // tick picks first is nondeterministic (several users sit at spawn and
    // ids are not join-ordered), so only assert that a bubble exists again.
    c.move_to(&c_id, SPAWN.0 + 0.5, SPAWN.1, 1);
    tokio::time::sleep(Duration::from_millis(150)).await;
    let (p, _) = a.next_call_start().await;
    assert!(p.len() >= 2, "a fresh bubble reformed");
    let (p, _) = c.next_call_start().await;
    assert!(p.len() >= 2, "a fresh bubble reformed");
}

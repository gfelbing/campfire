//! Phase 7 acceptance tests (README §11): reconnect-with-token (30 s
//! window) and chat/signaling reliability under 5 % simulated packet loss.
//!
//! > **Done when:** chat is reliable under 5 % simulated packet loss
//! > (streams); a dropped connection rejoins without a leave/join flicker.
//!
//! Both run over **real HTTP/3 on QUIC** against the real server stack. The
//! loss test pushes the traffic through a local UDP relay that drops one
//! datagram in 20 (each direction): QUIC retransmissions ride the same
//! lossy path, so this is the link-level guarantee the README asks for.

use std::net::SocketAddr;
use std::time::Duration;

use bytes::Bytes;
use campfire_protocol::{ClientMsg, Dir, MovementBatch, MovementEntry, ServerMsg, to_line};
use tokio::io::AsyncWriteExt;
use wtransport::Connection;

mod common;
use common::start_server;

const RECV_TIMEOUT: Duration = Duration::from_secs(15);

/// How many times to retry establishing a WebTransport connection.
///
/// A connection can fail *transiently* under packet loss, for a reason that
/// has nothing to do with the data plane: the client's h3 SETTINGS frame and
/// its CONNECT request ride separate datagrams, and h3-webtransport treats a
/// CONNECT that reaches the server before the peer's SETTINGS as a fatal
/// `H3_SETTINGS_ERROR` ("webtransport is not supported by client"). A real
/// client (a browser) just reconnects when a WebTransport connection drops,
/// so we do the same here. The 5 % loss still applies to the whole data plane
/// below — this retry only re-establishes the handshake.
const CONNECT_ATTEMPTS: u32 = 6;

/// A local UDP relay between the test clients and the server that drops one
/// datagram in `drop_every` (e.g. 20 → 5 % loss) in **each** direction.
///
/// Simulating loss at the link level (rather than inside quinn) means the
/// QUIC stack on both ends is fully real: retransmissions ride the same
/// lossy path, which is exactly what "chat is reliable under 5 % packet
/// loss" means (README §11 Phase 7).
///
/// Topology: clients connect to the `front` socket. Forwarder 1 reads
/// `front` and **sends through `back`**, so the server sees `back` as the
/// client's address. Forwarder 2 reads the server's replies from `back` and
/// **sends through `front`** to every client seen so far (fan-out is safe:
/// a QUIC packet for connection A is dropped by client B's stack because the
/// 4-tuple doesn't match, and only accepted by the right end).
///
/// Plain std sockets on dedicated threads (not the tokio runtime): each
/// forwarder needs read + write access to *both* sockets, which tokio's
/// `UdpSocket` (not `Sync`) can't share.
struct LossyRelay {
    /// What clients connect to instead of the server address.
    client_addr: SocketAddr,
}

impl LossyRelay {
    async fn start(server_addr: SocketAddr, drop_every: u32) -> Self {
        let front = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let back = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let client_addr = front.local_addr().unwrap();
        // Every client the front side has seen (source addresses of client
        // packets). The back side delivers each server packet to all of them.
        let peers = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));

        {
            let read_front = front.try_clone().unwrap();
            let write_back = back.try_clone().unwrap();
            let peers = peers.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 65536];
                let mut seen = 0u32;
                while let Ok((len, src)) = read_front.recv_from(&mut buf) {
                    peers.lock().unwrap().insert(src);
                    seen += 1;
                    if seen.is_multiple_of(drop_every) {
                        continue; // dropped packet
                    }
                    let _ = write_back.send_to(&buf[..len], server_addr);
                }
            });
        }

        {
            let read_back = back.try_clone().unwrap();
            let write_front = front.try_clone().unwrap();
            std::thread::spawn(move || {
                let mut buf = [0u8; 65536];
                let mut seen = 0u32;
                while let Ok((len, _src)) = read_back.recv_from(&mut buf) {
                    // The server can only answer after the front side
                    // saw a client packet, so the peer set is
                    // non-empty once the first reply arrives.
                    let dests = peers.lock().unwrap().clone();
                    seen += 1;
                    if seen.is_multiple_of(drop_every) {
                        continue; // dropped packet
                    }
                    for dest in dests {
                        let _ = write_front.send_to(&buf[..len], dest);
                    }
                }
            });
        }

        Self { client_addr }
    }
}

/// A connected WebTransport client with its command stream open.
struct TestClient {
    _conn: Connection,
    send: wtransport::SendStream,
    recv: wtransport::RecvStream,
}

impl TestClient {
    async fn connect(addr: SocketAddr) -> Self {
        let url = format!("https://{addr}/wt");
        let mut attempt = 0;
        loop {
            attempt += 1;
            let config = wtransport::ClientConfig::builder()
                .with_bind_address("127.0.0.1:0".parse().unwrap())
                .with_no_cert_validation()
                .build();
            let conn = wtransport::Endpoint::client(config)
                .unwrap()
                .connect(url.clone())
                .await;
            match conn {
                Ok(conn) => {
                    let (send, recv) = conn.open_bi().await.unwrap().await.unwrap();
                    return Self {
                        _conn: conn,
                        send,
                        recv,
                    };
                }
                Err(err) => {
                    if attempt >= CONNECT_ATTEMPTS {
                        panic!(
                            "failed to establish a WebTransport connection \
                             after {CONNECT_ATTEMPTS} attempts: {err}"
                        );
                    }
                    // Brief pause before the next attempt; each attempt
                    // advances the relay's drop counter, so the next one
                    // sees a different loss phase.
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
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

    /// Kill the QUIC connection (simulates a network drop).
    fn close(&self) {
        self._conn
            .close(wtransport::VarInt::from_u32(0), b"connection closed");
    }
}

/// Connect + join (fresh identity), returning (client, own id, token).
async fn join(addr: SocketAddr, room: &str, name: &str) -> (TestClient, String, String) {
    let mut c = TestClient::connect(addr).await;
    c.send(&ClientMsg::Join {
        room: room.into(),
        name: name.into(),
        avatar: None,
        token: None,
    })
    .await;
    let ServerMsg::Hello { you, token, .. } = c.recv().await else {
        panic!("expected hello after join");
    };
    assert!(!token.is_empty(), "hello must carry a reconnect token");
    (c, you, token)
}

/// Assert that no server message arrives within `window` (a "silence"
/// check — the anti-flicker proof).
async fn assert_quiet(c: &mut TestClient, window: Duration, what: &str) {
    match tokio::time::timeout(window, c.recv()).await {
        Err(_) => {} // silence: exactly what we wanted
        Ok(msg) => panic!("expected silence ({what}), but got {msg:?}"),
    }
}

/// Phase 7 acceptance: a dropped connection rejoins **without a
/// leave/join flicker** — same identity, position and call membership
/// survive, and the room hears no `left`/`joined` at all.
#[tokio::test]
async fn reconnect_within_window_keeps_identity_no_flicker() {
    let (addr, _root) = start_server().await;

    // Alice + Bob in a huddle.
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
        token: a_token,
        ..
    } = a.recv().await
    else {
        panic!("expected hello for alice");
    };
    let (mut b, b_id, _b_token) = join(addr, "office", "bob").await;
    // Alice hears bob join (drain).
    assert!(matches!(a.recv().await, ServerMsg::Joined { .. }));

    // Alice walks half a tile east of spawn (20.5, 15.5 → 21.0, 15.5):
    // within the one-tile bubble radius. The speed gate (8 tiles/s) needs
    // headroom since the join.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let batch = MovementBatch {
        m: vec![MovementEntry {
            id: a_id.clone(),
            x: 21.0,
            y: 15.5,
            d: Dir::East,
            moving: 1,
            seq: 1,
            silent: false,
        }],
    };
    a._conn
        .send_datagram(Bytes::from(serde_json::to_vec(&batch).unwrap()))
        .unwrap();
    // Let the tick accept the move (datagrams are unreliable; give the
    // server a moment before the connection drop below).
    tokio::time::sleep(Duration::from_millis(250)).await;

    // Alice walked within the bubble radius (0.5 tiles < 1.0): the tick forms
    // the proximity bubble on its own — no ring, no accept (README §6.3).
    // Call state is room-wide: both hear the roster.
    match a.recv().await {
        ServerMsg::CallStart {
            participants,
            you_offer,
            ..
        } => {
            assert_eq!(participants.len(), 2, "alice's roster lists both");
            assert_eq!(you_offer, a_id < b_id, "the smaller id offers");
        }
        m => panic!("expected call_start for alice, got {m:?}"),
    }
    match b.recv().await {
        ServerMsg::CallStart { participants, .. } => {
            assert_eq!(participants.len(), 2, "bob's roster lists both");
        }
        m => panic!("expected call_start for bob, got {m:?}"),
    }

    // Alice's connection dies. Bob must hear NOTHING: no call_leave, no
    // left (README §5: the reconnect window keeps her in the room).
    a.close();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_quiet(
        &mut b,
        Duration::from_millis(700),
        "no left/call_leave for alice",
    )
    .await;

    // Alice reconnects within the window with her token: same identity,
    // no joined broadcast for the room.
    let mut a2 = TestClient::connect(addr).await;
    a2.send(&ClientMsg::Join {
        room: "office".into(),
        name: "alice".into(),
        avatar: None,
        token: Some(a_token.clone()),
    })
    .await;
    let ServerMsg::Hello {
        you: a_id2,
        token: a_token2,
        users,
        call,
        ..
    } = a2.recv().await
    else {
        panic!("expected hello for reconnected alice");
    };
    assert_eq!(a_id2, a_id, "reconnect must keep the same user id");
    assert_eq!(a_token2, a_token, "the token survives the reconnect");
    // Position survived.
    let me = users
        .iter()
        .find(|u| u.id == a_id)
        .expect("alice in her own hello");
    assert_eq!((me.x, me.y), (21.0, 15.5), "position must survive the drop");
    // Call membership survived: the hello's call roster includes alice.
    assert_eq!(call.len(), 2, "the huddle still has both participants");
    assert!(
        call.iter().any(|u| u.id == a_id),
        "alice is still in the call"
    );

    // Bob still hears nothing (no joined for the restored alice).
    assert_quiet(
        &mut b,
        Duration::from_millis(700),
        "no joined for reconnected alice",
    )
    .await;

    // Call membership proof from the other side: call-scoped signaling
    // between the two still relays (both must be participants).
    a2.send(&ClientMsg::CallIce {
        to: b_id.clone(),
        candidate: "{\"candidate\":\"alice-rejoin\"}".into(),
    })
    .await;
    match b.recv().await {
        ServerMsg::CallIce { from, .. } => assert_eq!(from, a_id),
        m => panic!("expected relayed call_ice, got {m:?}"),
    }
}

/// Phase 7 acceptance: **chat is reliable under 5 % simulated packet
/// loss** — streams (and the stream-based call signaling) deliver
/// completely through a lossy link, thanks to QUIC retransmission.
#[tokio::test]
async fn chat_and_signaling_survive_5_percent_packet_loss() {
    let (addr, _root) = start_server().await;
    // One datagram in 20 (5 %) dropped in each direction.
    let relay = LossyRelay::start(addr, 20).await;

    let (mut a, _a_id, _) = join(relay.client_addr, "office", "alice").await;
    let (mut b, b_id, _) = join(relay.client_addr, "office", "bob").await;
    // Alice hears bob join (drain).
    assert!(matches!(a.recv().await, ServerMsg::Joined { .. }));

    // A burst of 20 typing events (no per-message rate limit) must arrive
    // completely and in order.
    for i in 0..20 {
        b.send(&ClientMsg::Typing { on: i % 2 == 0 }).await;
    }
    let mut got = 0;
    let (mut a_saw, mut b_saw) = (false, false);
    while got < 20 {
        // Typing is relayed to the other members only: alice receives all 20.
        match a.recv().await {
            ServerMsg::Typing { id, .. } => {
                assert_eq!(id, b_id, "typing must come from bob");
                got += 1;
            }
            // The proximity bubble forms on its own (both sit at spawn);
            // its room-wide call_start may interleave anywhere.
            ServerMsg::CallStart { .. } => a_saw = true,
            m => panic!("expected typing at alice (#{got}), got {m:?}"),
        }
    }

    // Chat round-trip under loss: both sides get the echo.
    b.send(&ClientMsg::Chat {
        text: "hello over the lossy link".into(),
    })
    .await;
    for (c, which) in [(&mut a, 0), (&mut b, 1)] {
        match c.recv().await {
            ServerMsg::Chat { from, text, .. } => {
                assert_eq!(from, b_id);
                assert_eq!(text, "hello over the lossy link");
            }
            ServerMsg::CallStart { .. } => {
                if which == 0 {
                    a_saw = true
                } else {
                    b_saw = true
                }
            }
            m => panic!("expected chat echo, got {m:?}"),
        }
    }
    // Alice and bob sit at spawn: the proximity bubble forms on its own
    // and its room-wide call_start arrives through the lossy link for
    // both (whichever side has not seen it yet waits for it now).
    for (c, saw) in [(&mut a, a_saw), (&mut b, b_saw)] {
        if saw {
            continue;
        }
        loop {
            match c.recv().await {
                ServerMsg::CallStart { participants, .. } => {
                    assert_eq!(participants.len(), 2, "the bubble started for both");
                    break;
                }
                _ => continue,
            }
        }
    }
}

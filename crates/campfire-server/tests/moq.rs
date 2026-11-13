//! Phase 1 acceptance tests (docs/moq-sfu.md §9): the SFU wired into the
//! production server. A spike-style client (moq-net over a `wtransport`
//! WebTransport connection, exactly the Phase 0 tier-1 client) publishes
//! and subscribes through the real `/moq/{ticket}` route with a minted
//! media ticket, and a user outside the call is rejected.
//!
//! The realtime `/wt` channel and the MoQ `/moq` channel are separate
//! WebTransport connections to the same server, mirroring the production
//! layout (docs/moq-sfu.md §3).

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use campfire_protocol::{ClientMsg, ServerMsg, to_line};
use moq_net::Timescale;
use tokio::io::AsyncWriteExt;
use wtransport::Connection;

mod common;
use common::start_server_with_world;
#[path = "moq_client_wt.rs"]
mod client_wt;

/// Cap on any single wait, so a broken server fails the test instead of
/// hanging it.
const RECV_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to let the 50 ms tick settle the bubble state before asserting.
const SETTLE: Duration = Duration::from_millis(400);

type WtEndpoint = wtransport::Endpoint<wtransport::endpoint::endpoint_side::Client>;

// ── /wt realtime client (same shape as `tests/call.rs`) ───────────────────

struct WtClient {
    /// Held so the QUIC connection stays open.
    _conn: Connection,
    send: wtransport::SendStream,
    recv: wtransport::RecvStream,
}

impl WtClient {
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
        campfire_protocol::from_line(std::str::from_utf8(&buf).unwrap()).unwrap()
    }

    /// Drain messages until a `CallStart` carrying a media ticket arrives
    /// (this user is a call participant), returning the ticket. `None` on
    /// timeout — a bystander never gets one.
    async fn recv_ticket(&mut self) -> Option<String> {
        let deadline = Instant::now() + RECV_TIMEOUT;
        while Instant::now() < deadline {
            let msg = match tokio::time::timeout(Duration::from_millis(500), self.recv()).await {
                Ok(m) => m,
                Err(_) => break,
            };
            if let ServerMsg::CallStart {
                ticket: Some(t), ..
            } = msg
            {
                return Some(t);
            }
        }
        None
    }
}

/// Connect + join, returning (client, own id). A joiner into a room with a
/// running call gets a catch-up `CallStart` (bystander: no ticket) before
/// their own `Hello`.
async fn join(addr: SocketAddr, room: &str, name: &str) -> (WtClient, String) {
    let mut c = WtClient::connect(addr).await;
    c.send(&ClientMsg::Join {
        room: room.into(),
        name: name.into(),
        avatar: None,
        token: None,
        status: None,
    })
    .await;
    loop {
        let msg = c.recv().await;
        match msg {
            ServerMsg::Hello { you, .. } => return (c, you),
            ServerMsg::CallStart { .. } => continue,
            other => panic!("expected hello after join for {name}, got {other:?}"),
        }
    }
}

// ── /moq client (the Phase 0 spike client, moq-net over wtransport) ──────

/// A connected MoQ session: the `Session` handle is kept alive for the life
/// of the test (dropping the last handle aborts the session), and the local
/// `origin` is what the test publishes into / subscribes from.
struct MoqClient {
    _session: moq_net::Session,
    origin: moq_net::origin::Producer,
}

fn endpoint() -> WtEndpoint {
    let config = wtransport::ClientConfig::builder()
        .with_bind_address("127.0.0.1:0".parse().unwrap())
        .with_no_cert_validation()
        .build();
    wtransport::Endpoint::client(config).unwrap()
}

/// Connect a MoQ session to `/moq/{ticket}`, retrying the whole
/// WebTransport and MoQ handshake on failure (the h3 SETTINGS race,
/// `docs/moq-sfu.md` / spike `connect_session`). A rejected ticket (403
/// before the upgrade) also surfaces here as a connect error, so a failed
/// admission and a flaky connect are both retried — bounded, so a genuine
/// rejection still fails. Tickets are single-use, so a retry only ever
/// succeeds when the earlier attempt failed before the ticket was consumed
/// (the h3 race does).
async fn connect_moq(
    ep: &WtEndpoint,
    addr: SocketAddr,
    ticket: Option<&str>,
) -> Result<MoqClient, String> {
    let url = match ticket {
        Some(t) => format!("https://{addr}/moq/{t}"),
        None => format!("https://{addr}/moq"),
    };
    const MAX_ATTEMPTS: u32 = 40;
    let mut last_err = String::new();
    for _ in 1..=MAX_ATTEMPTS {
        match try_connect_moq(ep, &url).await {
            Ok(c) => return Ok(c),
            Err(e) => {
                last_err = e;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    Err(last_err)
}

async fn try_connect_moq(ep: &WtEndpoint, url: &str) -> Result<MoqClient, String> {
    // A local origin, exactly like the spike client: the session reads local
    // announces from it and writes remote announces into it.
    let (origin, origin_driver) =
        moq_net::origin::Producer::new(moq_net::origin::Config::new(moq_net::Hop::random()));
    tokio::spawn(async move {
        let _ = moq_net::time::run(origin_driver).await;
    });
    let wt_conn = ep
        .connect(wtransport::endpoint::ConnectOptions::builder(url))
        .await
        .map_err(|e| format!("webtransport connect failed: {e}"))?;
    let session = moq_tokio::transport::Session::new(client_wt::Session::new(wt_conn));
    let client = moq_net::Client::new().with_origin(origin.clone());
    let (moq_session, driver) = client
        .connect(Instant::now(), session)
        .await
        .map_err(|e| format!("moq setup failed: {e}"))?;
    tokio::spawn(async move {
        let _ = moq_net::time::run(driver).await;
    });
    Ok(MoqClient {
        _session: moq_session,
        origin,
    })
}

/// Unwrap an admitted session, naming it on failure (`MoqClient` is not
/// `Debug`, so `Result::expect` is not usable).
fn moq_ok(result: Result<MoqClient, String>, what: &str) -> MoqClient {
    match result {
        Ok(c) => c,
        Err(e) => panic!("{what}: {e}"),
    }
}

/// Assert a connection was rejected (the admission failure path).
fn moq_rejected(result: Result<MoqClient, String>, what: &str) {
    if result.is_ok() {
        panic!("{what}: unexpectedly admitted");
    }
}

// ── tests ─────────────────────────────────────────────────────────────────

/// Two co-located users form a call; each `call_start` carries its own
/// minted ticket; one publishes her namespace and the other subscribes to
/// it, with the SFU (per-call origin) fanning the frames out.
#[tokio::test]
async fn publish_and_subscribe_within_a_call() {
    let (addr, _root, _world) = start_server_with_world().await;
    let ep = endpoint();
    let (mut a, a_id) = join(addr, "office", "alice").await;
    let (mut b, _b_id) = join(addr, "office", "bob").await;
    let Some(ticket_a) = a.recv_ticket().await else {
        panic!("alice got no media ticket");
    };
    let Some(ticket_b) = b.recv_ticket().await else {
        panic!("bob got no media ticket");
    };
    assert_ne!(ticket_a, ticket_b, "each participant gets their own ticket");

    // Both connect to the SFU with their minted tickets.
    let a_moq = moq_ok(
        connect_moq(&ep, addr, Some(&ticket_a)).await,
        "alice's /moq session",
    );
    let b_moq = moq_ok(
        connect_moq(&ep, addr, Some(&ticket_b)).await,
        "bob's /moq session",
    );

    // Alice publishes her own namespace (`call/<room>/<user-id>`) and
    // streams fifty audio frames at 20 ms intervals — the spike shape
    // (docs/moq-sfu.md §9): the publisher streams live while the
    // subscriber joins.
    let path = format!("call/office/{a_id}");
    let info = moq_net::track::Info::default().with_timescale(Timescale::MICRO);
    let bcast = a_moq
        .origin
        .publish(&path, moq_net::origin::Route::default())
        .expect("alice publishes");
    let mut track = bcast.create_track("a", info).expect("audio track");
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let writer = tokio::spawn(async move {
        for i in 0..50u64 {
            let ts = moq_net::Timestamp::from_micros(i * 20_000).unwrap();
            if track
                .write_frame(ts, format!("frame-{i}").into_bytes())
                .is_err()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Hold the track open like a live publisher until the test is done,
        // then finish it cleanly.
        let _ = stop_rx.await;
        let _ = track.finish();
    });

    // Bob joins mid-stream, 300 ms in (the spike join-delay shape). The
    // Lite02 wire carries no max age and starts a new subscriber at the
    // live edge (no backlog replay), so he gets the frames that follow —
    // groups ~15..49.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let consumer = b_moq.origin.consume();
    let b_bcast = tokio::time::timeout(Duration::from_secs(5), consumer.routed_broadcast(&path))
        .await
        .expect("timed out waiting for alice's announce")
        .expect("alice's announce");
    let b_track = b_bcast.track("a").expect("audio track");
    let mut b_sub = b_track
        .subscribe(moq_net::track::Subscription::default().with_max_age(Duration::from_secs(2)))
        .await
        .expect("bob subscribes");

    // Bob reads the live frames back through the SFU.
    let mut got = 0u64;
    let deadline = Instant::now() + RECV_TIMEOUT;
    while got < 10 && Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), b_sub.recv_group()).await {
            Ok(Ok(Some(mut group))) => loop {
                match group.read_frame().await {
                    Ok(Some(_frame)) => {
                        got += 1;
                        if got >= 10 {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => panic!("read_frame error: {e}"),
                }
            },
            Ok(Ok(None)) => panic!("subscription ended (recv_group None)"),
            Ok(Err(e)) => panic!("recv_group error: {e}"),
            Err(_) => eprintln!("recv_group timeout, continuing"),
        }
    }
    stop_tx.send(()).ok();
    writer.await.expect("writer task");
    assert!(
        got >= 10,
        "bob received {got} live frames from alice through the SFU"
    );
}

/// A user in the room but outside the call has no media ticket: connecting
/// to `/moq` with no ticket, and with a ticket that is not a live one, is
/// both rejected (403 before the WebTransport upgrade).
#[tokio::test]
async fn outsider_without_ticket_is_rejected() {
    let (addr, _root, world) = start_server_with_world().await;
    let ep = endpoint();
    let (mut a, _a_id) = join(addr, "office", "alice").await;
    let (mut b, _b_id) = join(addr, "office", "bob").await;
    let Some(_) = a.recv_ticket().await else {
        panic!("alice got no media ticket");
    };
    let Some(_) = b.recv_ticket().await else {
        panic!("bob got no media ticket");
    };

    // Carol joins the room but opts out of the bubble: she is in the room
    // but not the call, so the world mints her no ticket.
    let (_c, c_id) = join(addr, "office", "carol").await;
    world.set_bubble("office", &c_id, true).unwrap();

    // No ticket at all → rejected.
    moq_rejected(connect_moq(&ep, addr, None).await, "a missing ticket");
    // A ticket that names no live call/user → rejected.
    let bogus = "deadbeef".repeat(8);
    moq_rejected(connect_moq(&ep, addr, Some(&bogus)).await, "a bogus ticket");
}

/// A media ticket is bound to the call id it was minted for. When that call
/// ends, the ticket is dead even though a *new* call (new id) later forms in
/// the same room; only a freshly minted ticket is admitted.
#[tokio::test]
async fn stale_ticket_after_call_end_is_rejected() {
    let (addr, _root, _world) = start_server_with_world().await;
    let ep = endpoint();
    let (mut a, _a_id) = join(addr, "office", "alice").await;
    let (mut b, _b_id) = join(addr, "office", "bob").await;
    let Some(ticket_a) = a.recv_ticket().await else {
        panic!("alice got no media ticket");
    };
    let _ = b.recv_ticket().await;

    // The live ticket is admitted.
    let _live = moq_ok(
        connect_moq(&ep, addr, Some(&ticket_a)).await,
        "the live ticket",
    );

    // Alice hangs up: the two-person call ends (bob is left alone).
    a.send(&ClientMsg::CallLeave).await;
    tokio::time::sleep(SETTLE).await;

    // The old ticket is now dead: the call it named no longer exists.
    moq_rejected(
        connect_moq(&ep, addr, Some(&ticket_a)).await,
        "the stale ticket (dead call id)",
    );

    // The bubble re-forms (alice and bob are still co-located) with a new
    // call id, and alice is minted a fresh ticket.
    let Some(ticket_a2) = a.recv_ticket().await else {
        panic!("no fresh ticket after the call re-formed");
    };
    assert_ne!(
        ticket_a, ticket_a2,
        "a re-formed call gets a new id and ticket"
    );
    // The fresh ticket is admitted — proving the earlier rejection was the
    // dead call id, not a blanket block of alice.
    let _fresh = moq_ok(
        connect_moq(&ep, addr, Some(&ticket_a2)).await,
        "the fresh ticket",
    );
}

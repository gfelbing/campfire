//! Regression test for the `moq-tokio` adapter over the in-memory mock
//! transport (`asyncmockwt`). A publisher client writes a broadcast into a
//! shared SFU origin and a subscriber client reads it back, the whole path
//! run through the moq-tokio adapter's poll→async bridge. No real QUIC, no
//! h3wt/client_wt bridge: if the uplink stalls here the adapter is at fault;
//! if it flows the adapter is exonerated and any stall is in the WebTransport
//! bridges under real QUIC.

use std::{str::FromStr, time::Duration};

use moq_spike::asyncmockwt::create_async_mock_pair;
use moq_spike::mockwt_harness::run;
use moq_net::Version;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let version = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "moq-lite-02".into());
    let version = Version::from_str(&version).expect("version name");
    tracing::info!(?version, "adapter-repro starting");

    // The publisher's origin (client side).
    let (client_origin, cd) = moq_net::origin::Producer::new(moq_net::origin::Config::new(
        moq_net::Hop::random(),
    ));
    tokio::spawn(async move {
        let _ = run(cd).await;
    });

    // The SFU: one shared origin, both directions.
    let (sfu, sd) = moq_net::origin::Producer::new(moq_net::origin::Config::new(
        moq_net::Hop::random(),
    ));
    tokio::spawn(async move {
        let _ = run(sd).await;
    });

    // The adapter under test: async mock session wrapped in the poll
    // `moq-net` consumes, exactly as the spike wraps its real bridges.
    let protocol = version.alpn();
    let (client_async, server_async) = create_async_mock_pair(Some(protocol));
    let client_transport = moq_tokio::transport::Session::new(client_async);
    let server_transport = moq_tokio::transport::Session::new(server_async);

    let client = moq_net::Client::new()
        .with_versions(version.into())
        .with_publisher(client_origin.consume());
    let server = moq_net::Server::new()
        .with_versions(version.into())
        .with_publisher(sfu.consume())
        .with_subscriber(sfu.clone());

    let client_fut = async {
        let (session, driver) = client
            .connect(run_now(), client_transport)
            .await
            .expect("client handshake");
        tokio::spawn(run(driver));
        session
    };
    let server_fut = async {
        let (session, driver) = server
            .accept(run_now(), server_transport)
            .await
            .expect("server handshake");
        tokio::spawn(run(driver));
        session
    };
    let (client_session, server_session) = tokio::join!(client_fut, server_fut);
    let _ = &client_session;
    let _ = &server_session;
    tracing::info!("handshake complete, both drivers running");

    // Client: publish the broadcast and stream one frame per group, 20 ms apart.
    let publish = client_origin
        .publish("p0", moq_net::origin::Route::default())
        .expect("publish");
    let info = moq_net::track::Info::default().with_timescale(moq_net::Timescale::MICRO);
    let a = publish.create_track("a", info).expect("track");

    tokio::spawn(async move {
        let start = std::time::Instant::now();
        let mut seq = 0u64;
        let mut w = a;
        loop {
            let now_us = start.elapsed().as_micros() as u64;
            let ts = moq_net::Timestamp::from_micros(now_us).expect("ts");
            if w.write_frame(ts, vec![0x5A; 320]).is_err() {
                tracing::error!(seq, "write_frame failed");
                break;
            }
            if seq % 50 == 0 {
                tracing::info!(seq, "client wrote group");
            }
            seq += 1;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });

    // Server/SFU: read the uplink from the shared origin, count groups for 5 s.
    let consumer = sfu.consume();
    let broadcast = tokio::time::timeout(Duration::from_secs(10), consumer.routed_broadcast("p0"))
        .await
        .expect("announce timeout")
        .expect("broadcast");
    let mut sub = broadcast.track("a").expect("track").subscribe(None).await.expect("sub");

    let mut seen = 0u64;
    let mut last = 0u64;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        tokio::select! {
            res = sub.recv_group() => match res {
                Ok(Some(group)) => {
                    seen += 1;
                    if seen <= 5 || group.sequence - last >= 50 {
                        tracing::info!(seq = group.sequence, seen, "sfu received group");
                        last = group.sequence;
                    }
                }
                Ok(None) => {
                    tracing::info!(seen, "sfu track finished");
                    break;
                }
                Err(err) => {
                    tracing::error!(%err, seen, "sfu recv_group error");
                    break;
                }
            },
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                tracing::info!(seen, "deadline reached");
                break;
            }
        }
    }
    Ok(())
}

fn run_now() -> moq_net::time::Instant {
    tokio::time::Instant::now().into_std()
}

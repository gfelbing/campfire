//! Tier-1 spike client (docs/moq-sfu.md Phase 0): `moq-net` sessions over
//! `wtransport` WebTransport client connections — no browser.
//!
//! One process opens a publisher session (fake media frames stamped with
//! `run_start.elapsed()` at write time) and N subscriber sessions that fan
//! out through the spike SFU, measuring latency, first-frame time and frame
//! gaps. All sessions share one clock, so
//! `latency = rx_time - run_start - stamp` is glass-to-glass latency without
//! clock sync (same machine, `Instant` = CLOCK_MONOTONIC).
//!
//! Output: one JSON object on stdout (consumed by the justfile target that
//! generates docs/moq-spike-results.md).

use std::{
    path::PathBuf,
    process,
    time::{Duration, Instant},
};

use anyhow::Result;
use clap::Parser;
use moq_spike::{client_wt, tls, Bridge};
use tracing::{debug, info, warn};

type WtEndpoint = wtransport::endpoint::Endpoint<wtransport::endpoint::endpoint_side::Client>;

#[derive(Parser, Debug)]
#[command(name = "moq-spike-client", about = "MoQ spike client (publisher + N subscribers)")]
struct Args {
    /// WebTransport URL of the spike SFU, e.g. https://localhost:4443/moq
    #[arg(long)]
    url: String,

    /// Broadcast path published/subscribed. Unique per run keeps a shared
    /// SFU origin from leaking one run's cached groups into the next.
    #[arg(long, default_value = "call/spike/p0")]
    path: String,

    /// Path the subscriber sessions subscribe to (default: `--path`).
    /// Against the app server (docs/moq-sfu.md Phase 1) point this at the
    /// `call/<room>/<user-id>` namespace another client publishes, while
    /// `--path` keeps this client's own publish unique.
    #[arg(long)]
    sub_path: Option<String>,

    /// PEM file of the CA that signed the server certificate.
    #[arg(long, default_value = "certs/ca.pem")]
    ca: PathBuf,

    /// Number of subscriber sessions (fan-out factor).
    #[arg(long, default_value_t = 3)]
    subscribers: usize,

    /// Measurement window per subscriber, from subscribe start.
    #[arg(long, default_value = "30s")]
    duration: String,

    /// Fake video frame size in bytes (default ~ one 720p VP8 frame).
    #[arg(long, default_value_t = 12000)]
    video_bytes: usize,

    /// Video frame interval (default 40 ms ≈ 25 fps).
    #[arg(long, default_value = "40ms")]
    video_interval: String,

    /// Fake audio frame size in bytes (~20 ms of Opus).
    #[arg(long, default_value_t = 320)]
    audio_bytes: usize,

    /// Audio frame interval (default 20 ms).
    #[arg(long, default_value = "20ms")]
    audio_interval: String,

    /// Delay before the subscribers start (publisher streams first). Tests
    /// new-subscriber fast-start (gates T3/T7): a subscriber joins a
    /// publisher that already has groups in flight. The publisher runs
    /// `duration + join_delay` so every subscriber still gets a full
    /// `duration` window.
    #[arg(long, default_value = "0ms")]
    join_delay: String,

    /// How old a subscribed group may get before the subscriber gives up
    /// on it (MoQ `Subscriber Max Age`). The 1 s default rides out the
    /// T4/T5 reordering window without adding steady-state delay (the
    /// budget is only consumed when newer data is already that far
    /// ahead). `0s` disables the budget: a group is skipped the instant
    /// a newer one arrives, which drops scattered groups under jitter.
    #[arg(long, default_value = "1s")]
    max_age: String,

    /// Media ticket for the app server (docs/moq-sfu.md §7): every session
    /// this client opens is admitted with it (`?ticket=…` on the URL).
    #[arg(long)]
    ticket: Option<String>,

    /// Skip the publisher session: pure subscriber, the media is published
    /// by another client (the Phase 2 e2e browser uplink).
    #[arg(long)]
    no_publish: bool,

    /// Do not strip the 8-byte send-stamp prefix from frames (spike
    /// publisher convention). For foreign publishers (browser media) the
    /// receive time is the stamp; latency stats read as ~0 and are
    /// meaningless, sample/byte counts are not.
    #[arg(long)]
    no_stamp: bool,
}

/// Parse `30s`, `500ms`, `1.5s`, `250us` or bare seconds.
fn parse_duration(s: &str) -> Result<Duration, String> {
    let unit: String = s.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    let num: f64 = s
        .trim_end_matches(|c: char| c.is_ascii_alphabetic())
        .parse::<f64>()
        .map_err(|e| e.to_string())?;
    let secs = match unit.as_str() {
        "s" | "" => num,
        "ms" => num / 1000.0,
        "us" => num / 1_000_000.0,
        other => return Err(format!("bad duration unit {other:?} in {s:?}")),
    };
    Ok(Duration::from_secs_f64(secs))
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "moq_spike=debug,info".into()),
        )
        .init();

    let args = Args::parse();
    let duration = parse_duration(&args.duration).map_err(|e| anyhow::anyhow!(e))?;
    let video_interval = parse_duration(&args.video_interval).map_err(|e| anyhow::anyhow!(e))?;
    let audio_interval = parse_duration(&args.audio_interval).map_err(|e| anyhow::anyhow!(e))?;
    let join_delay = parse_duration(&args.join_delay).map_err(|e| anyhow::anyhow!(e))?;
    let max_age = parse_duration(&args.max_age).map_err(|e| anyhow::anyhow!(e))?;
    // One shared wall clock for the whole run: the publisher stamps frames
    // from it, subscribers measure against it.
    let run_start = Instant::now();
    let cpu_start = cpu_time();

    // One WebTransport client endpoint for all sessions.
    let rustls_conf = tls::client_rustls_config(&args.ca)?;
    let mut quic_transport = tls::media_transport_config();
    quic_transport.max_idle_timeout(Some(
        quinn::IdleTimeout::try_from(std::time::Duration::from_secs(300))
            .expect("idle timeout within varint limit"),
    ));
    let config = wtransport::ClientConfig::builder()
        .with_bind_default()
        .with_custom_tls_and_transport(rustls_conf, quic_transport)
        .build();
    let endpoint = wtransport::Endpoint::client(config)?;

    let path = args.path.clone();
    let mut wt_url = args.url.trim_end_matches('/').to_string();
    if let Some(ticket) = &args.ticket {
        // The ticket is 32 hex bytes: URL-safe as-is, no encoding needed.
        wt_url.push_str(&format!("?ticket={ticket}"));
    }

    // --- publisher session --------------------------------------------------
    // In pure-subscriber mode (`--no-publish`, the Phase 2 e2e) the media is
    // published by another client; this process only subscribes.
    let (publisher, pub_task) = if args.no_publish {
        (None, None)
    } else {
        let publisher = connect_session(&endpoint, &wt_url).await?;
        info!(?publisher.version, "publisher connected");

        let b = publisher
            .origin
            .publish(&path, moq_net::origin::Route::default())
            .expect("publishing local broadcast");
        let track_info = moq_net::track::Info::default().with_timescale(moq_net::Timescale::MICRO);
        let mut v = b
            .create_track("v", track_info.clone())
            .expect("creating video track");
        let mut a = b.create_track("a", track_info).expect("creating audio track");
        let video_fill = vec![0xA5u8; args.video_bytes];
        let audio_fill = vec![0x5Au8; args.audio_bytes];
        let video_every = (video_interval.as_millis() / audio_interval.as_millis()).max(1) as u64;
        // The publisher outlives a late-joining subscriber by the join delay,
        // so every subscriber still gets a full `duration` measurement window.
        let pub_duration = duration + join_delay;

        let pub_task = tokio::spawn(async move {
            let deadline = run_start + pub_duration;
            let mut tick = 0u64;
            loop {
                let now_us = run_start.elapsed().as_micros() as u64;
                let ts = moq_net::Timestamp::from_micros(now_us).expect("timestamp in range");
                // Lite02 wire carries no frame timestamp (receivers re-stamp
                // local receive time), so the send stamp rides in the payload:
                // u64 LE microseconds since run_start, stripped in `reader_task`.
                let stamp = now_us.to_le_bytes();
                if tick.is_multiple_of(video_every) {
                    let mut payload = Vec::with_capacity(8 + video_fill.len());
                    payload.extend_from_slice(&stamp);
                    payload.extend_from_slice(&video_fill);
                    if v.write_frame(ts, payload).is_err() {
                        break;
                    }
                }
                let mut payload = Vec::with_capacity(8 + audio_fill.len());
                payload.extend_from_slice(&stamp);
                payload.extend_from_slice(&audio_fill);
                if a.write_frame(ts, payload).is_err() {
                    break;
                }
                tick += 1;
                if Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(audio_interval).await;
            }
        });
        (Some(publisher), Some(pub_task))
    };

    // --- subscriber sessions -------------------------------------------------
    let mut handles = Vec::new();
    let mut subscriber_version: Option<moq_net::Version> = None;
    let stamp_prefix = !args.no_stamp;
    for i in 0..args.subscribers {
        let subscriber = connect_session(&endpoint, &wt_url).await?;
        info!(subscriber = i, "connected");
        if subscriber_version.is_none() {
            subscriber_version = Some(subscriber.version);
        }
        let path = args.sub_path.clone().unwrap_or_else(|| path.clone());
        handles.push(tokio::spawn(async move {
            // The session handle must live until the task ends: dropping it
            // aborts the session (moq-net treats it as the app giving up).
            let MoqSession { session, origin, .. } = subscriber;
            // Late join (fast-start, gates T3/T7): the publisher has been
            // streaming since run_start; measure from the subscribe moment.
            if join_delay > Duration::ZERO {
                tokio::time::sleep(join_delay).await;
            }
            let stats = match run_subscriber(origin, &path, run_start, duration, max_age, stamp_prefix).await {
                Ok(stats) => stats,
                Err(err) => {
                    warn!(subscriber = i, %err, "subscriber failed");
                    serde_json::json!({ "error": err.to_string(), "subscriber": i })
                }
            };
            drop(session);
            stats
        }));
    }

    let mut subscriber_stats = Vec::new();
    for handle in handles {
        subscriber_stats.push(handle.await.expect("subscriber task joined"));
    }

    // Let the publisher wind down, then report.
    if let Some(pub_task) = pub_task {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = pub_task.await;
    }

    let result = serde_json::json!({
        "url": args.url,
        "negotiated_version": publisher
            .as_ref()
            .map(|p| format!("{:?}", p.version))
            .or_else(|| subscriber_version.map(|v| format!("{v:?}"))),
        "max_age_ms": max_age.as_millis() as u64,
        "duration_s": run_start.elapsed().as_secs_f64(),
        "cpu_seconds": cpu_time() - cpu_start,
        "connect_retries": CONNECT_RETRIES.load(std::sync::atomic::Ordering::Relaxed),
        "subscribers": subscriber_stats,
    });
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

/// A connected MoQ session with its local origin: local publishes are
/// announced from it, remote announcements land in it.
struct MoqSession {
    /// Kept alive for the whole run: dropping the last `Session` handle
    /// aborts the session with a `Cancel`/"dropped" close (moq-net
    /// supervisor treats it as the app giving up).
    session: moq_net::Session,
    origin: moq_net::origin::Producer,
    version: moq_net::Version,
}

/// Failed connect attempts that needed a retry, across all sessions of
/// this run (the h3 SETTINGS race; see `connect_session`).
static CONNECT_RETRIES: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// Connect a MoQ session, retrying the whole WebTransport + MoQ handshake
/// on failure. The client's h3 SETTINGS frame (control stream) can arrive
/// after the CONNECT request (request stream); h3-webtransport 0.1.2
/// treats not-yet-parsed SETTINGS as "client without WebTransport" and
/// rejects the connection with H3_SETTINGS_ERROR (code 265). Jitter makes
/// this frequent, not just loss: netem's independent per-packet delay
/// draws reorder SETTINGS vs CONNECT, so each attempt is a coin flip.
/// Bounded budget (100 × ~30 ms + connect time) covers the tail without
/// masking a genuine outage.
async fn connect_session(endpoint: &WtEndpoint, url: &str) -> Result<MoqSession> {
    const MAX_ATTEMPTS: u32 = 100;
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        match try_connect_session(endpoint, url).await {
            Ok(session) => return Ok(session),
            Err(err) => {
                CONNECT_RETRIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                warn!(attempt, %err, "moq connect failed, retrying");
                last_err = Some(err);
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("connect failed after {MAX_ATTEMPTS} attempts")))
}

async fn try_connect_session(
    endpoint: &WtEndpoint,
    url: &str,
) -> Result<MoqSession> {
    let (origin, origin_driver) =
        moq_net::origin::Producer::new(moq_net::origin::Config::new(moq_net::Hop::random()));
    tokio::spawn(async move {
        let _ = moq_net::time::run(origin_driver).await;
    });

    let wt_conn = endpoint
        .connect(wtransport::endpoint::ConnectOptions::builder(url))
        .await
        .map_err(|e| anyhow::anyhow!("webtransport connect failed: {e}"))?;
    let session = Bridge::new(client_wt::Session::new(wt_conn));
    // Publish and subscribe through the same local origin, like the SFU's
    // shared origin on the server: the session reads local announces from it
    // and writes remote announces into it.
    let client = moq_net::Client::new().with_origin(origin.clone());
    let (moq_session, driver) = client
        .connect(std::time::Instant::now(), session)
        .await
        .map_err(|e| anyhow::anyhow!("moq setup failed: {e}"))?;
    let version = moq_session.version();
    tokio::spawn(async move {
        let _ = moq_net::time::run(driver).await;
    });
    debug!("moq session established (version {version:?})");
    Ok(MoqSession { session: moq_session, origin, version })
}

/// Subscribe to the publisher's broadcast and measure frame delivery.
async fn run_subscriber(
    origin: moq_net::origin::Producer,
    path: &str,
    run_start: Instant,
    duration: Duration,
    max_age: Duration,
    stamp_prefix: bool,
) -> Result<serde_json::Value> {
    let consumer = origin.consume();
    let subscribe_start = Instant::now();
    // Waits for the SFU's announce of the publisher's broadcast and retries
    // as the covering routes move (request_broadcast fails at once while no
    // announced route covers the path yet).
    let broadcast = consumer
        .routed_broadcast(path)
        .await
        .map_err(|e| anyhow::anyhow!("broadcast request failed: {e}"))?;
    info!(broadcast = %broadcast.info().path, "broadcast announced");

    // One reader task per track; frames ride an mpsc with their local
    // receive time.
    let mut tracks = Vec::new();
    // The default `Subscription::max_age` is ZERO: a group is abandoned the
    // instant a newer one arrives. Under jitter that drops scattered
    // groups, so the run opts into a reordering budget (see `--max-age`).
    let subscription = moq_net::track::Subscription::default().with_max_age(max_age);
    for name in ["v", "a"] {
        let track = broadcast
            .track(name)
            .map_err(|e| anyhow::anyhow!("track {name} unavailable: {e}"))?;
        let subscriber = track
            .subscribe(subscription.clone())
            .await
            .map_err(|e| anyhow::anyhow!("subscribe {name} failed: {e}"))?;
        let (tx, rx) = tokio::sync::mpsc::channel::<(u128, u64, Instant)>(512);
        tracks.push((name, rx));
        tokio::spawn(reader_task(name, subscriber, tx, run_start, stamp_prefix));
    }

    let deadline = subscribe_start + duration;
    // Collect raw samples and reorder them by send stamp before measuring:
    // the wire reorders under jitter and loss retransmission, so the stats
    // describe what a consumer with a reorder buffer sees (see
    // finish_stats).
    let mut video_raw: Vec<(u128, u64, Instant)> = Vec::new();
    let mut audio_raw: Vec<(u128, u64, Instant)> = Vec::new();

    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let (v_rx, a_rx) = match tracks.as_mut_slice() {
            [(name1, r1), (name2, r2)] if *name1 == "v" => (r1, r2),
            [(name1, r1), (name2, r2)] if *name2 == "v" => (r2, r1),
            _ => unreachable!("exactly two tracks"),
        };
        tokio::select! {
            maybe = v_rx.recv() => {
                let Some(sample) = maybe else { break };
                video_raw.push(sample);
            }
            maybe = a_rx.recv() => {
                let Some(sample) = maybe else { break };
                audio_raw.push(sample);
            }
            _ = tokio::time::sleep(deadline - now) => break,
        }
    }

    Ok(serde_json::json!({
        "video": finish_stats(&video_raw, run_start, subscribe_start),
        "audio": finish_stats(&audio_raw, run_start, subscribe_start),
    }))
}

/// Reorder a window's samples by send stamp (consumer reorder buffer, no
/// drop window) and compute the delivery stats.
fn finish_stats(
    raw: &[(u128, u64, Instant)],
    run_start: Instant,
    subscribe_start: Instant,
) -> serde_json::Value {
    let mut samples: Vec<(u128, u64, Instant)> = raw.to_vec();
    samples.sort_by_key(|s| s.0);
    let mut stats = FrameStats::default();
    let mut last_stamp: Option<u128> = None;
    let mut last_rx: Option<Instant> = None;
    for (stamp, bytes, rx) in &samples {
        if stats.first_rx.is_none() {
            stats.first_rx = Some(*rx);
        }
        if let Some(last) = last_stamp {
            let gap_ms = (*stamp - last) as f64 / 1000.0;
            if gap_ms > 100.0 {
                stats.gaps_gt_100ms += 1;
            }
            if gap_ms > stats.max_gap_ms {
                stats.max_gap_ms = gap_ms;
            }
        }
        if let Some(lrx) = last_rx {
            let rx_gap_ms = rx.saturating_duration_since(lrx).as_secs_f64() * 1000.0;
            if rx_gap_ms > stats.max_rx_gap_ms {
                stats.max_rx_gap_ms = rx_gap_ms;
            }
        }
        last_rx = Some(*rx);
        last_stamp = Some(*stamp);
        let latency = rx
            .duration_since(run_start)
            .as_micros() as i128
            - *stamp as i128;
        if latency >= 0 {
            stats.push(latency as u128, *bytes);
        }
    }
    stats.into_json(subscribe_start)
}

/// Drains one subscribed track until it ends, forwarding frames.
/// `recv_group` delivers in arrival order (gaps are not waited for); the
/// main loop reorders by send stamp before measuring.
async fn reader_task(
    name: &str,
    subscriber: moq_net::track::Subscriber,
    tx: tokio::sync::mpsc::Sender<(u128, u64, Instant)>,
    run_start: Instant,
    stamp_prefix: bool,
) {
    let mut sub = subscriber;
    // Count the groups the cursor hands out and how each one ends; the
    // end-of-track log is the spike's delivery funnel diagnostic.
    let mut group_count = 0u64;
    let mut empty_groups = 0u64;
    let mut err_groups = 0u64;
    while let Ok(Some(mut group)) = sub.recv_group().await {
        group_count += 1;
        let mut frames = 0u64;
        loop {
            match group.read_frame().await {
                Ok(Some(frame)) => {
                    frames += 1;
                    let rx = Instant::now();
                    // With the spike's own publisher the payload embeds a u64
                    // LE send stamp (the wire's own timestamp is a local
                    // receive stamp under Lite02 and unusable); with a foreign
                    // publisher (browser media, `--no-stamp`) the whole payload
                    // is body and the receive time is the stamp.
                    let (stamp_us, body_len) = if stamp_prefix {
                        let payload = &frame.payload;
                        if payload.len() < 8 {
                            continue;
                        }
                        let mut stamp_buf = [0u8; 8];
                        stamp_buf.copy_from_slice(&payload[..8]);
                        (u64::from_le_bytes(stamp_buf) as u128, payload.len() as u64 - 8)
                    } else {
                        (
                            rx.saturating_duration_since(run_start).as_micros(),
                            frame.payload.len() as u64,
                        )
                    };
                    if tx.send((stamp_us, body_len, rx)).await.is_err() {
                        return;
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    err_groups += 1;
                    tracing::debug!(track = name, group = group_count, %err, "reader: group read error");
                    break;
                }
            }
        }
        if frames == 0 {
            empty_groups += 1;
        }
    }
    tracing::debug!(track = name, group_count, empty_groups, err_groups, "reader: track ended");
}

#[derive(Default)]
struct FrameStats {
    samples: Vec<u128>,
    first_rx: Option<Instant>,
    gaps_gt_100ms: u64,
    max_gap_ms: f64,
    /// Largest gap in *receive* time between consecutive frames (send-stamp
    /// order): a frame that arrived late stalls the consumer even though the
    /// stamp sequence is unbroken. This is the "video freeze" / "stall" the
    /// T5/T6 gates bound.
    max_rx_gap_ms: f64,
    bytes: u64,
}

impl FrameStats {
    fn push(&mut self, latency_us: u128, n_bytes: u64) {
        self.samples.push(latency_us);
        self.bytes += n_bytes;
    }

    fn into_json(self, subscribe_start: Instant) -> serde_json::Value {
        let mut s = self.samples;
        s.sort_unstable();
        let p = |q: f64| -> f64 {
            if s.is_empty() {
                return 0.0;
            }
            let idx = (q / 100.0 * s.len() as f64).min(s.len() as f64 - 1.0) as usize;
            s[idx] as f64
        };
        // Time from the subscribe request to the first delivered frame: the
        // fast-start metric (gate T3).
        let first_frame_ms =
            self.first_rx.map(|rx| rx.saturating_duration_since(subscribe_start).as_millis() as f64);
        serde_json::json!({
            "samples": s.len(),
            "p50_us": p(50.0),
            "p95_us": p(95.0),
            "p99_us": p(99.0),
            "max_us": s.last().copied().unwrap_or(0) as f64,
            "first_frame_ms": first_frame_ms,
            "gaps_gt_100ms": self.gaps_gt_100ms,
            "max_gap_ms": self.max_gap_ms,
            "max_rx_gap_ms": self.max_rx_gap_ms,
            "bytes": self.bytes,
        })
    }
}

/// Process CPU time in seconds (user + system), from /proc (Linux).
fn cpu_time() -> f64 {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{}/stat", process::id())) else {
        return 0.0;
    };
    // The comm field can contain spaces: split after the last ')'.
    let rest = match stat.rsplit(')').next() {
        Some(rest) => rest,
        None => return 0.0,
    };
    let fields: Vec<f64> = rest
        .split_whitespace()
        .filter_map(|f| f.parse::<f64>().ok())
        .collect();
    // Fields after ')': state(0) ppid(1) ... utime(11) stime(12)
    let tick = 100.0; // USER_HZ
    if fields.len() > 12 {
        (fields[11] + fields[12]) / tick
    } else {
        0.0
    }
}

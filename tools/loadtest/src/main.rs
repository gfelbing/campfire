//! Campfire load harness (README §11 Phase 9, targets in §13).
//!
//! Ramps `--users` bot connections over real QUIC/WebTransport against a
//! running campfire server. Each bot:
//!
//! * joins a room (spread across `--rooms`),
//! * walks at the client's real cadence — 0.4-tile steps every 60 ms
//!   (~6.7 tiles/s, under the 8 tiles/s validator gate) — with direction
//!   changes, so the server validates and rebroadcasts real movement,
//! * a fraction of the bots are clustered into `--groups` meeting points of
//!   `--group-size`, which the server's bubble engine turns into calls
//!   (README §6.3); group members then toggle mute to
//!   exercise the call-state path without real media,
//! * occasionally chats (within the 1 msg/s room limit).
//!
//! It reports its own view — connect latency, inbound messages/s, errors —
//! every `--report-secs` and a final summary. Server-side truth (tick
//! latency, datagram totals) comes from `GET /metrics` over HTTP/3,
//! scraped by whatever drives the run (see README §15).
//!
//! Turn OFF cert validation like the test suite: load runs target a dev
//! server with the local CA.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::Result;
use bytes::Bytes;
use campfire_protocol::{
    ChatScope, ClientMsg, Dir, MovementBatch, MovementEntry, ServerMsg, from_line, to_line,
};
use clap::Parser;
use tokio::io::AsyncWriteExt as _;

/// Everything counted across all bots; printed as a rate in the reports.
#[derive(Default)]
struct Stats {
    connects: AtomicU64,
    connect_errors: AtomicU64,
    sessions_dropped: AtomicU64,
    msgs_in: AtomicU64,
    datagrams_in: AtomicU64,
    datagrams_out: AtomicU64,
    chats: AtomicU64,
    call_starts: AtomicU64,
    connect_us_total: AtomicU64,
}

#[derive(Parser, Debug)]
#[command(about)]
struct Args {
    /// WebTransport URL of the server (the /wt endpoint).
    #[arg(long, default_value = "https://127.0.0.1:8443/wt")]
    url: String,

    /// Total bots to reach.
    #[arg(long, default_value_t = 50)]
    users: u32,

    /// Ramp-up window in seconds (bots join evenly across it).
    #[arg(long, default_value_t = 10)]
    ramp: u64,

    /// Distinct rooms the bots spread across.
    #[arg(long, default_value_t = 4)]
    rooms: u32,

    /// Clusters of bots parked on one tile to form bubbles (calls).
    #[arg(long, default_value_t = 2)]
    groups: u32,

    /// Bots per cluster (2..=8 makes a voice call; 9+ is voice-only).
    #[arg(long, default_value_t = 3)]
    group_size: u32,

    /// How long the run lasts after the ramp (0 = forever, Ctrl-C ends it).
    #[arg(long, default_value_t = 120)]
    duration: u64,

    /// Report interval in seconds.
    #[arg(long, default_value_t = 10)]
    report: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let stats = Arc::new(Stats::default());
    let deadline = if args.duration == 0 {
        None
    } else {
        Some(Instant::now() + Duration::from_secs(args.ramp + args.duration))
    };

    // One QUIC config for the whole run; each bot owns its endpoint.
    // Real room ids: the server only accepts joins into map rooms
    // (README §5); `--rooms` caps how many of them the bots spread over.
    // Maps load from disk (README §6): same default dir as the server.
    let maps = campfire_maps::Maps::load(Path::new("maps"));
    let rooms: Vec<String> = {
        let mut ids: Vec<String> = maps.all().iter().map(|m| m.id.clone()).collect();
        ids.sort();
        ids.truncate(args.rooms.max(1) as usize);
        if ids.is_empty() {
            vec!["island".to_owned()]
        } else {
            ids
        }
    };
    // Group meeting points (one per group): distinct walkable tiles on the
    // map each group parks in (round-robin rooms, same as the bots), where
    // the server's bubble engine auto-forms a call from co-location.
    let group_points: Vec<(f32, f32)> = {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for g in 0..args.groups as usize {
            *counts.entry(rooms[g % rooms.len()].clone()).or_insert(0) += 1;
        }
        let mut lists: HashMap<String, Vec<(f32, f32)>> = HashMap::new();
        let mut next: HashMap<String, usize> = HashMap::new();
        let mut pts = Vec::with_capacity(args.groups as usize);
        for g in 0..args.groups as usize {
            let room = &rooms[g % rooms.len()];
            if !lists.contains_key(room) {
                let list = maps
                    .get(room)
                    .map(|m| meeting_points(m, counts[room]))
                    .unwrap_or_default();
                lists.insert(room.clone(), list);
            }
            let i = next.get(room).copied().unwrap_or(0);
            next.insert(room.clone(), i + 1);
            if let Some(p) = lists[room].get(i) {
                pts.push(*p);
            }
        }
        pts
    };

    println!(
        "loadtest: {} users -> {} (ramp {}s, {} rooms, {} groups of {}, {}s)",
        args.users, args.url, args.ramp, args.rooms, args.groups, args.group_size, args.duration
    );

    let mut joins = tokio::task::JoinSet::new();
    let stagger = if args.users > 0 {
        Duration::from_millis((args.ramp * 1000 / u64::from(args.users)).max(1))
    } else {
        Duration::from_secs(1)
    };
    for i in 0..args.users {
        let is_group_bot = i < args.groups * args.group_size;
        let group = if is_group_bot {
            Some(i / args.group_size)
        } else {
            None
        };
        let room = group
            .and_then(|g| rooms.get((g as usize) % rooms.len()).cloned())
            .unwrap_or_else(|| rooms[i as usize % rooms.len()].clone());
        let name = format!("load-{i:04}");
        let (map_size, spawn) = maps
            .get(&room)
            .map(|m| ((m.width, m.height), m.spawn))
            .unwrap_or(((40, 30), (20.5, 15.5)));
        joins.spawn(bot(
            args.url.clone(),
            room,
            name,
            group.and_then(|g| group_points.get(g as usize).copied()),
            map_size,
            spawn,
            stats.clone(),
        ));
        tokio::time::sleep(stagger).await;
    }

    // Reports + deadline.
    let report_stats = stats.clone();
    let report_every = Duration::from_secs(args.report.max(1));
    tokio::spawn(async move {
        let mut last = (0u64, 0u64, 0u64, 0u64, 0u64);
        let mut last_at = Instant::now();
        loop {
            tokio::time::sleep(report_every).await;
            let now = (
                report_stats.msgs_in.load(Ordering::Relaxed),
                report_stats.datagrams_in.load(Ordering::Relaxed),
                report_stats.datagrams_out.load(Ordering::Relaxed),
                report_stats.chats.load(Ordering::Relaxed),
                report_stats.call_starts.load(Ordering::Relaxed),
            );
            let dt = last_at.elapsed().as_secs_f64().max(0.001);
            println!(
                "msgs/s {:8.0}  dg_in/s {:8.0}  dg_out/s {:8.0}  chats/s {:5.1}  calls+ {}  conns {}  err {}  drop {}",
                (now.0 - last.0) as f64 / dt,
                (now.1 - last.1) as f64 / dt,
                (now.2 - last.2) as f64 / dt,
                (now.3 - last.3) as f64 / dt,
                now.4 - last.4,
                report_stats.connects.load(Ordering::Relaxed),
                report_stats.connect_errors.load(Ordering::Relaxed),
                report_stats.sessions_dropped.load(Ordering::Relaxed),
            );
            last = now;
            last_at = Instant::now();
        }
    });

    while joins.join_next().await.is_some() {
        if deadline.is_some_and(|d| Instant::now() >= d) {
            break;
        }
    }
    let total_connect = stats.connect_us_total.load(Ordering::Relaxed);
    println!(
        "done: {} connects (mean {:.0} ms), {} drops, {} connect errors, {} call starts",
        stats.connects.load(Ordering::Relaxed),
        if total_connect > 0 {
            total_connect as f64 / stats.connects.load(Ordering::Relaxed) as f64 / 1000.0
        } else {
            0.0
        },
        stats.sessions_dropped.load(Ordering::Relaxed),
        stats.connect_errors.load(Ordering::Relaxed),
        stats.call_starts.load(Ordering::Relaxed),
    );
    Ok(())
}

/// One bot: connect, join, then walk / chat / signal until the deadline or
/// an unrecoverable error. Drops are counted, not fatal to the run.
async fn bot(
    url: String,
    room: String,
    name: String,
    group_point: Option<(f32, f32)>,
    map_size: (u32, u32),
    spawn: (f32, f32),
    stats: Arc<Stats>,
) {
    let started = Instant::now();
    // One endpoint per bot (wtransport endpoints are not shareable clones);
    // each binds its own ephemeral UDP port, like real browsers do.
    let endpoint = match wtransport::Endpoint::client(
        wtransport::ClientConfig::builder()
            .with_bind_address("127.0.0.1:0".parse().unwrap())
            .with_no_cert_validation()
            .build(),
    ) {
        Ok(endpoint) => endpoint,
        Err(_) => {
            stats.connect_errors.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    let conn = match endpoint.connect(url.clone()).await {
        Ok(conn) => conn,
        Err(_) => {
            stats.connect_errors.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    stats.connects.fetch_add(1, Ordering::Relaxed);
    stats
        .connect_us_total
        .fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);

    let Ok(opened) = conn.open_bi().await else {
        stats.connect_errors.fetch_add(1, Ordering::Relaxed);
        return;
    };
    let Ok((mut send, mut recv)) = opened.await else {
        stats.connect_errors.fetch_add(1, Ordering::Relaxed);
        return;
    };
    if send
        .write_all(
            to_line(&ClientMsg::Join {
                room: room.clone(),
                name: name.clone(),
                avatar: None,
                token: None,
                status: None,
            })
            .as_bytes(),
        )
        .await
        .is_err()
        || send.flush().await.is_err()
    {
        stats.connect_errors.fetch_add(1, Ordering::Relaxed);
        return;
    }
    // Skip until our hello (room-wide call broadcasts may interleave).
    loop {
        match next_msg(&mut recv).await {
            Some(ServerMsg::Hello { .. }) => break,
            Some(_) => {}
            None => return,
        }
    }

    // Inbound datagrams: the 50 ms tick batches (README §5). They must be
    // drained or the server's datagram queue would eventually stall.
    let stats_dg = stats.clone();
    let dg_conn = conn.clone();
    let dg_reader = tokio::spawn(async move {
        while let Ok(_dg) = dg_conn.receive_datagram().await {
            stats_dg.datagrams_in.fetch_add(1, Ordering::Relaxed);
        }
    });

    // Inbound drain: count every line, watch call starts.
    let stats_in = stats.clone();
    let in_call = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader_in_call = in_call.clone();
    let reader = tokio::spawn(async move {
        while let Some(msg) = next_msg(&mut recv).await {
            stats_in.msgs_in.fetch_add(1, Ordering::Relaxed);
            if let ServerMsg::CallStart { participants, .. } = msg {
                stats_in.call_starts.fetch_add(1, Ordering::Relaxed);
                // A CallStart broadcast reaches everyone in the room; the
                // bot only relays signaling when the roster is non-empty
                // (i.e. it is in the bubble).
                reader_in_call.store(!participants.is_empty(), Ordering::Relaxed);
            }
        }
    });

    // Walk + chat + (for group bots) signaling relay.

    // Free bots start at the map's spawn (known walkable).
    let mut x = group_point.map_or(spawn.0, |(x, _)| x);
    let mut y = group_point.map_or(spawn.1, |(_, y)| y);
    let mut dir = Dir::East;
    let mut seq: u64 = rand::random();
    let mut step: u32 = 0;
    let chat_every: u64 = if group_point.is_none() {
        90 + (seq % 120)
    } else {
        0
    };
    loop {
        tokio::time::sleep(Duration::from_millis(60)).await;
        // Group bots hold their tile (the bubble needs co-location); free
        // bots wander with occasional direction changes.
        if group_point.is_none() {
            if seq.is_multiple_of(25) {
                dir = match seq % 4 {
                    0 => Dir::East,
                    1 => Dir::West,
                    2 => Dir::North,
                    _ => Dir::South,
                };
            }
            let (dx, dy) = match dir {
                Dir::East => (0.4, 0.0),
                Dir::West => (-0.4, 0.0),
                Dir::North => (0.0, -0.4),
                Dir::South => (0.0, 0.4),
            };
            // Stay on the map (bounds from the room's map).
            if !(1.0..map_size.0 as f32 - 1.0).contains(&(x + dx)) {
                dir = Dir::West;
            }
            if !(1.0..map_size.1 as f32 - 1.0).contains(&(y + dy)) {
                dir = Dir::South;
            }
            let (dx, dy) = match dir {
                Dir::East => (0.4, 0.0),
                Dir::West => (-0.4, 0.0),
                Dir::North => (0.0, -0.4),
                Dir::South => (0.0, 0.4),
            };
            x += dx;
            y += dy;
        }
        seq = seq.wrapping_add(1);
        step += 1;
        let batch = MovementBatch {
            m: vec![MovementEntry {
                id: name.clone(),
                x: (x * 10.0).round() / 10.0,
                y: (y * 10.0).round() / 10.0,
                d: dir,
                moving: u8::from(group_point.is_none()),
                seq,
                silent: false,
            }],
        };
        stats.datagrams_out.fetch_add(1, Ordering::Relaxed);
        if conn
            .send_datagram(Bytes::from(serde_json::to_vec(&batch).unwrap()))
            .is_err()
        {
            break; // connection died
        }
        if chat_every > 0 && u64::from(step) % chat_every == 0 {
            stats.chats.fetch_add(1, Ordering::Relaxed);
            if send
                .write_all(
                    to_line(&ClientMsg::Chat {
                        text: "load ping".into(),
                        scope: ChatScope::Room,
                    })
                    .as_bytes(),
                )
                .await
                .is_err()
                || send.flush().await.is_err()
            {
                break;
            }
        }
        // Group bots exercise the room-wide call fan-out by sending mute
        // toggles once a call exists.
        if group_point.is_some() && step.is_multiple_of(50) && in_call.load(Ordering::Relaxed) {
            let msg = ClientMsg::CallMute {
                audio: step % 100 < 50,
                video: false,
            };
            if send.write_all(to_line(&msg).as_bytes()).await.is_err()
                || send.flush().await.is_err()
            {
                break;
            }
        }
    }
    stats.sessions_dropped.fetch_add(1, Ordering::Relaxed);
    reader.abort();
    dg_reader.abort();
    conn.close(0u32.into(), b"loadtest done");
}

/// `n` distinct, spread walkable points on `map` for group bubbles: a
/// raster scan with a stride so the points spread out, then a fine scan to
/// fill, and finally the spawn tile as a last resort (groups sharing a tile
/// merge into one big bubble, which is fine for load).
fn meeting_points(map: &campfire_maps::MapData, n: usize) -> Vec<(f32, f32)> {
    if n == 0 {
        return Vec::new();
    }
    let (w, h) = (map.width, map.height);
    let stride = (w.min(h) as usize / n).clamp(1, 64);
    let mut pts: Vec<(f32, f32)> = Vec::with_capacity(n);
    for y in (0..h).step_by(stride) {
        for x in (0..w).step_by(stride) {
            if map.tile_walkable(x, y) {
                pts.push((x as f32 + 0.5, y as f32 + 0.5));
                if pts.len() >= n {
                    return pts;
                }
            }
        }
    }
    let mut seen: std::collections::HashSet<(u32, u32)> =
        pts.iter().map(|&(px, py)| (px as u32, py as u32)).collect();
    'fill: for y in 0..h {
        for x in 0..w {
            if map.tile_walkable(x, y) && seen.insert((x, y)) {
                pts.push((x as f32 + 0.5, y as f32 + 0.5));
                if pts.len() >= n {
                    break 'fill;
                }
            }
        }
    }
    while pts.len() < n {
        pts.push(map.spawn);
    }
    pts
}

async fn next_msg(recv: &mut wtransport::RecvStream) -> Option<ServerMsg> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match recv.read_exact(&mut byte).await {
            Ok(()) if byte[0] == b'\n' => break,
            Ok(()) => line.push(byte[0]),
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&line);
    from_line::<ServerMsg>(&text).ok()
}

//! Prometheus metrics at `GET /metrics` (docs/ops/README.md).
//!
//! Hand-rolled text exposition (the 0.0.4 format) instead of a metrics
//! crate: the counters are a handful of atomics and a dependency (and its
//! transitive heap) buys nothing here. Counters are `AtomicU64`; gauges
//! that describe the world (users/rooms/calls) are computed from the
//! world at scrape time, so they are always consistent with what a
//! concurrent tick is doing.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Every metric the server exposes. Cheap to clone: all counters live
/// behind one `Arc`.
#[derive(Clone, Default)]
pub struct Metrics {
    inner: Arc<Counters>,
}

/// The actual counters ([`Metrics`] is the cheap-clone handle).
#[derive(Default)]
struct Counters {
    /// QUIC connections currently open; `conn_total` is all-time.
    conns: AtomicU64,
    conn_total: AtomicU64,
    /// WebTransport sessions currently open; `session_total` is all-time.
    sessions: AtomicU64,
    session_total: AtomicU64,
    /// Inbound movement datagrams / bytes (docs/arch/protocol.md).
    dg_in: AtomicU64,
    dg_in_bytes: AtomicU64,
    /// Outbound tick batches / bytes.
    dg_out: AtomicU64,
    dg_out_bytes: AtomicU64,
    /// Rejected requests by the rate limiters (docs/ops/README.md).
    rate_limit_hits: AtomicU64,
    /// Tick-loop time: total seconds spent inside `World::tick` and how
    /// many ticks ran (scrape → mean; spikes show up in the rate).
    tick_micros: AtomicU64,
    ticks: AtomicU64,
    /// MoQ SFU media sessions (docs/arch/moq-sfu.md): currently open,
    /// all-time admitted, and rejected at CONNECT (missing/bad ticket or
    /// the ticket's call no longer active with the user in it).
    moq_sessions: AtomicU64,
    moq_session_total: AtomicU64,
    moq_session_rejected: AtomicU64,
}

/// MoQ SFU gauges that live outside [`Counters`]: the per-call media
/// origins and the media traffic, read from the SFU's moq-net stats
/// registry at scrape time (docs/arch/moq-sfu.md).
#[derive(Clone, Copy, Default)]
pub struct MoqGauges {
    /// Live per-call media origins.
    pub origins: u64,
    /// Media objects published into the SFU.
    pub objects_in: u64,
    /// Media bytes published into the SFU.
    pub bytes_in: u64,
    /// Media objects served out to subscribers.
    pub objects_out: u64,
    /// Media bytes served out to subscribers.
    pub bytes_out: u64,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn conn_open(&self) {
        self.inner.conns.fetch_add(1, Ordering::Relaxed);
        self.inner.conn_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn conn_close(&self) {
        self.inner.conns.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn session_open(&self) {
        self.inner.sessions.fetch_add(1, Ordering::Relaxed);
        self.inner.session_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn session_close(&self) {
        self.inner.sessions.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn datagram_in(&self, bytes: usize) {
        self.inner.dg_in.fetch_add(1, Ordering::Relaxed);
        self.inner
            .dg_in_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub fn datagram_out(&self, bytes: usize) {
        self.inner.dg_out.fetch_add(1, Ordering::Relaxed);
        self.inner
            .dg_out_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    pub fn rate_limit_hit(&self) {
        self.inner.rate_limit_hits.fetch_add(1, Ordering::Relaxed);
    }

    /// Record one tick's wall-clock duration.
    pub fn tick(&self, micros: u64) {
        self.inner.tick_micros.fetch_add(micros, Ordering::Relaxed);
        self.inner.ticks.fetch_add(1, Ordering::Relaxed);
    }

    pub fn moq_session_open(&self) {
        self.inner.moq_sessions.fetch_add(1, Ordering::Relaxed);
        self.inner.moq_session_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn moq_session_close(&self) {
        self.inner.moq_sessions.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn moq_session_reject(&self) {
        self.inner
            .moq_session_rejected
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Render the exposition format. `world_gauges` is
    /// `(users, rooms, calls)` from the world at scrape time; `moq` carries
    /// the SFU's gauges (live origins + media traffic, docs/arch/moq-sfu.md).
    pub fn render(&self, world_gauges: (u64, u64, u64), moq: &MoqGauges) -> String {
        let (users, rooms, calls) = world_gauges;
        let g = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let f = |a: &AtomicU64| a.load(Ordering::Relaxed) as f64;
        let mut out = String::with_capacity(2048);
        fn metric(out: &mut String, kind: &str, name: &str, help: &str, value: f64) {
            out.push_str(&format!(
                "# HELP {name} {help}\n# TYPE {name} {kind}\n{name} {value}\n"
            ));
        }

        metric(
            &mut out,
            "gauge",
            "campfire_connections",
            "QUIC connections currently open.",
            g(&self.inner.conns) as f64,
        );
        metric(
            &mut out,
            "counter",
            "campfire_connections_total",
            "QUIC connections accepted (all-time).",
            f(&self.inner.conn_total),
        );
        metric(
            &mut out,
            "gauge",
            "campfire_wt_sessions",
            "WebTransport sessions currently open.",
            g(&self.inner.sessions) as f64,
        );
        metric(
            &mut out,
            "counter",
            "campfire_wt_sessions_total",
            "WebTransport sessions opened (all-time).",
            f(&self.inner.session_total),
        );
        metric(
            &mut out,
            "gauge",
            "campfire_users",
            "Users currently in all rooms.",
            users as f64,
        );
        metric(
            &mut out,
            "gauge",
            "campfire_rooms",
            "Rooms currently occupied.",
            rooms as f64,
        );
        metric(
            &mut out,
            "gauge",
            "campfire_calls",
            "Rooms with an active bubble (docs/arch/protocol.md).",
            calls as f64,
        );
        metric(
            &mut out,
            "counter",
            "campfire_datagrams_in_total",
            "Inbound movement datagrams.",
            f(&self.inner.dg_in),
        );
        metric(
            &mut out,
            "counter",
            "campfire_datagrams_in_bytes_total",
            "Inbound datagram bytes.",
            f(&self.inner.dg_in_bytes),
        );
        metric(
            &mut out,
            "counter",
            "campfire_datagrams_out_total",
            "Outbound tick-batch datagrams.",
            f(&self.inner.dg_out),
        );
        metric(
            &mut out,
            "counter",
            "campfire_datagrams_out_bytes_total",
            "Outbound datagram bytes.",
            f(&self.inner.dg_out_bytes),
        );
        metric(
            &mut out,
            "counter",
            "campfire_rate_limit_hits_total",
            "Requests rejected by rate limiters.",
            f(&self.inner.rate_limit_hits),
        );
        metric(
            &mut out,
            "counter",
            "campfire_tick_seconds_total",
            "Time spent in the world tick loop.",
            f(&self.inner.tick_micros) / 1e6,
        );
        metric(
            &mut out,
            "counter",
            "campfire_ticks_total",
            "World ticks executed.",
            f(&self.inner.ticks),
        );
        metric(
            &mut out,
            "gauge",
            "campfire_moq_sessions",
            "MoQ media sessions currently open (docs/arch/moq-sfu.md).",
            g(&self.inner.moq_sessions) as f64,
        );
        metric(
            &mut out,
            "counter",
            "campfire_moq_sessions_total",
            "MoQ media sessions admitted (all-time).",
            f(&self.inner.moq_session_total),
        );
        metric(
            &mut out,
            "counter",
            "campfire_moq_sessions_rejected_total",
            "MoQ CONNECTs rejected (missing/bad ticket or call no longer active).",
            f(&self.inner.moq_session_rejected),
        );
        metric(
            &mut out,
            "gauge",
            "campfire_moq_origins",
            "Live per-call media origins.",
            moq.origins as f64,
        );
        metric(
            &mut out,
            "counter",
            "campfire_moq_objects_in_total",
            "Media objects published into the SFU.",
            moq.objects_in as f64,
        );
        metric(
            &mut out,
            "counter",
            "campfire_moq_bytes_in_total",
            "Media bytes published into the SFU.",
            moq.bytes_in as f64,
        );
        metric(
            &mut out,
            "counter",
            "campfire_moq_objects_out_total",
            "Media objects served out to subscribers.",
            moq.objects_out as f64,
        );
        metric(
            &mut out,
            "counter",
            "campfire_moq_bytes_out_total",
            "Media bytes served out to subscribers.",
            moq.bytes_out as f64,
        );
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_is_prometheus_text_and_tracks_counters() {
        let m = Metrics::default();
        m.conn_open();
        m.session_open();
        m.datagram_in(64);
        m.datagram_out(1200);
        m.rate_limit_hit();
        m.tick(15_000);
        m.moq_session_open();
        m.moq_session_reject();
        let moq = MoqGauges {
            origins: 1,
            objects_in: 42,
            bytes_in: 5_000,
            objects_out: 84,
            bytes_out: 9_000,
        };
        let text = m.render((7, 2, 1), &moq);
        assert!(text.contains("campfire_users 7"));
        assert!(text.contains("campfire_rooms 2"));
        assert!(text.contains("campfire_calls 1"));
        assert!(text.contains("campfire_datagrams_in_total 1"));
        assert!(text.contains("campfire_datagrams_out_bytes_total 1200"));
        assert!(text.contains("campfire_rate_limit_hits_total 1"));
        assert!(text.contains("campfire_tick_seconds_total 0.015"));
        assert!(text.contains("campfire_ticks_total 1"));
        assert!(text.contains("campfire_moq_sessions 1"));
        assert!(text.contains("campfire_moq_sessions_total 1"));
        assert!(text.contains("campfire_moq_sessions_rejected_total 1"));
        assert!(text.contains("campfire_moq_origins 1"));
        assert!(text.contains("campfire_moq_objects_in_total 42"));
        assert!(text.contains("campfire_moq_bytes_out_total 9000"));
        assert!(text.contains("# TYPE campfire_connections gauge"));
        // Counters go down too (gauges, not monotonic):
        m.conn_close();
        assert!(
            m.render((0, 0, 0), &MoqGauges::default())
                .contains("campfire_connections 0")
        );
    }
}

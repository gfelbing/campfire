//! Prometheus metrics at `GET /metrics` (README §14/§11 Phase 8).
//!
//! Hand-rolled text exposition (the 0.0.4 format) instead of a metrics
//! crate: the counters are a handful of atomics and a dependency (and its
//! transitive heap) buys nothing here. Counters are `AtomicU64`; gauges
//! that describe the world (users/rooms/calls) are computed from the
//! world at scrape time, so they are always consistent with what a
//! concurrent tick is doing.
//!
//! TURN has no stats API in the embedded server, so its numbers are
//! observed where we can see them: the TLS front's STUN/TURN splices
//! ([`crate::bootstrap`]). A splice is one TURN-over-TLS session (≈ one
//! allocation sequence), and the spliced bytes are the relay traffic.

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
    /// Inbound movement datagrams / bytes (README §5).
    dg_in: AtomicU64,
    dg_in_bytes: AtomicU64,
    /// Outbound tick batches / bytes.
    dg_out: AtomicU64,
    dg_out_bytes: AtomicU64,
    /// Rejected requests by the rate limiters (README §14).
    rate_limit_hits: AtomicU64,
    /// Tick-loop time: total seconds spent inside `World::tick` and how
    /// many ticks ran (scrape → mean; spikes show up in the rate).
    tick_micros: AtomicU64,
    ticks: AtomicU64,
    /// STUN/TURN splices at the TLS front: currently open, all-time, and
    /// the relayed bytes both ways.
    turn_splices: AtomicU64,
    turn_splice_total: AtomicU64,
    turn_bytes_in: AtomicU64,
    turn_bytes_out: AtomicU64,
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

    pub fn turn_splice_open(&self) {
        self.inner.turn_splices.fetch_add(1, Ordering::Relaxed);
        self.inner.turn_splice_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn turn_splice_close(&self) {
        self.inner.turn_splices.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn turn_bytes(&self, to_turn: usize, from_turn: usize) {
        self.inner
            .turn_bytes_in
            .fetch_add(to_turn as u64, Ordering::Relaxed);
        self.inner
            .turn_bytes_out
            .fetch_add(from_turn as u64, Ordering::Relaxed);
    }

    /// Render the exposition format. `world_gauges` is
    /// `(users, rooms, calls)` from the world at scrape time.
    pub fn render(&self, world_gauges: (u64, u64, u64)) -> String {
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
            "Rooms with an active bubble (README §6.3).",
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
            "campfire_turn_splices",
            "TURN-over-TLS sessions currently spliced at the TLS front.",
            g(&self.inner.turn_splices) as f64,
        );
        metric(
            &mut out,
            "counter",
            "campfire_turn_splices_total",
            "TURN-over-TLS sessions spliced (all-time).",
            f(&self.inner.turn_splice_total),
        );
        metric(
            &mut out,
            "counter",
            "campfire_turn_bytes_in_total",
            "Bytes relayed client → TURN (TLS front view).",
            f(&self.inner.turn_bytes_in),
        );
        metric(
            &mut out,
            "counter",
            "campfire_turn_bytes_out_total",
            "Bytes relayed TURN → client (TLS front view).",
            f(&self.inner.turn_bytes_out),
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
        m.turn_splice_open();
        m.turn_bytes(100, 200);
        let text = m.render((7, 2, 1));
        assert!(text.contains("campfire_users 7"));
        assert!(text.contains("campfire_rooms 2"));
        assert!(text.contains("campfire_calls 1"));
        assert!(text.contains("campfire_datagrams_in_total 1"));
        assert!(text.contains("campfire_datagrams_out_bytes_total 1200"));
        assert!(text.contains("campfire_rate_limit_hits_total 1"));
        assert!(text.contains("campfire_tick_seconds_total 0.015"));
        assert!(text.contains("campfire_ticks_total 1"));
        assert!(text.contains("campfire_turn_bytes_in_total 100"));
        assert!(text.contains("# TYPE campfire_connections gauge"));
        // Counters go down too (gauges, not monotonic):
        m.conn_close();
        assert!(m.render((0, 0, 0)).contains("campfire_connections 0"));
    }
}

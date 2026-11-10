//! Bandwidth-based congestion controller for the media path.
//!
//! Both of quinn's stock controllers fail on the spike's network model
//! (independent per-packet loss plus delay jitter, no rate-limited
//! bottleneck):
//!
//! - CUBIC/NewReno halve the congestion window on every declared loss.
//!   netem's `loss random N%` drops packets independently of load, so at 5 %
//!   loss the window halves roughly 13 times per second and pins at the
//!   floor (measured: 99 of 1500 audio groups delivered over 30 s).
//! - BBR sizes its window from a BDP computed with `min_rtt`. Under
//!   100+30 ms one-way delay the minimum sample is a jitter artifact
//!   (~20-40 ms) instead of the ~190 ms RTT, the BDP collapses to a few KB
//!   and the resulting rate cap (cwnd/RTT, ~32 KB/s) sits below the
//!   316 KB/s media path, so the queue grows unbounded (measured:
//!   p50 628 ms at 0 % loss).
//!
//! This controller runs the congestion window at `max(FLOOR, GAIN * BDP)`,
//! BDP = measured delivery rate x *smoothed* RTT. Isolated loss events are
//! ignored - they are not congestion in this model - and only persistent
//! congestion shrinks the window. Quinn 0.11's pacer is never consulted in
//! the send path, so the window is the only rate lever.
//!
//! Spike scope: the path under test has no bottleneck to protect, so
//! not cutting the window on isolated loss is safe. A production SFU on a
//! real WAN needs a loss-tolerant production controller (docs/moq-sfu.md).

use std::any::Any;
use std::sync::Arc;
use std::time::{Duration, Instant};

use quinn::congestion::{Controller, ControllerFactory};

/// Window floor. At the spike's RTTs (190-250 ms) this alone carries
/// 500-670 KB/s per connection, ahead of the 316 KB/s media path; the BDP
/// term takes over on fatter or longer pipes.
const FLOOR: u64 = 128 * 1024;
/// Window ceiling. Per connection; fan-out multiplies connections, not
/// windows.
const CEILING: u64 = 1024 * 1024;
/// Gain applied to the measured BDP: burst headroom for the SFU's cache
/// drains without unbounded queueing.
const BDP_GAIN: f64 = 3.0;

/// Bandwidth-based controller: the window tracks `max(FLOOR, BDP_GAIN * BDP)`.
#[derive(Clone)]
pub struct MediaCc {
    cwnd: u64,
    /// Delivery rate in bytes/ms, EWMA over non-app-limited ack batches.
    bw_bytes_per_ms: f64,
    last_ack: Option<Instant>,
}

impl MediaCc {
    /// The window the path should run at: measured BDP with gain, floored so
    /// low-rate or short-RTT pipes never starve the media path.
    fn target(&self, rtt: Duration) -> u64 {
        let bdp = self.bw_bytes_per_ms * rtt.as_secs_f64() * 1000.0;
        let sized = (BDP_GAIN * bdp) as u64;
        sized.clamp(FLOOR, CEILING)
    }
}

impl Controller for MediaCc {
    fn on_ack(
        &mut self,
        now: Instant,
        _sent: Instant,
        bytes: u64,
        app_limited: bool,
        rtt: &quinn_proto::RttEstimator,
    ) {
        if !app_limited {
            // A sample taken while the sender was starved would understate
            // the path's capacity; only unsaturated acks inform the rate.
            if let Some(last) = self.last_ack {
                let dt_ms = now.saturating_duration_since(last).as_secs_f64() * 1000.0;
                if dt_ms > 0.0 {
                    let rate = bytes as f64 / dt_ms;
                    self.bw_bytes_per_ms = if self.bw_bytes_per_ms == 0.0 {
                        rate
                    } else {
                        0.8 * self.bw_bytes_per_ms + 0.2 * rate
                    };
                }
            }
            self.last_ack = Some(now);
        }
        // Never shrink on ordinary acks: the window only recovers from its
        // initial value or a persistent-congestion cut, and the network
        // model has no bottleneck extra window would hurt.
        self.cwnd = self.cwnd.max(self.target(rtt.get()));
    }

    fn on_congestion_event(
        &mut self,
        _now: Instant,
        _sent: Instant,
        is_persistent_congestion: bool,
        _lost_bytes: u64,
    ) {
        // Isolated loss is load-independent in this model (netem random
        // loss): halving here is exactly what collapsed CUBIC under the
        // T4/T5 loss gates. Only persistent congestion - every packet of a
        // full RTT window lost - is evidence of a real bottleneck.
        if is_persistent_congestion {
            self.cwnd = (self.cwnd / 2).max(FLOOR);
        }
    }

    fn on_mtu_update(&mut self, _new_mtu: u16) {}

    fn window(&self) -> u64 {
        self.cwnd
    }

    fn initial_window(&self) -> u64 {
        FLOOR
    }

    fn clone_box(&self) -> Box<dyn Controller> {
        Box::new(self.clone())
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }
}

/// Factory for [`MediaCc`], handed to
/// `TransportConfig::congestion_controller_factory`.
#[derive(Default)]
pub struct MediaCcConfig;

impl ControllerFactory for MediaCcConfig {
    fn build(self: Arc<Self>, _now: Instant, _current_mtu: u16) -> Box<dyn Controller> {
        Box::new(MediaCc {
            cwnd: FLOOR,
            bw_bytes_per_ms: 0.0,
            last_ack: None,
        })
    }
}

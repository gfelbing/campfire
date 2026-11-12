//! Per-call media origins (docs/moq-sfu.md §3/§4).
//!
//! Every active call gets its own moq-net origin: the participants' uplinks
//! are written into it, and every participant's subscriptions are served
//! from it (fan-out and group caching are moq-net's job). Calls are
//! isolated by construction — a session wired to call C's origin can only
//! see, and only publish into, the tracks announced on C — so the
//! bubble-state authorization policy (docs/moq-sfu.md §3) reduces to the
//! CONNECT-time checks in [`super::session`].

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use moq_net::origin::Producer;

/// Pool settings for a call origin (docs/moq-sfu.md Phase 0, F7): 10 s of
/// history keeps fast-start cheap for late joiners (the T7 first-frame
/// budget is 2 s) without holding more media than that, and the byte cap
/// bounds a bursty publisher.
const POOL_EXPIRY: Duration = Duration::from_secs(10);
const POOL_CAPACITY: u64 = 16 * 1024 * 1024;

/// One origin per active call. Dropping the last `Producer` handle of a
/// call ends that origin (moq-net handles are refcounted), which also
/// finishes its driver task.
#[derive(Clone, Default)]
pub struct Fanout {
    origins: Arc<Mutex<HashMap<u64, OriginEntry>>>,
}

/// A call's origin plus when it was last touched (the sweeper's signal).
struct OriginEntry {
    producer: Producer,
    /// Last time a session admitted into this origin (see [`Fanout::sweep`]).
    last_used: Instant,
}

impl Fanout {
    pub fn new() -> Self {
        Self::default()
    }

    /// The origin for `call_id`, created (with its driver task) on first
    /// use.
    pub fn origin(&self, call_id: u64) -> Producer {
        let mut origins = self.origins.lock().unwrap();
        let entry = origins.entry(call_id).or_insert_with(|| {
            let mut config = moq_net::origin::Config::new(moq_net::Hop::random());
            config.pool = moq_net::cache::Pool::new(
                moq_net::cache::Config::default()
                    .with_expiry(POOL_EXPIRY)
                    .with_capacity(Some(POOL_CAPACITY)),
            );
            let (producer, driver) = Producer::new(config);
            tokio::spawn(async move {
                let _ = moq_net::time::run(driver).await;
            });
            OriginEntry {
                producer,
                last_used: Instant::now(),
            }
        });
        entry.last_used = Instant::now();
        entry.producer.clone()
    }

    /// Drop a call's origin (the call ended); a no-op when it is gone.
    pub fn drop_call(&self, call_id: u64) {
        self.origins.lock().unwrap().remove(&call_id);
    }

    /// Drop origins whose call is no longer live. The world is the source of
    /// truth: an origin whose `call_id` is absent from `live_calls` is stale
    /// — its call ended (or the call-end hook never fired, or the call died
    /// between the admission check and origin creation). Dropping the last
    /// `Producer` handle ends the origin and its driver task. Live calls are
    /// never swept here, no matter how long the origin has been quiet, so a
    /// multi-hour call is safe; the call-end path (`drop_call`) is the fast
    /// route and this is the backstop. Returns the number dropped.
    pub fn sweep(&self, live_calls: &[u64]) -> usize {
        let mut origins = self.origins.lock().unwrap();
        let before = origins.len();
        origins.retain(|call_id, _| live_calls.contains(call_id));
        before - origins.len()
    }

    /// Live call origins (the fan-out width gauge).
    pub fn live(&self) -> usize {
        self.origins.lock().unwrap().len()
    }
}

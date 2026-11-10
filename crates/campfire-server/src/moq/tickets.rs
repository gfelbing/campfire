//! Media tickets (docs/moq-sfu.md §5): short-lived bearer tokens that
//! authorize one MoQ session on the SFU.
//!
//! The world mints a ticket when a user becomes a call participant
//! (`call_start`) and again on reconnect (`hello`); the client presents it
//! in the `/moq` WebTransport CONNECT query (`?ticket=…`). A ticket is a
//! bearer token — it only ever travels over the owner's own encrypted
//! session — and stays valid until its TTL expires. The SFU additionally
//! re-checks call membership on CONNECT ([`crate::moq::session`]), so a
//! ticket whose call has already ended is refused.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use rand::RngCore;

/// A ticket's time to live.
pub const TICKET_TTL: Duration = Duration::from_secs(60);

/// What a presented ticket authorizes: the presenting user, their room, and
/// the call the ticket was minted for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketInfo {
    pub user: String,
    pub room: String,
    pub call_id: u64,
}

struct Entry {
    user: String,
    room: String,
    call_id: u64,
    minted: Instant,
}

/// Process-wide ticket store. Cheap to clone (one `Arc` around a small
/// map, guarded by a mutex held for the length of a hash lookup).
#[derive(Clone)]
pub struct TicketRegistry {
    inner: Arc<Inner>,
}

struct Inner {
    ttl: Duration,
    map: Mutex<HashMap<String, Entry>>,
}

impl TicketRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                ttl: TICKET_TTL,
                map: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Tests: a shorter TTL so expiry can be exercised without sleeping.
    #[cfg(test)]
    pub(crate) fn with_ttl(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                ttl,
                map: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Mint a fresh ticket for `user` in `room` for call `call_id`.
    /// 32 random bytes, hex-encoded (64 chars).
    pub fn mint(&self, user: &str, room: &str, call_id: u64) -> String {
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        let id: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        let mut map = self.inner.map.lock().unwrap();
        sweep_expired(&mut map, self.inner.ttl);
        map.insert(
            id.clone(),
            Entry {
                user: user.to_owned(),
                room: room.to_owned(),
                call_id,
                minted: Instant::now(),
            },
        );
        id
    }

    /// Validate a presented ticket: `None` when unknown or expired
    /// (expired entries are dropped on the way out).
    pub fn validate(&self, id: &str) -> Option<TicketInfo> {
        let mut map = self.inner.map.lock().unwrap();
        let entry = map.get(id)?;
        if entry.minted.elapsed() >= self.inner.ttl {
            map.remove(id);
            return None;
        }
        Some(TicketInfo {
            user: entry.user.clone(),
            room: entry.room.clone(),
            call_id: entry.call_id,
        })
    }
}

/// Drop expired entries (called on mint, so the map stays bounded even
/// when nobody presents tickets).
fn sweep_expired(map: &mut HashMap<String, Entry>, ttl: Duration) {
    map.retain(|_, e| e.minted.elapsed() < ttl);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_validate_roundtrip() {
        let reg = TicketRegistry::new();
        let t = reg.mint("u_1", "office", 7);
        assert_eq!(t.len(), 64);
        assert_eq!(
            reg.validate(&t),
            Some(TicketInfo {
                user: "u_1".into(),
                room: "office".into(),
                call_id: 7,
            })
        );
    }

    #[test]
    fn unknown_ticket_is_rejected() {
        let reg = TicketRegistry::new();
        assert_eq!(reg.validate("not-a-ticket"), None);
    }

    #[test]
    fn expired_ticket_is_rejected_and_removed() {
        let reg = TicketRegistry::with_ttl(Duration::from_millis(10));
        let t = reg.mint("u_1", "office", 1);
        assert!(reg.validate(&t).is_some());
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(reg.validate(&t), None);
        // A second mint sweeps it out of the map.
        let t2 = reg.mint("u_2", "office", 2);
        assert!(reg.validate(&t2).is_some());
    }

    #[test]
    fn tickets_are_distinct() {
        let reg = TicketRegistry::new();
        let a = reg.mint("u_1", "office", 1);
        let b = reg.mint("u_1", "office", 1);
        assert_ne!(a, b);
    }
}

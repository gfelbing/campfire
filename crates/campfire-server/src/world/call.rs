//! Per-room call state (README §6/§7).
//!
//! Deliberately trivial: one `Option<Call>` per room — a participant set
//! plus per-participant audio/video flags, and (for 1:1) the in-flight
//! ring. Every transition is driven by a signaling message and validated
//! in [`crate::world::World::call_*`]: same room, sender involved, size
//! caps on SDP/ICE. The server never touches media; it relays.
//!
//! Phase 5 implements 1:1 calls (`CallKind::OneToOne`). Room huddles
//! (`CallKind::Huddle`) land in Phase 6.

use std::collections::HashMap;

use campfire_protocol::UserBrief;

use crate::world::UserId;

/// The shape of a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallKind {
    /// One-on-one call: exactly two participants.
    OneToOne,
    /// Room huddle: any number of participants (Phase 6).
    Huddle,
}

/// Per-participant presence flags (README §6.3: `call_mute` is presence
/// only — the client flips `track.enabled`, no renegotiation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ParticipantFlags {
    /// `true` = audio on (speaking), `false` = muted.
    pub audio: bool,
    /// `true` = camera on, `false` = off.
    pub video: bool,
}

/// An in-flight call in one room.
#[derive(Debug, Clone)]
pub struct Call {
    pub kind: CallKind,
    /// Participants: id → (name, flags).
    pub participants: HashMap<UserId, (String, ParticipantFlags)>,
    /// A 1:1 ring not yet accepted or canceled: `(caller, callee)`.
    /// `None` once the call has started (or for huddles).
    pub ringing: Option<(UserId, UserId)>,
}

impl Call {
    pub fn new_one_to_one(caller: UserId, callee: UserId) -> Self {
        Self {
            kind: CallKind::OneToOne,
            participants: HashMap::new(),
            ringing: Some((caller, callee)),
        }
    }

    /// Whether `id` is a participant of this call.
    pub fn contains(&self, id: &str) -> bool {
        self.participants.contains_key(id)
    }

    /// All participants as presence briefs, id-sorted for stable ordering.
    pub fn participant_list(&self) -> Vec<UserBrief> {
        let mut out: Vec<UserBrief> = self
            .participants
            .iter()
            .map(|(id, (name, _))| UserBrief {
                id: id.clone(),
                name: name.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// Remove a participant; `true` when the call is now empty.
    pub fn remove(&mut self, id: &str) -> bool {
        self.participants.remove(id).is_some() && self.participants.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_call() -> Call {
        let mut call = Call::new_one_to_one("u_aaa".into(), "u_bbb".into());
        call.participants.insert(
            "u_aaa".into(),
            (
                "alice".into(),
                ParticipantFlags {
                    audio: true,
                    video: true,
                },
            ),
        );
        call.participants.insert(
            "u_bbb".into(),
            (
                "bob".into(),
                ParticipantFlags {
                    audio: true,
                    video: false,
                },
            ),
        );
        call
    }

    #[test]
    fn participant_list_is_sorted_and_complete() {
        let list = sample_call().participant_list();
        assert_eq!(
            list,
            vec![
                UserBrief {
                    id: "u_aaa".into(),
                    name: "alice".into(),
                },
                UserBrief {
                    id: "u_bbb".into(),
                    name: "bob".into(),
                },
            ]
        );
    }

    #[test]
    fn remove_reports_empty_call() {
        let mut call = sample_call();
        assert!(!call.remove("u_aaa"), "one left, call not empty");
        assert!(call.contains("u_bbb"));
        assert!(call.remove("u_bbb"), "last one left, call empty");
        assert!(!call.remove("u_gone"));
    }
}

//! Per-room call state (README §6/§7): proximity bubbles.
//!
//! One `Option<Call>` per room. There is no ring/accept flow any more: the
//! server *computes* the call from avatar positions in the 50 ms tick
//! ([`crate::world::World::tick`]) — walking within the join radius of a
//! participant pulls you in, walking (or toggling) out drops you after a
//! grace delay. The server still never touches media: it relays SDP/ICE
//! between participants (README §6.1) and tracks who is in which bubble.
//!
//! Call *state* is room-wide (it powers the avatars' headphone badge);
//! call *signaling* (offer/answer/ice/mute) is participant-scoped.

use std::collections::HashMap;

use campfire_protocol::UserBrief;

use crate::world::UserId;

/// Per-participant presence flags (README §6.3: `call_mute` is presence
/// only — the client flips `track.enabled`, no renegotiation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ParticipantFlags {
    /// `true` = audio on (speaking), `false` = muted.
    pub audio: bool,
    /// `true` = camera on, `false` = off.
    pub video: bool,
}

/// An in-flight proximity call in one room.
#[derive(Debug, Clone, Default)]
pub struct Call {
    /// Participants: id → (name, flags).
    pub participants: HashMap<UserId, (String, ParticipantFlags)>,
}

impl Call {
    /// A bubble with its first participants (id → name); they do *not*
    /// offer each other — the server designates one offerer per recipient
    /// in `CallStart.you_offer` (the smaller id offers on creation).
    pub fn new(entries: impl Iterator<Item = (UserId, String)>) -> Self {
        let mut call = Self::default();
        for (id, name) in entries {
            call.participants.insert(
                id,
                (
                    name,
                    ParticipantFlags {
                        audio: true,
                        video: true,
                    },
                ),
            );
        }
        call
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
        Call::new(
            [
                ("u_aaa".to_owned(), "alice".to_owned()),
                ("u_bbb".to_owned(), "bob".to_owned()),
            ]
            .into_iter(),
        )
    }

    #[test]
    fn participant_list_is_sorted_and_complete() {
        let call = sample_call();
        assert_eq!(
            call.participant_list(),
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

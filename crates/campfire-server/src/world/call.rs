//! Per-room call state (docs/arch/protocol.md): proximity bubbles and zone calls.
//!
//! One `Option<Call>` per room, plus one per occupied `jitsiRoom` zone. The
//! server *computes* the call from avatar positions in the 50 ms tick
//! ([`crate::world::World::tick`]) — walking within the join radius of a
//! participant pulls you in; walking (or toggling) out drops you immediately.
//! The server never touches media (it rides the MoQ SFU, docs/arch/moq-sfu.md); it
//! only tracks who is in which call and each participant's
//! mute/camera/screen presence.
//!
//! Call *state* is room-wide (it powers the avatars' headphone badge and the
//! zone-rectangle highlight).

use std::collections::HashMap;

use campfire_protocol::UserBrief;

use crate::world::UserId;

/// Per-participant presence flags (docs/arch/protocol.md: `call_mute` is presence
/// only — the client flips `track.enabled`, no renegotiation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ParticipantFlags {
    /// `true` = audio on (speaking), `false` = muted.
    pub audio: bool,
    /// `true` = camera on, `false` = off.
    pub video: bool,
    /// `true` = the camera video track carries the screen share.
    pub screen: bool,
}

/// An in-flight proximity call in one room.
#[derive(Debug, Clone, Default)]
pub struct Call {
    /// Call id: assigned by the world (monotonic per process). Names the
    /// call's media origin (docs/arch/moq-sfu.md) and rides in media tickets.
    pub id: u64,
    /// Participants: id → (name, flags).
    pub participants: HashMap<UserId, (String, ParticipantFlags)>,
    /// `jitsiRoom` zone call (README roadmap "Map enhancements"): the call
    /// is bounded by the zone's rectangle instead of the one-tile bubble
    /// radius. `None` = ordinary proximity bubble.
    pub zone: Option<String>,
}

impl Call {
    /// A call with its first participants (id → name). They are already in
    /// the call — there is no offer/answer: media rides the MoQ SFU
    /// (docs/arch/moq-sfu.md), so no peer is ever an "offerer".
    pub fn new(id: u64, entries: impl Iterator<Item = (UserId, String)>) -> Self {
        let mut call = Call {
            id,
            ..Self::default()
        };
        for (id, name) in entries {
            call.participants.insert(
                id,
                (
                    name,
                    ParticipantFlags {
                        audio: true,
                        video: true,
                        screen: false,
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
                // The call tracks only presence, not the avatar: map avatars
                // are colored from the hello/Joined rosters, not here.
                color: None,
                status: None,
            })
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_call() -> Call {
        Call::new(
            1,
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
                    color: None,
                        status: None,
                                        },
                UserBrief {
                    id: "u_bbb".into(),
                    name: "bob".into(),
                    color: None,
                        status: None,
                                        },
            ]
        );
    }
}

//! In-memory world state: rooms, users, chat history.
//!
//! A single [`World`] behind an `Arc<Mutex<..>>` is plenty for Phase 2: the
//! lock is held only for short, non-awaiting mutations. The per-room owner
//! task / tick-loop architecture from README §7 arrives with Phase 3's
//! movement; the public API here is shaped so that switch is mechanical.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use campfire_protocol::{Avatar, ChatMsg, ServerMsg, UserBrief, UserState};
use rand::RngCore;

/// Maximum chat lines kept per room (README §7).
const CHAT_HISTORY: usize = 100;

/// Id of a connected user, e.g. `u_1f3a9c02`.
pub type UserId = String;

/// A user present in one room.
struct Member {
    name: String,
    #[allow(dead_code)] // consumed by the client renderer in Phase 4
    avatar: Option<Avatar>,
    pos: (f32, f32),
    dir: campfire_protocol::Dir,
    #[allow(dead_code)] // written by the Phase 3 movement tick
    moving: bool,
    #[allow(dead_code)] // written by the Phase 3 movement tick
    seq: u64,
    /// Outbound reliable-stream queue for this session.
    tx: tokio::sync::mpsc::UnboundedSender<ServerMsg>,
}

/// One room: presence + chat history.
#[derive(Default)]
struct Room {
    users: HashMap<UserId, Member>,
    chat: VecDeque<ChatMsg>,
}

/// Why a join was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinError {
    /// Room is at its user cap (README §14).
    RoomFull,
}

/// The whole world: every room and who is in it.
#[derive(Clone, Default)]
pub struct World {
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    id_counter: Arc<AtomicU64>,
    nonce: Arc<Mutex<[u8; 4]>>,
}

impl World {
    pub fn new() -> Self {
        let mut nonce = [0u8; 4];
        rand::thread_rng().fill_bytes(&mut nonce);
        Self {
            rooms: Arc::default(),
            id_counter: Arc::new(AtomicU64::new(0)),
            nonce: Arc::new(Mutex::new(nonce)),
        }
    }

    /// Generate a fresh user id (`u_` + 8 hex digits), identity-free per
    /// README §14 (logs carry no nicknames or personal data).
    fn next_user_id(&self) -> String {
        let n = self.id_counter.fetch_add(1, Ordering::Relaxed);
        let key = u32::from_le_bytes(*self.nonce.lock().unwrap()) ^ (n as u32);
        format!("u_{key:08x}")
    }

    /// Join a room. On success the caller gets its own id, the room snapshot,
    /// and everyone already in the room is told about the newcomer.
    pub fn join(
        &self,
        room: &str,
        name: &str,
        avatar: Option<Avatar>,
        tx: tokio::sync::mpsc::UnboundedSender<ServerMsg>,
    ) -> Result<Joined, JoinError> {
        let id = self.next_user_id();
        let mut rooms = self.rooms.lock().unwrap();
        let room_entry = rooms.entry(room.to_owned()).or_default();

        const ROOM_CAP: usize = 2048;
        if room_entry.users.len() >= ROOM_CAP {
            return Err(JoinError::RoomFull);
        }
        room_entry.users.insert(
            id.clone(),
            Member {
                name: name.to_owned(),
                avatar,
                pos: (40.0, 24.0),
                dir: campfire_protocol::Dir::South,
                moving: false,
                seq: 0,
                tx,
            },
        );

        let joined = Joined {
            you: id.clone(),
            users: room_entry
                .users
                .iter()
                .map(|(uid, m)| UserState {
                    id: uid.clone(),
                    name: m.name.clone(),
                    x: m.pos.0,
                    y: m.pos.1,
                    d: m.dir,
                })
                .collect(),
            chat: room_entry.chat.iter().cloned().collect(),
        };

        let brief = UserBrief {
            id: id.clone(),
            name: name.to_owned(),
        };
        for (uid, m) in &room_entry.users {
            if uid != &id {
                let _ = m.tx.send(ServerMsg::Joined {
                    user: brief.clone(),
                });
            }
        }
        Ok(joined)
    }

    /// Remove a user from their room and tell everyone left inside.
    pub fn leave(&self, room: &str, id: &str) {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get_mut(room) else {
            return;
        };
        if entry.users.remove(id).is_some() {
            for m in entry.users.values() {
                let _ = m.tx.send(ServerMsg::Left { id: id.to_owned() });
            }
        }
        if entry.users.is_empty() {
            rooms.remove(room);
        }
    }

    /// Send a chat message: recorded in history and echoed to everyone in the
    /// room, including the sender (so clients render their own line once).
    pub fn broadcast_chat(&self, room: &str, msg: ChatMsg) {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get_mut(room) else {
            return;
        };
        entry.chat.push_back(msg.clone());
        while entry.chat.len() > CHAT_HISTORY {
            entry.chat.pop_front();
        }
        for m in entry.users.values() {
            let _ = m.tx.send(ServerMsg::Chat {
                from: msg.from.clone(),
                name: msg.name.clone(),
                text: msg.text.clone(),
                ts: msg.ts,
            });
        }
    }

    /// Relay a typing indicator to everyone except the typer.
    pub fn broadcast_typing(&self, room: &str, id: &str, on: bool) {
        let rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get(room) else {
            return;
        };
        for (uid, m) in &entry.users {
            if uid != id {
                let _ = m.tx.send(ServerMsg::Typing {
                    id: id.to_owned(),
                    on,
                });
            }
        }
    }

    /// Snapshot for `/healthz`.
    pub fn stats(&self) -> (usize, usize) {
        let rooms = self.rooms.lock().unwrap();
        (rooms.values().map(|r| r.users.len()).sum(), rooms.len())
    }
}

/// Result of a successful join.
pub struct Joined {
    /// The joining user's own id.
    pub you: String,
    /// Everyone in the room, including the joiner.
    pub users: Vec<UserState>,
    /// Last chat lines of the room.
    pub chat: Vec<ChatMsg>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> (
        tokio::sync::mpsc::UnboundedSender<ServerMsg>,
        tokio::sync::mpsc::UnboundedReceiver<ServerMsg>,
    ) {
        tokio::sync::mpsc::unbounded_channel()
    }

    #[test]
    fn join_leave_cycle() {
        let world = World::new();
        let (tx_a, mut rx_a) = channel();
        let (tx_b, mut rx_b) = channel();

        let a = world.join("r", "alice", None, tx_a).unwrap();
        let b = world.join("r", "bob", None, tx_b).unwrap();
        assert_ne!(a.you, b.you);
        assert_eq!(a.users.len(), 1);
        assert_eq!(b.users.len(), 2);
        // alice heard bob join
        assert!(matches!(rx_a.try_recv().unwrap(), ServerMsg::Joined { .. }));

        world.leave("r", &a.you);
        // bob hears alice leave; bob is last man standing
        assert!(matches!(rx_b.try_recv().unwrap(), ServerMsg::Left { .. }));
        let (users, rooms) = world.stats();
        assert_eq!((users, rooms), (1, 1));

        world.leave("r", &b.you);
        assert_eq!(world.stats(), (0, 0));
    }

    #[test]
    fn chat_echoes_to_everyone_and_keeps_history() {
        let world = World::new();
        let (tx_a, mut rx_a) = channel();
        let (tx_b, mut rx_b) = channel();
        let a = world.join("r", "a", None, tx_a).unwrap();
        let _b = world.join("r", "b", None, tx_b).unwrap();
        rx_a.try_recv().unwrap(); // drain the `joined` broadcast for b

        world.broadcast_chat(
            "r",
            ChatMsg {
                from: a.you.clone(),
                name: "a".into(),
                text: "hi".into(),
                ts: 7,
            },
        );
        for rx in [&mut rx_a, &mut rx_b] {
            match rx.try_recv().unwrap() {
                ServerMsg::Chat { ref text, ts, .. } => {
                    assert_eq!((text.as_str(), ts), ("hi", 7))
                }
                other => panic!("expected chat, got {other:?}"),
            }
        }
    }

    #[test]
    fn typing_not_echoed_to_sender() {
        let world = World::new();
        let (tx_a, mut rx_a) = channel();
        let (tx_b, mut rx_b) = channel();
        let a = world.join("r", "a", None, tx_a).unwrap();
        world.join("r", "b", None, tx_b).unwrap();
        rx_a.try_recv().unwrap(); // drain the `joined` broadcast for b

        world.broadcast_typing("r", &a.you, true);
        assert!(rx_a.try_recv().is_err(), "sender must not hear own typing");
        assert!(matches!(
            rx_b.try_recv().unwrap(),
            ServerMsg::Typing { on: true, .. }
        ));
    }
}

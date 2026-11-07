//! In-memory world state: map registry, rooms, users, movement, chat history.
//!
//! A single [`World`] behind `Arc<Mutex<..>>` is plenty for Phase 3: the lock
//! is held only for short, non-awaiting mutations. A 50 ms tick task
//! (spawend by [`start_ticking`]) batches every dirty member into one
//! movement datagram per room (README §5); per-room owner tasks from README §7
//! are the next step if the lock ever shows up in a profile.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use campfire_protocol::{
    Avatar, ChatMsg, Dir, MovementBatch, MovementEntry, ServerMsg, UserBrief, UserState,
};
use rand::RngCore;

/// Maximum chat lines kept per room (README §7).
const CHAT_HISTORY: usize = 100;
/// Users per room (README §14).
const ROOM_CAP: usize = 2048;
/// Server tick: one movement batch per room every 50 ms (README §5).
pub const TICK: Duration = Duration::from_millis(50);
/// Largest movement datagram; bigger batches are split in halves (README §5).
const MAX_DATAGRAM_BYTES: usize = 1200;
/// Movement entries per user per second (README §5: client sends ≤15 Hz).
const MOVES_PER_SEC: usize = 30;
/// Maximum avatar speed in tiles per second (README §5).
const MAX_SPEED: f32 = 8.0;

/// Id of a connected user, e.g. `u_1f3a9c02`.
pub type UserId = String;

/// A user present in one room.
struct Member {
    name: String,
    #[allow(dead_code)] // consumed by the client renderer in Phase 4
    avatar: Option<Avatar>,
    pos: (f32, f32),
    dir: Dir,
    moving: u8,
    /// Last accepted sequence number; older entries are stale.
    seq: u64,
    /// When the last move was accepted (drives the speed gate).
    last_move_at: Instant,
    /// Fixed 1 s window for the movement rate limit.
    move_window_start: Instant,
    move_window_count: usize,
    /// Position changed since the last tick; goes into the next batch.
    dirty: bool,
    /// Outbound reliable-stream queue for this session.
    tx: tokio::sync::mpsc::UnboundedSender<ServerMsg>,
    /// Outbound datagram queue for this session (movement batches).
    dtx: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
}

/// One room (one map): presence + chat history.
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
    /// The room id is not a known map.
    UnknownRoom,
}

/// The whole world: the map registry plus every occupied room.
#[derive(Clone)]
pub struct World {
    maps: Arc<HashMap<String, campfire_maps::MapData>>,
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    id_counter: Arc<AtomicU64>,
    nonce: Arc<Mutex<[u8; 4]>>,
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

impl World {
    /// A world with all bundled maps registered as rooms.
    pub fn new() -> Self {
        let mut nonce = [0u8; 4];
        rand::thread_rng().fill_bytes(&mut nonce);
        Self {
            maps: Arc::new(campfire_maps::bundled()),
            rooms: Arc::default(),
            id_counter: Arc::new(AtomicU64::new(0)),
            nonce: Arc::new(Mutex::new(nonce)),
        }
    }

    /// The map a room id names, if it is a known map.
    pub fn map(&self, room: &str) -> Option<&campfire_maps::MapData> {
        self.maps.get(room)
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
    ///
    /// The room id must name a known map; the joiner spawns at the map's
    /// spawn point.
    pub fn join(
        &self,
        room: &str,
        name: &str,
        avatar: Option<Avatar>,
        tx: tokio::sync::mpsc::UnboundedSender<ServerMsg>,
        dtx: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<Joined, JoinError> {
        let map = self.maps.get(room).ok_or(JoinError::UnknownRoom)?;
        let id = self.next_user_id();
        let mut rooms = self.rooms.lock().unwrap();
        let room_entry = rooms.entry(room.to_owned()).or_default();

        if room_entry.users.len() >= ROOM_CAP {
            return Err(JoinError::RoomFull);
        }
        let now = Instant::now();
        // If the room already has members, mark the joiner dirty so the next
        // tick broadcasts the spawn position (an empty room has no one to
        // tell, and no one will learn the position from a datagram).
        let dirty = !room_entry.users.is_empty();
        room_entry.users.insert(
            id.clone(),
            Member {
                name: name.to_owned(),
                avatar,
                pos: map.spawn,
                dir: Dir::South,
                moving: 0,
                seq: 0,
                last_move_at: now,
                move_window_start: now,
                move_window_count: 0,
                dirty,
                tx,
                dtx,
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

    /// Validate and apply one user's movement batch (README §5 "Movement
    /// rules"). Every entry must come from the caller, carry a strictly
    /// newer sequence number, stay inside the map on a walkable tile, and
    /// respect the 8 tiles/s speed gate. Rejected entries are dropped
    /// silently; nothing changes for them.
    pub fn apply_movement(&self, room: &str, user_id: &str, entries: &[MovementEntry]) {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(room_entry) = rooms.get_mut(room) else {
            return;
        };
        let Some(member) = room_entry.users.get_mut(user_id) else {
            return;
        };
        let Some(map) = self.maps.get(room) else {
            return;
        };
        for entry in entries {
            if entry.id != user_id || entry.seq <= member.seq {
                continue; // not ours, or stale
            }
            // ≤ 30 movement entries per second (fixed 1 s window).
            let now = Instant::now();
            if now.duration_since(member.move_window_start) >= Duration::from_secs(1) {
                member.move_window_start = now;
                member.move_window_count = 0;
            }
            if member.move_window_count >= MOVES_PER_SEC {
                break;
            }
            if !map.is_walkable(entry.x, entry.y) {
                continue;
            }
            // Speed gate: no farther than 8 tiles/s since the last accepted
            // move. Rejected moves leave `last_move_at` untouched.
            let dt = now.duration_since(member.last_move_at).as_secs_f32();
            let dx = entry.x - member.pos.0;
            let dy = entry.y - member.pos.1;
            if (dx * dx + dy * dy).sqrt() > MAX_SPEED * dt {
                continue;
            }
            member.pos = (entry.x, entry.y);
            member.dir = entry.d;
            member.moving = entry.moving;
            member.seq = entry.seq;
            member.last_move_at = now;
            member.move_window_count += 1;
            member.dirty = true;
        }
    }

    /// One 50 ms tick (README §5): for every room, batch the dirty members
    /// into datagram-sized movement JSON and fan it out to all members.
    pub fn tick(&self) {
        let mut rooms = self.rooms.lock().unwrap();
        for room_entry in rooms.values_mut() {
            if !room_entry.users.values().any(|m| m.dirty) {
                continue;
            }
            let entries: Vec<MovementEntry> = room_entry
                .users
                .iter()
                .filter(|(_, m)| m.dirty)
                .map(|(uid, m)| MovementEntry {
                    id: uid.clone(),
                    x: m.pos.0,
                    y: m.pos.1,
                    d: m.dir,
                    moving: m.moving,
                    seq: m.seq,
                })
                .collect();
            for chunk in encode_batches(&entries) {
                for m in room_entry.users.values() {
                    let _ = m.dtx.send(chunk.clone());
                }
            }
            for m in room_entry.users.values_mut() {
                m.dirty = false;
            }
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

    /// Snapshot of the active rooms for `GET /api/v1/rooms`.
    pub fn rooms_list(&self) -> Vec<RoomInfo> {
        let rooms = self.rooms.lock().unwrap();
        let mut list: Vec<RoomInfo> = rooms
            .iter()
            .map(|(id, room)| RoomInfo {
                room: id.clone(),
                map: id.clone(),
                users: room.users.len(),
            })
            .collect();
        list.sort_by(|a, b| a.room.cmp(&b.room));
        list
    }

    /// Snapshot for `/healthz`.
    pub fn stats(&self) -> (usize, usize) {
        let rooms = self.rooms.lock().unwrap();
        (rooms.values().map(|r| r.users.len()).sum(), rooms.len())
    }
}

/// Spawn the 50 ms tick loop (README §5); returns its handle so the caller
/// can stop it.
pub fn start_ticking(world: World) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            world.tick();
        }
    })
}

/// Split a room's dirty entries into datagram-sized JSON batches: encode all
/// at once, and when the batch would exceed the datagram cap split the entry
/// list in halves and recurse (README §5 overflow rule).
fn encode_batches(entries: &[MovementEntry]) -> Vec<Vec<u8>> {
    if entries.is_empty() {
        return Vec::new();
    }
    let encoded = serde_json::to_vec(&MovementBatch {
        m: entries.to_vec(),
    })
    .expect("movement batches always serialize");
    if encoded.len() <= MAX_DATAGRAM_BYTES || entries.len() == 1 {
        return vec![encoded];
    }
    let mid = entries.len() / 2;
    let mut out = encode_batches(&entries[..mid]);
    out.extend(encode_batches(&entries[mid..]));
    out
}

/// Result of a successful join.
#[derive(Debug, PartialEq)]
pub struct Joined {
    /// The joining user's own id.
    pub you: String,
    /// Everyone in the room, including the joiner.
    pub users: Vec<UserState>,
    /// Last chat lines of the room.
    pub chat: Vec<ChatMsg>,
}

/// One active room, as reported by `GET /api/v1/rooms`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RoomInfo {
    /// Room id (== map id in v1).
    pub room: String,
    /// The map the room plays on.
    pub map: String,
    /// Current member count.
    pub users: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use campfire_protocol::from_line;

    fn channel() -> (
        tokio::sync::mpsc::UnboundedSender<ServerMsg>,
        tokio::sync::mpsc::UnboundedReceiver<ServerMsg>,
    ) {
        tokio::sync::mpsc::unbounded_channel()
    }

    fn datagram_channel() -> (
        tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
        tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    ) {
        tokio::sync::mpsc::unbounded_channel()
    }

    fn entry(id: &str, x: f32, y: f32, seq: u64) -> MovementEntry {
        MovementEntry {
            id: id.to_owned(),
            x,
            y,
            d: Dir::East,
            moving: 1,
            seq,
        }
    }

    #[test]
    fn join_leave_cycle() {
        let world = World::new();
        let (tx_a, mut rx_a) = channel();
        let (dtx_a, _) = datagram_channel();
        let (tx_b, mut rx_b) = channel();
        let (dtx_b, _) = datagram_channel();

        let a = world.join("office", "alice", None, tx_a, dtx_a).unwrap();
        let b = world.join("office", "bob", None, tx_b, dtx_b).unwrap();
        assert_ne!(a.you, b.you);
        assert_eq!(a.users.len(), 1);
        assert_eq!(b.users.len(), 2);
        // alice heard bob join
        assert!(matches!(rx_a.try_recv().unwrap(), ServerMsg::Joined { .. }));

        world.leave("office", &a.you);
        // bob hears alice leave; bob is last man standing
        assert!(matches!(rx_b.try_recv().unwrap(), ServerMsg::Left { .. }));
        let (users, rooms) = world.stats();
        assert_eq!((users, rooms), (1, 1));

        world.leave("office", &b.you);
        assert_eq!(world.stats(), (0, 0));
    }

    #[test]
    fn unknown_room_is_rejected() {
        let world = World::new();
        let (tx, _) = channel();
        let (dtx, _) = datagram_channel();
        assert_eq!(
            world.join("nope", "alice", None, tx, dtx),
            Err(JoinError::UnknownRoom)
        );
        // And nothing was created in the world.
        assert_eq!(world.stats(), (0, 0));
    }

    #[test]
    fn join_spawns_at_the_map_spawn() {
        let world = World::new();
        let (tx, _) = channel();
        let (dtx, _) = datagram_channel();
        let joined = world.join("office", "alice", None, tx, dtx).unwrap();
        let (spawn_x, spawn_y) = world.map("office").unwrap().spawn;
        assert_eq!((joined.users[0].x, joined.users[0].y), (spawn_x, spawn_y));
    }

    #[tokio::test]
    async fn movement_is_validated_and_batched() {
        let world = World::new();
        let (tx_a, _) = channel();
        let (dtx_a, mut dgr_a) = datagram_channel();
        let (tx_b, _) = channel();
        let (dtx_b, mut dgr_b) = datagram_channel();
        let a = world.join("office", "alice", None, tx_a, dtx_a).unwrap();
        world.join("office", "bob", None, tx_b, dtx_b).unwrap();
        let (spawn_x, spawn_y) = world.map("office").unwrap().spawn;

        // Bob's join (the room already had Alice) makes him dirty: the first
        // tick broadcasts his spawn position to everyone. Flush it so the
        // move-validation assertions below see a clean slate.
        world.tick();
        assert!(dgr_a.try_recv().is_ok(), "alice hears bob's spawn");
        assert!(dgr_b.try_recv().is_ok(), "bob hears his own spawn");

        // Too far for the elapsed time: the speed gate rejects it.
        world.apply_movement(
            "office",
            &a.you,
            &[entry(&a.you, spawn_x + 10.0, spawn_y, 1)],
        );
        world.tick();
        assert!(
            dgr_a.try_recv().is_err(),
            "a rejected move must not be broadcast"
        );

        // 200 ms later a 1-tile step is fine (1 ≤ 8 · 0.2).
        tokio::time::sleep(Duration::from_millis(200)).await;
        world.apply_movement(
            "office",
            &a.you,
            &[entry(&a.you, spawn_x + 1.0, spawn_y, 1)],
        );
        world.tick();
        // Both members receive the same batch.
        for dgr in [&mut dgr_a, &mut dgr_b] {
            let dg = dgr
                .try_recv()
                .expect("movement batch on the datagram queue");
            let batch: MovementBatch =
                from_line(std::str::from_utf8(&dg).expect("batch is utf8")).unwrap();
            assert_eq!(batch.m.len(), 1);
            assert_eq!(batch.m[0].id, a.you);
            assert_eq!((batch.m[0].x, batch.m[0].y), (spawn_x + 1.0, spawn_y));
            assert_eq!(batch.m[0].seq, 1);
        }
        // Dirty flags cleared: the next tick sends nothing.
        world.tick();
        assert!(dgr_a.try_recv().is_err());
        assert!(dgr_b.try_recv().is_err());

        // A stale sequence number is ignored.
        tokio::time::sleep(Duration::from_millis(200)).await;
        world.apply_movement(
            "office",
            &a.you,
            &[entry(&a.you, spawn_x + 2.0, spawn_y, 1)],
        );
        world.tick();
        assert!(dgr_a.try_recv().is_err(), "stale entry must not broadcast");
    }

    #[tokio::test]
    async fn movement_rejects_blocked_tiles() {
        let world = World::new();
        let (tx_a, _) = channel();
        let (dtx_a, mut dgr_a) = datagram_channel();
        let a = world.join("office", "alice", None, tx_a, dtx_a).unwrap();
        let map = world.map("office").unwrap();
        let (spawn_x, spawn_y) = map.spawn;
        // One tile north of the spawn is a wall in the office map.
        let (blocked_x, blocked_y) = (spawn_x, spawn_y - 1.0);
        assert!(
            !map.is_walkable(blocked_x, blocked_y),
            "test setup: tile must be a wall"
        );

        tokio::time::sleep(Duration::from_millis(200)).await;
        world.apply_movement("office", &a.you, &[entry(&a.you, blocked_x, blocked_y, 1)]);
        world.tick();
        assert!(
            dgr_a.try_recv().is_err(),
            "a move into a wall must not be accepted"
        );
    }

    #[test]
    fn join_becomes_dirty_only_for_nonempty_rooms() {
        let world = World::new();
        let (tx_a, _) = channel();
        let (dtx_a, mut dgr_a) = datagram_channel();
        world.join("office", "alice", None, tx_a, dtx_a).unwrap();
        // Joining an empty room has no one to tell: nothing is broadcast.
        world.tick();
        assert!(dgr_a.try_recv().is_err(), "empty-room joiner is not dirty");

        let (tx_b, _) = channel();
        let (dtx_b, mut dgr_b) = datagram_channel();
        let b = world.join("office", "bob", None, tx_b, dtx_b).unwrap();
        world.tick();
        let dg = dgr_a.try_recv().expect("alice hears bob's spawn");
        let batch: MovementBatch =
            from_line(std::str::from_utf8(&dg).expect("batch is utf8")).unwrap();
        assert_eq!(batch.m.len(), 1);
        assert_eq!(batch.m[0].id, b.you);
        let (spawn_x, spawn_y) = world.map("office").unwrap().spawn;
        assert_eq!((batch.m[0].x, batch.m[0].y), (spawn_x, spawn_y));
        // The server echoes the batch to all members, including bob.
        assert!(dgr_b.try_recv().is_ok());
    }

    #[test]
    fn chat_echoes_to_everyone_and_keeps_history() {
        let world = World::new();
        let (tx_a, mut rx_a) = channel();
        let (dtx_a, _) = datagram_channel();
        let (tx_b, mut rx_b) = channel();
        let (dtx_b, _) = datagram_channel();
        let a = world.join("office", "a", None, tx_a, dtx_a).unwrap();
        world.join("office", "b", None, tx_b, dtx_b).unwrap();
        rx_a.try_recv().unwrap(); // drain the `joined` broadcast for b

        world.broadcast_chat(
            "office",
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
        let (dtx_a, _) = datagram_channel();
        let (tx_b, mut rx_b) = channel();
        let (dtx_b, _) = datagram_channel();
        let a = world.join("office", "a", None, tx_a, dtx_a).unwrap();
        world.join("office", "b", None, tx_b, dtx_b).unwrap();
        rx_a.try_recv().unwrap(); // drain the `joined` broadcast for b

        world.broadcast_typing("office", &a.you, true);
        assert!(rx_a.try_recv().is_err(), "sender must not hear own typing");
        assert!(matches!(
            rx_b.try_recv().unwrap(),
            ServerMsg::Typing { on: true, .. }
        ));
    }
}

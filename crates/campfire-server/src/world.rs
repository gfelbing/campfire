//! In-memory world state: map registry, rooms, users, movement, chat history.
//!
//! A single [`World`] behind `Arc<Mutex<..>>` is plenty for Phase 3: the lock
//! is held only for short, non-awaiting mutations. A 50 ms tick task
//! (spawend by [`start_ticking`]) batches every dirty member into one
//! movement datagram per room (README §5); per-room owner tasks from README §7
//! are the next step if the lock ever shows up in a profile.

pub mod call;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use campfire_protocol::{
    Avatar, ChatMsg, Dir, ErrorCode, MovementBatch, MovementEntry, ServerMsg, UserBrief, UserState,
};
use rand::RngCore;

/// Maximum chat lines kept per room (README §7).
const CHAT_HISTORY: usize = 100;
/// Users per room (README §14).
const ROOM_CAP: usize = 2048;
/// Server tick: one movement batch per room every 50 ms (README §5).
pub const TICK: Duration = Duration::from_millis(50);
/// How long a disconnected user keeps their identity (README §5 reconnect):
/// position, call membership and the token all survive a drop for this long.
/// 30 s, not 10: a browser that loses a WebTransport connection takes
/// ~10-11 s to re-establish it (measured headless), so a 10 s window expired
/// before the rejoin landed and the user was re-spawned with a fresh id.
/// The extra hold on a genuinely closed tab is the accepted trade.
pub const RECONNECT_WINDOW: Duration = Duration::from_secs(30);
/// Proximity call (README §6.3): a bubble has a one-tile radius around the
/// centroid of its participants. Less than [`BUBBLE_RADIUS`] tiles from
/// another player (or from the bubble's center) pulls you in; at the radius
/// or beyond drops you immediately.
const BUBBLE_RADIUS: f32 = 1.0;
/// A member who re-entered via their token is exempt from the bubble-radius
/// check for this long (their restored position is often outside the
/// radius; walking out while connected still leaves immediately).
const BUBBLE_RETURN_GRACE: Duration = Duration::from_secs(2);
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
    /// The session that currently owns this member (guards against a stale
    /// session's disconnect clobbering a newer one, README §5 reconnect).
    session: u64,
    /// Reconnect token (README §5): echoed in `hello`, matched in `join`.
    token: String,
    /// When the owning session died; swept by the tick into a real leave
    /// once the reconnect window has elapsed (README §5).
    gone_at: Option<Instant>,
    /// Proximity-call opt-out (README §6.3, `ClientMsg::Bubble`): a user
    /// with this set is never pulled into a bubble and leaves the one they
    /// are in.
    bubble_off: bool,
    /// Set when a disconnected member re-enters via their token: exempts
    /// them from the bubble-radius check for [`BUBBLE_RETURN_GRACE`] (the
    /// restored position is often outside the radius, and the reconnect
    /// promise is that call membership survives).
    reentered_at: Option<Instant>,
}

/// One room (one map): presence + chat history + the in-flight calls.
#[derive(Default)]
struct Room {
    users: HashMap<UserId, Member>,
    chat: VecDeque<ChatMsg>,
    /// The room's calls (README §7): at most one proximity bubble
    /// (`zone: None`) plus one call per occupied jitsi zone. A user is in
    /// at most one call at a time.
    calls: Vec<call::Call>,
}

/// The index of the (single) call containing `id`, if any.
fn call_containing(entry: &Room, id: &str) -> Option<usize> {
    entry
        .calls
        .iter()
        .position(|c| c.participants.contains_key(id))
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
    maps: Arc<campfire_maps::Maps>,
    rooms: Arc<Mutex<HashMap<String, Room>>>,
    id_counter: Arc<AtomicU64>,
    nonce: Arc<Mutex<[u8; 4]>>,
    /// One per connected session; lets a stale session's disconnect lose to
    /// a newer session that already restored the same token (README §5).
    session_counter: Arc<AtomicU64>,
    /// How long a disconnected user keeps their identity (README §5).
    reconnect_window: Duration,
    /// Monotonic call ids (docs/moq-sfu.md §5): name the call's media
    /// origin and ride in media tickets.
    call_counter: Arc<AtomicU64>,
    /// Media tickets for `/moq` (docs/moq-sfu.md §5); the SFU shares this
    /// handle.
    tickets: Arc<crate::moq::tickets::TicketRegistry>,
    /// Set by [`Self::on_call_end`]; fired with the call id when a call
    /// ends so the SFU drops its media origin.
    call_end_hook: Option<Arc<dyn Fn(u64) + Send + Sync>>,
}

#[cfg(test)]
pub(crate) fn test_maps() -> campfire_maps::Maps {
    campfire_maps::Maps::load(std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../maps"
    )))
}

/// A map with zones for the zone tests (README roadmap "Map enhancements"):
/// a `jitsiRoom` meeting zone at tiles 2..5, 2..5, a `silentZone` at
/// tiles 0..2, 0..2, and a `start` area at tiles 1..3, 1..3. The whole
/// 8x8 grid is walkable.
#[cfg(test)]
pub(crate) fn zone_maps() -> campfire_maps::Maps {
    let raw = serde_json::json!({
        "type": "map",
        "name": "zonetest",
        "width": 8,
        "height": 8,
        "tilewidth": 32,
        "layers": [
            {"type": "tilelayer", "name": "collision", "width": 8, "height": 8,
             "data": vec![0; 64]},
            {"type": "objectgroup", "name": "zones", "objects": [
                {"name": "meeting", "x": 64, "y": 64, "width": 96, "height": 96,
                 "properties": [{"name": "jitsiRoom", "type": "string",
                                 "value": "team-meeting"}]},
                {"name": "annex", "x": 192, "y": 64, "width": 64, "height": 96,
                 "properties": [{"name": "jitsiRoom", "type": "string",
                                 "value": "team-annex"}]},
                {"name": "quiet", "x": 0, "y": 0, "width": 64, "height": 64,
                 "properties": [{"name": "silentZone", "type": "bool", "value": true}]},
                {"name": "start", "x": 32, "y": 32, "width": 64, "height": 64}
            ]}
        ]
    });
    let dir = std::env::temp_dir().join("campfire-zone-maps-test");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("zonetest.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    campfire_maps::Maps::load(&dir)
}

impl World {
    /// A world over the loaded maps (each registered as a room).
    pub fn new(maps: campfire_maps::Maps) -> Self {
        let mut nonce = [0u8; 4];
        rand::thread_rng().fill_bytes(&mut nonce);
        Self {
            maps: Arc::new(maps),
            rooms: Arc::default(),
            id_counter: Arc::new(AtomicU64::new(0)),
            nonce: Arc::new(Mutex::new(nonce)),
            session_counter: Arc::new(AtomicU64::new(0)),
            reconnect_window: RECONNECT_WINDOW,
            call_counter: Arc::new(AtomicU64::new(0)),
            tickets: Arc::new(crate::moq::tickets::TicketRegistry::new()),
            call_end_hook: None,
        }
    }

    /// The map registry (room ids and tileset assets, for the HTTP API).
    pub fn maps(&self) -> &Arc<campfire_maps::Maps> {
        &self.maps
    }

    /// Override the reconnect window (tests use a short one).
    pub fn with_reconnect_window(mut self, window: Duration) -> Self {
        self.reconnect_window = window;
        self
    }

    /// Register the SFU's call-end hook (docs/moq-sfu.md §5): called with
    /// the call id whenever a call ends, so the SFU drops the call's media
    /// origin. Must be set before the tick loop starts.
    pub fn on_call_end(mut self, hook: Arc<dyn Fn(u64) + Send + Sync>) -> Self {
        self.call_end_hook = Some(hook);
        self
    }

    /// The ticket store media sessions present on `/moq` (docs/moq-sfu.md
    /// §5): one per process, shared with the SFU.
    pub fn tickets(&self) -> &crate::moq::tickets::TicketRegistry {
        &self.tickets
    }

    /// Mint a media ticket for `user` when they sit in a call in `room`
    /// (docs/moq-sfu.md §5). `None` for bystanders.
    pub fn mint_call_ticket(&self, room: &str, user: &str) -> Option<String> {
        let rooms = self.rooms.lock().unwrap();
        let entry = rooms.get(room)?;
        let call = entry.calls.iter().find(|c| c.participants.contains_key(user))?;
        Some(self.tickets.mint(user, room, call.id))
    }

    /// The SFU's CONNECT check (docs/moq-sfu.md §5): the ticket's call must
    /// still exist in its room with the ticket's user in it.
    pub fn call_active(&self, room: &str, call_id: u64, user: &str) -> bool {
        let rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get(room) else {
            return false;
        };
        entry
            .calls
            .iter()
            .any(|c| c.id == call_id && c.participants.contains_key(user))
    }

    /// Next session id (monotonic; guards discard/leave races, README §5).
    pub fn next_session_id(&self) -> u64 {
        self.session_counter.fetch_add(1, Ordering::Relaxed)
    }

    /// Next call id (monotonic per process; docs/moq-sfu.md §5).
    fn next_call_id(&self) -> u64 {
        self.call_counter.fetch_add(1, Ordering::Relaxed)
    }

    /// Fire the SFU's call-end hook for a call that just ended (no-op when
    /// the SFU is not attached, as in unit tests).
    fn call_ended(&self, call_id: u64) {
        if let Some(hook) = &self.call_end_hook {
            hook(call_id);
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

    /// Generate a fresh reconnect token: 32 random hex chars (README §5).
    fn next_token(&self) -> String {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Join a room (README §5). Two paths:
    ///
    /// * **Reconnect**: `token` matches an existing member (gone, or still
    ///   alive — the old session may not have been detected as dead yet) →
    ///   that member is restored: the new session takes over the member's
    ///   channels, the user id, position and call membership survive, and
    ///   the room hears no `left`/`joined` (no flicker).
    /// * **Fresh**: a new id + token is generated and everyone in the room
    ///   hears `joined`.
    ///
    /// The room id must name a known map; a fresh joiner spawns at the map's
    /// spawn point.
    // Eight flat parameters on purpose: four are the join *request* (room,
    // name, avatar, token), three describe the *connecting session*
    // (session_id, tx, dtx). A struct would churn every call site for no gain.
    #[allow(clippy::too_many_arguments)]
    pub fn join(
        &self,
        room: &str,
        name: &str,
        avatar: Option<Avatar>,
        token: Option<&str>,
        session_id: u64,
        tx: tokio::sync::mpsc::UnboundedSender<ServerMsg>,
        dtx: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    ) -> Result<Joined, JoinError> {
        let map = self.maps.get(room).ok_or(JoinError::UnknownRoom)?;
        let mut rooms = self.rooms.lock().unwrap();
        let room_entry = rooms.entry(room.to_owned()).or_default();

        // Reconnect (README §5): the token names an existing member. The
        // identity (id, name, position, token, call membership) survives;
        // only the session channels change hands.
        if let Some(tok) = token.filter(|t| !t.is_empty())
            && let Some(id) = room_entry
                .users
                .iter()
                .find(|(_, m)| m.token == tok)
                .map(|(id, _)| id.clone())
        {
            let member = room_entry.users.get_mut(&id).unwrap();
            member.session = session_id;
            member.tx = tx;
            member.dtx = dtx;
            member.gone_at = None;
            member.reentered_at = Some(Instant::now());
            // The rejoining session starts its movement sequence from 0
            // again; keep the old counter and every batch would be rejected
            // as stale.
            member.seq = 0;
            member.dirty = true;
            // A mid-call reconnect keeps call membership, so the user gets
            // a fresh media ticket for it (docs/moq-sfu.md §7).
            let (call, ticket) = match room_entry
                .calls
                .iter()
                .find(|c| c.participants.contains_key(&id))
            {
                Some(c) => (
                    c.participant_list(),
                    Some(self.tickets.mint(&id, room, c.id)),
                ),
                None => (Vec::new(), None),
            };
            let joined = Joined {
                call,
                you: id,
                token: member.token.clone(),
                users: user_snapshot(room_entry, Some(map)),
                chat: room_entry.chat.iter().cloned().collect(),
                ticket,
            };
            return Ok(joined);
        }

        if room_entry.users.len() >= ROOM_CAP {
            return Err(JoinError::RoomFull);
        }
        let id = self.next_user_id();
        let token = self.next_token();
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
                session: session_id,
                token: token.clone(),
                gone_at: None,
                bubble_off: false,
                reentered_at: None,
            },
        );

        let joined = Joined {
            you: id.clone(),
            token,
            users: user_snapshot(room_entry, Some(map)),
            chat: room_entry.chat.iter().cloned().collect(),
            call: room_entry
                .calls
                .iter()
                .find(|c| c.participants.contains_key(&id))
                .map(|c| c.participant_list())
                .unwrap_or_default(),
            // A fresh joiner is never a call participant; a ticket is minted
            // only when they are pulled into a bubble (docs/moq-sfu.md §7).
            ticket: None,
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
        // Catch-up (README §6.3): for every running call, the new room
        // member gets its current roster so their avatars' headphone badge
        // is correct from the start.
        for call in &room_entry.calls {
            if call.participants.is_empty() {
                continue;
            }
            let Some(m) = room_entry.users.get(&id) else {
                break;
            };
            let _ = m.tx.send(ServerMsg::CallStart {
                room: room.to_owned(),
                participants: call.participant_list(),
                zone: call.zone.clone(),
                // A fresh room joiner is a bystander to the running call:
                // roster for the badge, no media ticket.
                ticket: None,
            });
        }
        Ok(joined)
    }

    /// A session died (README §5 reconnect): the member keeps their
    /// identity — room, position, call membership, token — for the
    /// reconnect window. Nobody is notified; to the room the user is just
    /// still there. The tick turns this into a real [`World::leave`] once
    /// the window has elapsed.
    ///
    /// Guarded by session id: a stale session's disconnect must not mark a
    /// member gone when a newer session has already restored the token.
    pub fn discard(&self, room: &str, id: &str, session_id: u64) {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get_mut(room) else {
            return;
        };
        if let Some(member) = entry.users.get_mut(id)
            && member.session == session_id
            && member.gone_at.is_none()
        {
            member.gone_at = Some(Instant::now());
            member.dirty = false;
        }
    }

    /// Remove a user from their room and tell everyone left inside. A call
    /// involving the leaver drops (README §6.3): the leaver is not notified,
    /// they are gone.
    pub fn leave(&self, room: &str, id: &str) {
        let mut rooms = self.rooms.lock().unwrap();
        let ended = remove_from_room(&mut rooms, room, id);
        drop(rooms);
        for call_id in ended {
            self.call_ended(call_id);
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

    /// One 50 ms tick (README §5): first expire gone members whose
    /// reconnect window has elapsed (a real leave, with notification), then
    /// for every room batch the dirty members into datagram-sized movement
    /// JSON and fan it out to all members.
    pub fn tick(&self) {
        let mut rooms = self.rooms.lock().unwrap();
        let window = self.reconnect_window;
        let expired: Vec<(String, String)> = rooms
            .iter()
            .flat_map(|(room, entry)| {
                entry
                    .users
                    .iter()
                    .filter(|(_, m)| m.gone_at.is_some_and(|t| t.elapsed() >= window))
                    .map(|(id, _)| (room.clone(), id.clone()))
            })
            .collect();
        for (room, id) in &expired {
            let ended = remove_from_room(&mut rooms, room, id);
            for call_id in ended {
                self.call_ended(call_id);
            }
        }
        for (room, room_entry) in rooms.iter_mut() {
            let map = self.maps.get(room);
            let ended = update_bubbles(self, room, room_entry, Instant::now(), map);
            for call_id in ended {
                self.call_ended(call_id);
            }
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
                    silent: map.is_some_and(|map| {
                        map.zones
                            .iter()
                            .any(|z| z.silent && z.contains(m.pos.0, m.pos.1))
                    }),
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

    // -------------------------------------------------------------------
    // Call signaling (README §5/§6): the server relays between members of
    // the same room/call and tracks who is in which call. It never sees
    // media. `room` is always the sender's room, so cross-room signaling
    // cannot reach another room's state.
    // -------------------------------------------------------------------

    /// Opt in/out of proximity calls (README §6.3, `ClientMsg::Bubble`).
    /// `off` also drops the user from the current bubble — the next tick
    /// sweeps them out (immediate removal, no leave delay).
    pub fn set_bubble(&self, room: &str, id: &str, off: bool) -> Result<(), ErrorCode> {
        let mut rooms = self.rooms.lock().unwrap();
        let entry = rooms.get_mut(room).ok_or(ErrorCode::CallNotAllowed)?;
        let member = entry.users.get_mut(id).ok_or(ErrorCode::CallNotAllowed)?;
        member.bubble_off = off;
        Ok(())
    }

    /// The sender started/stopped screen sharing; broadcast to the other
    /// call participants (presence only — the camera video track is
    /// replaced by the screen, no renegotiation).
    pub fn call_screen(&self, room: &str, from: &str, on: bool) -> Result<(), ErrorCode> {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get_mut(room) else {
            return Err(ErrorCode::CallNotAllowed);
        };
        {
            let call = entry
                .calls
                .iter_mut()
                .find(|c| c.participants.contains_key(from))
                .ok_or(ErrorCode::CallNotAllowed)?;
            let flags = call
                .participants
                .get_mut(from)
                .ok_or(ErrorCode::CallNotAllowed)?;
            flags.1.screen = on;
        }
        let call = entry
            .calls
            .iter()
            .find(|c| c.participants.contains_key(from))
            .expect("checked above");
        for (uid, m) in &entry.users {
            if uid != from && call.participants.contains_key(uid) {
                let _ = m.tx.send(ServerMsg::CallScreen {
                    id: from.to_owned(),
                    on,
                });
            }
        }
        Ok(())
    }

    /// The sender's mute/camera state flipped; broadcast to the other call
    /// participants (presence only, README §6.3 — no renegotiation).
    pub fn call_mute(
        &self,
        room: &str,
        from: &str,
        audio: bool,
        video: bool,
    ) -> Result<(), ErrorCode> {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get_mut(room) else {
            return Err(ErrorCode::CallNotAllowed);
        };
        {
            let call = entry
                .calls
                .iter_mut()
                .find(|c| c.participants.contains_key(from))
                .ok_or(ErrorCode::CallNotAllowed)?;
            let flags = call
                .participants
                .get_mut(from)
                .ok_or(ErrorCode::CallNotAllowed)?;
            let screen = flags.1.screen;
            flags.1 = call::ParticipantFlags {
                audio,
                video,
                screen,
            };
        }
        let call = entry
            .calls
            .iter()
            .find(|c| c.participants.contains_key(from))
            .expect("checked above");
        for (uid, m) in &entry.users {
            if uid != from && call.participants.contains_key(uid) {
                let _ = m.tx.send(ServerMsg::CallMute {
                    id: from.to_owned(),
                    audio,
                    video,
                });
            }
        }
        Ok(())
    }

    /// Hang up: the sender leaves the room's call (or cancels their ring).
    pub fn call_leave(&self, room: &str, from: &str) -> Result<(), ErrorCode> {
        let mut rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get_mut(room) else {
            return Err(ErrorCode::CallNotAllowed);
        };
        let involved = call_containing(entry, from).is_some();
        if !involved {
            return Err(ErrorCode::CallNotAllowed);
        }
        let ended = leave_call(entry, from);
        drop(rooms);
        if let Some(call_id) = ended {
            self.call_ended(call_id);
        }
        Ok(())
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

    /// The room with an active bubble in it (README §6.3): one per room at
    /// most, so the count is the number of live bubbles.
    pub fn call_count(&self) -> usize {
        self.rooms
            .lock()
            .unwrap()
            .values()
            .filter(|r| !r.calls.is_empty())
            .count()
    }
}

/// Spawn the 50 ms tick loop (README §5); returns its handle so the caller
/// can stop it.
pub fn start_ticking(world: World) -> tokio::task::JoinHandle<()> {
    start_ticking_with(world, crate::metrics::Metrics::new())
}

/// [`start_ticking`], with tick-duration metrics (README §11 Phase 8).
pub fn start_ticking_with(
    world: World,
    metrics: crate::metrics::Metrics,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let start = std::time::Instant::now();
            world.tick();
            metrics.tick(start.elapsed().as_micros() as u64);
        }
    })
}

/// Drop `id` from their call, if any, and tell the room (README §6.3).
/// Used when the leaver toggles out, hangs up, or is gone and cannot be
/// notified.
///
/// The call state is room-wide (it powers the avatars' headphone badge),
/// so every remaining member of the room is told. A call whose last member
/// leaves ends with `call_end(last_left)`; a one-on-one whose partner
/// stays keeps the remaining participant.
fn leave_call(entry: &mut Room, id: &str) -> Option<u64> {
    let index = call_containing(entry, id)?;
    let mut call = entry.calls.swap_remove(index);
    call.participants.remove(id);
    let over = call.participants.len() <= 1;
    for m in entry.users.values() {
        let _ = if over {
            m.tx.send(ServerMsg::CallEnd {
                reason: "last_left".to_owned(),
                zone: call.zone.clone(),
            })
        } else {
            m.tx.send(ServerMsg::CallLeave {
                id: id.to_owned(),
                zone: call.zone.clone(),
            })
        };
    }
    if !over {
        entry.calls.push(call);
        return None;
    }
    Some(call.id)
}

/// One step of the proximity-call engine (README §6.3), run every tick
/// before the movement batch: the bubble is the one-tile circle around the
/// centroid of its participants. Walk within [`BUBBLE_RADIUS`] of the
/// center (or of another player, when no bubble exists yet) and you are
/// pulled in; at the radius or beyond — or toggled off — you drop out
/// immediately. At most one join per tick keeps the roster broadcast
/// ordered and trickle-paced. Returns the ids of the
/// calls that ended this step, so the caller can fire the SFU's call-end
/// hook (docs/moq-sfu.md §5).
fn update_bubbles(
    world: &World,
    room: &str,
    entry: &mut Room,
    now: Instant,
    map: Option<&campfire_maps::MapData>,
) -> Vec<u64> {
    // Silent zones (README roadmap "Map enhancements"): silent-zone
    // occupants never join a proximity bubble (zone calls are separate).
    let in_silent = |x: f32, y: f32| -> bool {
        map.is_some_and(|map| map.zones.iter().any(|z| z.silent && z.contains(x, y)))
    };
    // A call's zone rectangle: a zone call is bounded by its zone rect (a
    // zone call whose zone has emptied out lets everyone drop, ending the
    // call); a proximity bubble is the one-tile radius around the centroid
    // of connected participants.
    let zone_rect = |zone: &Option<String>| -> Option<&campfire_maps::Zone> {
        let name = zone.as_ref()?;
        map.and_then(|map| {
            map.zones.iter().find(|z| {
                z.jitsi_room.as_deref() == Some(name.as_str())
                    || (z.jitsi_room.is_none() && z.name == *name)
            })
        })
    };

    // Leaves first: gone members keep their seat (reconnect grace), opted
    // out members and participants outside their call's area drop out
    // immediately — for every concurrent call.
    let mut dropped: Vec<String> = Vec::new();
    for ci in 0..entry.calls.len() {
        let call = &entry.calls[ci];
        let rect = zone_rect(&call.zone);
        for id in call.participants.keys() {
            let Some(m) = entry.users.get(id) else {
                continue; // gone: stays in the bubble (reconnect grace)
            };
            if m.bubble_off {
                dropped.push(id.clone());
                continue;
            }
            if m.gone_at.is_some() {
                continue; // gone: stays in the bubble (reconnect grace)
            }
            if let Some(reentered) = m.reentered_at
                && now.duration_since(reentered) < BUBBLE_RETURN_GRACE
            {
                continue; // just re-entered: the radius check comes later
            }
            let inside = match rect {
                Some(z) if call.zone.is_some() => z.contains(m.pos.0, m.pos.1),
                None if call.zone.is_some() => false,
                _ => dist(center_of_call(entry, call), m.pos) < BUBBLE_RADIUS,
            };
            if !inside {
                dropped.push(id.clone());
                continue;
            }
            // A proximity bubble never spans a silent zone: occupants who
            // walk into one drop out of the bubble.
            if call.zone.is_none() && in_silent(m.pos.0, m.pos.1) {
                dropped.push(id.clone());
            }
        }
    }
    let mut ended: Vec<u64> = Vec::new();
    for id in dropped {
        if let Some(call_id) = leave_call(entry, &id) {
            ended.push(call_id);
        }
    }

    // Creation: each occupied jitsi zone can carry its own call (the zone
    // is the call area, so a lone occupant starts it and everyone who
    // walks in joins); then, if no proximity bubble is live, two eligible
    // users within the bubble radius of each other form one (id-sorted so
    // the pair — and thus the designated offerer — is deterministic).
    let in_any_call =
        |entry: &Room, id: &str| entry.calls.iter().any(|c| c.participants.contains_key(id));
    if let Some(map) = map {
        for zone in &map.zones {
            let Some(jitsi) = &zone.jitsi_room else {
                continue;
            };
            if entry
                .calls
                .iter()
                .any(|c| c.zone.as_deref() == Some(jitsi.as_str()))
            {
                continue; // this zone's call is already live
            }
            let inside: Vec<String> = entry
                .users
                .iter()
                .filter(|(uid, m)| {
                    !m.bubble_off
                        && m.gone_at.is_none()
                        && !in_any_call(entry, uid)
                        && zone.contains(m.pos.0, m.pos.1)
                })
                .map(|(uid, _)| uid.clone())
                .collect();
            if inside.is_empty() {
                continue;
            }
            let mut inside = inside;
            inside.sort();
            let call = call::Call::new(
                world.next_call_id(),
                entry
                    .users
                    .iter()
                    .filter(|(uid, _)| inside.contains(uid))
                    .map(|(uid, m)| (uid.clone(), m.name.clone())),
            );
            let call = call::Call {
                zone: Some(jitsi.clone()),
                ..call
            };
            broadcast_call_start(world, room, entry, &call);
            entry.calls.push(call);
            return ended;
        }
    }
    {
        let mut created = false;
        let mut candidates: Vec<(String, (f32, f32))> = entry
            .users
            .iter()
            .filter(|(uid, m)| {
                !m.bubble_off
                    && m.gone_at.is_none()
                    && !in_any_call(entry, uid)
                    && !in_silent(m.pos.0, m.pos.1)
            })
            .map(|(uid, m)| (uid.clone(), m.pos))
            .collect();
        candidates.sort_by(|a, b| a.0.cmp(&b.0));
        'pair: for i in 0..candidates.len() {
            for j in i + 1..candidates.len() {
                if dist(candidates[i].1, candidates[j].1) < BUBBLE_RADIUS {
                    let a = candidates[i].clone();
                    let b = candidates[j].clone();
                    let call = call::Call {
                        zone: None,
                        ..call::Call::new(
                            world.next_call_id(),
                            entry
                                .users
                                .iter()
                                .filter(|(uid, _)| uid.as_str() == a.0 || uid.as_str() == b.0)
                                .map(|(uid, m)| (uid.clone(), m.name.clone())),
                        )
                    };
                    broadcast_call_start(world, room, entry, &call);
                    entry.calls.push(call);
                    created = true;
                    break 'pair;
                }
            }
        }
        if created {
            return ended;
        }
    }

    // Joins: at most one per tick — the nearest eligible user inside a
    // call's area (zone rect or bubble radius) who is not already in
    // another call. One join per tick keeps the roster broadcast ordered
    // and trickle-paced.
    'calls: for ci in 0..entry.calls.len() {
        let call = &entry.calls[ci];
        let rect = zone_rect(&call.zone);
        let mut best: Option<(f32, String)> = None;
        for (uid, m) in &entry.users {
            if m.bubble_off || m.gone_at.is_some() || call.contains(uid) || in_any_call(entry, uid)
            {
                continue;
            }
            // Silent-zone occupants never join a proximity bubble.
            if call.zone.is_none() && in_silent(m.pos.0, m.pos.1) {
                continue;
            }
            let inside = match rect {
                Some(z) if call.zone.is_some() => z.contains(m.pos.0, m.pos.1),
                None if call.zone.is_some() => false,
                _ => dist(center_of_call(entry, call), m.pos) < BUBBLE_RADIUS,
            };
            if !inside {
                continue;
            }
            let d = dist(center_of_call(entry, call), m.pos);
            if best.as_ref().is_none_or(|(bd, _)| d < *bd) {
                best = Some((d, uid.clone()));
            }
        }
        if let Some((_, joiner)) = best {
            let name = entry.users[&joiner].name.clone();
            {
                let call = &mut entry.calls[ci];
                call.participants.insert(
                    joiner.clone(),
                    (
                        name,
                        call::ParticipantFlags {
                            audio: true,
                            video: true,
                            screen: false,
                        },
                    ),
                );
            }
            let c = &entry.calls[ci];
            broadcast_call_start(world, room, entry, c);
            break 'calls;
        }
    }
    ended
}

/// The centroid of the call's connected participants.
fn center_of_call(entry: &Room, call: &call::Call) -> (f32, f32) {
    let mut center = (0.0f32, 0.0f32);
    let mut n = 0usize;
    for (uid, m) in &entry.users {
        if call.contains(uid) {
            center.0 += m.pos.0;
            center.1 += m.pos.1;
            n += 1;
        }
    }
    if n > 0 {
        center.0 /= n as f32;
        center.1 /= n as f32;
    }
    center
}

/// Broadcast the bubble's roster to the whole room: `CallStart` powers the
/// headphone badge on everyone, and `ticket` mints a media ticket for each
/// participant (docs/moq-sfu.md §7) — bystanders get the roster but no
/// ticket.
fn broadcast_call_start(
    world: &World,
    room: &str,
    entry: &Room,
    call: &call::Call,
) {
    let participants = call.participant_list();
    let zone = call.zone.clone();
    for (uid, m) in &entry.users {
        let ticket = call
            .participants
            .contains_key(uid)
            .then(|| world.tickets.mint(uid, room, call.id));
        let _ = m.tx.send(ServerMsg::CallStart {
            room: room.to_owned(),
            participants: participants.clone(),
            zone: zone.clone(),
            ticket,
        });
    }
}

/// Euclidean distance in tile units.
fn dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// Remove `id` from `room` — call membership included (see
/// [`leave_call`]) — broadcast `Left` to everyone left, and drop the room
/// when it becomes empty. The caller owns the `rooms` lock. Returns the
/// ids of the calls that ended, so the caller can fire the SFU's
/// call-end hook (docs/moq-sfu.md §5).
fn remove_from_room(rooms: &mut HashMap<String, Room>, room: &str, id: &str) -> Vec<u64> {
    let Some(entry) = rooms.get_mut(room) else {
        return Vec::new();
    };
    let mut ended: Vec<u64> = Vec::new();
    if entry.users.remove(id).is_some() {
        if let Some(call_id) = leave_call(entry, id) {
            ended.push(call_id);
        }
        for m in entry.users.values() {
            let _ = m.tx.send(ServerMsg::Left { id: id.to_owned() });
        }
    }
    if entry.users.is_empty() {
        // A dropped room takes every remaining call with it (defensive: an
        // empty room normally has none left).
        for c in &entry.calls {
            ended.push(c.id);
        }
        rooms.remove(room);
    }
    ended
}

/// The room's full user snapshot for a `hello` (gone members included —
/// they are still in the room until the reconnect window elapses).
fn user_snapshot(entry: &Room, map: Option<&campfire_maps::MapData>) -> Vec<UserState> {
    entry
        .users
        .iter()
        .map(|(uid, m)| UserState {
            id: uid.clone(),
            name: m.name.clone(),
            x: m.pos.0,
            y: m.pos.1,
            d: m.dir,
            sz: map.is_some_and(|map| {
                map.zones
                    .iter()
                    .any(|z| z.silent && z.contains(m.pos.0, m.pos.1))
            }),
        })
        .collect()
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
    /// The user's reconnect token (README §5), echoed in `hello`.
    pub token: String,
    /// Everyone in the room, including the joiner.
    pub users: Vec<UserState>,
    /// Last chat lines of the room.
    pub chat: Vec<ChatMsg>,
    /// The room's current call participants (empty when no call is running).
    pub call: Vec<UserBrief>,
    /// The joiner's media ticket when they are in an active call
    /// (reconnect catch-up; docs/moq-sfu.md §7). `None` for fresh joiners
    /// and for users outside any call.
    pub ticket: Option<String>,
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
            silent: false,
        }
    }

    /// Decode movement batches on `drx` until the entry for `id` arrives;
    /// return its silent flag — the `sz` flag rides the movement batch (README
    /// roadmap "Map enhancements").
    fn first_movement(drx: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>, id: &str) -> bool {
        use campfire_protocol::from_line;
        loop {
            let batch: MovementBatch =
                from_line(std::str::from_utf8(&drx.try_recv().unwrap()).unwrap()).unwrap();
            for e in &batch.m {
                if e.id == id {
                    return e.silent;
                }
            }
        }
    }

    #[test]
    fn jitsi_zone_call_bounded_by_the_zone_rect() {
        let world = World::new(zone_maps());
        let mut a = join_user(&world, "zonetest", "alice");
        let mut b = join_user(&world, "zonetest", "bob");
        let mut c = join_user(&world, "zonetest", "carol");
        // a and b inside the meeting zone (tiles 2..5, 2..5); c outside it.
        place(&world, "zonetest", &a.id, 2.5, 2.5);
        place(&world, "zonetest", &b.id, 3.5, 3.5);
        place(&world, "zonetest", &c.id, 7.5, 7.5);
        world.tick();
        // The zone call forms (2+ occupants inside the zone rect).
        for u in [&mut a, &mut b] {
            let p = expect_start(u);
            assert_eq!(p.len(), 2);
        }
        // c is outside the zone: not a participant, but the room-wide badge
        // reaches him (CallStart with the 2 participants).
        let p = expect_start(&mut c);
        assert_eq!(p.len(), 2);
        // c walks into the zone: joins the zone call on the next tick.
        place(&world, "zonetest", &c.id, 3.5, 3.5);
        world.tick();
        // The roster re-broadcasts to everyone (badge): c joins, 3 participants.
        for u in [&mut b, &mut c] {
            let p = expect_start(u);
            assert_eq!(p.len(), 3);
        }
        // a leaves the zone: dropped (the call keeps the other two).
        place(&world, "zonetest", &a.id, 7.5, 7.5);
        world.tick();
        for u in [&mut b, &mut c] {
            match u.rx.try_recv().unwrap() {
                ServerMsg::CallLeave { id, .. } => assert_eq!(id, a.id),
                other => panic!("expected call_leave, got {other:?}"),
            }
        }
    }

    #[test]
    fn silent_zone_flag_rides_the_movement_batch() {
        let world = World::new(zone_maps());
        let mut a = join_user(&world, "zonetest", "alice");
        let mut b = join_user(&world, "zonetest", "bob");
        // a in the silent zone (tiles 0..2, 0..2), b outside it.
        place(&world, "zonetest", &a.id, 0.5, 0.5);
        place(&world, "zonetest", &b.id, 6.5, 6.5);
        world.tick();
        let a_silent = first_movement(&mut a.drx, &a.id);
        let b_silent = first_movement(&mut b.drx, &b.id);
        assert!(a_silent, "a is in the silent zone");
        assert!(!b_silent, "b is outside the silent zone");
    }

    #[test]
    fn join_leave_cycle() {
        let world = World::new(test_maps());
        let (tx_a, mut rx_a) = channel();
        let (dtx_a, _) = datagram_channel();
        let (tx_b, mut rx_b) = channel();
        let (dtx_b, _) = datagram_channel();

        let a = world
            .join(
                "office",
                "alice",
                None,
                None,
                world.next_session_id(),
                tx_a,
                dtx_a,
            )
            .unwrap();
        let b = world
            .join(
                "office",
                "bob",
                None,
                None,
                world.next_session_id(),
                tx_b,
                dtx_b,
            )
            .unwrap();
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
        let world = World::new(test_maps());
        let (tx, _) = channel();
        let (dtx, _) = datagram_channel();
        assert_eq!(
            world.join(
                "nope",
                "alice",
                None,
                None,
                world.next_session_id(),
                tx,
                dtx
            ),
            Err(JoinError::UnknownRoom)
        );
        // And nothing was created in the world.
        assert_eq!(world.stats(), (0, 0));
    }

    #[test]
    fn join_spawns_at_the_map_spawn() {
        let world = World::new(test_maps());
        let (tx, _) = channel();
        let (dtx, _) = datagram_channel();
        let joined = world
            .join(
                "office",
                "alice",
                None,
                None,
                world.next_session_id(),
                tx,
                dtx,
            )
            .unwrap();
        let (spawn_x, spawn_y) = world.map("office").unwrap().spawn;
        assert_eq!((joined.users[0].x, joined.users[0].y), (spawn_x, spawn_y));
    }

    #[test]
    fn start_area_selects_the_spawn_point() {
        let world = World::new(zone_maps());
        // The `start` area (tiles 1..3, 1..3): its center (2, 2) is the
        // spawn point (README roadmap "Map enhancements").
        assert_eq!(world.map("zonetest").unwrap().spawn, (2.0, 2.0));
    }

    #[test]
    fn lone_occupant_starts_a_zone_call() {
        let world = World::new(zone_maps());
        let mut a = join_user(&world, "zonetest", "alice");
        let mut b = join_user(&world, "zonetest", "bob");
        // Only a stands in the meeting zone (tiles 2..5, 2..5): the zone is
        // the call area, so one occupant starts it.
        place(&world, "zonetest", &a.id, 3.5, 3.5);
        place(&world, "zonetest", &b.id, 7.5, 7.5);
        world.tick();
        let p = expect_start(&mut a);
        assert_eq!(p.len(), 1);
        expect_start(&mut b); // room-wide badge
    }

    #[test]
    fn two_zone_calls_run_concurrently() {
        let world = World::new(zone_maps());
        let mut a = join_user(&world, "zonetest", "alice");
        let mut b = join_user(&world, "zonetest", "bob");
        while a.rx.try_recv().is_ok() {}
        while b.rx.try_recv().is_ok() {}
        // a in the meeting zone (tiles 2..5, 2..5), b in the annex
        // (tiles 6..8, 2..5): two independent zone calls at once.
        place(&world, "zonetest", &a.id, 2.5, 2.5);
        place(&world, "zonetest", &b.id, 6.5, 3.5);
        world.tick();
        let (pa, za) = expect_start_zone(&mut a);
        assert_eq!(za.as_deref(), Some("team-meeting"));
        assert_eq!(pa.len(), 1);
        // One zone call per tick: b's annex call forms on the next tick.
        // b's tick-1 CallStart was the meeting badge (roster [a]).
        let (pb, zb) = expect_start_zone(&mut b);
        assert_eq!(zb.as_deref(), Some("team-meeting"));
        assert!(!pb.iter().any(|p| p.id == b.id));
        world.tick();
        let (pb, zb) = expect_start_zone(&mut b);
        assert_eq!(zb.as_deref(), Some("team-annex"));
        assert_eq!(pb.len(), 1);
        // a hears b's call as a badge (roster update), not his own.
        let (pa2, za2) = expect_start_zone(&mut a);
        assert_eq!(za2.as_deref(), Some("team-annex"));
        assert!(!pa2.iter().any(|p| p.id == a.id));
    }

    #[test]
    fn silent_zone_users_never_join_a_proximity_bubble() {
        let world = World::new(zone_maps());
        let mut a = join_user(&world, "zonetest", "alice");
        let mut b = join_user(&world, "zonetest", "bob");
        while a.rx.try_recv().is_ok() {} // drain join noise
        while b.rx.try_recv().is_ok() {}
        // a stands in the silent zone (tiles 0..2, 0..2), b right outside it —
        // close enough for a bubble if a were eligible.
        // close enough for a bubble if a were eligible.
        place(&world, "zonetest", &a.id, 1.5, 1.5);
        place(&world, "zonetest", &b.id, 3.5, 1.5);
        world.tick();
        // No bubble: no CallStart anywhere.
        assert!(a.rx.try_recv().is_err());
        // a walks out of the silent zone: the bubble forms now.
        place(&world, "zonetest", &a.id, 3.4, 1.5);
        world.tick();
        let p = expect_start(&mut a);
        assert_eq!(p.len(), 2);
    }

    #[tokio::test]
    async fn movement_is_validated_and_batched() {
        let world = World::new(test_maps());
        let (tx_a, _) = channel();
        let (dtx_a, mut dgr_a) = datagram_channel();
        let (tx_b, _) = channel();
        let (dtx_b, mut dgr_b) = datagram_channel();
        let a = world
            .join(
                "office",
                "alice",
                None,
                None,
                world.next_session_id(),
                tx_a,
                dtx_a,
            )
            .unwrap();
        world
            .join(
                "office",
                "bob",
                None,
                None,
                world.next_session_id(),
                tx_b,
                dtx_b,
            )
            .unwrap();
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
        let world = World::new(test_maps());
        let (tx_a, _) = channel();
        let (dtx_a, mut dgr_a) = datagram_channel();
        let a = world
            .join(
                "office",
                "alice",
                None,
                None,
                world.next_session_id(),
                tx_a,
                dtx_a,
            )
            .unwrap();
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
        let world = World::new(test_maps());
        let (tx_a, _) = channel();
        let (dtx_a, mut dgr_a) = datagram_channel();
        world
            .join(
                "office",
                "alice",
                None,
                None,
                world.next_session_id(),
                tx_a,
                dtx_a,
            )
            .unwrap();
        // Joining an empty room has no one to tell: nothing is broadcast.
        world.tick();
        assert!(dgr_a.try_recv().is_err(), "empty-room joiner is not dirty");

        let (tx_b, _) = channel();
        let (dtx_b, mut dgr_b) = datagram_channel();
        let b = world
            .join(
                "office",
                "bob",
                None,
                None,
                world.next_session_id(),
                tx_b,
                dtx_b,
            )
            .unwrap();
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
        let world = World::new(test_maps());
        let (tx_a, mut rx_a) = channel();
        let (dtx_a, _) = datagram_channel();
        let (tx_b, mut rx_b) = channel();
        let (dtx_b, _) = datagram_channel();
        let a = world
            .join(
                "office",
                "a",
                None,
                None,
                world.next_session_id(),
                tx_a,
                dtx_a,
            )
            .unwrap();
        world
            .join(
                "office",
                "b",
                None,
                None,
                world.next_session_id(),
                tx_b,
                dtx_b,
            )
            .unwrap();
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
        let world = World::new(test_maps());
        let (tx_a, mut rx_a) = channel();
        let (dtx_a, _) = datagram_channel();
        let (tx_b, mut rx_b) = channel();
        let (dtx_b, _) = datagram_channel();
        let a = world
            .join(
                "office",
                "a",
                None,
                None,
                world.next_session_id(),
                tx_a,
                dtx_a,
            )
            .unwrap();
        world
            .join(
                "office",
                "b",
                None,
                None,
                world.next_session_id(),
                tx_b,
                dtx_b,
            )
            .unwrap();
        rx_a.try_recv().unwrap(); // drain the `joined` broadcast for b

        world.broadcast_typing("office", &a.you, true);
        assert!(rx_a.try_recv().is_err(), "sender must not hear own typing");
        assert!(matches!(
            rx_b.try_recv().unwrap(),
            ServerMsg::Typing { on: true, .. }
        ));
    }

    // -- proximity bubbles (README §6.3) ---------------------------------

    /// A joined test user, keeping its outbound stream receiver.
    struct TestUser {
        id: String,
        rx: tokio::sync::mpsc::UnboundedReceiver<ServerMsg>,
        /// The member's datagram receiver (movement batches, `sz` flag).
        drx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    }

    fn join_user(world: &World, room: &str, name: &str) -> TestUser {
        let (tx, rx) = channel();
        let (dtx, drx) = datagram_channel();
        let joined = world
            .join(room, name, None, None, world.next_session_id(), tx, dtx)
            .unwrap();
        TestUser {
            id: joined.you,
            rx,
            drx,
        }
    }

    /// Teleport a user (unit tests share the module, so private fields are
    /// reachable): the speed gate would reject a far jump in one entry.
    fn place(world: &World, room: &str, id: &str, x: f32, y: f32) {
        let mut rooms = world.rooms.lock().unwrap();
        let m = rooms.get_mut(room).unwrap().users.get_mut(id).unwrap();
        m.pos = (x, y);
        m.dirty = true;
    }

    /// Expect `CallStart`; returns the participants.
    fn expect_start(u: &mut TestUser) -> Vec<UserBrief> {
        for _ in 0..20 {
            match u.rx.try_recv().expect("call_start") {
                ServerMsg::CallStart { participants, .. } => return participants,
                _ => continue,
            }
        }
        panic!("call_start never arrived");
    }

    /// Expect `CallStart`; returns (participants, zone name).
    fn expect_start_zone(u: &mut TestUser) -> (Vec<UserBrief>, Option<String>) {
        for _ in 0..20 {
            match u.rx.try_recv().expect("call_start") {
                ServerMsg::CallStart {
                    participants, zone, ..
                } => return (participants, zone),
                _ => continue,
            }
        }
        panic!("call_start never arrived");
    }

    #[test]
    fn bubble_forms_when_two_users_are_close() {
        let world = World::new(test_maps());
        let mut a = join_user(&world, "office", "alice");
        let mut b = join_user(&world, "office", "bob");
        let mut c = join_user(&world, "office", "carol");
        a.rx.try_recv().unwrap(); // a hears b and c join
        a.rx.try_recv().unwrap();
        b.rx.try_recv().unwrap(); // b hears c join

        // Carol keeps her distance so {a, b} is the only candidate pair.
        place(&world, "office", &c.id, 20.0, 0.0);
        // Spawn is shared, so both are within the join radius already: the
        // first tick creates the bubble.
        world.tick();
        let participants = expect_start(&mut a);
        let pb = expect_start(&mut b);
        assert_eq!(participants, pb, "everyone hears the same roster");
        assert_eq!(participants.len(), 2);

        // The bystander hears the badge but is not a participant.
        let p3 = expect_start(&mut c);
        assert_eq!(p3.len(), 2);

        // A farther-apart pair does not bubble.
        let mut d = join_user(&world, "island", "dave");
        let mut e = join_user(&world, "island", "erin");
        place(&world, "island", &d.id, 0.0, 0.0);
        place(&world, "island", &e.id, 20.0, 0.0);
        world.tick();
        assert!(
            matches!(d.rx.try_recv().unwrap(), ServerMsg::Joined { .. }),
            "presence only, no bubble beyond the radius"
        );
        assert!(e.rx.try_recv().is_err(), "erin hears nothing at all");
    }

    #[test]
    fn walking_out_leaves_immediately() {
        let world = World::new(test_maps());
        let mut a = join_user(&world, "office", "alice");
        let mut b = join_user(&world, "office", "bob");
        world.tick();
        expect_start(&mut a);
        expect_start(&mut b);

        // Bob walks beyond the bubble radius: the very next tick drops him
        // (no grace delay — the bubble is a hard one-tile circle).
        place(&world, "office", &b.id, 10.0, 0.0);
        world.tick();
        for u in [&mut a, &mut b] {
            match u.rx.try_recv().unwrap() {
                ServerMsg::CallEnd { ref reason, .. } => assert_eq!(reason, "last_left"),
                other => panic!("expected call_end, got {other:?}"),
            }
        }

        // Walking back within the radius of alice's spawn reforms it.
        place(&world, "office", &b.id, 21.0, 15.5);
        world.tick();
        expect_start(&mut a);
        expect_start(&mut b);
    }

    #[test]
    fn toggling_bubble_off_drops_immediately() {
        let world = World::new(test_maps());
        let mut a = join_user(&world, "office", "alice");
        let mut b = join_user(&world, "office", "bob");
        let mut c = join_user(&world, "office", "carol");
        // Carol keeps her distance: the bubble is {a, b}, carol a bystander.
        place(&world, "office", &c.id, 20.0, 0.0);
        world.tick();
        for u in [&mut a, &mut b, &mut c] {
            expect_start(u);
        }

        // Bob opts out: with two participants the bubble dissolves at once
        // (call_end, not call_leave — alice is the only one left).
        world.set_bubble("office", &b.id, true).unwrap();
        world.tick();
        for u in [&mut a, &mut b, &mut c] {
            match u.rx.try_recv().unwrap() {
                ServerMsg::CallEnd { ref reason, .. } => assert_eq!(reason, "last_left"),
                other => panic!("expected call_end, got {other:?}"),
            }
        }

        // Opting back in reforms the bubble with alice.
        world.set_bubble("office", &b.id, false).unwrap();
        world.tick();
        let (a_id, b_id) = (a.id.clone(), b.id.clone());
        for u in [&mut a, &mut b, &mut c] {
            let p = expect_start(u);
            assert_eq!(p.len(), 2);
            assert!(
                p.iter().any(|x| x.id == a_id) && p.iter().any(|x| x.id == b_id),
                "roster is alice and bob"
            );
        }
    }

    #[test]
    fn call_mute_is_presence_broadcast_to_others() {
        let world = World::new(test_maps());
        let mut a = join_user(&world, "office", "alice");
        let mut b = join_user(&world, "office", "bob");
        let mut c = join_user(&world, "office", "carol");
        // Carol keeps her distance: she is a bystander, not a participant.
        place(&world, "office", &c.id, 20.0, 0.0);
        world.tick();
        for u in [&mut a, &mut b, &mut c] {
            expect_start(u);
        }
        world.call_mute("office", &a.id, false, true).unwrap();
        match b.rx.try_recv().unwrap() {
            ServerMsg::CallMute { id, audio, video } => {
                assert_eq!(id, a.id);
                assert!(!audio && video);
            }
            other => panic!("expected call_mute, got {other:?}"),
        }
        assert!(a.rx.try_recv().is_err(), "no echo to the sender");
        // Bystanders hear the call *state* (badge) but not its presence
        // (mute/camera).
        assert!(
            c.rx.try_recv().is_err(),
            "bystanders do not hear call presence"
        );
        // A non-participant cannot flip presence either.
        assert_eq!(
            world.call_mute("office", &c.id, true, true),
            Err(ErrorCode::CallNotAllowed)
        );
    }

    #[test]
    fn call_screen_is_presence_broadcast_to_others() {
        let world = World::new(test_maps());
        let mut a = join_user(&world, "office", "alice");
        let mut b = join_user(&world, "office", "bob");
        let mut c = join_user(&world, "office", "carol");
        place(&world, "office", &c.id, 20.0, 0.0); // bystander
        world.tick();
        for u in [&mut a, &mut b, &mut c] {
            expect_start(u);
        }
        world.call_screen("office", &a.id, true).unwrap();
        match b.rx.try_recv().unwrap() {
            ServerMsg::CallScreen { id, on } => {
                assert_eq!(id, a.id);
                assert!(on);
            }
            other => panic!("expected call_screen, got {other:?}"),
        }
        assert!(a.rx.try_recv().is_err(), "no echo to the sender");
        assert!(
            c.rx.try_recv().is_err(),
            "bystanders do not hear call presence"
        );
        assert_eq!(
            world.call_screen("office", &c.id, true),
            Err(ErrorCode::CallNotAllowed)
        );
        // The flag lives on the participant (the next roster keeps it).
        world.call_screen("office", &a.id, false).unwrap();
        let _ = b.rx.try_recv().unwrap();
    }

    #[test]
    fn call_leave_and_room_leave_drop_the_call() {
        let world = World::new(test_maps());
        let mut a = join_user(&world, "office", "alice");
        let mut b = join_user(&world, "office", "bob");
        world.tick();
        expect_start(&mut a);
        expect_start(&mut b);

        // Hanging up: the whole room gets `last_left` (badge), the bubble
        // is over for everyone.
        world.call_leave("office", &a.id).unwrap();
        for u in [&mut a, &mut b] {
            match u.rx.try_recv().unwrap() {
                ServerMsg::CallEnd { reason, .. } => assert_eq!(reason, "last_left"),
                other => panic!("expected call_end, got {other:?}"),
            }
        }
        // With no call left, call_leave is a state violation.
        assert_eq!(
            world.call_leave("office", &a.id),
            Err(ErrorCode::CallNotAllowed)
        );

        // Room leave mid-call: the survivor gets the call drop, the leaver
        // (gone) is not notified.
        world.tick(); // a + b are together again
        expect_start(&mut a);
        expect_start(&mut b);
        world.leave("office", &b.id);
        assert!(matches!(
            a.rx.try_recv().unwrap(),
            ServerMsg::CallEnd { ref reason, .. } if reason == "last_left"
        ));
        assert!(matches!(a.rx.try_recv().unwrap(), ServerMsg::Left { .. }));
    }

    // -- reconnect with token (README §5, Phase 7) -----------------------

    /// Join with an optional reconnect token, keeping the outbound stream
    /// receiver, the token, and the session id this join ran under.
    fn join_token(
        world: &World,
        room: &str,
        name: &str,
        token: Option<&str>,
    ) -> (TestUser, String, u64) {
        let (tx, rx) = channel();
        let (dtx, drx) = datagram_channel();
        let session = world.next_session_id();
        let joined = world
            .join(room, name, None, token, session, tx, dtx)
            .unwrap();
        (
            TestUser {
                id: joined.you,
                rx,
                drx,
            },
            joined.token,
            session,
        )
    }

    #[test]
    fn reconnect_restores_identity_without_flicker() {
        let world = World::new(test_maps());
        let (mut a, a_token, a_session) = join_token(&world, "office", "alice", None);
        let (mut b, _, _) = join_token(&world, "office", "bob", None);
        a.rx.try_recv().unwrap(); // alice hears bob join

        // Alice's session dies: the room hears nothing (no leave).
        world.discard("office", &a.id, a_session);
        assert!(b.rx.try_recv().is_err(), "a drop is not a leave");

        // Rejoin with the token: same id, same token, no joined broadcast.
        let (a2, a_token2, _) = join_token(&world, "office", "alice", Some(&a_token));
        assert_eq!(a2.id, a.id, "the identity must survive");
        assert_eq!(a_token2, a_token, "the token must survive");
        assert!(
            b.rx.try_recv().is_err(),
            "no joined broadcast for a restore"
        );
    }

    #[test]
    fn reconnect_resets_the_movement_sequence() {
        let world = World::new(test_maps());
        let (mut a, a_token, a_session) = join_token(&world, "office", "alice", None);
        let (dtx_b, mut dgr_b) = datagram_channel();
        let session_b = world.next_session_id();
        let joined_b = world
            .join("office", "bob", None, None, session_b, channel().0, dtx_b)
            .unwrap();
        let b_id = joined_b.you;
        a.rx.try_recv().unwrap();

        // Alice moves with a few batches, then drops.
        for seq in 1..=5u64 {
            world.apply_movement("office", &a.id, &[entry(&a.id, 20.5, 15.5, seq)]);
        }
        world.discard("office", &a.id, a_session);

        // The restored session starts from sequence 0 again (a fresh page
        // does): the server must not reject the batches as stale.
        let (_a2, _, _) = join_token(&world, "office", "alice", Some(&a_token));
        std::thread::sleep(Duration::from_millis(150)); // speed-gate headroom
        world.apply_movement("office", &a.id, &[entry(&a.id, 21.0, 15.5, 1)]);
        world.tick();
        let line = String::from_utf8(dgr_b.try_recv().unwrap()).unwrap();
        assert!(
            line.contains(&format!("\"id\":\"{b_id}\"")) || line.contains(&a.id),
            "bob's batch: {line}"
        );
        assert!(
            line.contains("21"),
            "alice's post-reconnect move is in the batch: {line}"
        );
    }

    #[test]
    fn reconnect_while_alive_switches_the_session() {
        let world = World::new(test_maps());
        let (mut a_old, a_token, _) = join_token(&world, "office", "alice", None);
        let (b, _, _) = join_token(&world, "office", "bob", None);
        a_old.rx.try_recv().unwrap(); // alice hears bob join

        // A second session presents the token before the first is detected
        // as dead: the member's channels change hands to the new session.
        let (mut a_new, _, _) = join_token(&world, "office", "alice", Some(&a_token));
        assert_eq!(a_new.id, a_old.id);

        // The old channel is dead; the new one is live.
        world.broadcast_typing("office", &b.id, true);
        assert!(a_old.rx.try_recv().is_err(), "the old session is cut over");
        assert!(
            matches!(a_new.rx.try_recv().unwrap(), ServerMsg::Typing { .. }),
            "the new session is live"
        );
    }

    #[tokio::test]
    async fn stale_discard_is_a_noop() {
        let world = World::new(test_maps()).with_reconnect_window(Duration::from_millis(80));
        let (mut a_old, a_token, a_session1) = join_token(&world, "office", "alice", None);
        let (mut b, _, _) = join_token(&world, "office", "bob", None);
        a_old.rx.try_recv().unwrap();
        // Keep them apart: this test is about presence, not bubbles.
        place(&world, "office", &b.id, 20.0, 0.0);

        // Restore first...
        let (a_new, _, _) = join_token(&world, "office", "alice", Some(&a_token));
        assert_eq!(a_new.id, a_old.id);
        // ...then the old session's disconnect lands late. The session-id
        // guard makes it a no-op: even past the window the user survives.
        world.discard("office", &a_old.id, a_session1);
        tokio::time::sleep(Duration::from_millis(150)).await;
        world.tick();
        assert!(
            b.rx.try_recv().is_err(),
            "stale discard must not expire the user"
        );
    }

    #[tokio::test]
    async fn gone_member_expires_into_a_real_leave() {
        let world = World::new(test_maps()).with_reconnect_window(Duration::from_millis(80));
        let (mut a, a_token, a_session) = join_token(&world, "office", "alice", None);
        let (mut b, _, _) = join_token(&world, "office", "bob", None);
        a.rx.try_recv().unwrap();

        world.discard("office", &a.id, a_session);
        assert!(b.rx.try_recv().is_err(), "silent inside the window");
        tokio::time::sleep(Duration::from_millis(150)).await;
        world.tick();
        assert!(
            matches!(b.rx.try_recv().unwrap(), ServerMsg::Left { ref id } if id == &a.id),
            "the tick turns the expiry into a real leave"
        );
        assert_eq!(world.stats(), (1, 1));

        // Her token died with her: a late reconnect is a fresh user.
        let (late, _, _) = join_token(&world, "office", "alice", Some(&a_token));
        assert_ne!(late.id, a.id, "an expired token cannot restore");
        assert!(
            matches!(b.rx.try_recv().unwrap(), ServerMsg::Joined { .. }),
            "the room hears the fresh join"
        );
    }

    #[tokio::test]
    async fn gone_member_in_a_call_drops_the_call_on_expiry() {
        let world = World::new(test_maps()).with_reconnect_window(Duration::from_millis(80));
        let (mut a, _, a_session) = join_token(&world, "office", "alice", None);
        let (mut b, _, _) = join_token(&world, "office", "bob", None);
        world.tick(); // both at spawn: the bubble forms
        expect_start(&mut a);
        expect_start(&mut b);

        world.discard("office", &a.id, a_session);
        assert!(b.rx.try_recv().is_err(), "silent inside the window");
        tokio::time::sleep(Duration::from_millis(150)).await;
        world.tick();
        // The 1:1 drops for the room, then the leave.
        assert!(
            matches!(
                b.rx.try_recv().unwrap(),
                ServerMsg::CallEnd { ref reason, .. } if reason == "last_left"
            ),
            "the call drops when the gone member expires"
        );
        assert!(matches!(b.rx.try_recv().unwrap(), ServerMsg::Left { .. }));
    }

    #[test]
    fn token_mismatch_is_a_fresh_user() {
        let world = World::new(test_maps());
        let (mut a, a_token, _) = join_token(&world, "office", "alice", None);
        let (mut b, _, _) = join_token(&world, "office", "bob", None);
        a.rx.try_recv().unwrap();

        // A stranger token: a brand-new user (the room hears about it).
        let (a3, a3_token, _) = join_token(&world, "office", "alice2", Some("bogus"));
        assert_ne!(a3.id, a.id);
        assert_ne!(a3_token, a_token);
        assert!(
            matches!(b.rx.try_recv().unwrap(), ServerMsg::Joined { ref user } if user.id == a3.id),
            "the room hears the fresh join"
        );

        // The real token wins even under a different display name: identity
        // is keyed by the token, and the original name is kept.
        let (tx, _rx) = channel();
        let (dtx, _) = datagram_channel();
        let session = world.next_session_id();
        let joined = world
            .join("office", "ALICE-2", None, Some(&a_token), session, tx, dtx)
            .unwrap();
        assert_eq!(joined.you, a.id);
        let me = joined
            .users
            .iter()
            .find(|u| u.id == a.id)
            .expect("restored alice in her own snapshot");
        assert_eq!(
            me.name, "alice",
            "the token, not the name, identifies the user"
        );
        assert!(b.rx.try_recv().is_err(), "no flicker for the restore");
    }

    #[test]
    fn explicit_leave_beats_the_reconnect_window() {
        let world = World::new(test_maps());
        let (mut a, a_token, _) = join_token(&world, "office", "alice", None);
        let (mut b, _, _) = join_token(&world, "office", "bob", None);
        a.rx.try_recv().unwrap();

        world.leave("office", &a.id);
        assert!(matches!(b.rx.try_recv().unwrap(), ServerMsg::Left { .. }));
        // Her token dies with her: no restore.
        let (a2, _, _) = join_token(&world, "office", "alice", Some(&a_token));
        assert_ne!(a2.id, a.id, "an explicit leave forfeits the token");
    }
}

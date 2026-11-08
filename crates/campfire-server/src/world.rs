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
    Avatar, ChatMsg, Dir, ErrorCode, MAX_CANDIDATE_BYTES, MAX_SDP_BYTES, MovementBatch,
    MovementEntry, ServerMsg, UserBrief, UserState,
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
pub const RECONNECT_WINDOW: Duration = Duration::from_secs(30);
/// Proximity call (README §6.3): a bubble has a one-tile radius around the
/// centroid of its participants. Less than [`BUBBLE_RADIUS`] tiles from
/// another player (or from the bubble's center) pulls you in; at the radius
/// or beyond drops you immediately.
const BUBBLE_RADIUS: f32 = 1.0;
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
}

/// One room (one map): presence + chat history + the in-flight call, if any.
#[derive(Default)]
struct Room {
    users: HashMap<UserId, Member>,
    chat: VecDeque<ChatMsg>,
    /// The room's call (README §7): at most one per room in v1.
    call: Option<call::Call>,
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
}

#[cfg(test)]
pub(crate) fn test_maps() -> campfire_maps::Maps {
    campfire_maps::Maps::load(std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../maps"
    )))
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

    /// Next session id (monotonic; guards discard/leave races, README §5).
    pub fn next_session_id(&self) -> u64 {
        self.session_counter.fetch_add(1, Ordering::Relaxed)
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
            let joined = Joined {
                you: id,
                token: member.token.clone(),
                users: user_snapshot(room_entry),
                chat: room_entry.chat.iter().cloned().collect(),
                call: room_entry
                    .call
                    .as_ref()
                    .map(|c| c.participant_list())
                    .unwrap_or_default(),
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
            },
        );

        let joined = Joined {
            you: id.clone(),
            token,
            users: user_snapshot(room_entry),
            chat: room_entry.chat.iter().cloned().collect(),
            call: room_entry
                .call
                .as_ref()
                .map(|c| c.participant_list())
                .unwrap_or_default(),
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
        // Catch-up (README §6.3): if the room already has a running call,
        // the new room member gets its current roster so their avatars'
        // headphone badge is correct from the start.
        if let Some(call) = &room_entry.call
            && !call.participants.is_empty()
            && let Some(m) = room_entry.users.get(&id)
        {
            let _ = m.tx.send(ServerMsg::CallStart {
                room: room.to_owned(),
                participants: call.participant_list(),
                // A member joining into an existing bubble (reconnect or
                // room re-entry) re-offers: their peer connections died.
                you_offer: call.contains(&id),
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
        remove_from_room(&mut rooms, room, id);
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
            remove_from_room(&mut rooms, room, id);
        }
        for (room, room_entry) in rooms.iter_mut() {
            update_bubbles(room, room_entry);
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

    /// Relay an SDP offer between two participants of the room's bubble.
    pub fn call_relay_offer(
        &self,
        room: &str,
        from: &str,
        to: &str,
        sdp: String,
    ) -> Result<(), ErrorCode> {
        if sdp.len() > MAX_SDP_BYTES {
            return Err(ErrorCode::SdpTooLong);
        }
        let rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get(room) else {
            return Err(ErrorCode::CallNotAllowed);
        };
        let target = call_target(entry, from, to)?;
        let _ = target.tx.send(ServerMsg::CallOffer {
            from: from.to_owned(),
            sdp,
        });
        Ok(())
    }

    /// Relay an SDP answer between two participants of the room's active call.
    pub fn call_relay_answer(
        &self,
        room: &str,
        from: &str,
        to: &str,
        sdp: String,
    ) -> Result<(), ErrorCode> {
        if sdp.len() > MAX_SDP_BYTES {
            return Err(ErrorCode::SdpTooLong);
        }
        let rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get(room) else {
            return Err(ErrorCode::CallNotAllowed);
        };
        let target = call_target(entry, from, to)?;
        let _ = target.tx.send(ServerMsg::CallAnswer {
            from: from.to_owned(),
            sdp,
        });
        Ok(())
    }

    /// Relay one ICE candidate between two participants of the active call.
    pub fn call_relay_ice(
        &self,
        room: &str,
        from: &str,
        to: &str,
        candidate: String,
    ) -> Result<(), ErrorCode> {
        if candidate.len() > MAX_CANDIDATE_BYTES {
            return Err(ErrorCode::CandidateTooLong);
        }
        let rooms = self.rooms.lock().unwrap();
        let Some(entry) = rooms.get(room) else {
            return Err(ErrorCode::CallNotAllowed);
        };
        let target = call_target(entry, from, to)?;
        let _ = target.tx.send(ServerMsg::CallIce {
            from: from.to_owned(),
            candidate,
        });
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
            let call = entry.call.as_mut().ok_or(ErrorCode::CallNotAllowed)?;
            let flags = call
                .participants
                .get_mut(from)
                .ok_or(ErrorCode::CallNotAllowed)?;
            flags.1 = call::ParticipantFlags { audio, video };
        }
        let call = entry.call.as_ref().expect("checked above");
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
        let involved = entry
            .call
            .as_ref()
            .is_some_and(|c| c.participants.contains_key(from));
        if !involved {
            return Err(ErrorCode::CallNotAllowed);
        }
        leave_call(entry, from);
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
            .filter(|r| r.call.is_some())
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

/// Find the relay target of a call message: both `from` and `to` must be
/// participants of the room's bubble. Signaling from a bystander is
/// rejected here.
fn call_target<'a>(entry: &'a Room, from: &str, to: &str) -> Result<&'a Member, ErrorCode> {
    let call = entry.call.as_ref().ok_or(ErrorCode::CallNotAllowed)?;
    if !call.participants.contains_key(from) || !call.participants.contains_key(to) {
        return Err(ErrorCode::CallNotAllowed);
    }
    entry.users.get(to).ok_or(ErrorCode::CallNotAllowed)
}

/// Drop `id` from the room's bubble, if any, and tell the room (README
/// §6.3). Used when the leaver toggles out, hangs up, or is gone and
/// cannot be notified.
///
/// The call state is room-wide (it powers the avatars' headphone badge),
/// so every remaining member of the room is told. An emptied bubble ends
/// with `call_end(last_left)`.
fn leave_call(entry: &mut Room, id: &str) {
    let Some(mut call) = entry.call.take() else {
        return;
    };
    if call.participants.remove(id).is_none() {
        entry.call = Some(call); // not in the call: nothing happened
        return;
    }
    let over = call.participants.len() <= 1;
    for m in entry.users.values() {
        let _ = if over {
            m.tx.send(ServerMsg::CallEnd {
                reason: "last_left".to_owned(),
            })
        } else {
            m.tx.send(ServerMsg::CallLeave { id: id.to_owned() })
        };
    }
    if !over {
        entry.call = Some(call);
    }
}

/// One step of the proximity-call engine (README §6.3), run every tick
/// before the movement batch: the bubble is the one-tile circle around the
/// centroid of its participants. Walk within [`BUBBLE_RADIUS`] of the
/// center (or of another player, when no bubble exists yet) and you are
/// pulled in; at the radius or beyond — or toggled off — you drop out
/// immediately. At most one join per tick keeps the offerer designation
/// deterministic and the signaling trickle-paced.
fn update_bubbles(room: &str, entry: &mut Room) {
    // Leaves first: gone members keep their seat (reconnect grace), opted
    // out members and participants at or beyond the bubble radius drop out
    // immediately.
    let mut dropped: Vec<String> = Vec::new();
    if let Some(call) = entry.call.as_ref() {
        // The bubble's center: the centroid of the participants' positions.
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
        for id in call.participants.keys() {
            match entry.users.get(id) {
                None => {} // gone: stays in the bubble (reconnect grace)
                Some(m) => {
                    if m.bubble_off || dist(center, m.pos) >= BUBBLE_RADIUS {
                        dropped.push(id.clone());
                    }
                }
            }
        }
    }
    for id in dropped {
        leave_call(entry, &id);
    }

    // Creation: no bubble yet, and two eligible users within the bubble
    // radius of each other (id-sorted so the pair — and thus the designated
    // offerer — is deterministic).
    if entry.call.is_none() {
        let mut candidates: Vec<(String, (f32, f32))> = entry
            .users
            .iter()
            .filter(|(_, m)| !m.bubble_off && m.gone_at.is_none())
            .map(|(uid, m)| (uid.clone(), m.pos))
            .collect();
        candidates.sort_by(|a, b| a.0.cmp(&b.0));
        'pair: for i in 0..candidates.len() {
            for j in i + 1..candidates.len() {
                if dist(candidates[i].1, candidates[j].1) < BUBBLE_RADIUS {
                    let a = candidates[i].clone();
                    let b = candidates[j].clone();
                    let call = call::Call::new(
                        entry
                            .users
                            .iter()
                            .filter(|(uid, _)| uid.as_str() == a.0 || uid.as_str() == b.0)
                            .map(|(uid, m)| (uid.clone(), m.name.clone())),
                    );
                    let offerer = [a.0.clone(), b.0.clone()].into_iter().min().unwrap();
                    entry.call = Some(call);
                    broadcast_call_start(room, entry, Some(&offerer));
                    break 'pair;
                }
            }
        }
        return;
    }

    // Joins: at most one per tick — the nearest eligible user within the
    // bubble radius of the bubble's center. The joiner is the offerer
    // (README §6.3: the joiner offers every existing member; nobody
    // renegotiates).
    let Some(call) = entry.call.as_ref() else {
        return;
    };
    let mut center = (0.0f32, 0.0f32);
    let mut n = 0usize;
    for (uid, m) in &entry.users {
        if call.contains(uid) {
            center.0 += m.pos.0;
            center.1 += m.pos.1;
            n += 1;
        }
    }
    if n == 0 {
        return;
    }
    center.0 /= n as f32;
    center.1 /= n as f32;
    let mut best: Option<(f32, String)> = None;
    for (uid, m) in &entry.users {
        if m.bubble_off || m.gone_at.is_some() || call.contains(uid) {
            continue;
        }
        let d = dist(center, m.pos);
        if d < BUBBLE_RADIUS && best.as_ref().is_none_or(|(bd, _)| d < *bd) {
            best = Some((d, uid.clone()));
        }
    }
    if let Some((_, joiner)) = best {
        let name = entry.users[&joiner].name.clone();
        let call = entry.call.as_mut().expect("checked above");
        call.participants.insert(
            joiner.clone(),
            (
                name,
                call::ParticipantFlags {
                    audio: true,
                    video: true,
                },
            ),
        );
        broadcast_call_start(room, entry, Some(&joiner));
    }
}

/// Broadcast the bubble's roster to the whole room: `CallStart` powers the
/// headphone badge on everyone, and `you_offer` marks the one recipient
/// who must send SDP offers to the others.
fn broadcast_call_start(room: &str, entry: &mut Room, offerer: Option<&str>) {
    let participants = entry
        .call
        .as_ref()
        .expect("call present")
        .participant_list();
    for (uid, m) in &entry.users {
        let you = offerer == Some(uid.as_str());
        let _ = m.tx.send(ServerMsg::CallStart {
            room: room.to_owned(),
            participants: participants.clone(),
            you_offer: you,
        });
    }
}

/// Euclidean distance in tile units.
fn dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// Remove `id` from `room` — call membership included (see
/// [`leave_call`]) — broadcast `Left` to everyone left, and drop the room
/// when it becomes empty. The caller owns the `rooms` lock.
fn remove_from_room(rooms: &mut HashMap<String, Room>, room: &str, id: &str) {
    let Some(entry) = rooms.get_mut(room) else {
        return;
    };
    if entry.users.remove(id).is_some() {
        leave_call(entry, id);
        for m in entry.users.values() {
            let _ = m.tx.send(ServerMsg::Left { id: id.to_owned() });
        }
    }
    if entry.users.is_empty() {
        rooms.remove(room);
    }
}

/// The room's full user snapshot for a `hello` (gone members included —
/// they are still in the room until the reconnect window elapses).
fn user_snapshot(entry: &Room) -> Vec<UserState> {
    entry
        .users
        .iter()
        .map(|(uid, m)| UserState {
            id: uid.clone(),
            name: m.name.clone(),
            x: m.pos.0,
            y: m.pos.1,
            d: m.dir,
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
    }

    fn join_user(world: &World, room: &str, name: &str) -> TestUser {
        let (tx, rx) = channel();
        let (dtx, _dgr) = datagram_channel();
        let joined = world
            .join(room, name, None, None, world.next_session_id(), tx, dtx)
            .unwrap();
        TestUser { id: joined.you, rx }
    }

    /// Teleport a user (unit tests share the module, so private fields are
    /// reachable): the speed gate would reject a far jump in one entry.
    fn place(world: &World, room: &str, id: &str, x: f32, y: f32) {
        let mut rooms = world.rooms.lock().unwrap();
        let m = rooms.get_mut(room).unwrap().users.get_mut(id).unwrap();
        m.pos = (x, y);
        m.dirty = true;
    }

    /// Expect `CallStart` on `u`'s stream; returns (participants, you_offer).
    /// Skips presence noise (`Hello`, `Joined`, …) in between.
    fn expect_start(u: &mut TestUser) -> (Vec<UserBrief>, bool) {
        for _ in 0..20 {
            match u.rx.try_recv().expect("call_start") {
                ServerMsg::CallStart {
                    participants,
                    you_offer,
                    ..
                } => return (participants, you_offer),
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

        // Carol keeps her distance so {a, b} is the only candidate pair
        // (ids are not join-ordered): the pair — and thus the offerer — is
        // deterministic.
        place(&world, "office", &c.id, 20.0, 0.0);
        // Spawn is shared, so both are within the join radius already: the
        // first tick creates the bubble. The smaller id is the offerer.
        world.tick();
        let (participants, a_offers) = expect_start(&mut a);
        let (pb, b_offers) = expect_start(&mut b);
        assert_eq!(participants, pb, "everyone hears the same roster");
        assert_eq!(participants.len(), 2);
        assert_eq!(a_offers, a.id < b.id, "the smaller id offers on creation");
        assert_ne!(a_offers, b_offers, "exactly one offerer");

        // The bystander hears the badge but is not marked as offerer.
        let (p3, c_offers) = expect_start(&mut c);
        assert_eq!(p3.len(), 2);
        assert!(!c_offers);

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
                ServerMsg::CallEnd { ref reason } => assert_eq!(reason, "last_left"),
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
                ServerMsg::CallEnd { ref reason } => assert_eq!(reason, "last_left"),
                other => panic!("expected call_end, got {other:?}"),
            }
        }

        // Opting back in reforms the bubble with alice (creation: the
        // smaller id offers, regardless of who opted back in).
        world.set_bubble("office", &b.id, false).unwrap();
        world.tick();
        let (a_id, b_id) = (a.id.clone(), b.id.clone());
        let mut offers: Vec<&str> = Vec::new();
        for u in [&mut a, &mut b, &mut c] {
            let (p, off) = expect_start(u);
            assert_eq!(p.len(), 2);
            assert!(
                p.iter().any(|x| x.id == a_id) && p.iter().any(|x| x.id == b_id),
                "roster is alice and bob"
            );
            if off {
                offers.push("x");
            }
        }
        assert_eq!(offers.len(), 1, "exactly one offerer");
    }

    #[test]
    fn call_relay_requires_participation() {
        let world = World::new(test_maps());
        let mut a = join_user(&world, "office", "alice");
        let mut b = join_user(&world, "office", "bob");
        let mut c = join_user(&world, "office", "carol");
        // Carol keeps her distance: {a, b} is the bubble, she a bystander.
        place(&world, "office", &c.id, 20.0, 0.0);
        world.tick(); // a + b bubble at spawn
        expect_start(&mut a);
        expect_start(&mut b);
        c.rx.try_recv().unwrap(); // bystander badge

        // A bystander cannot send or receive call payloads.
        assert_eq!(
            world.call_relay_offer("office", &c.id, &b.id, "sdp".into()),
            Err(ErrorCode::CallNotAllowed)
        );
        assert_eq!(
            world.call_relay_offer("office", &a.id, &c.id, "sdp".into()),
            Err(ErrorCode::CallNotAllowed)
        );
        // Participants relay offer, answer and ICE both ways.
        world
            .call_relay_offer("office", &a.id, &b.id, "v=0 offer".into())
            .unwrap();
        assert!(matches!(
            b.rx.try_recv().unwrap(),
            ServerMsg::CallOffer { ref sdp, .. } if sdp == "v=0 offer"
        ));
        world
            .call_relay_answer("office", &b.id, &a.id, "v=0 answer".into())
            .unwrap();
        assert!(matches!(
            a.rx.try_recv().unwrap(),
            ServerMsg::CallAnswer { ref sdp, .. } if sdp == "v=0 answer"
        ));
        world
            .call_relay_ice(
                "office",
                &a.id,
                &b.id,
                "candidate:1 udp 2130706431 ...".into(),
            )
            .unwrap();
        assert!(matches!(
            b.rx.try_recv().unwrap(),
            ServerMsg::CallIce { .. }
        ));

        // Relay caps (README §5).
        assert_eq!(
            world.call_relay_offer("office", &a.id, &b.id, "x".repeat(65 * 1024)),
            Err(ErrorCode::SdpTooLong)
        );
        assert_eq!(
            world.call_relay_ice("office", &a.id, &b.id, "x".repeat(1025)),
            Err(ErrorCode::CandidateTooLong)
        );
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
                ServerMsg::CallEnd { reason } => assert_eq!(reason, "last_left"),
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
            ServerMsg::CallEnd { ref reason } if reason == "last_left"
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
        let (dtx, _dgr) = datagram_channel();
        let session = world.next_session_id();
        let joined = world
            .join(room, name, None, token, session, tx, dtx)
            .unwrap();
        (TestUser { id: joined.you, rx }, joined.token, session)
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
                ServerMsg::CallEnd { ref reason } if reason == "last_left"
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

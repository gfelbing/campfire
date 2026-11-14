# Realtime protocol

One WebTransport session per browser at `/wt`. Reliable **streams** carry
JSON lines (join/leave, chat, typing, call state, keepalive, errors);
**datagrams** carry movement only. The message enums live in
`crates/campfire-protocol` (no IO, unit-tested codec).

## Stream messages (JSON lines)

```jsonc
// client → server (stream)
{"t":"join", "room":"office", "name":"georg", "avatar":{"color":"#e05f38"}}
             // "token":"…" restores the previous identity on reconnect
{"t":"leave"} {"t":"chat","text":"hi"} {"t":"typing","on":true}
{"t":"bubble","off":true}                    // opt out of calls
{"t":"call_mute"/"call_screen"/"call_leave", …}   // call presence
{"t":"ping"}                                 // keepalive: resets the idle timeout

// server → client (stream)
{"t":"hello", "you":"u_…", "room":"office", "token":"…", "users":[…], "chat":[…], "call":[…]}
{"t":"joined"/"left"} {"t":"chat", …} {"t":"typing", …} {"t":"error","code":"…"}
{"t":"call_start", "participants":[…], "zone":"MeetingRoom", "ticket":"…"}
{"t":"call_leave","id":"u_…", "zone":"…"} {"t":"call_end","reason":"last_left","zone":"…"}
{"t":"call_mute"/"call_screen", …}          // participant presence

// datagrams (both directions)
{"m":[{"id":"u_…","x":41.5,"y":12.75,"d":"e","mv":1,"s":4821,"sz":true}, …]}
                                     // "sz": inside a silentZone (only when true)
```

- `t` is the message type; unknown fields are ignored so the protocol can grow
  without a hard version break.
- Call *state* (`call_start`/`call_leave`/`call_end`) is **room-wide** — it
  powers the headphone badge and the zone-rectangle highlight on every client.
  `zone` marks a zone call (a room can carry several concurrent calls — one
  per occupied jitsi zone plus the proximity bubble).
- `ticket` rides `call_start` per participant ([`moq-sfu.md`](moq-sfu.md)) and
  admits the media session at `/moq`.
- `error` is the rejection catalogue: bad room, full room, not authenticated,
  not a participant, or a call already in progress.

## Movement

Datagrams only. Each entry carries a sequence number `s`; the server drops
stale ones. **Server-side validation**: tile space, max 8 tiles/s, walkable
tiles only, ≤ 30 moves/s per user. Each 50 ms tick the server broadcasts one
batched datagram (≤ 1200 B) per room.

## Calls

A room carries **at most one proximity bubble plus one call per occupied
jitsi zone**; a user is in at most one call at a time. All computed by the
server in the 50 ms tick.

- **Zone calls** (`jitsiRoom` zones, [`../ops/maps.md`](../ops/maps.md)):
  every occupied zone runs its own call bounded by the zone rectangle — a lone
  occupant starts it, anyone who walks in joins. The client highlights each
  live zone's rectangle (visible to bystanders too).
- **Proximity bubbles**: the one-tile-radius circle around the centroid of the
  participants (the client draws exactly that circle). **Creation:** two
  opted-in users closer than one tile. **Joining:** automatic — closer than
  one tile to the center pulls you in (at most one join per tick across all
  calls). The mic permission prompt happens on the first auto-join: walking
  close *is* the intent.
- **Leaving:** outside your call's area (the zone rect or the bubble radius —
  or the bubble toggle) drops you **immediately** — no grace delay, no
  hysteresis. The last leave ends that call
  (`call_end {reason:"last_left","zone":…}`).
- **Silent zones**: occupants of a `silentZone` never form or join a proximity
  bubble, and walking into the zone drops them out of one they were in. Zone
  calls are unaffected (the two zone types are meant to be disjoint).
- **Reconnect**: a disconnected member keeps their seat for the 30 s reconnect
  window; their stale position is excluded from the centroid. A member who
  re-enters via their token gets a 2 s re-entry grace before the radius check
  applies again, so call membership survives the reload.
- **Limits**: voice-only degradation at 9+ participants (UI-enforced);
  `call_mute`/`call_screen` are presence only, the media track catalog follows
  the MoQ session ([`moq-sfu.md`](moq-sfu.md)).

## The SSE+POST fallback

Browsers without WebTransport use `/rt/sse` (server → client) and
`/rt/event` (client → server POSTs) on the same port. Same message catalogue,
no datagrams — movement rides the POST path at a lower rate.

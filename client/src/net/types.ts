//! Wire protocol types, mirroring `campfire-protocol` on the server.
//!
//! Reliable stream: newline-delimited JSON. Datagrams: one MovementBatch
//! JSON object per datagram (README §5).

export type Dir = "n" | "s" | "e" | "w";

/** Presence status (the profile menu): `online` = normal calls with mic +
 *  camera; `away` = calls auto-join muted; `dnd` = no call starts. */
export type OwnStatus = "online" | "away" | "dnd";

export interface UserState {
  id: string;
  name: string;
  x: number;
  y: number;
  d: Dir;
  /** `sz`: the user stands inside a silentZone (README roadmap "Map
   *  enhancements"). Only sent when true. */
  sz?: boolean;
  /** The user's chosen avatar color (`#rrggbb`); present when they set one. */
  color?: string;
  /** The user's presence status; absent means `online`. */
  status?: OwnStatus;
}

export interface UserBrief {
  id: string;
  name: string;
  /** The user's chosen avatar color (`#rrggbb`); present when they set one. */
  color?: string;
  /** The user's presence status; absent means `online`. */
  status?: OwnStatus;
}

export interface ChatMsg {
  from: string;
  name: string;
  text: string;
  ts: number;
}

export type ErrorCode =
  | "bad_message"
  | "rate_limited"
  | "room_full"
  | "name_too_long"
  | "chat_too_long"
  | "unknown_room"
  | "call_not_allowed";

// --- server → client -------------------------------------------------------

export type ServerMsg =
  | {
      t: "hello";
      you: string;
      room: string;
      /** Reconnect token (README §5): resend it in `join` to restore this
       *  identity after a dropped connection. */
      token: string;
      users: UserState[];
      chat: ChatMsg[];
      /** The room's current call participants (empty when no call) — the
       *  authoritative catch-up so a reconnected client knows whether the
       *  call survived the drop. */
      call: UserBrief[];
      /** The user's media ticket when they are in an active call
       *  (reconnect catch-up, docs/moq-sfu.md §7). Present only then. */
      ticket?: string;
    }
  | { t: "joined"; user: UserBrief }
  | { t: "left"; id: string }
  | { t: "chat"; from: string; name: string; text: string; ts: number }
  | { t: "typing"; id: string; on: boolean }
  /** `id`'s presence status changed (profile menu); not sent to the sender. */
  | { t: "status"; id: string; status: OwnStatus }
  | {
      t: "call_start";
      room: string;
      participants: UserBrief[];
      /** Zone call: the `jitsiRoom` name of the bounding zone (README roadmap
       *  "Map enhancements"); only present for zone calls. */
      zone?: string;
      /** The recipient's media ticket when they are a participant of this
       *  call (docs/moq-sfu.md §7); bystanders get the roster but no ticket. */
      ticket?: string;
    }
  | { t: "call_leave"; id: string; zone?: string }
  | { t: "call_end"; reason: string; zone?: string }
  | { t: "call_mute"; id: string; audio: boolean; video: boolean }
  | { t: "call_screen"; id: string; on: boolean }
  | {
      /** Stepped onto an `exitUrl` zone: the server resolved the URL to a
       *  map id (README roadmap "Map enhancements"); navigate there with
       *  the same name + color. */
      t: "navigate";
      map: string;
    }
  | { t: "error"; code: ErrorCode };

// --- client → server -------------------------------------------------------

export type ClientMsg =
  | {
      t: "join";
      room: string;
      name: string;
      avatar?: { color: string };
      /** Reconnect token (README §5): restore the previous identity. */
      token?: string;
      /** The joiner's presence status; absent means `online`. */
      status?: OwnStatus;
    }
  | { t: "chat"; text: string }
  | { t: "typing"; on: boolean }
  /** Presence status changed (the profile menu): `dnd` opts out of
   *  proximity calls, `away` auto-joins them muted. */
  | { t: "status"; status: OwnStatus }
  /** Leave the room immediately (README §5): used for room switching, the
   *  server tears the session down right away. */
  | { t: "leave" }
  /** Opt out of proximity bubbles (README §6.3): leaves the current bubble
   *  at once and prevents joining; `off: false` opts back in. */
  | { t: "bubble"; off: boolean }
  | { t: "call_mute"; audio: boolean; video: boolean }
  /** Presence: we started/stopped screen sharing (camera track replaced). */
  | { t: "call_screen"; on: boolean }
  | { t: "call_leave" }
  /** Keepalive (README §5): the server ignores it; the stream activity
   *  alone resets the server's idle timeout, so a stationary user keeps
   *  their session (and identity + position) alive. */
  | { t: "ping" };

// --- datagrams -------------------------------------------------------------

export interface MovementEntry {
  id: string;
  x: number;
  y: number;
  d: Dir;
  /** 0 = idle, 1 = moving. */
  mv: number;
  /** Monotonic sequence number; the client keeps the newest. */
  s: number;
  /** `sz` (README roadmap "Map enhancements"): the sender stands inside a
   *  `silentZone` — remote audio from them is muted. Only sent when true. */
  sz?: boolean;
}

export interface MovementBatch {
  m: MovementEntry[];
}

export function encodeLine(msg: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg) + "\n");
}

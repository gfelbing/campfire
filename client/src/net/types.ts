//! Wire protocol types, mirroring `campfire-protocol` on the server.
//!
//! Reliable stream: newline-delimited JSON. Datagrams: one MovementBatch
//! JSON object per datagram (README §5).

export type Dir = "n" | "s" | "e" | "w";

/// `call_offer.to` value that means "create/join the room huddle"
/// (README §5; mirrors `ROOM_TARGET` on the server).
export const ROOM_TARGET = "room";

export interface UserState {
  id: string;
  name: string;
  x: number;
  y: number;
  d: Dir;
}

export interface UserBrief {
  id: string;
  name: string;
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
  | "room_too_long"
  | "unknown_room"
  | "call_not_allowed"
  | "sdp_too_long"
  | "candidate_too_long";

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
    }
  | { t: "joined"; user: UserBrief }
  | { t: "left"; id: string }
  | { t: "chat"; from: string; name: string; text: string; ts: number }
  | { t: "typing"; id: string; on: boolean }
  | { t: "call_ring"; from: string; name: string }
  | { t: "call_start"; room: string; participants: UserBrief[] }
  | { t: "call_join"; user: UserBrief }
  | { t: "call_leave"; id: string }
  | { t: "call_end"; reason: string }
  | { t: "call_offer"; from: string; sdp: string }
  | { t: "call_answer"; from: string; sdp: string }
  | { t: "call_ice"; from: string; candidate: string }
  | { t: "call_mute"; id: string; audio: boolean; video: boolean }
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
    }
  | { t: "chat"; text: string }
  | { t: "typing"; on: boolean }
  /** Leave the room immediately (README §5): used for room switching, the
   *  server tears the session down right away. */
  | { t: "leave" }
  | { t: "call_ring"; to: string }
  | { t: "call_ring_stop"; to: string }
  | { t: "call_accept"; to: string }
  | { t: "call_decline"; to: string }
  | { t: "call_offer"; to: string; sdp: string }
  | { t: "call_answer"; to: string; sdp: string }
  | { t: "call_ice"; to: string; candidate: string }
  | { t: "call_mute"; audio: boolean; video: boolean }
  | { t: "call_leave" };

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
}

export interface MovementBatch {
  m: MovementEntry[];
}

export function encodeLine(msg: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg) + "\n");
}

//! Wire protocol types, mirroring `campfire-protocol` on the server.
//!
//! Reliable stream: newline-delimited JSON. Datagrams: one MovementBatch
//! JSON object per datagram (README §5).

export type Dir = "n" | "s" | "e" | "w";

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
  | "unknown_room";

// --- server → client -------------------------------------------------------

export type ServerMsg =
  | { t: "hello"; you: string; room: string; users: UserState[]; chat: ChatMsg[] }
  | { t: "joined"; user: UserBrief }
  | { t: "left"; id: string }
  | { t: "chat"; from: string; name: string; text: string; ts: number }
  | { t: "typing"; id: string; on: boolean }
  | { t: "error"; code: ErrorCode };

// --- client → server -------------------------------------------------------

export type ClientMsg =
  | { t: "join"; room: string; name: string; avatar?: { color: string } }
  | { t: "chat"; text: string }
  | { t: "typing"; on: boolean };

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

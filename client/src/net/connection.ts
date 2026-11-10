import type {
  ChatMsg,
  ClientMsg,
  Dir,
  MovementBatch,
  ServerMsg,
  UserBrief,
  UserState,
} from "./types";
import { encodeLine } from "./types";

/**
 * One realtime connection to the server, with automatic reconnection.
 *
 * Uses WebTransport when the browser has it (streams + datagrams); otherwise
 * the SSE+POST fallback (`/rt/sse` + `/rt/event`) — same protocol, no
 * datagram movement (README §8).
 */
export interface ConnHandlers {
  onHello: (h: {
    you: string;
    room: string;
    token: string;
    users: UserState[];
    chat: ChatMsg[];
    call: UserBrief[];
    /** Media ticket for an active call (reconnect catch-up, docs/moq-sfu.md
     *  §7). Present only when the user is in a call. */
    ticket?: string;
  }) => void;
  onJoined: (u: UserBrief) => void;
  onLeft: (id: string) => void;
  onChat: (c: ChatMsg) => void;
  onTyping: (id: string, on: boolean) => void;
  onMovement: (batch: MovementBatch) => void;
  /** A bubble started or grew; `participants` is the full list. `ticket`
   *  is our media ticket when we are a participant (docs/moq-sfu.md §7). */
  onCallStart: (
    participants: UserBrief[],
    zone?: string,
    ticket?: string,
  ) => void;
  /** A participant left the ongoing bubble (huddles, Phase 6). */
  onCallLeave: (id: string, zone?: string) => void;
  /** The bubble is over (`last_left`). */
  onCallEnd: (reason: string, zone?: string) => void;
  onCallMute: (id: string, audio: boolean, video: boolean) => void;
  onCallScreen: (id: string, on: boolean) => void;
  onError: (code: string) => void;
  onStatus: (s: ConnStatus) => void;
}

export type ConnStatus = "connected" | "reconnecting" | "disconnected";

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export class Connection {
  private transport: WTConn | SSEConn | null = null;
  private attempt = 0;
  /** Generation of the current transport (see `connectOnce`). */
  private connGen = 0;
  /** Generation counter: cancels a pending reconnect timer when the
   *  connection is closed or the page enters the back/forward cache. */
  private reconnectGen = 0;
  /** Whether the bfcache `pagehide`/`pageshow` hooks are installed. */
  private bfcacheHooked = false;
  private closing = false;
  private moveSeq = 0;
  /** Our own user id from the last hello ("" until joined). */
  private selfId = "";
  /** Our reconnect token from the last hello ("" until joined). Sent back in
   *  every join so a dropped connection restores this identity (README §5).
   *  Persisted per room in `sessionStorage`: a page reload re-joins with the
   *  same token, so the server replaces the old avatar instead of leaving a
   *  ghost behind for the reconnect window. Session-scoped storage means a
   *  fresh browser session correctly starts as a new user. */
  private token = "";

  constructor(
    private room: string,
    private name: string,
    private avatarColor: string,
    private handlers: ConnHandlers,
  ) {
    try {
      this.token = sessionStorage.getItem(this.tokenKey()) ?? "";
    } catch {
      // storage unavailable (private mode): reconnect only in-memory
    }
  }

  /** sessionStorage key for this room's reconnect token. */
  private tokenKey(): string {
    return `campfire.token.${this.room}`;
  }

  /** Connect, join, and keep reconnecting until close() is called. */
  start(): void {
    this.closing = false;
    if (!this.bfcacheHooked) {
      this.bfcacheHooked = true;
      // Back/forward cache: when the page is hidden into the bfcache
      // (address-bar navigation + Back), the browser kills the
      // WebTransport and the page later restores frozen. Close cleanly on
      // hide, and reconnect on the restore — the sessionStorage token
      // re-joins with the same identity, so movement keeps flowing.
      window.addEventListener("pagehide", () => {
        this.reconnectGen += 1; // cancel any pending reconnect timer
        this.closing = true;
        this.transport?.close();
        this.transport = null;
      });
      window.addEventListener("pageshow", (e) => {
        if ((e as PageTransitionEvent).persisted) {
          this.reconnectGen += 1;
          this.attempt = 0;
          this.resetMoveSeq();
          this.handlers.onStatus("reconnecting");
          void this.start();
        }
      });
    }
    this.connectOnce();
  }

  close(): void {
    this.reconnectGen += 1;
    this.closing = true;
    this.transport?.close();
    this.transport = null;
  }

  sendChat(text: string): void {
    this.transport?.sendMsg({ t: "chat", text });
  }

  sendTyping(on: boolean): void {
    this.transport?.sendMsg({ t: "typing", on });
  }

  /** Send one movement datagram (no-op on the SSE fallback). */
  sendMove(x: number, y: number, d: Dir, moving: boolean): void {
    const t = this.transport;
    if (!t || !this.selfId) return;
    t.sendMove(this.selfId, x, y, d, moving, ++this.moveSeq);
  }

  // --- call state + presence (README §5/§6.3): plain stream messages; media
  // --- never transits the server (docs/moq-sfu.md).

  /** Opt out of proximity bubbles (README §6.3) — or back in with false. */
  sendBubble(off: boolean): void {
    this.transport?.sendMsg({ t: "bubble", off });
  }

  sendCallMute(audio: boolean, video: boolean): void {
    this.transport?.sendMsg({ t: "call_mute", audio, video });
  }

  sendCallScreen(on: boolean): void {
    this.transport?.sendMsg({ t: "call_screen", on });
  }

  sendCallLeave(): void {
    this.transport?.sendMsg({ t: "call_leave" });
  }

  /** Leave the room immediately (README §5): the server tears the session
   *  down with no reconnect grace — used right before a room switch. */
  sendLeave(): void {
    this.transport?.sendMsg({ t: "leave" });
  }

  private resetMoveSeq(): void {
    // New session: the server tracks per-member sequence numbers, so a
    // reconnected user starts at 0 again (server seq for this member resets
    // with the new membership).
    this.moveSeq = 0;
  }

  private connectOnce(): void {
    if (this.closing) return;
    // Each transport instance gets a generation: events from a stale
    // transport (killed by close() or the back/forward cache while a newer
    // connection is already up) must not trigger another reconnect.
    const gen = ++this.connGen;
    const useWT = typeof WebTransport !== "undefined";
    this.transport = useWT ? new WTConn(this, gen) : new SSEConn(this, gen);
    this.transport.connect().catch((err) => {
      console.warn("connection failed:", err);
      this.onTransportDown(gen);
    });
  }

  /** Called by the transport when the connection died. Stale transports
   *  (older generation) are ignored. */
  onTransportDown(gen: number): void {
    if (this.closing || gen !== this.connGen) return;
    this.transport = null;
    const pending = this.reconnectGen;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.handlers.onStatus("reconnecting");
    console.log(`reconnecting in ${delay} ms (attempt ${this.attempt})`);
    window.setTimeout(() => {
      if (pending !== this.reconnectGen) return; // closed or bfcache-hid since
      this.resetMoveSeq();
      this.connectOnce();
    }, delay);
  }

  onTransportUp(): void {
    this.attempt = 0;
    this.handlers.onStatus("connected");
  }

  /** Dispatch one server message (from either transport). */
  dispatch(msg: ServerMsg): void {
    switch (msg.t) {
      case "hello":
        this.selfId = msg.you;
        this.token = msg.token;
        try {
          sessionStorage.setItem(this.tokenKey(), this.token);
        } catch {
          // ignore storage failures
        }
        this.handlers.onHello(msg);
        break;
      case "joined":
        this.handlers.onJoined(msg.user);
        break;
      case "left":
        this.handlers.onLeft(msg.id);
        break;
      case "chat":
        this.handlers.onChat(msg);
        break;
      case "typing":
        this.handlers.onTyping(msg.id, msg.on);
        break;
      case "call_start":
        this.handlers.onCallStart(msg.participants, msg.zone, msg.ticket);
        break;
      case "call_leave":
        this.handlers.onCallLeave(msg.id, msg.zone);
        break;
      case "call_end":
        this.handlers.onCallEnd(msg.reason, msg.zone);
        break;
      case "call_mute":
        this.handlers.onCallMute(msg.id, msg.audio, msg.video);
        break;
      case "call_screen":
        this.handlers.onCallScreen(msg.id, msg.on);
        break;
      case "error":
        console.warn("server error:", msg.code);
        this.handlers.onError(msg.code);
        break;
    }
  }

  /** Inner join payload (`room`, `name`, `avatar`, `token`) — what the SSE
   *  fallback POSTs, and what `joinMsg` wraps into a tagged stream message.
   *  The token (when we have one) makes a reconnect restore our identity
   *  instead of creating a fresh user (README §5). */
  joinPayload(): { room: string; name: string; avatar?: { color: string }; token?: string } {
    return {
      room: this.room,
      name: this.name,
      avatar: { color: this.avatarColor },
      ...(this.token ? { token: this.token } : {}),
    };
  }

  /** One movement batch from the datagram channel (WT transport). */
  onMovement(batch: MovementBatch): void {
    this.handlers.onMovement(batch);
  }

  /** The transport writes join + subsequent messages through this. */
  joinMsg(): ClientMsg {
    return { t: "join", ...this.joinPayload() };
  }
}

// ---------------------------------------------------------------------------
// Shared plumbing: line-based JSON over a ReadableStream of bytes.
// ---------------------------------------------------------------------------

/** Feed raw bytes, invoking `onLine` for every complete `\n`-terminated line. */
export function lineReader(onLine: (line: string) => void) {
  let buf = "";
  return (chunk: Uint8Array) => {
    buf += new TextDecoder().decode(chunk);
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > 0) onLine(line);
    }
  };
}

// ---------------------------------------------------------------------------
// WebTransport transport (streams + datagrams).
// ---------------------------------------------------------------------------

class WTConn {
  private wt: WebTransport | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private dgReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private dgWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  // WebTransport has no readyState (that is WebSocket); track liveness
  // ourselves so datagram sends don't go out on a dead transport.
  private live = false;

  constructor(private conn: Connection, private gen: number) {}

  async connect(): Promise<void> {
    // WebTransport requires an absolute URL — relative paths throw on
    // construction (the WS-style `/wt` shortcut is not valid here).
    const wt = new WebTransport(new URL("/wt", location.origin).toString());
    this.wt = wt;
    this.live = false;
    wt.closed.then(
      () => {
        this.live = false;
        this.conn.onTransportDown(this.gen);
      },
      (err) => {
        this.live = false;
        console.warn("webtransport closed:", err);
        this.conn.onTransportDown(this.gen);
      },
    );
    await wt.ready;
    this.live = true;

    const stream = await wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    this.writer = writer;
    this.reader = reader;

    // Join first thing on the command stream.
    await writer.write(encodeLine(this.conn.joinMsg()));
    this.conn.onTransportUp();

    // Datagram reader (movement batches).
    try {
      this.dgReader = wt.datagrams.readable.getReader();
      void this.readDatagrams();
    } catch {
      // Server did not advertise datagrams: presence/chat still work.
      this.dgReader = null;
    }

    // Datagram writer (movement batches). Chromium ships only the streams
    // API — there is no sendDatagram() method.
    try {
      this.dgWriter = wt.datagrams.writable.getWriter();
    } catch {
      // No datagrams: presence/chat still work.
      this.dgWriter = null;
    }

    void this.readCommandStream();
  }

  private async readCommandStream(): Promise<void> {
    const onLine = lineReader((line) => {
      try {
        this.conn.dispatch(JSON.parse(line) as ServerMsg);
      } catch (err) {
        console.warn("bad server line:", line, err);
      }
    });
    try {
      for (;;) {
        const { done, value } = await this.reader!.read();
        if (done) break;
        onLine(value);
      }
    } catch {
      // Read error (page hidden into the bfcache, network drop): the
      // `closed` promise already reports the death.
    }
    this.conn.onTransportDown(this.gen);
  }

  private async readDatagrams(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.dgReader!.read();
        if (done) break;
        try {
          const batch = JSON.parse(new TextDecoder().decode(value)) as MovementBatch;
          this.conn.onMovement(batch);
        } catch (err) {
          console.warn("bad datagram:", err);
        }
      }
    } catch {
      // Read error: see readCommandStream.
    }
    // Datagram stream ended: the connection is going.
    this.conn.onTransportDown(this.gen);
  }

  sendMsg(msg: ClientMsg): void {
    void this.writer?.write(encodeLine(msg));
  }

  sendMove(id: string, x: number, y: number, d: Dir, moving: boolean, seq: number): void {
    if (!this.dgWriter || !this.live) return;
    const batch: MovementBatch = {
      m: [{ id, x, y, d, mv: moving ? 1 : 0, s: seq }],
    };
    // A transport hiccup must never propagate into the render loop (the
    // tick would die and freeze the game); a lost datagram is harmless.
    try {
      void this.dgWriter.write(encodeLine(batch)).catch(() => {
        this.live = false;
        this.dgWriter = null;
      });
    } catch {
      this.live = false;
      this.dgWriter = null;
    }
  }

  close(): void {
    try {
      this.wt?.close();
    } catch {
      // already closing
    }
  }
}

// ---------------------------------------------------------------------------
// SSE + POST fallback transport (no datagrams).
// ---------------------------------------------------------------------------

class SSEConn {
  private es: EventSource | null = null;
  private token: string | null = null;

  constructor(private conn: Connection, private gen: number) {}

  async connect(): Promise<void> {
    const res = await fetch("/rt/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "join",
        payload: this.conn.joinPayload(),
      }),
    });
    if (!res.ok) throw new Error(`join failed: ${res.status}`);
    const { token } = (await res.json()) as { token: string };
    this.token = token;
    this.conn.onTransportUp();

    const es = new EventSource(`/rt/sse?token=${encodeURIComponent(token)}`);
    this.es = es;
    es.onmessage = (e) => {
      try {
        this.conn.dispatch(JSON.parse(e.data) as ServerMsg);
      } catch (err) {
        console.warn("bad sse event:", e.data, err);
      }
    };
    es.onerror = () => {
      // EventSource auto-retries the HTTP request; the server drops the
      // session when the stream ends, so treat any error as "down" and let
      // the Connection reconnect with a fresh join.
      es.close();
      this.conn.onTransportDown(this.gen);
    };
  }

  sendMsg(msg: ClientMsg): void {
    if (!this.token) return;
    void fetch("/rt/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "msg", payload: { token: this.token, msg } }),
    }).catch((err) => console.warn("event post failed:", err));
  }

  sendMove(): void {
    // The fallback has no datagram path; movement is not relayed.
  }

  close(): void {
    this.es?.close();
  }
}

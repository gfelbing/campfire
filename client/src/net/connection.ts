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
  onHello: (h: { you: string; room: string; users: UserState[]; chat: ChatMsg[] }) => void;
  onJoined: (u: UserBrief) => void;
  onLeft: (id: string) => void;
  onChat: (c: ChatMsg) => void;
  onTyping: (id: string, on: boolean) => void;
  onMovement: (batch: MovementBatch) => void;
  onError: (code: string) => void;
  onStatus: (s: ConnStatus) => void;
}

export type ConnStatus = "connected" | "reconnecting" | "disconnected";

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export class Connection {
  private transport: WTConn | SSEConn | null = null;
  private attempt = 0;
  private closing = false;
  private moveSeq = 0;
  /** Our own user id from the last hello ("" until joined). */
  private selfId = "";

  constructor(
    private room: string,
    private name: string,
    private avatarColor: string,
    private handlers: ConnHandlers,
  ) {}

  /** Connect, join, and keep reconnecting until close() is called. */
  start(): void {
    this.closing = false;
    this.connectOnce();
  }

  close(): void {
    this.closing = true;
    this.transport?.close();
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

  private resetMoveSeq(): void {
    // New session: the server tracks per-member sequence numbers, so a
    // reconnected user starts at 0 again (server seq for this member resets
    // with the new membership).
    this.moveSeq = 0;
  }

  private connectOnce(): void {
    if (this.closing) return;
    const useWT = typeof WebTransport !== "undefined";
    this.transport = useWT ? new WTConn(this) : new SSEConn(this);
    this.transport.connect().catch((err) => {
      console.warn("connection failed:", err);
      this.onTransportDown();
    });
  }

  /** Called by the transport when the connection died. */
  onTransportDown(): void {
    if (this.closing) return;
    this.transport = null;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.handlers.onStatus("reconnecting");
    console.log(`reconnecting in ${delay} ms (attempt ${this.attempt})`);
    window.setTimeout(() => {
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
      case "error":
        console.warn("server error:", msg.code);
        this.handlers.onError(msg.code);
        break;
    }
  }

  /** Inner join payload (`room`, `name`, `avatar`) — what the SSE fallback
   *  POSTs, and what `joinMsg` wraps into a tagged stream message. */
  joinPayload(): { room: string; name: string; avatar?: { color: string } } {
    return {
      room: this.room,
      name: this.name,
      avatar: { color: this.avatarColor },
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

  constructor(private conn: Connection) {}

  async connect(): Promise<void> {
    const wt = new WebTransport(`/wt`);
    this.wt = wt;
    wt.closed.then(
      () => this.conn.onTransportDown(),
      (err) => {
        console.warn("webtransport closed:", err);
        this.conn.onTransportDown();
      },
    );
    await wt.ready;

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
    } finally {
      this.conn.onTransportDown();
    }
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
    } finally {
      // Datagram stream ended: the connection is going.
      this.conn.onTransportDown();
    }
  }

  sendMsg(msg: ClientMsg): void {
    void this.writer?.write(encodeLine(msg));
  }

  sendMove(id: string, x: number, y: number, d: Dir, moving: boolean, seq: number): void {
    if (!this.wt || this.wt.readyState !== "connected") return;
    const batch: MovementBatch = {
      m: [{ id, x, y, d, mv: moving ? 1 : 0, s: seq }],
    };
    this.wt.sendDatagram(encodeLine(batch));
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

  constructor(private conn: Connection) {}

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
      this.conn.onTransportDown();
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

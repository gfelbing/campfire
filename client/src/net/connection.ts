import type {
  ChatMsg,
  ClientMsg,
  Dir,
  MovementBatch,
  OwnStatus,
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
  /** A member's presence status changed (profile menu). */
  onUserStatus: (id: string, status: OwnStatus) => void;
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
  /** Stepped onto an `exitUrl` zone: the server resolved the URL to a map
   *  id (README roadmap "Map enhancements"); navigate there with the same
   *  name + color. */
  onNavigate: (map: string) => void;
  onError: (code: string) => void;
  onStatus: (s: ConnStatus) => void;
}

export type ConnStatus = "connected" | "reconnecting" | "disconnected";

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/// Keepalive cadence (README §5): the server reaps a command stream idle
/// for 300 s, so 25 s leaves a wide margin. The ping writes through
/// whatever transport is current, so a reconnect needs no restart.
const PING_INTERVAL_MS = 25_000;

export class Connection {
  private transport: WTConn | SSEConn | null = null;
  private attempt = 0;
  /** Generation of the current transport (see `connectOnce`). */
  private connGen = 0;
  /** Generation counter: cancels a pending reconnect timer when the
   *  connection is closed or the page enters the back/forward cache. */
  private reconnectGen = 0;
  /** The transport generation whose death we already handled. A single
   *  WebTransport death reports itself through several readers at once
   *  (`closed`, the command stream and the datagrams); dedupe on the
   *  generation so exactly one reconnect is scheduled per death, not one
   *  per reporter. */
  private downGen = 0;
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
  /** Keepalive ping timer (README §5); see `PING_INTERVAL_MS`. */
  private pingTimer: number | null = null;

  constructor(
    private room: string,
    private name: string,
    private avatarColor: string,
    private status: OwnStatus,
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
      window.addEventListener("pagehide", (e) => {
        this.reconnectGen += 1; // cancel any pending reconnect timer
        this.closing = true;
        // A hard close (tab closed, navigated away, not saved to the bfcache):
        // tell the server to drop us immediately, so our avatar leaves now
        // instead of waiting out the 30 s reconnect window. Best effort — the
        // write is flushed in the same packet batch as the close. For a
        // bfcache hide (persisted) skip it: the page restores frozen and
        // re-joins with the same identity via the sessionStorage token.
        if (!(e as PageTransitionEvent).persisted) {
          this.transport?.sendMsg({ t: "leave" });
        }
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
    this.startPing();
    this.connectOnce();
  }

  /** Send a keepalive every `PING_INTERVAL_MS` (README §5): a stationary
   *  user sends no movement or chat, and the server reaps a command stream
   *  idle for 300 s — without the ping, such a session (and with it the
   *  identity and position) is lost after the 10 s reconnect window. */
  private startPing(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = window.setInterval(() => {
      this.transport?.sendMsg({ t: "ping" });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  close(): void {
    this.reconnectGen += 1;
    this.closing = true;
    this.stopPing();
    this.transport?.close();
    this.transport = null;
  }

  sendChat(text: string): void {
    this.transport?.sendMsg({ t: "chat", text });
  }

  sendTyping(on: boolean): void {
    this.transport?.sendMsg({ t: "typing", on });
  }

  /** Announce a presence-status change (the profile menu). */
  sendStatus(status: OwnStatus): void {
    this.transport?.sendMsg({ t: "status", status });
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

  /** Transport RTT in ms (the `/wt` QUIC connection's `smoothedRtt`), or
   *  `null` when unsupported (the SSE fallback, or a browser without
   *  `WebTransport.getStats()`). The `/wt` connection is a second QUIC
   *  connection to the same host — a close proxy for the MoQ session's
   *  path, which is what the call tiles display next to their e2e delay. */
  getRtt(): Promise<number | null> {
    return this.transport?.getRtt() ?? Promise.resolve(null);
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
    if (gen === this.downGen) return; // this death already handled
    this.downGen = gen;
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
      case "status":
        this.handlers.onUserStatus(msg.id, msg.status);
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
      case "navigate":
        this.handlers.onNavigate(msg.map);
        break;
      case "error":
        console.warn("server error:", msg.code);
        this.handlers.onError(msg.code);
        break;
    }
  }

  /** Inner join payload (`room`, `name`, `avatar`, `token`, `status`) — what
   *  the SSE fallback POSTs, and what `joinMsg` wraps into a tagged stream
   *  message. The token (when we have one) makes a reconnect restore our
   *  identity instead of creating a fresh user (README §5). */
  joinPayload(): {
    room: string;
    name: string;
    avatar?: { color: string };
    token?: string;
    status?: OwnStatus;
  } {
    return {
      room: this.room,
      name: this.name,
      avatar: { color: this.avatarColor },
      ...(this.token ? { token: this.token } : {}),
      ...(this.status !== "online" ? { status: this.status } : {}),
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
  let pending: Uint8Array = new Uint8Array(0);
  // Decode each complete line as a whole: `\n` (0x0A) can never appear
  // inside a UTF-8 multibyte sequence (all other bytes are >= 0x80), so an
  // undecoded tail can never contain a line break, and a multibyte
  // character split across chunks is reassembled by the decode of the
  // complete line. (Relies on no decoder state: a per-chunk decode with
  // `{ stream: true }` is not guaranteed to carry an incomplete sequence
  // in every engine.)
  const decoder = new TextDecoder("utf-8");
  return (chunk: Uint8Array) => {
    const data = new Uint8Array(pending.length + chunk.length);
    data.set(pending);
    data.set(chunk, pending.length);
    let start = 0;
    let idx: number;
    while ((idx = data.indexOf(0x0a, start)) >= 0) {
      if (idx > start) onLine(decoder.decode(data.subarray(start, idx)));
      start = idx + 1;
    }
    pending = data.slice(start);
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
    // Datagrams are whole messages, so a non-streaming decoder is safe;
    // one per reader mirrors the line reader's pattern.
    const decoder = new TextDecoder("utf-8");
    try {
      for (;;) {
        const { done, value } = await this.dgReader!.read();
        if (done) break;
        try {
          const batch = JSON.parse(decoder.decode(value)) as MovementBatch;
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

  /** Transport RTT in ms via `getStats().smoothedRtt` — `WebTransport`
   *  has no `rtt` event (MDN/spec). `null` when unsupported (Chrome gates
   *  `getStats()` behind a runtime flag; see webtransport.d.ts) or when
   *  the transport is down. */
  getRtt(): Promise<number | null> {
    const wt = this.wt;
    if (!wt || typeof wt.getStats !== "function") return Promise.resolve(null);
    return wt
      .getStats()
      .then((s) => (typeof s.smoothedRtt === "number" ? s.smoothedRtt : null))
      .catch(() => null);
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
      // WebTransport has no close(): closeWithError is the only teardown.
      // (The former no-op `close()` silently kept the dead QUIC connection
      // open through bfcache/pagehide — the reconnect storm the server
      // warns about.)
      this.wt?.closeWithError(0, "campfire: page hidden");
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

  /** No QUIC transport, no RTT to measure. */
  getRtt(): Promise<number | null> {
    return Promise.resolve(null);
  }

  close(): void {
    this.es?.close();
  }
}

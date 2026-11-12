// TypeScript's DOM lib snapshot predates the datagram streams,
// `closeWithError` (WebTransport) and `stream` (TextDecoderOptions); every
// browser with WebTransport has them. Extend the global interfaces so the
// transport code type-checks against them.
//
// Deliberately NOT declared:
// - `sendDatagram()` — never shipped in Chromium (it is WebSocket-era draft
//   API); datagrams go through `datagrams.writable` instead.
// - `readyState` — WebTransport has none (that is WebSocket). Declaring one
//   once let a `!== "connected"` guard silently disable all movement.
// Track liveness from `ready`/`closed` instead.
interface WebTransport {
  /** Tear down the transport (the only close; there is no plain
   *  `close()`). */
  closeWithError(errorCode: number, reason: string | BufferSource | undefined): void;
  readonly datagrams: {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
  };
  /** Connection stats (W3C `WebTransportConnectionStats`). Guarded at the
   *  call site: Chrome has not enabled it by default yet (Chromium issue
   *  573538454, the `WebTransportStats` runtime feature), and it is
   *  absent from the instance API in browsers that have not shipped it —
   *  hence `typeof getStats === "function"` before use. */
  getStats(): Promise<WebTransportStats>;
}

/** W3C `WebTransportConnectionStats` — the fields campfire uses. Every
 *  field is optional: the API itself is flag-gated in Chrome (see above),
 *  and a snapshot may omit fields it cannot measure. */
interface WebTransportStats {
  /** Smoothed RTT, ms. */
  smoothedRtt?: number;
  /** Minimum RTT observed, ms. */
  minRtt?: number;
  /** RTT variation (jitter), ms. */
  rttVariation?: number;
  /** Cumulative bytes sent. */
  bytesSent?: number;
  /** Cumulative bytes received. */
  bytesReceived?: number;
  /** Estimated send rate, bits/s (Chrome, when the flag is on). */
  estimatedSendRate?: number;
}

/** WHATWG Encoding: carry a partial multibyte character across `decode()`
 *  calls. */
interface TextDecoderOptions {
  stream?: boolean;
}

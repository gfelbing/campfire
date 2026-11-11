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
}

/** WHATWG Encoding: carry a partial multibyte character across `decode()`
 *  calls. */
interface TextDecoderOptions {
  stream?: boolean;
}

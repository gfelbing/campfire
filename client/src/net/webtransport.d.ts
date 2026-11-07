// TypeScript's DOM lib snapshot predates the datagram streams on
// WebTransport; every browser with WebTransport has them. Extend the global
// interface so the transport code type-checks against it.
//
// Deliberately NOT declared:
// - `sendDatagram()` — never shipped in Chromium (it is WebSocket-era draft
//   API); datagrams go through `datagrams.writable` instead.
// - `readyState` — WebTransport has none (that is WebSocket). Declaring one
//   once let a `!== "connected"` guard silently disable all movement.
// Track liveness from `ready`/`closed` instead.
interface WebTransport {
  readonly datagrams: {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
  };
}

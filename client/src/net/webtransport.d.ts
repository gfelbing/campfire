// TypeScript's DOM lib snapshot predates `sendDatagram` on WebTransport;
// every browser with WebTransport has it. Extend the global interface so
// the transport code type-checks against it.
//
// Deliberately NO `readyState` here: WebTransport has none (that is
// WebSocket). Declaring one let a `!== "connected"` guard silently disable
// all movement datagrams — track liveness from `ready`/`closed` instead.
interface WebTransport {
  sendDatagram(data: Uint8Array | ArrayBuffer): void;
}

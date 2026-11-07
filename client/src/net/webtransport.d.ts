// TypeScript's DOM lib snapshot predates `readyState` and `sendDatagram` on
// WebTransport; every browser with WebTransport has both. Extend the global
// interface so the transport code type-checks against it.
interface WebTransport {
  readonly readyState: "connecting" | "connected" | "closed";
  sendDatagram(data: Uint8Array | ArrayBuffer): void;
}

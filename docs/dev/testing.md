# Testing

| Suite | Where | How to run |
|---|---|---|
| Unit | `crates/*` | `just test` (part of `cargo test --workspace`) |
| Integration | `crates/campfire-server/tests/` | `just test` |
| Headless E2E | `tools/e2e/` | `just e2e` (needs a running server build) |
| MoQ call E2E | `tools/e2e/moq.js` | `just moq-e2e` |
| Load | `tools/loadtest/` | `just loadtest` (needs a running server) |

## Unit

Protocol codec round-trips, Tiled parsing, walkability, movement validation
(speed/walkability/bounds/staleness), bubble engine transitions, room-id
validation. The protocol crate has no IO, so its codec is exhaustively tested
in isolation.

## Integration (real QUIC/WebTransport clients on ephemeral ports)

- join/hello/leave (`wt.rs`), movement batching,
- bubble lifecycle: six-member huddle, mid-call drop/reconnect, walk-away
  (`huddle.rs`, `call.rs`),
- reconnect identity with zero flicker (`reconnect.rs`),
- chat under 5% packet loss,
- HTTP/3 API surface (`http3.rs`),
- the SSE+POST fallback carries the full catalogue (`sse.rs`),
- MoQ SFU wiring and ticket admission (`moq.rs`).

## Headless E2E (`tools/e2e`)

Headless Chromium with **fake media** over HTTP/3 (no permission prompts):
two pages join via URL, chat broadcasts, a bubble forms and tears down on
walk-away. `tools/e2e/moq.js` runs two real browser clients against the SFU
(publisher streaming live, subscriber rendering frames — a sanity bound, not a
pixel-perfect check).

## Load (`tools/loadtest`)

A ramped QUIC bot swarm: joins rooms, walks, forms bubbles, toggles mute.
Verified 50 users / 2 rooms / 2 live bubbles with mean tick 0.16 ms. Exposes
its own counters for the driver to scrape (`/metrics` shape).

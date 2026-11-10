//! Phase 0 spike glue (docs/moq-sfu.md §5): WebTransport sessions for the
//! `web-transport-trait` 0.4 async interface, over
//!
//! - [`h3wt`]: the `h3_webtransport` server session the production
//!   h3/quinn endpoint yields (the only path the rebuilt SFU uses), and
//! - [`client_wt`]: a `wtransport` WebTransport client connection (the
//!   tier-1 test clients).
//!
//! `moq-net` is poll-only; [`Bridge`] (`moq_tokio::transport::Session`)
//! adapts any async `web_transport_trait::Session` to that poll interface,
//! including the drop-safety of the two-stage stream opens. These two trait
//! impls are the only protocol glue the rebuild writes.
//!
//! Known gap: `set_priority` is a no-op on the h3 bridge — h3 0.0.8 does not
//! expose QUIC stream priority for already-open streams. QUIC still
//! multiplexes; MoQ's importance ordering degrades to FIFO until the h3
//! surface gains it.

pub mod asyncmockwt;
pub mod cc;
pub mod client_wt;
pub mod h3wt;
pub mod mockwt;
pub mod mockwt_harness;
pub mod tls;

/// The async→poll adapter `moq-net` consumes, over an async-trait session.
pub type Bridge<S> = moq_tokio::transport::Session<S>;

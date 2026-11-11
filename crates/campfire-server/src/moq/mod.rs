//! The SFU (docs/moq-sfu.md §5): media-over-QUIC, server-transit.
//!
//! - [`tickets`] — short-lived media tickets, minted by the world on
//!   `call_start` / reconnect `hello`.
//! - [`fanout`] — one moq-net origin per active call (fan-out + caching are
//!   moq-net's job; isolation is structural).
//! - [`session`] — the `/moq` route: ticket + membership admission, then
//!   the session runs on moq-net.
//! - [`h3wt`] — the `web_transport_trait` bridge over the h3/quinn
//!   WebTransport session (the only protocol glue; ported unchanged from
//!   the Phase 0 spike).

pub mod fanout;
pub mod h3wt;
pub mod session;
pub mod tickets;

pub use session::MoqSfu;
pub use session::handle_moq;

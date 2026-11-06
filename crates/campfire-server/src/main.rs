//! Campfire — a virtual-office-style virtual office.
//!
//! One binary listening on one port number (443): QUIC/HTTP/3 + WebTransport
//! + STUN on UDP, TURN/TLS on TCP. See README.md for the implementation plan.
//!
//! Phase 0: workspace skeleton — the binary boots and reports itself.
//! Sockets and the router arrive in Phase 1.

fn main() {
    println!(
        "campfire-server {} — phase 0 skeleton (no listeners yet)",
        env!("CARGO_PKG_VERSION")
    );
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_set() {
        assert!(!env!("CARGO_PKG_VERSION").is_empty());
    }
}

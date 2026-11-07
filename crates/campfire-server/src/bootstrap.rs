//! TLS front over TCP: the HTTP/3 discovery bootstrap + TURN splice.
//!
//! Browsers discover HTTP/3 only through an `Alt-Svc` response header, and
//! such a header can only arrive over a TCP connection — the QUIC listener
//! itself cannot advertise. The public TCP port is therefore a TLS front that
//! terminates TLS for *both* protocols sharing it (README §6.2: in
//! production, `turns:host:443` must be indistinguishable from ordinary
//! HTTPS) and demuxes on the first plaintext bytes:
//!
//! * **STUN** — every STUN message carries the magic cookie `0x2112A442` at
//!   bytes 4–8 (RFC 5389 §6), and TURN-over-TLS clients speak STUN → the
//!   stream is spliced to TURN's internal plaintext TCP listener (the TLS
//!   was terminated here, so TURN is configured without SSL).
//! * **HTTP** — a minimal HTTP/1.1 answer carrying `Alt-Svc: h3=":port"`.
//!   The document asks the browser to reload once (`?alt=1`), by which time
//!   the alternative is cached and the reload (plus every later request,
//!   including the WebTransport connect) rides HTTP/3. If the reload still
//!   arrives over TCP, the page says so — that means UDP is unreachable.
//!
//! Failures here are logged and non-fatal: the QUIC service itself keeps
//! working for HTTP/3-aware clients; only browser discovery and TURN-over-TCP
//! degrade.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Result;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info};

use crate::config::Config;
use crate::tls;

/// The STUN magic cookie every STUN message carries (RFC 5389 §6).
const STUN_MAGIC: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];

/// Reserve an ephemeral localhost port for TURN's internal plaintext TCP
/// listener. The probe socket is dropped before TURN binds it — on localhost
/// the race window is negligible.
pub fn free_local_tcp() -> std::io::Result<SocketAddr> {
    let probe = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    probe.local_addr()
}

/// Start the TLS front on the public TCP port. `turn_internal` is where
/// TURN's plaintext TCP listener lives (splice target for STUN/TURN).
pub fn start(cfg: &Config, turn_internal: SocketAddr) -> Result<()> {
    let (certs, key) = tls::load_pem(&cfg.cert, &cfg.key)?;
    // Only http/1.1: browsers always offer h2 as well, but the bootstrap
    // answers HTTP/1.1 by hand — selecting h2 would break that.
    let rustls_conf = tls::rustls_server_config(certs, key, vec![b"http/1.1".to_vec()])?;
    let acceptor = TlsAcceptor::from(Arc::new(rustls_conf));
    let listen = cfg.listen;
    let alt = format!("h3=\":{}\"; ma=86400", listen.port());

    tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(listen).await {
            Ok(listener) => listener,
            Err(err) => {
                error!(%err, listen = %listen, "TCP TLS front failed to bind; browsers cannot discover HTTP/3 (Alt-Svc) and TURN over TCP is down");
                return;
            }
        };
        info!(
            listen = %listen,
            turn = %turn_internal,
            "TLS front listening: Alt-Svc bootstrap + TURN splice"
        );
        loop {
            let Ok((tcp, _peer)) = listener.accept().await else {
                break;
            };
            let acceptor = acceptor.clone();
            let turn_internal = turn_internal;
            let alt = alt.clone();
            tokio::spawn(async move {
                let mut tls = match acceptor.accept(tcp).await {
                    Ok(tls) => tls,
                    Err(err) => {
                        debug!(%err, "TLS front: handshake failed");
                        return;
                    }
                };
                // One read covers the demux: a STUN header starts with a
                // 20-byte message whose bytes 4–8 are the magic cookie; an
                // HTTP request starts with an ASCII request line.
                let mut buf = vec![0u8; 4096];
                let n = match tls.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                if n >= 8 && buf[4..8] == STUN_MAGIC {
                    splice_to_turn(tls, turn_internal, &buf[..n]).await;
                } else {
                    let line = buf[..n].iter().position(|&b| b == b'\n').map(|i| &buf[..i]);
                    let wants_alt_marker = line.is_some_and(|l| {
                        let l = std::str::from_utf8(l).unwrap_or("");
                        l.contains("alt=1")
                    });
                    if let Err(err) = bootstrap_answer(tls, &alt, wants_alt_marker).await {
                        debug!(%err, "TLS front: bootstrap answer failed");
                    }
                }
            });
        }
    });
    Ok(())
}

/// Splice an established TLS stream (already recognized as STUN/TURN by its
/// first bytes) to TURN's internal plaintext listener. `first` is the bytes
/// already consumed from the client side and must be replayed.
async fn splice_to_turn<S>(tls: S, turn_internal: SocketAddr, first: &[u8])
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let turn = match tokio::net::TcpStream::connect(turn_internal).await {
        Ok(turn) => turn,
        Err(err) => {
            debug!(%err, "TLS front: TURN splice target unreachable");
            return;
        }
    };
    let (mut turn_read, mut turn_write) = tokio::io::split(turn);
    let (mut tls_read, mut tls_write) = tokio::io::split(tls);
    if turn_write.write_all(first).await.is_err() {
        return;
    }
    // Client → TURN runs in its own task; this task drains TURN → client and
    // shuts the client side down when the server goes quiet.
    let up = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut tls_read, &mut turn_write).await;
        let _ = turn_write.shutdown().await;
    });
    let _ = tokio::io::copy(&mut turn_read, &mut tls_write).await;
    let _ = tls_write.shutdown().await;
    let _ = up.await;
}

/// The HTTP/1.1 bootstrap answer: `Alt-Svc` plus a document that reloads once
/// (`?alt=1`) so the browser re-requests over HTTP/3 with the alternative
/// cached. If the reload still lands here (no `alt=1` → refresh; `alt=1` →
/// explanation), UDP to this port is not reachable from that browser.
async fn bootstrap_answer<S>(mut tls: S, alt: &str, wants_alt_marker: bool) -> std::io::Result<()>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    let body = if wants_alt_marker {
        "<!doctype html><meta charset=utf-8><title>Campfire</title>\
<p>Campfire runs over HTTP/3 (QUIC on UDP). This page was served over TCP \
because the browser has not switched to HTTP/3 yet.</p>\
<p>If reloading the page does not fix this, UDP to this port is not \
reachable from your browser/network.</p>"
    } else {
        "<!doctype html><meta charset=utf-8>\
<meta http-equiv=refresh content=\"0; url=?alt=1\">\
<title>Campfire</title><p>Switching to HTTP/3&hellip;</p>"
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\nAlt-Svc: {alt}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    tls.write_all(head.as_bytes()).await?;
    tls.write_all(body.as_bytes()).await?;
    tls.flush().await?;
    Ok(())
}

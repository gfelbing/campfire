//! TLS front over TCP: the HTTP/3 discovery bootstrap.
//!
//! Browsers discover HTTP/3 only through an `Alt-Svc` response header, and
//! such a header can only arrive over a TCP connection — the QUIC listener
//! itself cannot advertise. The public TCP port is therefore a TLS front
//! that answers HTTP/1.1 by hand:
//!
//! * **HTTP** — a `302` back to the original target, carrying
//!   `Alt-Svc: h3=":port"`. The browser caches the alternative from the
//!   redirect response and follows it over HTTP/3; by then (plus every
//!   later request, including the WebTransport connect) the alternative is
//!   in play. If the redirected request still lands over TCP (the target
//!   then carries the `?alt=1` marker), the page says so — that means UDP
//!   is unreachable.
//!
//! Failures here are logged and non-fatal: the QUIC service itself keeps
//! working for HTTP/3-aware clients; only browser discovery degrades.

use std::sync::Arc;

use anyhow::Result;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info};

use crate::config::Config;
use crate::tls;

/// Start the TLS front on the public TCP port.
pub fn start(cfg: &Config) -> Result<()> {
    let (certs, key) = tls::load_pem(&cfg.cert, &cfg.key)?;
    // Only http/1.1: browsers always offer h2 as well, but the bootstrap
    // answers HTTP/1.1 by hand — selecting h2 would break that.
    let rustls_conf = tls::rustls_server_config(certs, key, vec![b"http/1.1".to_vec()])?;
    let acceptor = TlsAcceptor::from(Arc::new(rustls_conf));
    let listen = cfg.listen;
    // The Alt-Svc must name the port the *client* can reach. Behind a port
    // mapping (docker/podman `-p 8443:443`) that is the external port, not
    // the one the socket binds inside the container — reuse `--external`.
    // Browsers ignore the host part of an Alt-Svc entry, so the port is
    // what matters.
    let alt = format!("h3=\":{}\"; ma=86400", cfg.external_addr().port());

    tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(listen).await {
            Ok(listener) => listener,
            Err(err) => {
                error!(%err, listen = %listen, "TCP TLS front failed to bind; browsers cannot discover HTTP/3 (Alt-Svc)");
                return;
            }
        };
        info!(listen = %listen, "TLS front listening: Alt-Svc bootstrap");
        loop {
            let Ok((tcp, _peer)) = listener.accept().await else {
                break;
            };
            let acceptor = acceptor.clone();
            let alt = alt.clone();
            tokio::spawn(async move {
                let mut tls = match acceptor.accept(tcp).await {
                    Ok(tls) => tls,
                    Err(err) => {
                        debug!(%err, "TLS front: handshake failed");
                        return;
                    }
                };
                // One read covers the request line: an HTTP request starts
                // with an ASCII request line.
                let mut buf = vec![0u8; 4096];
                let n = match tls.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                let line = buf[..n].iter().position(|&b| b == b'\n').map(|i| &buf[..i]);
                // The request target ("GET /play/office/office.json?name=… …"):
                // the reload must keep it, or the browser loses its query
                // parameters (the ?alt=1 marker would otherwise replace them).
                let target = line
                    .and_then(|l| std::str::from_utf8(l).ok())
                    .and_then(|l| {
                        l.split(' ')
                            .nth(1)
                            .filter(|t| t.starts_with('/') && !t.contains(' '))
                            .map(|t| t.to_owned())
                    });
                let wants_alt_marker = line.is_some_and(|l| {
                    let l = std::str::from_utf8(l).unwrap_or("");
                    l.contains("alt=1")
                });
                let sep = if target.as_deref().is_some_and(|t| t.contains('?')) {
                    "&"
                } else {
                    "?"
                };
                let refresh = target.map(|t| format!("{t}{sep}alt=1"));
                if let Err(err) = bootstrap_answer(tls, &alt, wants_alt_marker, refresh).await {
                    debug!(%err, "TLS front: bootstrap answer failed");
                }
            });
        }
    });
    Ok(())
}

/// The HTTP/1.1 bootstrap answer. First hop (no `alt=1` marker in the
/// target): `302 Found` back to the same target with the marker appended,
/// carrying `Alt-Svc` — the browser caches the alternative from the
/// redirect and re-requests over HTTP/3. If the redirected request still
/// arrives over TCP, UDP is unreachable from that browser: serve the
/// explanation instead of looping the redirect.
async fn bootstrap_answer<S>(
    mut tls: S,
    alt: &str,
    wants_alt_marker: bool,
    redirect: Option<String>,
) -> std::io::Result<()>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    let (head, body) = if wants_alt_marker {
        // Self-healing page (issues.md "tcp fallback page is shown
        // initially"): a fresh browser load has no cached Alt-Svc, so the
        // first navigation lands here over TCP. The Alt-Svc header on this
        // response is cached before the script below runs, so a plain
        // reload a moment later lands on QUIC. The attempt counter in
        // sessionStorage (key `campfire-quic-retry`) stops the reload
        // after ~5 tries and shows the final message instead of looping
        // when UDP is genuinely unreachable; the counter expires after a
        // minute so a later manual reload retries, and the app clears it
        // on a successful load (client/src/main.ts).
        let body = "<!doctype html><meta charset=utf-8><title>Campfire</title>\
<p id=retry>Campfire runs over HTTP/3 (QUIC on UDP). This page was served \
over TCP because the browser has not switched to HTTP/3 yet. Trying again \
automatically&#8230;</p>\
<p id=final hidden>Campfire runs over HTTP/3 (QUIC on UDP). This page was \
served over TCP because the browser has not switched to HTTP/3 yet.</p>\
<p id=final2 hidden>If reloading the page does not fix this, UDP to this \
port is not reachable from your browser/network.</p>\
<script>\
(function () {\
  var KEY = \"campfire-quic-retry\";\
  var MAX = 5, WAIT = 1500, WINDOW = 60000;\
  var n = 0;\
  try {\
    var prev = JSON.parse(sessionStorage.getItem(KEY) || \"null\");\
    if (prev && typeof prev.n === \"number\" && Date.now() - prev.t < WINDOW) n = prev.n;\
  } catch (e) {}\
  if (n >= MAX) {\
    document.getElementById(\"retry\").hidden = true;\
    document.getElementById(\"final\").hidden = false;\
    document.getElementById(\"final2\").hidden = false;\
    return;\
  }\
  try { sessionStorage.setItem(KEY, JSON.stringify({ n: n + 1, t: Date.now() })); } catch (e) {}\
  setTimeout(function () { location.replace(location.href); }, WAIT);\
})();\
</script>".to_owned();
        (
            format!(
                "HTTP/1.1 200 OK\r\nAlt-Svc: {alt}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                body.len()
            ),
            body,
        )
    } else {
        let redirect = redirect.unwrap_or_else(|| "/?alt=1".to_owned());
        (
            format!(
                "HTTP/1.1 302 Found\r\nAlt-Svc: {alt}\r\nLocation: {redirect}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            ),
            String::new(),
        )
    };
    tls.write_all(head.as_bytes()).await?;
    tls.write_all(body.as_bytes()).await?;
    tls.flush().await?;
    Ok(())
}

//! UDP demux socket: one OS socket, two protocols (README §6.2).
//!
//! QUIC/HTTP/3 (quinn) and the STUN binding responder share the single UDP
//! port. Demux: a datagram that parses as a STUN message (message type +
//! magic cookie, see [`crate::stun::is_stun`]) is handled in place —
//! Binding requests are answered with an XOR-MAPPED-ADDRESS; everything
//! else is a QUIC packet queued for quinn. The first byte alone cannot
//! disambiguate: a GREASE'd (RFC 9287) QUIC 1-RTT packet may carry any
//! first byte below 0x80, so STUN identification relies on the 20-byte
//! STUN header. A QUIC datagram that accidentally validates as STUN
//! (~2^-32 per packet, the magic cookie) is dropped and retransmitted by
//! QUIC — harmless.
//!
//! Architecture:
//! - One OS socket, cloned once at bind time: the reader clone is owned by
//!   a background demux task, the other half by quinn (via this type).
//! - The demux task receives every datagram. STUN Binding requests are
//!   answered in place; QUIC datagrams are queued for quinn.
//! - The [`AsyncUdpSocket`] impl below (handed to `quinn::Endpoint`) reads
//!   from that queue — it never reads from the socket, which is what keeps
//!   the STUN/QUIC demux intact — and sends directly through its half.
//!
//! No GSO/GRO/ECN: the socket is a plain UDP socket, so one `recv_from`
//! always carries exactly one datagram and the STUN header stays intact
//! for the demux. The optimization is not worth breaking the demux in v1.
//!
//! Burst draining: after the first datagram of a burst arrives, the demux
//! task drains everything already sitting in the kernel buffer without
//! yielding, and only then wakes quinn. This reproduces the effect UDP GRO
//! had on the old `quinn-udp` socket: consecutive datagrams of one flight
//! reach quinn in a single poll iteration, in order — so h3 sees the
//! client's SETTINGS frame before a later WebTransport CONNECT request is
//! handed to the application.

use std::collections::VecDeque;
use std::io;
use std::io::IoSliceMut;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use quinn::udp::{RecvMeta, Transmit};
use quinn::{AsyncUdpSocket, UdpPoller};
use tracing::debug;

use crate::stun;

/// A queued QUIC datagram with its source address.
type Queued = (Vec<u8>, SocketAddr);

/// The shared UDP socket with the STUN/QUIC demux (README §6.2).
#[derive(Debug)]
pub struct DemuxSocket {
    /// The socket half quinn sends through (same OS socket as the demux
    /// task's reader half).
    io: tokio::net::UdpSocket,
    /// QUIC datagrams queued by the demux task, plus the waker of the task
    /// parked in `poll_recv`. One mutex so push-and-wake and park-and-check
    /// cannot race.
    handoff: Mutex<(VecDeque<Queued>, Option<Waker>)>,
}

impl DemuxSocket {
    /// Bind the shared UDP socket and start the demux task.
    pub fn bind(listen: SocketAddr) -> io::Result<Arc<Self>> {
        // Clone at the OS level: both halves share the same fd, so the
        // demux task's `recv_from` and quinn's `send_to` meet on one port.
        let std_sock = std::net::UdpSocket::bind(listen)?;
        std_sock.set_nonblocking(true)?;
        let reader = tokio::net::UdpSocket::from_std(std_sock.try_clone()?)?;
        let io = tokio::net::UdpSocket::from_std(std_sock)?;
        let socket = Arc::new(Self {
            io,
            handoff: Mutex::new((VecDeque::new(), None)),
        });
        spawn_demux(socket.clone(), reader);
        Ok(socket)
    }

    /// The bound local address (port 0 resolves to the real port here).
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.io.local_addr()
    }
}

/// The background demux loop: receive everything, answer STUN, queue QUIC.
fn spawn_demux(socket: Arc<DemuxSocket>, reader: tokio::net::UdpSocket) {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65_536];
        loop {
            // Block for the first datagram of the burst…
            let (n, src) = match reader.recv_from(&mut buf).await {
                Ok(x) => x,
                Err(err) => {
                    debug!(%err, "demux receive loop ended");
                    return;
                }
            };
            // …then drain everything already in the kernel buffer without
            // yielding, so quinn sees the whole burst in one poll (see the
            // module docs for why this matters).
            let mut quic_pending = false;
            let mut datagram: Option<(usize, SocketAddr)> = Some((n, src));
            while let Some((n, src)) = datagram.take() {
                let pkt = &buf[..n];
                if stun::is_stun(pkt) {
                    // STUN Binding: answer in place (README §6.2).
                    if let Some(reply) = stun::answer_binding_request(pkt, src)
                        && let Err(err) = reader.send_to(&reply, src).await
                    {
                        debug!(%err, "failed to send STUN response");
                    }
                } else {
                    // QUIC: hand to quinn.
                    let mut h = socket.handoff.lock().unwrap();
                    h.0.push_back((pkt.to_vec(), src));
                    quic_pending = true;
                }
                match reader.try_recv_from(&mut buf) {
                    Ok(next) => datagram = Some(next),
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                    Err(err) => {
                        debug!(%err, "demux receive loop ended");
                        return;
                    }
                }
            }
            if quic_pending {
                let mut h = socket.handoff.lock().unwrap();
                if let Some(waker) = h.1.take() {
                    waker.wake();
                }
            }
        }
    });
}

impl AsyncUdpSocket for DemuxSocket {
    fn create_io_poller(self: Arc<Self>) -> Pin<Box<dyn UdpPoller>> {
        Box::pin(WritablePoller { socket: self })
    }

    fn try_send(&self, transmit: &Transmit) -> io::Result<()> {
        // Plain single-datagram send. The socket is non-blocking: a full
        // send buffer yields WouldBlock and quinn re-arms via the poller.
        self.io
            .try_send_to(transmit.contents, transmit.destination)
            .map(|_| ())
    }

    fn poll_recv(
        &self,
        cx: &mut Context,
        bufs: &mut [IoSliceMut<'_>],
        meta: &mut [RecvMeta],
    ) -> Poll<io::Result<usize>> {
        loop {
            let (pkt, src) = {
                let mut h = self.handoff.lock().unwrap();
                match h.0.pop_front() {
                    Some(q) => q,
                    None => {
                        h.1 = Some(cx.waker().clone());
                        return Poll::Pending;
                    }
                }
            };
            if pkt.len() > bufs[0].len() {
                // The peer violated max_udp_payload_size; drop the packet
                // (the sender will retransmit). This mirrors what the kernel
                // did with ENOBUFS for oversized datagrams on the old
                // GRO-enabled socket.
                debug!(len = pkt.len(), "dropping oversized datagram");
                continue;
            }
            let n = pkt.len();
            bufs[0][..n].copy_from_slice(&pkt);
            meta[0] = RecvMeta {
                addr: src,
                len: n,
                stride: n,
                ecn: None,
                dst_ip: None,
            };
            return Poll::Ready(Ok(1));
        }
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        DemuxSocket::local_addr(self)
    }
}

/// Wakes the parked task when the shared socket can accept more sends.
#[derive(Debug)]
struct WritablePoller {
    socket: Arc<DemuxSocket>,
}

impl UdpPoller for WritablePoller {
    fn poll_writable(self: Pin<&mut Self>, cx: &mut Context) -> Poll<io::Result<()>> {
        self.socket.io.poll_send_ready(cx)
    }
}

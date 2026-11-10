//! UDP socket wrapper with burst draining: one OS socket for quinn.
//!
//! QUIC/HTTP/3 (quinn) binds the UDP port through this type. Formerly the
//! socket also served the STUN binding responder (WebRTC ICE, removed in
//! Phase 4); the demux task remains only for the burst-draining behavior
//! that quinn's own socket does not provide:
//!
//! - One OS socket, cloned once at bind time: the reader clone is owned by
//!   a background task, the other half by quinn (via this type).
//! - The background task receives every datagram and queues it for quinn.
//! - The [`AsyncUdpSocket`] impl below (handed to `quinn::Endpoint`) reads
//!   from that queue — it never reads from the socket — and sends directly
//!   through its half.
//!
//! No GSO/GRO/ECN: the socket is a plain UDP socket, so one `recv_from`
//! always carries exactly one datagram.
//!
//! Burst draining: after the first datagram of a burst arrives, the task
//! drains everything already sitting in the kernel buffer without
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

/// A queued QUIC datagram with its source address.
type Queued = (Vec<u8>, SocketAddr);

/// The shared UDP socket (README §6.2).
#[derive(Debug)]
pub struct DemuxSocket {
    /// The socket half quinn sends through (same OS socket as the
    /// reader task's half).
    io: tokio::net::UdpSocket,
    /// QUIC datagrams queued by the reader task, plus the waker of the task
    /// parked in `poll_recv`. One mutex so push-and-wake and park-and-check
    /// cannot race.
    handoff: Mutex<(VecDeque<Queued>, Option<Waker>)>,
}

impl DemuxSocket {
    /// Bind the UDP socket and start the reader task.
    pub fn bind(listen: SocketAddr) -> io::Result<Arc<Self>> {
        // Clone at the OS level: both halves share the same fd, so the
        // reader's `recv_from` and quinn's `send_to` meet on one port.
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

/// The background reader loop: receive everything, queue QUIC.
fn spawn_demux(socket: Arc<DemuxSocket>, reader: tokio::net::UdpSocket) {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 65_536];
        loop {
            // Block for the first datagram of the burst…
            let (n, src) = match reader.recv_from(&mut buf).await {
                Ok(x) => x,
                Err(err) => {
                    debug!(%err, "socket receive loop ended");
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
                // QUIC: hand to quinn.
                let mut h = socket.handoff.lock().unwrap();
                h.0.push_back((pkt.to_vec(), src));
                quic_pending = true;
                match reader.try_recv_from(&mut buf) {
                    Ok(next) => datagram = Some(next),
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                    Err(err) => {
                        debug!(%err, "socket receive loop ended");
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

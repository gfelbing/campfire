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

/// A queued QUIC datagram with its source address. The buffer is taken
/// from the handoff's pool and returned to it right after quinn copied
/// the packet out in `poll_recv` — no allocation per packet on either
/// side (docs/dev/latency-optimization.md §2 step 6).
type Queued = (Vec<u8>, SocketAddr);

/// The shared UDP socket (docs/arch/decisions.md).
#[derive(Debug)]
pub struct DemuxSocket {
    /// The socket half quinn sends through (same OS socket as the
    /// reader task's half).
    io: tokio::net::UdpSocket,
    /// QUIC datagrams queued by the reader task, plus the waker of the task
    /// parked in `poll_recv`. One mutex so push-and-wake and park-and-check
    /// cannot race.
    handoff: Mutex<Handoff>,
}

/// The handoff queue plus the buffer pool the queued buffers were drawn
/// from and are returned to. One mutex: `poll_recv` pops a batch, copies
/// it out and recycles the buffers without ever dropping a `Vec`.
#[derive(Debug, Default)]
struct Handoff {
    queue: VecDeque<Queued>,
    /// Waker of the task parked in `poll_recv` (the quinn side). Set when
    /// the queue is found empty; woken by the reader's push-and-wake.
    waker: Option<Waker>,
    /// Buffers read by the reader task, parked between packets. Grown
    /// once to the burst-drain high-water mark and never shrunk: datagrams
    /// are MTU-sized, the pool is bounded by the max in-flight packets.
    pool: Vec<Vec<u8>>,
}

impl Handoff {
    /// Take a buffer from the pool (or allocate a fresh one when empty).
    fn take_buf(&mut self) -> Vec<u8> {
        self.pool
            .pop()
            .unwrap_or_else(|| Vec::with_capacity(65_536))
    }
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
            handoff: Mutex::new(Handoff::default()),
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
        let mut inner_buf = vec![0u8; 65_536];
        loop {
            // Block for the first datagram of the burst…
            let (n, src) = match reader.recv_from(&mut inner_buf).await {
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
                // One buffer per packet, taken from the pool: the reader
                // copies the kernel buffer into a pooled slot and hands the
                // slot on; `poll_recv` recycles it after quinn copied out.
                let mut buf = {
                    let mut h = socket.handoff.lock().unwrap();
                    h.take_buf()
                };
                buf.clear();
                buf.extend_from_slice(&inner_buf[..n]);
                let mut h = socket.handoff.lock().unwrap();
                h.queue.push_back((buf, src));
                quic_pending = true;
                match reader.try_recv_from(&mut inner_buf) {
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
                if let Some(waker) = h.waker.take() {
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
        // Batch: drain as many queued datagrams as quinn offered buffers
        // for (docs/dev/latency-optimization.md §2 step 6). One `poll_recv`
        // per datagram paid the mutex hop twice per packet on a burst;
        // quinn sizes the arrays for GRO-style batches either way.
        let mut h = self.handoff.lock().unwrap();
        if h.queue.is_empty() {
            h.waker = Some(cx.waker().clone());
            return Poll::Pending;
        }
        let mut n = 0;
        while n < bufs.len() {
            let Some((pkt, src)) = h.queue.pop_front() else {
                break;
            };
            let len = pkt.len();
            if len > bufs[n].len() {
                // The peer violated max_udp_payload_size; drop the packet
                // (the sender will retransmit). This mirrors what the kernel
                // did with ENOBUFS for oversized datagrams on the old
                // GRO-enabled socket. The buffer still goes back to the pool.
                h.pool.push(pkt);
                debug!(len, "dropping oversized datagram");
                continue;
            }
            bufs[n][..len].copy_from_slice(&pkt);
            meta[n] = RecvMeta {
                addr: src,
                len,
                stride: len,
                ecn: None,
                dst_ip: None,
            };
            // Recycle: quinn has already copied the packet out above.
            h.pool.push(pkt);
            n += 1;
        }
        if n == 0 {
            // Only oversized packets were in the queue; park like an empty
            // one instead of handing quinn a zero batch (it expects ≥ 1).
            h.waker = Some(cx.waker().clone());
            return Poll::Pending;
        }
        Poll::Ready(Ok(n))
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

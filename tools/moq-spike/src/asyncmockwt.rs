//! The in-memory mock transport behind the ASYNC `web_transport_trait`
//! interface, so the `moq-tokio` adapter can be exercised without real QUIC
//! (see `adapter-repro`).
//!
//! Each async operation polls the poll-interface handle once per poll under a
//! shared std mutex; the mock's kio queues make that re-entrantly safe (a
//! `Pending` re-registers on the next poll). The mock has no flow control —
//! writes and datagrams resolve immediately — so the adapter's deferred-write
//! bookkeeping sees the easy path, while the open, accept, read, and close
//! paths run in full.

use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};

use bytes::Bytes;
use web_transport_trait::poll;
use web_transport_trait::poll::{RecvStream as _PollRecvStream, SendStream as _PollSendStream};
use web_transport_trait::poll::Session as _PollSession;
use web_transport_trait::{RecvStream, SendStream, Session};

use crate::mockwt::{create_mock_session_pair, MockError, MockRecvStream, MockSendStream, MockSession};

/// A future that polls the shared mock session once per poll.
struct SharedPoll<R> {
    inner: Arc<Mutex<MockSession>>,
    // The closure shape is the poll interface itself (one poll of the
    // shared handle); there is no shorter way to name it.
    #[allow(clippy::type_complexity)]
    f: Box<dyn Fn(&mut MockSession, &mut Context<'_>) -> Poll<R> + Send>,
}

impl<R> Future for SharedPoll<R> {
    type Output = R;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<R> {
        let mut guard = self.inner.lock().unwrap();
        (self.f)(&mut guard, cx)
    }
}

/// The async-interface handle over one half of a mock session pair.
#[derive(Clone)]
pub struct AsyncMockSession {
    inner: Arc<Mutex<MockSession>>,
    /// The negotiated protocol is fixed for the connection's life, so the
    /// wrapper keeps its own `&'static` copy (the poll accessor's lifetime is
    /// tied to the handle).
    protocol: Option<&'static str>,
}

/// A connected async-mock pair, ready to hand to the adapter.
pub fn create_async_mock_pair(
    protocol: Option<&'static str>,
) -> (AsyncMockSession, AsyncMockSession) {
    let (a, b) = create_mock_session_pair(protocol);
    (
        AsyncMockSession {
            inner: Arc::new(Mutex::new(a)),
            protocol,
        },
        AsyncMockSession {
            inner: Arc::new(Mutex::new(b)),
            protocol,
        },
    )
}

impl Session for AsyncMockSession {
    type SendStream = AsyncMockSend;
    type RecvStream = AsyncMockRecv;
    type Error = MockError;

    fn accept_uni(&self) -> impl Future<Output = Result<Self::RecvStream, Self::Error>> + Send {
        let inner = self.inner.clone();
        SharedPoll {
            inner,
            f: Box::new(|s, cx| poll::Session::poll_accept_uni(s, cx).map(|r| r.map(AsyncMockRecv::new))),
        }
    }

    fn accept_bi(
        &self,
    ) -> impl Future<Output = Result<(Self::SendStream, Self::RecvStream), Self::Error>> + Send {
        let inner = self.inner.clone();
        SharedPoll {
            inner,
            f: Box::new(|s, cx| {
                poll::Session::poll_accept_bi(s, cx)
                    .map(|r| r.map(|(send, recv)| (AsyncMockSend::new(send), AsyncMockRecv::new(recv))))
            }),
        }
    }

    fn open_bi(
        &self,
    ) -> impl Future<Output = Result<(Self::SendStream, Self::RecvStream), Self::Error>> + Send {
        let inner = self.inner.clone();
        SharedPoll {
            inner,
            f: Box::new(|s, cx| {
                poll::Session::poll_open_bi(s, cx)
                    .map(|r| r.map(|(send, recv)| (AsyncMockSend::new(send), AsyncMockRecv::new(recv))))
            }),
        }
    }

    fn open_uni(&self) -> impl Future<Output = Result<Self::SendStream, Self::Error>> + Send {
        let inner = self.inner.clone();
        SharedPoll {
            inner,
            f: Box::new(|s, cx| poll::Session::poll_open_uni(s, cx).map(|r| r.map(AsyncMockSend::new))),
        }
    }

    fn send_datagram(&self, payload: Bytes) -> Result<(), MockError> {
        let mut guard = self.inner.lock().unwrap();
        let mut cx = Context::from_waker(Waker::noop());
        match guard.poll_send_datagram(&mut cx, &payload) {
            Poll::Ready(res) => res,
            // The mock never blocks on datagrams; treat "no room" like the
            // network would: drop, best effort.
            Poll::Pending => Ok(()),
        }
    }

    fn recv_datagram(&self) -> impl Future<Output = Result<Bytes, Self::Error>> + Send {
        let inner = self.inner.clone();
        SharedPoll {
            inner,
            f: Box::new(poll::Session::poll_recv_datagram),
        }
    }

    fn max_datagram_size(&self) -> usize {
        let guard = self.inner.lock().unwrap();
        guard.max_datagram_size()
    }

    fn protocol(&self) -> Option<&str> {
        self.protocol
    }

    fn close(&self, code: u32, reason: &str) {
        let mut guard = self.inner.lock().unwrap();
        guard.close(code, reason);
    }

    fn closed(&self) -> impl Future<Output = Self::Error> + Send {
        let inner = self.inner.clone();
        SharedPoll {
            inner,
            f: Box::new(poll::Session::poll_closed),
        }
    }
}

/// The async-interface send half over a mock send stream.
pub struct AsyncMockSend {
    inner: MockSendStream,
}

impl AsyncMockSend {
    pub fn new(inner: MockSendStream) -> Self {
        Self { inner }
    }
}

impl SendStream for AsyncMockSend {
    type Error = MockError;

    async fn write(&mut self, buf: &[u8]) -> Result<usize, MockError> {
        // The mock's poll methods re-register their kio waiters on every
        // poll, so driving them through poll_fn is re-entrantly safe.
        futures_util::future::poll_fn(|cx| self.inner.poll_write(cx, buf)).await
    }

    fn set_priority(&mut self, order: u8) {
        self.inner.set_priority(order);
    }

    fn finish(&mut self) -> Result<(), MockError> {
        self.inner.finish()
    }

    fn reset(&mut self, code: u32) {
        self.inner.reset(code);
    }

    async fn closed(&mut self) -> Result<(), MockError> {
        futures_util::future::poll_fn(|cx| self.inner.poll_closed(cx)).await
    }
}

/// The async-interface receive half over a mock receive stream.
pub struct AsyncMockRecv {
    inner: MockRecvStream,
}

impl AsyncMockRecv {
    pub fn new(inner: MockRecvStream) -> Self {
        Self { inner }
    }
}

impl RecvStream for AsyncMockRecv {
    type Error = MockError;

    async fn read(&mut self, dst: &mut [u8]) -> Result<Option<usize>, MockError> {
        futures_util::future::poll_fn(|cx| self.inner.poll_read(cx, dst)).await
    }

    fn stop(&mut self, code: u32) {
        self.inner.stop(code);
    }

    async fn closed(&mut self) -> Result<(), MockError> {
        futures_util::future::poll_fn(|cx| self.inner.poll_closed(cx)).await
    }
}

//! Async `web_transport_trait::Session` (v0.4) over the h3/quinn
//! WebTransport server session — the exact session type
//! `h3_axum::WebTransportUpgrade::accept` yields on the production endpoint,
//! so this bridge is what the rebuilt SFU runs on.

use std::{
    sync::Arc,
    task::{Context, Poll},
};

use bytes::{Buf, Bytes};
use h3::error::{ConnectionError as H3ConnectionError, StreamError as H3StreamError};
use h3::quic::{BidiStream as _, RecvStream as _, SendStream as _, SendStreamUnframed as _};
use h3_quinn::Connection as H3Quinn;
use h3_webtransport::{
    server::{AcceptedBi, WebTransportSession},
    stream::{RecvStream as H3Recv, SendStream as H3Send},
};
use web_transport_trait as wt;

type Inner = WebTransportSession<H3Quinn, Bytes>;
type QSend = <H3Quinn as h3::quic::OpenStreams<Bytes>>::SendStream;
type QRecv = <H3Quinn as h3::quic::Connection<Bytes>>::RecvStream;
type Send = H3Send<QSend, Bytes>;
type Recv = H3Recv<QRecv, Bytes>;
type DatagramReader = h3_datagram::datagram_handler::DatagramReader<
    <H3Quinn as h3_datagram::quic_traits::DatagramConnectionExt<Bytes>>::RecvDatagramHandler,
>;

/// Conservative datagram size: h3 0.0.8 does not expose the negotiated
/// QUIC datagram size, so report a value that fits a 1280-byte path MTU.
const DATAGRAM_SIZE: usize = 1200;

/// The WebTransport session the MoQ server accepts on.
///
/// `WebTransportSession` is not `Clone`, so it lives behind an `Arc`; the
/// datagram reader is created once and shared (each call to
/// `datagram_reader()` would hand out another queue handle).
#[derive(Clone)]
pub struct Session {
    inner: Arc<Inner>,
    quic: quinn::Connection,
    dgram_reader: Arc<tokio::sync::Mutex<Option<DatagramReader>>>,
}

impl Session {
    pub fn new(session: Inner, quic: quinn::Connection) -> Self {
        Self {
            inner: Arc::new(session),
            quic,
            dgram_reader: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// The quinn connection underneath (kept so the axum layer can close it
    /// when the MoQ session ends, matching the production `/wt` handler).
    pub fn quic_connection(&self) -> &quinn::Connection {
        &self.quic
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("connection error: {0}")]
    Connection(String),
    #[error("stream error: {0}")]
    Stream(String),
    #[error("webtransport session closed")]
    Closed,
}

impl wt::Error for Error {
    fn session_error(&self) -> Option<(u32, String)> {
        match self {
            Error::Connection(msg) => Some((0, msg.clone())),
            Error::Closed => Some((0, "webtransport session closed".to_string())),
            Error::Stream(_) => None,
        }
    }

    fn stream_error(&self) -> Option<u32> {
        match self {
            Error::Stream(_) => Some(0),
            _ => None,
        }
    }
}

impl From<H3StreamError> for Error {
    fn from(err: H3StreamError) -> Self {
        if let H3StreamError::ConnectionError(conn) = &err {
            Error::Connection(conn.to_string())
        } else {
            Error::Stream(err.to_string())
        }
    }
}

impl From<H3ConnectionError> for Error {
    fn from(err: H3ConnectionError) -> Self {
        Error::Connection(err.to_string())
    }
}

impl From<h3::quic::StreamErrorIncoming> for Error {
    fn from(err: h3::quic::StreamErrorIncoming) -> Self {
        Error::Stream(err.to_string())
    }
}

/// DEBUG: name the failing operation; the error text itself comes from h3.
fn log_err<T: std::fmt::Display + Into<Error>>(op: &str, err: T) -> Error {
    tracing::warn!(%op, %err, "h3wt bridge error");
    err.into()
}

impl wt::Session for Session {
    type SendStream = SendStream;
    type RecvStream = RecvStream;
    type Error = Error;

    async fn accept_uni(&self) -> Result<RecvStream, Error> {
        match self
            .inner
            .accept_uni()
            .await
            .map_err(|e| log_err("accept_uni", e))?
        {
            Some((_id, stream)) => Ok(RecvStream::new(stream)),
            // None: the session's stream queue is drained for good.
            None => Err(Error::Closed),
        }
    }

    async fn accept_bi(&self) -> Result<(SendStream, RecvStream), Error> {
        let accepted = self
            .inner
            .accept_bi()
            .await
            .map_err(|e| log_err("accept_bi", e))?;
        match accepted {
            Some(AcceptedBi::BidiStream(_id, bidi)) => {
                let (send, recv) = bidi.split();
                Ok((SendStream::new(send), RecvStream::new(recv)))
            }
            // A plain h3 request inside the WebTransport session: the MoQ
            // clients never send one; failing is the honest answer.
            Some(AcceptedBi::Request(_request, _stream)) => Err(Error::Stream(
                "unexpected h3 request in webtransport session".into(),
            )),
            None => Err(Error::Closed),
        }
    }

    async fn open_bi(&self) -> Result<(SendStream, RecvStream), Error> {
        let session_id = self.inner.session_id();
        let bidi = self
            .inner
            .open_bi(session_id)
            .await
            .map_err(|e| log_err("open_bi", e))?;
        let (send, recv) = bidi.split();
        Ok((SendStream::new(send), RecvStream::new(recv)))
    }

    async fn open_uni(&self) -> Result<SendStream, Error> {
        let session_id = self.inner.session_id();
        let stream = self
            .inner
            .open_uni(session_id)
            .await
            .map_err(|e| log_err("open_uni", e))?;
        Ok(SendStream::new(stream))
    }

    fn send_datagram(&self, payload: Bytes) -> Result<(), Error> {
        let mut sender = self.inner.datagram_sender();
        sender
            .send_datagram(payload)
            .map_err(|err| Error::Stream(err.to_string()))
    }

    async fn recv_datagram(&self) -> Result<Bytes, Error> {
        let mut guard = self.dgram_reader.lock().await;
        let reader = guard.get_or_insert_with(|| self.inner.datagram_reader());
        let dgram = reader.read_datagram().await?;
        Ok(dgram.payload().clone())
    }

    fn max_datagram_size(&self) -> usize {
        DATAGRAM_SIZE
    }

    fn close(&self, code: u32, reason: &str) {
        // Close the whole QUIC connection: the production endpoint serves one
        // WebTransport session per connection.
        self.quic
            .close(quinn::VarInt::from_u32(code), reason.as_bytes());
    }

    async fn closed(&self) -> Error {
        let err = self.quic.closed().await;
        Error::Connection(err.to_string())
    }
}

/// Outgoing half of a WebTransport stream.
pub struct SendStream {
    inner: Send,
    /// The `closed()` watch: resolves as soon as the send side is terminal.
    /// h3-quinn exposes neither FIN acknowledgements nor the peer's
    /// STOP_SENDING, so terminal means "FIN sent" (the trait allows
    /// resolving when the FIN is sent if the transport cannot report
    /// acks) or "reset". The moq-tokio adapter interrupts this watch
    /// whenever a deferred finish or reset settles and recreates it, so
    /// the flag is re-read with fresh state each time a watch starts.
    terminal: bool,
}

impl SendStream {
    fn new(inner: Send) -> Self {
        Self {
            inner,
            terminal: false,
        }
    }
}

impl wt::SendStream for SendStream {
    type Error = Error;

    async fn write(&mut self, buf: &[u8]) -> Result<usize, Error> {
        let mut remaining: &[u8] = buf;
        loop {
            let n = futures_util::future::poll_fn(|cx| self.inner.poll_send(cx, &mut remaining))
                .await
                .map_err(|e| log_err("send_stream.write", e))?;
            if n > 0 {
                return Ok(n);
            }
            // h3 accepts zero bytes while waiting for capacity; retry.
        }
    }

    fn set_priority(&mut self, _order: u8) {
        // h3 0.0.8 cannot re-prioritize an already-open QUIC stream; see the
        // lib docs for the impact (MoQ importance degrades to FIFO).
    }

    fn finish(&mut self) -> Result<(), Error> {
        // h3's `poll_finish` sends the FIN synchronously (it calls quinn's
        // sync `SendStream::finish`), so one poll with a noop waker suffices
        // to make the peer see the FIN now.
        let waker = std::task::Waker::noop();
        let mut cx = Context::from_waker(waker);
        let fut = futures_util::future::poll_fn(|cx| self.inner.poll_finish(cx));
        match std::pin::pin!(fut).poll(&mut cx) {
            Poll::Ready(Ok(())) => {
                self.terminal = true;
                Ok(())
            }
            Poll::Ready(Err(err)) => Err(Error::from(err)),
            // A future h3 that makes finish genuinely async: the FIN is still
            // pending; report success and let `closed` settle it.
            Poll::Pending => Ok(()),
        }
    }

    fn reset(&mut self, code: u32) {
        self.terminal = true;
        self.inner.reset(code as u64);
    }

    async fn closed(&mut self) -> Result<(), Error> {
        if self.terminal {
            return Ok(());
        }
        // Not terminal yet, and h3-quinn cannot surface a FIN ack or the
        // peer's STOP_SENDING, so there is nothing to await. The
        // moq-tokio adapter interrupts this watch (a oneshot) when a
        // deferred finish or reset settles and recreates it, at which
        // point the flag is read again.
        std::future::pending::<()>().await;
        Ok(())
    }
}

/// Incoming half of a WebTransport stream.
pub struct RecvStream {
    inner: Recv,
    /// Chunk bytes not yet copied into a caller's buffer: h3 hands out whole
    /// chunks, reads may be smaller.
    pending: Bytes,
}

impl RecvStream {
    fn new(inner: Recv) -> Self {
        Self {
            inner,
            pending: Bytes::new(),
        }
    }
}

impl wt::RecvStream for RecvStream {
    type Error = Error;

    async fn read(&mut self, buf: &mut [u8]) -> Result<Option<usize>, Error> {
        if self.pending.is_empty() {
            match futures_util::future::poll_fn(|cx| self.inner.poll_data(cx))
                .await
                .map_err(|e| log_err("recv_stream.read", e))?
            {
                Some(chunk) => self.pending = chunk,
                None => return Ok(None),
            }
        }
        let n = self.pending.len().min(buf.len());
        buf[..n].copy_from_slice(&self.pending[..n]);
        self.pending.advance(n);
        Ok(Some(n))
    }

    fn stop(&mut self, code: u32) {
        self.inner.stop_sending(code as u64);
    }

    async fn closed(&mut self) -> Result<(), Error> {
        // The moq-tokio adapter never calls this (it emulates the closed
        // watch with reads), so chunks fetched while waiting for the FIN are
        // discarded.
        loop {
            match futures_util::future::poll_fn(|cx| self.inner.poll_data(cx)).await? {
                Some(_) => {}
                None => return Ok(()),
            }
        }
    }
}

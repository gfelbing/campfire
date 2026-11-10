//! Async `web_transport_trait::Session` (v0.4) over a `wtransport` client
//! connection — the tier-1 spike clients (no browser involved).

use std::future::Future;

use bytes::Bytes;
use web_transport_trait as wt;

/// The WebTransport client connection the MoQ client runs over.
#[derive(Clone)]
pub struct Session {
    conn: wtransport::Connection,
}

impl Session {
    pub fn new(conn: wtransport::Connection) -> Self {
        Self { conn }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("connection error: {0}")]
    Connection(String),
    #[error("stream error: {0}")]
    Stream(String),
}

impl wt::Error for Error {
    fn session_error(&self) -> Option<(u32, String)> {
        match self {
            Error::Connection(msg) => Some((0, msg.clone())),
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

impl From<wtransport::error::ConnectionError> for Error {
    fn from(err: wtransport::error::ConnectionError) -> Self {
        tracing::warn!(%err, "client_wt connection error");
        Error::Connection(err.to_string())
    }
}

impl From<wtransport::error::StreamOpeningError> for Error {
    fn from(err: wtransport::error::StreamOpeningError) -> Self {
        tracing::warn!(%err, "client_wt stream opening error");
        Error::Stream(err.to_string())
    }
}

/// DEBUG: name the failing operation; the error text comes from wtransport.
fn log_err<T: std::fmt::Display>(op: &str, err: T) -> Error {
    tracing::warn!(%op, %err, "client_wt bridge error");
    Error::Stream(err.to_string())
}

impl wt::Session for Session {
    type SendStream = SendStream;
    type RecvStream = RecvStream;
    type Error = Error;

    fn accept_uni(&self) -> impl Future<Output = Result<RecvStream, Error>> + wt::MaybeSend {
        async move {
            let stream = self.conn.accept_uni().await?;
            Ok(RecvStream::new(stream))
        }
    }

    fn accept_bi(
        &self,
    ) -> impl Future<Output = Result<(SendStream, RecvStream), Error>> + wt::MaybeSend {
        async move {
            let (send, recv) = self.conn.accept_bi().await?;
            Ok((SendStream::new(send), RecvStream::new(recv)))
        }
    }

    fn open_bi(
        &self,
    ) -> impl Future<Output = Result<(SendStream, RecvStream), Error>> + wt::MaybeSend {
        async move {
            // Two-stage open: wtransport's `OpeningBiStream` is not drop-safe,
            // but the moq-tokio adapter (which wraps this session) retains the
            // in-flight future, so a cancelled poll cannot strand a stream.
            let (send, recv) = self.conn.open_bi().await?.await?;
            Ok((SendStream::new(send), RecvStream::new(recv)))
        }
    }

    fn open_uni(&self) -> impl Future<Output = Result<SendStream, Error>> + wt::MaybeSend {
        async move {
            let send = self.conn.open_uni().await?.await?;
            Ok(SendStream::new(send))
        }
    }

    fn send_datagram(&self, payload: Bytes) -> Result<(), Error> {
        self.conn.send_datagram(&payload).map_err(|err| Error::Stream(err.to_string()))
    }

    fn recv_datagram(&self) -> impl Future<Output = Result<Bytes, Error>> + wt::MaybeSend {
        async move {
            let dgram = self.conn.receive_datagram().await?;
            Ok(dgram.payload())
        }
    }

    fn max_datagram_size(&self) -> usize {
        self.conn.max_datagram_size().unwrap_or(0)
    }

    fn close(&self, code: u32, reason: &str) {
        self.conn
            .close(wtransport::VarInt::from_u32(code), reason.as_bytes());
    }

    fn closed(&self) -> impl Future<Output = Error> + wt::MaybeSend {
        async move {
            let err = self.conn.closed().await;
            Error::Connection(err.to_string())
        }
    }
}

/// Outgoing half of a WebTransport stream.
pub struct SendStream {
    inner: wtransport::SendStream,
}

impl SendStream {
    fn new(inner: wtransport::SendStream) -> Self {
        Self { inner }
    }
}

impl wt::SendStream for SendStream {
    type Error = Error;

    fn write(&mut self, buf: &[u8]) -> impl Future<Output = Result<usize, Error>> + wt::MaybeSend {
        async move {
            let n = self
                .inner
                .write(buf)
                .await
                .map_err(|e| log_err("send_stream.write", e))?;
            Ok(n)
        }
    }

    fn set_priority(&mut self, order: u8) {
        self.inner.set_priority(order as i32);
    }

    fn finish(&mut self) -> Result<(), Error> {
        // quinn's `finish` is synchronous (it enqueues the FIN); the
        // wtransport wrapper hides it behind an async method the sync trait
        // slot cannot drive, so send it through the quinn handle.
        self.inner
            .quic_stream_mut()
            .finish()
            .map_err(|e| Error::Stream(e.to_string()))
    }

    fn reset(&mut self, code: u32) {
        let _ = self
            .inner
            .reset(wtransport::VarInt::from_u32(code));
    }

    fn closed(&mut self) -> impl Future<Output = Result<(), Error>> + wt::MaybeSend {
        // Resolves when the stream ends for any reason: our FIN is
        // acknowledged (quinn `stopped` yields `None`), the peer sends
        // STOP_SENDING (yields `Some(code)`), or the connection dies.
        async move {
            let quic = self.inner.quic_stream();
            match quic.stopped().await {
                Ok(None) => Ok(()),
                Ok(code) => Err(Error::Stream(format!(
                    "peer stop sending (code: {code:?})"
                ))),
                Err(err) => Err(Error::Stream(err.to_string())),
            }
        }
    }
}

/// Incoming half of a WebTransport stream.
pub struct RecvStream {
    inner: wtransport::RecvStream,
}

impl RecvStream {
    fn new(inner: wtransport::RecvStream) -> Self {
        Self { inner }
    }
}

impl wt::RecvStream for RecvStream {
    type Error = Error;

    fn read(
        &mut self,
        buf: &mut [u8],
    ) -> impl Future<Output = Result<Option<usize>, Error>> + wt::MaybeSend {
        async move {
            self.inner
                .read(buf)
                .await
                .map_err(|e| log_err("recv_stream.read", e))
        }
    }

    fn stop(&mut self, code: u32) {
        // `wtransport::RecvStream::stop` consumes the stream; send the
        // STOP_SENDING through the quinn handle instead.
        let _ = self.inner.quic_stream_mut().stop(quinn::VarInt::from_u32(code));
    }

    fn closed(&mut self) -> impl Future<Output = Result<(), Error>> + wt::MaybeSend {
        // The moq-tokio adapter never calls this (it emulates the closed
        // watch with reads), so chunks fetched while waiting for the FIN are
        // discarded.
        async move {
            let mut chunk = vec![0u8; 8192];
            loop {
                match self.inner.read(&mut chunk).await {
                    Ok(Some(_)) => {}
                    Ok(None) => return Ok(()),
                    Err(err) => return Err(Error::Stream(err.to_string())),
                }
            }
        }
    }
}

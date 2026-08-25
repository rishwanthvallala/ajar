//! The agent's connection to the relay, with reconnect.
//!
//! The agent always dials out. That is the whole reason there are no inbound
//! ports, no firewall rules and no NAT configuration to explain to anyone.
//!
//! The process survives the socket. Terminals keep running while we're
//! disconnected and their ring buffers keep filling, so a blip costs nothing
//! but the frames that would have been in flight.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ajar_proto::{Channel, Cipher, Control, Frame};
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;
use tracing::debug;

const BACKOFF_BASE: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(8);

#[derive(Debug)]
pub enum RelayEvent {
    /// Registered with the relay. `resumed` means the relay still had our
    /// session from before the drop, so guests never lost it.
    Connected {
        resumed: bool,
    },
    Disconnected(String),
    Frame(Frame),
    /// The relay refused us outright — a taken session id, say. Not retryable.
    Refused(String),
}

pub struct RelayHandle {
    /// Frames to put on the wire. Sends while disconnected are dropped, which
    /// is correct: the ring buffers already hold the terminal output a guest
    /// needs, and replaying it here would duplicate it.
    pub outbound: UnboundedSender<Frame>,
    pub events: UnboundedReceiver<RelayEvent>,
    shutdown: Arc<AtomicBool>,
}

impl RelayHandle {
    /// A handle that survives moving `events` out of this struct.
    pub fn shutdown_handle(&self) -> Shutdown {
        Shutdown(self.shutdown.clone())
    }
}

/// Stops the supervisor reconnecting. Trigger it after sending
/// `Control::Close`, or the agent will dial straight back in.
#[derive(Clone)]
pub struct Shutdown(Arc<AtomicBool>);

impl Shutdown {
    pub fn trigger(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// `cipher` seals everything on a content channel as it goes out and opens
/// it as it comes in. Doing it here, at the one place frames touch the
/// socket, is what keeps the rest of the agent unaware that it exists.
pub fn spawn(url: String, hello: Control, cipher: Cipher) -> RelayHandle {
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Frame>();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<RelayEvent>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let flag = shutdown.clone();

    tokio::spawn(async move {
        let mut attempt: u32 = 0;
        loop {
            if flag.load(Ordering::SeqCst) {
                return;
            }
            match session(&url, &hello, &cipher, &mut out_rx, &ev_tx).await {
                Ok(Outcome::Closed) => {
                    let _ = ev_tx.send(RelayEvent::Disconnected("relay closed".into()));
                }
                Ok(Outcome::Refused(msg)) => {
                    let _ = ev_tx.send(RelayEvent::Refused(msg));
                    return;
                }
                Err(e) => {
                    let _ = ev_tx.send(RelayEvent::Disconnected(e.to_string()));
                }
            }
            if flag.load(Ordering::SeqCst) {
                return;
            }
            let delay = BACKOFF_BASE
                .saturating_mul(2u32.saturating_pow(attempt))
                .min(BACKOFF_MAX);
            attempt = attempt.saturating_add(1);
            drain_for(&mut out_rx, delay).await;
        }
    });

    RelayHandle {
        outbound: out_tx,
        events: ev_rx,
        shutdown,
    }
}

enum Outcome {
    Closed,
    Refused(String),
}

async fn session(
    url: &str,
    hello: &Control,
    cipher: &Cipher,
    out_rx: &mut UnboundedReceiver<Frame>,
    ev_tx: &UnboundedSender<RelayEvent>,
) -> Result<Outcome> {
    let (stream, response) = tokio_tungstenite::connect_async(url)
        .await
        .with_context(|| format!("connecting to relay at {url}"))?;
    debug!("relay handshake: {}", response.status());
    let (mut sink, mut source) = stream.split();

    sink.send(Message::Binary(
        Frame::json(Channel::Control, ajar_proto::TARGET_ALL, hello)?
            .encode()
            .into(),
    ))
    .await?;

    // The relay answers a hello with welcome or error. Anything else means
    // we are not talking to a relay.
    let welcome = loop {
        match source.next().await {
            Some(Ok(Message::Binary(b))) => match Frame::decode(&b) {
                Ok(f) if f.channel == Channel::Control => break f,
                Ok(_) => return Err(anyhow!("relay sent a non-control frame before welcome")),
                Err(e) => debug!("dropping malformed frame during handshake: {e}"),
            },
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e.into()),
            None => return Err(anyhow!("relay closed during handshake")),
        }
    };

    let resumed = match welcome.parse_json::<Control>()? {
        Control::Welcome { participants, .. } => participants.len() > 1,
        Control::Error { code, message } => {
            return Ok(Outcome::Refused(format!("{code}: {message}")))
        }
        other => return Err(anyhow!("unexpected first message from relay: {other:?}")),
    };
    let _ = ev_tx.send(RelayEvent::Connected { resumed });

    loop {
        tokio::select! {
            outgoing = out_rx.recv() => {
                let Some(frame) = outgoing else { return Ok(Outcome::Closed) };
                let bytes = frame.seal(cipher).encode();
                if sink.send(Message::Binary(bytes.into())).await.is_err() {
                    return Ok(Outcome::Closed);
                }
            }
            incoming = source.next() => {
                match incoming {
                    Some(Ok(Message::Binary(b))) => match Frame::decode(&b) {
                        Ok(f) => match f.open(cipher) {
                            Ok(f) => {
                                if ev_tx.send(RelayEvent::Frame(f)).is_err() {
                                    return Ok(Outcome::Closed);
                                }
                            }
                            // Wrong key, or a frame that was interfered with.
                            // Neither is worth guessing at.
                            Err(e) => debug!("dropping unreadable frame: {e}"),
                        },
                        Err(e) => debug!("dropping malformed frame: {e}"),
                    },
                    Some(Ok(Message::Close(_))) | None => return Ok(Outcome::Closed),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.into()),
                }
            }
        }
    }
}

/// Wait out the backoff while throwing away anything the app tries to send.
/// Terminal output produced during a disconnect lives in the ring buffers;
/// queueing it here would only replay it twice.
async fn drain_for(out_rx: &mut UnboundedReceiver<Frame>, delay: Duration) {
    let deadline = tokio::time::sleep(delay);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return,
            dropped = out_rx.recv() => {
                if dropped.is_none() {
                    return;
                }
            }
        }
    }
}

/// Turns `http(s)://host` or `ws(s)://host` into the websocket endpoint.
pub fn ws_url(base: &str) -> Result<String> {
    let base = base.trim_end_matches('/');
    let url = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if base.starts_with("ws://") || base.starts_with("wss://") {
        base.to_string()
    } else {
        return Err(anyhow!(
            "relay address must start with http://, https://, ws:// or wss://"
        ));
    };
    Ok(format!("{url}/ws"))
}

/// The address a guest opens in a browser.
pub fn join_url(base: &str, session: &str) -> String {
    format!("{}/j/{session}", base.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_http_schemes() {
        assert_eq!(
            ws_url("http://localhost:8787").unwrap(),
            "ws://localhost:8787/ws"
        );
        assert_eq!(ws_url("https://ajar.sh/").unwrap(), "wss://ajar.sh/ws");
        assert_eq!(ws_url("wss://ajar.sh").unwrap(), "wss://ajar.sh/ws");
    }

    #[test]
    fn rejects_a_bare_host() {
        assert!(ws_url("ajar.sh").is_err());
    }

    #[test]
    fn builds_the_join_url() {
        assert_eq!(
            join_url("https://ajar.sh/", "quiet-ember-4417"),
            "https://ajar.sh/j/quiet-ember-4417"
        );
    }

    #[tokio::test]
    async fn draining_discards_instead_of_queueing() {
        let (tx, mut rx) = mpsc::unbounded_channel::<Frame>();
        for _ in 0..100 {
            tx.send(Frame::stream(Channel::Pty, 1, 0, b"noise".to_vec()))
                .unwrap();
        }
        drain_for(&mut rx, Duration::from_millis(30)).await;
        assert!(rx.try_recv().is_err(), "backoff should not leave a backlog");
    }

    #[test]
    fn backoff_is_bounded() {
        for attempt in 0u32..40 {
            let d = BACKOFF_BASE
                .saturating_mul(2u32.saturating_pow(attempt))
                .min(BACKOFF_MAX);
            assert!(d <= BACKOFF_MAX, "attempt {attempt} produced {d:?}");
        }
    }
}

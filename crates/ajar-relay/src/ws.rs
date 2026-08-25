//! Socket handling and the whole of the routing layer.
//!
//! The relay parses the 9-byte header and nothing else. Payloads are opaque
//! bytes it forwards without inspection — the one exception is the `Hello`
//! handshake, which it must read to know where a socket belongs.

use std::sync::Arc;

use ajar_proto::{Channel, Control, Frame, Participant, Role, Store, SNAPSHOT_STREAM, TARGET_ALL};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tracing::{debug, info, warn};

use crate::outbox::{self, Outbox};
use crate::quota::Quota;
use crate::session::{HostExit, JoinError, Registry, HOST_GRACE};

pub async fn handle(
    socket: WebSocket,
    registry: Arc<Registry>,
    quota: Arc<Quota>,
    caller: std::net::IpAddr,
) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = outbox::channel();

    // Everything written to this socket goes through one task, so the routing
    // side never blocks on a slow reader. The queue behind it is bounded:
    // `next` returns `None` once this connection has fallen too far behind,
    // which ends the task and closes the socket.
    let writer = tokio::spawn(async move {
        while let Some(bytes) = rx.next().await {
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // ---- handshake ------------------------------------------------------
    //
    // Refusals go out through the writer task, so it has to be allowed to
    // drain before the socket goes away. Aborting it here — which is what
    // this used to do — threw the explanation away and every refusal looked
    // like a timeout to whoever was trying to join.
    macro_rules! refuse {
        ($code:expr, $message:expr) => {{
            send_error(&tx, $code, $message);
            drop(tx);
            let _ = writer.await;
            return;
        }};
    }

    let hello = match next_frame(&mut stream).await {
        Some(f) => f,
        None => {
            writer.abort();
            return;
        }
    };

    let (session_id, role) = match hello.parse_json::<Control>() {
        Ok(Control::Hello { session, role }) => (session, role),
        _ => refuse!("expected_hello", "first frame must be a hello"),
    };

    // Only opening a session is metered. Joining one costs an address
    // nothing: a guest already needs the link, and rationing the people a
    // host invited would be limiting the wrong side.
    // Held for the life of this connection; releases on every exit path,
    // including the refusals below.
    let _slot = if role == Role::Host {
        match quota.claim(caller, std::time::Instant::now()) {
            Ok(slot) => Some(slot),
            Err(denied) => {
                warn!(%caller, "refused: {}", denied.message());
                refuse!("rate_limited", denied.message());
            }
        }
    } else {
        None
    };

    let joined = match role {
        Role::Host => registry.open(&session_id, tx.clone()),
        Role::Guest => registry.join(&session_id, tx.clone()).map(|p| (p, false)),
    };

    let (me, resumed): (Participant, bool) = match joined {
        Ok(pair) => pair,
        Err(JoinError::HostTaken) => refuse!("host_taken", "this session already has a host"),
        Err(JoinError::NoSuchSession) => {
            refuse!("no_such_session", "no open session with that id")
        }
        Err(JoinError::Locked) => refuse!("locked", "the host has locked this session"),
    };

    info!(session = %session_id, participant = me.id, role = ?me.role, "joined");

    let participants = registry
        .with(&session_id, |s| s.participants())
        .unwrap_or_else(|| vec![me.clone()]);

    send_control(
        &tx,
        &Control::Welcome {
            participant_id: me.id,
            participants,
        },
    );

    match me.role {
        Role::Guest => {
            // Membership is a relay-level notice, not guest-to-guest traffic:
            // the routing rules still forbid guests addressing each other,
            // but everyone needs to know who is in the room.
            let joined = Control::Joined {
                participant: me.clone(),
            };
            if let Ok(f) = Frame::json(Channel::Control, TARGET_ALL, &joined) {
                let bytes = f.encode();
                registry.with(&session_id, |s| {
                    s.send_host(&bytes);
                    for (id, c) in &s.guests {
                        if *id != me.id {
                            let _ = c.tx.send(bytes.clone());
                        }
                    }
                });
            }
        }
        Role::Host if resumed => {
            info!(session = %session_id, "host resumed inside its grace period");
            if let Ok(f) = Frame::json(Channel::Control, TARGET_ALL, &Control::HostBack) {
                let bytes = f.encode();
                registry.with(&session_id, |s| s.send_all_guests(&bytes));
            }
        }
        Role::Host => {}
    }

    // ---- routing --------------------------------------------------------
    // Ctrl-C on the agent sends `Close`. Anything else that ends the host's
    // socket is a blip, and the session waits for it.
    let mut host_exit = HostExit::Dropped;
    // Set between an accepted offer and the blob that follows it.
    let mut expecting: Option<u32> = None;

    while let Some(frame) = next_frame(&mut stream).await {
        // The host may address one guest or broadcast; a guest may only
        // reach the host. Four cells, and it stays four cells.
        match me.role {
            Role::Guest => {
                if frame.target != TARGET_ALL {
                    debug!("guest tried to address a participant directly; dropped");
                    continue;
                }
                // A guest asking for the stored copy is answered by the
                // relay, not forwarded — the host may not be there.
                if frame.channel == Channel::Store {
                    if matches!(frame.parse_json::<Store>(), Ok(Store::Fetch)) {
                        match registry.snapshot(&session_id) {
                            Some((sealed, files)) => {
                                send_json(
                                    &tx,
                                    Channel::Store,
                                    &Store::Snapshot {
                                        bytes: sealed.len() as u64,
                                        files,
                                    },
                                );
                                let _ = tx.send(
                                    Frame::stream(Channel::Store, SNAPSHOT_STREAM, me.id, sealed)
                                        .encode(),
                                );
                            }
                            None => send_json(&tx, Channel::Store, &Store::Empty),
                        }
                    }
                    continue;
                }
                // Stamp the sender so the host knows who asked.
                let stamped =
                    Frame::new(frame.channel, frame.stream_id, me.id, frame.payload).encode();
                registry.with(&session_id, |s| s.send_host(&stamped));
            }
            Role::Host if frame.channel == Channel::Store => {
                if frame.stream_id == SNAPSHOT_STREAM {
                    // The blob for the offer we just accepted. Anything not
                    // announced is dropped rather than trusted.
                    match expecting.take() {
                        Some(files) => registry.put_snapshot(&session_id, frame.payload, files),
                        None => debug!("unannounced snapshot blob; dropped"),
                    }
                    continue;
                }
                match frame.parse_json::<Store>() {
                    Ok(Store::Offer { bytes, files }) => {
                        match registry.offer_snapshot(&session_id, bytes, files) {
                            Ok(()) => {
                                expecting = Some(files);
                                send_json(&tx, Channel::Store, &Store::Accepted);
                            }
                            Err(reason) => {
                                expecting = None;
                                send_json(&tx, Channel::Store, &Store::Rejected { reason });
                            }
                        }
                    }
                    // Sync switched off: forget what we were holding.
                    Ok(Store::Empty) => registry.clear_snapshot(&session_id),
                    _ => {}
                }
                continue;
            }
            Role::Host => {
                if let Channel::Control = frame.channel {
                    match frame.parse_json::<Control>() {
                        Ok(Control::Kick { participant_id }) => {
                            kick(&registry, &session_id, participant_id);
                            continue;
                        }
                        Ok(Control::Close) => {
                            host_exit = HostExit::Deliberate;
                            break;
                        }
                        Ok(Control::Lock { locked }) => {
                            registry.set_locked(&session_id, locked);
                            info!(session = %session_id, locked, "lock changed");
                            if let Ok(f) = Frame::json(
                                Channel::Control,
                                TARGET_ALL,
                                &Control::Locked { locked },
                            ) {
                                let bytes = f.encode();
                                registry.with(&session_id, |s| s.send_all_guests(&bytes));
                            }
                            continue;
                        }
                        _ => {}
                    }
                }
                let bytes = frame.encode();
                registry.with(&session_id, |s| {
                    if frame.target == TARGET_ALL {
                        s.send_all_guests(&bytes);
                    } else {
                        s.send_one(frame.target, &bytes);
                    }
                });
            }
        }
    }

    // ---- teardown -------------------------------------------------------
    match me.role {
        Role::Host => {
            let notice = match host_exit {
                HostExit::Deliberate => Control::Closed {
                    reason: "the host closed this session".into(),
                },
                HostExit::Dropped => Control::HostAway {
                    grace_secs: HOST_GRACE.as_secs(),
                },
            };
            let bytes = Frame::json(Channel::Control, TARGET_ALL, &notice)
                .map(|f| f.encode())
                .unwrap_or_default();
            registry.host_gone(&session_id, host_exit, &bytes);
            match host_exit {
                HostExit::Deliberate => info!(session = %session_id, "session closed"),
                HostExit::Dropped => {
                    info!(session = %session_id, grace = ?HOST_GRACE, "host away, holding")
                }
            }
        }
        Role::Guest => {
            registry.drop_guest(&session_id, me.id);
            let left = Control::Left {
                participant_id: me.id,
            };
            if let Ok(f) = Frame::json(Channel::Control, TARGET_ALL, &left) {
                let bytes = f.encode();
                registry.with(&session_id, |s| {
                    s.send_host(&bytes);
                    s.send_all_guests(&bytes);
                });
            }
        }
    }

    writer.abort();
}

fn kick(registry: &Registry, session_id: &str, participant_id: u32) {
    let closed = Control::Closed {
        reason: "removed by the host".into(),
    };
    if let Ok(f) = Frame::json(Channel::Control, TARGET_ALL, &closed) {
        registry.with(session_id, |s| s.send_one(participant_id, &f.encode()));
    }
    registry.drop_guest(session_id, participant_id);
    warn!(session = %session_id, participant_id, "kicked");
}

async fn next_frame(stream: &mut futures_util::stream::SplitStream<WebSocket>) -> Option<Frame> {
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(b) => match Frame::decode(&b) {
                Ok(f) => return Some(f),
                Err(e) => {
                    debug!("bad frame: {e}");
                    continue;
                }
            },
            Message::Close(_) => return None,
            _ => continue,
        }
    }
    None
}

fn send_control(tx: &Outbox, msg: &Control) {
    if let Ok(f) = Frame::json(Channel::Control, TARGET_ALL, msg) {
        let _ = tx.send(f.encode());
    }
}

fn send_json<T: serde::Serialize>(tx: &Outbox, channel: Channel, msg: &T) {
    if let Ok(f) = Frame::json(channel, TARGET_ALL, msg) {
        let _ = tx.send(f.encode());
    }
}

fn send_error(tx: &Outbox, code: &str, message: &str) {
    send_control(
        tx,
        &Control::Error {
            code: code.into(),
            message: message.into(),
        },
    );
}

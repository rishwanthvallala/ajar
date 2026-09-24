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
use crate::quota::Kind;
use crate::quota::Quota;
use crate::session::{HostExit, JoinError, Registry, HOST_GRACE, MAX_SNAPSHOT_BYTES};

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

    let (session_id, role, locked, protocol) = match hello.parse_json::<Control>() {
        Ok(Control::Hello {
            session,
            role,
            locked,
            protocol,
        }) => (session, role, locked, protocol),
        _ => refuse!("expected_hello", "first frame must be a hello"),
    };

    // Every connection is charged to something. It used to be only the
    // ones that *created* a session — guests were exempt outright and peers
    // were exempt whenever the name already existed, which is every pad after
    // the first visit. One address could therefore hold unlimited sockets, each
    // with an 8 MiB outbox allowance, and the quota never saw them.
    //
    // Creating a peer session costs the same as opening a hosted one, since
    // both mint a name nobody had. Two peers racing to create the same name
    // will both be metered; over-counting by one is not worth a lock here.
    let kind = match role {
        Role::Host => Kind::Open,
        Role::Peer if !registry.exists(&session_id) => Kind::Open,
        _ => Kind::Join,
    };
    // Held for the life of this connection; releases on every exit path,
    // including the refusals below.
    let _slot = match quota.claim(caller, std::time::Instant::now(), kind) {
        Ok(slot) => slot,
        Err(denied) => {
            warn!(%caller, ?kind, "refused: {}", denied.message());
            refuse!("rate_limited", denied.message());
        }
    };

    let joined = match role {
        Role::Host => registry.open_locked(&session_id, tx.clone(), locked, protocol),
        Role::Guest => registry.join(&session_id, tx.clone()).map(|p| (p, false)),
        // A peer never "resumes": there is no agent whose absence it could
        // be waiting out.
        Role::Peer => registry
            .join_peer(&session_id, tx.clone())
            .map(|(p, _created)| (p, false)),
    };

    let (me, resumed): (Participant, bool) = match joined {
        Ok(pair) => pair,
        Err(JoinError::HostTaken) => refuse!("host_taken", "this session already has a host"),
        Err(JoinError::NoSuchSession) => {
            refuse!("no_such_session", "no open session with that id")
        }
        Err(JoinError::Locked) => refuse!("locked", "the host has locked this session"),
        Err(JoinError::WrongShape) => refuse!(
            "wrong_shape",
            "that name belongs to a different kind of session"
        ),
    };

    info!(session = %session_id, participant = me.id, role = ?me.role, "joined");

    let participants = registry
        .with(&session_id, |s| s.participants())
        .unwrap_or_else(|| vec![me.clone()]);

    // What the host speaks, so a guest can tell the difference between a quiet
    // session and one where nothing it sends can be decrypted. Read from the
    // session rather than this connection: for a guest the relevant version is
    // the host's, and for the host it is simply its own coming back.
    let host_protocol = registry
        .with(&session_id, |s| s.host_protocol)
        .unwrap_or(ajar_proto::PROTOCOL_UNVERSIONED);

    send_control(
        &tx,
        &Control::Welcome {
            participant_id: me.id,
            participants,
            host_protocol,
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
        Role::Peer => {
            // Everyone already in the room hears about the arrival. Unlike a
            // hosted session there is nobody to tell separately.
            let joined = Control::Joined {
                participant: me.clone(),
            };
            if let Ok(f) = Frame::json(Channel::Control, TARGET_ALL, &joined) {
                let bytes = f.encode();
                registry.with(&session_id, |s| s.send_others(me.id, &bytes));
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
    let mut expecting: Option<(u64, u32)> = None;

    while let Some(frame) = next_frame(&mut stream).await {
        if !registry.contains_participant(&session_id, &me) {
            debug!(
                participant = me.id,
                "frame from a removed participant; closing socket"
            );
            break;
        }
        // Two shapes, and the rules differ because the topologies do.
        //
        // Hosted: the host may address one guest or broadcast; a guest may
        // only reach the host. Guests cannot reach each other, which removes
        // a whole class of question about what one guest can do to another.
        //
        // Peer: everyone reaches everyone else, always by broadcast. That is
        // not a relaxation of the rule above but a different room — there is
        // no machine at the centre to protect, and the participants are
        // already editing one shared folder.
        match me.role {
            Role::Guest => {
                // Control messages are relay authority. Guests never need to
                // originate one after the handshake, and forwarding malformed
                // cleartext control to the agent used to terminate the host.
                if frame.channel == Channel::Control {
                    debug!("guest control frame dropped");
                    continue;
                }
                if frame.channel.is_encrypted() && frame.target != me.id {
                    debug!(
                        "guest sent encrypted content without its authenticated sender id; dropped"
                    );
                    continue;
                }
                if !frame.channel.is_encrypted() && frame.target != TARGET_ALL {
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
                // Encrypted frames already carry the sender in authenticated
                // routing metadata. Rewriting it here would invalidate them.
                //
                // Note what this costs: nothing stamps a guest's *unencrypted*
                // frames any more, so control and store traffic reaches the
                // host with `target` still 0 rather than the sender's id.
                // Nothing reads it there today — every `frame.target` on the
                // host sits on pty, fs, doc or presence — but a handler added
                // later will get 0 and no hint as to why.
                registry.with(&session_id, |s| s.send_host(&frame.encode()));
            }
            Role::Peer => {
                if frame.channel == Channel::Control {
                    debug!("peer control frame dropped");
                    continue;
                }
                // Same rule a guest follows — you may only speak as yourself,
                // so the id cannot be forged and, on channels that seal their
                // header, cannot be rewritten by us either. What differs is
                // where it lands: a guest reaches the host, a peer reaches
                // everyone else at once.
                //
                // Peers therefore broadcast and never address one another
                // directly. Bringing a newcomer up to date is a broadcast
                // too, which is how the CRDT layer does it anyway.
                if frame.target != me.id {
                    debug!("peer frame not stamped with its own id; dropped");
                    continue;
                }
                let bytes = frame.encode();
                registry.with(&session_id, |s| s.send_others(me.id, &bytes));
            }
            Role::Host if frame.channel == Channel::Store => {
                if frame.stream_id == SNAPSHOT_STREAM {
                    // The blob for the offer we just accepted. Anything not
                    // announced is dropped rather than trusted.
                    match expecting.take() {
                        Some((bytes, files))
                            if bytes <= MAX_SNAPSHOT_BYTES
                                && frame.payload.len() as u64 == bytes =>
                        {
                            registry.put_snapshot(&session_id, frame.payload, files)
                        }
                        Some((bytes, _)) => warn!(
                            session = %session_id,
                            advertised = bytes,
                            actual = frame.payload.len(),
                            "snapshot blob did not match its accepted offer; dropped"
                        ),
                        None => debug!("unannounced snapshot blob; dropped"),
                    }
                    continue;
                }
                match frame.parse_json::<Store>() {
                    Ok(Store::Offer { bytes, files }) => {
                        match registry.offer_snapshot(&session_id, bytes, files) {
                            Ok(()) => {
                                expecting = Some((bytes, files));
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
        Role::Peer => {
            // Told before the drop, so the leaver is still in the map to be
            // excluded rather than sent their own departure.
            let left = Control::Left {
                participant_id: me.id,
            };
            if let Ok(f) = Frame::json(Channel::Control, TARGET_ALL, &left) {
                let bytes = f.encode();
                registry.with(&session_id, |s| s.send_others(me.id, &bytes));
            }
            registry.drop_peer(&session_id, me.id);
        }
    }

    writer.abort();
}

fn kick(registry: &Registry, session_id: &str, participant_id: u32) {
    let closed = Control::Closed {
        reason: "removed by the host".into(),
    };
    if let Ok(f) = Frame::json(Channel::Control, TARGET_ALL, &closed) {
        registry.kick_guest(session_id, participant_id, f.encode());
    } else {
        registry.drop_guest(session_id, participant_id);
    }
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

//! The relay's entire state: a map from session id to who is connected.
//!
//! Deliberately in-memory. Nothing here persists, so a relay restart dropping
//! every session is correct rather than merely acceptable — a hosted session's
//! agent reconnects and rebuilds it, and a peer session's files were never
//! kept here in the first place.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use ajar_proto::{Participant, Role};
use dashmap::DashMap;

/// How long a session survives its host's socket dropping. Terminals keep
/// running the whole time — the agent process never noticed. Long enough to
/// cover a wifi handover or a laptop lid, short enough that an abandoned
/// session doesn't linger.
pub const HOST_GRACE: Duration = Duration::from_secs(45);

/// The sending half of a connection's bounded queue. Sends can fail — a
/// socket that has fallen too far behind is closed rather than fed a lossy
/// stream. Call sites ignore the result because the writer task tears the
/// connection down on their behalf.
pub type Tx = crate::outbox::Outbox;

pub struct Conn {
    pub participant: Participant,
    pub tx: Tx,
}

/// Two axes, because they cost different things. Bytes are storage; file
/// count is what the tree, the watcher and the sync engine all pay for. A
/// repository of thirty thousand tiny files is far more expensive to us than
/// one fifty-megabyte video.
pub const MAX_SNAPSHOT_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_SNAPSHOT_FILES: u32 = 5_000;

/// The sealed copy of a workspace, kept so guests can still read it while the
/// host is away. Ciphertext: the relay has no key.
pub struct Snapshot {
    pub sealed: Vec<u8>,
    pub files: u32,
}

/// What kind of session this id holds.
///
/// Fixed when the session is created and never changes. The two shapes have
/// different routing rules and different lifetimes, and a session that could
/// be both would need every call site to ask which it is today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// An agent and its guests. Dies with the agent, after a grace period.
    Hosted,
    /// N browsers, no centre. Dies when the last one leaves — the files it
    /// was editing live in the durable store, not here.
    Peer,
}

pub struct Session {
    pub shape: Shape,
    pub host: Option<Conn>,
    /// Latest sealed snapshot, if the host is syncing one.
    pub snapshot: Option<Snapshot>,
    /// Set when the host's socket drops without a deliberate close.
    pub host_left_at: Option<Instant>,
    pub guests: HashMap<u32, Conn>,
    /// Sealed by the host. New guests are refused; existing ones stay.
    pub locked: bool,
    /// What the host speaks, from its handshake. Relayed to each guest so a
    /// version mismatch can be reported rather than felt.
    pub host_protocol: u32,
    next_id: u32,
}

impl Session {
    fn new(shape: Shape) -> Self {
        Self {
            shape,
            host: None,
            snapshot: None,
            host_left_at: None,
            guests: HashMap::new(),
            locked: false,
            host_protocol: ajar_proto::PROTOCOL_UNVERSIONED,
            // In a hosted session 1 is reserved for the host, so guests start
            // at 2. A peer session has no reserved id and starts at 1 — but
            // never at 0, which is TARGET_ALL on the wire.
            next_id: match shape {
                Shape::Hosted => 2,
                Shape::Peer => 1,
            },
        }
    }

    fn take_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn participants(&self) -> Vec<Participant> {
        self.host
            .iter()
            .map(|c| c.participant.clone())
            .chain(self.guests.values().map(|c| c.participant.clone()))
            .collect()
    }

    pub fn send_all_guests(&self, bytes: &[u8]) {
        for c in self.guests.values() {
            let _ = c.tx.send(bytes.to_vec());
        }
    }

    pub fn send_host(&self, bytes: &[u8]) {
        if let Some(h) = &self.host {
            let _ = h.tx.send(bytes.to_vec());
        }
    }

    /// Everyone except one participant. The sender of a broadcast does not
    /// need their own frame back, and echoing it would make a CRDT update
    /// look like a second edit.
    pub fn send_others(&self, except: u32, bytes: &[u8]) {
        for (id, c) in &self.guests {
            if *id != except {
                let _ = c.tx.send(bytes.to_vec());
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.host.is_none() && self.guests.is_empty()
    }

    pub fn send_one(&self, id: u32, bytes: &[u8]) {
        if let Some(c) = self.guests.get(&id) {
            let _ = c.tx.send(bytes.to_vec());
        } else if let Some(h) = &self.host {
            if h.participant.id == id {
                let _ = h.tx.send(bytes.to_vec());
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum JoinError {
    /// A second socket claimed to be the host while one is already connected.
    HostTaken,
    /// A guest asked for a session that no host has opened.
    NoSuchSession,
    /// The host sealed the room.
    Locked,
    /// Joining a hosted session as a peer, or the reverse. One session id is
    /// one shape for its whole life.
    WrongShape,
}

/// Why a host's socket ended, which decides whether the session survives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostExit {
    /// Ctrl-C, or an explicit close message. Ends the session now.
    Deliberate,
    /// The socket dropped. Starts the grace period.
    Dropped,
}

#[derive(Default)]
pub struct Registry {
    sessions: DashMap<String, Session>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    /// A host opening a session, or re-opening one whose socket dropped
    /// inside the grace period.
    #[cfg(test)]
    pub fn open(&self, id: &str, tx: Tx) -> Result<(Participant, bool), JoinError> {
        self.open_locked(id, tx, false, ajar_proto::PROTOCOL_VERSION)
    }

    /// Open while atomically restoring the host's current admission state.
    pub fn open_locked(
        &self,
        id: &str,
        tx: Tx,
        locked: bool,
        protocol: u32,
    ) -> Result<(Participant, bool), JoinError> {
        let mut entry = self
            .sessions
            .entry(id.to_string())
            .or_insert_with(|| Session::new(Shape::Hosted));
        if entry.shape != Shape::Hosted {
            return Err(JoinError::WrongShape);
        }
        if entry.host.is_some() {
            return Err(JoinError::HostTaken);
        }
        let resumed = entry.host_left_at.take().is_some();
        // The agent supplies this on every handshake. That restores the
        // admission boundary after a relay restart, before any guest can race
        // through a later Lock control frame.
        entry.locked = locked;
        // Recorded on every handshake for the same reason as the lock: after a
        // relay restart a guest must still learn which version it is talking to.
        entry.host_protocol = protocol;
        let participant = Participant {
            id: 1,
            role: Role::Host,
        };
        entry.host = Some(Conn {
            participant: participant.clone(),
            tx,
        });
        Ok((participant, resumed))
    }

    /// A guest joining. Allowed while the host is away — they will see the
    /// away state and their terminals reattach when it returns.
    pub fn join(&self, id: &str, tx: Tx) -> Result<Participant, JoinError> {
        let mut entry = self.sessions.get_mut(id).ok_or(JoinError::NoSuchSession)?;
        if entry.shape != Shape::Hosted {
            return Err(JoinError::WrongShape);
        }
        if entry.locked {
            return Err(JoinError::Locked);
        }
        let pid = entry.take_id();
        let participant = Participant {
            id: pid,
            role: Role::Guest,
        };
        entry.guests.insert(
            pid,
            Conn {
                participant: participant.clone(),
                tx,
            },
        );
        Ok(participant)
    }

    /// A browser joining a peer session, creating it if this is the first one.
    ///
    /// Unlike `join`, there is no "no such session" — a name nobody is using
    /// is a name you can start using, which is what makes opening a bare URL
    /// work. Returns whether this call created it, so the caller can meter
    /// creation without metering arrival.
    ///
    /// Nothing here checks whether the caller may *write* to the folder that
    /// name refers to. That is the durable store's business: the relay routes
    /// frames and has never known what they mean.
    pub fn join_peer(&self, id: &str, tx: Tx) -> Result<(Participant, bool), JoinError> {
        let mut created = false;
        let mut entry = self.sessions.entry(id.to_string()).or_insert_with(|| {
            created = true;
            Session::new(Shape::Peer)
        });
        if entry.shape != Shape::Peer {
            return Err(JoinError::WrongShape);
        }
        let pid = entry.take_id();
        let participant = Participant {
            id: pid,
            role: Role::Peer,
        };
        entry.guests.insert(
            pid,
            Conn {
                participant: participant.clone(),
                tx,
            },
        );
        Ok((participant, created))
    }

    /// True when this id is already in use, whatever its shape.
    pub fn exists(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    /// A peer left. The session goes when the last one does — there is no
    /// grace period, because there is nothing running to come back to and the
    /// files are not kept here.
    pub fn drop_peer(&self, id: &str, pid: u32) {
        let empty = match self.sessions.get_mut(id) {
            Some(mut s) => {
                s.guests.remove(&pid);
                s.is_empty()
            }
            None => return,
        };
        if empty {
            self.sessions.remove(id);
        }
    }

    pub fn with<R>(&self, id: &str, f: impl FnOnce(&Session) -> R) -> Option<R> {
        self.sessions.get(id).map(|s| f(&s))
    }

    /// Whether this socket still owns a participant entry. Kicking removes
    /// that entry first; the next frame from the old socket then closes it
    /// without granting one last action.
    pub fn contains_participant(&self, id: &str, participant: &Participant) -> bool {
        self.sessions
            .get(id)
            .is_some_and(|s| match participant.role {
                Role::Host => s
                    .host
                    .as_ref()
                    .is_some_and(|h| h.participant.id == participant.id),
                Role::Guest | Role::Peer => s.guests.contains_key(&participant.id),
            })
    }

    /// Seal or unseal a session. Returns the new state, or `None` if the
    /// session has gone.
    pub fn set_locked(&self, id: &str, locked: bool) -> Option<bool> {
        let mut s = self.sessions.get_mut(id)?;
        s.locked = locked;
        Some(locked)
    }

    /// Accept a sealed snapshot, or say why not.
    ///
    /// Refusing loudly matters more than it looks: a store that silently kept
    /// the first 25MB would hand guests a workspace that is quietly missing
    /// files, which is worse than having none at all.
    pub fn offer_snapshot(&self, id: &str, bytes: u64, files: u32) -> Result<(), String> {
        if bytes > MAX_SNAPSHOT_BYTES {
            return Err(format!(
                "{:.1} MB is over the {} MB limit",
                bytes as f64 / (1024.0 * 1024.0),
                MAX_SNAPSHOT_BYTES / (1024 * 1024)
            ));
        }
        if files > MAX_SNAPSHOT_FILES {
            return Err(format!(
                "{files} files is over the {MAX_SNAPSHOT_FILES} file limit"
            ));
        }
        if self.sessions.get(id).is_none() {
            return Err("no such session".into());
        }
        Ok(())
    }

    pub fn put_snapshot(&self, id: &str, sealed: Vec<u8>, files: u32) {
        if let Some(mut s) = self.sessions.get_mut(id) {
            s.snapshot = Some(Snapshot { sealed, files });
        }
    }

    pub fn snapshot(&self, id: &str) -> Option<(Vec<u8>, u32)> {
        self.sessions
            .get(id)
            .and_then(|s| s.snapshot.as_ref().map(|n| (n.sealed.clone(), n.files)))
    }

    pub fn clear_snapshot(&self, id: &str) {
        if let Some(mut s) = self.sessions.get_mut(id) {
            s.snapshot = None;
        }
    }

    pub fn drop_guest(&self, id: &str, pid: u32) {
        if let Some(mut s) = self.sessions.get_mut(id) {
            s.guests.remove(&pid);
        }
    }

    /// Revoke membership and close the participant's socket after a final
    /// control notice has drained.
    pub fn kick_guest(&self, id: &str, pid: u32, notice: Vec<u8>) -> bool {
        let conn = self
            .sessions
            .get_mut(id)
            .and_then(|mut s| s.guests.remove(&pid));
        let Some(conn) = conn else { return false };
        conn.tx.finish(notice);
        true
    }

    /// The host's socket ended. `Deliberate` tears the session down now;
    /// `Dropped` starts the grace period and tells guests to hold on.
    pub fn host_gone(&self, id: &str, why: HostExit, notice: &[u8]) {
        match why {
            HostExit::Deliberate => {
                if let Some((_, session)) = self.sessions.remove(id) {
                    session.send_all_guests(notice);
                }
            }
            HostExit::Dropped => {
                if let Some(mut s) = self.sessions.get_mut(id) {
                    s.host = None;
                    s.host_left_at = Some(Instant::now());
                    s.send_all_guests(notice);
                }
            }
        }
    }

    /// Removes sessions whose host never came back. Returns the ids reaped so
    /// the caller can log them.
    pub fn reap(&self, grace: Duration, notice: &[u8]) -> Vec<String> {
        let expired: Vec<String> = self
            .sessions
            .iter()
            .filter(|s| s.host_left_at.is_some_and(|t| t.elapsed() > grace))
            .map(|s| s.key().clone())
            .collect();
        for id in &expired {
            if let Some((_, session)) = self.sessions.remove(id) {
                session.send_all_guests(notice);
            }
        }
        expired
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx() -> (Tx, crate::outbox::Drain) {
        crate::outbox::channel()
    }

    // ---- peer sessions ----------------------------------------------

    #[test]
    fn a_peer_session_starts_the_moment_someone_opens_the_name() {
        // The whole point of the bare URL: a name nobody is using is a name
        // you can start using. There is no "no such session" to hit.
        let r = Registry::new();
        let (a, _ra) = tx();
        let (p, created) = r.join_peer("demowork", a).unwrap();
        assert!(created, "the first peer should have created the session");
        assert_eq!(p.role, Role::Peer);
        assert_ne!(p.id, 0, "0 is TARGET_ALL and can never be a participant");
    }

    #[test]
    fn arriving_at_an_existing_peer_session_does_not_report_creation() {
        // The caller meters creation and not arrival, so this flag decides
        // whether opening a shared link costs the visitor's address anything.
        let r = Registry::new();
        let (a, _ra) = tx();
        let (b, _rb) = tx();
        r.join_peer("demowork", a).unwrap();
        let (_, created) = r.join_peer("demowork", b).unwrap();
        assert!(!created, "the second peer must not look like a creation");
    }

    #[test]
    fn peers_get_distinct_ids() {
        let r = Registry::new();
        let (a, _ra) = tx();
        let (b, _rb) = tx();
        let (first, _) = r.join_peer("s", a).unwrap();
        let (second, _) = r.join_peer("s", b).unwrap();
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn the_shapes_never_mix() {
        // One name is one kind of session for its whole life. Letting an
        // agent open a name people are already editing in a browser would
        // put two routing rules in one room.
        let r = Registry::new();
        let (a, _ra) = tx();
        r.join_peer("shared", a).unwrap();
        let (h, _rh) = tx();
        assert_eq!(r.open("shared", h).err(), Some(JoinError::WrongShape));

        let r2 = Registry::new();
        let (h2, _rh2) = tx();
        r2.open("hosted", h2).unwrap();
        let (p, _rp) = tx();
        assert_eq!(r2.join_peer("hosted", p).err(), Some(JoinError::WrongShape));
    }

    #[test]
    fn a_broadcast_skips_its_own_sender() {
        // Echoing an update back to whoever made it would read as a second
        // edit to the CRDT layer.
        let r = Registry::new();
        let (a, mut ra) = tx();
        let (b, mut rb) = tx();
        let (me, _) = r.join_peer("s", a).unwrap();
        r.join_peer("s", b).unwrap();

        r.with("s", |s| s.send_others(me.id, b"update")).unwrap();
        assert!(rb.try_next().is_some(), "the other peer heard nothing");
        assert!(ra.try_next().is_none(), "the sender got its own frame back");
    }

    #[test]
    fn the_session_goes_when_the_last_peer_does() {
        // Nothing is running and the files live in the durable store, so
        // there is no reason to hold the room open.
        let r = Registry::new();
        let (a, _ra) = tx();
        let (b, _rb) = tx();
        let (first, _) = r.join_peer("s", a).unwrap();
        let (second, _) = r.join_peer("s", b).unwrap();

        r.drop_peer("s", first.id);
        assert!(r.exists("s"), "one peer left, the room should stand");
        r.drop_peer("s", second.id);
        assert!(!r.exists("s"), "an empty peer session should be forgotten");
    }

    #[test]
    fn a_reaped_host_does_not_take_peer_sessions_with_it() {
        // `reap` walks every session looking for an absent host. A peer
        // session has no host by definition, and must not read as expired.
        let r = Registry::new();
        let (a, _ra) = tx();
        r.join_peer("shared", a).unwrap();
        let reaped = r.reap(Duration::from_millis(0), b"gone");
        assert!(
            reaped.is_empty(),
            "a peer session was reaped for having no host: {reaped:?}"
        );
        assert!(r.exists("shared"));
    }

    #[test]
    fn a_second_host_is_refused() {
        let r = Registry::new();
        let (a, _ra) = tx();
        let (b, _rb) = tx();
        r.open("s", a).unwrap();
        assert_eq!(r.open("s", b).err(), Some(JoinError::HostTaken));
    }

    #[test]
    fn a_dropped_host_can_resume_and_guests_survive() {
        let r = Registry::new();
        let (h, _rh) = tx();
        let (g, _rg) = tx();
        r.open("s", h).unwrap();
        r.join("s", g).unwrap();

        r.host_gone("s", HostExit::Dropped, b"away");
        assert_eq!(
            r.with("s", |s| s.guests.len()),
            Some(1),
            "guest was dropped too early"
        );

        let (h2, _rh2) = tx();
        let (_, resumed) = r.open("s", h2).unwrap();
        assert!(resumed, "re-opening after a drop should report a resume");
    }

    #[test]
    fn a_locked_session_refuses_newcomers_but_keeps_everyone_in_it() {
        let r = Registry::new();
        let (h, _rh) = tx();
        let (early, _re) = tx();
        r.open("s", h).unwrap();
        r.join("s", early).unwrap();

        assert_eq!(r.set_locked("s", true), Some(true));
        let (late, _rl) = tx();
        assert_eq!(r.join("s", late).err(), Some(JoinError::Locked));
        assert_eq!(
            r.with("s", |s| s.guests.len()),
            Some(1),
            "locking should not evict anyone already here"
        );

        r.set_locked("s", false);
        let (later, _rr) = tx();
        assert!(
            r.join("s", later).is_ok(),
            "unlocking should let people in again"
        );
    }

    #[test]
    fn a_host_handshake_restores_lock_before_the_first_join() {
        let r = Registry::new();
        let (host, _rh) = tx();
        r.open_locked("s", host, true, ajar_proto::PROTOCOL_VERSION)
            .unwrap();
        let (guest, _rg) = tx();
        assert_eq!(r.join("s", guest).err(), Some(JoinError::Locked));
    }

    #[test]
    fn the_hosts_protocol_version_reaches_the_session_for_guests_to_read() {
        // What a guest is told decides whether it can explain a dead session
        // or has to sit in one. An older agent sends no version at all, and
        // the relay must carry that through as "older" rather than as current.
        let r = Registry::new();
        let (old_host, _a) = tx();
        r.open_locked("old", old_host, false, ajar_proto::PROTOCOL_UNVERSIONED)
            .unwrap();
        assert_eq!(
            r.with("old", |s| s.host_protocol),
            Some(ajar_proto::PROTOCOL_UNVERSIONED)
        );

        let (new_host, _b) = tx();
        r.open_locked("new", new_host, false, ajar_proto::PROTOCOL_VERSION)
            .unwrap();
        assert_eq!(
            r.with("new", |s| s.host_protocol),
            Some(ajar_proto::PROTOCOL_VERSION)
        );
    }

    #[test]
    fn a_reconnecting_host_refreshes_its_protocol_version() {
        // The same reason the lock is re-sent on every handshake: after a relay
        // restart the stored value has to come from the agent that is actually
        // connected now, not from whatever opened the session first.
        let r = Registry::new();
        let (first, _a) = tx();
        r.open_locked("s", first, false, ajar_proto::PROTOCOL_UNVERSIONED)
            .unwrap();
        r.host_gone("s", HostExit::Dropped, b"");
        let (second, _b) = tx();
        r.open_locked("s", second, false, ajar_proto::PROTOCOL_VERSION)
            .unwrap();
        assert_eq!(
            r.with("s", |s| s.host_protocol),
            Some(ajar_proto::PROTOCOL_VERSION)
        );
    }

    #[test]
    fn removing_a_guest_revokes_membership_immediately() {
        let r = Registry::new();
        let (host, _rh) = tx();
        let (guest, _rg) = tx();
        r.open("s", host).unwrap();
        let participant = r.join("s", guest).unwrap();
        assert!(r.contains_participant("s", &participant));
        r.drop_guest("s", participant.id);
        assert!(!r.contains_participant("s", &participant));
    }

    #[test]
    fn a_snapshot_is_kept_and_handed_back() {
        let r = Registry::new();
        let (h, _rh) = tx();
        r.open("s", h).unwrap();
        assert!(r.snapshot("s").is_none());

        r.offer_snapshot("s", 10, 1).unwrap();
        r.put_snapshot("s", b"sealed bytes".to_vec(), 3);
        assert_eq!(r.snapshot("s"), Some((b"sealed bytes".to_vec(), 3)));

        r.clear_snapshot("s");
        assert!(
            r.snapshot("s").is_none(),
            "disabling sync should drop the copy"
        );
    }

    #[test]
    fn an_oversized_snapshot_is_refused_on_either_axis() {
        let r = Registry::new();
        let (h, _rh) = tx();
        r.open("s", h).unwrap();

        let too_big = r
            .offer_snapshot("s", MAX_SNAPSHOT_BYTES + 1, 10)
            .unwrap_err();
        assert!(too_big.contains("MB limit"), "{too_big}");

        let too_many = r
            .offer_snapshot("s", 10, MAX_SNAPSHOT_FILES + 1)
            .unwrap_err();
        assert!(too_many.contains("file limit"), "{too_many}");

        assert!(r
            .offer_snapshot("s", MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_FILES)
            .is_ok());
    }

    #[test]
    fn a_snapshot_dies_with_its_session() {
        let r = Registry::new();
        let (h, _rh) = tx();
        r.open("s", h).unwrap();
        r.put_snapshot("s", b"x".to_vec(), 1);
        r.host_gone("s", HostExit::Deliberate, b"bye");
        assert!(
            r.snapshot("s").is_none(),
            "a closed session should keep nothing"
        );
    }

    #[test]
    fn a_deliberate_close_ends_it_immediately() {
        let r = Registry::new();
        let (h, _rh) = tx();
        r.open("s", h).unwrap();
        r.host_gone("s", HostExit::Deliberate, b"bye");
        assert!(
            r.with("s", |_| ()).is_none(),
            "session outlived a deliberate close"
        );
    }

    #[test]
    fn reaping_spares_a_session_still_inside_its_grace() {
        let r = Registry::new();
        let (h, _rh) = tx();
        r.open("s", h).unwrap();
        r.host_gone("s", HostExit::Dropped, b"away");

        assert!(r.reap(Duration::from_secs(60), b"gone").is_empty());
        assert_eq!(
            r.reap(Duration::from_millis(0), b"gone"),
            vec!["s".to_string()]
        );
        assert!(r.with("s", |_| ()).is_none());
    }

    #[test]
    fn a_connected_host_is_never_reaped() {
        let r = Registry::new();
        let (h, _rh) = tx();
        r.open("s", h).unwrap();
        assert!(r.reap(Duration::from_millis(0), b"gone").is_empty());
    }
}

//! The relay's entire state: a map from session id to who is connected.
//!
//! Deliberately in-memory. Nothing in v0 persists, so a relay restart
//! dropping every session is correct rather than merely acceptable.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use ajar_proto::{Participant, Role};
use dashmap::DashMap;
use tokio::sync::mpsc;

/// How long a session survives its host's socket dropping. Terminals keep
/// running the whole time — the agent process never noticed. Long enough to
/// cover a wifi handover or a laptop lid, short enough that an abandoned
/// session doesn't linger.
pub const HOST_GRACE: Duration = Duration::from_secs(45);

pub type Tx = mpsc::UnboundedSender<Vec<u8>>;

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

pub struct Session {
    pub host: Option<Conn>,
    /// Latest sealed snapshot, if the host is syncing one.
    pub snapshot: Option<Snapshot>,
    /// Set when the host's socket drops without a deliberate close.
    pub host_left_at: Option<Instant>,
    pub guests: HashMap<u32, Conn>,
    /// Sealed by the host. New guests are refused; existing ones stay.
    pub locked: bool,
    next_id: u32,
}

impl Session {
    fn new() -> Self {
        // 1 is always the host; guests start at 2.
        Self {
            host: None,
            snapshot: None,
            host_left_at: None,
            guests: HashMap::new(),
            locked: false,
            next_id: 2,
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
    pub fn open(&self, id: &str, tx: Tx) -> Result<(Participant, bool), JoinError> {
        let mut entry = self
            .sessions
            .entry(id.to_string())
            .or_insert_with(Session::new);
        if entry.host.is_some() {
            return Err(JoinError::HostTaken);
        }
        let resumed = entry.host_left_at.take().is_some();
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

    pub fn with<R>(&self, id: &str, f: impl FnOnce(&Session) -> R) -> Option<R> {
        self.sessions.get(id).map(|s| f(&s))
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

    fn tx() -> (Tx, mpsc::UnboundedReceiver<Vec<u8>>) {
        mpsc::unbounded_channel()
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

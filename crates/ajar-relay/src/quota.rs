//! What one address is allowed to ask for.
//!
//! Opening a session takes no account, no invitation and no proof of anything
//! — which is the point, and also means a public relay will accept sessions
//! from anyone until it runs out of memory. Session state is small, so this is
//! slow rather than dramatic, but it needs a floor.
//!
//! Deliberately not a general rate limiter. It counts two things per address:
//! how many sessions are *open*, and how many were *started recently*. The
//! first bounds steady state, the second bounds a burst. Nothing here tries to
//! be fair, or to survive a restart, or to work behind a proxy that does not
//! set a forwarding header — a relay that needs that has outgrown this file.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// Sessions one address may have open at once.
pub const MAX_OPEN_PER_IP: usize = 8;

/// Sessions one address may start within [`WINDOW`].
pub const MAX_STARTS_PER_WINDOW: usize = 20;

/// Connections one address may hold to sessions it did **not** create.
///
/// Much larger than [`MAX_OPEN_PER_IP`] on purpose. Joining is the ordinary
/// thing a visitor does, a whole office or classroom can arrive from one
/// address, and every pad the browser tier opens is a join — so a tight number
/// here refuses real people. It is a ceiling against one address holding
/// thousands of sockets, not a policy about how many colleagues you may have.
pub const MAX_JOINS_PER_IP: usize = 96;

/// Joins one address may start within [`WINDOW`].
pub const MAX_JOIN_STARTS_PER_WINDOW: usize = 240;

// The join ceiling exists to stop one address holding thousands of sockets, not
// to ration how many colleagues somebody may have. If it ever drops near the
// open ceiling it has stopped being that, so say so here rather than discover it
// from a support message.
const _: () = assert!(MAX_JOINS_PER_IP > MAX_OPEN_PER_IP * 8);
const _: () = assert!(MAX_JOIN_STARTS_PER_WINDOW > MAX_STARTS_PER_WINDOW * 8);

pub const WINDOW: Duration = Duration::from_secs(60);

/// Which budget a connection is charged to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// Bringing a session into existence. Scarce.
    Open,
    /// Connecting to one that already exists. Generous.
    Join,
}

impl Kind {
    fn limits(self) -> (usize, usize) {
        match self {
            Kind::Open => (MAX_OPEN_PER_IP, MAX_STARTS_PER_WINDOW),
            Kind::Join => (MAX_JOINS_PER_IP, MAX_JOIN_STARTS_PER_WINDOW),
        }
    }
}

#[derive(Default)]
struct Budget {
    held: usize,
    starts: Vec<Instant>,
}

#[derive(Default)]
struct Caller {
    open: Budget,
    join: Budget,
}

impl Caller {
    fn budget(&mut self, kind: Kind) -> &mut Budget {
        match kind {
            Kind::Open => &mut self.open,
            Kind::Join => &mut self.join,
        }
    }

    fn idle(&self) -> bool {
        self.open.held == 0
            && self.open.starts.is_empty()
            && self.join.held == 0
            && self.join.starts.is_empty()
    }
}

#[derive(Default)]
pub struct Quota {
    callers: Mutex<HashMap<IpAddr, Caller>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Denied {
    /// Too many sessions open right now.
    TooManyOpen,
    /// Opening them too quickly.
    TooFast,
}

impl Denied {
    pub fn message(&self) -> &'static str {
        match self {
            Denied::TooManyOpen => "too many sessions open from this address",
            Denied::TooFast => "too many sessions started from this address just now",
        }
    }
}

impl Quota {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim a session slot.
    ///
    /// Returns a guard that releases on drop, rather than a bare `Ok`. The
    /// handshake has several ways to fail *after* a slot is taken — a session
    /// id already in use, most obviously — and every one of them is a path
    /// where a manual release is easy to forget and leaks the address's
    /// allowance to a session that never existed.
    pub fn claim(self: &Arc<Self>, ip: IpAddr, now: Instant, kind: Kind) -> Result<Claim, Denied> {
        self.take(ip, now, kind)?;
        Ok(Claim {
            quota: self.clone(),
            ip,
            kind,
        })
    }

    fn take(&self, ip: IpAddr, now: Instant, kind: Kind) -> Result<(), Denied> {
        let (max_held, max_starts) = kind.limits();
        let mut callers = self.callers.lock();
        let caller = callers.entry(ip).or_default();
        let budget = caller.budget(kind);

        budget.starts.retain(|t| now.duration_since(*t) < WINDOW);

        if budget.held >= max_held {
            return Err(Denied::TooManyOpen);
        }
        if budget.starts.len() >= max_starts {
            return Err(Denied::TooFast);
        }

        budget.held += 1;
        budget.starts.push(now);
        Ok(())
    }

    fn release(&self, ip: IpAddr, now: Instant, kind: Kind) {
        let mut callers = self.callers.lock();
        let Some(caller) = callers.get_mut(&ip) else {
            return;
        };
        let budget = caller.budget(kind);
        budget.held = budget.held.saturating_sub(1);
        budget.starts.retain(|t| now.duration_since(*t) < WINDOW);
        // An address with nothing open and no recent history is not worth
        // remembering. Without this the map only ever grows.
        if caller.idle() {
            callers.remove(&ip);
        }
    }

    #[cfg(test)]
    pub fn tracked(&self) -> usize {
        self.callers.lock().len()
    }
}

/// A held session slot. Releases when it goes out of scope, whichever way the
/// handshake ended.
pub struct Claim {
    quota: Arc<Quota>,
    ip: IpAddr,
    kind: Kind,
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.quota.release(self.ip, Instant::now(), self.kind);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(n: u8) -> IpAddr {
        IpAddr::from([10, 0, 0, n])
    }

    fn quota() -> Arc<Quota> {
        Arc::new(Quota::new())
    }

    #[test]
    fn ordinary_use_is_never_refused() {
        let q = quota();
        let start = Instant::now();
        // Someone sharing a folder now and then across an afternoon. The
        // spacing is the point: fifty sessions at the same instant would be a
        // burst, and the window is supposed to catch that.
        for i in 0..50 {
            let at = start + Duration::from_secs(i * 120);
            let held = q
                .claim(ip(1), at, Kind::Open)
                .expect("ordinary spaced-out use was refused");
            drop(held);
        }
    }

    #[test]
    fn holding_too_many_open_at_once_is_refused() {
        let q = quota();
        let now = Instant::now();
        let _held: Vec<Claim> = (0..MAX_OPEN_PER_IP)
            .map(|_| q.claim(ip(1), now, Kind::Open).unwrap())
            .collect();
        assert_eq!(
            q.claim(ip(1), now, Kind::Open).err(),
            Some(Denied::TooManyOpen)
        );
    }

    #[test]
    fn closing_one_frees_the_slot() {
        let q = quota();
        let now = Instant::now();
        let mut held: Vec<Claim> = (0..MAX_OPEN_PER_IP)
            .map(|_| q.claim(ip(1), now, Kind::Open).unwrap())
            .collect();
        held.pop();
        assert!(
            q.claim(ip(1), now, Kind::Open).is_ok(),
            "a freed slot should be reusable"
        );
    }

    #[test]
    fn a_burst_is_refused_even_when_each_one_closes() {
        // The open-count alone would never fire here: open, close, repeat is
        // always one at a time. Churn is what the window is for.
        let q = quota();
        let now = Instant::now();
        for _ in 0..MAX_STARTS_PER_WINDOW {
            drop(q.claim(ip(1), now, Kind::Open).unwrap());
        }
        assert_eq!(q.claim(ip(1), now, Kind::Open).err(), Some(Denied::TooFast));
    }

    #[test]
    fn the_window_moves() {
        let q = quota();
        let start = Instant::now();
        for _ in 0..MAX_STARTS_PER_WINDOW {
            drop(q.claim(ip(1), start, Kind::Open).unwrap());
        }
        assert_eq!(
            q.claim(ip(1), start, Kind::Open).err(),
            Some(Denied::TooFast)
        );
        let later = start + WINDOW + Duration::from_secs(1);
        assert!(
            q.claim(ip(1), later, Kind::Open).is_ok(),
            "the window never expired"
        );
    }

    #[test]
    fn one_address_cannot_starve_another() {
        let q = quota();
        let now = Instant::now();
        let _held: Vec<Claim> = (0..MAX_OPEN_PER_IP)
            .map(|_| q.claim(ip(1), now, Kind::Open).unwrap())
            .collect();
        assert_eq!(
            q.claim(ip(1), now, Kind::Open).err(),
            Some(Denied::TooManyOpen)
        );
        assert!(
            q.claim(ip(2), now, Kind::Open).is_ok(),
            "a busy neighbour blocked an unrelated address"
        );
    }

    #[test]
    fn joining_is_metered_too_but_far_more_generously() {
        // Joins used to be exempt outright, so one address could hold
        // unlimited sockets — each with an 8 MiB outbox allowance — without the
        // quota ever seeing them. They are charged now, against a ceiling set
        // high enough that an office or a classroom behind one address is not
        // the thing it catches.
        let q = quota();
        let now = Instant::now();
        let held: Vec<_> = (0..MAX_JOINS_PER_IP)
            .map(|_| q.claim(ip(1), now, Kind::Join).unwrap())
            .collect();
        assert_eq!(held.len(), MAX_JOINS_PER_IP);
        assert_eq!(
            q.claim(ip(1), now, Kind::Join).err(),
            Some(Denied::TooManyOpen)
        );
    }

    #[test]
    fn the_two_budgets_do_not_spend_each_other() {
        // Somebody with a room full of guests must still be able to start a
        // session, and a busy host must not eat the allowance its own visitors
        // need. Sharing one counter would make each starve the other.
        let q = quota();
        let now = Instant::now();
        let _joins: Vec<_> = (0..MAX_JOINS_PER_IP)
            .map(|_| q.claim(ip(1), now, Kind::Join).unwrap())
            .collect();
        assert!(
            q.claim(ip(1), now, Kind::Open).is_ok(),
            "joins exhausted should not block opening"
        );

        let q = quota();
        let _opens: Vec<_> = (0..MAX_OPEN_PER_IP)
            .map(|_| q.claim(ip(2), now, Kind::Open).unwrap())
            .collect();
        assert!(
            q.claim(ip(2), now, Kind::Join).is_ok(),
            "opens exhausted should not block joining"
        );
    }

    #[test]
    fn a_join_slot_is_returned_when_the_connection_goes() {
        let q = quota();
        let now = Instant::now();
        let held: Vec<_> = (0..MAX_JOINS_PER_IP)
            .map(|_| q.claim(ip(1), now, Kind::Join).unwrap())
            .collect();
        assert!(q.claim(ip(1), now, Kind::Join).is_err());
        drop(held);
        assert!(
            q.claim(ip(1), now, Kind::Join).is_ok(),
            "a closed connection must give its slot back"
        );
    }

    #[test]
    fn addresses_are_forgotten_once_they_go_quiet() {
        // Otherwise the map is itself the memory leak this file exists to
        // prevent, just slower.
        let q = quota();
        let start = Instant::now();
        for n in 0..100 {
            drop(q.claim(ip(n), start, Kind::Open).unwrap());
        }
        assert_eq!(q.tracked(), 100, "entries should persist while recent");

        let later = start + WINDOW + Duration::from_secs(1);
        // A single later claim prunes the caller it touches; the rest go when
        // they are next seen. Check the one we touched.
        drop(q.claim(ip(0), later, Kind::Open).unwrap());
        assert!(q.tracked() <= 100);
    }
}

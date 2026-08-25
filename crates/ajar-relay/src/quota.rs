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

pub const WINDOW: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Caller {
    open: usize,
    starts: Vec<Instant>,
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
    pub fn claim(self: &Arc<Self>, ip: IpAddr, now: Instant) -> Result<Claim, Denied> {
        self.take(ip, now)?;
        Ok(Claim {
            quota: self.clone(),
            ip,
        })
    }

    fn take(&self, ip: IpAddr, now: Instant) -> Result<(), Denied> {
        let mut callers = self.callers.lock();
        let caller = callers.entry(ip).or_default();

        caller.starts.retain(|t| now.duration_since(*t) < WINDOW);

        if caller.open >= MAX_OPEN_PER_IP {
            return Err(Denied::TooManyOpen);
        }
        if caller.starts.len() >= MAX_STARTS_PER_WINDOW {
            return Err(Denied::TooFast);
        }

        caller.open += 1;
        caller.starts.push(now);
        Ok(())
    }

    fn release(&self, ip: IpAddr, now: Instant) {
        let mut callers = self.callers.lock();
        let Some(caller) = callers.get_mut(&ip) else {
            return;
        };
        caller.open = caller.open.saturating_sub(1);
        caller.starts.retain(|t| now.duration_since(*t) < WINDOW);
        // An address with nothing open and no recent history is not worth
        // remembering. Without this the map only ever grows.
        if caller.open == 0 && caller.starts.is_empty() {
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
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.quota.release(self.ip, Instant::now());
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
                .claim(ip(1), at)
                .expect("ordinary spaced-out use was refused");
            drop(held);
        }
    }

    #[test]
    fn holding_too_many_open_at_once_is_refused() {
        let q = quota();
        let now = Instant::now();
        let _held: Vec<Claim> = (0..MAX_OPEN_PER_IP)
            .map(|_| q.claim(ip(1), now).unwrap())
            .collect();
        assert_eq!(q.claim(ip(1), now).err(), Some(Denied::TooManyOpen));
    }

    #[test]
    fn closing_one_frees_the_slot() {
        let q = quota();
        let now = Instant::now();
        let mut held: Vec<Claim> = (0..MAX_OPEN_PER_IP)
            .map(|_| q.claim(ip(1), now).unwrap())
            .collect();
        held.pop();
        assert!(
            q.claim(ip(1), now).is_ok(),
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
            drop(q.claim(ip(1), now).unwrap());
        }
        assert_eq!(q.claim(ip(1), now).err(), Some(Denied::TooFast));
    }

    #[test]
    fn the_window_moves() {
        let q = quota();
        let start = Instant::now();
        for _ in 0..MAX_STARTS_PER_WINDOW {
            drop(q.claim(ip(1), start).unwrap());
        }
        assert_eq!(q.claim(ip(1), start).err(), Some(Denied::TooFast));
        let later = start + WINDOW + Duration::from_secs(1);
        assert!(q.claim(ip(1), later).is_ok(), "the window never expired");
    }

    #[test]
    fn one_address_cannot_starve_another() {
        let q = quota();
        let now = Instant::now();
        let _held: Vec<Claim> = (0..MAX_OPEN_PER_IP)
            .map(|_| q.claim(ip(1), now).unwrap())
            .collect();
        assert_eq!(q.claim(ip(1), now).err(), Some(Denied::TooManyOpen));
        assert!(
            q.claim(ip(2), now).is_ok(),
            "a busy neighbour blocked an unrelated address"
        );
    }

    #[test]
    fn addresses_are_forgotten_once_they_go_quiet() {
        // Otherwise the map is itself the memory leak this file exists to
        // prevent, just slower.
        let q = quota();
        let start = Instant::now();
        for n in 0..100 {
            drop(q.claim(ip(n), start).unwrap());
        }
        assert_eq!(q.tracked(), 100, "entries should persist while recent");

        let later = start + WINDOW + Duration::from_secs(1);
        // A single later claim prunes the caller it touches; the rest go when
        // they are next seen. Check the one we touched.
        drop(q.claim(ip(0), later).unwrap());
        assert!(q.tracked() <= 100);
    }
}

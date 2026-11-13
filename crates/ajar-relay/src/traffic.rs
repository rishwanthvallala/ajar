//! How busy the relay is, for the operator's view: requests a second by
//! kind, the busiest second of the last hour, and how long requests took.
//!
//! So production says how near it is to what it was measured to take
//! (docs/dev/scaling.md, "Requests a second, against HttpArena") rather than
//! that being found out from a slow page. Counts and durations only — no
//! address, account, pad or path beyond its kind — held in memory for an
//! hour, and gone with a restart.

use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::Response;
use parking_lot::Mutex;
use serde::Serialize;

use crate::AppState;

/// What a request is, as the operator's view counts it.
pub const KINDS: [&str; 5] = ["pad read", "pad save", "account", "other", "socket"];

/// Seconds kept, one slot each.
const SECONDS: usize = 3600;
/// Minutes of durations kept.
const MINUTES: usize = 60;
/// The upper bound of each duration bucket, in microseconds; the last is
/// everything slower.
const BOUNDS_US: [u64; 13] = [
    250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000,
    1_024_000,
];
const BUCKETS: usize = BOUNDS_US.len() + 1;

pub fn kind_of(method: &Method, path: &str) -> usize {
    if path == "/ws" {
        return 4;
    }
    if let Some(rest) = path.strip_prefix("/api/pad/") {
        // A pad itself, not its history or its last run.
        if !rest.contains('/') {
            return if method == Method::PUT { 1 } else { 0 };
        }
    }
    if path == "/api/me" || path.starts_with("/api/my/") || path.starts_with("/auth/") {
        return 2;
    }
    3
}

fn bucket(took: Duration) -> usize {
    let us = took.as_micros() as u64;
    BOUNDS_US
        .iter()
        .position(|&b| us < b)
        .unwrap_or(BOUNDS_US.len())
}

struct Inner {
    /// For each slot, the second it holds and that second's count by kind.
    seconds: Vec<(u64, [u32; KINDS.len()])>,
    /// For each slot, the minute it holds and its durations, by bucket.
    minutes: Vec<(u64, [u32; BUCKETS])>,
}

pub struct Traffic {
    inner: Mutex<Inner>,
}

impl Default for Traffic {
    fn default() -> Self {
        Traffic {
            inner: Mutex::new(Inner {
                seconds: vec![(u64::MAX, [0; KINDS.len()]); SECONDS],
                minutes: vec![(u64::MAX, [0; BUCKETS]); MINUTES],
            }),
        }
    }
}

/// Requests a second of one kind, over the last minute.
#[derive(Debug, Serialize, PartialEq)]
pub struct Rate {
    pub kind: &'static str,
    pub per_second: f64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct TrafficStats {
    /// The last full minute's requests a second, all kinds together and by kind.
    pub per_second: f64,
    pub by_kind: Vec<Rate>,
    /// The busiest second of the last hour, and when (Unix seconds).
    pub peak: u32,
    pub peak_at: Option<u64>,
    /// How long requests took to be answered — to their headers, before a
    /// streamed body — at the median and the 99th percentile, in the last
    /// minute and the last hour: the upper bound of the bucket each falls
    /// in, in milliseconds. None when there were none.
    pub p50_ms_minute: Option<f64>,
    pub p99_ms_minute: Option<f64>,
    pub p99_ms_hour: Option<f64>,
    /// Requests in each of the last 120 seconds, oldest first.
    pub seconds: Vec<u32>,
}

fn percentile(buckets: &[u32; BUCKETS], p: f64) -> Option<f64> {
    let total: u64 = buckets.iter().map(|&n| n as u64).sum();
    if total == 0 {
        return None;
    }
    let want = (total as f64 * p).ceil() as u64;
    let mut seen = 0u64;
    for (i, &n) in buckets.iter().enumerate() {
        seen += n as u64;
        if seen >= want {
            // The slowest bucket has no upper bound; it is said as its lower one.
            let us = BOUNDS_US
                .get(i)
                .copied()
                .unwrap_or(BOUNDS_US[BOUNDS_US.len() - 1]);
            return Some(us as f64 / 1000.0);
        }
    }
    None
}

impl Traffic {
    pub fn record(&self, kind: usize, took: Duration, now: u64) {
        let mut inner = self.inner.lock();
        let slot = &mut inner.seconds[(now % SECONDS as u64) as usize];
        if slot.0 != now {
            *slot = (now, [0; KINDS.len()]);
        }
        slot.1[kind] += 1;
        let minute = now / 60;
        let slot = &mut inner.minutes[(minute % MINUTES as u64) as usize];
        if slot.0 != minute {
            *slot = (minute, [0; BUCKETS]);
        }
        slot.1[bucket(took)] += 1;
    }

    pub fn stats(&self, now: u64) -> TrafficStats {
        let inner = self.inner.lock();
        let count = |second: u64| -> [u32; KINDS.len()] {
            let slot = &inner.seconds[(second % SECONDS as u64) as usize];
            if slot.0 == second {
                slot.1
            } else {
                [0; KINDS.len()]
            }
        };
        // The last full minute: the 60 seconds before this one.
        let mut minute = [0u64; KINDS.len()];
        for s in now.saturating_sub(60)..now {
            for (k, n) in count(s).iter().enumerate() {
                minute[k] += *n as u64;
            }
        }
        let (mut peak, mut peak_at) = (0, None);
        for s in now.saturating_sub(SECONDS as u64 - 1)..=now {
            let total: u32 = count(s).iter().sum();
            if total > peak {
                (peak, peak_at) = (total, Some(s));
            }
        }
        let this_minute = now / 60;
        let durations = |from: u64| {
            let mut sum = [0u32; BUCKETS];
            for slot in inner
                .minutes
                .iter()
                .filter(|m| m.0 != u64::MAX && m.0 >= from && m.0 <= this_minute)
            {
                for (b, n) in slot.1.iter().enumerate() {
                    sum[b] += n;
                }
            }
            sum
        };
        let last_minute = durations(this_minute.saturating_sub(1));
        let last_hour = durations(this_minute.saturating_sub(MINUTES as u64 - 1));
        TrafficStats {
            per_second: minute.iter().sum::<u64>() as f64 / 60.0,
            by_kind: KINDS
                .iter()
                .zip(minute)
                .map(|(kind, n)| Rate {
                    kind,
                    per_second: n as f64 / 60.0,
                })
                .collect(),
            peak,
            peak_at,
            p50_ms_minute: percentile(&last_minute, 0.5),
            p99_ms_minute: percentile(&last_minute, 0.99),
            p99_ms_hour: percentile(&last_hour, 0.99),
            seconds: (now.saturating_sub(120)..now)
                .map(|s| count(s).iter().sum())
                .collect(),
        }
    }
}

/// Every routed request, counted as it is answered.
pub async fn track(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let kind = kind_of(request.method(), request.uri().path());
    let started = std::time::Instant::now();
    let response = next.run(request).await;
    state
        .traffic
        .record(kind, started.elapsed(), crate::usage::now() as u64);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_counted_by_kind() {
        assert_eq!(kind_of(&Method::GET, "/api/pad/some-pad"), 0);
        assert_eq!(kind_of(&Method::PUT, "/api/pad/some-pad"), 1);
        assert_eq!(kind_of(&Method::GET, "/api/pad/some-pad/history"), 3);
        assert_eq!(kind_of(&Method::GET, "/api/me"), 2);
        assert_eq!(kind_of(&Method::POST, "/api/my/pads"), 2);
        assert_eq!(kind_of(&Method::GET, "/auth/github/callback"), 2);
        assert_eq!(kind_of(&Method::GET, "/api/limits"), 3);
        assert_eq!(kind_of(&Method::GET, "/ws"), 4);
    }

    #[test]
    fn the_last_minute_the_peak_and_the_durations_are_said() {
        let t = Traffic::default();
        let now = 1_000_000;
        // Two hours ago: in slots since reused, and outside every window.
        t.record(3, Duration::from_secs(5), now - 7200);
        // 90 pad reads in the minute before now, 31 of them in one second.
        for s in 0..60 {
            let second = now - 60 + s;
            let n = if s == 10 { 31 } else { 1 };
            for _ in 0..n {
                t.record(0, Duration::from_micros(300), second);
            }
        }
        for _ in 0..30 {
            t.record(1, Duration::from_millis(20), now - 1);
        }
        let stats = t.stats(now);
        assert_eq!(stats.peak, 31);
        assert_eq!(stats.peak_at, Some(now - 50));
        assert_eq!(stats.per_second, (90.0 + 30.0) / 60.0);
        assert_eq!(stats.by_kind[0].per_second, 90.0 / 60.0);
        assert_eq!(stats.by_kind[1].per_second, 0.5);
        assert_eq!(
            stats.by_kind[3].per_second, 0.0,
            "two hours ago is not counted"
        );
        assert_eq!(stats.seconds.len(), 120);
        assert_eq!(
            stats.seconds[119], 31,
            "the last second: a read and 30 saves"
        );
        // 90 reads under 0.5 ms, 30 saves under 32 ms.
        assert_eq!(stats.p50_ms_minute, Some(0.5));
        assert_eq!(stats.p99_ms_hour, Some(32.0));
    }

    #[test]
    fn a_slot_reused_an_hour_later_starts_again() {
        let t = Traffic::default();
        t.record(0, Duration::from_millis(1), 100);
        t.record(0, Duration::from_millis(1), 100 + SECONDS as u64);
        let stats = t.stats(100 + SECONDS as u64 + 1);
        assert_eq!(stats.peak, 1, "the old second's count did not carry over");
        assert_eq!(t.stats(10_000_000).p99_ms_minute, None);
    }
}

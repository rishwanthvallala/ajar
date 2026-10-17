//! How the pad is used, counted as it happens, for the operator's view.
//!
//! Counts, and nothing else: how many times a pad was opened in a day and how
//! many different pads that was, how many programs were run and in which
//! language, and the most people in pads and sessions at once. No address,
//! account, pad name or anything else that says who or which is written
//! down — the page's privacy notice (pad/public/privacy.html) says so, and
//! this file is what keeps it true.
//!
//! The one thing kept that is about a pad at all is how "different pads" is
//! counted: today's pads are held as hashes under a key made fresh each day,
//! so a pad opened twice counts once, and the hashes and the key are deleted
//! once the day is over (`prune`, at the turn of the hour). Without the key
//! the hashes say nothing; with it, only which of today's pads were opened
//! today — and tomorrow neither exists.
//!
//! Its own database, beside the accounts one: nothing in it is anyone's,
//! losing it loses only the history, and a copy of it is a copy of nothing
//! else.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::Path;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::Router;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::warn;

use crate::accounts::{Count, Day};
use crate::AppState;

/// The languages a run is counted under. Anything else the page sends is
/// ignored, so these words are all the table can hold.
pub const LANGUAGES: &[&str] = &[
    "python",
    "javascript",
    "c",
    "cpp",
    "go",
    "java",
    "php",
    "lisp",
];
/// How a run started: the Run button, or a line typed in the terminal.
pub const VIA: &[&str] = &["run", "typed"];
/// Runs one address may have counted in a minute; past it they are dropped.
/// A person runs a few; a loop posting them would otherwise be the chart.
pub const RUNS_PER_MINUTE: u32 = 60;
/// People online is kept as the most seen in each of these.
pub const SAMPLE_SECS: i64 = 300;
/// How long the five-minute samples are kept; each day's peak outlives them.
pub const SAMPLES_KEPT_DAYS: i64 = 30;
/// How long the daily counts are kept.
pub const COUNTS_KEPT_DAYS: i64 = 400;

const DAY: i64 = 86_400;

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub struct Usage {
    db: Mutex<Connection>,
    /// Runs counted per address in the current minute, emptied as the minute
    /// turns — so it holds only the addresses of the last minute.
    throttle: Mutex<(i64, HashMap<IpAddr, u32>)>,
}

/// The most at once in five minutes, from its start in Unix seconds.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Sample {
    pub at: i64,
    /// In pads and in sessions, together.
    pub people: i64,
    pub pads: i64,
    pub sessions: i64,
}

#[derive(Debug, Serialize)]
pub struct UsageStats {
    /// Pad pages opened, per day.
    pub opens: Vec<Day>,
    /// How many different pads those were, per day.
    pub pads: Vec<Day>,
    /// Programs run, per day.
    pub runs: Vec<Day>,
    /// The window's runs by language, and by Run or typed, most first.
    pub languages: Vec<Count>,
    pub via: Vec<Count>,
    /// The most people in pads and sessions at once, per day.
    pub peak: Vec<Day>,
    /// The last day, five minutes at a time. None where the relay was not
    /// running to look.
    pub online: Vec<Sample>,
    /// The first day anything was counted, in Unix seconds: the charts are
    /// empty before it because there was no counting, not no use.
    pub since: Option<i64>,
}

impl Usage {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&conn)?;
        Ok(Usage {
            db: Mutex::new(conn),
            throttle: Mutex::new((0, HashMap::new())),
        })
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        Usage {
            db: Mutex::new(conn),
            throttle: Mutex::new((0, HashMap::new())),
        }
    }

    /// A pad's page opened it: one more open, and one more pad if it is the
    /// first time today.
    pub fn opened(&self, pad: &str, now: i64) -> rusqlite::Result<()> {
        let day = now.div_euclid(DAY);
        let db = self.db.lock();
        let tx = db.unchecked_transaction()?;
        let salt = salt(&tx, day)?;
        let hash = Sha256::new()
            .chain_update(&salt)
            .chain_update(pad.as_bytes())
            .finalize();
        let first = tx.execute(
            "INSERT OR IGNORE INTO seen (day, hash) VALUES (?1, ?2)",
            params![day, &hash[..16]],
        )? == 1;
        add(&tx, day, "open", "", 1)?;
        if first {
            add(&tx, day, "pads", "", 1)?;
        }
        tx.commit()
    }

    /// A program run in `language`, started `via` Run or typing. Counted
    /// when both are words counted here and `from` has not had too many this
    /// minute; whether it was.
    pub fn ran(&self, language: &str, via: &str, from: IpAddr, now: i64) -> rusqlite::Result<bool> {
        if !LANGUAGES.contains(&language) || !VIA.contains(&via) {
            return Ok(false);
        }
        {
            let mut throttle = self.throttle.lock();
            let minute = now.div_euclid(60);
            if throttle.0 != minute {
                *throttle = (minute, HashMap::new());
            }
            let n = throttle.1.entry(from).or_default();
            if *n >= RUNS_PER_MINUTE {
                return Ok(false);
            }
            *n += 1;
        }
        let day = now.div_euclid(DAY);
        let db = self.db.lock();
        let tx = db.unchecked_transaction()?;
        add(&tx, day, "run", language, 1)?;
        add(&tx, day, "via", via, 1)?;
        tx.commit()?;
        Ok(true)
    }

    /// How many are in pads and sessions now: kept as the most for these five
    /// minutes, and for the day.
    pub fn sample(&self, people: i64, pads: i64, sessions: i64, now: i64) -> rusqlite::Result<()> {
        let at = now - now.rem_euclid(SAMPLE_SECS);
        let db = self.db.lock();
        db.execute(
            "INSERT INTO online (at, people, pads, sessions) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(at) DO UPDATE SET people = MAX(people, excluded.people),
               pads = MAX(pads, excluded.pads), sessions = MAX(sessions, excluded.sessions)",
            params![at, people, pads, sessions],
        )?;
        db.execute(
            "INSERT INTO counts (day, kind, key, n) VALUES (?1, 'peak', '', ?2)
             ON CONFLICT(day, kind, key) DO UPDATE SET n = MAX(n, excluded.n)",
            params![now.div_euclid(DAY), people],
        )?;
        Ok(())
    }

    /// What is past keeping: the hashes of days that are over and their keys,
    /// samples past a month, counts past [`COUNTS_KEPT_DAYS`].
    pub fn prune(&self, now: i64) -> rusqlite::Result<()> {
        let today = now.div_euclid(DAY);
        let db = self.db.lock();
        db.execute("DELETE FROM seen WHERE day < ?1", [today])?;
        db.execute("DELETE FROM salts WHERE day < ?1", [today])?;
        db.execute(
            "DELETE FROM online WHERE at < ?1",
            [now - SAMPLES_KEPT_DAYS * DAY],
        )?;
        db.execute(
            "DELETE FROM counts WHERE day < ?1",
            [today - COUNTS_KEPT_DAYS],
        )?;
        Ok(())
    }

    /// The last `days` days of it, every day there even when nothing happened.
    pub fn stats(&self, days: i64, now: i64) -> rusqlite::Result<UsageStats> {
        let db = self.db.lock();
        let today = now.div_euclid(DAY);
        let first = today - days + 1;
        let per_day = |kind: &str| -> rusqlite::Result<Vec<Day>> {
            let mut q = db.prepare(
                "SELECT day, SUM(n) FROM counts WHERE kind = ?1 AND day >= ?2 GROUP BY day",
            )?;
            let got: HashMap<i64, i64> = q
                .query_map(params![kind, first], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok((first..=today)
                .map(|day| Day {
                    day: day * DAY,
                    n: got.get(&day).copied().unwrap_or(0),
                })
                .collect())
        };
        let by_key = |kind: &str| -> rusqlite::Result<Vec<Count>> {
            let mut q = db.prepare(
                "SELECT key, SUM(n) FROM counts WHERE kind = ?1 AND day >= ?2
                 GROUP BY key ORDER BY 2 DESC, 1",
            )?;
            let rows = q.query_map(params![kind, first], |r| {
                Ok(Count {
                    key: r.get(0)?,
                    n: r.get(1)?,
                })
            })?;
            rows.collect()
        };
        let online = {
            let mut q = db.prepare(
                "SELECT at, people, pads, sessions FROM online WHERE at > ?1 ORDER BY at",
            )?;
            let rows = q.query_map([now - DAY], |r| {
                Ok(Sample {
                    at: r.get(0)?,
                    people: r.get(1)?,
                    pads: r.get(2)?,
                    sessions: r.get(3)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let since: Option<i64> = db
            .query_row("SELECT MIN(day) FROM counts", [], |r| r.get(0))
            .optional()?
            .flatten();
        Ok(UsageStats {
            opens: per_day("open")?,
            pads: per_day("pads")?,
            runs: per_day("run")?,
            languages: by_key("run")?,
            via: by_key("via")?,
            peak: per_day("peak")?,
            online,
            since: since.map(|day| day * DAY),
        })
    }
}

fn add(db: &Connection, day: i64, kind: &str, key: &str, by: i64) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO counts (day, kind, key, n) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(day, kind, key) DO UPDATE SET n = n + excluded.n",
        params![day, kind, key, by],
    )?;
    Ok(())
}

/// The day's key for the hashes of its pads, made the first time it is
/// needed and deleted with them.
fn salt(db: &Connection, day: i64) -> rusqlite::Result<Vec<u8>> {
    if let Some(salt) = db
        .query_row("SELECT salt FROM salts WHERE day = ?1", [day], |r| r.get(0))
        .optional()?
    {
        return Ok(salt);
    }
    let mut salt = [0u8; 32];
    getrandom::fill(&mut salt).expect("the system has no randomness");
    db.execute(
        "INSERT INTO salts (day, salt) VALUES (?1, ?2)",
        params![day, &salt[..]],
    )?;
    Ok(salt.to_vec())
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE counts (
                 day INTEGER NOT NULL,
                 kind TEXT NOT NULL,
                 key TEXT NOT NULL,
                 n INTEGER NOT NULL,
                 PRIMARY KEY (day, kind, key)
             ) WITHOUT ROWID;
             CREATE TABLE seen (
                 day INTEGER NOT NULL,
                 hash BLOB NOT NULL,
                 PRIMARY KEY (day, hash)
             ) WITHOUT ROWID;
             CREATE TABLE salts (day INTEGER PRIMARY KEY, salt BLOB NOT NULL);
             CREATE TABLE online (
                 at INTEGER PRIMARY KEY,
                 people INTEGER NOT NULL,
                 pads INTEGER NOT NULL,
                 sessions INTEGER NOT NULL
             );
             PRAGMA user_version = 1;",
        )?;
    }
    Ok(())
}

// ------------------------------------------------------------------ http

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/usage/run", post(count_run))
}

#[derive(Deserialize)]
struct Run {
    language: String,
    via: String,
}

/// A program run, from the page: its language and how it started, and
/// nothing about where. Answered the same whether it was counted or not, so
/// it tells a caller nothing either.
async fn count_run(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    State(state): State<AppState>,
    body: Bytes,
) -> StatusCode {
    let Ok(run) = serde_json::from_slice::<Run>(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    let from = crate::caller_ip(&headers, peer.ip(), state.trust_forwarded);
    let usage = state.usage.clone();
    let counted =
        tokio::task::spawn_blocking(move || usage.ran(&run.language, &run.via, from, now())).await;
    if let Ok(Err(e)) = counted {
        warn!("counting a run failed: {e}");
    }
    StatusCode::NO_CONTENT
}

/// Count a pad's page opening it, off the request's way.
pub fn count_open(state: &AppState, pad: String) {
    let usage = state.usage.clone();
    tokio::task::spawn_blocking(move || {
        if let Err(e) = usage.opened(&pad, now()) {
            warn!("counting an open failed: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_760_000_000 - 1_760_000_000 % DAY + 3600;
    const HOME: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 1));

    #[test]
    fn a_pad_opened_twice_in_a_day_is_one_pad_and_two_opens() {
        let u = Usage::in_memory();
        u.opened("alpha", T).unwrap();
        u.opened("alpha", T + 60).unwrap();
        u.opened("beta", T + 120).unwrap();
        let s = u.stats(30, T + 200).unwrap();
        assert_eq!(s.opens.last().unwrap().n, 3);
        assert_eq!(s.pads.last().unwrap().n, 2);
        // The next day it is a pad again.
        u.opened("alpha", T + DAY).unwrap();
        let s = u.stats(30, T + DAY).unwrap();
        assert_eq!(
            (s.opens.last().unwrap().n, s.pads.last().unwrap().n),
            (1, 1)
        );
        assert_eq!(s.pads[s.pads.len() - 2].n, 2, "yesterday keeps its count");
    }

    #[test]
    fn a_days_hashes_and_key_go_when_it_is_over_and_its_counts_stay() {
        let u = Usage::in_memory();
        u.opened("alpha", T).unwrap();
        u.prune(T + 10).unwrap();
        let rows = |table: &str| -> i64 {
            u.db.lock()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!((rows("seen"), rows("salts")), (1, 1), "today's are kept");
        u.prune(T + DAY).unwrap();
        assert_eq!((rows("seen"), rows("salts")), (0, 0));
        assert_eq!(
            u.stats(30, T + DAY)
                .unwrap()
                .pads
                .iter()
                .map(|d| d.n)
                .sum::<i64>(),
            1
        );
        // No name anywhere, not even hashed past its day.
        let names: i64 =
            u.db.lock()
                .query_row(
                    "SELECT COUNT(*) FROM counts WHERE key LIKE '%alpha%' OR kind LIKE '%alpha%'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(names, 0);
    }

    #[test]
    fn runs_are_counted_by_known_language_only_and_a_minute_at_a_time() {
        let u = Usage::in_memory();
        assert!(u.ran("python", "run", HOME, T).unwrap());
        assert!(u.ran("go", "typed", HOME, T).unwrap());
        assert!(!u.ran("<script>", "run", HOME, T).unwrap());
        assert!(!u.ran("python", "somehow", HOME, T).unwrap());
        for _ in 2..RUNS_PER_MINUTE {
            assert!(u.ran("python", "typed", HOME, T).unwrap());
        }
        assert!(
            !u.ran("python", "typed", HOME, T + 30).unwrap(),
            "past the minute's allowance"
        );
        let other = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 2));
        assert!(
            u.ran("c", "run", other, T + 30).unwrap(),
            "another address has its own"
        );
        assert!(
            u.ran("python", "typed", HOME, T + 60).unwrap(),
            "and the next minute is new"
        );
        let s = u.stats(30, T + 60).unwrap();
        assert_eq!(s.runs.last().unwrap().n, i64::from(RUNS_PER_MINUTE) + 2);
        assert_eq!(s.languages[0].key, "python");
        assert!(s
            .languages
            .iter()
            .all(|c| LANGUAGES.contains(&c.key.as_str())));
        assert_eq!(
            s.via.iter().map(|c| c.n).sum::<i64>(),
            s.runs.last().unwrap().n
        );
    }

    #[test]
    fn people_online_keeps_the_most_in_each_five_minutes_and_each_day() {
        let u = Usage::in_memory();
        u.sample(2, 1, 0, T).unwrap();
        u.sample(5, 2, 1, T + 30).unwrap();
        u.sample(1, 1, 0, T + 60).unwrap();
        u.sample(3, 1, 1, T + SAMPLE_SECS).unwrap();
        let s = u.stats(30, T + SAMPLE_SECS).unwrap();
        assert_eq!(
            s.online,
            vec![
                Sample {
                    at: T,
                    people: 5,
                    pads: 2,
                    sessions: 1
                },
                Sample {
                    at: T + SAMPLE_SECS,
                    people: 3,
                    pads: 1,
                    sessions: 1
                },
            ]
        );
        assert_eq!(s.peak.last().unwrap().n, 5);
        // A day later the samples are not the last day's, and the peak stays.
        let s = u.stats(30, T + 2 * DAY).unwrap();
        assert!(s.online.is_empty());
        assert_eq!(s.peak[s.peak.len() - 3].n, 5);
    }

    #[test]
    fn every_day_of_the_window_is_there_and_since_says_when_counting_began() {
        let u = Usage::in_memory();
        assert_eq!(u.stats(30, T).unwrap().since, None);
        u.opened("alpha", T - 3 * DAY).unwrap();
        let s = u.stats(30, T).unwrap();
        assert_eq!(s.opens.len(), 30);
        assert_eq!(s.since, Some((T - 3 * DAY).div_euclid(DAY) * DAY));
        assert_eq!(s.opens.last().unwrap().day, T.div_euclid(DAY) * DAY);
    }
}

//! Turning filesystem noise into something a client can follow.
//!
//! A dependency install fires tens of thousands of events in seconds. The
//! coalescer buffers touched paths into a set, flushes a few times a second
//! while that goes on, and gives up describing the change entirely once one
//! flush would be too large — rebuilding a tree is cheaper than shipping
//! fifty thousand deltas, and far cheaper than a client that falls behind
//! forever.
//!
//! One file saved is not that, and does not wait for it: a change that comes
//! out of quiet is sent as soon as what came with it has — a few
//! milliseconds — rather than at the next beat of a clock. Until 20 November
//! every change waited for a tick four times a second, so a file saved on
//! the host reached a guest's page a quarter of a second late at worst and an
//! eighth on average, before the network had carried it anywhere.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tracing::debug;

use super::filter::Filter;

/// How long a change waits for what comes with it. One save is several
/// events — the file emptied and then written, or one written beside it and
/// renamed over it — a moment apart, and a flush between them would show a
/// guest the file half saved.
pub const SETTLE: Duration = Duration::from_millis(12);

/// The longest a change waits for quiet, however much keeps coming.
pub const MAX_HOLD: Duration = Duration::from_millis(50);

/// The least between two flushes when little is changing: a guest typing
/// into a file, a test writing its output.
pub const QUIET_GAP: Duration = Duration::from_millis(100);

/// And when a lot is — a flush that carried more than [`BUSY`] paths: slow
/// enough that a build doesn't turn into a packet storm. What every flush
/// waited for until 20 November.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(250);

/// A flush of more paths than this is a burst, and the next one keeps the
/// slower beat.
pub const BUSY: usize = 32;

/// Past this many paths in one flush, stop describing and ask for a resync.
pub const RESYNC_THRESHOLD: usize = 500;

#[derive(Debug, PartialEq, Eq)]
pub enum FsEvent {
    /// Relative paths that changed in some way. The workspace resolves each
    /// against what it already knows to decide added, changed or removed.
    Touched(Vec<String>),
    /// Too much moved to enumerate.
    Resync,
}

/// Decides what a batch of touched paths becomes. Split out from the watcher
/// so it can be tested without a filesystem.
pub fn classify(mut touched: Vec<String>, threshold: usize) -> FsEvent {
    if touched.len() > threshold {
        return FsEvent::Resync;
    }
    touched.sort();
    FsEvent::Touched(touched)
}

/// When what is held should go: once it has been quiet for [`SETTLE`] or
/// held for [`MAX_HOLD`], but no sooner after the last flush than the beat
/// that flush set — [`QUIET_GAP`], or [`FLUSH_INTERVAL`] after a burst. Split
/// out from the watcher so it can be tested without a clock.
pub fn flush_at(
    first: Instant,
    latest: Instant,
    last_flush: Instant,
    last_batch: usize,
) -> Instant {
    let gap = if last_batch > BUSY {
        FLUSH_INTERVAL
    } else {
        QUIET_GAP
    };
    (latest + SETTLE)
        .min(first + MAX_HOLD)
        .max(last_flush + gap)
}

/// Starts watching. The returned watcher must be held: dropping it stops the
/// notifications, silently.
pub fn spawn(filter: Arc<Filter>) -> Result<(RecommendedWatcher, UnboundedReceiver<FsEvent>)> {
    let root = filter.root().to_path_buf();
    let (raw_tx, mut raw_rx) = mpsc::unbounded_channel::<PathBuf>();
    let (out_tx, out_rx) = mpsc::unbounded_channel::<FsEvent>();

    let for_watcher = filter.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            // Reads are not changes. Without this, merely opening a file in
            // an editor would broadcast a patch.
            return;
        }
        for path in event.paths {
            // An ignore file changed: read it again before deciding anything.
            for_watcher.changed(&path);
            // The watcher and the scanner must agree, or an install into an
            // ignored directory floods everyone with churn they never saw.
            let is_dir = path.is_dir();
            if for_watcher.is_ignored(&path, is_dir) {
                continue;
            }
            let _ = raw_tx.send(path);
        }
    })
    .context("creating filesystem watcher")?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .with_context(|| format!("watching {}", root.display()))?;

    tokio::spawn(async move {
        let mut pending: HashSet<String> = HashSet::new();
        // When the oldest and the newest of what is held came, and what the
        // last flush was: together, when the next is due (`flush_at`).
        let mut first: Option<Instant> = None;
        let mut latest = Instant::now();
        let mut last_flush = latest.checked_sub(FLUSH_INTERVAL).unwrap_or(latest);
        let mut last_batch = 0;

        loop {
            let due = first.map(|first| flush_at(first, latest, last_flush, last_batch));
            tokio::select! {
                path = raw_rx.recv() => {
                    let Some(path) = path else { break };
                    if let Some(rel) = filter.relative(&path) {
                        pending.insert(rel);
                        latest = Instant::now();
                        first.get_or_insert(latest);
                    }
                }
                _ = async { tokio::time::sleep_until(due.expect("guarded").into()).await }, if due.is_some() => {
                    let batch: Vec<String> = pending.drain().collect();
                    debug!("flushing {} touched paths", batch.len());
                    first = None;
                    last_flush = Instant::now();
                    last_batch = batch.len();
                    if out_tx.send(classify(batch, RESYNC_THRESHOLD)).is_err() {
                        break;
                    }
                }
            }
        }
    });

    Ok((watcher, out_rx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_out_of_quiet_goes_once_what_came_with_it_has() {
        let quiet = Instant::now();
        let t = quiet + Duration::from_secs(5);
        // One event: sent a settle later, not at the next beat of anything.
        assert_eq!(flush_at(t, t, quiet, 1), t + SETTLE);
        // A save's second event, three milliseconds on, moves it by as much.
        let second = t + Duration::from_millis(3);
        assert_eq!(flush_at(t, second, quiet, 1), second + SETTLE);
    }

    #[test]
    fn a_change_never_waits_for_quiet_that_does_not_come() {
        let quiet = Instant::now();
        let t = quiet + Duration::from_secs(5);
        // Events every few milliseconds, still coming after 200: it went at
        // the longest hold, not when they stopped.
        let still = t + Duration::from_millis(200);
        assert_eq!(flush_at(t, still, quiet, 1), t + MAX_HOLD);
    }

    #[test]
    fn flushes_keep_a_beat_and_a_burst_slows_it() {
        let last = Instant::now();
        // A change a moment after a small flush waits out the quiet gap.
        let t = last + Duration::from_millis(5);
        assert_eq!(flush_at(t, t, last, 2), last + QUIET_GAP);
        // After a flush that was a burst, the beat every flush kept before.
        assert_eq!(flush_at(t, t, last, BUSY + 1), last + FLUSH_INTERVAL);
        // And long after either, nothing is waited for but the settle.
        let later = last + Duration::from_secs(2);
        assert_eq!(flush_at(later, later, last, BUSY + 1), later + SETTLE);
    }

    #[test]
    fn a_small_batch_is_described() {
        let ev = classify(vec!["b.rs".into(), "a.rs".into()], 500);
        assert_eq!(ev, FsEvent::Touched(vec!["a.rs".into(), "b.rs".into()]));
    }

    #[test]
    fn a_batch_at_the_threshold_is_still_described() {
        let batch: Vec<String> = (0..500).map(|i| format!("f{i}")).collect();
        assert!(matches!(classify(batch, 500), FsEvent::Touched(_)));
    }

    #[test]
    fn an_oversized_batch_asks_for_a_resync() {
        let batch: Vec<String> = (0..501).map(|i| format!("f{i}")).collect();
        assert_eq!(classify(batch, 500), FsEvent::Resync);
    }

    #[test]
    fn an_install_sized_batch_asks_for_a_resync() {
        let batch: Vec<String> = (0..40_000).map(|i| format!("node_modules/p{i}")).collect();
        assert_eq!(classify(batch, RESYNC_THRESHOLD), FsEvent::Resync);
    }
}

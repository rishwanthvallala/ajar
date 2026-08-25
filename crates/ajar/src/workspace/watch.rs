//! Turning filesystem noise into something a client can follow.
//!
//! A dependency install fires tens of thousands of events in seconds. The
//! coalescer buffers touched paths into a set, flushes a few times a second,
//! and gives up describing the change entirely once one flush would be too
//! large — rebuilding a tree is cheaper than shipping fifty thousand deltas,
//! and far cheaper than a client that falls behind forever.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tracing::debug;

use super::filter::Filter;

/// How often the coalescer drains. Fast enough that a save feels immediate,
/// slow enough that a build doesn't turn into a packet storm.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(250);

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
        let mut tick = tokio::time::interval(FLUSH_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                path = raw_rx.recv() => {
                    let Some(path) = path else { break };
                    if let Some(rel) = filter.relative(&path) {
                        pending.insert(rel);
                    }
                }
                _ = tick.tick() => {
                    if pending.is_empty() {
                        continue;
                    }
                    let batch: Vec<String> = pending.drain().collect();
                    debug!("flushing {} touched paths", batch.len());
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

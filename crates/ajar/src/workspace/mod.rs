//! The shared folder as the guests see it.
//!
//! The agent is the file authority — it owns the disk and everything a client
//! knows about the tree came from here.

pub mod filter;
pub mod watch;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ajar_proto::{Entry, EntryKind, Fs, MAX_FILE_BYTES};
use anyhow::{bail, Context, Result};
use ignore::WalkBuilder;
use tracing::debug;

pub use filter::Filter;
pub use watch::FsEvent;

/// Past this many entries the tree stops being useful to render and the
/// watcher starts costing real money. It is also a strong hint that the
/// ignore rules are missing something.
pub const MAX_ENTRIES: usize = 20_000;

pub struct Workspace {
    filter: Arc<Filter>,
    entries: BTreeMap<String, Entry>,
}

pub struct ScanReport {
    pub count: usize,
    /// Hit `MAX_ENTRIES` and stopped walking.
    pub truncated: bool,
}

impl Workspace {
    pub fn scan(root: &Path, limit: usize) -> Result<(Self, ScanReport)> {
        let filter = Arc::new(Filter::build(root)?);
        let mut ws = Workspace {
            filter,
            entries: BTreeMap::new(),
        };
        let report = ws.rescan(limit)?;
        Ok((ws, report))
    }

    /// Walk the folder from scratch. Used at startup and whenever the watcher
    /// gives up describing a change.
    pub fn rescan(&mut self, limit: usize) -> Result<ScanReport> {
        let root = self.filter.root().to_path_buf();
        let mut entries = BTreeMap::new();
        let mut truncated = false;

        let walker = WalkBuilder::new(&root)
            .hidden(false) // a project usually wants .gitignore and .editorconfig visible
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .follow_links(false) // a symlink out of the workspace is not ours to share
            .build();

        for dirent in walker.flatten() {
            let path = dirent.path();
            if path == root {
                continue;
            }
            let is_dir = dirent.file_type().is_some_and(|t| t.is_dir());
            if self.filter.is_ignored(path, is_dir) {
                continue;
            }
            let Some(rel) = self.filter.relative(path) else {
                continue;
            };
            if entries.len() >= limit {
                truncated = true;
                break;
            }
            entries.insert(rel.clone(), make_entry(rel, path, is_dir));
        }

        let count = entries.len();
        self.entries = entries;
        Ok(ScanReport { count, truncated })
    }

    pub fn filter(&self) -> Arc<Filter> {
        self.filter.clone()
    }

    /// The full snapshot, sent to whoever just arrived.
    pub fn tree(&self) -> Fs {
        Fs::Tree {
            entries: self.entries.values().cloned().collect(),
        }
    }

    /// Resolve a batch of touched paths against what we already knew.
    ///
    /// Doing it this way — collecting paths, then asking the disk — means a
    /// file created and deleted inside one flush window correctly produces
    /// nothing at all.
    pub fn apply(&mut self, touched: &[String]) -> Option<Fs> {
        let mut added = Vec::new();
        let mut changed = Vec::new();
        let mut removed = Vec::new();

        for rel in touched {
            let Some(abs) = self.filter.resolve_unchecked(rel) else {
                continue;
            };
            match std::fs::symlink_metadata(&abs) {
                Ok(meta) => {
                    let is_dir = meta.is_dir();
                    if self.filter.is_ignored(&abs, is_dir) {
                        continue;
                    }
                    let entry = make_entry(rel.clone(), &abs, is_dir);
                    match self.entries.insert(rel.clone(), entry.clone()) {
                        Some(previous) if previous == entry => {} // touched, unchanged
                        Some(_) => changed.push(entry),
                        None => added.push(entry),
                    }
                }
                Err(_) => {
                    if self.entries.remove(rel).is_some() {
                        removed.push(rel.clone());
                    }
                }
            }
        }

        if added.is_empty() && changed.is_empty() && removed.is_empty() {
            return None;
        }
        debug!(
            "patch: +{} ~{} -{}",
            added.len(),
            changed.len(),
            removed.len()
        );
        Some(Fs::Patch {
            added,
            changed,
            removed,
        })
    }

    /// Read a file for a guest. Never sends binary, never sends more than the
    /// cap, never resolves outside the workspace.
    pub fn read(&self, rel: &str) -> Fs {
        match self.try_read(rel) {
            Ok(fs) => fs,
            Err(e) => Fs::ReadError {
                path: rel.to_string(),
                message: e.to_string(),
            },
        }
    }

    fn try_read(&self, rel: &str) -> Result<Fs> {
        let path = self
            .filter
            .resolve(rel)
            .with_context(|| format!("{rel} is not inside this workspace"))?;
        let meta = std::fs::metadata(&path).context("reading file")?;
        if meta.is_dir() {
            bail!("{rel} is a directory");
        }

        let size = meta.len() as usize;
        let want = size.min(MAX_FILE_BYTES);
        let bytes = read_prefix(&path, want)?;

        // A null byte in the first chunk is the same heuristic git uses, and
        // it is right often enough that nobody notices the exceptions.
        if bytes.iter().take(8192).any(|b| *b == 0) {
            return Ok(Fs::Content {
                path: rel.to_string(),
                text: String::new(),
                truncated: false,
                binary: true,
            });
        }

        Ok(Fs::Content {
            path: rel.to_string(),
            text: String::from_utf8_lossy(&bytes).into_owned(),
            truncated: size > MAX_FILE_BYTES,
            binary: false,
        })
    }
}

fn read_prefix(path: &Path, want: usize) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).context("opening file")?;
    let mut buf = vec![0u8; want];
    let mut filled = 0;
    while filled < want {
        match f.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) => return Err(e).context("reading file"),
        }
    }
    buf.truncate(filled);
    Ok(buf)
}

fn make_entry(path: String, abs: &Path, is_dir: bool) -> Entry {
    Entry {
        path,
        kind: if is_dir {
            EntryKind::Dir
        } else {
            EntryKind::File
        },
        size: if is_dir {
            0
        } else {
            std::fs::metadata(abs).map(|m| m.len()).unwrap_or(0)
        },
    }
}

impl Filter {
    /// Join without touching the disk. Used when resolving a path that may
    /// have just been deleted, where `canonicalize` would fail.
    pub fn resolve_unchecked(&self, rel: &str) -> Option<PathBuf> {
        if rel.is_empty() || rel.starts_with('/') {
            return None;
        }
        let mut out = self.root().to_path_buf();
        for part in rel.split('/') {
            if part.is_empty() || part == "." || part == ".." {
                return None;
            }
            out.push(part);
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ajar-ws-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn paths(fs_msg: &Fs) -> Vec<String> {
        match fs_msg {
            Fs::Tree { entries } => entries.iter().map(|e| e.path.clone()).collect(),
            _ => panic!("expected a tree"),
        }
    }

    #[test]
    fn scans_source_and_skips_dependencies() {
        let root = scratch("scan");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules/react")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("README.md"), "# hi").unwrap();
        fs::write(
            root.join("node_modules/react/index.js"),
            "module.exports={}",
        )
        .unwrap();

        let (ws, report) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        assert!(!report.truncated);
        let listed = paths(&ws.tree());
        assert!(listed.contains(&"src/main.rs".to_string()));
        assert!(listed.contains(&"README.md".to_string()));
        assert!(
            !listed.iter().any(|p| p.starts_with("node_modules")),
            "dependencies leaked into the tree: {listed:?}"
        );
    }

    #[test]
    fn stops_at_the_entry_limit() {
        let root = scratch("limit");
        for i in 0..50 {
            fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }
        let (_, report) = Workspace::scan(&root, 10).unwrap();
        assert!(report.truncated);
        assert_eq!(report.count, 10);
    }

    #[test]
    fn a_new_file_becomes_an_addition() {
        let root = scratch("added");
        let (mut ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        fs::write(root.join("new.txt"), "hello").unwrap();

        let patch = ws
            .apply(&["new.txt".to_string()])
            .expect("expected a patch");
        match patch {
            Fs::Patch {
                added,
                changed,
                removed,
            } => {
                assert_eq!(added.len(), 1);
                assert_eq!(added[0].path, "new.txt");
                assert_eq!(added[0].size, 5);
                assert!(changed.is_empty() && removed.is_empty());
            }
            other => panic!("expected a patch, got {other:?}"),
        }
    }

    #[test]
    fn a_deleted_file_becomes_a_removal() {
        let root = scratch("removed");
        fs::write(root.join("gone.txt"), "bye").unwrap();
        let (mut ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        fs::remove_file(root.join("gone.txt")).unwrap();

        match ws
            .apply(&["gone.txt".to_string()])
            .expect("expected a patch")
        {
            Fs::Patch { removed, .. } => assert_eq!(removed, vec!["gone.txt".to_string()]),
            other => panic!("expected a patch, got {other:?}"),
        }
    }

    #[test]
    fn a_touch_that_changed_nothing_produces_nothing() {
        let root = scratch("noop");
        fs::write(root.join("same.txt"), "stable").unwrap();
        let (mut ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        assert!(
            ws.apply(&["same.txt".to_string()]).is_none(),
            "an unchanged file should not produce a patch"
        );
    }

    #[test]
    fn a_file_created_and_deleted_in_one_window_produces_nothing() {
        let root = scratch("transient");
        let (mut ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        // The watcher saw it; by flush time it is gone. This is what a build
        // writing temporary files looks like.
        assert!(ws.apply(&["temp.o".to_string()]).is_none());
    }

    #[test]
    fn reads_a_text_file() {
        let root = scratch("read");
        fs::write(root.join("a.txt"), "hello world").unwrap();
        let (ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        match ws.read("a.txt") {
            Fs::Content {
                text,
                binary,
                truncated,
                ..
            } => {
                assert_eq!(text, "hello world");
                assert!(!binary && !truncated);
            }
            other => panic!("expected content, got {other:?}"),
        }
    }

    #[test]
    fn flags_binary_instead_of_shipping_it() {
        let root = scratch("binary");
        fs::write(root.join("blob.bin"), [0u8, 1, 2, 3, 0, 9]).unwrap();
        let (ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        match ws.read("blob.bin") {
            Fs::Content { binary, text, .. } => {
                assert!(binary);
                assert!(text.is_empty(), "binary content should not travel");
            }
            other => panic!("expected content, got {other:?}"),
        }
    }

    #[test]
    fn truncates_a_file_over_the_cap() {
        let root = scratch("truncate");
        let big = "a".repeat(MAX_FILE_BYTES + 4096);
        fs::write(root.join("big.txt"), &big).unwrap();
        let (ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        match ws.read("big.txt") {
            Fs::Content {
                text, truncated, ..
            } => {
                assert!(truncated);
                assert_eq!(text.len(), MAX_FILE_BYTES);
            }
            other => panic!("expected content, got {other:?}"),
        }
    }

    #[test]
    fn refuses_to_read_outside_the_workspace() {
        let root = scratch("read-escape");
        let (ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        assert!(matches!(
            ws.read("../../../etc/passwd"),
            Fs::ReadError { .. }
        ));
        assert!(matches!(ws.read("/etc/passwd"), Fs::ReadError { .. }));
    }
}

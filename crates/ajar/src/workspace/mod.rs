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

    /// Everything under a folder that has just appeared, by the same rules as
    /// a full scan, for as long as there is room under the entry limit.
    fn adopt(&mut self, dir: &Path) -> Vec<Entry> {
        let mut added = Vec::new();
        let walker = WalkBuilder::new(dir)
            .hidden(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .follow_links(false)
            .build();
        for dirent in walker.flatten() {
            let path = dirent.path();
            if path == dir {
                continue;
            }
            if self.entries.len() >= MAX_ENTRIES {
                break;
            }
            let is_dir = dirent.file_type().is_some_and(|t| t.is_dir());
            if self.filter.is_ignored(path, is_dir) {
                continue;
            }
            let Some(rel) = self.filter.relative(path) else {
                continue;
            };
            if self.entries.contains_key(&rel) {
                continue;
            }
            let entry = make_entry(rel.clone(), path, is_dir);
            self.entries.insert(rel, entry.clone());
            added.push(entry);
        }
        added
    }

    pub fn filter(&self) -> Arc<Filter> {
        self.filter.clone()
    }

    /// Files, not counting the folders they are in.
    pub fn file_count(&self) -> usize {
        self.entries
            .values()
            .filter(|e| e.kind == EntryKind::File)
            .count()
    }

    /// Everything at or under `path`, as the tree has it; `""` is everything.
    pub fn under(&self, path: &str) -> Vec<Entry> {
        if path.is_empty() {
            return self.entries.values().cloned().collect();
        }
        let inside = format!("{path}/");
        let mut out: Vec<Entry> = self.entries.get(path).cloned().into_iter().collect();
        out.extend(
            self.entries
                .range(inside.clone()..)
                .take_while(|(p, _)| p.starts_with(&inside))
                .map(|(_, e)| e.clone()),
        );
        out
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
                        None => {
                            added.push(entry);
                            // A folder that arrives whole — renamed, moved in,
                            // unpacked — is reported as itself, not as its
                            // contents. It used to appear empty, for good.
                            if is_dir {
                                added.extend(self.adopt(&abs));
                            }
                        }
                    }
                }
                Err(_) => {
                    if self.entries.remove(rel).is_some() {
                        removed.push(rel.clone());
                    }
                    // And a folder that goes takes its contents with it. They
                    // used to stay listed, and counted, under a name that no
                    // longer existed.
                    let inside = format!("{rel}/");
                    let gone: Vec<String> = self
                        .entries
                        .range(inside.clone()..)
                        .take_while(|(path, _)| path.starts_with(&inside))
                        .map(|(path, _)| path.clone())
                        .collect();
                    for path in gone {
                        self.entries.remove(&path);
                        removed.push(path);
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

    /// A file's text, if guests can edit it as text — or why they cannot.
    ///
    /// Stricter than `read`, which is for looking: anything editing would
    /// write back wrongly is refused. A file that is not UTF-8 reaches the
    /// editor with its foreign bytes replaced, and the first keystroke wrote
    /// the replacements to disk. And the browser's editor keeps one kind of
    /// line ending per file and drops a byte-order mark, so every offset in a
    /// file with either was off by one per oddity — an edit made after the
    /// mark landed a character early.
    pub fn editable(&self, rel: &str) -> std::result::Result<String, String> {
        let path = self
            .filter
            .resolve_shared(rel)
            .ok_or_else(|| "deleted, moved or no longer shared".to_string())?;
        let meta = std::fs::metadata(&path).map_err(|_| "deleted or moved".to_string())?;
        if meta.is_dir() {
            return Err("a directory".into());
        }
        if meta.len() as usize > MAX_FILE_BYTES {
            return Err("too large to edit — over 1 MB".into());
        }
        let bytes = read_prefix(&path, MAX_FILE_BYTES).map_err(|e| e.to_string())?;
        if bytes.iter().take(8192).any(|b| *b == 0) {
            return Err("binary file".into());
        }
        let text = String::from_utf8(bytes).map_err(|_| {
            "not UTF-8 text, so editing would change bytes nobody typed".to_string()
        })?;
        if text.starts_with('\u{feff}') {
            return Err("starts with a byte-order mark, which the editor would drop".into());
        }
        if !one_kind_of_line_ending(&text) {
            return Err("mixed line endings, which the editor would change".into());
        }
        Ok(text)
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
            .resolve_shared(rel)
            .with_context(|| format!("{rel} is not shared"))?;
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

/// Only `\n`, or only `\r\n` — what the browser's editor keeps as it is.
fn one_kind_of_line_ending(text: &str) -> bool {
    let bytes = text.as_bytes();
    let (mut crlf, mut lf) = (false, false);
    for (i, b) in bytes.iter().enumerate() {
        match b {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => crlf = true,
            // A carriage return on its own: classic Mac, or stray.
            b'\r' => return false,
            b'\n' if i == 0 || bytes[i - 1] != b'\r' => lf = true,
            _ => {}
        }
    }
    !(crlf && lf)
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
    fn a_read_by_path_is_refused_what_the_tree_hides() {
        // The tree never lists these; a read asked for by name used to return
        // them anyway — `.git/config` with a remote's token in it, a
        // gitignored `.env` — to read-only guests too.
        let root = scratch("hidden-reads");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("secrets")).unwrap();
        fs::write(
            root.join(".git/config"),
            "[remote] url = https://user:token@x",
        )
        .unwrap();
        fs::write(root.join(".gitignore"), ".env\nsecrets/\n").unwrap();
        fs::write(root.join(".env"), "PASSWORD=hunter2").unwrap();
        fs::write(root.join("secrets/key.txt"), "TOP SECRET").unwrap();
        fs::write(root.join("README.md"), "# shared").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join(".env"), root.join("innocent.txt")).unwrap();

        let (ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        let refused = |p: &str| matches!(ws.read(p), Fs::ReadError { .. });
        assert!(refused(".git/config"), ".git/config was readable");
        assert!(refused(".env"), "a gitignored file was readable");
        assert!(
            refused("secrets/key.txt"),
            "a file in a gitignored folder was readable"
        );
        #[cfg(unix)]
        assert!(
            refused("innocent.txt"),
            "a link to a hidden file was readable"
        );
        assert!(
            matches!(ws.read("README.md"), Fs::Content { .. }),
            "an ordinary file stopped being readable"
        );
    }

    #[test]
    fn a_folder_renamed_or_moved_in_arrives_with_what_is_in_it() {
        let root = scratch("rename-dir");
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/a.rs"), "a").unwrap();
        fs::write(root.join("src/nested/b.rs"), "b").unwrap();
        fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        let (mut ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();

        // What the watcher reports for `mv src lib`: the two names, nothing inside.
        fs::rename(root.join("src"), root.join("lib")).unwrap();
        fs::write(root.join("lib/skip.log"), "ignored").unwrap();
        let Some(Fs::Patch { added, removed, .. }) = ws.apply(&["src".into(), "lib".into()]) else {
            panic!("no patch")
        };
        let added: Vec<_> = added.iter().map(|e| e.path.as_str()).collect();
        for path in ["lib", "lib/a.rs", "lib/nested", "lib/nested/b.rs"] {
            assert!(added.contains(&path), "{path} missing from {added:?}");
        }
        assert!(
            !added.contains(&"lib/skip.log"),
            "ignored files stay hidden"
        );
        for path in ["src", "src/a.rs", "src/nested", "src/nested/b.rs"] {
            assert!(
                removed.contains(&path.to_string()),
                "{path} still listed: {removed:?}"
            );
        }
        let listed = paths(&ws.tree());
        assert!(listed.iter().all(|p| !p.starts_with("src")), "{listed:?}");
        assert!(
            listed.contains(&"lib/nested/b.rs".to_string()),
            "{listed:?}"
        );
    }

    #[test]
    fn only_files_the_editor_keeps_byte_for_byte_are_editable() {
        let root = scratch("editable");
        let files: &[(&str, &[u8], bool)] = &[
            ("plain.txt", b"one\ntwo\n", true),
            ("windows.txt", b"one\r\ntwo\r\n", true),
            ("empty.txt", b"", true),
            ("emoji.txt", "caf\u{e9} \u{1f600}\n".as_bytes(), true),
            ("latin1.txt", b"caf\xe9 na\xefve\n", false),
            ("bom.txt", b"\xef\xbb\xbfhello\n", false),
            ("mixed.txt", b"one\r\ntwo\n", false),
            ("mac.txt", b"one\rtwo\r", false),
            ("binary.bin", b"\x89PNG\0\0", false),
        ];
        for (name, bytes, _) in files {
            fs::write(root.join(name), bytes).unwrap();
        }
        fs::write(root.join("big.txt"), vec![b'a'; MAX_FILE_BYTES + 1]).unwrap();
        let (ws, _) = Workspace::scan(&root, MAX_ENTRIES).unwrap();
        for (name, bytes, editable) in files {
            match ws.editable(name) {
                Ok(text) => {
                    assert!(editable, "{name} should not be editable");
                    assert_eq!(text.as_bytes(), *bytes, "{name} came back changed");
                }
                Err(why) => assert!(!editable, "{name} refused: {why}"),
            }
        }
        assert!(ws.editable("big.txt").is_err());
        assert!(ws.editable("gone.txt").is_err());
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

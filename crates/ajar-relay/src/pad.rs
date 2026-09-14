//! Durable folders for the browser tier.
//!
//! Everything else in this binary is deliberately amnesiac — `session.rs` says
//! outright that losing every session on restart is *correct*, because an
//! agent reconnects and rebuilds what was lost. This module is the opposite by
//! necessity: a pad has no agent anywhere, so if the server forgets it, it is
//! gone. Two lifetimes in one process, kept apart on purpose.
//!
//! The shape is small: a folder is a name, a sequence number, and a map of
//! paths to contents, stored as one JSON document per pad. No database,
//! nothing to migrate, and a pad is legible with `cat` when something is
//! wrong. The caps are what keep that honest.
//!
//! **Names are never reused.** A lease that lapses deletes the *contents* and
//! leaves a tombstone behind, so a link shared in a tutorial can never later
//! resolve to a stranger's files. A name costs a few bytes to remember
//! forever, which is nothing next to the class of problem it removes.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Total bytes one pad may hold. Matches the snapshot cap the agent tier uses.
pub const MAX_BYTES: usize = 25 * 1024 * 1024;

/// Files one pad may hold.
///
/// Far below the agent tier's 5,000, and deliberately: a pad is a scratchpad
/// someone pasted three files into, and every write walks the whole tree
/// because the runtime reports no modification times. A cap that keeps that
/// walk trivial is worth more here than room nobody asked for.
pub const MAX_FILES: usize = 500;

/// How long an untouched pad survives. Restarted by any write.
pub const LEASE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub const MAX_NAME: usize = 64;

/// Paths this server answers on for its own reasons. A pad can never take one,
/// and the list has to be complete *before* the first name is handed out —
/// there is no taking `api` back once somebody owns it.
pub const RESERVED: &[&str] = &[
    // Served by the relay.
    "ws", "healthz", "install", "run", "j", "api",
    // Served by the web server in front of it. `packages` and `sw` were
    // missing until an audit found them: the browser tier serves `/packages/*`
    // for the mirrored wasm and `/sw.js` for the worker that rewrites it, and
    // a pad holding either name would have sat underneath a real path.
    "assets", "vendor", "packages", "static", "sw", "index", "public", "dist",
    // Kept back for things that do not exist yet, because a name cannot be
    // taken back once somebody owns it.
    "admin", "login", "logout", "signup", "account", "settings", "new", "about", "terms", "privacy",
    "pricing", "docs", "help", "status", "favicon", "robots", "sitemap",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    /// The common case, and the only one a text editor produces.
    Utf8,
    /// Anything that is not valid UTF-8. Costs a third more to store, which is
    /// why it is not the default for everything.
    Base64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct File {
    pub content: String,
    pub encoding: Encoding,
    /// The sequence this file last changed at. Lets a client that has fallen
    /// behind ask what moved without re-reading the whole folder.
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pad {
    /// Bumped once per accepted write. The server owns this because browsers
    /// cannot agree on a clock — skew and a user-settable system time make
    /// wall time useless for ordering, and last-write-wins needs an order.
    pub seq: u64,
    pub created_ms: u64,
    pub updated_ms: u64,
    pub files: BTreeMap<String, File>,
}

impl Pad {
    fn new(now_ms: u64) -> Self {
        Self {
            seq: 0,
            created_ms: now_ms,
            updated_ms: now_ms,
            files: BTreeMap::new(),
        }
    }

    pub fn bytes(&self) -> usize {
        self.files.values().map(|f| f.content.len()).sum()
    }

    fn expired(&self, now_ms: u64) -> bool {
        now_ms.saturating_sub(self.updated_ms) > LEASE.as_millis() as u64
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// Not a shape a name may take.
    BadName(&'static str),
    /// The name is ours.
    Reserved,
    /// Held once, expired, and never coming back.
    Gone,
    /// A path inside the pad that we will not store.
    BadPath(&'static str),
    TooBig {
        bytes: usize,
    },
    TooManyFiles,
    Io(String),
}

impl Error {
    pub fn message(&self) -> String {
        match self {
            Error::BadName(why) => format!("that name will not work: {why}"),
            Error::Reserved => "that name is reserved".into(),
            Error::Gone => "this pad expired and its name will not be reused".into(),
            Error::BadPath(why) => format!("that file path will not work: {why}"),
            Error::TooBig { bytes } => format!(
                "{:.1} MB is over the {} MB limit",
                *bytes as f64 / (1024.0 * 1024.0),
                MAX_BYTES / (1024 * 1024)
            ),
            Error::TooManyFiles => format!("a pad holds at most {MAX_FILES} files"),
            Error::Io(e) => format!("could not store that: {e}"),
        }
    }
}

/// A name that is safe to use as a filename and readable in a URL.
pub fn check_name(name: &str) -> Result<(), Error> {
    if name.is_empty() {
        return Err(Error::BadName("it is empty"));
    }
    if name.len() > MAX_NAME {
        return Err(Error::BadName("it is too long"));
    }
    // Strict enough that the name *is* the filename with no escaping, which is
    // the only reason the store can be a directory of flat files.
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(Error::BadName(
            "use lowercase letters, digits and dashes only",
        ));
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err(Error::BadName("it cannot start or end with a dash"));
    }
    if RESERVED.contains(&name) {
        return Err(Error::Reserved);
    }
    Ok(())
}

/// A path inside a pad.
///
/// These never touch the filesystem — a pad is one JSON document — but they do
/// reach other people's browsers, where a `..` would be handed to a runtime
/// that resolves it. Refusing them here is cheaper than trusting every client.
pub fn check_path(path: &str) -> Result<(), Error> {
    if path.is_empty() {
        return Err(Error::BadPath("it is empty"));
    }
    if path.len() > 512 {
        return Err(Error::BadPath("it is too long"));
    }
    if path.starts_with('/') || path.contains('\\') {
        return Err(Error::BadPath("it must be relative, with forward slashes"));
    }
    if path
        .split('/')
        .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(Error::BadPath("it contains an empty or relative segment"));
    }
    if path.contains('\0') {
        return Err(Error::BadPath("it contains a null byte"));
    }
    Ok(())
}

/// One write to apply. Absent `content` removes the file.
#[derive(Debug, Clone, Deserialize)]
pub struct Write {
    pub path: String,
    pub content: Option<String>,
    #[serde(default = "utf8")]
    pub encoding: Encoding,
}

fn utf8() -> Encoding {
    Encoding::Utf8
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// How many locks guard the pads.
///
/// Striped rather than one per name: a lock map keyed by pad would grow for
/// the life of the process, and this is a server that is meant to run for
/// months. Sixty-four is far more than the concurrency a scratchpad sees, so
/// two pads sharing a stripe is a theoretical wait, not a real one.
const STRIPES: usize = 64;

pub struct Store {
    dir: PathBuf,
    /// Serialises the read-modify-write in `write`.
    ///
    /// Without it two saves to one pad both read the same starting point and
    /// the second discards the first — and they collided on the temporary file
    /// as well, so the loser did not even fail quietly: it failed with
    /// `No such file or directory` after the winner renamed the file away.
    /// Two people typing in one folder is the ordinary case here, not an edge.
    stripes: Vec<Mutex<()>>,
}

impl Store {
    pub fn open(dir: impl Into<PathBuf>) -> std::io::Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            stripes: (0..STRIPES).map(|_| Mutex::new(())).collect(),
        })
    }

    fn stripe(&self, name: &str) -> &Mutex<()> {
        let mut h: usize = 0;
        for b in name.bytes() {
            h = h.wrapping_mul(31).wrapping_add(b as usize);
        }
        &self.stripes[h % STRIPES]
    }

    fn pad_path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.json"))
    }

    fn tomb_path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.tomb"))
    }

    /// Read a pad. `Ok(None)` means the name is free.
    pub fn get(&self, name: &str) -> Result<Option<Pad>, Error> {
        check_name(name)?;
        if self.tomb_path(name).exists() {
            return Err(Error::Gone);
        }
        let raw = match std::fs::read(self.pad_path(name)) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::Io(e.to_string())),
        };
        let pad: Pad = serde_json::from_slice(&raw).map_err(|e| Error::Io(e.to_string()))?;
        // Checked on the way out as well as by the sweeper, so a pad is never
        // served past its lease just because nothing has swept recently.
        if pad.expired(now_ms()) {
            self.entomb(name)?;
            return Err(Error::Gone);
        }
        Ok(Some(pad))
    }

    /// Apply writes and removals, and return the new sequence number.
    ///
    /// Last write wins, and this is where "last" is decided: the server stamps
    /// the order because no two browsers can agree on one.
    pub fn write(&self, name: &str, writes: &[Write]) -> Result<u64, Error> {
        check_name(name)?;
        for w in writes {
            check_path(&w.path)?;
        }

        // Held across the read, the change and the save. Blocking I/O under a
        // lock in an async handler is not free, but a pad is one small JSON
        // document and the alternative is losing writes.
        let _guard = self.stripe(name).lock();

        if self.tomb_path(name).exists() {
            return Err(Error::Gone);
        }

        let now = now_ms();
        let mut pad = match self.get(name)? {
            Some(pad) => pad,
            None => Pad::new(now),
        };

        pad.seq += 1;
        pad.updated_ms = now;
        for w in writes {
            match &w.content {
                Some(content) => {
                    pad.files.insert(
                        w.path.clone(),
                        File {
                            content: content.clone(),
                            encoding: w.encoding,
                            seq: pad.seq,
                        },
                    );
                }
                None => {
                    pad.files.remove(&w.path);
                }
            }
        }

        // Checked after applying rather than before: a write that replaces a
        // large file with a small one should be allowed even when the pad was
        // already at the limit.
        if pad.files.len() > MAX_FILES {
            return Err(Error::TooManyFiles);
        }
        let bytes = pad.bytes();
        if bytes > MAX_BYTES {
            return Err(Error::TooBig { bytes });
        }

        self.save(name, &pad)?;
        Ok(pad.seq)
    }

    fn save(&self, name: &str, pad: &Pad) -> Result<(), Error> {
        let body = serde_json::to_vec(pad).map_err(|e| Error::Io(e.to_string()))?;
        // Written beside the target and renamed over it. A half-written pad
        // that a restart then tries to parse is worse than a lost write.
        // Unique per call, not per process. Sharing one temporary path meant
        // concurrent writers clobbered each other's file before the rename.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = self
            .dir
            .join(format!(".{name}.{}.{n}.tmp", std::process::id()));
        std::fs::write(&tmp, &body).map_err(|e| Error::Io(e.to_string()))?;
        std::fs::rename(&tmp, self.pad_path(name)).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            Error::Io(e.to_string())
        })
    }

    /// Delete the contents, keep the name forever.
    fn entomb(&self, name: &str) -> Result<(), Error> {
        std::fs::write(self.tomb_path(name), b"").map_err(|e| Error::Io(e.to_string()))?;
        match std::fs::remove_file(self.pad_path(name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::Io(e.to_string())),
        }
    }

    /// Entomb everything past its lease. Returns the names reaped.
    pub fn sweep(&self) -> Vec<String> {
        let now = now_ms();
        let mut reaped = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return reaped;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(name) = stem(&path) else { continue };
            let Ok(raw) = std::fs::read(&path) else {
                continue;
            };
            let Ok(pad) = serde_json::from_slice::<Pad>(&raw) else {
                continue;
            };
            if pad.expired(now) && self.entomb(&name).is_ok() {
                reaped.push(name);
            }
        }
        reaped
    }
}

fn stem(path: &Path) -> Option<String> {
    path.file_stem()?.to_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, tempdir::Dir) {
        let dir = tempdir::Dir::new();
        let store = Store::open(dir.path()).unwrap();
        (store, dir)
    }

    fn put(path: &str, content: &str) -> Write {
        Write {
            path: path.into(),
            content: Some(content.into()),
            encoding: Encoding::Utf8,
        }
    }

    /// A directory that cleans itself up. Not worth a dependency.
    mod tempdir {
        use std::path::{Path, PathBuf};
        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new() -> Self {
                // A counter, not just the clock. Tests are threads in one
                // process, so the pid is the same for all of them, and two
                // starting inside one clock tick got the same directory —
                // whichever finished first deleted the other's files on the
                // way out, and the loser failed with "No such file or
                // directory" somewhere unrelated.
                //
                // The same shape as the bug in `save` below, in the helper
                // that was never looked at while fixing it.
                static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                let p = std::env::temp_dir().join(format!(
                    "ajar-pad-test-{}-{:?}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                ));
                std::fs::create_dir_all(&p).unwrap();
                Self(p)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn two_temp_directories_are_never_the_same_one() {
        // The clock alone was not enough. Tests are threads in one process, so
        // the pid never differs, and two `Dir::new()` calls inside one tick
        // produced one directory with two owners — the first to finish deleted
        // it, and the second failed somewhere that looked unrelated.
        //
        // Threads rather than a loop, because a loop advances the clock enough
        // to hide it: the collision needs genuine concurrency to appear.
        let paths: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..32)
                .map(|_| scope.spawn(|| tempdir::Dir::new().path().to_path_buf()))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let unique: std::collections::HashSet<_> = paths.iter().collect();
        assert_eq!(unique.len(), paths.len(), "two temp directories collided");
    }

    #[test]
    fn a_name_nobody_holds_reads_as_free() {
        let (s, _d) = store();
        assert!(s.get("demowork").unwrap().is_none());
    }

    #[test]
    fn writing_creates_the_pad() {
        let (s, _d) = store();
        assert_eq!(
            s.write("demowork", &[put("main.py", "print(1)")]).unwrap(),
            1
        );
        let pad = s.get("demowork").unwrap().unwrap();
        assert_eq!(pad.files["main.py"].content, "print(1)");
        assert_eq!(pad.seq, 1);
    }

    #[test]
    fn the_sequence_advances_once_per_write() {
        // It is the ordering last-write-wins depends on, and browsers cannot
        // supply one.
        let (s, _d) = store();
        assert_eq!(s.write("p", &[put("a", "1")]).unwrap(), 1);
        assert_eq!(s.write("p", &[put("b", "2")]).unwrap(), 2);
        let pad = s.get("p").unwrap().unwrap();
        assert_eq!(
            pad.files["a"].seq, 1,
            "an untouched file keeps its sequence"
        );
        assert_eq!(pad.files["b"].seq, 2);
    }

    #[test]
    fn a_write_with_no_content_removes_the_file() {
        let (s, _d) = store();
        s.write("p", &[put("gone.txt", "x")]).unwrap();
        s.write(
            "p",
            &[Write {
                path: "gone.txt".into(),
                content: None,
                encoding: Encoding::Utf8,
            }],
        )
        .unwrap();
        assert!(!s.get("p").unwrap().unwrap().files.contains_key("gone.txt"));
    }

    #[test]
    fn a_pad_survives_the_process_that_made_it() {
        // The entire reason this module exists. Nothing else in this binary
        // would care.
        let dir = tempdir::Dir::new();
        {
            let s = Store::open(dir.path()).unwrap();
            s.write("keeper", &[put("main.py", "print(1)")]).unwrap();
        }
        let reopened = Store::open(dir.path()).unwrap();
        assert_eq!(
            reopened.get("keeper").unwrap().unwrap().files["main.py"].content,
            "print(1)"
        );
    }

    #[test]
    fn reserved_names_are_refused() {
        let (s, _d) = store();
        for name in ["api", "healthz", "ws", "new"] {
            assert_eq!(
                s.write(name, &[put("a", "1")]).err(),
                Some(Error::Reserved),
                "{name} should be reserved"
            );
        }
    }

    #[test]
    fn every_path_the_site_serves_is_reserved() {
        // The list has to be complete before the first name is handed out —
        // there is no taking `packages` back once a pad owns it. These are the
        // prefixes the two origins actually answer on.
        for path in [
            "ws", "healthz", "install", "run", "j", "api", "assets", "vendor", "packages", "sw",
        ] {
            assert_eq!(
                check_name(path).err(),
                Some(Error::Reserved),
                "{path} is served but claimable"
            );
        }
    }

    #[test]
    fn a_name_has_to_be_a_safe_filename() {
        // The store is a flat directory and the name *is* the filename, so
        // this check is the only thing between a URL and the parent directory.
        let (s, _d) = store();
        for bad in [
            "../etc/passwd",
            "Has Capitals",
            "with/slash",
            "",
            "-leading",
        ] {
            assert!(
                matches!(s.get(bad), Err(Error::BadName(_)) | Err(Error::Reserved)),
                "{bad:?} should be refused"
            );
        }
    }

    #[test]
    fn a_path_cannot_climb_out_of_the_pad() {
        let (s, _d) = store();
        for bad in ["../outside", "/absolute", "a/../../b", "back\\slash", ""] {
            assert!(
                matches!(s.write("p", &[put(bad, "x")]), Err(Error::BadPath(_))),
                "{bad:?} should be refused"
            );
        }
    }

    #[test]
    fn a_pad_that_is_too_big_is_refused_whole() {
        let (s, _d) = store();
        let big = "x".repeat(MAX_BYTES + 1);
        assert!(matches!(
            s.write("p", &[put("big.bin", &big)]),
            Err(Error::TooBig { .. })
        ));
        assert!(
            s.get("p").unwrap().is_none(),
            "a refused write must leave nothing behind"
        );
    }

    #[test]
    fn replacing_a_large_file_with_a_small_one_is_allowed() {
        // The cap is checked after applying, not before, or a full pad could
        // never be emptied.
        let (s, _d) = store();
        s.write("p", &[put("big", &"x".repeat(MAX_BYTES - 10))])
            .unwrap();
        assert!(s.write("p", &[put("big", "small")]).is_ok());
    }

    #[test]
    fn too_many_files_is_refused() {
        let (s, _d) = store();
        let writes: Vec<Write> = (0..=MAX_FILES)
            .map(|i| put(&format!("f{i}"), "x"))
            .collect();
        assert_eq!(s.write("p", &writes).err(), Some(Error::TooManyFiles));
    }

    #[test]
    fn an_expired_pad_is_gone_and_its_name_never_comes_back() {
        // The failure this prevents: a link shared in a tutorial resolving, a
        // week later, to whatever a stranger uploaded under the same name.
        let (s, _d) = store();
        s.write("demowork", &[put("a", "1")]).unwrap();

        // Age it past the lease by rewriting the stored timestamp.
        let path = s.pad_path("demowork");
        let mut pad: Pad = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pad.updated_ms = now_ms() - LEASE.as_millis() as u64 - 1;
        std::fs::write(&path, serde_json::to_vec(&pad).unwrap()).unwrap();

        assert_eq!(s.get("demowork").err(), Some(Error::Gone));
        assert_eq!(
            s.write("demowork", &[put("b", "2")]).err(),
            Some(Error::Gone),
            "a tombstoned name must not be claimable again"
        );
    }

    #[test]
    fn the_sweeper_entombs_only_what_is_past_its_lease() {
        let (s, _d) = store();
        s.write("fresh", &[put("a", "1")]).unwrap();
        s.write("stale", &[put("a", "1")]).unwrap();

        let path = s.pad_path("stale");
        let mut pad: Pad = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pad.updated_ms = now_ms() - LEASE.as_millis() as u64 - 1;
        std::fs::write(&path, serde_json::to_vec(&pad).unwrap()).unwrap();

        assert_eq!(s.sweep(), vec!["stale".to_string()]);
        assert!(s.get("fresh").unwrap().is_some());
        assert_eq!(s.get("stale").err(), Some(Error::Gone));
    }

    #[test]
    fn concurrent_writes_do_not_lose_each_other() {
        // `write` reads the pad, applies, and saves it back. Two of them at
        // once both read the same starting point and the second overwrites
        // the first — and the relay is a tokio server, so two requests for one
        // pad genuinely do overlap.
        use std::sync::Arc;
        let dir = tempdir::Dir::new();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        store.write("p", &[put("seed", "0")]).unwrap();

        let hands: Vec<_> = (0..8)
            .map(|i| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store.write("p", &[put(&format!("f{i}"), "x")]).unwrap();
                })
            })
            .collect();
        for h in hands {
            h.join().unwrap();
        }

        let pad = store.get("p").unwrap().unwrap();
        assert_eq!(
            pad.files.len(),
            9,
            "writes were lost: {:?}",
            pad.files.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_write_restarts_the_lease() {
        let (s, _d) = store();
        s.write("p", &[put("a", "1")]).unwrap();
        let first = s.get("p").unwrap().unwrap().updated_ms;
        std::thread::sleep(std::time::Duration::from_millis(5));
        s.write("p", &[put("a", "2")]).unwrap();
        assert!(s.get("p").unwrap().unwrap().updated_ms > first);
    }
}

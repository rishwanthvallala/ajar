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
//! **A lapsed name is free again.** A pad nobody writes to for a week is
//! deleted, and whoever opens that name next starts an empty folder there.
//!
//! Until September 2026 the opposite was true: a lapse left a tombstone and the
//! name answered 410 "will not be reused" forever. The reason was real — a link
//! in a tutorial could later show whatever a stranger put under the same name —
//! but the cost landed on the names people actually use: `/demo` became a page
//! that could only refuse, permanently, and the tombstones were an
//! ever-growing count nobody could reclaim. The trade was reversed on purpose.
//! An old link now opens an empty folder, or somebody else's newer one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

/// Total bytes one pad may hold. Matches the snapshot cap the agent tier uses.
pub const MAX_BYTES: usize = 25 * 1024 * 1024;

/// Files one pad may hold.
///
/// Far below the agent tier's 5,000, and deliberately: a pad is a scratchpad
/// someone pasted three files into, and every write walks the whole tree
/// because the runtime reports no modification times. A cap that keeps that
/// walk trivial is worth more here than room nobody asked for.
pub const MAX_FILES: usize = 500;

/// Bytes every pad in the store may add up to.
///
/// The per-pad cap bounds one folder; nothing bounded the sum, and pads cost
/// nothing to create. At 25 MiB each, roughly 640 writes fill a 16 GB disk, and
/// the seven-day lease is no help against something that takes an afternoon —
/// a full disk stops the relay saving anything, including the pads belonging to
/// people who were using it properly.
///
/// Chosen to be survivable rather than generous: well under the free space on
/// the box this runs on, so filling it is an error somebody sees rather than an
/// outage. The number is the *serialised* size on disk, which is what actually
/// competes for the disk.
pub const MAX_STORE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// How long an untouched pad survives. Restarted by any write.
pub const LEASE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub const MAX_NAME: usize = 64;

/// Paths this server answers on for its own reasons. A pad can never take one,
/// and the list has to be complete *before* the first name is handed out —
/// there is no taking `api` back once somebody owns it.
pub const RESERVED: &[&str] = &[
    // Served by the relay.
    "ws",
    "healthz",
    "install",
    "run",
    "j",
    "api",
    // Served by the web server in front of it. `packages` and `sw` were
    // missing until an audit found them: the browser tier serves `/packages/*`
    // for the mirrored wasm and `/sw.js` for the worker that rewrites it, and
    // a pad holding either name would have sat underneath a real path.
    "assets",
    "vendor",
    "packages",
    "static",
    "sw",
    "index",
    "public",
    "dist",
    // The pad's egress endpoint and the DNS it resolves through, both proxied
    // by Caddy on this origin. Added after they were built and not reserved —
    // a pad called `wisp` would have been shadowed by the route, its contents
    // unreachable, which is the exact failure this list exists to prevent.
    "wisp",
    "dns-query",
    // Kept back for things that do not exist yet, because a name cannot be
    // taken back once somebody owns it.
    "admin",
    "login",
    "logout",
    "signup",
    "account",
    "settings",
    "new",
    "about",
    "terms",
    "privacy",
    "pricing",
    "docs",
    "help",
    "status",
    "favicon",
    "robots",
    "sitemap",
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
        lease_lapsed(self.updated_ms, now_ms)
    }
}

fn lease_lapsed(updated_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(updated_ms) > LEASE.as_millis() as u64
}

/// When a stored pad was last written, read without loading it: the parse keeps
/// `updated_ms` and skips everything else without allocating it.
fn updated_ms(file: &std::fs::File) -> Result<u64, Error> {
    #[derive(Deserialize)]
    struct Lease {
        updated_ms: u64,
    }
    serde_json::from_reader::<_, Lease>(std::io::BufReader::new(file))
        .map(|lease| lease.updated_ms)
        .map_err(|e| Error::Io(e.to_string()))
}

/// A stored pad opened for streaming: the file positioned just past its
/// opening brace, and how many bytes follow.
///
/// Past the brace so a caller can put its own fields in front — the stored
/// document already *is* the response, apart from `exists`.
pub struct Opened {
    pub file: std::fs::File,
    pub remaining: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// Not a shape a name may take.
    BadName(&'static str),
    /// The name is ours.
    Reserved,
    /// A path inside the pad that we will not store.
    BadPath(&'static str),
    TooBig {
        bytes: usize,
    },
    TooManyFiles,
    /// Every pad together is at the ceiling. Nothing to do with *this* pad.
    StoreFull,
    Io(String),
}

impl Error {
    pub fn message(&self) -> String {
        match self {
            Error::BadName(why) => format!("that name will not work: {why}"),
            Error::Reserved => "that name is reserved".into(),
            Error::BadPath(why) => format!("that file path will not work: {why}"),
            Error::TooBig { bytes } => format!(
                "{:.1} MB is over the {} MB limit",
                *bytes as f64 / (1024.0 * 1024.0),
                MAX_BYTES / (1024 * 1024)
            ),
            Error::TooManyFiles => format!("a pad holds at most {MAX_FILES} files"),
            // Deliberately says it is not the caller's fault. Somebody who has
            // just pasted four lines and been refused should not go looking for
            // what is wrong with their four lines.
            Error::StoreFull => "this server is out of room for new pads — try again later".into(),
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
    /// The ceiling this store enforces. A field rather than the constant so a
    /// smaller disk can say so, and so a test can reach it without writing 4 GB.
    ceiling: u64,
    /// Serialised bytes currently on disk, maintained rather than measured.
    ///
    /// Counted once at startup and adjusted by every save and every expiry.
    /// The alternative is walking the directory per write, which is the cost
    /// the file-count cap exists to avoid — and the sweeper already shows what
    /// a full scan costs when it does one hourly.
    used: AtomicU64,
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
    /// The ceiling is always explicit. There was a convenience `open` applying
    /// the default, and with one real caller passing a flag it was only ever
    /// reached from tests — a constructor that exists for tests is how a default
    /// diverges from what production runs.
    pub fn open(dir: impl Into<PathBuf>, ceiling: u64) -> std::io::Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;

        // `<name>.tomb` is what the old policy left for every lapsed name, and
        // each one sealed that name for good. Nothing reads them any more;
        // removing them is what hands `/demo` and the rest back.
        let tombs: Vec<PathBuf> = std::fs::read_dir(&dir)?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "tomb"))
            .collect();
        let freed = tombs
            .iter()
            .filter(|p| std::fs::remove_file(p).is_ok())
            .count();
        if freed > 0 {
            tracing::info!(freed, "cleared tombstones — those names are free again");
        }

        let used = std::fs::read_dir(&dir)?
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum();
        Ok(Self {
            dir,
            ceiling,
            used: AtomicU64::new(used),
            stripes: (0..STRIPES).map(|_| Mutex::new(())).collect(),
        })
    }

    /// Serialised bytes the store is holding right now.
    pub fn used(&self) -> u64 {
        self.used.load(Ordering::Relaxed)
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

    /// Read a pad. `Ok(None)` means the name is free — nobody has written it,
    /// or its lease lapsed.
    ///
    /// An expired pad reads as free here rather than being deleted: deletion
    /// belongs to the sweeper, under the pad's lock, so that no reader can
    /// remove a pad that a write replaced after the reader looked.
    pub fn get(&self, name: &str) -> Result<Option<Pad>, Error> {
        check_name(name)?;
        let raw = match std::fs::read(self.pad_path(name)) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::Io(e.to_string())),
        };
        let pad: Pad = serde_json::from_slice(&raw).map_err(|e| Error::Io(e.to_string()))?;
        // Checked on the way out as well as by the sweeper, so a pad is never
        // served past its lease just because nothing has swept recently.
        Ok((!pad.expired(now_ms())).then_some(pad))
    }

    /// Open a pad to be streamed to a reader, without loading it. `Ok(None)`
    /// means the name is free.
    ///
    /// `get` holds the file, the parsed pad and — once the handler serialised
    /// it — the response at the same time: about three times the pad, per read,
    /// with nothing bounding how many ran together. Twelve concurrent reads of a
    /// 24 MiB pad grew the relay by 647 MiB, past the unit's `MemoryMax=512M`.
    ///
    /// Here the lease is checked by a pass that parses `updated_ms` and skips
    /// everything else without allocating it, and the file itself is what gets
    /// sent. One descriptor serves both, so the check and the bytes are the
    /// same version even if a write renames a new one into place meanwhile.
    pub fn open_for_read(&self, name: &str) -> Result<Option<Opened>, Error> {
        use std::io::{Read, Seek, SeekFrom};

        check_name(name)?;
        let io = |e: std::io::Error| Error::Io(e.to_string());
        let mut file = match std::fs::File::open(self.pad_path(name)) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io(e)),
        };
        // Lapsed reads as free, the same as `get`, and for the same reason is
        // left for the sweeper to delete.
        if lease_lapsed(updated_ms(&file)?, now_ms()) {
            return Ok(None);
        }

        file.seek(SeekFrom::Start(0)).map_err(io)?;
        let mut brace = [0u8; 1];
        file.read_exact(&mut brace).map_err(io)?;
        if brace != *b"{" {
            return Err(Error::Io("a stored pad is not a JSON object".into()));
        }
        let remaining = file.metadata().map_err(io)?.len() - 1;
        Ok(Some(Opened { file, remaining }))
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

        // A lapsed pad reads as `None`, so writing to its name starts a fresh
        // one, and the save replaces the old file rather than adding to it.
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

        // A path cannot be both a file and a directory. Validate the resulting
        // pad so conflicts are caught even when the two paths arrive in
        // separate requests.
        for path in pad.files.keys() {
            for (slash, _) in path.match_indices('/') {
                if pad.files.contains_key(&path[..slash]) {
                    return Err(Error::BadPath("a file is also used as a directory"));
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

        // What this write costs the store, as a delta against whatever the name
        // already occupied. Replacing a large pad with a small one has to give
        // the difference back, or the ceiling ratchets shut on ordinary use.
        let was = std::fs::metadata(self.pad_path(name))
            .map(|m| m.len())
            .unwrap_or(0);
        let now = body.len() as u64;
        if now > was {
            let after = self.used.load(Ordering::Relaxed) + (now - was);
            if after > self.ceiling {
                return Err(Error::StoreFull);
            }
        }

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
        })?;
        // Only once the rename landed. Counting before it would charge the
        // store for bytes that never reached the disk.
        if now >= was {
            self.used.fetch_add(now - was, Ordering::Relaxed);
        } else {
            self.used.fetch_sub(was - now, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Delete a pad whose lease has lapsed, and give its bytes back. True if it
    /// did.
    ///
    /// Decided and done under the pad's lock, looking at the file as it is now.
    /// Deciding from an earlier read and then deleting by path would remove
    /// whatever a write had renamed onto that path in between — a fresh pad,
    /// written by somebody who had just started using the name.
    pub fn expire_if_lapsed(&self, name: &str) -> bool {
        let _guard = self.stripe(name).lock();
        let path = self.pad_path(name);
        let Ok(file) = std::fs::File::open(&path) else {
            return false;
        };
        let Ok(updated) = updated_ms(&file) else {
            return false;
        };
        if !lease_lapsed(updated, now_ms()) {
            return false;
        }
        let freed = file.metadata().map(|m| m.len()).unwrap_or(0);
        drop(file);
        if std::fs::remove_file(&path).is_err() {
            return false;
        }
        self.used.fetch_sub(freed, Ordering::Relaxed);
        true
    }

    /// Delete everything past its lease, freeing the names. Returns them.
    pub fn sweep(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
            .filter_map(|path| stem(&path))
            .filter(|name| self.expire_if_lapsed(name))
            .collect()
    }
}

fn stem(path: &Path) -> Option<String> {
    path.file_stem()?.to_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pad ~1 MiB on disk, so a ceiling can be reached without writing 4 GB.
    fn megabyte(s: &Store, name: &str) -> Result<u64, Error> {
        s.write(name, &[put("big.txt", &"x".repeat(1024 * 1024))])
    }

    #[test]
    fn the_store_refuses_once_every_pad_together_reaches_the_ceiling() {
        // The vector this exists for: pads are free to create, so ~640 writes
        // at the per-pad cap fill a 16 GB disk and the relay can then save
        // nothing at all — including for the people who were using it properly.
        let dir = tempdir::Dir::new();
        let s = Store::open(dir.path(), 3 * 1024 * 1024).unwrap();

        megabyte(&s, "one").unwrap();
        megabyte(&s, "two").unwrap();
        let refused = megabyte(&s, "three");
        assert_eq!(
            refused.err(),
            Some(Error::StoreFull),
            "a third megabyte past a 3 MB ceiling must be refused"
        );

        // And the refusal must not have been charged: a rejected write that
        // still counts would walk the ceiling down to nothing.
        let before = s.used();
        let _ = megabyte(&s, "four");
        assert_eq!(s.used(), before, "a refused write must cost nothing");
    }

    #[test]
    fn a_full_store_still_serves_what_it_already_has() {
        // Refusing new writes is survival; refusing reads would be an outage.
        let dir = tempdir::Dir::new();
        let s = Store::open(dir.path(), 2 * 1024 * 1024).unwrap();
        megabyte(&s, "kept").unwrap();
        assert!(megabyte(&s, "extra").is_err(), "the store should be full");

        assert!(
            s.get("kept").unwrap().is_some(),
            "an existing pad must still be readable when the store is full"
        );
        // And a pad already there can still be edited *down*, which is the only
        // way somebody can help.
        assert!(
            s.write("kept", &[put("big.txt", "small now")]).is_ok(),
            "shrinking an existing pad must be allowed when full"
        );
    }

    #[test]
    fn the_store_counts_what_is_on_disk_and_gives_it_back() {
        // The ceiling is only as good as the arithmetic behind it. Over-counting
        // ratchets it shut on ordinary use; under-counting means it never trips.
        let (s, _d) = store();
        assert_eq!(s.used(), 0, "a fresh store holds nothing");

        megabyte(&s, "one").unwrap();
        let after_one = s.used();
        assert!(
            after_one > 1024 * 1024,
            "a megabyte of text must be counted"
        );

        megabyte(&s, "two").unwrap();
        assert!(s.used() > after_one, "a second pad adds to the total");

        // Replacing a large pad with a small one has to return the difference.
        s.write("one", &[put("big.txt", "tiny")]).unwrap();
        assert!(
            s.used() < after_one + 1024,
            "shrinking a pad must give the bytes back, not ratchet"
        );
    }

    #[test]
    fn a_reopened_store_recounts_rather_than_starting_at_zero() {
        // A restart that forgets the total is a ceiling an attacker resets by
        // waiting for a deploy.
        let dir = tempdir::Dir::new();
        {
            let s = Store::open(dir.path(), MAX_STORE_BYTES).unwrap();
            megabyte(&s, "kept").unwrap();
            assert!(s.used() > 1024 * 1024);
        }
        let again = Store::open(dir.path(), MAX_STORE_BYTES).unwrap();
        assert!(
            again.used() > 1024 * 1024,
            "reopening must count what is already there"
        );
    }

    #[test]
    fn expiring_a_pad_returns_its_bytes_to_the_store() {
        let (s, _d) = store();
        megabyte(&s, "stale").unwrap();
        let held = s.used();
        assert!(held > 1024 * 1024);

        age(&s, "stale");
        assert_eq!(s.sweep(), vec!["stale".to_string()]);
        assert!(
            s.used() < held,
            "a swept pad must stop counting against the ceiling"
        );
    }

    fn store() -> (Store, tempdir::Dir) {
        let dir = tempdir::Dir::new();
        let store = Store::open(dir.path(), MAX_STORE_BYTES).unwrap();
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
    fn file_and_directory_paths_are_rejected_atomically() {
        let (s, _d) = store();
        assert_eq!(
            s.write("p", &[put("src", "file"), put("src/main.rs", "nested")]),
            Err(Error::BadPath("a file is also used as a directory"))
        );
        assert!(s.get("p").unwrap().is_none(), "a rejected write was saved");
    }

    #[test]
    fn a_later_write_cannot_turn_a_file_into_a_directory() {
        let (s, _d) = store();
        s.write("p", &[put("src", "file")]).unwrap();
        assert_eq!(
            s.write("p", &[put("src/main.rs", "nested")]),
            Err(Error::BadPath("a file is also used as a directory"))
        );
        let pad = s.get("p").unwrap().unwrap();
        assert_eq!(pad.files.len(), 1);
        assert_eq!(pad.files["src"].content, "file");
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
            let s = Store::open(dir.path(), MAX_STORE_BYTES).unwrap();
            s.write("keeper", &[put("main.py", "print(1)")]).unwrap();
        }
        let reopened = Store::open(dir.path(), MAX_STORE_BYTES).unwrap();
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
        // Read out of the deployed config rather than listed here.
        //
        // A hand-written list is what this test used to be, and it drifted the
        // first time it mattered: `/wisp` and `/dns-query` were added to the
        // pad's origin and neither this list nor RESERVED heard about it, so a
        // pad called `wisp` would have been shadowed by the route, where
        // nobody could ever open it. The property the comment claimed was
        // never actually being checked.
        //
        // include_str! rather than a runtime read: this fails to compile if the
        // Caddyfile moves, instead of passing vacuously.
        let caddyfile = include_str!("../../../deploy/Caddyfile");

        // Only the pad's own origin. The preview origin serves
        // `/wasmer-host.js` and friends, and a pad called `wasmer-host` sits on
        // a different hostname entirely — reserving it would cost a name for no
        // reason, and asserting it would be asserting something untrue.
        let block = caddyfile
            .split_once("\ncode.")
            .expect("the pad origin block is in the Caddyfile")
            .1;
        let block = block.split_once("\n}").expect("the block is closed").0;

        let mut checked = 0;
        for line in block.lines() {
            let line = line.trim();
            // `handle /api/*`, `handle /ws`, `@wisp path /wisp /wisp/*`
            let rest = line
                .strip_prefix("handle ")
                .or_else(|| line.split_once(" path ").map(|(_, r)| r));
            let Some(rest) = rest else { continue };
            for token in rest.split_whitespace() {
                let Some(path) = token.strip_prefix('/') else {
                    continue;
                };
                let segment = path.trim_end_matches('*').trim_end_matches('/');
                // A path with a dot is a file the server answers for directly
                // (`/sw.js`), not a prefix a pad name could sit under.
                let segment = match segment.split_once('.') {
                    Some((before, _)) if !before.is_empty() => before,
                    _ => segment,
                };
                if segment.is_empty() || segment.contains('/') {
                    continue;
                }
                checked += 1;
                assert_eq!(
                    check_name(segment).err(),
                    Some(Error::Reserved),
                    "{segment} is served by the Caddyfile but claimable as a pad name"
                );
            }
        }
        // A parser that matched nothing would make this test pass silently.
        assert!(
            checked >= 4,
            "only found {checked} routes — the parse is wrong"
        );
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

    /// Push a stored pad past its lease by rewriting its timestamp.
    fn age(s: &Store, name: &str) {
        let path = s.pad_path(name);
        let mut pad: Pad = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pad.updated_ms = now_ms() - LEASE.as_millis() as u64 - 1;
        std::fs::write(&path, serde_json::to_vec(&pad).unwrap()).unwrap();
    }

    #[test]
    fn an_expired_pad_frees_its_name() {
        // It used to be sealed for good: a lapsed name answered 410 "will not
        // be reused" forever, so /demo — the one name everybody reaches for —
        // became a page that could only say no. A lapsed pad is empty now, and
        // whoever opens the name next starts a fresh folder there.
        let (s, _d) = store();
        s.write("demo", &[put("old.py", "print('old')")]).unwrap();
        age(&s, "demo");

        assert!(
            s.get("demo").unwrap().is_none(),
            "an expired pad must read as free, not as an error"
        );
        assert!(s.open_for_read("demo").unwrap().is_none());

        assert_eq!(s.write("demo", &[put("new.py", "print('new')")]), Ok(1));
        let pad = s.get("demo").unwrap().unwrap();
        assert_eq!(
            pad.files.keys().collect::<Vec<_>>(),
            vec!["new.py"],
            "the old contents came back with the reused name"
        );
    }

    #[test]
    fn the_sweeper_removes_only_what_is_past_its_lease() {
        let (s, _d) = store();
        s.write("fresh", &[put("a", "1")]).unwrap();
        s.write("stale", &[put("a", "1")]).unwrap();
        age(&s, "stale");

        assert_eq!(s.sweep(), vec!["stale".to_string()]);
        assert!(s.get("fresh").unwrap().is_some());
        assert!(
            !s.pad_path("stale").exists(),
            "the expired pad is still on disk"
        );
        assert!(s.get("stale").unwrap().is_none());
    }

    #[test]
    fn a_sweep_spares_a_pad_rewritten_since_it_was_listed() {
        // The sweeper decides from what it read, then deletes by path — and a
        // write can rename a fresh pad onto that path in between. It has to
        // look again under the pad's lock, or it deletes the new one.
        let (s, _d) = store();
        s.write("busy", &[put("a", "1")]).unwrap();
        age(&s, "busy");
        s.write("busy", &[put("a", "rewritten")]).unwrap();

        assert!(
            !s.expire_if_lapsed("busy"),
            "a pad written since it lapsed was expired anyway"
        );
        assert_eq!(
            s.get("busy").unwrap().unwrap().files["a"].content,
            "rewritten"
        );
    }

    #[test]
    fn tombstones_left_by_the_old_policy_are_cleared() {
        // Every name that lapsed before this change is sealed by a 0-byte
        // `<name>.tomb`. Opening the store frees them all, so deploying this is
        // what gives /demo back.
        let dir = tempdir::Dir::new();
        std::fs::write(dir.path().join("demo.tomb"), b"").unwrap();
        std::fs::write(dir.path().join("other.tomb"), b"").unwrap();

        let s = Store::open(dir.path(), MAX_STORE_BYTES).unwrap();
        assert!(!dir.path().join("demo.tomb").exists());
        assert!(!dir.path().join("other.tomb").exists());
        assert!(s.get("demo").unwrap().is_none());
        assert_eq!(s.write("demo", &[put("main.py", "print(1)")]), Ok(1));
    }

    #[test]
    fn concurrent_writes_do_not_lose_each_other() {
        // `write` reads the pad, applies, and saves it back. Two of them at
        // once both read the same starting point and the second overwrites
        // the first — and the relay is a tokio server, so two requests for one
        // pad genuinely do overlap.
        use std::sync::Arc;
        let dir = tempdir::Dir::new();
        let store = Arc::new(Store::open(dir.path(), MAX_STORE_BYTES).unwrap());
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

    /// What a reader receives: the fields the handler puts in front, then the
    /// rest of the stored document.
    fn streamed(s: &Store, name: &str) -> serde_json::Value {
        use std::io::Read;
        let mut opened = s.open_for_read(name).unwrap().expect("the pad exists");
        let mut rest = String::new();
        opened.file.read_to_string(&mut rest).unwrap();
        assert_eq!(rest.len() as u64, opened.remaining, "remaining was wrong");
        serde_json::from_str(&format!("{{\"exists\":true,{rest}")).expect("valid json")
    }

    #[test]
    fn a_streamed_pad_is_the_same_pad() {
        let (s, _d) = store();
        s.write(
            "p",
            &[put("a.txt", "one"), put("dir/b.txt", "two \"quoted\"\n")],
        )
        .unwrap();
        let body = streamed(&s, "p");
        assert_eq!(body["exists"], true);
        assert_eq!(body["seq"], 1);
        assert_eq!(body["files"]["a.txt"]["content"], "one");
        assert_eq!(body["files"]["dir/b.txt"]["content"], "two \"quoted\"\n");
        assert_eq!(body["files"]["dir/b.txt"]["encoding"], "utf8");
    }

    #[test]
    fn opening_to_read_a_free_name_is_not_an_error() {
        let (s, _d) = store();
        assert!(s.open_for_read("nobody-here").unwrap().is_none());
    }

    #[test]
    fn a_streamed_read_still_honours_the_lease() {
        // Reads skip `get`, and `get` was where an expired pad was caught on
        // the way out. The check has to have come along: nobody is served a
        // pad past its lease just because the sweeper has not run yet.
        let (s, _d) = store();
        s.write("stale", &[put("a", "1")]).unwrap();
        age(&s, "stale");
        assert!(s.open_for_read("stale").unwrap().is_none());
    }

    #[test]
    fn opening_to_read_refuses_what_get_refuses() {
        let (s, _d) = store();
        assert!(matches!(s.open_for_read("api"), Err(Error::Reserved)));
        assert!(matches!(s.open_for_read("../x"), Err(Error::BadName(_))));
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

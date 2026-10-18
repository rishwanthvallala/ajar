//! Durable folders for the browser tier.
//!
//! Everything else in this binary is deliberately amnesiac — `session.rs` says
//! outright that losing every session on restart is *correct*, because an
//! agent reconnects and rebuilds what was lost. This module is the opposite by
//! necessity: a pad has no agent anywhere, so if the server forgets it, it is
//! gone. Two lifetimes in one process, kept apart on purpose.
//!
//! The shape is small: a folder is a name, a sequence number, and a map of
//! paths to contents. Since 11 October 2026 the paths are rows in SQLite and
//! the contents are files named by their hash, so a save writes what changed
//! and a read streams the rest — see docs/dev/pad-store.md. It was one JSON
//! document per pad, which every keystroke's save read and wrote whole.
//!
//! **A lapsed name is free again.** A pad nobody opens or writes to for 90 days is
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
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

mod splice;

/// Total bytes one pad may hold.
///
/// 25 MiB until 7 October, 60 until 11 October, 100 since. What kept it down
/// was the store: a pad was one document every save rewrote whole, and at 60
/// MiB that could take the relay down. A save now writes only what it changes
/// (see docs/dev/pad-store.md), so this is no longer a memory figure. What it
/// costs is the download: opening a pad fetches all of it, for everyone who
/// opens it. One request is still bounded on its own, by `MAX_PAD_HTTP_BODY`;
/// a browser sends a bigger write in several.
pub const MAX_BYTES: usize = 100 * 1024 * 1024;

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
/// nothing to create. At 60 MiB each, roughly 270 writes fill a 16 GB disk, and
/// the lease is no help against something that takes an afternoon — a full
/// disk stops the relay saving anything, including the pads belonging to
/// people who were using it properly. See also `quota::MAX_PAD_GROWTH_PER_IP`,
/// which is what stops one address doing that on its own.
///
/// Chosen to be survivable rather than generous: well under the free space on
/// the box this runs on, so filling it is an error somebody sees rather than an
/// outage. The number is the *serialised* size on disk, which is what actually
/// competes for the disk.
pub const MAX_STORE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// How long a pad survives with nobody opening or writing it.
///
/// Ninety days. It was seven, and seven punished the pads people share rather
/// than the ones they abandon: a demo that is opened every day but edited once
/// a fortnight was deleted between edits. Two things changed with it, and the
/// length is only safe because of both: opening a pad now counts as touching it
/// (see [`RENEW_EVERY`]), and one address can only add
/// `quota::MAX_PAD_GROWTH_PER_IP` a day, so a long lease cannot be used to keep
/// the store full for three months.
pub const LEASE: Duration = Duration::from_secs(90 * 24 * 60 * 60);

/// How long a pad goes on being edited before the way it was is kept as a
/// version. A save after a pause at least this long keeps the pad as it was
/// left, and a long session keeps one this often: earlier versions without
/// one per keystroke.
pub const VERSION_EVERY: Duration = Duration::from_secs(10 * 60);
/// The most versions one pad keeps, newest first.
pub const VERSIONS_KEPT: usize = 30;
/// And the most bytes of files they may name between them. A version shares
/// every file it has in common with the pad and with other versions, so this
/// is what history could cost a pad whose every file changed each time, and
/// counts against [`MAX_STORE_BYTES`] like any file.
pub const HISTORY_BYTES: u64 = 200 * 1024 * 1024;
/// And nothing older than this.
pub const VERSION_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// How stale a pad's last touch must be before a read renews it.
///
/// The lease is the file's modification time, so renewing is a metadata update
/// rather than a rewrite — but it is still a write to the disk, and a busy pad
/// is read thousands of times a day. Once a day is all the lease needs.
pub const RENEW_EVERY: Duration = Duration::from_secs(24 * 60 * 60);

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
    // Signing in, and the dashboard for the pads an account owns.
    "auth",
    "dashboard",
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
    pub fn bytes(&self) -> usize {
        self.files.values().map(|f| f.content.len()).sum()
    }
}

/// What an accepted write did: the sequence it reached, and how many bytes it
/// added to the pad's footprint — which is what the caller's address is
/// charged.
#[derive(Debug, PartialEq, Eq)]
pub struct Written {
    pub seq: u64,
    pub grew: u64,
    /// What the pad came to, for an owned pad's dashboard and its account's
    /// quota.
    pub bytes: u64,
    pub files: u64,
    /// Each written file's hash, for a browser to send edits against.
    pub hashes: BTreeMap<String, String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// Not a shape a name may take.
    BadName(&'static str),
    /// The name is ours.
    Reserved,
    /// A path inside the pad that we will not store.
    BadPath(&'static str),
    /// A file refused for its path or its content, named so that whoever
    /// sent it can find it: one bad file refuses the whole write it came in.
    Unstorable {
        path: String,
        why: &'static str,
    },
    TooBig {
        bytes: usize,
    },
    TooManyFiles,
    /// More changes in one request than [`MAX_WRITES`].
    TooManyWrites,
    /// More edits to one file than [`MAX_EDITS`], or to a request's files
    /// together than [`MAX_EDITS_PER_REQUEST`].
    TooManyEdits,
    /// Every pad together is at the ceiling. Nothing to do with *this* pad.
    StoreFull,
    /// This write would add more than the caller's address has left for the
    /// day. See `quota::MAX_PAD_GROWTH_PER_IP`.
    OverAllowance,
    /// Edits sent against a version of a file the store no longer holds. The
    /// browser sends the whole file instead.
    Stale,
    /// Edits that do not fit the file they name.
    BadEdit(&'static str),
    Io(String),
}

impl Error {
    pub fn message(&self) -> String {
        match self {
            Error::BadName(why) => format!("that name will not work: {why}"),
            Error::Reserved => "that name is reserved".into(),
            Error::BadPath(why) => format!("that file path will not work: {why}"),
            // Quoted as Rust quotes a string, so a tab or a line break in the
            // name shows as `\t` or `\n` rather than breaking the message.
            Error::Unstorable { path, why } => format!("{path:?} cannot be stored: {why}"),
            Error::TooBig { bytes } => format!(
                "{:.1} MB is over the {} MB limit",
                *bytes as f64 / (1024.0 * 1024.0),
                MAX_BYTES / (1024 * 1024)
            ),
            Error::TooManyFiles => format!("a pad holds at most {MAX_FILES} files"),
            Error::TooManyWrites => {
                format!("one save changes at most {MAX_WRITES} files — send the rest in another")
            }
            Error::TooManyEdits => format!(
                "one save makes at most {MAX_EDITS} edits to a file and {MAX_EDITS_PER_REQUEST} \
                 in all — send the file whole instead"
            ),
            // Deliberately says it is not the caller's fault. Somebody who has
            // just pasted four lines and been refused should not go looking for
            // what is wrong with their four lines.
            Error::StoreFull => "this server is out of room for new pads — try again later".into(),
            // Edits that do not grow anything still go through, so this is only
            // ever somebody adding a great deal, and "tomorrow" is the fix.
            Error::OverAllowance => {
                "this address has added as much as it can for today — try again tomorrow, \
                 or remove something first"
                    .into()
            }
            Error::Stale => "a file changed since this page last read it".into(),
            Error::BadEdit(why) => format!("that edit will not apply: {why}"),
            Error::Io(e) => format!("could not store that: {e}"),
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Io(e.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e.to_string())
    }
}

/// A name that is safe to use in a URL and as a key.
pub fn check_name(name: &str) -> Result<(), Error> {
    if name.is_empty() {
        return Err(Error::BadName("it is empty"));
    }
    if name.len() > MAX_NAME {
        return Err(Error::BadName("it is too long"));
    }
    // Strict enough that the name is a filename with no escaping too — the
    // store was a directory of `<name>.json` until October 2026, and an export
    // for going back writes that again.
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
/// These never touch the filesystem — a file's bytes are stored under their
/// hash — but they do reach other people's browsers, where a `..` would be
/// handed to a runtime that resolves it. Refusing them here is cheaper than
/// trusting every client.
pub fn check_path(path: &str) -> Result<(), Error> {
    if path.is_empty() {
        return Err(Error::BadPath("it is empty"));
    }
    if path.len() > 512 {
        return Err(Error::BadPath("it is too long"));
    }
    if path.starts_with('/') {
        return Err(Error::BadPath("it must be relative, with forward slashes"));
    }
    if path.contains('\\') {
        return Err(Error::Unstorable {
            path: path.to_string(),
            why: "it has a backslash in it, and a pad's paths use forward slashes",
        });
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

/// What a path must be, besides [`check_path`], for a file to be stored at
/// it. Only for storing: deleting at such a path is still allowed, so a pad
/// that holds one from before can be cleaned.
///
/// No control characters — a tab, a line break, an escape: a name that
/// reaches other people's file trees, terminals and archives must not be
/// able to rearrange them, and nothing a person names a file has one. And
/// nothing under `.ajar/` or `.deps/` or in a `.git` folder: the page's own
/// machinery, the packages pip installed, and a repository's, which the page
/// never saves (`IGNORED` in pad/src/sync.ts) and never shows — so a file
/// there from the API is code nobody sees, put where the page runs its own
/// (review finding M7). `.deps` was saved with the pad until 18 October, when
/// numpy's 1,336 files outgrew the 500 a pad holds; requirements.txt carries
/// the packages now.
fn check_storable(path: &str) -> Result<(), Error> {
    let refuse = |why| {
        Err(Error::Unstorable {
            path: path.to_string(),
            why,
        })
    };
    if path.chars().any(|c| c < '\u{20}' || c == '\u{7f}') {
        return refuse("its name has a control character in it — a tab, a line break or the like");
    }
    if path.starts_with(".ajar/") {
        return refuse("the .ajar folder is the page's own machinery, which a pad never keeps");
    }
    if path.starts_with(".deps/") {
        return refuse(
            "installed packages are never kept with a pad — requirements.txt carries them",
        );
    }
    // Every segment but the last is a folder the file is in.
    if path.split('/').rev().skip(1).any(|dir| dir == ".git") {
        return refuse("a .git folder is never kept with a pad");
    }
    Ok(())
}

/// Whether text is base64 the way a browser writes it (`btoa`), so far: the
/// standard alphabet, and `=` only as the last one or two characters of a
/// whole group. Fed in pieces, as a file being streamed is.
///
/// Not that it is whole groups. A file too big for one request arrives as
/// its first part, cut wherever the request ran out (`pieces` in
/// pad/src/store.ts), and the rest is added by edits — so text without
/// padding may stop part-way through a group. Padding says it is the end,
/// and then it has to be.
#[derive(Debug, Default)]
pub(crate) struct Base64Shape {
    len: u64,
    padding: u8,
    bad: bool,
}

impl Base64Shape {
    pub(crate) fn feed(&mut self, text: &[u8]) {
        for &b in text {
            match b {
                b'=' if self.padding < 2 => self.padding += 1,
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' if self.padding == 0 => {}
                _ => self.bad = true,
            }
        }
        self.len += text.len() as u64;
    }

    pub(crate) fn ok(&self) -> bool {
        !self.bad && (self.padding == 0 || self.len.is_multiple_of(4))
    }
}

fn base64_shaped(text: &str) -> bool {
    let mut shape = Base64Shape::default();
    shape.feed(text.as_bytes());
    shape.ok()
}

/// What a binary file's content is refused for when it is not base64.
const NOT_BASE64: &str = "it is sent as base64 and is not base64";

/// One change to a file's text: `remove` characters at `at`, then `insert`
/// there. Counted in UTF-16 code units, as a browser counts a string.
#[derive(Debug, Clone, Deserialize)]
pub struct Edit {
    pub at: usize,
    pub remove: usize,
    #[serde(default)]
    pub insert: String,
}

/// One write to apply. `content` replaces the file; `edits` against `base`
/// change it; neither removes it. Edits apply to a file of the encoding they
/// say, which is how a browser sends a file too big for one request: the first
/// part as content, the rest added to the end of it.
#[derive(Debug, Clone, Deserialize)]
pub struct Write {
    pub path: String,
    pub content: Option<String>,
    #[serde(default = "utf8")]
    pub encoding: Encoding,
    /// The hash of the stored file `edits` apply to.
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default, deserialize_with = "edits")]
    pub edits: Option<Vec<Edit>>,
}

/// Changes one request may make: files written, edited or removed.
///
/// The page sends at most twice [`MAX_FILES`] in one — every file a pad holds
/// removed and as many put in its place, a command that replaced everything —
/// so this is twice that again. Nothing bounded it before but the 33 MiB
/// body, which holds 2.6 million `{"path":"a"}`: each parsed into a struct
/// ten times its size, and each compared with every one after it while the
/// write held one of the relay's two write permits (audit B10).
pub const MAX_WRITES: usize = 4 * MAX_FILES;

/// Edits one change may make to its file. The page sends one — what it
/// works out between the text the store has and the text it has (carry.ts),
/// and each later part of a file too big for one request — so this is room
/// for a client that sends every keystroke, not a figure the page reaches.
pub const MAX_EDITS: usize = 1_000;

/// Edits one request may make, its files together: ten files at the most one
/// may take, and twenty times what the page sends when a command has touched
/// every text file a pad holds.
pub const MAX_EDITS_PER_REQUEST: usize = 10 * MAX_EDITS;

/// A file's edits as they arrive, kept no further than one past
/// [`MAX_EDITS`]: the rest are read and dropped, so a write with a million
/// costs what one with a thousand does, and is refused by its length
/// ([`Store::write_within`]) as if every one had been kept.
fn edits<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<Edit>>, D::Error> {
    Option::<Edits>::deserialize(d).map(|e| e.map(|e| e.0))
}

/// A request's writes as they arrive, kept no further than one past
/// [`MAX_WRITES`], or than the write whose edits take the request past
/// [`MAX_EDITS_PER_REQUEST`]: whichever comes first. What is not kept is read
/// and dropped. A list cut short is always one the store refuses — it is
/// longer than a request may be, or has more edits — so nothing is applied
/// in part.
pub fn writes<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Write>, D::Error> {
    struct Visit;
    impl<'de> serde::de::Visitor<'de> for Visit {
        type Value = Vec<Write>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a list of writes")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut seq: A,
        ) -> Result<Self::Value, A::Error> {
            let mut kept = Vec::new();
            let mut edits = 0usize;
            while kept.len() <= MAX_WRITES && edits <= MAX_EDITS_PER_REQUEST {
                let Some(w) = seq.next_element::<Write>()? else {
                    return Ok(kept);
                };
                edits += w.edits.as_ref().map_or(0, Vec::len);
                kept.push(w);
            }
            while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
            Ok(kept)
        }
    }
    d.deserialize_seq(Visit)
}

/// A file's edits kept to one past [`MAX_EDITS`], the rest read and dropped.
struct Edits(Vec<Edit>);

impl<'de> Deserialize<'de> for Edits {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = Edits;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a list of edits")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                let mut kept = Vec::new();
                while kept.len() <= MAX_EDITS {
                    match seq.next_element()? {
                        Some(edit) => kept.push(edit),
                        None => return Ok(Edits(kept)),
                    }
                }
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(Edits(kept))
            }
        }
        d.deserialize_seq(Visit)
    }
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

/// How long a file in the blob directory that the store has no row for is
/// left alone: a write puts its blobs there before the transaction that
/// records them, and may still be about to commit.
///
/// It was also how long a blob no file held stayed, for a read still sending
/// it. Since 11 October a read says which blobs it is sending instead, and
/// any other goes at once — see [`Store::release`].
pub const GRACE: Duration = Duration::from_secs(10 * 60);

fn hash_of(encoding: Encoding, content: &str) -> String {
    let mut h = Sha256::new();
    h.update(match encoding {
        Encoding::Utf8 => b"u",
        Encoding::Base64 => b"b",
    });
    h.update(content.as_bytes());
    format!("{:x}", h.finalize())
}

fn encoding_code(e: Encoding) -> i64 {
    match e {
        Encoding::Utf8 => 0,
        Encoding::Base64 => 1,
    }
}

fn encoding_from(code: i64) -> Encoding {
    if code == 1 {
        Encoding::Base64
    } else {
        Encoding::Utf8
    }
}

fn encoding_name(e: Encoding) -> &'static str {
    match e {
        Encoding::Utf8 => "utf8",
        Encoding::Base64 => "base64",
    }
}

/// One file of a pad as the store holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    blob: String,
    encoding: Encoding,
    seq: u64,
    /// Bytes of its text, which is what the caps count.
    size: u64,
    /// Bytes of its blob on disk.
    stored: u64,
}

/// A version's files, path to blob.
type Manifest = BTreeMap<String, String>;

/// One kept version of a pad: [`Store::history`].
#[derive(Debug, Clone, Serialize)]
pub struct Version {
    pub id: u64,
    pub at_ms: u64,
    pub files: u64,
    pub bytes: u64,
}

/// A pad as a link preview describes it: [`Store::summary`].
#[derive(Debug, Clone)]
pub struct Summary {
    pub files: usize,
    /// The first [`SUMMARY_PATHS`] paths, in order.
    pub paths: Vec<String>,
    /// The file that says most about the pad, and its text.
    pub lead: Option<(String, String)>,
    /// What its last Run printed, and the file it ran.
    pub ran: Option<(String, String)>,
}

/// The most of a run's output a pad keeps: the end of it, the page cuts it to.
pub const LAST_RUN_MAX: usize = 32 * 1024;
/// The longest command or path a last run may name.
const LAST_RUN_NAME_MAX: usize = 1024;

/// What Run last printed in a pad, for whoever opens it next to see before
/// running anything (App.saveRun). The pad's, not a file in it: not in its
/// tree, its zip or its history, and gone with it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LastRun {
    /// The file Run ran.
    pub path: String,
    pub command: String,
    pub exit: i32,
    /// When, set by the store as it keeps it.
    #[serde(default)]
    pub at_ms: u64,
    /// What it printed, colours and all.
    pub output: String,
}

impl LastRun {
    /// What keeping it costs the store: its output, command and path, every
    /// byte of them the sender's. [`RUN_SIZE`] measures one already kept.
    pub fn bytes(&self) -> u64 {
        (self.output.len() + self.command.len() + self.path.len()) as u64
    }
}

/// [`LastRun::bytes`] of a row of `last_runs`, in SQL.
const RUN_SIZE: &str = "length(CAST(output AS BLOB)) + length(CAST(command AS BLOB)) \
                        + length(CAST(path AS BLOB))";

/// How many paths a preview names.
pub const SUMMARY_PATHS: usize = 6;
/// The largest file a preview reads, to quote its first lines.
pub const SUMMARY_LEAD_MAX: u64 = 64 * 1024;

/// The file a preview quotes: the one a reader would open first, if it is
/// text and small enough to read for a preview.
/// A path in a hidden folder, or a hidden file: `.deps/…`, `.ajar/…`, `.keep`.
fn hidden(path: &str) -> bool {
    path.split('/')
        .any(|part| part.starts_with('.') || part == "__pycache__")
}

fn lead_file(rows: &BTreeMap<String, Row>) -> Option<(String, Row)> {
    const FIRST: [&str; 8] = [
        "main.py",
        "app.py",
        "index.html",
        "README.md",
        "main.js",
        "index.js",
        "Main.java",
        "main.c",
    ];
    let quotable =
        |r: &Row| r.encoding == Encoding::Utf8 && r.size > 0 && r.size <= SUMMARY_LEAD_MAX;
    FIRST
        .iter()
        .find_map(|name| {
            rows.get(*name)
                .filter(|r| quotable(r))
                .map(|r| (name.to_string(), r.clone()))
        })
        .or_else(|| {
            rows.iter()
                .find(|(p, r)| !hidden(p) && quotable(r))
                .map(|(p, r)| (p.clone(), r.clone()))
        })
}

/// A stored pad opened for streaming: its document after the opening brace,
/// as pieces, and how many bytes they come to.
///
/// After the brace so a caller can put its own fields in front, as it always
/// has. The pieces are fixed bytes and blobs; a blob is opened only when it is
/// reached, so a read holds one file open, not one per file in the pad.
pub struct Opened {
    pub parts: Vec<Part>,
    pub remaining: u64,
    /// The blobs in `parts`, kept from being deleted until this is dropped,
    /// which a caller does when it has sent them or given up.
    pub reading: Reading,
}

/// Blobs in use — being sent to a reader, or edited — and by how many.
type InUse = Arc<Mutex<HashMap<String, usize>>>;

/// Blobs kept from [`Store::release`] until this is dropped.
pub struct Reading {
    blobs: Vec<String>,
    in_use: InUse,
}

impl Drop for Reading {
    fn drop(&mut self) {
        let mut in_use = self.in_use.lock();
        for hash in &self.blobs {
            if let Some(n) = in_use.get_mut(hash) {
                *n -= 1;
                if *n == 0 {
                    in_use.remove(hash);
                }
            }
        }
    }
}

/// A file's next blob, written beside the store until a write puts it in
/// place: its hash, the bytes of its text, and its bytes on disk. `tmp` is
/// none when the store already had it.
struct Staged {
    hash: String,
    size: u64,
    stored: u64,
    tmp: Option<PathBuf>,
}

impl Staged {
    fn discard(&mut self) {
        if let Some(tmp) = self.tmp.take() {
            let _ = std::fs::remove_file(tmp);
        }
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        self.discard();
    }
}

/// Blobs a write put in place, deleted again unless it went in.
struct Placed(Vec<PathBuf>);

impl Placed {
    fn keep(&mut self) {
        self.0.clear();
    }
}

impl Drop for Placed {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Whether `row` is the version `w`'s edits were made against.
fn names_version(row: Option<&Row>, w: &Write) -> bool {
    row.is_some_and(|r| Some(&r.blob) == w.base.as_ref() && r.encoding == w.encoding)
}

/// `content` written to `path` as a JSON string, and how many bytes that is.
/// Straight to the file: building it first was another copy of the file in
/// memory. On the disk, not only in the page cache, before it is renamed into
/// place (see `settle`).
fn write_json_string(path: &Path, content: &str) -> Result<u64, Error> {
    let write = || -> std::io::Result<u64> {
        let mut out = std::io::BufWriter::new(std::fs::File::create(path)?);
        serde_json::to_writer(&mut out, content)?;
        let file = out.into_inner().map_err(|e| e.into_error())?;
        file.sync_data()?;
        Ok(file.metadata()?.len())
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(path);
        Error::Io(e.to_string())
    })
}

/// A directory's entries on the disk: a file renamed into it is there after
/// a power cut only once its directory is synced too.
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    std::fs::File::open(dir)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

pub enum Part {
    Bytes(Vec<u8>),
    Blob(PathBuf),
}

#[cfg(test)]
impl Opened {
    /// The document as one reader, for anything not streaming it to a socket.
    pub fn into_reader(self) -> impl std::io::Read {
        PartsReader {
            parts: self.parts.into_iter(),
            current: None,
            _reading: self.reading,
        }
    }
}

#[cfg(test)]
struct PartsReader {
    parts: std::vec::IntoIter<Part>,
    current: Option<Box<dyn std::io::Read>>,
    _reading: Reading,
}

#[cfg(test)]
impl std::io::Read for PartsReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if let Some(r) = self.current.as_mut() {
                let n = r.read(buf)?;
                if n > 0 {
                    return Ok(n);
                }
                self.current = None;
            }
            match self.parts.next() {
                None => return Ok(0),
                Some(Part::Bytes(b)) => self.current = Some(Box::new(std::io::Cursor::new(b))),
                Some(Part::Blob(path)) => self.current = Some(Box::new(std::fs::File::open(path)?)),
            }
        }
    }
}

pub struct Store {
    dir: PathBuf,
    blobs: PathBuf,
    /// The ceiling this store enforces. A field rather than the constant so a
    /// smaller disk can say so, and so a test can reach it without writing 4 GB.
    ceiling: u64,
    /// One connection, and every change to the store under it: a write's
    /// checks and its transaction are one step, so two writes to one pad
    /// cannot both start from the same version and lose one another.
    db: Mutex<Connection>,
    /// Bytes of the blobs some file holds, and of the last runs kept in the
    /// database, maintained rather than measured.
    ///
    /// A blob is counted once however many pads hold it, which is what it
    /// costs the disk. One held by nothing stops counting at once, though its
    /// file waits out [`GRACE`].
    ///
    /// A last run is up to [`LAST_RUN_MAX`] of output a pad, in a table
    /// rather than a blob, and was not counted at all: with the store at its
    /// ceiling, a pad with no files could still be given 32 KiB of output,
    /// and any number of them (audit B09). Counted as [`RUN_SIZE`] measures
    /// it, added and taken away where a run is kept, replaced or deleted —
    /// one row's length each time, never a scan.
    used: AtomicU64,
    /// Pads that belong to an account. Their lease never lapses: an owned
    /// pad lasts as long as its account, and deleting it is the owner's call.
    pinned: parking_lot::RwLock<std::collections::HashSet<String>>,
    /// Blobs being read or edited, which a release leaves where they are.
    in_use: InUse,
    /// Whether a save keeps the pad as it was as a version. Always, but for
    /// the tests of how blobs are let go, which history would hold on to.
    keeps_history: bool,
}

const SCHEMA: &str = "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS pads (
        name TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        touched_ms INTEGER NOT NULL,
        bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
        pad TEXT NOT NULL,
        path TEXT NOT NULL,
        blob TEXT NOT NULL,
        encoding INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        size INTEGER NOT NULL,
        stored INTEGER NOT NULL,
        PRIMARY KEY (pad, path)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY,
        stored INTEGER NOT NULL,
        refs INTEGER NOT NULL,
        unheld_ms INTEGER
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS versions (
        pad TEXT NOT NULL,
        id INTEGER NOT NULL,
        at_ms INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        files INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        PRIMARY KEY (pad, id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS version_files (
        pad TEXT NOT NULL,
        version INTEGER NOT NULL,
        path TEXT NOT NULL,
        blob TEXT NOT NULL,
        encoding INTEGER NOT NULL,
        size INTEGER NOT NULL,
        stored INTEGER NOT NULL,
        PRIMARY KEY (pad, version, path)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS last_runs (
        pad TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        command TEXT NOT NULL,
        exit INTEGER NOT NULL,
        at_ms INTEGER NOT NULL,
        output TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pads_touched ON pads (touched_ms);
    CREATE INDEX IF NOT EXISTS blobs_unheld ON blobs (unheld_ms) WHERE refs = 0;
";

/// A pad's row, if there is one.
struct Head {
    seq: u64,
    created_ms: u64,
    updated_ms: u64,
    touched_ms: u64,
}

impl Store {
    /// The ceiling is always explicit. There was a convenience `open` applying
    /// the default, and with one real caller passing a flag it was only ever
    /// reached from tests — a constructor that exists for tests is how a default
    /// diverges from what production runs.
    pub fn open(dir: impl Into<PathBuf>, ceiling: u64) -> std::io::Result<Self> {
        let dir = dir.into();
        let blobs = dir.join("blobs");
        std::fs::create_dir_all(&blobs)?;

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

        let db = Connection::open(dir.join("store.db")).map_err(std::io::Error::other)?;
        db.execute_batch(SCHEMA).map_err(std::io::Error::other)?;
        let store = Self {
            dir,
            blobs,
            ceiling,
            db: Mutex::new(db),
            used: AtomicU64::new(0),
            pinned: Default::default(),
            in_use: Default::default(),
            keeps_history: true,
        };
        store.import_legacy()?;
        // Nothing is being read yet, so a blob held by nothing can go now.
        store.collect(Duration::ZERO);
        // Once, at the start: from here on it is kept up as things change.
        let used: i64 = store
            .db
            .lock()
            .query_row(
                &format!(
                    "SELECT (SELECT COALESCE(SUM(stored), 0) FROM blobs WHERE refs > 0)
                          + (SELECT COALESCE(SUM({RUN_SIZE}), 0) FROM last_runs)"
                ),
                [],
                |r| r.get(0),
            )
            .map_err(std::io::Error::other)?;
        store.used.store(used as u64, Ordering::Relaxed);
        Ok(store)
    }

    /// Bring in every pad stored the old way — one `<name>.json` each — and
    /// move the file into `legacy/`, kept for going back.
    ///
    /// Each pad in a transaction of its own, and moved only once it is in. A
    /// pad already here — a start that stopped part-way — is only moved.
    fn import_legacy(&self) -> std::io::Result<()> {
        let legacy: Vec<(String, PathBuf)> = std::fs::read_dir(&self.dir)?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .filter_map(|p| stem(&p).map(|name| (name, p)))
            .filter(|(name, _)| check_name(name).is_ok())
            .collect();
        if legacy.is_empty() {
            return Ok(());
        }
        let kept = self.dir.join("legacy");
        std::fs::create_dir_all(&kept)?;
        let mut imported = 0usize;
        for (name, path) in legacy {
            match self.import_one(&name, &path) {
                Ok(()) => {
                    std::fs::rename(&path, kept.join(format!("{name}.json")))?;
                    imported += 1;
                }
                Err(e) => {
                    tracing::warn!(pad = %name, "left where it was, not imported: {}", e.message())
                }
            }
        }
        tracing::info!(
            imported,
            "pads brought into the store from one document each"
        );
        Ok(())
    }

    fn import_one(&self, name: &str, path: &Path) -> Result<(), Error> {
        let meta = std::fs::metadata(path)?;
        let touched = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or_else(now_ms);
        let pad: Pad =
            serde_json::from_slice(&std::fs::read(path)?).map_err(|e| Error::Io(e.to_string()))?;
        let mut db = self.db.lock();
        let there: bool = db
            .query_row("SELECT 1 FROM pads WHERE name = ?1", [name], |_| Ok(()))
            .optional()?
            .is_some();
        if there {
            return Ok(());
        }
        let mut rows = BTreeMap::new();
        for (path, file) in &pad.files {
            let (blob, stored) = self.put_blob(file.encoding, &file.content)?;
            rows.insert(
                path.clone(),
                Row {
                    blob,
                    encoding: file.encoding,
                    seq: file.seq,
                    size: file.content.len() as u64,
                    stored,
                },
            );
        }
        let tx = db.transaction()?;
        let changed: Vec<String> = rows.keys().cloned().collect();
        Self::apply_rows(&tx, name, &BTreeMap::new(), &rows, &changed, touched)?;
        tx.execute(
            "INSERT INTO pads (name, seq, created_ms, updated_ms, touched_ms, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                name,
                pad.seq as i64,
                pad.created_ms as i64,
                pad.updated_ms as i64,
                touched as i64,
                pad.bytes() as i64
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Exempt a pad from its lease, for as long as it is owned.
    pub fn pin(&self, name: &str) {
        self.pinned.write().insert(name.to_owned());
    }

    fn lapsed(&self, name: &str, touched_ms: u64) -> bool {
        !self.pinned.read().contains(name)
            && Duration::from_millis(now_ms().saturating_sub(touched_ms)) > LEASE
    }

    /// Whether the store's database answers, for the readiness check: a row
    /// of the table every read and write starts from, looked for.
    pub fn ping(&self) -> Result<(), Error> {
        self.db
            .lock()
            .query_row("SELECT EXISTS (SELECT 1 FROM pads)", [], |r| {
                r.get::<_, bool>(0)
            })?;
        Ok(())
    }

    /// Bytes of the blobs some pad holds right now, and of the last runs
    /// pads keep.
    pub fn used(&self) -> u64 {
        self.used.load(Ordering::Relaxed)
    }

    /// The bytes a pad's last run keeps, as `used` counts them: none when
    /// it has none.
    fn stored_run(db: &Connection, name: &str) -> Result<u64, Error> {
        Ok(db
            .query_row(
                &format!("SELECT {RUN_SIZE} FROM last_runs WHERE pad = ?1"),
                [name],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map_or(0, |n| n.max(0) as u64))
    }

    /// A pad's last run deleted, and the change that makes to `used`.
    fn drop_run(tx: &rusqlite::Transaction, name: &str) -> Result<i64, Error> {
        let size = Self::stored_run(tx, name)?;
        tx.execute("DELETE FROM last_runs WHERE pad = ?1", [name])?;
        Ok(-(size as i64))
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.blobs.join(&hash[..2]).join(hash)
    }

    /// The directory a blob goes in, made if it is not there yet; true when
    /// this made it.
    fn blob_dir(&self, path: &Path) -> Result<bool, Error> {
        let dir = path.parent().expect("a blob's path has a directory");
        if dir.is_dir() {
            return Ok(false);
        }
        std::fs::create_dir_all(dir)?;
        Ok(true)
    }

    /// A blob just renamed into place, there after a power cut too: its
    /// directory synced, and the store's when that directory is new. Its
    /// bytes were synced before the rename.
    ///
    /// A save is said to be saved once the database commits it, and the
    /// database is synchronous = FULL, so the commit outlasts a power cut. Until
    /// 18 October it was NORMAL, nothing was synced here, and a crash of the
    /// machine — not of the relay — could lose a save that had been answered,
    /// or keep a file whose blob never reached the disk (audit B07). Now a
    /// blob is on the disk under its name before the row naming it commits.
    fn settle(&self, path: &Path, made: bool) -> Result<(), Error> {
        sync_dir(path.parent().expect("a blob's path has a directory"))?;
        if made {
            sync_dir(&self.blobs)?;
        }
        Ok(())
    }

    /// Store a file's text under its hash, if nothing has yet, and say which
    /// hash and how big the blob is. The text is kept as the JSON string it is
    /// sent as, so a read copies it rather than encoding it.
    fn put_blob(&self, encoding: Encoding, content: &str) -> Result<(String, u64), Error> {
        let hash = hash_of(encoding, content);
        let path = self.blob_path(&hash);
        if let Ok(meta) = std::fs::metadata(&path) {
            return Ok((hash, meta.len()));
        }
        let made = self.blob_dir(&path)?;
        // Written beside its place and renamed into it: a blob is either all
        // there or not there.
        let tmp = self.tmp_path();
        let stored = write_json_string(&tmp, content)?;
        std::fs::rename(&tmp, &path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })?;
        self.settle(&path, made)?;
        Ok((hash, stored))
    }

    fn blob_text(&self, hash: &str) -> Result<String, Error> {
        serde_json::from_slice(&std::fs::read(self.blob_path(hash))?)
            .map_err(|e| Error::Io(e.to_string()))
    }

    fn head(db: &Connection, name: &str) -> Result<Option<Head>, Error> {
        Ok(db
            .query_row(
                "SELECT seq, created_ms, updated_ms, touched_ms FROM pads WHERE name = ?1",
                [name],
                |r| {
                    Ok(Head {
                        seq: r.get::<_, i64>(0)? as u64,
                        created_ms: r.get::<_, i64>(1)? as u64,
                        updated_ms: r.get::<_, i64>(2)? as u64,
                        touched_ms: r.get::<_, i64>(3)? as u64,
                    })
                },
            )
            .optional()?)
    }

    fn rows(db: &Connection, name: &str) -> Result<BTreeMap<String, Row>, Error> {
        let mut q = db.prepare_cached(
            "SELECT path, blob, encoding, seq, size, stored FROM files WHERE pad = ?1 ORDER BY path",
        )?;
        let rows = q.query_map([name], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Row {
                    blob: r.get(1)?,
                    encoding: encoding_from(r.get(2)?),
                    seq: r.get::<_, i64>(3)? as u64,
                    size: r.get::<_, i64>(4)? as u64,
                    stored: r.get::<_, i64>(5)? as u64,
                },
            ))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Move a pad's files from `old` to `new`, for the paths in `changed` and
    /// any `old` has that `new` does not, counting each blob's holders as it
    /// goes. Returns the change in bytes held, for `used`.
    fn apply_rows(
        tx: &rusqlite::Transaction,
        name: &str,
        old: &BTreeMap<String, Row>,
        new: &BTreeMap<String, Row>,
        changed: &[String],
        now: u64,
    ) -> Result<i64, Error> {
        let mut held: i64 = 0;
        let mut count = |hash: &str, stored: u64, by: i64| -> Result<(), Error> {
            held += Self::count_ref(tx, hash, stored, by, now)?;
            Ok(())
        };
        for (path, row) in old {
            if !new.contains_key(path) {
                tx.execute(
                    "DELETE FROM files WHERE pad = ?1 AND path = ?2",
                    params![name, path],
                )?;
                count(&row.blob, row.stored, -1)?;
            }
        }
        for path in changed {
            let Some(row) = new.get(path) else { continue };
            count(&row.blob, row.stored, 1)?;
            if let Some(was) = old.get(path) {
                count(&was.blob, was.stored, -1)?;
            }
            tx.execute(
                "INSERT INTO files (pad, path, blob, encoding, seq, size, stored) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(pad, path) DO UPDATE SET blob = ?3, encoding = ?4, seq = ?5, size = ?6, stored = ?7",
                params![
                    name,
                    path,
                    row.blob,
                    encoding_code(row.encoding),
                    row.seq as i64,
                    row.size as i64,
                    row.stored as i64
                ],
            )?;
        }
        Ok(held)
    }

    /// A blob's holders — files and versions — changed by `by`. Returns what
    /// that does to the bytes held, for `used`.
    fn count_ref(
        tx: &rusqlite::Transaction,
        hash: &str,
        stored: u64,
        by: i64,
        now: u64,
    ) -> Result<i64, Error> {
        tx.execute(
            "INSERT INTO blobs (hash, stored, refs, unheld_ms) VALUES (?1, ?2, 0, NULL) ON CONFLICT(hash) DO NOTHING",
            params![hash, stored as i64],
        )?;
        let before: i64 = tx.query_row("SELECT refs FROM blobs WHERE hash = ?1", [hash], |r| {
            r.get(0)
        })?;
        let after = before + by;
        tx.execute(
            "UPDATE blobs SET refs = ?2, unheld_ms = CASE WHEN ?2 > 0 THEN NULL ELSE ?3 END WHERE hash = ?1",
            params![hash, after, now as i64],
        )?;
        Ok(if before == 0 && after > 0 {
            stored as i64
        } else if before > 0 && after == 0 {
            -(stored as i64)
        } else {
            0
        })
    }

    // ------------------------------------------------------------- history

    /// Keep `rows` — the pad as it is before a write changes it — as its next
    /// version, holding each blob for it, then let go of the versions past
    /// what a pad keeps. Returns the change in bytes held.
    fn keep_version(
        tx: &rusqlite::Transaction,
        name: &str,
        rows: &BTreeMap<String, Row>,
        seq: u64,
        now: u64,
    ) -> Result<i64, Error> {
        let id: i64 = tx.query_row(
            "SELECT COALESCE(MAX(id), 0) + 1 FROM versions WHERE pad = ?1",
            [name],
            |r| r.get(0),
        )?;
        let bytes: u64 = rows.values().map(|r| r.size).sum();
        tx.execute(
            "INSERT INTO versions (pad, id, at_ms, seq, files, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![name, id, now as i64, seq as i64, rows.len() as i64, bytes as i64],
        )?;
        let mut held = 0;
        for (path, row) in rows {
            tx.execute(
                "INSERT INTO version_files (pad, version, path, blob, encoding, size, stored) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![name, id, path, row.blob, encoding_code(row.encoding), row.size as i64, row.stored as i64],
            )?;
            held += Self::count_ref(tx, &row.blob, row.stored, 1, now)?;
        }
        Ok(held + Self::prune_versions(tx, name, now)?)
    }

    /// Versions past [`VERSIONS_KEPT`], [`HISTORY_BYTES`] or [`VERSION_AGE`],
    /// oldest first, let go. The newest is always kept: it is the one a
    /// restore was most likely just made from.
    fn prune_versions(tx: &rusqlite::Transaction, name: &str, now: u64) -> Result<i64, Error> {
        let versions: Vec<(i64, u64, u64)> = {
            let mut q = tx.prepare_cached(
                "SELECT id, at_ms, bytes FROM versions WHERE pad = ?1 ORDER BY id DESC",
            )?;
            let rows = q.query_map([name], |r| {
                Ok((
                    r.get(0)?,
                    r.get::<_, i64>(1)? as u64,
                    r.get::<_, i64>(2)? as u64,
                ))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let oldest = now.saturating_sub(VERSION_AGE.as_millis() as u64);
        let mut total = 0u64;
        let mut held = 0;
        for (i, (id, at, bytes)) in versions.into_iter().enumerate() {
            total += bytes;
            if i == 0 || (i < VERSIONS_KEPT && total <= HISTORY_BYTES && at >= oldest) {
                continue;
            }
            held += Self::drop_version(tx, name, id, now)?;
        }
        Ok(held)
    }

    fn drop_version(
        tx: &rusqlite::Transaction,
        name: &str,
        id: i64,
        now: u64,
    ) -> Result<i64, Error> {
        let files: Vec<(String, u64)> = {
            let mut q = tx.prepare_cached(
                "SELECT blob, stored FROM version_files WHERE pad = ?1 AND version = ?2",
            )?;
            let rows = q.query_map(params![name, id], |r| {
                Ok((r.get(0)?, r.get::<_, i64>(1)? as u64))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let mut held = 0;
        for (blob, stored) in files {
            held += Self::count_ref(tx, &blob, stored, -1, now)?;
        }
        tx.execute(
            "DELETE FROM version_files WHERE pad = ?1 AND version = ?2",
            params![name, id],
        )?;
        tx.execute(
            "DELETE FROM versions WHERE pad = ?1 AND id = ?2",
            params![name, id],
        )?;
        Ok(held)
    }

    /// Every version a pad has, let go with it.
    fn drop_history(tx: &rusqlite::Transaction, name: &str, now: u64) -> Result<i64, Error> {
        let ids: Vec<i64> = {
            let mut q = tx.prepare_cached("SELECT id FROM versions WHERE pad = ?1")?;
            let rows = q.query_map([name], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut held = 0;
        for id in ids {
            held += Self::drop_version(tx, name, id, now)?;
        }
        Ok(held)
    }

    /// When the newest version was kept, and the blob of each file it named.
    fn newest_version(db: &Connection, name: &str) -> Result<Option<(u64, Manifest)>, Error> {
        let Some((id, at)): Option<(i64, i64)> = db
            .query_row(
                "SELECT id, at_ms FROM versions WHERE pad = ?1 ORDER BY id DESC LIMIT 1",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
        else {
            return Ok(None);
        };
        let mut q = db.prepare_cached(
            "SELECT path, blob FROM version_files WHERE pad = ?1 AND version = ?2",
        )?;
        let files = q
            .query_map(params![name, id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<Result<_, _>>()?;
        Ok(Some((at as u64, files)))
    }

    /// Whether a name holds a pad now: written, and not lapsed. What every
    /// read of a pad's content asks first — its files, its history, a
    /// version, its last run — so that a pad past its lease is gone for all
    /// of them at once, not only for the ones that remembered to look, while
    /// it waits for the hourly sweep (audit B11).
    fn live(&self, db: &Connection, name: &str) -> Result<bool, Error> {
        Ok(Self::head(db, name)?.is_some_and(|h| !self.lapsed(name, h.touched_ms)))
    }

    /// A pad's versions, newest first. None for a pad that has lapsed.
    pub fn history(&self, name: &str) -> Result<Vec<Version>, Error> {
        check_name(name)?;
        let db = self.db.lock();
        if !self.live(&db, name)? {
            return Ok(Vec::new());
        }
        let mut q = db.prepare_cached(
            "SELECT id, at_ms, files, bytes FROM versions WHERE pad = ?1 ORDER BY id DESC",
        )?;
        let rows = q.query_map([name], |r| {
            Ok(Version {
                id: r.get::<_, i64>(0)? as u64,
                at_ms: r.get::<_, i64>(1)? as u64,
                files: r.get::<_, i64>(2)? as u64,
                bytes: r.get::<_, i64>(3)? as u64,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// One version's files opened to be streamed, as [`Store::open_for_read`]
    /// opens a pad: the document after its opening brace, `"id":…,"files":
    /// {…}}`, each file sent from its blob. `Ok(None)` when there is no such
    /// version, kept or still, or the pad has lapsed.
    ///
    /// It was read whole: every file into a string, then all of it into one
    /// JSON value and out again — a version can be as big as the pad was, up
    /// to 100 MiB, and a few at once took a fair part of the relay's memory
    /// (audit B03). Streamed, it costs a chunk buffer, as a read does.
    pub fn open_version(&self, name: &str, id: u64) -> Result<Option<Opened>, Error> {
        check_name(name)?;
        let (rows, reading) = {
            let db = self.db.lock();
            if !self.live(&db, name)? {
                return Ok(None);
            }
            let exists: bool = db.query_row(
                "SELECT EXISTS (SELECT 1 FROM versions WHERE pad = ?1 AND id = ?2)",
                params![name, id as i64],
                |r| r.get(0),
            )?;
            if !exists {
                return Ok(None);
            }
            let mut q = db.prepare_cached("SELECT path, blob, encoding, stored FROM version_files WHERE pad = ?1 AND version = ?2 ORDER BY path")?;
            let rows: Vec<(String, String, Encoding, u64)> = q
                .query_map(params![name, id as i64], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        encoding_from(r.get(2)?),
                        r.get::<_, i64>(3)? as u64,
                    ))
                })?
                .collect::<Result<_, _>>()?;
            let reading = self.hold(&db, rows.iter().map(|(_, b, _, _)| b.clone()).collect());
            (rows, reading)
        };
        let (parts, remaining) = self.streamed(
            format!(r#""id":{id},"files":{{"#),
            rows.iter().map(|(path, blob, encoding, stored)| {
                (
                    path.as_str(),
                    blob.as_str(),
                    *stored,
                    format!(r#""encoding":"{}","seq":0"#, encoding_name(*encoding)),
                )
            }),
        )?;
        Ok(Some(Opened {
            parts,
            remaining,
            reading,
        }))
    }

    /// One version's files, read whole. For the tests: over HTTP a version
    /// goes out through [`Store::open_version`], which this reads back.
    #[cfg(test)]
    pub fn version(&self, name: &str, id: u64) -> Result<Option<BTreeMap<String, File>>, Error> {
        use std::io::Read;
        let Some(opened) = self.open_version(name, id)? else {
            return Ok(None);
        };
        let mut rest = String::new();
        opened.into_reader().read_to_string(&mut rest)?;
        #[derive(Deserialize)]
        struct Kept {
            files: BTreeMap<String, File>,
        }
        let kept: Kept =
            serde_json::from_str(&format!("{{{rest}")).map_err(|e| Error::Io(e.to_string()))?;
        Ok(Some(kept.files))
    }

    /// Files as the pieces of a JSON object, `before` in front of them: for
    /// each, its key and `"content":`, its blob — sent from its file, already
    /// a JSON string — and then `fields`, the rest of its members. Returns the
    /// pieces and how many bytes they come to, which is the response's
    /// length, so `stored` must be each blob's size on disk.
    fn streamed<'a>(
        &self,
        before: String,
        files: impl Iterator<Item = (&'a str, &'a str, u64, String)>,
    ) -> Result<(Vec<Part>, u64), Error> {
        let mut parts = Vec::new();
        let mut remaining = 0u64;
        let mut text = before;
        for (i, (path, blob, stored, fields)) in files.enumerate() {
            let key = serde_json::to_string(path).map_err(|e| Error::Io(e.to_string()))?;
            text.push_str(&format!(
                r#"{}{key}:{{"content":"#,
                if i > 0 { "," } else { "" }
            ));
            remaining += text.len() as u64;
            parts.push(Part::Bytes(std::mem::take(&mut text).into_bytes()));
            remaining += stored;
            parts.push(Part::Blob(self.blob_path(blob)));
            text = format!(",{fields}}}");
        }
        text.push_str("}}");
        remaining += text.len() as u64;
        parts.push(Part::Bytes(text.into_bytes()));
        Ok((parts, remaining))
    }

    /// Keep the pad as it is now as a version, unless the newest already is
    /// it: asked for before a restore, so whatever the restore replaces can be
    /// had back. Returns the version that is the pad now, if it has files —
    /// and none for a lapsed pad, which is nobody's to keep.
    pub fn keep_now(&self, name: &str) -> Result<Option<u64>, Error> {
        check_name(name)?;
        let mut db = self.db.lock();
        let Some(head) = Self::head(&db, name)? else {
            return Ok(None);
        };
        if self.lapsed(name, head.touched_ms) {
            return Ok(None);
        }
        let rows = Self::rows(&db, name)?;
        if rows.is_empty() {
            return Ok(None);
        }
        if let Some((_, files)) = Self::newest_version(&db, name)? {
            let same = files.len() == rows.len()
                && rows.iter().all(|(p, r)| files.get(p) == Some(&r.blob));
            if same {
                let id: i64 =
                    db.query_row("SELECT MAX(id) FROM versions WHERE pad = ?1", [name], |r| {
                        r.get(0)
                    })?;
                return Ok(Some(id as u64));
            }
        }
        let now = now_ms();
        let tx = db.transaction()?;
        let held = Self::keep_version(&tx, name, &rows, head.seq, now)?;
        tx.commit()?;
        self.adjust(held);
        self.release(&db);
        let id: i64 = db.query_row("SELECT MAX(id) FROM versions WHERE pad = ?1", [name], |r| {
            r.get(0)
        })?;
        Ok(Some(id as u64))
    }

    /// Delete a pad outright — its owner said so. The name is the accounts
    /// store's to retire; here it is only its files.
    pub fn remove(&self, name: &str) -> Result<(), Error> {
        check_name(name)?;
        self.pinned.write().remove(name);
        self.drop_pad(name)?;
        Ok(())
    }

    /// Delete a pad's rows and let go of its blobs. True if there was one.
    fn drop_pad(&self, name: &str) -> Result<bool, Error> {
        let mut db = self.db.lock();
        if Self::head(&db, name)?.is_none() {
            return Ok(false);
        }
        let old = Self::rows(&db, name)?;
        let tx = db.transaction()?;
        let now = now_ms();
        let held = Self::apply_rows(&tx, name, &old, &BTreeMap::new(), &[], now)?
            + Self::drop_history(&tx, name, now)?
            + Self::drop_run(&tx, name)?;
        tx.execute("DELETE FROM pads WHERE name = ?1", [name])?;
        tx.commit()?;
        self.adjust(held);
        self.release(&db);
        Ok(true)
    }

    fn adjust(&self, held: i64) {
        if held >= 0 {
            self.used.fetch_add(held as u64, Ordering::Relaxed);
        } else {
            self.used.fetch_sub(held.unsigned_abs(), Ordering::Relaxed);
        }
    }

    /// Whether a name holds a pad: written, and not lapsed.
    pub fn exists(&self, name: &str) -> Result<bool, Error> {
        check_name(name)?;
        let db = self.db.lock();
        Ok(Self::head(&db, name)?.is_some_and(|h| !self.lapsed(name, h.touched_ms)))
    }

    /// Read a pad whole. `Ok(None)` means the name is free — nobody has
    /// written it, or its lease lapsed. For the tests: a read over HTTP goes
    /// through [`Store::open_for_read`].
    #[cfg(test)]
    pub fn get(&self, name: &str) -> Result<Option<Pad>, Error> {
        check_name(name)?;
        self.load(name, false)
    }

    /// A pad, its files read from their blobs; lapsed ones too if asked.
    ///
    /// An expired pad reads as free rather than being deleted: deletion
    /// belongs to the sweeper, so a read never removes a pad a write replaced
    /// after the read looked.
    fn load(&self, name: &str, lapsed_too: bool) -> Result<Option<Pad>, Error> {
        let (head, rows, _reading) = {
            let db = self.db.lock();
            let Some(head) = Self::head(&db, name)? else {
                return Ok(None);
            };
            if !lapsed_too && self.lapsed(name, head.touched_ms) {
                return Ok(None);
            }
            let rows = Self::rows(&db, name)?;
            let reading = self.hold(&db, rows.values().map(|r| r.blob.clone()).collect());
            (head, rows, reading)
        };
        let mut files = BTreeMap::new();
        for (path, row) in rows {
            files.insert(
                path,
                File {
                    content: self.blob_text(&row.blob)?,
                    encoding: row.encoding,
                    seq: row.seq,
                },
            );
        }
        Ok(Some(Pad {
            seq: head.seq,
            created_ms: head.created_ms,
            updated_ms: head.updated_ms,
            files,
        }))
    }

    /// What a link preview shows of a pad: how many files, which, and the first
    /// lines of the one that says most about it. `Ok(None)` means the name is
    /// free. Light on purpose: the paths and one file of at most
    /// [`SUMMARY_LEAD_MAX`] bytes, never the pad, since a preview is fetched
    /// by every chat app the link is pasted into. Not a touch, either: a bot
    /// looking at a link does not keep the pad alive.
    pub fn summary(&self, name: &str) -> Result<Option<Summary>, Error> {
        check_name(name)?;
        let (rows, lead, _reading) = {
            let db = self.db.lock();
            let Some(head) = Self::head(&db, name)? else {
                return Ok(None);
            };
            if self.lapsed(name, head.touched_ms) {
                return Ok(None);
            }
            let rows = Self::rows(&db, name)?;
            let lead = lead_file(&rows);
            let reading = self.hold(&db, lead.iter().map(|(_, r)| r.blob.clone()).collect());
            let ran: Option<(String, String)> = db
                .query_row(
                    "SELECT path, substr(output, 1, 4096) FROM last_runs WHERE pad = ?1",
                    [name],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            (rows, (lead, ran), reading)
        };
        let (lead, ran) = lead;
        let lead = match lead {
            Some((path, row)) => Some((path, self.blob_text(&row.blob)?)),
            None => None,
        };
        // What people made, not what pip installed: `.deps`, `.ajar` and the
        // like are a pad's machinery. The first preview of a Flask pad named
        // `.deps/bin/flask` and five more of them, and said 188 files.
        let theirs: Vec<&String> = rows.keys().filter(|p| !hidden(p)).collect();
        Ok(Some(Summary {
            files: theirs.len(),
            paths: theirs.into_iter().take(SUMMARY_PATHS).cloned().collect(),
            lead,
            ran,
        }))
    }

    /// Keep `run` as the pad's last run, in place of the one before: how many
    /// bytes it adds, which is what the writer is charged. `Ok(None)` for a
    /// pad that is not there, which has nothing to keep it with.
    ///
    /// Counted against the store's ceiling as a file is, and refused with
    /// [`Error::StoreFull`] when what it adds would go past it — a smaller one
    /// in place of a bigger one always goes in. Not counted against the
    /// account that owns the pad: what an account is charged is its files,
    /// which is what its dashboard shows a pad holding, and a run is at most
    /// [`LAST_RUN_MAX`] and two names a pad — 700 KiB for every pad an account
    /// may own together, against the 250 MiB it may hold — so charging it
    /// would add a second database write to every run for a sum the per-pad
    /// cap already bounds, and a size on the dashboard nobody could find in
    /// the pad.
    pub fn set_last_run(&self, name: &str, run: &LastRun) -> Result<Option<u64>, Error> {
        check_name(name)?;
        if run.output.len() > LAST_RUN_MAX {
            return Err(Error::TooBig {
                bytes: run.output.len(),
            });
        }
        if run.command.len() > LAST_RUN_NAME_MAX || run.path.len() > LAST_RUN_NAME_MAX {
            return Err(Error::BadPath("longer than a run's file or command may be"));
        }
        let db = self.db.lock();
        match Self::head(&db, name)? {
            Some(head) if !self.lapsed(name, head.touched_ms) => {}
            _ => return Ok(None),
        }
        let before = Self::stored_run(&db, name)?;
        let after = run.bytes();
        // Under the store's lock, as a write's check is, so the two cannot
        // both see the same room and together go past it.
        let grew = after.saturating_sub(before);
        if grew > 0 && self.used() + grew > self.ceiling {
            return Err(Error::StoreFull);
        }
        db.execute(
            "INSERT INTO last_runs (pad, path, command, exit, at_ms, output) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(pad) DO UPDATE SET path = excluded.path, command = excluded.command,
               exit = excluded.exit, at_ms = excluded.at_ms, output = excluded.output",
            params![name, run.path, run.command, run.exit, now_ms() as i64, run.output],
        )?;
        self.adjust(after as i64 - before as i64);
        Ok(Some(grew))
    }

    /// The pad's last run, if it has one — and none for a pad lapsed, whose
    /// name may be somebody else's next.
    pub fn last_run(&self, name: &str) -> Result<Option<LastRun>, Error> {
        check_name(name)?;
        let db = self.db.lock();
        match Self::head(&db, name)? {
            Some(head) if !self.lapsed(name, head.touched_ms) => {}
            _ => return Ok(None),
        }
        Ok(db
            .query_row(
                "SELECT path, command, exit, at_ms, output FROM last_runs WHERE pad = ?1",
                [name],
                |r| {
                    Ok(LastRun {
                        path: r.get(0)?,
                        command: r.get(1)?,
                        exit: r.get(2)?,
                        at_ms: r.get::<_, i64>(3)? as u64,
                        output: r.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    /// Open a pad to be streamed to a reader, without loading it. `Ok(None)`
    /// means the name is free.
    ///
    /// Opening counts as touching it, so its lease starts again — at most once
    /// a day, as renewing is a write. What is sent is the version this looked
    /// at: its blobs never change, and none is deleted while it is in use.
    pub fn open_for_read(&self, name: &str) -> Result<Option<Opened>, Error> {
        check_name(name)?;
        let (head, rows, reading) = {
            let db = self.db.lock();
            let Some(head) = Self::head(&db, name)? else {
                return Ok(None);
            };
            // Lapsed reads as free, the same as `get`, and for the same reason
            // is left for the sweeper to delete.
            if self.lapsed(name, head.touched_ms) {
                return Ok(None);
            }
            let now = now_ms();
            if Duration::from_millis(now.saturating_sub(head.touched_ms)) > RENEW_EVERY {
                db.execute(
                    "UPDATE pads SET touched_ms = ?2 WHERE name = ?1",
                    params![name, now as i64],
                )?;
            }
            let rows = Self::rows(&db, name)?;
            let reading = self.hold(&db, rows.values().map(|r| r.blob.clone()).collect());
            (head, rows, reading)
        };

        let (parts, remaining) = self.streamed(
            format!(
                r#""seq":{},"created_ms":{},"updated_ms":{},"files":{{"#,
                head.seq, head.created_ms, head.updated_ms
            ),
            rows.iter().map(|(path, row)| {
                (
                    path.as_str(),
                    row.blob.as_str(),
                    row.stored,
                    format!(
                        r#""encoding":"{}","seq":{},"hash":"{}""#,
                        encoding_name(row.encoding),
                        row.seq,
                        row.blob
                    ),
                )
            }),
        )?;
        Ok(Some(Opened {
            parts,
            remaining,
            reading,
        }))
    }

    /// Apply writes and removals with no allowance, and return the new sequence
    /// number. Every real write comes from an address with an allowance, so
    /// this exists only for the tests.
    #[cfg(test)]
    pub fn write(&self, name: &str, writes: &[Write]) -> Result<u64, Error> {
        self.write_within(name, writes, u64::MAX)
            .map(|written| written.seq)
    }

    /// Apply writes and removals, refusing any that would add more than
    /// `allowance` bytes to the pad, and say what was added.
    ///
    /// Last write wins, and this is where "last" is decided: the server stamps
    /// the order because no two browsers can agree on one.
    ///
    /// Only growth is charged. An edit that leaves a pad the same size or
    /// smaller always goes through, so somebody at their limit can still fix a
    /// typo — or make room.
    ///
    /// What it reads and writes is the files it is given. The rest of the pad
    /// is rows in a table, and stays as it is.
    pub fn write_within(
        &self,
        name: &str,
        writes: &[Write],
        allowance: u64,
    ) -> Result<Written, Error> {
        check_name(name)?;
        // Counted first, before anything is worked out for any of them. A
        // list cut short as it was read (`writes`, `edits`) is over these by
        // one, so it is refused here like the whole of it.
        if writes.len() > MAX_WRITES {
            return Err(Error::TooManyWrites);
        }
        let mut edits = 0usize;
        for w in writes {
            let n = w.edits.as_ref().map_or(0, Vec::len);
            edits += n;
            if n > MAX_EDITS || edits > MAX_EDITS_PER_REQUEST {
                return Err(Error::TooManyEdits);
            }
        }
        let mut seen = std::collections::HashSet::new();
        let mut edited = Vec::new();
        for w in writes {
            check_path(&w.path)?;
            // Anything but a deletion stores a file.
            if w.content.is_some() || w.edits.is_some() {
                check_storable(&w.path)?;
            }
            // A page decodes a binary file to show and run it, and content
            // that does not decode breaks that for everyone who opens the
            // pad. Edits are checked on what they leave, once applied.
            if let (Encoding::Base64, Some(content)) = (w.encoding, &w.content) {
                if !base64_shaped(content) {
                    return Err(Error::Unstorable {
                        path: w.path.clone(),
                        why: NOT_BASE64,
                    });
                }
            }
            if w.content.is_none() && w.edits.is_some() {
                if w.base.is_none() {
                    return Err(Error::BadEdit(
                        "edits need the hash of the file they apply to",
                    ));
                }
                // Against what is stored, not against another write in the
                // same request: each is worked out on its own.
                if seen.contains(w.path.as_str()) {
                    return Err(Error::BadEdit("a file is edited in a request of its own"));
                }
                edited.push(w);
            }
            seen.insert(w.path.as_str());
        }

        // Edits apply to the version they name. Checked now, and held so
        // nothing deletes it while they are applied, which is off the lock.
        let bases = if edited.is_empty() {
            None
        } else {
            let db = self.db.lock();
            let rows = match Self::head(&db, name)? {
                Some(h) if !self.lapsed(name, h.touched_ms) => Self::rows(&db, name)?,
                _ => BTreeMap::new(),
            };
            for w in &edited {
                if !names_version(rows.get(&w.path), w) {
                    return Err(Error::Stale);
                }
            }
            Some(self.hold(&db, edited.iter().filter_map(|w| w.base.clone()).collect()))
        };

        // A file written twice in one request ends as the second; the first
        // is not stored at all. Found from where each path is written last,
        // once through: it was every write against every one after it, which
        // a request of a few thousand deletions made seconds of work while
        // holding a write permit (audit B10).
        let mut final_at: HashMap<&str, usize> = HashMap::with_capacity(writes.len());
        for (i, w) in writes.iter().enumerate() {
            final_at.insert(w.path.as_str(), i);
        }
        let last: Vec<bool> = writes
            .iter()
            .enumerate()
            .map(|(i, w)| final_at[w.path.as_str()] == i)
            .collect();
        // More files kept by this request alone than a pad may hold is too
        // many whatever the pad has now: refused before a blob is staged for
        // any of them, rather than after writing them all out.
        let kept = writes
            .iter()
            .zip(&last)
            .filter(|(w, &last)| last && (w.content.is_some() || w.edits.is_some()))
            .count();
        if kept > MAX_FILES {
            return Err(Error::TooManyFiles);
        }

        // Each new file's blob, written beside the store with nobody waiting:
        // a large file takes a while, and every pad's reads and saves wait on
        // the lock. What could go wrong in the meantime is checked once it is
        // taken.
        let mut staged = Vec::with_capacity(writes.len());
        for (w, &last) in writes.iter().zip(&last) {
            staged.push(match (&w.content, &w.edits, &w.base) {
                _ if !last => None,
                (Some(content), _, _) => Some(self.stage_text(w.encoding, content)?),
                (None, Some(edits), Some(base)) => Some(self.stage_edits(w, base, edits)?),
                _ => None,
            });
        }

        let mut db = self.db.lock();
        // Blobs this write puts in place, deleted again if it does not go in.
        // Declared after the lock, so dropped before it is let go.
        let mut placed = Placed(Vec::new());
        let now = now_ms();
        let head = Self::head(&db, name)?;
        let old = Self::rows(&db, name)?;
        // A lapsed pad starts again: its files go, the name is the writer's.
        let live = head
            .as_ref()
            .is_some_and(|h| !self.lapsed(name, h.touched_ms));
        let seq = if live {
            head.as_ref().map_or(0, |h| h.seq)
        } else {
            0
        } + 1;
        let created_ms = head.as_ref().filter(|_| live).map_or(now, |h| h.created_ms);
        let mut new = if live { old.clone() } else { BTreeMap::new() };

        // Another write may have moved an edited file on since it was looked
        // at; then these edits were applied to the wrong text.
        for w in &edited {
            if !names_version(new.get(&w.path), w) {
                return Err(Error::Stale);
            }
        }

        let mut changed = Vec::new();
        for ((w, staged), &last) in writes.iter().zip(staged.iter_mut()).zip(&last) {
            if !last {
                continue;
            }
            match staged {
                Some(staged) => {
                    let stored = self.place(staged, w, &mut placed)?;
                    new.insert(
                        w.path.clone(),
                        Row {
                            blob: staged.hash.clone(),
                            encoding: w.encoding,
                            seq,
                            size: staged.size,
                            stored,
                        },
                    );
                }
                None => {
                    new.remove(&w.path);
                }
            }
            changed.push(w.path.clone());
        }

        // A path cannot be both a file and a directory. Checked on the result,
        // so a conflict is caught even when its two paths arrive in separate
        // requests.
        for path in new.keys() {
            for (slash, _) in path.match_indices('/') {
                if new.contains_key(&path[..slash]) {
                    return Err(Error::BadPath("a file is also used as a directory"));
                }
            }
        }
        // Checked after applying rather than before: a write that replaces a
        // large file with a small one should be allowed even when the pad was
        // already at the limit.
        if new.len() > MAX_FILES {
            return Err(Error::TooManyFiles);
        }
        let bytes: u64 = new.values().map(|r| r.size).sum();
        if bytes > MAX_BYTES as u64 {
            return Err(Error::TooBig {
                bytes: bytes as usize,
            });
        }

        // What this write costs, as a change in the pad's footprint. Replacing
        // a large pad with a small one gives the difference back, or the
        // ceiling ratchets shut on ordinary use. A lapsed pad still here
        // counts as occupied: the write replaces it.
        let was: u64 = old.values().map(|r| r.stored).sum();
        let footprint: u64 = new.values().map(|r| r.stored).sum();
        let grew = footprint.saturating_sub(was);
        // The caller's own allowance first: it is what they can do something
        // about, and it is the answer that is true when both would refuse.
        if grew > allowance {
            return Err(Error::OverAllowance);
        }

        // The way it was, kept as a version when the newest is old enough:
        // see [`VERSION_EVERY`]. Never a lapsed pad's way: that is somebody
        // else's, and was kept as the first version of whoever wrote next.
        let due = self.keeps_history
            && live
            && !old.is_empty()
            && !changed.is_empty()
            && Self::newest_version(&db, name)?
                .is_none_or(|(at, _)| now.saturating_sub(at) >= VERSION_EVERY.as_millis() as u64);
        let tx = db.transaction()?;
        let mut held = 0;
        // A lapsed pad still here until the sweep goes with this write, all
        // of it: its files above, and here its versions and its last run,
        // which otherwise came back as the new pad's (audit B11).
        if head.is_some() && !live {
            held += Self::drop_history(&tx, name, now)?;
            held += Self::drop_run(&tx, name)?;
        }
        if due {
            let was_seq = Self::head(&tx, name)?.map_or(0, |h| h.seq);
            held += Self::keep_version(&tx, name, &old, was_seq, now)?;
        }
        held += Self::apply_rows(&tx, name, &old, &new, &changed, now)?;
        if held > 0 && self.used.load(Ordering::Relaxed) + held as u64 > self.ceiling {
            // Rolled back with the transaction, and the blobs put in place
            // for it deleted.
            return Err(Error::StoreFull);
        }
        tx.execute(
            "INSERT INTO pads (name, seq, created_ms, updated_ms, touched_ms, bytes) VALUES (?1, ?2, ?3, ?4, ?4, ?5)
             ON CONFLICT(name) DO UPDATE SET seq = ?2, created_ms = ?3, updated_ms = ?4, touched_ms = ?4, bytes = ?5",
            params![name, seq as i64, created_ms as i64, now as i64, bytes as i64],
        )?;
        tx.commit()?;
        placed.keep();
        // Only once it is committed: counting before would charge the store
        // for bytes no pad holds.
        self.adjust(held);
        // The versions this replaced, the ones its edits started from among
        // them, unless somebody is still reading one.
        drop(bases);
        self.release(&db);
        let hashes = writes
            .iter()
            .filter_map(|w| new.get(&w.path).map(|r| (w.path.clone(), r.blob.clone())))
            .collect();
        Ok(Written {
            seq,
            grew,
            bytes,
            files: new.len() as u64,
            hashes,
        })
    }

    /// A file's new blob from its text, written to a temporary file unless
    /// the store already has it.
    fn stage_text(&self, encoding: Encoding, content: &str) -> Result<Staged, Error> {
        let hash = hash_of(encoding, content);
        let size = content.len() as u64;
        if self.blob_path(&hash).exists() {
            return Ok(Staged {
                hash,
                size,
                stored: 0,
                tmp: None,
            });
        }
        let tmp = self.tmp_path();
        let stored = write_json_string(&tmp, content)?;
        Ok(Staged {
            hash,
            size,
            stored,
            tmp: Some(tmp),
        })
    }

    /// A file's new blob from edits to the one it holds, streamed from one to
    /// the other. The one it holds is in use while this runs.
    fn stage_edits(&self, w: &Write, base: &str, edits: &[Edit]) -> Result<Staged, Error> {
        let encoding = w.encoding;
        let cuts = splice::cuts(edits).map_err(Error::BadEdit)?;
        let mut staged = Staged {
            hash: String::new(),
            size: 0,
            stored: 0,
            tmp: Some(self.tmp_path()),
        };
        let out = std::fs::File::create(staged.tmp.as_ref().expect("just set"))?;
        let from = std::fs::File::open(self.blob_path(base))?;
        let prefix: &[u8] = match encoding {
            Encoding::Utf8 => b"u",
            Encoding::Base64 => b"b",
        };
        let done = splice::splice(from, prefix, &cuts, &out).map_err(|e| match e {
            splice::Error::Edit(why) => Error::BadEdit(why),
            splice::Error::Io(e) => Error::Io(e.to_string()),
            splice::Error::Corrupt => {
                Error::Io(format!("the stored file {base} is not a JSON string"))
            }
        })?;
        // On the disk before it is renamed into place (see `settle`).
        out.sync_data()?;
        if encoding == Encoding::Base64 && !done.base64 {
            // Dropped, and with it the file it was written to.
            return Err(Error::Unstorable {
                path: w.path.clone(),
                why: NOT_BASE64,
            });
        }
        staged.hash = done.hash;
        staged.size = done.size;
        staged.stored = done.stored;
        Ok(staged)
    }

    /// A staged blob in its place, and its bytes on disk. Under the store's
    /// lock: nothing deletes a blob without it, so one found here stays.
    fn place(&self, staged: &mut Staged, w: &Write, placed: &mut Placed) -> Result<u64, Error> {
        let path = self.blob_path(&staged.hash);
        if let Ok(meta) = std::fs::metadata(&path) {
            staged.discard();
            return Ok(meta.len());
        }
        let stored = match staged.tmp.take() {
            Some(tmp) => {
                let made = self.blob_dir(&path)?;
                std::fs::rename(&tmp, &path).inspect_err(|_| {
                    let _ = std::fs::remove_file(&tmp);
                })?;
                self.settle(&path, made)?;
                staged.stored
            }
            // Already stored when it was staged, and deleted since.
            None => {
                let content = w
                    .content
                    .as_deref()
                    .ok_or_else(|| Error::Io("a staged file went missing".into()))?;
                self.put_blob(w.encoding, content)?.1
            }
        };
        placed.0.push(path);
        Ok(stored)
    }

    fn tmp_path(&self) -> PathBuf {
        // Unique per call, as two writers storing the same text at once is
        // ordinary.
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        self.blobs.join(format!(".{}.{n}.tmp", std::process::id()))
    }

    /// Mark blobs as in use until the guard is dropped. Takes the store's
    /// lock as proof it is held: nothing can be deleted between looking a
    /// blob up and marking it.
    fn hold(&self, _db: &Connection, blobs: Vec<String>) -> Reading {
        let mut in_use = self.in_use.lock();
        for hash in &blobs {
            *in_use.entry(hash.clone()).or_insert(0) += 1;
        }
        Reading {
            blobs,
            in_use: self.in_use.clone(),
        }
    }

    /// Delete the blobs no file holds and nothing is reading.
    ///
    /// Under the store's lock, which a write keeps from finding a blob in
    /// place to holding it. The one-document store rewrote a file in place; a
    /// blob is never changed, so every save of a file makes a new one, and
    /// until 11 October the old one stayed for ten minutes or more, uncounted:
    /// twenty one-character saves in a 60 MB file left 1.3 GB on disk.
    fn release(&self, db: &Connection) {
        let unheld: Vec<String> = {
            let Ok(mut q) = db.prepare_cached("SELECT hash FROM blobs WHERE refs = 0") else {
                return;
            };
            let Ok(rows) = q.query_map([], |r| r.get::<_, String>(0)) else {
                return;
            };
            rows.flatten().collect()
        };
        let in_use = self.in_use.lock();
        for hash in unheld.iter().filter(|h| !in_use.contains_key(*h)) {
            if db
                .execute("DELETE FROM blobs WHERE hash = ?1 AND refs = 0", [hash])
                .unwrap_or(0)
                == 1
            {
                let _ = std::fs::remove_file(self.blob_path(hash));
            }
        }
    }

    /// Delete a pad whose lease has lapsed, and give its bytes back. True if it
    /// did. Decided and done under the store's lock, looking at the pad as it
    /// is now, so a pad written since it was listed is left alone.
    pub fn expire_if_lapsed(&self, name: &str) -> bool {
        {
            let db = self.db.lock();
            match Self::head(&db, name) {
                Ok(Some(head)) if self.lapsed(name, head.touched_ms) => {}
                _ => return false,
            }
        }
        // Between the look and the drop a write can land; `drop_pad` takes the
        // lock again, so look once more inside it.
        let mut db = self.db.lock();
        let Ok(Some(head)) = Self::head(&db, name) else {
            return false;
        };
        if !self.lapsed(name, head.touched_ms) {
            return false;
        }
        let Ok(old) = Self::rows(&db, name) else {
            return false;
        };
        let Ok(tx) = db.transaction() else {
            return false;
        };
        let now = now_ms();
        let Ok(held) = Self::apply_rows(&tx, name, &old, &BTreeMap::new(), &[], now)
            .and_then(|h| Ok(h + Self::drop_history(&tx, name, now)?))
            .and_then(|h| Ok(h + Self::drop_run(&tx, name)?))
        else {
            return false;
        };
        if tx
            .execute("DELETE FROM pads WHERE name = ?1", [name])
            .is_err()
            || tx.commit().is_err()
        {
            return false;
        }
        self.adjust(held);
        self.release(&db);
        true
    }

    /// What the store holds, for the operator's view: how many pads, how
    /// recently each was last opened or written, and the biggest.
    pub fn census(&self, top: usize) -> Census {
        let mut census = Census {
            pads: 0,
            owned: 0,
            bytes: self.used(),
            ceiling: self.ceiling,
            touched_1d: 0,
            touched_7d: 0,
            touched_30d: 0,
            biggest: Vec::new(),
        };
        let all: Vec<(String, u64, u64)> = {
            let db = self.db.lock();
            let Ok(mut q) = db.prepare("SELECT name, bytes, touched_ms FROM pads") else {
                return census;
            };
            let Ok(rows) = q.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)? as u64,
                    r.get::<_, i64>(2)? as u64,
                ))
            }) else {
                return census;
            };
            rows.flatten().collect()
        };
        let pinned = self.pinned.read();
        let now = now_ms();
        let mut sizes = Vec::new();
        for (name, bytes, touched_ms) in all {
            let owned = pinned.contains(&name);
            let idle = Duration::from_millis(now.saturating_sub(touched_ms));
            if !owned && idle > LEASE {
                continue;
            }
            census.pads += 1;
            census.owned += owned as u64;
            census.touched_1d += (idle <= Duration::from_secs(86_400)) as u64;
            census.touched_7d += (idle <= Duration::from_secs(7 * 86_400)) as u64;
            census.touched_30d += (idle <= Duration::from_secs(30 * 86_400)) as u64;
            sizes.push(PadSize {
                name,
                bytes,
                touched: touched_ms / 1000,
                owned,
            });
        }
        sizes.sort_by_key(|p| std::cmp::Reverse(p.bytes));
        sizes.truncate(top);
        census.biggest = sizes;
        census
    }

    /// Delete everything past its lease, freeing the names, and the blobs
    /// nothing holds or is reading. Returns the names.
    pub fn sweep(&self) -> Vec<String> {
        let cutoff = now_ms().saturating_sub(LEASE.as_millis() as u64);
        let candidates: Vec<String> = {
            let db = self.db.lock();
            let Ok(mut q) = db.prepare("SELECT name FROM pads WHERE touched_ms < ?1") else {
                return Vec::new();
            };
            let Ok(rows) = q.query_map([cutoff as i64], |r| r.get::<_, String>(0)) else {
                return Vec::new();
            };
            rows.flatten().collect()
        };
        let expired: Vec<String> = candidates
            .into_iter()
            .filter(|name| self.expire_if_lapsed(name))
            .collect();
        self.collect(GRACE);
        expired
    }

    /// Delete blobs nothing holds or is reading, and files in the blob
    /// directory the table has not known for `grace` — written for a write
    /// that was then refused, or by a process that stopped between the two.
    fn collect(&self, grace: Duration) {
        // Blobs a read was still sending when a write let go of them.
        self.release(&self.db.lock());
        // Files the table never heard of, past the grace — their writes may
        // still be about to commit.
        let Ok(shards) = std::fs::read_dir(&self.blobs) else {
            return;
        };
        for shard in shards.flatten() {
            let path = shard.path();
            let old_enough = |meta: &std::fs::Metadata| {
                meta.modified()
                    .ok()
                    .and_then(|m| SystemTime::now().duration_since(m).ok())
                    .is_some_and(|age| age >= grace)
            };
            if path.is_file() {
                // A temporary file left by a process that stopped mid-write.
                if shard.metadata().is_ok_and(|m| old_enough(&m)) {
                    let _ = std::fs::remove_file(&path);
                }
                continue;
            }
            let Ok(files) = std::fs::read_dir(&path) else {
                continue;
            };
            for file in files.flatten() {
                let Some(hash) = file.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if !file.metadata().is_ok_and(|m| old_enough(&m)) {
                    continue;
                }
                let db = self.db.lock();
                let known = db
                    .query_row("SELECT 1 FROM blobs WHERE hash = ?1", [&hash], |_| Ok(()))
                    .optional()
                    .unwrap_or(Some(()))
                    .is_some();
                if !known {
                    let _ = std::fs::remove_file(file.path());
                }
            }
        }
    }

    /// Write every pad out the old way — `<name>.json`, one document each, its
    /// modification time its lease — into `out`. What a relay from before this
    /// store reads, and so the way back.
    pub fn export_legacy(&self, out: &Path) -> Result<usize, Error> {
        std::fs::create_dir_all(out)?;
        let names: Vec<(String, u64)> = {
            let db = self.db.lock();
            let mut q = db.prepare("SELECT name, touched_ms FROM pads ORDER BY name")?;
            let rows = q.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let mut written = 0;
        for (name, touched_ms) in names {
            // Lapsed or not: the store has not swept it, so neither does this.
            let Some(pad) = self.load(&name, true)? else {
                continue;
            };
            let path = out.join(format!("{name}.json"));
            std::fs::write(
                &path,
                serde_json::to_vec(&pad).map_err(|e| Error::Io(e.to_string()))?,
            )?;
            let _ = std::fs::File::options()
                .write(true)
                .open(&path)
                .and_then(|f| f.set_modified(UNIX_EPOCH + Duration::from_millis(touched_ms)));
            written += 1;
        }
        Ok(written)
    }

    /// Set when a pad was last touched, for tests of the lease.
    #[cfg(test)]
    pub fn set_touched(&self, name: &str, ago: Duration) {
        let at = now_ms().saturating_sub(ago.as_millis() as u64);
        self.db
            .lock()
            .execute(
                "UPDATE pads SET touched_ms = ?2 WHERE name = ?1",
                params![name, at as i64],
            )
            .unwrap();
    }

    /// How long ago a pad was last touched, for tests of the lease.
    #[cfg(test)]
    fn idle_of(&self, name: &str) -> Duration {
        let db = self.db.lock();
        let head = Self::head(&db, name).unwrap().expect("the pad exists");
        Duration::from_millis(now_ms().saturating_sub(head.touched_ms))
    }
}

/// See [`Store::census`].
#[derive(Debug, Serialize)]
pub struct Census {
    pub pads: u64,
    /// Of those, the ones that belong to an account.
    pub owned: u64,
    pub bytes: u64,
    pub ceiling: u64,
    /// Opened or written within a day, a week, a month — from the lease,
    /// which a read renews at most once a day.
    pub touched_1d: u64,
    pub touched_7d: u64,
    pub touched_30d: u64,
    pub biggest: Vec<PadSize>,
}

#[derive(Debug, Serialize)]
pub struct PadSize {
    pub name: String,
    pub bytes: u64,
    /// When it was last opened or written, in Unix seconds.
    pub touched: u64,
    pub owned: bool,
}

fn stem(path: &Path) -> Option<String> {
    path.file_stem()?.to_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_census_counts_live_pads_and_leaves_out_lapsed_ones() {
        let dir = tempdir::Dir::new();
        let s = Store::open(dir.path(), u64::MAX).unwrap();
        s.write("fresh", &[put("a.txt", "x")]).unwrap();
        s.write("big", &[put("a.txt", &"y".repeat(5000))]).unwrap();
        s.write("old", &[put("a.txt", "z")]).unwrap();
        s.write("kept", &[put("a.txt", "k")]).unwrap();
        s.pin("kept");
        touched(&s, "old", LEASE + Duration::from_secs(60));
        touched(&s, "kept", Duration::from_secs(10 * 86_400));
        let c = s.census(2);
        assert_eq!((c.pads, c.owned), (3, 1), "a lapsed pad is not counted");
        assert_eq!((c.touched_1d, c.touched_7d, c.touched_30d), (2, 2, 3));
        assert_eq!(c.biggest.len(), 2);
        assert_eq!(c.biggest[0].name, "big");
    }

    #[test]
    fn a_pinned_pad_outlives_its_lease_and_removing_it_frees_its_bytes() {
        let dir = tempdir::Dir::new();
        let s = Store::open(dir.path(), u64::MAX).unwrap();
        s.write("owned", &[put("a.txt", "kept")]).unwrap();
        s.write("anon", &[put("a.txt", "lapses")]).unwrap();
        s.pin("owned");
        for name in ["owned", "anon"] {
            touched(&s, name, LEASE + Duration::from_secs(60));
        }
        assert_eq!(s.sweep(), vec!["anon".to_string()]);
        assert!(
            s.get("owned").unwrap().is_some(),
            "an owned pad does not lapse"
        );
        s.remove("owned").unwrap();
        assert!(s.get("owned").unwrap().is_none());
        assert_eq!(s.used(), 0);
    }

    /// Audit B07. A power cut is not something a test can make; what it can
    /// hold is the setting that makes a commit outlast one, and that every
    /// blob a save names is in its place, with no temporary file left, when
    /// the save returns — whole or by edits.
    #[test]
    fn a_save_is_committed_in_full_and_its_blobs_are_in_place_when_it_returns() {
        let (s, _d) = store();
        let mode: i64 =
            s.db.lock()
                .query_row("PRAGMA synchronous", [], |r| r.get(0))
                .unwrap();
        assert_eq!(mode, 2, "synchronous = FULL");
        s.write("p", &[put("a.txt", "one two")]).unwrap();
        let whole = hash(&s, "p", "a.txt");
        s.write("p", &[edit("a.txt", &whole, 3, 0, " and")])
            .unwrap();
        let edited = hash(&s, "p", "a.txt");
        for blob in [&whole, &edited] {
            assert!(s.blob_path(blob).is_file(), "blob {blob} is in place");
        }
        let stray: Vec<_> = std::fs::read_dir(&s.blobs)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(stray.is_empty(), "no temporary file is left: {stray:?}");
        assert_eq!(
            s.get("p").unwrap().unwrap().files["a.txt"].content,
            "one and two"
        );
    }

    /// A pad ~1 MiB on disk, so a ceiling can be reached without writing 4 GB.
    /// Its text is its own: the same text in two pads is stored once.
    fn megabyte(s: &Store, name: &str) -> Result<u64, Error> {
        s.write(
            name,
            &[put(
                "big.txt",
                &format!("{name}{}", "x".repeat(1024 * 1024)),
            )],
        )
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
        let (s, _d) = store_without_history();
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

    /// For the tests of how blobs are let go: a version would hold the blob
    /// they watch go.
    fn store_without_history() -> (Store, tempdir::Dir) {
        let (mut s, d) = store();
        s.keeps_history = false;
        (s, d)
    }

    fn put(path: &str, content: &str) -> Write {
        Write {
            path: path.into(),
            content: Some(content.into()),
            encoding: Encoding::Utf8,
            base: None,
            edits: None,
        }
    }

    fn delete(path: &str) -> Write {
        Write {
            path: path.into(),
            content: None,
            encoding: Encoding::Utf8,
            base: None,
            edits: None,
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
                base: None,
                edits: None,
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
                matches!(
                    s.write("p", &[put(bad, "x")]),
                    Err(Error::BadPath(_) | Error::Unstorable { .. })
                ),
                "{bad:?} should be refused"
            );
        }
    }

    /// What a write was refused for, if it was refused for a file: its
    /// message, which has to name the file.
    fn refused_naming(result: Result<u64, Error>, path: &str) -> String {
        match result {
            Err(e @ Error::Unstorable { .. }) => {
                let message = e.message();
                assert!(
                    message.contains(&format!("{path:?}")),
                    "the refusal does not name {path:?}: {message}"
                );
                message
            }
            other => panic!("{path:?} was not refused by name: {other:?}"),
        }
    }

    #[test]
    fn a_path_with_a_control_character_or_a_backslash_is_refused_by_name() {
        let (s, _d) = store();
        for bad in [
            "notes\tdraft.txt",
            "two\nlines.py",
            "dir/carriage\r.txt",
            "bell\u{7}.txt",
            "colour\u{1b}[31m.txt",
            "delete\u{7f}.txt",
            "dir\\file.txt",
        ] {
            refused_naming(s.write("p", &[put(bad, "x")]), bad);
        }
        let message = refused_naming(s.write("p", &[put("a\nb", "x")]), "a\nb");
        assert!(
            !message.contains('\n'),
            "the name broke the message: {message}"
        );
        assert!(s.get("p").unwrap().is_none(), "a refused write was stored");
        // Not every character past ASCII is a control character.
        s.write("p", &[put("café/naïve 😀 file.txt", "x")]).unwrap();

        // A pad that holds one from before can still let go of it.
        s.db.lock()
            .execute(
                "UPDATE files SET path = 'old\tname.txt' WHERE pad = 'p'",
                [],
            )
            .unwrap();
        s.write("p", &[remove("old\tname.txt")]).unwrap();
        assert!(s.get("p").unwrap().unwrap().files.is_empty());
    }

    #[test]
    fn base64_that_is_not_base64_is_refused() {
        let (s, _d) = store();
        let binary = |path: &str, content: &str| Write {
            encoding: Encoding::Base64,
            ..put(path, content)
        };
        for bad in [
            "not base64!",
            "QUJD\n",
            "QU JD",
            "QQ=",
            "Q===",
            "QQ==QUJD",
            "QUJD-_",
        ] {
            refused_naming(s.write("p", &[binary("x.bin", bad)]), "x.bin");
        }
        assert!(s.get("p").unwrap().is_none());
        // Whole, padded or not, and the first part of a file sent in parts,
        // which stops wherever its request ran out.
        for good in ["", "QQ==", "QUI=", "QUJD", "iVBORw0KGgo=", "QUJDR"] {
            s.write("p", &[binary("x.bin", good)])
                .unwrap_or_else(|e| panic!("{good:?}: {}", e.message()));
        }
        // An edit is held to what it leaves.
        let base = s
            .write_within("p", &[binary("x.bin", "QUJD")], u64::MAX)
            .unwrap()
            .hashes["x.bin"]
            .clone();
        let padded_in_the_middle = Write {
            encoding: Encoding::Base64,
            ..edit("x.bin", &base, 2, 0, "==")
        };
        refused_naming(s.write("p", &[padded_in_the_middle]), "x.bin");
        assert_eq!(s.get("p").unwrap().unwrap().files["x.bin"].content, "QUJD");
        assert!(s.in_use.lock().is_empty(), "the edited blob is still held");
        let the_rest = Write {
            encoding: Encoding::Base64,
            ..edit("x.bin", &base, 4, 0, "RA==")
        };
        s.write("p", &[the_rest]).unwrap();
        assert_eq!(
            s.get("p").unwrap().unwrap().files["x.bin"].content,
            "QUJDRA=="
        );
        // Text is text, whatever it says.
        s.write("p", &[put("notes.txt", "not base64!")]).unwrap();
    }

    #[test]
    fn the_pages_own_folders_are_not_stored_but_can_be_cleaned() {
        // Review M7: the page never saves `.ajar/` or a `.git` folder, and
        // never shows them, so a file put there through the API is code
        // nobody sees — and `.ajar/` is where the page runs its own.
        let (s, _d) = store();
        for bad in [
            ".ajar/site/sitecustomize.py",
            ".ajar/box.py",
            ".deps/sitecustomize.py",
            ".deps/flask/__init__.py",
            ".git/config",
            "src/.git/hooks/pre-commit",
        ] {
            let message = refused_naming(s.write("p", &[put(bad, "x")]), bad);
            assert!(message.contains("never"), "{message}");
        }
        // Edits as much as whole files.
        s.write("p", &[put("main.py", "print(1)")]).unwrap();
        s.db.lock()
            .execute("UPDATE files SET path = '.ajar/box.py' WHERE pad = 'p'", [])
            .unwrap();
        let base = hash(&s, "p", ".ajar/box.py");
        refused_naming(
            s.write("p", &[edit(".ajar/box.py", &base, 0, 0, "import os\n")]),
            ".ajar/box.py",
        );
        // What a pad already holds there can be deleted.
        s.write("p", &[remove(".ajar/box.py")]).unwrap();
        assert!(s.get("p").unwrap().unwrap().files.is_empty());
        // Not every dot is the page's: an `.ajar` or `.deps` that is not the
        // top one is a folder of somebody's, and a file called `.git` is a file.
        for fine in [
            "sub/.deps/notes.txt",
            "sub/.ajar/notes.txt",
            "vendor/.git",
            ".gitignore",
        ] {
            s.write("p", &[put(fine, "x")])
                .unwrap_or_else(|e| panic!("{fine:?}: {}", e.message()));
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
    fn a_file_written_twice_in_one_request_ends_as_the_second() {
        let (s, _d) = store();
        s.write(
            "p",
            &[put("a", "1"), put("b", "2"), put("a", "3"), delete("b")],
        )
        .unwrap();
        let pad = s.get("p").unwrap().unwrap();
        assert_eq!(pad.files["a"].content, "3");
        assert!(!pad.files.contains_key("b"));
        // Put back after a removal in the same request, it stays.
        s.write("p", &[delete("a"), put("a", "4")]).unwrap();
        assert_eq!(s.get("p").unwrap().unwrap().files["a"].content, "4");
        // And the files a request keeps are counted on their last write:
        // the same path five hundred and one times is one file.
        let same: Vec<Write> = (0..=MAX_FILES).map(|i| put("c", &i.to_string())).collect();
        s.write("p", &same).unwrap();
        assert_eq!(
            s.get("p").unwrap().unwrap().files["c"].content,
            MAX_FILES.to_string()
        );
    }

    #[test]
    fn a_request_is_read_no_further_than_it_may_go() {
        // Audit B10: a request could hold millions of changes, each parsed
        // into a struct many times its size. They are kept to one past the
        // most a request may make, as they are read, and the store refuses
        // a list that long as it would have refused the whole of it.
        #[derive(Deserialize)]
        struct Body {
            #[serde(deserialize_with = "writes")]
            writes: Vec<Write>,
        }
        let json = format!(
            r#"{{"writes":[{}]}}"#,
            vec![r#"{"path":"a"}"#; 50_000].join(",")
        );
        let body: Body = serde_json::from_str(&json).unwrap();
        assert_eq!(body.writes.len(), MAX_WRITES + 1);
        let (s, _d) = store();
        assert_eq!(s.write("p", &body.writes).err(), Some(Error::TooManyWrites));
        assert_eq!(s.write("p", &body.writes[..MAX_WRITES]).err(), None);

        // A file's edits, the same way.
        let edits = vec![r#"{"at":0,"remove":0}"#; 5_000].join(",");
        let w: Write =
            serde_json::from_str(&format!(r#"{{"path":"a","base":"x","edits":[{edits}]}}"#))
                .unwrap();
        assert_eq!(w.edits.as_ref().map(Vec::len), Some(MAX_EDITS + 1));
        assert_eq!(s.write("p", &[w]).err(), Some(Error::TooManyEdits));

        // And a request's edits together: kept up to the write that takes
        // them past the most, which is then refused.
        let file = |f: usize| {
            format!(
                r#"{{"path":"f{f}","base":"x","edits":[{}]}}"#,
                vec![r#"{"at":0,"remove":0}"#; MAX_EDITS].join(",")
            )
        };
        let files: Vec<String> = (0..20).map(file).collect();
        let body: Body =
            serde_json::from_str(&format!(r#"{{"writes":[{}]}}"#, files.join(","))).unwrap();
        assert_eq!(body.writes.len(), MAX_EDITS_PER_REQUEST / MAX_EDITS + 1);
        assert_eq!(s.write("p", &body.writes).err(), Some(Error::TooManyEdits));
        // And `null` for edits is still none at all.
        let none: Write =
            serde_json::from_str(r#"{"path":"a","content":"x","edits":null}"#).unwrap();
        assert!(none.edits.is_none());
    }

    /// Set when a stored pad was last touched, as `ago` before now.
    fn touched(s: &Store, name: &str, ago: Duration) {
        s.set_touched(name, ago);
    }

    /// Push a stored pad past its lease.
    fn age(s: &Store, name: &str) {
        touched(s, name, LEASE + Duration::from_secs(60));
    }

    fn idle(s: &Store, name: &str) -> Duration {
        s.idle_of(name)
    }

    #[test]
    fn opening_a_pad_keeps_it_alive() {
        // A demo opened every day and edited once a month is the pad a lease
        // should never take. Reads count as touching it now, so it lasts as
        // long as somebody looks — not only as long as somebody types.
        let (s, _d) = store();
        s.write("demo", &[put("main.py", "print(1)")]).unwrap();
        touched(&s, "demo", LEASE - Duration::from_secs(3600));

        assert!(s.open_for_read("demo").unwrap().is_some());
        assert!(
            idle(&s, "demo") < Duration::from_secs(60),
            "opening it did not restart its lease: idle for {:?}",
            idle(&s, "demo")
        );
    }

    #[test]
    fn a_read_renews_at_most_once_a_day() {
        // Renewing is a write to the disk, and a busy pad is read thousands of
        // times a day. An hour-old touch is fresh enough to leave alone.
        let (s, _d) = store();
        s.write("busy", &[put("a", "1")]).unwrap();
        touched(&s, "busy", Duration::from_secs(3600));
        s.open_for_read("busy").unwrap();
        assert!(
            idle(&s, "busy") > Duration::from_secs(3500),
            "a read renewed a lease that was only an hour old"
        );
    }

    #[test]
    fn a_write_within_its_allowance_is_charged_what_it_added() {
        let (s, _d) = store();
        let first = s
            .write_within("p", &[put("a", &"x".repeat(1000))], u64::MAX)
            .unwrap();
        assert_eq!(first.seq, 1);
        assert!(first.grew > 1000, "the new pad was not charged: {first:?}");

        let same = s
            .write_within("p", &[put("a", &"y".repeat(1000))], 0)
            .unwrap();
        assert_eq!(same.grew, 0, "an edit that added nothing was charged");
    }

    #[test]
    fn growth_past_the_allowance_is_refused_and_costs_nothing() {
        let (s, _d) = store();
        s.write("p", &[put("a", "small")]).unwrap();
        let before = s.used();
        assert_eq!(
            s.write_within("p", &[put("b", &"z".repeat(4096))], 1024),
            Err(Error::OverAllowance)
        );
        assert_eq!(s.used(), before, "a refused write was counted");
        assert!(
            !s.get("p").unwrap().unwrap().files.contains_key("b"),
            "a refused write was saved"
        );
        // Shrinking always goes through: an address at its limit can make room.
        assert!(s.write_within("p", &[remove("a")], 0).is_ok());
    }

    fn remove(path: &str) -> Write {
        Write {
            path: path.into(),
            content: None,
            encoding: Encoding::Utf8,
            base: None,
            edits: None,
        }
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
            s.load("stale", true).unwrap().is_none(),
            "the expired pad is still in the store"
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
        let opened = s.open_for_read(name).unwrap().expect("the pad exists");
        let remaining = opened.remaining;
        let mut rest = String::new();
        opened.into_reader().read_to_string(&mut rest).unwrap();
        assert_eq!(rest.len() as u64, remaining, "remaining was wrong");
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
        touched(&s, "p", LEASE - Duration::from_secs(60));
        s.write("p", &[put("a", "2")]).unwrap();
        assert!(
            idle(&s, "p") < Duration::from_secs(60),
            "a write did not restart the lease"
        );
    }

    // ---- the store as files and rows, from 11 October 2026 ----

    fn blob_count(s: &Store) -> usize {
        std::fs::read_dir(&s.blobs)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|d| std::fs::read_dir(d.path()).unwrap().count())
            .sum()
    }

    fn hash(s: &Store, name: &str, path: &str) -> String {
        let db = s.db.lock();
        Store::rows(&db, name).unwrap()[path].blob.clone()
    }

    fn edit(path: &str, base: &str, at: usize, remove: usize, insert: &str) -> Write {
        Write {
            path: path.into(),
            content: None,
            encoding: Encoding::Utf8,
            base: Some(base.into()),
            edits: Some(vec![Edit {
                at,
                remove,
                insert: insert.into(),
            }]),
        }
    }

    #[test]
    fn a_save_writes_only_the_files_it_names() {
        // The whole pad was read, parsed and written back on every save: a
        // keystroke in a 60 MB pad cost the relay a quarter of a gigabyte.
        let (s, _d) = store();
        s.write(
            "p",
            &[
                put("big.txt", &"x".repeat(1024 * 1024)),
                put("main.py", "print(1)"),
            ],
        )
        .unwrap();
        let big = s.blob_path(&hash(&s, "p", "big.txt"));
        let before = std::fs::metadata(&big).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        s.write("p", &[put("main.py", "print(2)")]).unwrap();
        assert_eq!(
            std::fs::metadata(&big).unwrap().modified().unwrap(),
            before,
            "the untouched file was rewritten"
        );
        let pad = s.get("p").unwrap().unwrap();
        assert_eq!(
            pad.files["big.txt"].seq, 1,
            "the untouched file's sequence moved"
        );
        assert_eq!(pad.files["main.py"].content, "print(2)");
    }

    #[test]
    fn the_same_text_is_stored_once() {
        let (s, _d) = store();
        let text = "y".repeat(100_000);
        s.write("one", &[put("a.txt", &text)]).unwrap();
        let after_one = s.used();
        s.write("two", &[put("copy.txt", &text)]).unwrap();
        assert_eq!(s.used(), after_one, "the same text was counted twice");
        assert_eq!(blob_count(&s), 1);
        // And it stays while either still holds it.
        s.remove("one").unwrap();
        s.collect(Duration::ZERO);
        assert_eq!(
            s.get("two").unwrap().unwrap().files["copy.txt"].content,
            text
        );
    }

    #[test]
    fn a_replaced_blob_is_deleted_at_once() {
        // Every save of a file makes a new blob. The old one used to wait ten
        // minutes or more, uncounted: twenty one-character saves in a 60 MB
        // file left 1.3 GB on disk.
        let (s, _d) = store_without_history();
        let mut base = s
            .write_within("p", &[put("a.txt", &"x".repeat(100_000))], u64::MAX)
            .unwrap()
            .hashes["a.txt"]
            .clone();
        for i in 0..20 {
            base = s
                .write_within("p", &[edit("a.txt", &base, i, 0, "y")], u64::MAX)
                .unwrap()
                .hashes["a.txt"]
                .clone();
            assert_eq!(blob_count(&s), 1, "after save {i}");
        }
        assert_eq!(
            s.get("p").unwrap().unwrap().files["a.txt"].content,
            format!("{}{}", "y".repeat(20), "x".repeat(100_000))
        );
        // Removing a file lets go of its blob as well.
        s.write("p", &[remove("a.txt")]).unwrap();
        assert_eq!(blob_count(&s), 0);
    }

    #[test]
    fn a_blob_being_read_stays_until_the_read_is_done() {
        // A read lists its blobs and then sends them; a write in between lets
        // go of one. It has to stay for the read, and go after it.
        let (s, _d) = store_without_history();
        s.write("p", &[put("a.txt", "first")]).unwrap();
        let old = s.blob_path(&hash(&s, "p", "a.txt"));
        let opened = s.open_for_read("p").unwrap().unwrap();
        s.write("p", &[put("a.txt", "second")]).unwrap();
        assert!(old.exists(), "a blob went while a read was sending it");
        let mut sent = String::new();
        std::io::Read::read_to_string(&mut opened.into_reader(), &mut sent).unwrap();
        assert!(sent.contains(r#""content":"first""#), "{sent}");
        // Done with: the next write, or the sweep, takes it.
        s.write("p", &[put("b.txt", "other")]).unwrap();
        assert!(!old.exists(), "a blob outlived the read that kept it");
        assert_eq!(
            s.get("p").unwrap().unwrap().files["a.txt"].content,
            "second"
        );
    }

    #[test]
    fn a_blob_two_reads_hold_stays_for_the_second() {
        let (s, _d) = store_without_history();
        s.write("p", &[put("a.txt", "first")]).unwrap();
        let old = s.blob_path(&hash(&s, "p", "a.txt"));
        let one = s.open_for_read("p").unwrap().unwrap();
        let two = s.open_for_read("p").unwrap().unwrap();
        s.write("p", &[put("a.txt", "second")]).unwrap();
        drop(one);
        s.collect(GRACE);
        assert!(old.exists(), "a blob went while a second read held it");
        drop(two);
        s.collect(GRACE);
        assert!(!old.exists());
    }

    #[test]
    fn a_refused_write_leaves_nothing_behind() {
        let (s, _d) = store();
        s.write("p", &[put("a.txt", "kept")]).unwrap();
        let big = "z".repeat(MAX_BYTES + 1);
        assert!(matches!(
            s.write("p", &[put("big.txt", &big)]),
            Err(Error::TooBig { .. })
        ));
        assert_eq!(blob_count(&s), 1, "the refused write's blob was kept");
        assert_eq!(
            std::fs::read_dir(&s.blobs)
                .unwrap()
                .flatten()
                .filter(|e| e.path().is_file())
                .count(),
            0,
            "a temporary file was left"
        );
        assert!(!s.get("p").unwrap().unwrap().files.contains_key("big.txt"));
    }

    /// The newest version, made to look `minutes` older than it is.
    fn age_versions(s: &Store, name: &str, minutes: u64) {
        s.db.lock()
            .execute(
                "UPDATE versions SET at_ms = at_ms - ?2 WHERE pad = ?1",
                params![name, (minutes * 60_000) as i64],
            )
            .unwrap();
    }

    #[test]
    fn a_pad_keeps_the_way_it_was_after_a_pause_and_can_be_read_back() {
        let (s, _d) = store();
        s.write("p", &[put("a.py", "one")]).unwrap();
        assert!(
            s.history("p").unwrap().is_empty(),
            "making a pad is not a version of it"
        );
        // The first change keeps what was there before it.
        s.write("p", &[put("a.py", "two")]).unwrap();
        let history = s.history("p").unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(
            s.version("p", history[0].id).unwrap().unwrap()["a.py"].content,
            "one"
        );
        // Typing on, within VERSION_EVERY: no more.
        s.write("p", &[put("a.py", "three"), put("b.py", "new")])
            .unwrap();
        assert_eq!(
            s.history("p").unwrap().len(),
            1,
            "not a version a keystroke"
        );
        // After a pause, the way it was left.
        age_versions(&s, "p", 11);
        s.write("p", &[delete("b.py")]).unwrap();
        let history = s.history("p").unwrap();
        assert_eq!(history.len(), 2);
        let then = s.version("p", history[0].id).unwrap().unwrap();
        assert_eq!(
            (then["a.py"].content.as_str(), then["b.py"].content.as_str()),
            ("three", "new"),
            "newest first, with the file since deleted"
        );
        assert!(s.version("p", 99).unwrap().is_none());
    }

    #[test]
    fn keeping_now_is_once_for_the_same_files_and_history_goes_with_the_pad() {
        let (s, _d) = store();
        s.write("p", &[put("a.py", "x".repeat(1000).as_str())])
            .unwrap();
        let first = s.keep_now("p").unwrap().unwrap();
        assert_eq!(
            s.keep_now("p").unwrap(),
            Some(first),
            "the same files are the same version"
        );
        let held = s.used();
        s.write("p", &[put("a.py", "y")]).unwrap();
        assert!(
            s.used() >= held,
            "the old text is still held, by the version"
        );
        assert_eq!(
            s.version("p", first).unwrap().unwrap()["a.py"]
                .content
                .len(),
            1000
        );
        s.remove("p").unwrap();
        assert!(s.history("p").unwrap().is_empty());
        assert_eq!(s.used(), 0, "a deleted pad's history is given back too");
        assert_eq!(s.keep_now("nobody").unwrap(), None);
    }

    #[test]
    fn a_lapsed_pads_history_is_nobodys_and_does_not_come_back() {
        // Audit B11: history, a version and keeping one checked the name and
        // not the lease, so a pad that read as free still showed its old
        // files until the hourly sweep. And a pad started at the name before
        // the sweep inherited them: its versions, its last run, and the
        // lapsed files themselves kept as a version of the new pad.
        let (s, _d) = store();
        s.write("p", &[put("old.py", "the old owner's")]).unwrap();
        s.write("p", &[put("old.py", "the old owner's, changed")])
            .unwrap();
        let old = s.history("p").unwrap();
        assert_eq!(old.len(), 1);
        let run = LastRun {
            path: "old.py".into(),
            command: "python old.py".into(),
            exit: 0,
            at_ms: 0,
            output: "the old owner's output".into(),
        };
        s.set_last_run("p", &run).unwrap();
        age(&s, "p");

        assert!(s.history("p").unwrap().is_empty(), "a lapsed pad's history");
        assert!(s.version("p", old[0].id).unwrap().is_none());
        assert!(s.open_version("p", old[0].id).unwrap().is_none());
        assert_eq!(
            s.keep_now("p").unwrap(),
            None,
            "kept a version of a lapsed pad"
        );
        assert_eq!(s.last_run("p").unwrap(), None);

        // Somebody new, before the sweep.
        s.write("p", &[put("new.py", "theirs")]).unwrap();
        assert!(
            s.history("p").unwrap().is_empty(),
            "the lapsed pad's versions came back under the new one"
        );
        assert!(s.version("p", old[0].id).unwrap().is_none());
        assert_eq!(s.last_run("p").unwrap(), None, "and its last run");
        s.write("p", &[put("new.py", "theirs, changed")]).unwrap();
        let history = s.history("p").unwrap();
        assert_eq!(history.len(), 1);
        let then = s.version("p", history[0].id).unwrap().unwrap();
        assert_eq!(then.keys().collect::<Vec<_>>(), vec!["new.py"]);
        let left: i64 =
            s.db.lock()
                .query_row(
                    "SELECT COUNT(*) FROM version_files WHERE path = 'old.py'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(left, 0, "the old files are still held by a version");
        let held_runs: i64 =
            s.db.lock()
                .query_row("SELECT COUNT(*) FROM last_runs", [], |r| r.get(0))
                .unwrap();
        assert_eq!(held_runs, 0);
    }

    #[test]
    fn a_version_streamed_is_the_version_kept() {
        // Sent from its blobs as a pad's read is, rather than built whole:
        // escaping, binary files and an empty file all come out as kept.
        let (s, _d) = store();
        let files = [
            put("a.txt", "one \"quoted\"\n\u{1F600}\\"),
            Write {
                encoding: Encoding::Base64,
                ..put("logo.png", "iVBORw0KGgo=")
            },
            put("dir/empty.txt", ""),
        ];
        s.write("p", &files).unwrap();
        let id = s.keep_now("p").unwrap().unwrap();
        s.write("p", &[put("a.txt", "since")]).unwrap();

        use std::io::Read;
        let opened = s.open_version("p", id).unwrap().expect("kept");
        let remaining = opened.remaining;
        let mut rest = String::new();
        opened.into_reader().read_to_string(&mut rest).unwrap();
        assert_eq!(rest.len() as u64, remaining, "remaining was wrong");
        let body: serde_json::Value = serde_json::from_str(&format!("{{{rest}")).unwrap();
        assert_eq!(body["id"], id);
        assert_eq!(
            body["files"]["a.txt"]["content"],
            "one \"quoted\"\n\u{1F600}\\"
        );
        assert_eq!(body["files"]["logo.png"]["encoding"], "base64");
        assert_eq!(body["files"]["logo.png"]["content"], "iVBORw0KGgo=");
        assert_eq!(body["files"]["dir/empty.txt"]["content"], "");
        assert_eq!(body["files"].as_object().unwrap().len(), 3);
        assert!(s.open_version("p", id + 1).unwrap().is_none());
    }

    #[test]
    fn a_pad_keeps_only_so_many_versions() {
        let (s, _d) = store();
        s.write("p", &[put("a.py", "0")]).unwrap();
        for i in 1..=(VERSIONS_KEPT + 5) {
            s.write("p", &[put("a.py", &i.to_string())]).unwrap();
            s.keep_now("p").unwrap();
        }
        let history = s.history("p").unwrap();
        assert_eq!(history.len(), VERSIONS_KEPT);
        assert_eq!(
            s.version("p", history[0].id).unwrap().unwrap()["a.py"].content,
            (VERSIONS_KEPT + 5).to_string(),
            "the newest are the ones kept"
        );
    }

    #[test]
    fn a_pad_keeps_its_last_run_until_the_next_and_lets_it_go_with_it() {
        let (s, _d) = store();
        let run = |output: &str| LastRun {
            path: "main.py".into(),
            command: "python main.py".into(),
            exit: 1,
            at_ms: 0,
            output: output.into(),
        };
        assert_eq!(
            s.set_last_run("nowhere", &run("x")).unwrap(),
            None,
            "a free name has nothing to keep it with"
        );
        s.write("p", &[put("main.py", "print(1)")]).unwrap();
        assert_eq!(s.last_run("p").unwrap(), None);
        // Its output and its two names: "main.py" and "python main.py".
        assert_eq!(
            s.set_last_run("p", &run("hello\n")).unwrap(),
            Some(6 + 7 + 14)
        );
        assert_eq!(
            s.set_last_run("p", &run("hello world\n")).unwrap(),
            Some(6),
            "charged only what it adds to the one before"
        );
        let kept = s.last_run("p").unwrap().unwrap();
        assert_eq!((kept.output.as_str(), kept.exit), ("hello world\n", 1));
        assert!(kept.at_ms > 0, "the store says when");
        assert_eq!(
            s.summary("p").unwrap().unwrap().ran,
            Some(("main.py".into(), "hello world\n".into()))
        );
        assert!(matches!(
            s.set_last_run("p", &run(&"y".repeat(LAST_RUN_MAX + 1))),
            Err(Error::TooBig { .. })
        ));
        // Gone with the pad, deleted or lapsed, and not the name's next pad's.
        s.remove("p").unwrap();
        assert_eq!(s.last_run("p").unwrap(), None);
        s.write("p", &[put("main.py", "print(2)")]).unwrap();
        assert_eq!(
            s.last_run("p").unwrap(),
            None,
            "a new pad under the name has none"
        );
        s.set_last_run("p", &run("again")).unwrap();
        age(&s, "p");
        assert_eq!(s.last_run("p").unwrap(), None, "a lapsed pad's is nobody's");
        s.sweep();
        let rows: i64 =
            s.db.lock()
                .query_row("SELECT COUNT(*) FROM last_runs", [], |r| r.get(0))
                .unwrap();
        assert_eq!(rows, 0, "and the sweep takes it with the pad");
    }

    #[test]
    fn a_last_run_counts_against_the_ceiling_as_a_file_does() {
        // Audit B09: the store counted its blobs and nothing in its database,
        // so a store at its ceiling still took 32 KiB of output for each of
        // as many empty pads as anyone made.
        let dir = tempdir::Dir::new();
        let s = Store::open(dir.path(), 40 * 1024).unwrap();
        let run = |output: &str| LastRun {
            path: "a.py".into(),
            command: "python a.py".into(),
            exit: 0,
            at_ms: 0,
            output: output.into(),
        };
        s.write("one", &[]).unwrap();
        s.write("two", &[]).unwrap();
        assert_eq!(s.used(), 0, "a pad with no files holds nothing");
        let big = run(&"x".repeat(LAST_RUN_MAX));
        s.set_last_run("one", &big).unwrap();
        assert_eq!(s.used(), big.bytes());
        assert_eq!(
            s.set_last_run("two", &big).err(),
            Some(Error::StoreFull),
            "past the ceiling, a run is refused as a file is"
        );
        assert_eq!(s.last_run("two").unwrap(), None);
        // A file is refused for the room a run takes.
        assert_eq!(
            s.write("two", &[put("a.py", &"y".repeat(10 * 1024))]).err(),
            Some(Error::StoreFull)
        );
        // A smaller run in place of the big one goes in and gives room back,
        // and so does the pad going.
        let small = run("ok\n");
        s.set_last_run("one", &small).unwrap();
        assert_eq!(s.used(), small.bytes());
        s.set_last_run("two", &small).unwrap();
        assert_eq!(s.used(), 2 * small.bytes());
        s.remove("one").unwrap();
        assert_eq!(s.used(), small.bytes());
        // A lapsed pad's, swept or written over, likewise.
        s.write("three", &[]).unwrap();
        s.set_last_run("three", &small).unwrap();
        age(&s, "three");
        s.write("three", &[]).unwrap();
        assert_eq!(s.used(), small.bytes(), "written over, its run is gone");
        age(&s, "two");
        s.sweep();
        assert_eq!(s.used(), 0, "swept, its run is gone");
        // And a store opened again counts what runs it has.
        s.set_last_run("three", &big).unwrap();
        drop(s);
        let s = Store::open(dir.path(), 40 * 1024).unwrap();
        assert_eq!(s.used(), big.bytes());
    }

    #[test]
    fn a_summary_names_the_files_and_quotes_the_one_to_open_first() {
        let (s, _d) = store();
        assert!(
            s.summary("nobody-here").unwrap().is_none(),
            "a free name has nothing to describe"
        );
        let many: Vec<Write> = (0..9)
            .map(|i| put(&format!("notes/{i}.txt"), "n"))
            .collect();
        s.write("p", &many).unwrap();
        s.write(
            "p",
            &[
                put("main.py", "\n\nprint('hello')\nx = 1\n"),
                put("big.txt", &"y".repeat((SUMMARY_LEAD_MAX + 1) as usize)),
            ],
        )
        .unwrap();
        let summary = s.summary("p").unwrap().unwrap();
        assert_eq!(summary.files, 11);
        assert_eq!(
            summary.paths.len(),
            SUMMARY_PATHS,
            "only the first few are named"
        );
        let (path, text) = summary.lead.expect("main.py is quoted");
        assert_eq!(path, "main.py");
        assert!(text.contains("print('hello')"));
        // A hidden folder is not the pad's files to show. Installed packages
        // and the page's own folder a pad can no longer be given, but may
        // hold from before.
        s.write(
            "p",
            &[
                put(".config/x.py", "y"),
                put(".cache/flask/__init__.py", "x"),
            ],
        )
        .unwrap();
        let summary = s.summary("p").unwrap().unwrap();
        assert_eq!(summary.files, 11, "hidden folders are not counted");
        assert!(summary.paths.iter().all(|p| !p.starts_with('.')));
        assert!(hidden(".ajar/site/x.py") && hidden(".deps/flask/__init__.py"));
        // With no main file, the first small text file; never one too big to read for a preview.
        s.write(
            "q",
            &[
                put("big.txt", &"y".repeat((SUMMARY_LEAD_MAX + 1) as usize)),
                put("z.txt", "zed"),
            ],
        )
        .unwrap();
        assert_eq!(
            s.summary("q").unwrap().unwrap().lead.map(|(p, _)| p),
            Some("z.txt".to_string())
        );
    }

    #[test]
    fn edits_apply_to_the_version_they_name() {
        let (s, _d) = store();
        let written = s
            .write_within("p", &[put("a.txt", "hello world")], u64::MAX)
            .unwrap();
        let base = written.hashes["a.txt"].clone();
        let next = s
            .write_within("p", &[edit("a.txt", &base, 6, 5, "there")], u64::MAX)
            .unwrap();
        assert_eq!(
            s.get("p").unwrap().unwrap().files["a.txt"].content,
            "hello there"
        );
        assert_ne!(next.hashes["a.txt"], base, "the new version has a new hash");
        // Against the version before, which the store no longer holds.
        assert_eq!(
            s.write("p", &[edit("a.txt", &base, 0, 5, "HELLO")]),
            Err(Error::Stale)
        );
        assert_eq!(
            s.get("p").unwrap().unwrap().files["a.txt"].content,
            "hello there",
            "a stale edit was applied"
        );
        // Nor to a file that is not there.
        assert_eq!(
            s.write("p", &[edit("gone.txt", &base, 0, 0, "x")]),
            Err(Error::Stale)
        );
    }

    #[test]
    fn edits_count_as_a_browser_counts() {
        // UTF-16 code units: an emoji is two. An edit inside one is refused
        // rather than splitting it.
        let (s, _d) = store();
        let base = s
            .write_within("p", &[put("a.txt", "a\u{1F600}b")], u64::MAX)
            .unwrap()
            .hashes["a.txt"]
            .clone();
        assert_eq!(
            s.write("p", &[edit("a.txt", &base, 2, 0, "x")]),
            Err(Error::BadEdit("it starts outside the text"))
        );
        s.write("p", &[edit("a.txt", &base, 3, 1, "c")]).unwrap();
        assert_eq!(
            s.get("p").unwrap().unwrap().files["a.txt"].content,
            "a\u{1F600}c"
        );
    }

    #[test]
    fn a_file_too_big_for_one_request_arrives_in_parts() {
        // What a browser does with a file over its request size: the first
        // part as content, then each next part added to the end of what the
        // last write left. Binary files too, which are base64 text.
        let (s, _d) = store();
        for (path, encoding, parts) in [
            (
                "big.txt",
                Encoding::Utf8,
                ["héllo ", "wörld ", "😀 and the rest"],
            ),
            ("big.bin", Encoding::Base64, ["AAAA", "BBBB", "CCC="]),
        ] {
            let mut sent = String::new();
            let mut base = String::new();
            for (i, part) in parts.iter().enumerate() {
                let w = if i == 0 {
                    Write {
                        encoding,
                        ..put(path, part)
                    }
                } else {
                    Write {
                        encoding,
                        ..edit(path, &base, sent.encode_utf16().count(), 0, part)
                    }
                };
                base = s.write_within("p", &[w], u64::MAX).unwrap().hashes[path].clone();
                sent.push_str(part);
            }
            let file = &s.get("p").unwrap().unwrap().files[path];
            assert_eq!(
                (file.content.as_str(), file.encoding),
                (sent.as_str(), encoding)
            );
            assert_eq!(base, hash_of(encoding, &sent));
        }
        // An edit naming the other encoding is against another file.
        let base = hash(&s, "p", "big.bin");
        assert_eq!(
            s.write("p", &[edit("big.bin", &base, 0, 0, "x")]),
            Err(Error::Stale)
        );
    }

    #[test]
    fn a_file_is_edited_in_a_request_of_its_own() {
        let (s, _d) = store_without_history();
        let base = s
            .write_within("p", &[put("a.txt", "abc")], u64::MAX)
            .unwrap()
            .hashes["a.txt"]
            .clone();
        assert!(matches!(
            s.write("p", &[put("a.txt", "new"), edit("a.txt", &base, 0, 0, "x")]),
            Err(Error::BadEdit(_))
        ));
        assert!(matches!(
            s.write(
                "p",
                &[
                    edit("a.txt", &base, 0, 0, "x"),
                    edit("a.txt", &base, 1, 0, "y")
                ]
            ),
            Err(Error::BadEdit(_))
        ));
        // Replacing after an edit is a write like any other: the last wins.
        s.write(
            "p",
            &[edit("a.txt", &base, 0, 0, "x"), put("a.txt", "whole")],
        )
        .unwrap();
        assert_eq!(s.get("p").unwrap().unwrap().files["a.txt"].content, "whole");
        assert_eq!(blob_count(&s), 1);
    }

    #[test]
    fn edits_that_do_not_apply_leave_nothing_behind() {
        let (s, _d) = store();
        let base = s
            .write_within("p", &[put("a.txt", "abc")], u64::MAX)
            .unwrap()
            .hashes["a.txt"]
            .clone();
        assert_eq!(
            s.write("p", &[edit("a.txt", &base, 9, 0, "x")]),
            Err(Error::BadEdit("it starts outside the text"))
        );
        assert_eq!(blob_count(&s), 1);
        assert_eq!(
            std::fs::read_dir(&s.blobs)
                .unwrap()
                .flatten()
                .filter(|e| e.path().is_file())
                .count(),
            0,
            "a temporary file was left"
        );
        assert!(
            s.in_use.lock().is_empty(),
            "the edited blob is still marked in use"
        );
    }

    #[test]
    fn a_pad_stored_the_old_way_is_brought_in() {
        let dir = tempdir::Dir::new();
        let mut files = BTreeMap::new();
        files.insert(
            "main.py".to_string(),
            File {
                content: "print('é')\n".into(),
                encoding: Encoding::Utf8,
                seq: 3,
            },
        );
        files.insert(
            "logo.png".to_string(),
            File {
                content: "iVBORw0KGgo=".into(),
                encoding: Encoding::Base64,
                seq: 2,
            },
        );
        let old = Pad {
            seq: 3,
            created_ms: 1_000,
            updated_ms: 2_000,
            files,
        };
        let path = dir.path().join("old-pad.json");
        std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        let ago = Duration::from_secs(5 * 86_400);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - ago)
            .unwrap();

        let s = Store::open(dir.path(), MAX_STORE_BYTES).unwrap();
        let pad = s.get("old-pad").unwrap().expect("imported");
        assert_eq!((pad.seq, pad.created_ms, pad.updated_ms), (3, 1_000, 2_000));
        assert_eq!(pad.files["main.py"].content, "print('é')\n");
        assert_eq!(pad.files["main.py"].seq, 3);
        assert_eq!(pad.files["logo.png"].encoding, Encoding::Base64);
        assert!(
            idle(&s, "old-pad") > ago - Duration::from_secs(60),
            "the lease was not carried over"
        );
        assert!(!path.exists(), "the old file was left in place");
        assert!(
            dir.path().join("legacy/old-pad.json").exists(),
            "the old file was not kept"
        );
        // And a second start does not bring it in twice.
        drop(s);
        let again = Store::open(dir.path(), MAX_STORE_BYTES).unwrap();
        assert_eq!(again.get("old-pad").unwrap().unwrap().seq, 3);
    }

    #[test]
    fn an_export_reads_back_as_the_same_pads() {
        // The way back: what the store held, as the relay before it reads it.
        let (s, _d) = store();
        s.write(
            "p",
            &[put("a.txt", "one"), put("dir/b.txt", "two \"quoted\"\n")],
        )
        .unwrap();
        let out = tempdir::Dir::new();
        assert_eq!(s.export_legacy(out.path()).unwrap(), 1);
        let back: Pad =
            serde_json::from_slice(&std::fs::read(out.path().join("p.json")).unwrap()).unwrap();
        let here = s.get("p").unwrap().unwrap();
        assert_eq!(back.seq, here.seq);
        assert_eq!(
            back.files["dir/b.txt"].content,
            here.files["dir/b.txt"].content
        );
        assert_eq!(back.files.len(), 2);
        // And a store opened on that directory brings it in again.
        let reopened = Store::open(out.path(), MAX_STORE_BYTES).unwrap();
        assert_eq!(
            reopened.get("p").unwrap().unwrap().files["a.txt"].content,
            "one"
        );
    }

    #[test]
    fn a_streamed_pad_says_each_files_hash() {
        let (s, _d) = store();
        let written = s
            .write_within("p", &[put("a.txt", "one")], u64::MAX)
            .unwrap();
        let body = streamed(&s, "p");
        assert_eq!(
            body["files"]["a.txt"]["hash"],
            written.hashes["a.txt"].as_str()
        );
    }
}

//! What a guest's page asks the agent to do to the folder beyond reading it:
//! make a file or a folder, rename or move one, remove one, write a file
//! uploaded, search every file's text and replace what was found, and read a
//! file's bytes to look at.
//!
//! A guest's shell could always do all of it, inside the sandbox the agent
//! puts it in. These are the agent itself doing it, outside any sandbox, on a
//! guest's word — the second way to change the host's disk that the review
//! of 7 October left out on purpose. So every one goes through two gates:
//!
//! - **Nowhere but the folder.** The folder is opened once, as a `cap_std`
//!   directory, and every path is resolved beneath it a component at a time.
//!   A `..`, an absolute path, or a symlink that leads out — there when the
//!   path was checked, or swapped in a moment after by a guest with a shell —
//!   is an error, not a way out. Checking a path and then using it with the
//!   standard library would leave that moment open.
//! - **Nothing the tree hides.** A path is refused when the ignore rules
//!   hide it — `.git`, dependencies, a gitignored `.env` — as written, and
//!   when it goes through a link at all, since where a link leads is not what
//!   it says.
//!
//! Whether the guest may — the session is not read-only — is the caller's to
//! say (`main.rs`), since it is not a question about the folder.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use ajar_proto::{
    Entry, EntryKind, FoundFile, FoundMatch, ReplaceFile, FIND_LIMIT, MAX_FILE_BYTES,
    VIEW_MAX_BYTES,
};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use sha2::{Digest, Sha256};

use crate::workspace::Filter;

/// As long as a path may be, and each name in it: what every filesystem
/// here takes, and no reason for more.
const PATH_MAX: usize = 1024;
const NAME_MAX: usize = 255;

/// What a search looks for, as the page's own search has it.
#[derive(Debug, Clone)]
pub struct FindOptions {
    pub query: String,
    /// Only under this folder; `""` is everywhere.
    pub folder: String,
    pub match_case: bool,
    pub whole_word: bool,
}

/// The folder, opened as the only place anything here can reach.
fn folder(filter: &Filter) -> Result<Dir, String> {
    Dir::open_ambient_dir(filter.root(), ambient_authority())
        .map_err(|e| format!("the shared folder could not be opened: {e}"))
}

/// The part of `rel` before its last name, if it has one.
fn parent_of(rel: &str) -> Option<&str> {
    rel.rsplit_once('/').map(|(parent, _)| parent)
}

fn io(what: &str, e: std::io::Error) -> String {
    // The operating system's own word for it, without its number.
    let text = e.to_string();
    let plain = text.split(" (os error").next().unwrap_or(&text);
    format!("{what}: {}", plain.to_lowercase())
}

/// A path from a guest, held to what the tree shows.
///
/// Its shape first: relative, no empty part, no `.` or `..`, no control
/// character or backslash, not absurdly long. Then the ignore rules, as
/// written. Then every folder on the way to it: there and a folder, or not
/// there yet — never a file, and never a link, whose name says nothing of
/// where it leads.
fn checked(filter: &Filter, dir: &Dir, rel: &str, is_dir: bool) -> Result<(), String> {
    if rel.is_empty() {
        return Err("a name is needed".into());
    }
    if rel.len() > PATH_MAX {
        return Err("that path is too long".into());
    }
    if rel.starts_with('/') {
        return Err(format!("{rel} is not inside the shared folder"));
    }
    for part in rel.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.len() > NAME_MAX
            || part.trim() != part
            || part.chars().any(|c| c.is_control() || c == '\\')
        {
            return Err(format!("{rel} is not a path this folder can hold"));
        }
    }
    if filter.is_ignored(&filter.root().join(rel), is_dir) {
        return Err(format!(
            "{rel} is hidden by the folder's ignore rules, and what the file list hides is not changed from it"
        ));
    }
    let mut at = 0;
    while let Some(slash) = rel[at..].find('/') {
        let prefix = &rel[..at + slash];
        at += slash + 1;
        match dir.symlink_metadata(prefix) {
            Ok(meta) if meta.is_symlink() => {
                return Err(format!(
                    "{prefix} is a link, and nothing is changed through one"
                ))
            }
            Ok(meta) if !meta.is_dir() => return Err(format!("{prefix} is a file, not a folder")),
            Ok(_) => {}
            // Not there yet: nor is anything under it.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(io(prefix, e)),
        }
    }
    Ok(())
}

/// A new file, empty, or a new folder — with the folders on the way to it,
/// as `mkdir -p` would make them.
pub fn make(filter: &Filter, rel: &str, is_dir: bool) -> Result<(), String> {
    let dir = folder(filter)?;
    checked(filter, &dir, rel, is_dir)?;
    if dir.symlink_metadata(rel).is_ok() {
        return Err(format!("there is already something called {rel}"));
    }
    if let Some(parent) = parent_of(rel) {
        dir.create_dir_all(parent).map_err(|e| io(parent, e))?;
    }
    if is_dir {
        dir.create_dir(rel).map_err(|e| io(rel, e))
    } else {
        // `create_new`: never an existing file emptied, and never through a
        // link put where the file was to be.
        dir.open_with(rel, OpenOptions::new().write(true).create_new(true))
            .map(drop)
            .map_err(|e| io(rel, e))
    }
}

/// A file or a folder to a new path. Onto a file that is there only with
/// `replace`; never onto a folder, and a folder never onto anything.
pub fn rename(filter: &Filter, from: &str, to: &str, replace: bool) -> Result<(), String> {
    let dir = folder(filter)?;
    let meta = dir
        .symlink_metadata(from)
        .map_err(|_| format!("{from} is not there any more"))?;
    let moving_dir = meta.is_dir();
    checked(filter, &dir, from, moving_dir)?;
    checked(filter, &dir, to, moving_dir)?;
    if from == to {
        return Ok(());
    }
    if moving_dir && to.starts_with(&format!("{from}/")) {
        return Err("a folder cannot go inside itself".into());
    }
    if let Ok(there) = dir.symlink_metadata(to) {
        let what = if there.is_dir() { "folder" } else { "file" };
        if !replace || there.is_dir() || moving_dir {
            return Err(format!("there is already a {what} called {to}"));
        }
    }
    if let Some(parent) = parent_of(to) {
        dir.create_dir_all(parent).map_err(|e| io(parent, e))?;
    }
    dir.rename(from, &dir, to).map_err(|e| io(from, e))
}

/// A file, or a folder and everything in it. There is no bin.
pub fn remove(filter: &Filter, rel: &str) -> Result<bool, String> {
    let dir = folder(filter)?;
    let meta = dir
        .symlink_metadata(rel)
        .map_err(|_| format!("{rel} is not there any more"))?;
    let was_dir = meta.is_dir();
    checked(filter, &dir, rel, was_dir)?;
    if was_dir {
        dir.remove_dir_all(rel).map_err(|e| io(rel, e))?;
    } else {
        // A link is removed as itself; what it pointed at is left alone.
        dir.remove_file(rel).map_err(|e| io(rel, e))?;
    }
    Ok(was_dir)
}

/// Whether an upload to `rel` would be taken, before any of its bytes are.
pub fn may_put(filter: &Filter, rel: &str, replace: bool) -> Result<(), String> {
    let dir = folder(filter)?;
    checked(filter, &dir, rel, false)?;
    match dir.symlink_metadata(rel) {
        Ok(meta) if meta.is_dir() => Err(format!("{rel} is a folder")),
        Ok(meta) if meta.is_symlink() => Err(format!(
            "{rel} is a link, and nothing is written through one"
        )),
        Ok(_) if !replace => Err(format!("there is already a file called {rel}")),
        _ => Ok(()),
    }
}

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// `bytes` as the whole of `rel`: written beside it under a name of its own
/// and renamed over it, so nobody reads half of it, and a link put where it
/// was is replaced rather than followed. An existing file keeps its mode.
fn write_whole(dir: &Dir, rel: &str, bytes: &[u8]) -> Result<(), String> {
    let permissions = dir.metadata(rel).ok().map(|m| m.permissions());
    let parent = parent_of(rel);
    for _ in 0..100 {
        let n = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let name = format!(".ajar-write-{}-u{n}", std::process::id());
        let temp = match parent {
            Some(parent) => format!("{parent}/{name}"),
            None => name,
        };
        let mut file = match dir.open_with(&temp, OpenOptions::new().write(true).create_new(true)) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io(rel, e)),
        };
        let mut written = file.write_all(bytes).and_then(|()| file.sync_all());
        if let (Ok(()), Some(permissions)) = (&written, &permissions) {
            written = file.set_permissions(permissions.clone());
        }
        drop(file);
        let done = written.and_then(|()| dir.rename(&temp, dir, rel));
        if done.is_err() {
            let _ = dir.remove_file(&temp);
        }
        return done.map_err(|e| io(rel, e));
    }
    Err(format!("{rel}: no temporary name was free beside it"))
}

/// An uploaded file, written whole.
pub fn put(filter: &Filter, rel: &str, bytes: &[u8], replace: bool) -> Result<(), String> {
    may_put(filter, rel, replace)?;
    let dir = folder(filter)?;
    if let Some(parent) = parent_of(rel) {
        dir.create_dir_all(parent).map_err(|e| io(parent, e))?;
    }
    write_whole(&dir, rel, bytes)
}

/// A file's bytes, to look at: one the tree shows, up to [`VIEW_MAX_BYTES`].
pub fn view(filter: &Filter, rel: &str) -> Result<Vec<u8>, String> {
    let dir = folder(filter)?;
    checked(filter, &dir, rel, false)?;
    let meta = dir
        .symlink_metadata(rel)
        .map_err(|_| format!("{rel} is not there"))?;
    if meta.is_symlink() {
        return Err(format!("{rel} is a link"));
    }
    if !meta.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    if meta.len() > VIEW_MAX_BYTES {
        return Err(format!(
            "it is {} MB, and up to {} MB is shown here — download it instead",
            meta.len().div_ceil(1024 * 1024),
            VIEW_MAX_BYTES / (1024 * 1024)
        ));
    }
    // Read to the limit and no further, whatever it has grown to since.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    dir.open(rel)
        .map_err(|e| io(rel, e))?
        .take(VIEW_MAX_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| io(rel, e))?;
    Ok(bytes)
}

// ------------------------------------------------------------------ search

/// A match, as bytes of the text it is in.
struct Hit {
    start: usize,
    end: usize,
}

/// What a word is made of: letters, marks, digits and the underscore — the
/// page's own rule (`[\p{L}\p{M}\p{N}_]`), so a search here and one there
/// find the same.
fn word_char(c: char) -> bool {
    c == '_' || c.is_alphanumeric() || is_mark(c)
}

/// Combining marks, which follow a letter and are part of it: `é` written as
/// `e` and an accent. The ranges of the scripts people write code and prose
/// in; the standard library has no test for the category.
fn is_mark(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x0483..=0x0489 | 0x0591..=0x05BD | 0x05BF | 0x05C1..=0x05C2
        | 0x05C4..=0x05C5 | 0x05C7 | 0x0610..=0x061A | 0x064B..=0x065F | 0x0670
        | 0x06D6..=0x06DC | 0x06DF..=0x06E4 | 0x06E7..=0x06E8 | 0x06EA..=0x06ED
        | 0x0900..=0x0903 | 0x093A..=0x094F | 0x0951..=0x0957 | 0x0962..=0x0963
        | 0x0981..=0x0983 | 0x09BC..=0x09CD | 0x0A01..=0x0A03 | 0x0A3C..=0x0A4D
        | 0x0A81..=0x0A83 | 0x0ABC..=0x0ACD | 0x0B01..=0x0B03 | 0x0B3C..=0x0B4D
        | 0x0B82 | 0x0BBE..=0x0BCD | 0x0C00..=0x0C04 | 0x0C3E..=0x0C56
        | 0x0C81..=0x0C83 | 0x0CBC..=0x0CCD | 0x0D00..=0x0D03 | 0x0D3B..=0x0D4D
        | 0x0E31 | 0x0E34..=0x0E3A | 0x0E47..=0x0E4E | 0x1AB0..=0x1AFF
        | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0x302A..=0x302F | 0x3099..=0x309A
        | 0xFE00..=0xFE0F | 0xFE20..=0xFE2F | 0x1D165..=0x1D169 | 0x1D16D..=0x1D172)
}

/// Every place `text` has the query, in order: literal text, never a pattern
/// of the guest's own, and never across a line.
fn hits(text: &str, o: &FindOptions, limit: usize) -> Vec<Hit> {
    if o.query.is_empty() || o.query.contains(['\r', '\n']) {
        return Vec::new();
    }
    let Ok(pattern) = regex::RegexBuilder::new(&regex::escape(&o.query))
        .case_insensitive(!o.match_case)
        .build()
    else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for m in pattern.find_iter(text) {
        if o.whole_word {
            let before = text[..m.start()].chars().next_back();
            let after = text[m.end()..].chars().next();
            if before.is_some_and(word_char) || after.is_some_and(word_char) {
                continue;
            }
        }
        found.push(Hit {
            start: m.start(),
            end: m.end(),
        });
        if found.len() >= limit {
            break;
        }
    }
    found
}

/// The first `units` UTF-16 units of `text`, never half of a character.
fn first_units(text: &str, units: usize) -> &str {
    let mut taken = 0;
    for (at, c) in text.char_indices() {
        if taken + c.len_utf16() > units {
            return &text[..at];
        }
        taken += c.len_utf16();
    }
    text
}

/// The last `units` UTF-16 units of `text`.
fn last_units(text: &str, units: usize) -> &str {
    let mut taken = 0;
    for (at, c) in text.char_indices().rev() {
        if taken + c.len_utf16() > units {
            return &text[at + c.len_utf8()..];
        }
        taken += c.len_utf16();
    }
    text
}

/// The matches as the page shows and opens them: where each is in UTF-16
/// units, its line and column, and what is on its line either side.
fn describe(text: &str, found: &[Hit]) -> Vec<FoundMatch> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(found.len());
    // Carried forward from one match to the next: the file is walked once.
    let (mut at, mut units, mut line, mut line_start, mut line_units) =
        (0usize, 0u64, 1u32, 0usize, 0u64);
    for hit in found {
        for (offset, c) in text[at..hit.start].char_indices() {
            let here = at + offset;
            units += c.len_utf16() as u64;
            // A line ends at `\n`, or at a `\r` with no `\n` after it.
            if c == '\n' || (c == '\r' && bytes.get(here + 1) != Some(&b'\n')) {
                line += 1;
                line_start = here + 1;
                line_units = units;
            }
        }
        at = hit.start;
        let matched = &text[hit.start..hit.end];
        let matched_units: u64 = matched.chars().map(|c| c.len_utf16() as u64).sum();
        let line_end = text[hit.end..]
            .find(['\r', '\n'])
            .map_or(text.len(), |n| hit.end + n);
        out.push(FoundMatch {
            start: units,
            end: units + matched_units,
            line,
            column: (units - line_units) as u32 + 1,
            before: last_units(&text[line_start..hit.start], 80).to_string(),
            hit: first_units(matched, 160).to_string(),
            after: first_units(&text[hit.end..line_end], 80).to_string(),
        });
    }
    out
}

/// A file's text, when it is text a search can read: not binary, not over
/// the size the page would be shown, and UTF-8.
fn text_of(dir: &Dir, rel: &str) -> Option<String> {
    let meta = dir.symlink_metadata(rel).ok()?;
    if !meta.is_file() || meta.len() as usize > MAX_FILE_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    dir.open(rel)
        .ok()?
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_FILE_BYTES || bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Every match in the files the tree shows, or those under a folder of it,
/// up to [`FIND_LIMIT`]; and whether there were more. `entries` is the tree's
/// own list, so nothing hidden from it is searched.
pub fn find(filter: &Filter, entries: &[Entry], o: &FindOptions) -> (Vec<FoundFile>, bool) {
    let Ok(dir) = folder(filter) else {
        return (Vec::new(), false);
    };
    let inside = format!("{}/", o.folder);
    let mut groups = Vec::new();
    let mut count = 0;
    for entry in entries {
        if entry.kind != EntryKind::File || entry.size as usize > MAX_FILE_BYTES {
            continue;
        }
        if !o.folder.is_empty() && !entry.path.starts_with(&inside) {
            continue;
        }
        if checked(filter, &dir, &entry.path, false).is_err() {
            continue;
        }
        let Some(text) = text_of(&dir, &entry.path) else {
            continue;
        };
        // One past the limit, to know there were more.
        let found = hits(&text, o, FIND_LIMIT + 1 - count);
        if found.is_empty() {
            continue;
        }
        let over = count + found.len() > FIND_LIMIT;
        let keep = found.len().min(FIND_LIMIT - count);
        count += keep;
        if keep > 0 {
            groups.push(FoundFile {
                path: entry.path.clone(),
                matches: describe(&text, &found[..keep]),
            });
        }
        if over {
            return (groups, true);
        }
    }
    (groups, false)
}

/// What a replace did: files changed, replacements made, and each file left
/// alone with why.
pub struct Replaced {
    pub files: usize,
    pub replacements: usize,
    pub skipped: Vec<String>,
}

/// Replace what the search finds, in the files named — each only if it is
/// still the text the guest was shown: its SHA-256 is the one they sent.
/// Written whole, as an editor's save is; a file open in the editor takes it
/// as it takes any change on disk.
pub fn replace(
    filter: &Filter,
    o: &FindOptions,
    replacement: &str,
    files: &[ReplaceFile],
) -> Replaced {
    let mut done = Replaced {
        files: 0,
        replacements: 0,
        skipped: Vec::new(),
    };
    let dir = match folder(filter) {
        Ok(dir) => dir,
        Err(why) => {
            done.skipped.push(why);
            return done;
        }
    };
    for file in files {
        let rel = file.path.as_str();
        if let Err(why) = checked(filter, &dir, rel, false) {
            done.skipped.push(why);
            continue;
        }
        if dir.symlink_metadata(rel).is_ok_and(|m| m.is_symlink()) {
            done.skipped.push(format!("{rel} (a link)"));
            continue;
        }
        let Some(text) = text_of(&dir, rel) else {
            done.skipped
                .push(format!("{rel} (no longer text that can be changed here)"));
            continue;
        };
        let sum: String = Sha256::digest(text.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if !sum.eq_ignore_ascii_case(&file.sum) {
            done.skipped
                .push(format!("{rel} (changed since the preview)"));
            continue;
        }
        let found = hits(&text, o, usize::MAX);
        if found.is_empty() {
            continue;
        }
        let mut next = String::with_capacity(text.len());
        let mut at = 0;
        for hit in &found {
            next.push_str(&text[at..hit.start]);
            next.push_str(replacement);
            at = hit.end;
        }
        next.push_str(&text[at..]);
        match write_whole(&dir, rel, next.as_bytes()) {
            Ok(()) => {
                done.files += 1;
                done.replacements += found.len();
            }
            Err(why) => done.skipped.push(why),
        }
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ajar-fileops-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn filter(root: &std::path::Path) -> Filter {
        Filter::build(root).unwrap()
    }

    fn options(query: &str) -> FindOptions {
        FindOptions {
            query: query.into(),
            folder: String::new(),
            match_case: false,
            whole_word: false,
        }
    }

    fn file(path: &str, size: u64) -> Entry {
        Entry {
            path: path.into(),
            kind: EntryKind::File,
            size,
        }
    }

    #[test]
    fn makes_a_file_and_the_folders_on_the_way() {
        let root = scratch("make");
        let f = filter(&root);
        make(&f, "src/deep/new.py", false).unwrap();
        assert_eq!(fs::read(root.join("src/deep/new.py")).unwrap(), b"");
        make(&f, "docs", true).unwrap();
        assert!(root.join("docs").is_dir());
        // Never over what is there: not a file emptied, not a folder made twice.
        fs::write(root.join("kept.txt"), "mine").unwrap();
        assert!(make(&f, "kept.txt", false).is_err());
        assert_eq!(fs::read_to_string(root.join("kept.txt")).unwrap(), "mine");
        assert!(make(&f, "docs", true).is_err());
        // And not under a file.
        assert!(make(&f, "kept.txt/inside", false)
            .unwrap_err()
            .contains("a file, not a folder"));
    }

    #[test]
    fn refuses_every_path_that_is_not_one_in_the_folder() {
        let root = scratch("paths");
        fs::write(root.join("x"), "here").unwrap();
        let f = filter(&root);
        for bad in [
            "",
            "/etc/passwd",
            "../outside",
            "a/../../outside",
            "a//b",
            "./a",
            "a/.",
            "a/..",
            " lead",
            "trail ",
            "back\\slash",
            "new\nline",
            "nul\0byte",
        ] {
            assert!(make(&f, bad, false).is_err(), "{bad:?} should be refused");
            assert!(
                put(&f, bad, b"x", true).is_err(),
                "{bad:?} should not be written"
            );
            assert!(remove(&f, bad).is_err(), "{bad:?} should not be removed");
            assert!(
                rename(&f, "x", bad, true).is_err(),
                "{bad:?} should not be moved to"
            );
        }
        assert!(make(&f, &"n".repeat(NAME_MAX + 1), false).is_err());
        assert!(make(&f, &format!("{}/x", "d/".repeat(600)), false).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1, "nothing was made");
        assert_eq!(fs::read_to_string(root.join("x")).unwrap(), "here");
    }

    #[test]
    fn refuses_what_the_tree_hides() {
        let root = scratch("hidden");
        fs::write(root.join(".gitignore"), "secret.env\nprivate/\n").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "[core]\n").unwrap();
        fs::write(root.join("secret.env"), "KEY=1\n").unwrap();
        fs::write(root.join("shown.txt"), "hello\n").unwrap();
        let f = filter(&root);
        for hidden in [
            ".git/config",
            ".git/hooks/pre-commit",
            "secret.env",
            "private/new.txt",
            "node_modules/x/index.js",
        ] {
            assert!(
                make(&f, hidden, false).unwrap_err().contains("hidden"),
                "{hidden}"
            );
            assert!(put(&f, hidden, b"x", true).is_err(), "{hidden}");
            assert!(view(&f, hidden).is_err(), "{hidden}");
            assert!(
                rename(&f, "shown.txt", hidden, true).is_err(),
                "to {hidden}"
            );
        }
        // Nor by another name: a link to what is hidden, inside the folder,
        // is still inside it — so it is the link that is refused.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join(".git"), root.join("shortcut")).unwrap();
            assert!(put(&f, "shortcut/config", b"[evil]\n", true)
                .unwrap_err()
                .contains("a link"));
            assert!(view(&f, "shortcut/config").is_err());
            assert!(remove(&f, "shortcut/config").is_err());
            assert!(make(&f, "shortcut/hooks/pre-commit", false).is_err());
            assert!(rename(&f, "shown.txt", "shortcut/config", true).is_err());
        }
        assert!(remove(&f, ".git").is_err());
        assert!(remove(&f, "secret.env").is_err());
        assert!(rename(&f, "secret.env", "taken.txt", false).is_err());
        assert_eq!(
            fs::read_to_string(root.join("secret.env")).unwrap(),
            "KEY=1\n"
        );
        assert_eq!(
            fs::read_to_string(root.join(".git/config")).unwrap(),
            "[core]\n"
        );
        assert!(root.join("shown.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_folder_leads_nowhere() {
        let root = scratch("links");
        let outside = scratch("links-outside");
        fs::write(outside.join("theirs.txt"), "the host's own\n").unwrap();
        fs::create_dir_all(outside.join("dir")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();
        std::os::unix::fs::symlink(outside.join("theirs.txt"), root.join("link.txt")).unwrap();
        fs::write(root.join("mine.txt"), "a guest's\n").unwrap();
        let f = filter(&root);

        assert!(make(&f, "out/planted.txt", false).is_err());
        assert!(make(&f, "out/dir/planted", true).is_err());
        assert!(put(&f, "out/theirs.txt", b"overwritten", true).is_err());
        assert!(put(&f, "link.txt", b"overwritten", true).is_err());
        assert!(rename(&f, "mine.txt", "out/taken.txt", true).is_err());
        assert!(rename(&f, "out/theirs.txt", "stolen.txt", true).is_err());
        assert!(remove(&f, "out/theirs.txt").is_err());
        assert!(remove(&f, "out/dir").is_err());
        assert!(view(&f, "out/theirs.txt").is_err());
        assert!(view(&f, "link.txt").is_err());
        assert_eq!(
            fs::read_to_string(outside.join("theirs.txt")).unwrap(),
            "the host's own\n"
        );
        assert!(outside.join("dir").is_dir());
        assert_eq!(
            fs::read_dir(&outside).unwrap().count(),
            2,
            "nothing was put outside"
        );
        assert!(root.join("mine.txt").exists());

        // The link itself is the folder's, and goes as itself: what it
        // points at stays.
        remove(&f, "link.txt").unwrap();
        assert!(!root.join("link.txt").exists());
        remove(&f, "out").unwrap();
        assert!(fs::symlink_metadata(root.join("out")).is_err());
        assert!(outside.join("theirs.txt").exists());

        // Under the checks, the folder itself holds: with the standard
        // library a path checked and then used can be swapped between the
        // two. Opened beneath the folder, a link out is an error whenever it
        // is met — here, with no check before it at all.
        std::os::unix::fs::symlink(&outside, root.join("swapped")).unwrap();
        let dir = folder(&f).unwrap();
        assert!(dir
            .open_with(
                "swapped/planted.txt",
                OpenOptions::new().write(true).create_new(true)
            )
            .is_err());
        assert!(dir.remove_file("swapped/theirs.txt").is_err());
        assert!(dir.rename("mine.txt", &dir, "swapped/taken.txt").is_err());
        assert!(write_whole(&dir, "swapped/theirs.txt", b"overwritten").is_err());
        assert_eq!(
            fs::read_to_string(outside.join("theirs.txt")).unwrap(),
            "the host's own\n"
        );
    }

    #[test]
    fn renames_moves_and_will_not_write_over_without_being_told() {
        let root = scratch("rename");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::write(root.join("b.txt"), "b").unwrap();
        fs::write(root.join("src/c.txt"), "c").unwrap();
        let f = filter(&root);

        rename(&f, "a.txt", "renamed.txt", false).unwrap();
        assert_eq!(fs::read_to_string(root.join("renamed.txt")).unwrap(), "a");
        rename(&f, "renamed.txt", "new/place/a.txt", false).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("new/place/a.txt")).unwrap(),
            "a"
        );

        assert!(rename(&f, "b.txt", "src/c.txt", false)
            .unwrap_err()
            .contains("already a file"));
        assert_eq!(fs::read_to_string(root.join("src/c.txt")).unwrap(), "c");
        rename(&f, "b.txt", "src/c.txt", true).unwrap();
        assert_eq!(fs::read_to_string(root.join("src/c.txt")).unwrap(), "b");

        // A folder moves with what is in it, never into itself, and never
        // over anything, told to or not.
        assert!(rename(&f, "src", "src/inner", false)
            .unwrap_err()
            .contains("inside itself"));
        assert!(rename(&f, "src", "new", true)
            .unwrap_err()
            .contains("already a folder"));
        assert!(rename(&f, "src/c.txt", "new", true).is_err());
        rename(&f, "src", "lib", false).unwrap();
        assert_eq!(fs::read_to_string(root.join("lib/c.txt")).unwrap(), "b");
        assert!(rename(&f, "gone.txt", "x.txt", false)
            .unwrap_err()
            .contains("not there"));
    }

    #[test]
    fn removes_a_file_or_a_folder_whole() {
        let root = scratch("remove");
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::write(root.join("src/deep/x.txt"), "x").unwrap();
        fs::write(root.join("keep.txt"), "k").unwrap();
        let f = filter(&root);
        assert!(!remove(&f, "src/deep/x.txt").unwrap());
        assert!(remove(&f, "src").unwrap(), "said to have been a folder");
        assert!(!root.join("src").exists());
        assert!(root.join("keep.txt").exists());
        assert!(remove(&f, "src").is_err());
    }

    #[test]
    fn an_upload_is_written_whole_and_keeps_a_files_mode() {
        let root = scratch("put");
        let f = filter(&root);
        put(
            &f,
            "assets/logo.png",
            &[0x89, b'P', b'N', b'G', 0, 1, 2],
            false,
        )
        .unwrap();
        assert_eq!(
            fs::read(root.join("assets/logo.png")).unwrap(),
            [0x89, b'P', b'N', b'G', 0, 1, 2]
        );
        assert!(put(&f, "assets/logo.png", b"again", false)
            .unwrap_err()
            .contains("already a file"));
        put(&f, "assets/logo.png", b"again", true).unwrap();
        assert_eq!(fs::read(root.join("assets/logo.png")).unwrap(), b"again");
        assert!(put(&f, "assets", b"x", true)
            .unwrap_err()
            .contains("is a folder"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(root.join("run.sh"), "#!/bin/sh\n").unwrap();
            fs::set_permissions(root.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
            put(&f, "run.sh", b"#!/bin/sh\necho hi\n", true).unwrap();
            assert_eq!(
                fs::metadata(root.join("run.sh"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
        // Nothing of the writing left beside it.
        let left: Vec<_> = fs::read_dir(root.join("assets"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left.len(), 1, "{left:?}");
    }

    #[test]
    fn views_a_file_up_to_the_limit() {
        let root = scratch("view");
        fs::write(root.join("dot.png"), [1u8, 2, 3]).unwrap();
        fs::create_dir_all(root.join("dir")).unwrap();
        let big = fs::File::create(root.join("big.bin")).unwrap();
        big.set_len(VIEW_MAX_BYTES + 1).unwrap();
        let f = filter(&root);
        assert_eq!(view(&f, "dot.png").unwrap(), [1, 2, 3]);
        assert!(view(&f, "big.bin")
            .unwrap_err()
            .contains("download it instead"));
        assert!(view(&f, "dir").is_err());
        assert!(view(&f, "absent.png").is_err());
    }

    #[test]
    fn finds_as_the_pages_own_search_does() {
        // The cases the page's search is held to (pad/scripts/search-check.mjs),
        // so the same query finds the same here and there.
        let found = |text: &str, o: &FindOptions| -> Vec<u64> {
            describe(text, &hits(text, o, usize::MAX))
                .iter()
                .map(|m| m.start)
                .collect()
        };
        let word = FindOptions {
            whole_word: true,
            ..options("cat")
        };
        assert_eq!(found("cat CAT concatenate cat", &word), [0, 4, 20]);
        assert_eq!(
            found(
                "CAT cat",
                &FindOptions {
                    match_case: true,
                    ..options("cat")
                }
            ),
            [4]
        );
        assert_eq!(found("猫cat cat猫 cat", &word).len(), 1);
        for (text, query) in [
            ("की", "क"),
            ("cafe\u{301}", "cafe"),
            ("\u{301}cafe", "cafe"),
            ("x\u{20dd}", "x"),
            ("x\u{1d165}", "x"),
        ] {
            assert_eq!(
                found(
                    text,
                    &FindOptions {
                        whole_word: true,
                        ..options(query)
                    }
                )
                .len(),
                0,
                "{text}"
            );
            assert_eq!(found(text, &options(query)).len(), 1, "{text}");
        }
        assert_eq!(
            found("[a].*", &options("[a].*")).len(),
            1,
            "literal text, never a pattern"
        );
        assert_eq!(found("aaaa", &options("aa")).len(), 2);
        assert_eq!(found("abc", &options("")).len(), 0);
        assert_eq!(
            found("a\nb", &options("a\nb")).len(),
            0,
            "never across a line"
        );

        // Offsets and columns in UTF-16 units; a lone \r is a line break.
        let m = &describe("😀\r\ncat", &hits("😀\r\ncat", &options("cat"), 9))[0];
        assert_eq!((m.start, m.end, m.line, m.column), (4, 7, 2, 1));
        let m = &describe("one\rcat", &hits("one\rcat", &options("cat"), 9))[0];
        assert_eq!((m.line, m.column), (2, 1));
        let m = &describe("😀 cat", &hits("😀 cat", &options("cat"), 9))[0];
        assert_eq!((m.start, m.column), (3, 4));
        let m = &describe(
            "say alpha now\r\nnext",
            &hits("say alpha now\r\nnext", &options("alpha"), 9),
        )[0];
        assert_eq!(
            (m.before.as_str(), m.hit.as_str(), m.after.as_str()),
            ("say ", "alpha", " now")
        );
        // What is shown of a long line is cut at characters, not through one.
        let long = format!("{}cat{}", "é".repeat(200), "😀".repeat(200));
        let m = &describe(&long, &hits(&long, &options("cat"), 9))[0];
        assert_eq!(m.before.chars().count(), 80);
        assert_eq!(m.after.chars().count(), 40);
    }

    #[test]
    fn searches_the_files_the_tree_shows_and_stops_at_the_limit() {
        let root = scratch("find");
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("main.py"), "print('alpha')\n").unwrap();
        fs::write(
            root.join("src/one.py"),
            "alpha ALPHA alphabet\r\nprint('two')\r\n",
        )
        .unwrap();
        fs::write(root.join("src/nested/two.txt"), "alpha\n").unwrap();
        fs::write(root.join("src-other.txt"), "alpha\n").unwrap();
        fs::write(root.join("binary.bin"), b"alpha\0alpha").unwrap();
        fs::write(root.join("latin1.txt"), b"alpha \xe9\n").unwrap();
        fs::write(root.join(".gitignore"), "secret.txt\n").unwrap();
        fs::write(root.join("secret.txt"), "alpha\n").unwrap();
        let f = filter(&root);
        let entries: Vec<Entry> = [
            "binary.bin",
            "latin1.txt",
            "main.py",
            "secret.txt",
            "src-other.txt",
            "src/nested/two.txt",
            "src/one.py",
        ]
        .iter()
        .map(|p| file(p, 20))
        .collect();

        let (groups, truncated) = find(&f, &entries, &options("alpha"));
        assert!(!truncated);
        let paths: Vec<&str> = groups.iter().map(|g| g.path.as_str()).collect();
        // Not the binary, not what is not UTF-8, and not what is hidden —
        // even named in the list it was given.
        assert_eq!(
            paths,
            [
                "main.py",
                "src-other.txt",
                "src/nested/two.txt",
                "src/one.py"
            ]
        );
        assert_eq!(groups[3].matches.len(), 3);
        assert_eq!(
            (groups[3].matches[1].start, groups[3].matches[1].column),
            (6, 7)
        );

        let (inside, _) = find(
            &f,
            &entries,
            &FindOptions {
                folder: "src".into(),
                ..options("alpha")
            },
        );
        let paths: Vec<&str> = inside.iter().map(|g| g.path.as_str()).collect();
        assert_eq!(
            paths,
            ["src/nested/two.txt", "src/one.py"],
            "a folder is not its namesake's start"
        );

        fs::write(root.join("many.txt"), "cat ".repeat(FIND_LIMIT + 50)).unwrap();
        let (groups, truncated) = find(
            &f,
            &[file("many.txt", 100), file("main.py", 20)],
            &options("cat"),
        );
        assert!(truncated);
        assert_eq!(
            groups.iter().map(|g| g.matches.len()).sum::<usize>(),
            FIND_LIMIT
        );
    }

    #[test]
    fn replaces_only_in_files_that_are_still_what_was_shown() {
        let root = scratch("replace");
        fs::write(root.join("a.txt"), "cat\r\ncat and concat\r\n").unwrap();
        fs::write(root.join("b.txt"), "a cat\n").unwrap();
        fs::write(root.join("c.txt"), "cat\n").unwrap();
        let f = filter(&root);
        let sum = |text: &str| -> String {
            Sha256::digest(text.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        };
        let files = vec![
            ReplaceFile {
                path: "a.txt".into(),
                sum: sum("cat\r\ncat and concat\r\n"),
            },
            // Changed since the guest was shown it.
            ReplaceFile {
                path: "b.txt".into(),
                sum: sum("a cat, as it was\n"),
            },
            ReplaceFile {
                path: "../outside.txt".into(),
                sum: sum("cat\n"),
            },
        ];
        let word = FindOptions {
            whole_word: true,
            ..options("cat")
        };
        let done = replace(&f, &word, "$&dog", &files);
        assert_eq!((done.files, done.replacements), (1, 2));
        assert_eq!(done.skipped.len(), 2, "{:?}", done.skipped);
        // Literal in what it puts too, and the line endings as they were.
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "$&dog\r\n$&dog and concat\r\n"
        );
        assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "a cat\n");
        // And only in the files named.
        assert_eq!(fs::read_to_string(root.join("c.txt")).unwrap(), "cat\n");
        // Replaced with nothing removes it.
        let done = replace(
            &f,
            &options("cat"),
            "",
            &[ReplaceFile {
                path: "c.txt".into(),
                sum: sum("cat\n"),
            }],
        );
        assert_eq!((done.files, done.replacements), (1, 1));
        assert_eq!(fs::read_to_string(root.join("c.txt")).unwrap(), "\n");
    }
}

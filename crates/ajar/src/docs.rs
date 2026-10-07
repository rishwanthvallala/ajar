//! Collaborative editing, and its collision with a real filesystem.
//!
//! Only open files get a document. Twenty thousand CRDTs for a repository
//! nobody is reading would be absurd; the interesting state is whatever
//! somebody currently has on screen.
//!
//! The genuinely hard part is that the disk changes too. A guest types, a
//! formatter rewrites the file, someone runs `git checkout` in the terminal
//! next to it — all three are edits, and the document has to survive all of
//! them without losing anyone's work or their cursor.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use yrs::updates::decoder::Decode;
use yrs::{GetString, OffsetKind, Options, ReadTxn, StateVector, Text, TextRef, Transact, Update};

/// How long a document sits still before it is written back to disk. Long
/// enough that a burst of typing is one write, short enough that switching to
/// a terminal and running the file feels immediate.
pub const WRITE_AFTER: Duration = Duration::from_millis(400);

/// The single shared text inside every document.
const TEXT_KEY: &str = "content";

pub struct Doc {
    pub id: u32,
    pub path: String,
    doc: yrs::Doc,
    text: TextRef,
    /// Exactly what we last put on disk, so our own write can be recognised
    /// when the watcher reports it back a moment later.
    written: String,
    /// A second replica, held at `written`: the document as the disk last had
    /// it. A change on disk is an edit to *that*, not to whatever has been
    /// typed since — so it is made here, as an edit of its own, and merged
    /// into the live document the way a guest's would be. Typing that had not
    /// been written yet survives it.
    shadow: yrs::Doc,
    shadow_text: TextRef,
    /// Set when the document has changed since the last write.
    dirty: Option<Instant>,
    /// Participants with this file open. The document is dropped when the
    /// last one leaves.
    readers: HashSet<u32>,
}

impl Doc {
    fn new(id: u32, path: String, contents: &str) -> Self {
        let doc = replica();
        let text = doc.get_or_insert_text(TEXT_KEY);
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, contents);
        }
        let shadow = replica();
        let shadow_text = shadow.get_or_insert_text(TEXT_KEY);
        let mut made = Self {
            id,
            path,
            doc,
            text,
            written: contents.to_string(),
            shadow,
            shadow_text,
            dirty: None,
            readers: HashSet::new(),
        };
        made.settle();
        made
    }

    /// Bring the shadow up to the live document, which has just been written.
    fn settle(&mut self) {
        let since = self.shadow.transact().state_vector();
        let update = self.doc.transact().encode_state_as_update_v1(&since);
        if let Ok(update) = Update::decode_v1(&update) {
            let _ = self.shadow.transact_mut().apply_update(update);
        }
    }

    pub fn contents(&self) -> String {
        self.text.get_string(&self.doc.transact())
    }

    /// The whole document, for someone who just opened it.
    pub fn state(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    fn state_vector(&self) -> StateVector {
        self.doc.transact().state_vector()
    }

    /// Everything that happened since `since`.
    fn diff_since(&self, since: &StateVector) -> Vec<u8> {
        self.doc.transact().encode_state_as_update_v1(since)
    }

    fn touch(&mut self) {
        self.dirty = Some(Instant::now());
    }
}

/// An empty document that counts as the browsers do.
///
/// Yjs counts offsets in UTF-16 code units. yrs can count in bytes, which
/// would silently disagree with every browser on any file containing a
/// character outside the BMP.
fn replica() -> yrs::Doc {
    yrs::Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

pub struct Docs {
    docs: HashMap<u32, Doc>,
    by_path: HashMap<String, u32>,
    next_id: u32,
}

/// Documents one guest may hold open at once. The page holds one — the file
/// on screen — so this is a ceiling against a client opening every file in
/// the folder, a megabyte of the host's memory apiece, not a limit anybody
/// working meets.
pub const MAX_DOCS_PER_READER: usize = 16;

/// Documents open at once, everyone's together.
pub const MAX_OPEN_DOCS: usize = 256;

impl Default for Docs {
    fn default() -> Self {
        Self::new()
    }
}

impl Docs {
    pub fn new() -> Self {
        // 0 means "this frame is JSON", so document ids start at 1.
        Self {
            docs: HashMap::new(),
            by_path: HashMap::new(),
            next_id: 1,
        }
    }

    #[cfg(test)]
    pub fn get(&self, id: u32) -> Option<&Doc> {
        self.docs.get(&id)
    }

    pub fn id_for_path(&self, path: &str) -> Option<u32> {
        self.by_path.get(path).copied()
    }

    #[cfg(test)]
    pub fn is_open(&self, path: &str) -> bool {
        self.by_path.contains_key(path)
    }

    /// Whether `reader` may open `path` now, and why not. Asking again for
    /// one it already has open is always fine.
    pub fn may_open(&self, path: &str, reader: u32) -> Result<(), &'static str> {
        let open = self.by_path.get(path).and_then(|id| self.docs.get(id));
        if open.is_some_and(|d| d.readers.contains(&reader)) {
            return Ok(());
        }
        if self
            .docs
            .values()
            .filter(|d| d.readers.contains(&reader))
            .count()
            >= MAX_DOCS_PER_READER
        {
            return Err("too many files open at once — close one first");
        }
        if open.is_none() && self.docs.len() >= MAX_OPEN_DOCS {
            return Err("too many files open on this machine right now");
        }
        Ok(())
    }

    /// Open a document, creating it from `contents` if this is the first
    /// reader. Returns the id and the full state to send back.
    pub fn open(&mut self, path: &str, contents: &str, reader: u32) -> (u32, Vec<u8>) {
        let id = match self.by_path.get(path) {
            Some(id) => *id,
            None => {
                let id = self.next_id;
                self.next_id += 1;
                self.docs
                    .insert(id, Doc::new(id, path.to_string(), contents));
                self.by_path.insert(path.to_string(), id);
                id
            }
        };
        if let Some(doc) = self.docs.get_mut(&id) {
            doc.readers.insert(reader);
        }
        let state = self.docs.get(&id).map(|d| d.state()).unwrap_or_default();
        (id, state)
    }

    /// Close a document for everyone, because its file can no longer be
    /// edited. Returns its path and who had it open.
    pub fn remove(&mut self, id: u32) -> Option<(String, HashSet<u32>)> {
        let doc = self.docs.remove(&id)?;
        self.by_path.remove(&doc.path);
        Some((doc.path, doc.readers))
    }

    /// Drop a reader. Returns the document if that was the last one, so the
    /// caller can flush it before it disappears.
    pub fn close(&mut self, id: u32, reader: u32) -> Option<(String, String)> {
        let doc = self.docs.get_mut(&id)?;
        doc.readers.remove(&reader);
        if !doc.readers.is_empty() {
            return None;
        }
        let doc = self.docs.remove(&id)?;
        self.by_path.remove(&doc.path);
        Some((doc.path.clone(), doc.contents()))
    }

    /// Every open document's full state, for a resend after a gap. Yjs states
    /// are idempotent to apply, so whoever already has everything loses
    /// nothing but the bytes.
    pub fn states(&self) -> Vec<(u32, Vec<u8>)> {
        self.docs.values().map(|d| (d.id, d.state())).collect()
    }

    /// Everyone with any document open.
    pub fn readers(&self) -> HashSet<u32> {
        self.docs
            .values()
            .flat_map(|d| d.readers.iter().copied())
            .collect()
    }

    /// A participant disconnected. Same as closing everything they had open.
    pub fn drop_reader(&mut self, reader: u32) -> Vec<(String, String)> {
        let ids: Vec<u32> = self.docs.keys().copied().collect();
        ids.into_iter()
            .filter_map(|id| self.close(id, reader))
            .collect()
    }

    /// Apply a guest's update. The bytes are forwarded to everyone else
    /// verbatim — Yjs updates are idempotent and commutative, so the host
    /// never has to interpret them to relay them.
    pub fn apply(&mut self, id: u32, update: &[u8]) -> Result<()> {
        let doc = self
            .docs
            .get_mut(&id)
            .with_context(|| format!("no open document {id}"))?;
        let update = Update::decode_v1(update).context("decoding update")?;
        doc.doc
            .transact_mut()
            .apply_update(update)
            .context("applying update")?;
        doc.touch();
        Ok(())
    }

    /// Fold a change that happened on disk into the document.
    ///
    /// Returns the update to broadcast, or `None` when there was nothing to
    /// do — which is the common case, because most watcher events for an open
    /// file are the echo of our own write.
    pub fn reconcile(&mut self, id: u32, on_disk: &str) -> Option<Vec<u8>> {
        let doc = self.docs.get_mut(&id)?;

        // Our own write, echoed back by the watcher. Compared against what we
        // last wrote rather than what the document says now — because by the
        // time the event arrives, somebody has usually typed again, and
        // treating that as an external change would silently undo it.
        if on_disk == doc.written {
            return None;
        }

        let current = doc.text.get_string(&doc.doc.transact());
        if current == on_disk {
            // Someone else's change that matched what people had already
            // typed. Nothing to send, but the disk is now the reference.
            doc.written = on_disk.to_string();
            doc.dirty = None;
            doc.settle();
            return None;
        }

        let before = doc.state_vector();
        let base = doc.shadow_text.get_string(&doc.shadow.transact());
        if base == doc.written {
            // What changed on disk, relative to what was last written there —
            // made on the shadow, then merged in as a concurrent edit.
            //
            // It used to be spliced into the live document instead, which
            // made the document equal the disk: anything typed in the 400 ms
            // before the next write was deleted, for everyone, and a cursor
            // at the top of the file was thrown to wherever the splice ended.
            // A build step appending to a log someone had open lost every
            // keystroke between appends.
            let change = splice(&base, on_disk)?;
            let since = doc.shadow.transact().state_vector();
            {
                let mut txn = doc.shadow.transact_mut();
                if change.remove > 0 {
                    doc.shadow_text
                        .remove_range(&mut txn, change.at, change.remove);
                }
                if !change.insert.is_empty() {
                    doc.shadow_text.insert(&mut txn, change.at, &change.insert);
                }
            }
            let update = doc.shadow.transact().encode_state_as_update_v1(&since);
            let update = Update::decode_v1(&update).ok()?;
            doc.doc.transact_mut().apply_update(update).ok()?;
        } else {
            // The shadow has lost track of the disk, which a write that
            // failed halfway could do. The disk wins, as it always used to.
            let change = splice(&current, on_disk)?;
            {
                let mut txn = doc.doc.transact_mut();
                if change.remove > 0 {
                    doc.text.remove_range(&mut txn, change.at, change.remove);
                }
                if !change.insert.is_empty() {
                    doc.text.insert(&mut txn, change.at, &change.insert);
                }
            }
            doc.settle();
        }
        doc.written = on_disk.to_string();
        // Dirty only if typing survived the merge: then the disk is missing
        // it, and gets the merged text once things go quiet.
        doc.dirty = (doc.contents() != on_disk).then(Instant::now);
        Some(doc.diff_since(&before))
    }

    /// Documents that have been quiet long enough to write back.
    pub fn due_for_write(&self, now: Instant) -> Vec<(u32, String, String)> {
        let mut out = Vec::new();
        for doc in self.docs.values() {
            let Some(since) = doc.dirty else { continue };
            if now.duration_since(since) < WRITE_AFTER {
                continue;
            }
            let contents = doc.text.get_string(&doc.doc.transact());
            if contents == doc.written {
                continue;
            }
            out.push((doc.id, doc.path.clone(), contents));
        }
        out
    }

    /// Every change not known to be on disk, regardless of debounce age.
    /// Used during orderly shutdown, when there will be no later tick.
    pub fn pending_writes(&self) -> Vec<(u32, String, String)> {
        let mut out = Vec::new();
        for doc in self.docs.values() {
            let contents = doc.contents();
            if contents == doc.written {
                continue;
            }
            out.push((doc.id, doc.path.clone(), contents));
        }
        out
    }

    /// Acknowledge persistence only after the filesystem write succeeds.
    /// Failed writes remain dirty and are offered again on the next tick.
    pub fn mark_written(&mut self, id: u32, contents: &str) {
        let Some(doc) = self.docs.get_mut(&id) else {
            return;
        };
        doc.written = contents.to_string();
        if doc.contents() == contents {
            doc.dirty = None;
            doc.settle();
        }
    }
}

/// The one edit that turns `old` into `new`.
///
/// Replacing the whole text would be simpler and is what a naive
/// implementation does — but it deletes and reinserts every character, which
/// throws away everyone's cursor and stamps on concurrent edits. Keeping the
/// common prefix and suffix means a formatter touching one line disturbs one
/// line.
///
/// Offsets are UTF-16 code units, because that is what Yjs counts in.
#[derive(Debug, PartialEq, Eq)]
pub struct Splice {
    pub at: u32,
    pub remove: u32,
    pub insert: String,
}

pub fn splice(old: &str, new: &str) -> Option<Splice> {
    if old == new {
        return None;
    }
    let a: Vec<u16> = old.encode_utf16().collect();
    let b: Vec<u16> = new.encode_utf16().collect();

    let max_prefix = a.len().min(b.len());
    let mut prefix = 0;
    while prefix < max_prefix && a[prefix] == b[prefix] {
        prefix += 1;
    }
    // Never split a surrogate pair: doing so would produce an offset that is
    // half a character, and the two sides would disagree about where.
    if prefix > 0 && is_high_surrogate(a[prefix - 1]) {
        prefix -= 1;
    }

    let max_suffix = max_prefix - prefix;
    let mut suffix = 0;
    while suffix < max_suffix && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix] {
        suffix += 1;
    }
    if suffix > 0 && is_low_surrogate(a[a.len() - suffix]) {
        suffix -= 1;
    }

    let insert = String::from_utf16_lossy(&b[prefix..b.len() - suffix]);
    Some(Splice {
        at: prefix as u32,
        remove: (a.len() - suffix - prefix) as u32,
        insert,
    })
}

fn is_high_surrogate(u: u16) -> bool {
    (0xD800..0xDC00).contains(&u)
}

fn is_low_surrogate(u: u16) -> bool {
    (0xDC00..0xE000).contains(&u)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_guest_cannot_open_every_file_in_the_folder() {
        let mut docs = Docs::new();
        for i in 0..MAX_DOCS_PER_READER {
            let path = format!("f{i}.txt");
            assert!(docs.may_open(&path, 7).is_ok());
            docs.open(&path, "x", 7);
        }
        assert!(
            docs.may_open("one-more.txt", 7).is_err(),
            "past the ceiling"
        );
        assert!(
            docs.may_open("f0.txt", 7).is_ok(),
            "one it already has is fine"
        );
        assert!(
            docs.may_open("one-more.txt", 8).is_ok(),
            "someone else is not held to it"
        );
        let id = docs.id_for_path("f0.txt").unwrap();
        docs.close(id, 7);
        assert!(
            docs.may_open("one-more.txt", 7).is_ok(),
            "closing one makes room"
        );
    }

    fn apply(old: &str, s: &Splice) -> String {
        let a: Vec<u16> = old.encode_utf16().collect();
        let mut out: Vec<u16> = a[..s.at as usize].to_vec();
        out.extend(s.insert.encode_utf16());
        out.extend_from_slice(&a[(s.at + s.remove) as usize..]);
        String::from_utf16_lossy(&out)
    }

    #[test]
    fn identical_text_is_not_an_edit() {
        assert_eq!(splice("hello", "hello"), None);
    }

    #[test]
    fn an_insertion_touches_only_the_insertion() {
        let s = splice("fn main() {}", "fn main() { todo!() }").unwrap();
        assert_eq!(s.at, 11);
        assert_eq!(s.remove, 0);
        assert_eq!(s.insert, " todo!() ");
    }

    #[test]
    fn a_deletion_touches_only_the_deletion() {
        let s = splice("one two three", "one three").unwrap();
        assert_eq!(s.remove, 4);
        assert_eq!(s.insert, "");
        assert_eq!(apply("one two three", &s), "one three");
    }

    #[test]
    fn a_one_line_change_in_a_large_file_stays_small() {
        let mut before: Vec<String> = (0..500).map(|i| format!("line {i}")).collect();
        let after = {
            let mut a = before.clone();
            a[250] = "line 250 — edited".into();
            a.join("\n")
        };
        let s = splice(&before.join("\n"), &after).unwrap();
        assert!(
            s.insert.len() < 40 && s.remove < 40,
            "a one-line edit produced remove={} insert={:?}",
            s.remove,
            s.insert
        );
        before[250] = "line 250 — edited".into();
        assert_eq!(
            apply(
                &before.join("\n").replace("line 250 — edited", "line 250"),
                &s
            ),
            after
        );
    }

    #[test]
    fn replacing_everything_still_works() {
        let s = splice("aaa", "bbb").unwrap();
        assert_eq!(apply("aaa", &s), "bbb");
    }

    #[test]
    fn emoji_offsets_stay_whole() {
        // Two code units each. A byte-oriented diff would cut one in half.
        let old = "a👍b";
        let new = "a👍👍b";
        let s = splice(old, new).unwrap();
        assert_eq!(apply(old, &s), new);
        assert!(!s.insert.is_empty());
    }

    #[test]
    fn removing_an_emoji_stays_whole() {
        let old = "x🎉🎉y";
        let new = "x🎉y";
        let s = splice(old, new).unwrap();
        assert_eq!(apply(old, &s), new);
    }

    #[test]
    fn opening_twice_shares_one_document() {
        let mut docs = Docs::new();
        let (a, _) = docs.open("src/main.rs", "fn main() {}", 2);
        let (b, _) = docs.open("src/main.rs", "ignored — already open", 3);
        assert_eq!(a, b);
        assert_eq!(docs.get(a).unwrap().contents(), "fn main() {}");
    }

    #[test]
    fn a_document_survives_until_the_last_reader_leaves() {
        let mut docs = Docs::new();
        let (id, _) = docs.open("a.txt", "hi", 2);
        docs.open("a.txt", "hi", 3);
        assert!(
            docs.close(id, 2).is_none(),
            "closed while someone still had it open"
        );
        let (path, contents) = docs
            .close(id, 3)
            .expect("last reader should yield the file");
        assert_eq!(path, "a.txt");
        assert_eq!(contents, "hi");
        assert!(!docs.is_open("a.txt"));
    }

    #[test]
    fn a_disconnect_closes_everything_that_participant_had_open() {
        let mut docs = Docs::new();
        docs.open("a.txt", "1", 2);
        docs.open("b.txt", "2", 2);
        docs.open("c.txt", "3", 3);
        let flushed = docs.drop_reader(2);
        assert_eq!(flushed.len(), 2);
        assert!(
            docs.is_open("c.txt"),
            "someone else's document was closed too"
        );
    }

    #[test]
    fn an_echo_does_not_undo_typing_that_happened_since() {
        // The watcher reports our own write only after it lands, by which
        // time the next keystroke has usually already arrived. Reverting to
        // the file at that point loses it.
        let mut docs = Docs::new();
        let (id, _) = docs.open("a.txt", "hello", 2);

        // Write-back: the disk now holds "hello".
        let _ = docs.due_for_write(Instant::now() + WRITE_AFTER + Duration::from_millis(1));

        // Somebody types before the watcher event arrives.
        let update = {
            let doc = docs.get(id).unwrap();
            let before = doc.state_vector();
            {
                let mut txn = doc.doc.transact_mut();
                doc.text.insert(&mut txn, 5, " world");
            }
            doc.diff_since(&before)
        };
        docs.apply(id, &update).unwrap();

        // Now the echo lands, carrying the older contents.
        assert!(
            docs.reconcile(id, "hello").is_none(),
            "our own write coming back should be ignored"
        );
        assert_eq!(
            docs.get(id).unwrap().contents(),
            "hello world",
            "the echo undid an edit made while it was in flight"
        );
    }

    #[test]
    fn our_own_write_coming_back_is_not_an_edit() {
        let mut docs = Docs::new();
        let (id, _) = docs.open("a.txt", "hello", 2);
        assert!(
            docs.reconcile(id, "hello").is_none(),
            "unchanged content should not produce an update"
        );
    }

    #[test]
    fn a_change_on_disk_reaches_the_document() {
        let mut docs = Docs::new();
        let (id, _) = docs.open("a.txt", "hello world", 2);
        let update = docs
            .reconcile(id, "hello brave world")
            .expect("expected an update");
        assert!(!update.is_empty());
        assert_eq!(docs.get(id).unwrap().contents(), "hello brave world");
    }

    #[test]
    fn a_disk_change_replays_onto_another_replica() {
        // What a guest experiences: the host reconciles, sends the diff, and
        // the guest's copy has to end up identical.
        let mut docs = Docs::new();
        let (id, initial) = docs.open("a.txt", "one two three", 2);

        let replica = yrs::Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        let rtext = replica.get_or_insert_text(TEXT_KEY);
        replica
            .transact_mut()
            .apply_update(Update::decode_v1(&initial).unwrap())
            .unwrap();
        assert_eq!(rtext.get_string(&replica.transact()), "one two three");

        let update = docs.reconcile(id, "one two THREE four").unwrap();
        replica
            .transact_mut()
            .apply_update(Update::decode_v1(&update).unwrap())
            .unwrap();
        assert_eq!(rtext.get_string(&replica.transact()), "one two THREE four");
    }

    #[test]
    fn edits_are_written_back_once_typing_stops() {
        let mut docs = Docs::new();
        let (id, _) = docs.open("a.txt", "hello", 2);

        // Someone types.
        let replica_update = {
            let doc = docs.get(id).unwrap();
            let before = doc.state_vector();
            {
                let mut txn = doc.doc.transact_mut();
                doc.text.insert(&mut txn, 5, "!");
            }
            doc.diff_since(&before)
        };
        docs.apply(id, &replica_update).unwrap();

        assert!(
            docs.due_for_write(Instant::now()).is_empty(),
            "a write should wait for typing to stop"
        );
        let due = docs.due_for_write(Instant::now() + WRITE_AFTER + Duration::from_millis(1));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].2, "hello!");
        docs.mark_written(due[0].0, &due[0].2);
        assert!(
            docs.due_for_write(Instant::now() + Duration::from_secs(9))
                .is_empty(),
            "the same edit should not be written twice"
        );
    }

    #[test]
    fn shutdown_takes_edits_still_inside_the_debounce_window() {
        let mut docs = Docs::new();
        let (id, _) = docs.open("a.txt", "hello", 2);
        let replica_update = {
            let doc = docs.get(id).unwrap();
            let before = doc.state_vector();
            {
                let mut txn = doc.doc.transact_mut();
                doc.text.insert(&mut txn, 5, "!");
            }
            doc.diff_since(&before)
        };
        docs.apply(id, &replica_update).unwrap();

        assert!(docs.due_for_write(Instant::now()).is_empty());
        let pending = docs.pending_writes();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].2, "hello!");
        docs.mark_written(pending[0].0, &pending[0].2);
        assert!(docs.pending_writes().is_empty());
    }

    #[test]
    fn a_failed_write_remains_pending_until_acknowledged() {
        let mut docs = Docs::new();
        let (id, _) = docs.open("a.txt", "hello", 2);
        let update = {
            let doc = docs.get(id).unwrap();
            let before = doc.state_vector();
            {
                let mut txn = doc.doc.transact_mut();
                doc.text.insert(&mut txn, 5, "!");
            }
            doc.diff_since(&before)
        };
        docs.apply(id, &update).unwrap();

        let now = Instant::now() + WRITE_AFTER + Duration::from_millis(1);
        let first = docs.due_for_write(now);
        assert_eq!(first.len(), 1);
        assert_eq!(
            docs.due_for_write(now).len(),
            1,
            "failure was treated as saved"
        );
        docs.mark_written(first[0].0, &first[0].2);
        assert!(docs.due_for_write(now).is_empty());
    }

    #[test]
    fn a_change_on_disk_with_nothing_unsaved_is_not_written_back() {
        // The disk already holds what we just folded in; writing it back
        // would be a pointless round trip.
        let mut docs = Docs::new();
        let (id, _) = docs.open("a.txt", "hello", 2);
        docs.reconcile(id, "replaced from disk");
        assert_eq!(docs.get(id).unwrap().contents(), "replaced from disk");
        assert!(docs
            .due_for_write(Instant::now() + WRITE_AFTER + Duration::from_millis(1))
            .is_empty());
    }

    /// A guest's edit, made the way a browser makes one: on its own replica.
    fn guest_edit(
        docs: &Docs,
        id: u32,
        edit: impl FnOnce(&TextRef, &mut yrs::TransactionMut),
    ) -> Vec<u8> {
        let guest = replica();
        let text = guest.get_or_insert_text(TEXT_KEY);
        let state = docs.get(id).unwrap().state();
        guest
            .transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let before = guest.transact().state_vector();
        {
            let mut txn = guest.transact_mut();
            edit(&text, &mut txn);
        }
        let update = guest.transact().encode_state_as_update_v1(&before);
        update
    }

    #[test]
    fn a_change_on_disk_keeps_typing_that_was_not_written_yet() {
        // Two guests type, one at each end, and the file is appended to on
        // disk before the debounce writes their work. Everyone's survives.
        let mut docs = Docs::new();
        let (id, _) = docs.open("note.txt", "line1\nline2\n", 2);
        let top = guest_edit(&docs, id, |t, txn| t.insert(txn, 0, "abc"));
        let bottom = guest_edit(&docs, id, |t, txn| t.insert(txn, 12, "XYZ"));
        docs.apply(id, &top).unwrap();
        docs.apply(id, &bottom).unwrap();

        let update = docs
            .reconcile(id, "line1\nline2\nH0\n")
            .expect("the disk changed");
        let merged = docs.get(id).unwrap().contents();
        assert!(merged.starts_with("abcline1\nline2\n"), "{merged:?}");
        assert!(
            merged.contains("XYZ") && merged.contains("H0\n"),
            "{merged:?}"
        );
        assert_eq!(merged.len(), "abcline1\nline2\nH0\nXYZ".len(), "{merged:?}");

        // A guest who had all of it gets the same text from the broadcast.
        let guest = replica();
        let text = guest.get_or_insert_text(TEXT_KEY);
        for bytes in [
            docs.get(id).unwrap().state(),
            top.clone(),
            bottom.clone(),
            update,
        ] {
            guest
                .transact_mut()
                .apply_update(Update::decode_v1(&bytes).unwrap())
                .unwrap();
        }
        assert_eq!(text.get_string(&guest.transact()), merged);

        // And the disk is missing the typing, so it is written.
        let due = docs.due_for_write(Instant::now() + WRITE_AFTER + Duration::from_millis(1));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].2, merged);
        docs.mark_written(id, &merged);

        // The next change on disk is relative to that write.
        docs.reconcile(id, &format!("{merged}H1\n")).unwrap();
        assert_eq!(docs.get(id).unwrap().contents(), format!("{merged}H1\n"));
    }

    #[test]
    fn a_change_on_disk_and_typing_in_the_same_place_both_survive() {
        let mut docs = Docs::new();
        let (id, _) = docs.open("a.txt", "one two three", 2);
        let typed = guest_edit(&docs, id, |t, txn| t.insert(txn, 4, "TYPED "));
        docs.apply(id, &typed).unwrap();
        docs.reconcile(id, "one 2 three").unwrap();
        let merged = docs.get(id).unwrap().contents();
        assert!(
            merged.contains("TYPED") && merged.contains('2') && !merged.contains("two"),
            "{merged:?}"
        );
    }

    #[test]
    fn doc_kind_tags_round_trip() {
        use ajar_proto::DocKind;
        let framed = DocKind::Awareness.frame(b"payload");
        let (kind, body) = DocKind::split(&framed).unwrap();
        assert_eq!(kind, DocKind::Awareness);
        assert_eq!(body, b"payload");
        assert!(DocKind::split(&[]).is_none());
        assert!(DocKind::split(&[0xff, 1, 2]).is_none());
    }
}

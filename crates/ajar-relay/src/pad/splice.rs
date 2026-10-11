//! An edit applied to a stored file without loading it.
//!
//! A blob is the JSON string a file's text is sent as. A keystroke in a large
//! file used to read that whole string, decode it, rebuild the text around the
//! edit and encode it again: three copies of the file at once, so a 60 MB file
//! took the relay to 274 MB of its 512, and a 25 MB one before it was enough to
//! have it killed (11 October). Here the stored string is read in pieces and
//! copied through as it is, the edits are put in where they fall, and the
//! result is hashed on the way. Whatever the file's size, it costs a few
//! buffers.

use std::io::{BufRead, BufReader, BufWriter, Read, Write};

use sha2::{Digest, Sha256};

use super::Edit;

/// An edit in the stored text's own positions, in UTF-16 units: what lies in
/// `from..to` is replaced by `insert`.
#[derive(Debug, PartialEq, Eq)]
pub struct Cut<'a> {
    pub from: usize,
    pub to: usize,
    pub insert: &'a str,
}

#[derive(Debug)]
pub enum Error {
    /// The edits do not fit the text.
    Edit(&'static str),
    Io(std::io::Error),
    /// The blob is not a JSON string. Nothing the store writes.
    Corrupt,
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

/// Edits made one after another — each measured on the text the one before
/// left — as cuts in the text they started from, in order.
///
/// Only edits that move forward through the text can be put that way, and
/// that is what a browser sends: one per file.
pub fn cuts(edits: &[Edit]) -> Result<Vec<Cut<'_>>, &'static str> {
    let mut out = Vec::with_capacity(edits.len());
    // How far the text after the last edit has moved: inserted less removed.
    let mut shift: i128 = 0;
    // Where the last edit's insert ends, in the edited text.
    let mut past = 0usize;
    for e in edits {
        if e.at < past {
            return Err("edits must move forward through the text");
        }
        // Not negative: `at` is past the last insert, which is where the
        // text it left starts, and that was at or past zero.
        let from = (e.at as i128 - shift) as usize;
        let to = from
            .checked_add(e.remove)
            .ok_or("it ends outside the text")?;
        let units = e.insert.encode_utf16().count();
        out.push(Cut {
            from,
            to,
            insert: &e.insert,
        });
        shift += units as i128 - e.remove as i128;
        past = e.at.checked_add(units).ok_or("it ends outside the text")?;
    }
    Ok(out)
}

/// What a splice wrote: the hash of the new text, its size in bytes, and the
/// bytes its JSON string takes.
#[derive(Debug, PartialEq, Eq)]
pub struct Spliced {
    pub hash: String,
    pub size: u64,
    pub stored: u64,
}

struct Out<W: Write> {
    w: BufWriter<W>,
    hash: Sha256,
    size: u64,
    stored: u64,
}

impl<W: Write> Out<W> {
    /// Stored bytes `raw`, which are the text `text`.
    fn keep(&mut self, raw: &[u8], text: &[u8]) -> std::io::Result<()> {
        self.w.write_all(raw)?;
        self.stored += raw.len() as u64;
        self.hash.update(text);
        self.size += text.len() as u64;
        Ok(())
    }

    fn insert(&mut self, text: &str) -> std::io::Result<()> {
        // Escaped the way the rest of the blob was, by the same serializer.
        let quoted = serde_json::to_string(text).map_err(std::io::Error::other)?;
        self.keep(&quoted.as_bytes()[1..quoted.len() - 1], text.as_bytes())
    }
}

/// `cuts` applied to the JSON string `src` holds, the result written to `out`
/// as a JSON string, its text hashed after `prefix`.
pub fn splice(
    src: impl Read,
    prefix: &[u8],
    cuts: &[Cut],
    out: impl Write,
) -> Result<Spliced, Error> {
    let mut src = BufReader::with_capacity(64 * 1024, src);
    let mut out = Out {
        w: BufWriter::with_capacity(64 * 1024, out),
        hash: Sha256::new(),
        size: 0,
        stored: 0,
    };
    out.hash.update(prefix);
    let mut quote = [0u8; 1];
    src.read_exact(&mut quote)?;
    if quote[0] != b'"' {
        return Err(Error::Corrupt);
    }
    out.w.write_all(b"\"")?;
    out.stored += 1;

    // UTF-16 units of the stored text passed so far.
    let mut unit = 0usize;
    // The next cut to begin.
    let mut next = 0usize;
    // Inside a cut: the stored text is dropped until here.
    let mut until: Option<usize> = None;
    loop {
        at_boundary(&mut out, cuts, unit, &mut next, &mut until)?;
        // The next place something happens; nothing may straddle it.
        let stop = until
            .or_else(|| cuts.get(next).map(|c| c.from))
            .unwrap_or(usize::MAX);
        let straddled = if until.is_some() {
            "it ends outside the text"
        } else {
            "it starts outside the text"
        };
        let keeping = until.is_none();

        let buf = src.fill_buf()?;
        // Ended without its closing quote.
        let Some(&first) = buf.first() else {
            return Err(Error::Corrupt);
        };
        match first {
            b'"' => {
                src.consume(1);
                break;
            }
            b'\\' => {
                let (raw, len, ch, units) = escape(&mut src)?;
                if unit + units > stop {
                    return Err(Error::Edit(straddled));
                }
                if keeping {
                    let mut text = [0u8; 4];
                    out.keep(&raw[..len], ch.encode_utf8(&mut text).as_bytes())?;
                }
                unit += units;
            }
            _ => {
                // A run of whole characters, up to the next escape, the end,
                // or the next stop.
                let mut i = 0;
                let mut u = unit;
                while i < buf.len() {
                    let b = buf[i];
                    if b == b'"' || b == b'\\' || u == stop {
                        break;
                    }
                    let (len, units) = width(b)?;
                    if i + len > buf.len() {
                        break;
                    }
                    if u + units > stop {
                        return Err(Error::Edit(straddled));
                    }
                    i += len;
                    u += units;
                }
                if i > 0 {
                    if keeping {
                        out.keep(&buf[..i], &buf[..i])?;
                    }
                    src.consume(i);
                    unit = u;
                    continue;
                }
                // One character across the end of what is buffered.
                let (len, units) = width(first)?;
                let mut ch = [0u8; 4];
                src.read_exact(&mut ch[..len])?;
                std::str::from_utf8(&ch[..len]).map_err(|_| Error::Corrupt)?;
                if unit + units > stop {
                    return Err(Error::Edit(straddled));
                }
                if keeping {
                    out.keep(&ch[..len], &ch[..len])?;
                }
                unit += units;
            }
        }
    }
    // Edits at the very end, and none past it.
    at_boundary(&mut out, cuts, unit, &mut next, &mut until)?;
    if until.is_some() {
        return Err(Error::Edit("it ends outside the text"));
    }
    if next < cuts.len() {
        return Err(Error::Edit("it starts outside the text"));
    }
    out.w.write_all(b"\"")?;
    out.stored += 1;
    out.w.flush()?;
    Ok(Spliced {
        hash: format!("{:x}", out.hash.finalize()),
        size: out.size,
        stored: out.stored,
    })
}

/// At a character boundary `unit` in: end the cut being dropped if it ends
/// here, and put in every cut that starts here.
fn at_boundary<W: Write>(
    out: &mut Out<W>,
    cuts: &[Cut],
    unit: usize,
    next: &mut usize,
    until: &mut Option<usize>,
) -> std::io::Result<()> {
    loop {
        if let Some(to) = *until {
            if to != unit {
                return Ok(());
            }
            *until = None;
        }
        match cuts.get(*next) {
            Some(c) if c.from == unit => {
                out.insert(c.insert)?;
                *until = Some(c.to);
                *next += 1;
            }
            _ => return Ok(()),
        }
    }
}

/// Bytes and UTF-16 units of the character a byte starts.
fn width(lead: u8) -> Result<(usize, usize), Error> {
    match lead {
        0x00..=0x7F => Ok((1, 1)),
        0xC2..=0xDF => Ok((2, 1)),
        0xE0..=0xEF => Ok((3, 1)),
        0xF0..=0xF4 => Ok((4, 2)),
        _ => Err(Error::Corrupt),
    }
}

/// One escape, backslash and all: its bytes, how many, the character, and its
/// UTF-16 units. A surrogate pair is one character of two.
fn escape(src: &mut impl Read) -> Result<([u8; 12], usize, char, usize), Error> {
    let mut raw = [0u8; 12];
    src.read_exact(&mut raw[..2])?;
    let simple = match raw[1] {
        b'"' => Some('"'),
        b'\\' => Some('\\'),
        b'/' => Some('/'),
        b'b' => Some('\u{8}'),
        b'f' => Some('\u{c}'),
        b'n' => Some('\n'),
        b'r' => Some('\r'),
        b't' => Some('\t'),
        b'u' => None,
        _ => return Err(Error::Corrupt),
    };
    if let Some(ch) = simple {
        return Ok((raw, 2, ch, 1));
    }
    src.read_exact(&mut raw[2..6])?;
    let high = hex(&raw[2..6])?;
    if !(0xD800..0xDC00).contains(&high) {
        let ch = char::from_u32(high).ok_or(Error::Corrupt)?;
        return Ok((raw, 6, ch, 1));
    }
    src.read_exact(&mut raw[6..12])?;
    if &raw[6..8] != b"\\u" {
        return Err(Error::Corrupt);
    }
    let low = hex(&raw[8..12])?;
    if !(0xDC00..0xE000).contains(&low) {
        return Err(Error::Corrupt);
    }
    let ch =
        char::from_u32(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)).ok_or(Error::Corrupt)?;
    Ok((raw, 12, ch, 2))
}

fn hex(digits: &[u8]) -> Result<u32, Error> {
    let s = std::str::from_utf8(digits).map_err(|_| Error::Corrupt)?;
    u32::from_str_radix(s, 16).map_err(|_| Error::Corrupt)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The edits applied the plain way, on a decoded string, as the store did
    /// before: what a splice has to agree with.
    fn by_hand(text: &str, edits: &[Edit]) -> Option<String> {
        let mut units: Vec<u16> = text.encode_utf16().collect();
        for e in edits {
            if e.at + e.remove > units.len() {
                return None;
            }
            let insert: Vec<u16> = e.insert.encode_utf16().collect();
            units.splice(e.at..e.at + e.remove, insert);
        }
        String::from_utf16(&units).ok()
    }

    fn run(stored: &[u8], edits: &[Edit]) -> Result<(String, Spliced), Error> {
        let cuts = cuts(edits).map_err(Error::Edit)?;
        let mut out = Vec::new();
        let done = splice(stored, b"u", &cuts, &mut out)?;
        let text: String = serde_json::from_slice(&out).expect("a splice writes a JSON string");
        Ok((text, done))
    }

    fn edit(at: usize, remove: usize, insert: &str) -> Edit {
        Edit {
            at,
            remove,
            insert: insert.into(),
        }
    }

    fn hash(text: &str) -> String {
        let mut h = Sha256::new();
        h.update(b"u");
        h.update(text.as_bytes());
        format!("{:x}", h.finalize())
    }

    #[test]
    fn a_splice_agrees_with_editing_the_text() {
        // Every kind of character a blob holds, escaped and not: quotes,
        // backslashes, control characters, accents, CJK, an emoji, and a
        // character the serializer writes as \u.
        let text = "a\"b\\c\nd\te\u{1}é漢😀z\r\n end";
        let stored = serde_json::to_vec(text).unwrap();
        let len = text.encode_utf16().count();
        // Every position that is a character boundary, every remove that
        // keeps it one, with inserts that need escaping too.
        let units: Vec<u16> = text.encode_utf16().collect();
        let boundaries: Vec<usize> = (0..=len)
            .filter(|&u| String::from_utf16(&units[..u]).is_ok())
            .collect();
        let mut tried = 0;
        for &at in &boundaries {
            for &end in boundaries.iter().filter(|&&e| e >= at) {
                for insert in ["", "X", "\"\\\n", "😀ü"] {
                    let edits = [edit(at, end - at, insert)];
                    let want = by_hand(text, &edits).unwrap();
                    let (got, done) = run(&stored, &edits).unwrap();
                    assert_eq!(got, want, "{edits:?}");
                    assert_eq!(done.hash, hash(&want));
                    assert_eq!(done.size, want.len() as u64);
                    assert_eq!(done.stored, serde_json::to_vec(&want).unwrap().len() as u64);
                    tried += 1;
                }
            }
        }
        assert!(tried > 500, "only {tried} cases");
    }

    #[test]
    fn several_edits_in_order_apply_as_they_would_one_by_one() {
        let text = "hello wide world";
        let stored = serde_json::to_vec(text).unwrap();
        for edits in [
            vec![edit(0, 5, "HELLO"), edit(6, 4, "big")],
            vec![edit(2, 0, "x"), edit(3, 0, "y"), edit(4, 1, "")],
            vec![edit(16, 0, "!"), edit(17, 0, "?")],
            vec![edit(0, 16, ""), edit(0, 0, "all new")],
        ] {
            let (got, _) = run(&stored, &edits).unwrap();
            assert_eq!(got, by_hand(text, &edits).unwrap(), "{edits:?}");
        }
        // Backwards is refused rather than guessed at.
        assert!(matches!(
            run(&stored, &[edit(6, 0, "a"), edit(2, 0, "b")]),
            Err(Error::Edit(_))
        ));
    }

    #[test]
    fn an_edit_inside_a_character_or_past_the_end_is_refused() {
        let stored = serde_json::to_vec("a😀b").unwrap();
        assert!(matches!(
            run(&stored, &[edit(2, 0, "x")]),
            Err(Error::Edit("it starts outside the text"))
        ));
        assert!(matches!(
            run(&stored, &[edit(0, 2, "x")]),
            Err(Error::Edit("it ends outside the text"))
        ));
        assert!(matches!(
            run(&stored, &[edit(5, 0, "x")]),
            Err(Error::Edit("it starts outside the text"))
        ));
        assert!(matches!(
            run(&stored, &[edit(3, 3, "x")]),
            Err(Error::Edit("it ends outside the text"))
        ));
        // The same emoji written as an escaped pair is one character too.
        let escaped = br#""a\ud83d\ude00b""#;
        assert!(matches!(
            run(escaped, &[edit(2, 0, "x")]),
            Err(Error::Edit("it starts outside the text"))
        ));
        assert_eq!(run(escaped, &[edit(3, 1, "c")]).unwrap().0, "a😀c");
    }

    #[test]
    fn a_large_text_streams_through_small_buffers() {
        // Characters of every width across the 64 KiB buffer's edges: eight
        // UTF-16 units a repeat, the emoji two of them.
        let text: String = "ab漢é😀\"\n".repeat(40_000);
        let stored = serde_json::to_vec(&text).unwrap();
        let len = text.encode_utf16().count();
        let edited = len - 8 + "middle".len();
        let edits = [edit(len / 2, 8, "middle"), edit(edited - 2, 0, "end")];
        let (got, done) = run(&stored, &edits).unwrap();
        let want = by_hand(&text, &edits).unwrap();
        assert_eq!(got, want);
        assert_eq!(done.hash, hash(&want));
    }

    #[test]
    fn what_is_not_a_json_string_is_refused() {
        for bad in [
            &b"abc"[..],
            b"\"abc",
            b"\"\\q\"",
            b"\"\\ud83dx\"",
            b"\"\\udc00\"",
        ] {
            assert!(
                matches!(run(bad, &[]), Err(Error::Corrupt | Error::Io(_))),
                "{bad:?}"
            );
        }
    }
}

//! A folder as a zip, for a guest to download.
//!
//! Stored rather than compressed. Source compresses well, but deflating costs
//! the host's CPU on every download, and the whole point of the session is
//! that the host's machine is doing other work. Written by hand because the
//! format's stored subset is a few dozen lines, and a dependency for it would
//! be more to audit than to write.
//!
//! What goes in is exactly what a guest can read: the tree's own entries,
//! each read through the same rule as any other read — nothing the ignore
//! rules hide, nothing through a link out of the folder.

/// Past this a download is refused rather than held in the host's memory and
/// pushed through the relay. Source trees are far smaller; a folder this big
/// is build output, which has better ways to travel.
pub const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;

/// And past this many files. Under the format's 65,535 without its 64-bit
/// extension.
pub const MAX_DOWNLOAD_FILES: usize = 20_000;

use std::path::Path;

use ajar_proto::{Entry, EntryKind};

use crate::workspace::Filter;

/// What a guest asked to download, ready to send.
pub struct Download {
    pub name: String,
    pub bytes: Vec<u8>,
    pub files: u32,
}

/// Build what a guest asked for: one file as itself, a folder — or with
/// `path` empty, the whole workspace — as a zip named after it. `entries` is
/// the tree's own list, so nothing hidden from it can be in here, and every
/// file is read through the same rule as any guest read besides.
pub fn build(
    filter: &Filter,
    folder: &str,
    path: &str,
    entries: &[Entry],
) -> Result<Download, String> {
    let read = |rel: &str| -> Result<(Vec<u8>, u64), String> {
        let abs = filter
            .resolve_shared(rel)
            .ok_or_else(|| format!("{rel} is not shared"))?;
        let meta = std::fs::metadata(&abs).map_err(|e| format!("{rel}: {e}"))?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        Ok((
            std::fs::read(&abs).map_err(|e| format!("{rel}: {e}"))?,
            modified,
        ))
    };

    let single =
        entries.len() == 1 && entries[0].kind == EntryKind::File && entries[0].path == path;
    if single {
        if entries[0].size > MAX_DOWNLOAD_BYTES {
            return Err(too_big());
        }
        let (bytes, _) = read(path)?;
        return Ok(Download {
            name: base(path).to_string(),
            bytes,
            files: 1,
        });
    }
    if entries.is_empty() {
        return Err("nothing there to download".into());
    }

    let files: Vec<&Entry> = entries
        .iter()
        .filter(|e| e.kind == EntryKind::File)
        .collect();
    if files.len() > MAX_DOWNLOAD_FILES {
        return Err(format!(
            "{} files — more than the {MAX_DOWNLOAD_FILES} a download takes",
            files.len()
        ));
    }
    if files.iter().map(|e| e.size).sum::<u64>() > MAX_DOWNLOAD_BYTES {
        return Err(too_big());
    }
    // Unzipped, it makes the one folder it was: the workspace's name, or the
    // folder asked for, with everything inside it.
    let top = if path.is_empty() { folder } else { base(path) };
    let strip = if path.is_empty() {
        String::new()
    } else {
        format!("{path}/")
    };
    let inside = |rel: &str| format!("{top}/{}", rel.strip_prefix(&strip).unwrap_or(rel));
    let mut zip = Zip::default();
    for entry in entries {
        match entry.kind {
            EntryKind::File => {
                let (bytes, modified) = read(&entry.path)?;
                zip.add(&inside(&entry.path), &bytes, modified);
                if zip.len() as u64 > MAX_DOWNLOAD_BYTES {
                    return Err(too_big());
                }
            }
            // Folders go in only when empty; the rest are implied by the
            // files in them.
            EntryKind::Dir => {
                let prefix = format!("{}/", entry.path);
                if entry.path != path && !entries.iter().any(|e| e.path.starts_with(&prefix)) {
                    zip.add(&format!("{}/", inside(&entry.path)), b"", 0);
                }
            }
        }
    }
    Ok(Download {
        name: format!("{top}.zip"),
        bytes: zip.finish(),
        files: files.len() as u32,
    })
}

fn too_big() -> String {
    format!(
        "over {} MB — too large to download through the session",
        MAX_DOWNLOAD_BYTES / (1024 * 1024)
    )
}

fn base(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
}

/// A zip being written, all in memory.
#[derive(Default)]
pub struct Zip {
    out: Vec<u8>,
    central: Vec<u8>,
    entries: u16,
}

impl Zip {
    /// Add one file, or a folder when `name` ends in `/` and `data` is empty.
    /// `modified` is seconds since the Unix epoch.
    pub fn add(&mut self, name: &str, data: &[u8], modified: u64) {
        let (time, date) = dos_time(modified);
        let crc = crc32(data);
        let size = data.len() as u32;
        let offset = self.out.len() as u32;
        let name_bytes = name.as_bytes();

        // Local header.
        self.out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        self.out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        self.out.extend_from_slice(&0x0800u16.to_le_bytes()); // names are UTF-8
        self.out.extend_from_slice(&0u16.to_le_bytes()); // stored
        self.out.extend_from_slice(&time.to_le_bytes());
        self.out.extend_from_slice(&date.to_le_bytes());
        self.out.extend_from_slice(&crc.to_le_bytes());
        self.out.extend_from_slice(&size.to_le_bytes());
        self.out.extend_from_slice(&size.to_le_bytes());
        self.out
            .extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes()); // no extra field
        self.out.extend_from_slice(name_bytes);
        self.out.extend_from_slice(data);

        // Its entry in the central directory.
        let folder = name.ends_with('/');
        self.central
            .extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        // Made on Unix, so the mode below means something to unzip.
        self.central
            .extend_from_slice(&(0x0300u16 | 20).to_le_bytes());
        self.central.extend_from_slice(&20u16.to_le_bytes());
        self.central.extend_from_slice(&0x0800u16.to_le_bytes());
        self.central.extend_from_slice(&0u16.to_le_bytes());
        self.central.extend_from_slice(&time.to_le_bytes());
        self.central.extend_from_slice(&date.to_le_bytes());
        self.central.extend_from_slice(&crc.to_le_bytes());
        self.central.extend_from_slice(&size.to_le_bytes());
        self.central.extend_from_slice(&size.to_le_bytes());
        self.central
            .extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        self.central.extend_from_slice(&0u16.to_le_bytes()); // extra
        self.central.extend_from_slice(&0u16.to_le_bytes()); // comment
        self.central.extend_from_slice(&0u16.to_le_bytes()); // disk
        self.central.extend_from_slice(&0u16.to_le_bytes()); // internal
        let mode: u32 = if folder { 0o040755 } else { 0o100644 };
        self.central.extend_from_slice(&(mode << 16).to_le_bytes());
        self.central.extend_from_slice(&offset.to_le_bytes());
        self.central.extend_from_slice(name_bytes);

        self.entries += 1;
    }

    pub fn len(&self) -> usize {
        self.out.len() + self.central.len()
    }

    pub fn finish(mut self) -> Vec<u8> {
        let offset = self.out.len() as u32;
        let size = self.central.len() as u32;
        self.out.append(&mut self.central);
        self.out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes()); // this disk
        self.out.extend_from_slice(&0u16.to_le_bytes()); // disk with the directory
        self.out.extend_from_slice(&self.entries.to_le_bytes());
        self.out.extend_from_slice(&self.entries.to_le_bytes());
        self.out.extend_from_slice(&size.to_le_bytes());
        self.out.extend_from_slice(&offset.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes()); // no comment
        self.out
    }
}

/// CRC-32 as zip uses it (the IEEE polynomial, reflected).
pub fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        table
    });
    let mut crc = 0xFFFF_FFFFu32;
    for b in bytes {
        crc = table[((crc ^ u32::from(*b)) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

/// Unix seconds as the MS-DOS time and date zip stores, in UTC. Anything
/// before 1980, which DOS cannot say, is 1980.
fn dos_time(secs: u64) -> (u16, u16) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    if year < 1980 {
        return (0, (1 << 5) | 1);
    }
    let time = ((rem / 3600) << 11) | (((rem % 3600) / 60) << 5) | ((rem % 60) / 2);
    let date = (((year - 1980).min(127) as u64) << 9) | ((month as u64) << 5) | day as u64;
    (time as u16, date as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The names in a zip's central directory.
    fn names(zip: &[u8]) -> Vec<String> {
        let end = zip.len() - 22;
        let count = u16::from_le_bytes([zip[end + 10], zip[end + 11]]) as usize;
        let mut at = u32::from_le_bytes(zip[end + 16..end + 20].try_into().unwrap()) as usize;
        let mut out = Vec::new();
        for _ in 0..count {
            let len = u16::from_le_bytes([zip[at + 28], zip[at + 29]]) as usize;
            out.push(String::from_utf8(zip[at + 46..at + 46 + len].to_vec()).unwrap());
            at += 46 + len;
        }
        out
    }

    #[test]
    fn a_folder_downloads_as_itself_and_nothing_else() {
        let root = std::env::temp_dir().join("ajar-archive-folder");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("pkg/sub")).unwrap();
        std::fs::create_dir_all(root.join("pkg/empty")).unwrap();
        std::fs::write(root.join("pkg/a.txt"), "a").unwrap();
        std::fs::write(root.join("pkg/sub/b.txt"), "b").unwrap();
        std::fs::write(root.join("pkg/skip.log"), "ignored").unwrap();
        std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(root.join("other.txt"), "elsewhere").unwrap();
        let root = root.canonicalize().unwrap();
        let (ws, _) =
            crate::workspace::Workspace::scan(&root, crate::workspace::MAX_ENTRIES).unwrap();

        let got = build(&ws.filter(), "proj", "pkg", &ws.under("pkg")).unwrap();
        assert_eq!(got.name, "pkg.zip");
        let mut listed = names(&got.bytes);
        listed.sort();
        assert_eq!(listed, ["pkg/a.txt", "pkg/empty/", "pkg/sub/b.txt"]);

        let all = build(&ws.filter(), "proj", "", &ws.under("")).unwrap();
        assert_eq!(all.name, "proj.zip");
        let listed = names(&all.bytes);
        assert!(listed.contains(&"proj/other.txt".to_string()), "{listed:?}");
        assert!(!listed.iter().any(|n| n.ends_with(".log")), "{listed:?}");

        let one = build(&ws.filter(), "proj", "pkg/a.txt", &ws.under("pkg/a.txt")).unwrap();
        assert_eq!(
            (one.name.as_str(), one.bytes.as_slice()),
            ("a.txt", b"a".as_slice())
        );
    }

    #[test]
    fn crc_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn dates_come_out_as_dos_writes_them() {
        // 2026-10-07 12:34:56 UTC.
        let (time, date) = dos_time(1_791_376_496);
        assert_eq!(date >> 9, 2026 - 1980);
        assert_eq!((date >> 5) & 0xF, 10);
        assert_eq!(date & 0x1F, 7);
        assert_eq!(time >> 11, 12);
        assert_eq!((time >> 5) & 0x3F, 34);
        assert_eq!((time & 0x1F) * 2, 56);
        assert_eq!(dos_time(0).1, (1 << 5) | 1, "before 1980 is 1980");
    }

    #[test]
    fn a_zip_lists_what_went_in_and_ends_where_it_says() {
        let mut zip = Zip::default();
        zip.add("src/main.rs", b"fn main() {}\n", 1_791_376_496);
        zip.add("empty/", b"", 1_791_376_496);
        zip.add("caf\u{e9}.txt", &[0, 1, 2, 255], 1_791_376_496);
        let bytes = zip.finish();
        let end = bytes.len() - 22;
        assert_eq!(&bytes[end..end + 4], &0x0605_4b50u32.to_le_bytes());
        let entries = u16::from_le_bytes([bytes[end + 10], bytes[end + 11]]);
        assert_eq!(entries, 3);
        let size = u32::from_le_bytes(bytes[end + 12..end + 16].try_into().unwrap()) as usize;
        let offset = u32::from_le_bytes(bytes[end + 16..end + 20].try_into().unwrap()) as usize;
        assert_eq!(
            offset + size,
            end,
            "the directory sits right before the end record"
        );
        assert_eq!(&bytes[offset..offset + 4], &0x0201_4b50u32.to_le_bytes());
        // The first file is where its central entry says, with its own bytes.
        assert_eq!(&bytes[0..4], &0x0403_4b50u32.to_le_bytes());
        let name_len = u16::from_le_bytes([bytes[26], bytes[27]]) as usize;
        assert_eq!(&bytes[30..30 + name_len], b"src/main.rs");
        assert_eq!(&bytes[30 + name_len..30 + name_len + 13], b"fn main() {}\n");
    }
}

//! Rewrite a `.webc` without the parts of its filesystem that can never be
//! used, keeping the manifest and every atom byte-for-byte.
//!
//!   webc-trim <in.webc> <out.webc> [--drop PATTERN]... [--keep-only DIR=NAME,NAME]...
//!
//! A PATTERN is a full path — the volume name, then the path inside it — where
//! `*` matches within one segment. `--drop` removes whatever matches, file or
//! directory. `--keep-only` keeps, in each directory matching DIR, only the
//! files named; everything else in such a directory is removed. Directories
//! left empty by either are removed too.
//!
//! When no rule matches anything, nothing is written: rewriting an untouched
//! package would change its bytes, and its hash, for nothing. The rewritten
//! file is read back and checked before it is written out.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use webc::{
    v3::{
        write::{DirEntry, Directory, FileEntry, SymlinkEntry, Writer},
        ChecksumAlgorithm, SignatureAlgorithm, Timestamps,
    },
    Container, Metadata, PathSegment, Volume,
};

struct Rules {
    drop: Vec<Vec<String>>,
    keep_only: Vec<(Vec<String>, Vec<String>)>,
}

/// `*` matches within one segment; segments are compared one for one.
fn matches(pattern: &[String], path: &[String]) -> bool {
    pattern.len() == path.len()
        && pattern
            .iter()
            .zip(path)
            .all(|(p, s)| glob(p.as_bytes(), s.as_bytes()))
}

fn glob(p: &[u8], s: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => glob(&p[1..], s) || (!s.is_empty() && glob(p, &s[1..])),
        (Some(a), Some(b)) if a == b => glob(&p[1..], &s[1..]),
        _ => false,
    }
}

fn split(path: &str) -> Vec<String> {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

#[derive(Default)]
struct Removed {
    bytes: u64,
    files: u64,
}

/// Reading and writing use different timestamp types; only `modified` exists
/// in either, as nanoseconds since the epoch.
fn timestamps(meta: &Metadata) -> Timestamps {
    let read = match meta {
        Metadata::Dir { timestamps }
        | Metadata::File { timestamps, .. }
        | Metadata::Symlink { timestamps, .. } => timestamps.as_ref(),
    };
    read.map(|t| Timestamps {
        modified: std::time::UNIX_EPOCH + std::time::Duration::from_nanos(t.modified()),
    })
    .unwrap_or_default()
}

fn size_of(volume: &Volume, path: &[PathSegment]) -> (u64, u64) {
    match volume.metadata(path) {
        Some(Metadata::File { length, .. }) => (length as u64, 1),
        Some(Metadata::Dir { .. }) => volume
            .read_dir(path)
            .unwrap_or_default()
            .into_iter()
            .map(|(name, _, _)| {
                let mut child = path.to_vec();
                child.push(name);
                size_of(volume, &child)
            })
            .fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1)),
        _ => (0, 0),
    }
}

/// Rebuild one directory, recursively. `None` when nothing in it survived.
fn rebuild(
    volume: &Volume,
    full: &[String],
    path: &[PathSegment],
    stamp: Timestamps,
    rules: &Rules,
    removed: &mut Removed,
) -> Result<Option<Directory<'static>>> {
    let keep_only = rules
        .keep_only
        .iter()
        .find(|(dir, _)| matches(dir, full))
        .map(|(_, names)| names);
    let mut children = BTreeMap::new();
    let entries = volume.read_dir(path).unwrap_or_default();
    let had_children = !entries.is_empty();
    for (name, _, meta) in entries {
        let mut child = path.to_vec();
        child.push(name.clone());
        let mut child_full = full.to_vec();
        child_full.push(name.as_str().to_string());

        let dropped = rules.drop.iter().any(|p| matches(p, &child_full))
            || matches!((keep_only, &meta), (Some(names), Metadata::File { .. }) if !names.iter().any(|n| n == name.as_str()));
        if dropped {
            let (bytes, files) = size_of(volume, &child);
            removed.bytes += bytes;
            removed.files += files;
            continue;
        }
        let entry = match &meta {
            Metadata::Dir { .. } => {
                match rebuild(
                    volume,
                    &child_full,
                    &child,
                    timestamps(&meta),
                    rules,
                    removed,
                )? {
                    Some(dir) => DirEntry::Dir(dir),
                    None => continue,
                }
            }
            Metadata::File { .. } => {
                let (bytes, _) = volume
                    .read_file(child.as_slice())
                    .with_context(|| format!("reading {}", child_full.join("/")))?;
                DirEntry::File(FileEntry::owned(bytes.to_vec(), timestamps(&meta)))
            }
            Metadata::Symlink { .. } => {
                let (target, _) = volume
                    .read_link(child.as_slice())
                    .with_context(|| format!("reading link {}", child_full.join("/")))?;
                DirEntry::Symlink(SymlinkEntry::owned(target, timestamps(&meta)))
            }
        };
        children.insert(name, entry);
    }
    // Only a directory the rules emptied goes. One that was empty to begin
    // with stays: python finds its own install by looking for an empty
    // `lib-dynload`, and dropping it made every run warn "Could not find
    // platform dependent libraries".
    if had_children && children.is_empty() && !path.is_empty() {
        return Ok(None);
    }
    Ok(Some(Directory::new(children, stamp)))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        bail!("usage: webc-trim <in.webc> <out.webc> [--drop PATTERN]... [--keep-only DIR=NAME,NAME]...");
    }
    let (input, output) = (&args[0], &args[1]);
    let mut rules = Rules {
        drop: vec![],
        keep_only: vec![],
    };
    let mut rest = args[2..].iter();
    while let Some(flag) = rest.next() {
        let value = rest
            .next()
            .with_context(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--drop" => rules.drop.push(split(value)),
            "--keep-only" => {
                let (dir, names) = value
                    .split_once('=')
                    .context("--keep-only wants DIR=NAME,NAME")?;
                rules
                    .keep_only
                    .push((split(dir), names.split(',').map(String::from).collect()));
            }
            other => bail!("unknown flag {other}"),
        }
    }

    let bytes = std::fs::read(input).with_context(|| format!("reading {input}"))?;
    let version = webc::detect(bytes.as_slice())?;
    if version != webc::Version::V3 {
        bail!("{input} is {version:?}; only v3 is rewritten");
    }
    let container = Container::from_bytes_and_version(bytes.clone().into(), version)?;

    let atoms: BTreeMap<PathSegment, FileEntry> = container
        .atoms()
        .into_iter()
        .map(|(name, data)| {
            Ok((
                name.parse()?,
                FileEntry::owned(data.to_vec(), Timestamps::default()),
            ))
        })
        .collect::<Result<_>>()?;
    let mut writer = Writer::new(ChecksumAlgorithm::Sha256)
        .write_manifest(container.manifest())?
        .write_atoms(atoms)?;

    let mut removed = Removed::default();
    for (name, volume) in container.volumes() {
        let root_stamp = volume
            .metadata("/")
            .as_ref()
            .map(timestamps)
            .unwrap_or_default();
        let dir = rebuild(
            &volume,
            &split(&name),
            &[],
            root_stamp,
            &rules,
            &mut removed,
        )?
        .expect("a volume root always survives");
        writer.write_volume(&name, dir)?;
    }
    if removed.files == 0 {
        println!("{input}: unchanged");
        return Ok(());
    }
    let out = writer.finish(SignatureAlgorithm::None)?;

    // Read it back: the same manifest, the same atoms, every volume present.
    let check = Container::from_bytes_and_version(out.clone(), webc::detect(&out[..])?)?;
    if check.manifest() != container.manifest() {
        bail!("the rewritten manifest differs");
    }
    for (name, data) in container.atoms() {
        let again = check
            .get_atom(&name)
            .with_context(|| format!("atom {name} missing"))?;
        if again.as_ref() != data.as_ref() {
            bail!("atom {name} changed");
        }
    }
    if check.volumes().len() != container.volumes().len() {
        bail!("a volume went missing");
    }

    std::fs::write(output, &out)?;
    println!(
        "{input}: {:.2} MB -> {:.2} MB ({} files, {:.2} MB removed)",
        bytes.len() as f64 / 1e6,
        out.len() as f64 / 1e6,
        removed.files,
        removed.bytes as f64 / 1e6
    );
    Ok(())
}

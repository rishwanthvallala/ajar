//! Write a `.webc` of our own: a manifest, its atoms, and directories as volumes.
//!
//!   webc-pack <manifest.json> <out.webc> [--atom NAME=FILE]... [--volume NAME=DIR]...
//!   webc-pack --inspect <file.webc>
//!
//! The manifest is written as given, so its atom signatures must already be
//! right; build-java.mjs computes them. Every entry carries the same timestamp,
//! so the same inputs make the same bytes, and the same URL stays safe to cache
//! forever. Symlinks are followed: jlink's legal notices are links, and a
//! container holds the files. The result is read back and checked before it is
//! written out.
//!
//! `--inspect` prints a container's manifest and volume names — what a package
//! of ours should look like is easiest to read off one of Wasmer's.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use webc::{
    metadata::Manifest,
    v3::{
        write::{DirEntry, Directory, FileEntry, Writer},
        ChecksumAlgorithm, SignatureAlgorithm, Timestamps,
    },
    Container, PathSegment,
};

/// 2026-01-01T00:00:00Z.
fn stamp() -> Timestamps {
    Timestamps {
        modified: UNIX_EPOCH + Duration::from_secs(1_767_225_600),
    }
}

fn directory(path: &Path) -> Result<Directory<'static>> {
    let mut children = BTreeMap::new();
    for entry in std::fs::read_dir(path).with_context(|| format!("reading {}", path.display()))? {
        let entry = entry?;
        let name = entry.file_name();
        let name: PathSegment = name
            .to_str()
            .with_context(|| format!("{} is not UTF-8", entry.path().display()))?
            .parse()?;
        // Followed, not copied as links.
        let meta = std::fs::metadata(entry.path())?;
        let child = if meta.is_dir() {
            DirEntry::Dir(directory(&entry.path())?)
        } else {
            DirEntry::File(FileEntry::owned(std::fs::read(entry.path())?, stamp()))
        };
        children.insert(name, child);
    }
    Ok(Directory::new(children, stamp()))
}

fn pairs<'a>(args: &'a [String], flag: &str) -> Result<Vec<(&'a str, &'a str)>> {
    let mut out = vec![];
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let value = rest
            .next()
            .with_context(|| format!("{arg} needs a value"))?;
        if arg == flag {
            out.push(
                value
                    .split_once('=')
                    .with_context(|| format!("{flag} wants NAME=PATH"))?,
            );
        } else if arg != "--atom" && arg != "--volume" {
            bail!("unknown flag {arg}");
        }
    }
    Ok(out)
}

fn inspect(path: &str) -> Result<()> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {path}"))?;
    let container =
        Container::from_bytes_and_version(bytes.clone().into(), webc::detect(&bytes[..])?)?;
    println!("{}", serde_json::to_string_pretty(container.manifest())?);
    for (name, _) in container.volumes() {
        println!("volume {name}");
    }
    for (name, data) in container.atoms() {
        println!("atom {name} {} bytes", data.len());
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--inspect") {
        return inspect(args.get(1).context("--inspect needs a file")?);
    }
    if args.len() < 2 {
        bail!("usage: webc-pack <manifest.json> <out.webc> [--atom NAME=FILE]... [--volume NAME=DIR]...");
    }
    let (manifest_path, output) = (&args[0], &args[1]);
    let manifest: Manifest = serde_json::from_slice(
        &std::fs::read(manifest_path).with_context(|| format!("reading {manifest_path}"))?,
    )
    .with_context(|| format!("parsing {manifest_path}"))?;

    let mut atoms = BTreeMap::new();
    let mut atom_bytes = BTreeMap::new();
    for (name, file) in pairs(&args[2..], "--atom")? {
        let bytes = std::fs::read(file).with_context(|| format!("reading {file}"))?;
        if !manifest.atoms.contains_key(name) {
            bail!("atom {name} is not in the manifest");
        }
        atoms.insert(
            name.parse::<PathSegment>()?,
            FileEntry::owned(bytes.clone(), stamp()),
        );
        atom_bytes.insert(name.to_string(), bytes);
    }
    if atom_bytes.len() != manifest.atoms.len() {
        bail!(
            "the manifest names {} atoms and {} were given",
            manifest.atoms.len(),
            atom_bytes.len()
        );
    }

    let mut writer = Writer::new(ChecksumAlgorithm::Sha256)
        .write_manifest(&manifest)?
        .write_atoms(atoms)?;
    let volumes = pairs(&args[2..], "--volume")?;
    for (name, dir) in &volumes {
        writer.write_volume(name, directory(Path::new(dir))?)?;
    }
    let out = writer.finish(SignatureAlgorithm::None)?;

    let check = Container::from_bytes_and_version(out.clone(), webc::detect(&out[..])?)?;
    if check.manifest() != &manifest {
        bail!("the written manifest differs");
    }
    for (name, bytes) in &atom_bytes {
        let again = check
            .get_atom(name)
            .with_context(|| format!("atom {name} missing"))?;
        if again.as_ref() != bytes.as_slice() {
            bail!("atom {name} changed");
        }
    }
    let names: Vec<String> = check.volumes().into_keys().collect();
    for (name, _) in &volumes {
        if !names.iter().any(|n| n == name) {
            bail!("volume {name} missing; the container has {names:?}");
        }
    }

    std::fs::write(output, &out)?;
    println!("{output}: {:.2} MB", out.len() as f64 / 1e6);
    Ok(())
}

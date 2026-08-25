//! Share-time refusals. Runs before anything else happens.
//!
//! Each check is a few lines and each one prevents a whole category of bad
//! day. The v0 set is deliberately small; the full list lives in the spec.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};

#[derive(Debug)]
pub struct Verdict {
    pub path: PathBuf,
    pub warnings: Vec<String>,
}

pub fn check(raw: &Path, force: bool) -> Result<Verdict> {
    let path = raw
        .canonicalize()
        .map_err(|e| anyhow::anyhow!("cannot open {}: {e}", raw.display()))?;

    if !path.is_dir() {
        bail!("{} is not a directory", path.display());
    }

    let mut warnings = Vec::new();

    // Someone will run `ajar ~`. It shares their whole life and produces a
    // tree with a million nodes.
    if let Some(home) = home_dir() {
        if path == home {
            bail!(
                "refusing to share your home directory.\n\
                 Point ajar at a project folder instead — sharing {} exposes \
                 every file you own.",
                home.display()
            );
        }
        if home.starts_with(&path) {
            bail!(
                "refusing to share {} because it contains your home directory.",
                path.display()
            );
        }
    }

    if path.parent().is_none() {
        bail!("refusing to share the filesystem root");
    }

    // A dependency install on a Windows drive through WSL takes eight minutes
    // against twenty-five seconds on native ext4. That's a cliff, not a
    // slowdown, so it is worth stopping for.
    if is_windows_drive_mount(&path) {
        bail!(
            "{} lives on a Windows drive.\n\
             File operations here are roughly 20x slower — move the project into \
             your WSL home directory first.",
            path.display()
        );
    }

    if !path.join(".git").exists() {
        warnings.push(
            "not a git repository — there is no history to roll back to if a guest \
             changes something"
                .into(),
        );
    }

    // The entry-count rule needs the real ignore rules, so it lives with the
    // scanner rather than here. See `main::open_workspace`.
    let _ = force;

    Ok(Verdict { path, warnings })
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|h| h.canonicalize().ok())
}

fn is_windows_drive_mount(path: &Path) -> bool {
    let s = path.to_string_lossy();
    // /mnt/c/... under WSL, /Volumes/... is macOS and fine.
    s.starts_with("/mnt/") && s.split('/').nth(2).is_some_and(|d| d.len() == 1)
}

const NO_SANDBOX: &str = "\
  No sandbox here. Anyone who opens this link gets a shell as you — your
  files, your SSH keys, your cloud credentials.

  Share only with people you would hand your unlocked laptop to.";

const SANDBOXED: &str = "\
  A guest gets a shell with your toolchain, confined to this folder: they
  cannot write outside it and cannot read your ssh or cloud credentials.

  It is a sandbox, not a virtual machine. Share with people you have some
  reason to trust.";

/// What to say at the top, which depends on whether anything is enforcing it.
pub fn notice(confined: bool) -> &'static str {
    if confined {
        SANDBOXED
    } else {
        NO_SANDBOX
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_a_wsl_windows_mount() {
        assert!(is_windows_drive_mount(Path::new("/mnt/c/Users/x/project")));
        assert!(is_windows_drive_mount(Path::new("/mnt/d/code")));
        assert!(!is_windows_drive_mount(Path::new("/mnt/data/project")));
        assert!(!is_windows_drive_mount(Path::new("/Volumes/ssd/project")));
        assert!(!is_windows_drive_mount(Path::new("/home/x/project")));
    }

    #[test]
    fn refuses_the_home_directory() {
        let Some(home) = home_dir() else { return };
        let err = check(&home, false).unwrap_err().to_string();
        assert!(err.contains("home directory"), "{err}");
    }

    #[test]
    fn accepts_an_ordinary_directory() {
        let dir = std::env::temp_dir().join("ajar-guard-test");
        std::fs::create_dir_all(&dir).unwrap();
        let v = check(&dir, false).expect("temp dir should be shareable");
        assert!(v.path.is_dir());
    }
}

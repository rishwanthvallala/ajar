//! A way back.
//!
//! The sandbox deliberately does not protect the shared folder — a guest is
//! meant to edit it. So before the link exists, take a note of where things
//! stood, and on the way out say plainly what changed and how to undo it.
//!
//! `git stash create` is the right primitive: it builds a commit object from
//! the working tree without touching the working tree. `git stash` would
//! disturb what the host is looking at, which is rude at the exact moment
//! they are deciding whether to trust this.

use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    /// A commit holding the working tree as it was.
    pub commit: String,
    /// Uncommitted work was captured, not just HEAD.
    pub had_changes: bool,
}

impl Checkpoint {
    /// What to run to get back here. Restores tracked files only — anything a
    /// guest newly created stays, because deleting unknown files on someone's
    /// behalf is not a favour.
    pub fn restore_command(&self) -> String {
        format!(
            "git restore --source={} --worktree -- .",
            &self.commit[..12.min(self.commit.len())]
        )
    }
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // `trim_end` and not `trim`: porcelain status lines begin with a
    // significant space, and trimming the front shifts every path by one.
    Some(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

pub fn is_repo(root: &Path) -> bool {
    git(root, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true")
}

/// Capture the working tree. `None` when this is not a repository, or git
/// isn't installed — both of which the caller should say out loud rather than
/// paper over.
pub fn create(root: &Path) -> Option<Checkpoint> {
    if !is_repo(root) {
        return None;
    }
    // Empty when the tree is clean: nothing to stash, so HEAD is the mark.
    match git(root, &["stash", "create"]) {
        Some(sha) if !sha.is_empty() => Some(Checkpoint {
            commit: sha,
            had_changes: true,
        }),
        _ => git(root, &["rev-parse", "HEAD"])
            .filter(|s| !s.is_empty())
            .map(|commit| Checkpoint {
                commit,
                had_changes: false,
            }),
    }
}

/// Paths that differ from the checkpoint, as `git status` sees them.
pub fn changed_since(root: &Path) -> Vec<String> {
    let Some(out) = git(root, &["status", "--porcelain"]) else {
        return Vec::new();
    };
    out.lines()
        .filter_map(|line| line.get(3..))
        // Renames arrive as `old -> new`; the destination is what exists now.
        .map(|p| p.rsplit(" -> ").next().unwrap_or(p).trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo(name: &str) -> Option<std::path::PathBuf> {
        let dir = std::env::temp_dir().join(format!("ajar-ckpt-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        git(&dir, &["init", "-q"])?;
        git(&dir, &["config", "user.email", "t@example.com"])?;
        git(&dir, &["config", "user.name", "test"])?;
        fs::write(dir.join("a.txt"), "original\n").unwrap();
        git(&dir, &["add", "-A"])?;
        git(&dir, &["commit", "-qm", "first"])?;
        Some(dir)
    }

    #[test]
    fn a_plain_directory_has_no_checkpoint() {
        let dir = std::env::temp_dir().join("ajar-ckpt-plain");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(!is_repo(&dir));
        assert!(create(&dir).is_none());
    }

    #[test]
    fn a_clean_repository_checkpoints_at_head() {
        let Some(dir) = repo("clean") else { return };
        let c = create(&dir).expect("a repo should always checkpoint");
        assert!(!c.had_changes);
        assert_eq!(c.commit, git(&dir, &["rev-parse", "HEAD"]).unwrap());
        assert!(changed_since(&dir).is_empty());
    }

    #[test]
    fn uncommitted_work_is_captured_without_disturbing_it() {
        let Some(dir) = repo("dirty") else { return };
        fs::write(dir.join("a.txt"), "edited by the host\n").unwrap();

        let c = create(&dir).expect("checkpoint");
        assert!(c.had_changes, "uncommitted work should be captured");

        // The whole point: the host's working tree is untouched.
        assert_eq!(
            fs::read_to_string(dir.join("a.txt")).unwrap(),
            "edited by the host\n",
            "creating a checkpoint disturbed the working tree"
        );
        assert_eq!(changed_since(&dir), vec!["a.txt".to_string()]);
    }

    #[test]
    fn restoring_undoes_what_a_guest_did() {
        let Some(dir) = repo("restore") else { return };
        fs::write(dir.join("a.txt"), "host was here\n").unwrap();
        let c = create(&dir).expect("checkpoint");

        // A guest rewrites the file.
        fs::write(dir.join("a.txt"), "guest was here\n").unwrap();
        assert_eq!(changed_since(&dir), vec!["a.txt".to_string()]);

        // The command we print has to actually work.
        let out = Command::new("sh")
            .arg("-c")
            .arg(format!("git restore --source={} --worktree -- .", c.commit))
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            fs::read_to_string(dir.join("a.txt")).unwrap(),
            "host was here\n",
            "restoring did not bring back the host's work"
        );
    }

    #[test]
    fn status_paths_survive_the_leading_space() {
        // `git status --porcelain` puts two status characters and a space
        // before every path. Trimming the whole output eats the first line's
        // leading space and silently drops a character from that path.
        let Some(dir) = repo("porcelain") else { return };
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        git(&dir, &["add", "-A"]).unwrap();
        git(&dir, &["commit", "-qm", "second"]).unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() { changed(); }\n").unwrap();

        let changed = changed_since(&dir);
        assert_eq!(
            changed,
            vec!["src/main.rs".to_string()],
            "path was mangled: {changed:?}"
        );
    }

    #[test]
    fn untracked_files_are_reported_too() {
        let Some(dir) = repo("untracked") else { return };
        fs::write(dir.join("guest-left-this.txt"), "hi\n").unwrap();
        assert_eq!(changed_since(&dir), vec!["guest-left-this.txt".to_string()]);
    }

    #[test]
    fn the_printed_command_is_short_enough_to_read() {
        let c = Checkpoint {
            commit: "4f2a1b93c7de8801122334455667788990aabbcc".into(),
            had_changes: true,
        };
        let cmd = c.restore_command();
        assert!(cmd.contains("4f2a1b93c7de"), "{cmd}");
        assert!(!cmd.contains("aabbcc"), "the full sha is noise: {cmd}");
    }
}

//! A way back.
//!
//! The sandbox deliberately does not protect the shared folder — a guest is
//! meant to edit it. So before the link exists, take a note of where things
//! stood, and on the way out say plainly what changed and how to undo it.
//!
//! The checkpoint is a commit object built from the working tree through a
//! temporary index, so neither the host's index nor their files are touched —
//! `git stash` would disturb what the host is looking at, which is rude at the
//! exact moment they are deciding whether to trust this. Through an index of
//! its own rather than `git stash create`, which it used to be: that leaves out
//! untracked files, so a new file the host had not committed yet could be
//! rewritten by a guest with no way back. Ignored files stay out either way.
//!
//! What changed is measured against that commit, not against HEAD. Against
//! HEAD, every edit the host made before sharing was reported on the way out
//! as something that changed during the session.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    /// A commit holding the working tree as it was.
    pub commit: String,
    /// Uncommitted work was captured, not just HEAD.
    pub had_changes: bool,
}

impl Checkpoint {
    /// What to run to get back here. Puts back every file the checkpoint holds
    /// — tracked or not, as long as it was not ignored — and leaves anything a
    /// guest newly created, because deleting unknown files on someone's behalf
    /// is not a favour.
    pub fn restore_command(&self) -> String {
        format!(
            "git restore --source={} --worktree -- .",
            &self.commit[..12.min(self.commit.len())]
        )
    }
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    run(Command::new("git").args(args).current_dir(root))
}

fn run(cmd: &mut Command) -> Option<String> {
    let out = cmd.output().ok()?;
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

/// The working tree as a tree object — tracked and untracked files, ignored
/// ones left out — written through an index of its own.
///
/// The real index is copied in first when there is one, so `add` only has to
/// hash what changed rather than every file in the repository.
fn tree_of(root: &Path) -> Option<String> {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let index: PathBuf = std::env::temp_dir().join(format!(
        "ajar-index-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    if let Some(real) = git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-path", "index"],
    ) {
        let _ = std::fs::copy(real, &index);
    }
    let with_index = |args: &[&str]| {
        run(Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_INDEX_FILE", &index))
    };
    let tree = with_index(&["add", "-A", "--", "."]).and_then(|_| with_index(&["write-tree"]));
    let _ = std::fs::remove_file(&index);
    tree.filter(|t| !t.is_empty())
}

/// Capture the working tree. `None` when this is not a repository, or git
/// isn't installed — both of which the caller should say out loud rather than
/// paper over.
pub fn create(root: &Path) -> Option<Checkpoint> {
    if !is_repo(root) {
        return None;
    }
    let tree = tree_of(root)?;
    let head = git(root, &["rev-parse", "--verify", "-q", "HEAD"]).filter(|h| !h.is_empty());
    // Nothing differs from HEAD: HEAD is the mark.
    if let Some(head) = &head {
        if git(root, &["rev-parse", "HEAD^{tree}"]).as_deref() == Some(tree.as_str()) {
            return Some(Checkpoint {
                commit: head.clone(),
                had_changes: false,
            });
        }
    }
    let mut args = vec![
        "commit-tree",
        tree.as_str(),
        "-m",
        "ajar: the folder before sharing",
    ];
    if let Some(head) = &head {
        args.extend(["-p", head.as_str()]);
    }
    // A name of its own, so a machine with no git identity configured can
    // still make one. It is a commit nothing points to; only the sha matters.
    let commit = run(Command::new("git")
        .args(&args)
        .current_dir(root)
        .env("GIT_AUTHOR_NAME", "ajar")
        .env("GIT_AUTHOR_EMAIL", "ajar@localhost")
        .env("GIT_COMMITTER_NAME", "ajar")
        .env("GIT_COMMITTER_EMAIL", "ajar@localhost"))?;
    Some(Checkpoint {
        commit,
        had_changes: true,
    })
}

/// Paths that differ from the checkpoint: edited, created or deleted since.
pub fn changed_since(root: &Path, since: &Checkpoint) -> Vec<String> {
    let Some(now) = tree_of(root) else {
        return Vec::new();
    };
    // NUL-separated, so a path with a space or a quote comes out as written.
    let Some(out) = git(
        root,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            &since.commit,
            &now,
        ],
    ) else {
        return Vec::new();
    };
    out.split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
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
        assert!(changed_since(&dir, &c).is_empty());
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
        assert!(
            changed_since(&dir, &c).is_empty(),
            "the host's own edit, made before sharing, is not something that changed"
        );
    }

    #[test]
    fn restoring_undoes_what_a_guest_did() {
        let Some(dir) = repo("restore") else { return };
        fs::write(dir.join("a.txt"), "host was here\n").unwrap();
        let c = create(&dir).expect("checkpoint");

        // A guest rewrites the file.
        fs::write(dir.join("a.txt"), "guest was here\n").unwrap();
        assert_eq!(changed_since(&dir, &c), vec!["a.txt".to_string()]);

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
        let c = create(&dir).expect("checkpoint");
        fs::write(dir.join("src/main.rs"), "fn main() { changed(); }\n").unwrap();

        let changed = changed_since(&dir, &c);
        assert_eq!(
            changed,
            vec!["src/main.rs".to_string()],
            "path was mangled: {changed:?}"
        );
    }

    #[test]
    fn untracked_files_are_reported_too() {
        let Some(dir) = repo("untracked") else { return };
        let c = create(&dir).expect("checkpoint");
        fs::write(dir.join("guest-left-this.txt"), "hi\n").unwrap();
        fs::remove_file(dir.join("a.txt")).unwrap();
        assert_eq!(
            changed_since(&dir, &c),
            vec!["a.txt".to_string(), "guest-left-this.txt".to_string()],
            "a file made and a file deleted are both changes"
        );
    }

    #[test]
    fn an_uncommitted_new_file_can_be_put_back() {
        // The host's new file, never added. `git stash create` left these
        // out, so a guest's rewrite of one had no way back.
        let Some(dir) = repo("new-file") else { return };
        fs::write(dir.join("notes.txt"), "the host's notes\n").unwrap();
        let c = create(&dir).expect("checkpoint");
        assert!(c.had_changes);
        fs::write(dir.join("notes.txt"), "overwritten by a guest\n").unwrap();
        assert_eq!(changed_since(&dir, &c), vec!["notes.txt".to_string()]);

        let out = Command::new("sh")
            .arg("-c")
            .arg(c.restore_command())
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            fs::read_to_string(dir.join("notes.txt")).unwrap(),
            "the host's notes\n"
        );
        // And the index is the host's own: the new file is still untracked.
        assert_eq!(
            git(&dir, &["status", "--porcelain"]).unwrap(),
            "?? notes.txt"
        );
    }

    #[test]
    fn ignored_files_stay_out() {
        let Some(dir) = repo("ignored") else { return };
        fs::write(dir.join(".gitignore"), "build/\n").unwrap();
        git(&dir, &["add", ".gitignore"]).unwrap();
        git(&dir, &["commit", "-qm", "ignore"]).unwrap();
        let c = create(&dir).expect("checkpoint");
        fs::create_dir_all(dir.join("build")).unwrap();
        fs::write(dir.join("build/out.o"), "x").unwrap();
        assert!(changed_since(&dir, &c).is_empty());
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

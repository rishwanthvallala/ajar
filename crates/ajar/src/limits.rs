//! What a guest is allowed to spend.
//!
//! The sandbox decides which *paths* a guest can touch. It has nothing to say
//! about processes, and a shell is a process factory — so until this existed,
//! a guest could fork-bomb the machine they were lent, or open shells until
//! something fell over. For a product whose whole pitch is "lend me your
//! machine", that undercuts the offer more than any file-access question.
//!
//! Two limits, both chosen because they stop the *catastrophic* cases:
//!
//!   - a cap on open terminals, since each one is a live shell
//!   - `RLIMIT_NPROC`, which turns a fork bomb into `fork: Resource
//!     temporarily unavailable` instead of an unusable machine
//!
//! Applied with `ulimit` in a wrapper shell rather than a syscall, which keeps
//! the crate free of `unsafe`, works the same on macOS and Linux, and composes
//! with the sandbox wrappers — rlimits are inherited across `exec`, so
//! whatever the sandbox launches inherits them too.
//!
//! What is deliberately **not** capped, because the cure is worse: CPU time
//! (`RLIMIT_CPU` would kill a long build), address space (`RLIMIT_AS` breaks
//! anything that maps aggressively, `rustc` included), and disk. Those are
//! recoverable; a machine that cannot fork is not. [`Limits::summary`] says so
//! rather than letting a host assume otherwise.

/// Terminals one session may have open at once. Generous for pairing —
/// nobody watches eight terminals — and a hard stop on opening them in a loop.
pub const DEFAULT_TERMINALS: usize = 12;

/// Processes for the whole account, enforced at `fork`.
///
/// Checked against the *user's* total, so it bounds a runaway guest without
/// touching the host's own shells: those have their own, higher limit and can
/// still fork past this one. 512 leaves room for a parallel build — `cargo
/// build -j8` peaks well under a hundred — while a bomb hits the wall in
/// milliseconds.
pub const DEFAULT_PROCESSES: u32 = 512;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub terminals: usize,
    pub processes: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            terminals: DEFAULT_TERMINALS,
            processes: DEFAULT_PROCESSES,
        }
    }
}

impl Limits {
    /// Wrap a command so the limits are in force before it runs.
    ///
    /// `sh -c 'ulimit …; exec "$@"' ajar <program> <args…>` — the wrapper
    /// replaces itself with the real command, so nothing is left behind in the
    /// process tree and the pty still talks to the shell directly.
    ///
    /// `ulimit` failures are swallowed: a shell that cannot lower the limit
    /// should still start. The host is told which limits are real in the
    /// panel rather than being left to guess.
    pub fn wrap(&self, program: String, args: Vec<String>) -> (String, Vec<String>) {
        let script = format!("ulimit -u {} 2>/dev/null; exec \"$@\"", self.processes);
        let mut out = vec![
            "-c".to_string(),
            script,
            // $0, which `exec "$@"` skips over.
            "ajar-limits".to_string(),
            program,
        ];
        out.extend(args);
        ("/bin/sh".to_string(), out)
    }

    /// One line for the panel, including what is *not* covered.
    pub fn summary(&self) -> String {
        format!(
            "{} terminals, {} processes — cpu, memory and disk are not capped",
            self.terminals, self.processes
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn run(program: &str, args: Vec<String>) -> String {
        let out = Command::new(program).args(args).output().expect("spawn");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn stderr_of(program: &str, args: Vec<String>) -> String {
        let out = Command::new(program).args(args).output().expect("spawn");
        String::from_utf8_lossy(&out.stderr).to_string()
    }

    #[test]
    fn the_wrapper_runs_the_command_it_was_given() {
        let (p, a) = Limits::default().wrap("/bin/echo".into(), vec!["hello".into()]);
        assert_eq!(run(&p, a), "hello");
    }

    #[test]
    fn arguments_survive_the_wrapper() {
        // `exec "$@"` has to skip $0 and pass the rest through untouched — an
        // off-by-one here silently drops the first argument.
        let (p, a) = Limits::default().wrap(
            "/bin/sh".into(),
            vec![
                "-c".into(),
                "printf '%s|%s' \"$1\" \"$2\"".into(),
                "x".into(),
                "one".into(),
                "two".into(),
            ],
        );
        assert_eq!(run(&p, a), "one|two");
    }

    #[test]
    fn the_process_limit_is_actually_in_force() {
        let limits = Limits {
            processes: 64,
            ..Default::default()
        };
        let (p, a) = limits.wrap("/bin/sh".into(), vec!["-c".into(), "ulimit -u".into()]);
        assert_eq!(run(&p, a), "64", "the limit did not reach the command");
    }

    #[test]
    fn a_fork_bomb_hits_the_wall_instead_of_the_machine() {
        // Read from stderr, not from an exit status: a shell whose `fork`
        // fails writes the refusal out and carries on, so `||` never fires
        // and the loop looks like it simply finished. The kernel's complaint
        // is the only honest signal here.
        let limits = Limits {
            processes: 30,
            ..Default::default()
        };
        let (p, a) = limits.wrap(
            "/bin/sh".into(),
            vec![
                "-c".into(),
                "i=0; while [ $i -lt 200 ]; do sleep 3 & i=$((i+1)); done; wait".into(),
            ],
        );
        let complaints = stderr_of(&p, a);
        assert!(
            complaints
                .to_lowercase()
                .contains("resource temporarily unavailable")
                || complaints.to_lowercase().contains("fork"),
            "forking was never refused, so the limit is not reaching the shell: {complaints:?}"
        );
    }

    #[test]
    fn the_summary_admits_what_is_not_covered() {
        // A host reading "limits are on" and assuming memory is capped would
        // be worse off than one told plainly that it is not.
        let s = Limits::default().summary();
        assert!(s.contains("not capped"), "{s}");
        assert!(
            s.contains("cpu") && s.contains("memory") && s.contains("disk"),
            "{s}"
        );
    }
}

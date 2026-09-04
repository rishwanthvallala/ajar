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

/// Shells that might be able to apply the process limit, best first.
///
/// `ulimit -u` is not POSIX. bash and zsh have it; dash does not, and dash is
/// `/bin/sh` on Debian and Ubuntu — where it answers `ulimit: Illegal option
/// -u` on stderr and carries on. With that error swallowed the wrapper looks
/// like it worked, so the panel said "512 processes" while nothing at all was
/// capped. Which shell can do it is therefore probed, never assumed.
const ENFORCERS: &[&str] = &["/bin/bash", "/bin/sh", "/bin/zsh"];

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub terminals: usize,
    pub processes: u32,
    /// The shell that can actually apply `processes` here, if any.
    enforcer: Option<&'static str>,
}

impl Default for Limits {
    fn default() -> Self {
        Self::new(DEFAULT_TERMINALS, DEFAULT_PROCESSES)
    }
}

/// Ask a shell to set the limit and read it back. Claiming the cap on the
/// strength of a zero exit status would prove nothing — the failure this
/// exists to catch writes to stderr and exits 0.
fn applies(shell: &str, processes: u32) -> bool {
    let script = format!("ulimit -u {processes} 2>/dev/null; ulimit -u 2>/dev/null");
    std::process::Command::new(shell)
        .arg("-c")
        .arg(script)
        .output()
        .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == processes.to_string())
}

impl Limits {
    pub fn new(terminals: usize, processes: u32) -> Self {
        Self {
            terminals,
            processes,
            enforcer: ENFORCERS.iter().copied().find(|sh| applies(sh, processes)),
        }
    }

    /// Whether the process cap is real on this machine.
    pub fn enforces_processes(&self) -> bool {
        self.enforcer.is_some()
    }

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
        // No shell here can set it. Launch the command directly rather than
        // through a wrapper that only looks like it did something.
        let Some(shell) = self.enforcer else {
            return (program, args);
        };
        let script = format!("ulimit -u {} 2>/dev/null; exec \"$@\"", self.processes);
        let mut out = vec![
            "-c".to_string(),
            script,
            // $0, which `exec "$@"` skips over.
            "ajar-limits".to_string(),
            program,
        ];
        out.extend(args);
        (shell.to_string(), out)
    }

    /// One line for the panel, including what is *not* covered.
    pub fn summary(&self) -> String {
        match self.enforcer {
            Some(_) => format!(
                "{} terminals, {} processes — cpu, memory and disk are not capped",
                self.terminals, self.processes
            ),
            // Naming the gap rather than quietly dropping the number: a host
            // told "12 terminals" and nothing about processes can still read
            // the sentence and decide. One told "512 processes" that were
            // never applied cannot.
            None => format!(
                "{} terminals — no shell here can cap processes, so processes, \
                 cpu, memory and disk are all uncapped",
                self.terminals
            ),
        }
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
        let limits = Limits::new(DEFAULT_TERMINALS, 64);
        let Some(shell) = limits.enforcer else {
            // Nothing here can set it, which is a supported outcome — see
            // `the_summary_never_claims_a_cap_it_cannot_apply`.
            return;
        };
        // Read it back through the same shell that set it. Asking dash to
        // report a limit bash applied is how this test used to fail on Linux
        // while the limit was fine.
        let (p, a) = limits.wrap(shell.to_string(), vec!["-c".into(), "ulimit -u".into()]);
        assert_eq!(run(&p, a), "64", "the limit did not reach the command");
    }

    #[test]
    fn a_fork_bomb_hits_the_wall_instead_of_the_machine() {
        // Read from stderr, not from an exit status: a shell whose `fork`
        // fails writes the refusal out and carries on, so `||` never fires
        // and the loop looks like it simply finished. The kernel's complaint
        // is the only honest signal here.
        let limits = Limits::new(DEFAULT_TERMINALS, 30);
        let Some(shell) = limits.enforcer else {
            return;
        };
        let (p, a) = limits.wrap(
            shell.to_string(),
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
    fn the_summary_never_claims_a_cap_it_cannot_apply() {
        // The one that would have caught this. `/bin/sh` is dash on Debian
        // and Ubuntu, dash has no `ulimit -u`, and the wrapper swallowed the
        // error — so every Linux host was told "512 processes" and given
        // none. Whatever the summary says has to match what `wrap` does.
        let limits = Limits::default();
        let s = limits.summary();
        if limits.enforces_processes() {
            assert!(
                s.contains(&format!("{} processes", limits.processes)),
                "{s}"
            );
        } else {
            assert!(
                s.contains("cannot cap processes") || s.contains("cap processes"),
                "a machine that cannot cap processes must not imply it does: {s}"
            );
            let (p, _) = limits.wrap("/bin/echo".into(), vec!["hi".into()]);
            assert_eq!(
                p, "/bin/echo",
                "an unenforceable limit should add no wrapper"
            );
        }
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

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

/// Processes every guest together may add, enforced at `fork`.
///
/// 512 leaves room for a parallel build — `cargo build -j8` peaks well under a
/// hundred — while a bomb hits the wall in milliseconds.
///
/// The number is *headroom*, not a total, and that distinction is the bug this
/// used to be. `RLIMIT_NPROC` is checked against everything the user owns — on
/// Linux every thread — and the host's browser, editor and chat client are that
/// same user. A desktop is past 512 before anyone joins, so a bare `ulimit -u
/// 512` left a guest unable to start a single command, while the tests passed on
/// CI machines running almost nothing. The limit is therefore set at what the
/// host is already running plus this, measured when each terminal opens.
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
    /// `in_use` is what the host is already running, from [`in_use`]; the cap
    /// lands that far above [`Limits::processes`]. `None` where it cannot be
    /// measured, which falls back to the bare number.
    ///
    /// A cap above the user's hard limit cannot be set, so the wrapper falls
    /// back to the hard limit rather than to no limit at all.
    pub fn wrap(
        &self,
        program: String,
        args: Vec<String>,
        in_use: Option<u32>,
    ) -> (String, Vec<String>) {
        // No shell here can set it. Launch the command directly rather than
        // through a wrapper that only looks like it did something.
        let Some(shell) = self.enforcer else {
            return (program, args);
        };
        let cap = self.processes.saturating_add(in_use.unwrap_or(0));
        let script = format!(
            "ulimit -u {cap} 2>/dev/null || ulimit -u \"$(ulimit -Hu)\" 2>/dev/null; exec \"$@\""
        );
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
                "{} terminals, {} processes for guests — cpu, memory and disk are not capped",
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

/// What the host's own user is running, as `RLIMIT_NPROC` counts it, leaving
/// out everything under a guest's terminal.
///
/// Guests are left out so they cannot raise their own ceiling: counted in, a
/// guest who filled one terminal and opened another would be granted the whole
/// allowance again on top. A process a guest daemonises out of its terminal's
/// tree does count as the host's — the cap is a wall against catastrophe, not an
/// accounting system, and twelve terminals is still a bound.
///
/// Linux counts threads; macOS counts processes. Each is measured the way its
/// kernel counts, or the headroom is wrong by the thread count of a browser.
pub fn in_use(guest_roots: &[u32]) -> Option<u32> {
    let tasks = user_tasks()?;
    let total: u32 = tasks.values().map(|&(_, n)| n).sum();

    let mut children: std::collections::HashMap<u32, Vec<u32>> = Default::default();
    for (&pid, &(ppid, _)) in &tasks {
        children.entry(ppid).or_default().push(pid);
    }
    let mut guests = 0u32;
    let mut stack: Vec<u32> = guest_roots.to_vec();
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(&(_, n)) = tasks.get(&pid) {
            guests += n;
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids);
        }
    }
    Some(total.saturating_sub(guests))
}

/// pid → (parent, tasks it holds), for every process owned by our real uid.
#[cfg(target_os = "linux")]
fn user_tasks() -> Option<std::collections::HashMap<u32, (u32, u32)>> {
    // Real uid, the first of the four — the one RLIMIT_NPROC is charged to.
    let uid_of = |status: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix("Uid:"))
            .and_then(|v| v.split_whitespace().next())
            .and_then(|v| v.parse::<u32>().ok())
    };
    let field = |status: &str, name: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(name))
            .and_then(|v| v.trim().parse::<u32>().ok())
    };
    let me = uid_of(&std::fs::read_to_string("/proc/self/status").ok()?)?;
    let mut out = std::collections::HashMap::new();
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse().ok()) else {
            continue;
        };
        // A process can exit between listing and reading; it no longer counts.
        let Ok(status) = std::fs::read_to_string(entry.path().join("status")) else {
            continue;
        };
        if uid_of(&status) == Some(me) {
            let ppid = field(&status, "PPid:").unwrap_or(0);
            let threads = field(&status, "Threads:").unwrap_or(1);
            out.insert(pid, (ppid, threads));
        }
    }
    Some(out)
}

/// pid → (parent, 1), for every process owned by our real uid. `ps` rather than
/// a syscall binding: it is on every Mac and keeps this crate free of `unsafe`.
#[cfg(target_os = "macos")]
fn user_tasks() -> Option<std::collections::HashMap<u32, (u32, u32)>> {
    let ps = |args: &[&str]| {
        std::process::Command::new("/bin/ps")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let me = ps(&["-o", "ruid=", "-p", &std::process::id().to_string()])?
        .trim()
        .parse::<u32>()
        .ok()?;
    let mut out = std::collections::HashMap::new();
    for line in ps(&["-axo", "pid=,ppid=,ruid="])?.lines() {
        let mut f = line.split_whitespace().map(|v| v.parse::<u32>().ok());
        if let (Some(Some(pid)), Some(Some(ppid)), Some(Some(uid))) = (f.next(), f.next(), f.next())
        {
            if uid == me {
                out.insert(pid, (ppid, 1));
            }
        }
    }
    Some(out)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn user_tasks() -> Option<std::collections::HashMap<u32, (u32, u32)>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Held by every test that counts or fills the user's process table.
    ///
    /// The cap is measured against everything the user runs, and the test
    /// harness runs tests in parallel — so the fork bomb in one test was eating
    /// the headroom another had just measured, and the busy-host test failed one
    /// run in two for reasons that had nothing to do with the code.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

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
        let (p, a) = Limits::default().wrap("/bin/echo".into(), vec!["hello".into()], None);
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
            None,
        );
        assert_eq!(run(&p, a), "one|two");
    }

    #[test]
    fn the_process_limit_is_actually_in_force() {
        let _serial = serial();
        let limits = Limits::new(DEFAULT_TERMINALS, 64);
        let Some(shell) = limits.enforcer else {
            // Nothing here can set it, which is a supported outcome — see
            // `the_summary_never_claims_a_cap_it_cannot_apply`.
            return;
        };
        // Read it back through the same shell that set it. Asking dash to
        // report a limit bash applied is how this test used to fail on Linux
        // while the limit was fine.
        let used = in_use(&[]).unwrap_or(0);
        let (p, a) = limits.wrap(
            shell.to_string(),
            vec!["-c".into(), "ulimit -u".into()],
            Some(used),
        );
        assert_eq!(
            run(&p, a),
            (64 + used).to_string(),
            "the limit did not reach the command"
        );
    }

    #[test]
    fn a_guests_own_processes_do_not_raise_their_ceiling() {
        // Counted as the host's, a guest who filled one terminal and opened a
        // second would be handed the whole allowance again on top of it.
        let _serial = serial();
        let mut guest = Command::new("/bin/sh")
            .args(["-c", "sleep 30 & sleep 30 & wait"])
            .spawn()
            .expect("spawn a stand-in guest shell");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let everything = in_use(&[]);
        let without_guest = in_use(&[guest.id()]);
        let _ = guest.kill();
        let _ = guest.wait();
        let (Some(everything), Some(without_guest)) = (everything, without_guest) else {
            return; // Not measurable on this platform, which `wrap` accepts.
        };
        assert!(
            everything >= without_guest + 3,
            "the guest's shell and its two children were not left out: {everything} vs {without_guest}"
        );
    }

    #[test]
    fn a_fork_bomb_hits_the_wall_instead_of_the_machine() {
        // Read from stderr, not from an exit status: a shell whose `fork`
        // fails writes the refusal out and carries on, so `||` never fires
        // and the loop looks like it simply finished. The kernel's complaint
        // is the only honest signal here.
        let _serial = serial();
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
            in_use(&[]),
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
    fn a_busy_host_does_not_stop_a_guest_running_anything() {
        // RLIMIT_NPROC is checked against every process the *user* has — on
        // Linux every thread — not the guest's. A desktop with a browser open is
        // past 512 before anyone joins, and a cap applied as a bare number left
        // the guest unable to fork at all. Modelled small: a cap of 64, and a
        // host already running more than that. Wide enough that the few
        // processes other tests start meanwhile cannot use it up.
        let _serial = serial();
        let headroom = 64;
        let limits = Limits::new(DEFAULT_TERMINALS, headroom);
        let Some(shell) = limits.enforcer else {
            return;
        };
        let mut busy: Vec<_> = (0..headroom + 40)
            .map(|_| {
                Command::new("sleep")
                    .arg("30")
                    .spawn()
                    .expect("spawn sleep")
            })
            .collect();

        // A command substitution running an external binary, so a fork really
        // happens. `sh -c 'echo …'` as the last command would not test this:
        // the shell execs its final command rather than forking, and `echo` is
        // a builtin — the first draft of this test passed against the bug.
        let (p, a) = limits.wrap(
            shell.to_string(),
            vec!["-c".into(), "x=$(/bin/echo forked); echo \"$x\"".into()],
            in_use(&[]),
        );
        let out = run(&p, a);
        for child in &mut busy {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert_eq!(
            out, "forked",
            "a guest shell could not start a single process on a host that was merely busy"
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
            let (p, _) = limits.wrap("/bin/echo".into(), vec!["hi".into()], None);
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

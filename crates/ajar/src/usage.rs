//! What each terminal is actually costing the host.
//!
//! A status display tells you a guest is connected. A trust surface tells you
//! what they are running and what it is using — and the second one is what
//! decides whether someone is willing to leave their machine open.
//!
//! Each pty's shell is one process with a subtree of children under it, so
//! the number that matters is the whole subtree, not the shell.

use std::collections::HashMap;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    /// Percent of one core, summed across the subtree.
    pub cpu: f32,
    pub memory_bytes: u64,
    /// How many processes are running under this terminal.
    pub processes: usize,
}

pub struct Sampler {
    system: System,
    /// Each terminal's shell and everything under it, as last looked up.
    subtrees: Vec<(u32, u32, Vec<Pid>)>,
    /// Samples since that was looked up.
    since_listing: u32,
}

/// How many samples a terminal nobody is using goes between looks at what is
/// running under it. One that is being used is looked at every time.
const LIST_EVERY: u32 = 10;

impl Sampler {
    pub fn new() -> Self {
        Self {
            system: System::new_with_specifics(RefreshKind::nothing()),
            subtrees: Vec::new(),
            since_listing: 0,
        }
    }

    /// Sample every pty's process subtree. CPU is measured between calls, so
    /// the first sample after startup reads as zero.
    ///
    /// What a terminal is running is found by asking every process on the
    /// machine for its parent, which is most of what this costs — a fortieth
    /// of a core when it was done every second, with each one's command line
    /// and environment read as well, for as long as a session stood open. So
    /// it is asked when something may have changed: `busy` says a terminal
    /// was typed into or printed since the last sample, which is when a
    /// command starts or ends; a terminal is new; or it has been
    /// [`LIST_EVERY`] samples. In between, only the processes already known
    /// are asked what they are using — and nothing at all is, with no
    /// terminal open.
    pub fn sample(&mut self, roots: &[(u32, u32)], busy: bool) -> HashMap<u32, Usage> {
        if roots.is_empty() {
            self.subtrees.clear();
            return HashMap::new();
        }
        let same = self.subtrees.len() == roots.len()
            && self
                .subtrees
                .iter()
                .zip(roots)
                .all(|((id, root, _), (pty, pid))| id == pty && root == pid);
        self.since_listing += 1;
        if busy || !same || self.since_listing >= LIST_EVERY {
            self.list(roots);
        }

        let ours: Vec<Pid> = self
            .subtrees
            .iter()
            .flat_map(|(_, _, pids)| pids.iter().copied())
            .collect();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&ours),
            /* remove_dead */ true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );

        let mut out = HashMap::new();
        for (pty_id, _, pids) in &self.subtrees {
            let mut usage = Usage::default();
            for pid in pids {
                if let Some(process) = self.system.process(*pid) {
                    usage.cpu += process.cpu_usage();
                    usage.memory_bytes += process.memory();
                    usage.processes += 1;
                }
            }
            out.insert(*pty_id, usage);
        }
        out
    }

    /// Who is whose child, for every process, and so what is under each
    /// terminal's shell.
    fn list(&mut self, roots: &[(u32, u32)]) {
        self.since_listing = 0;
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            /* remove_dead */ true,
            ProcessRefreshKind::nothing(),
        );
        // One pass to build the parent map, so the subtree walk is linear
        // rather than quadratic in the number of processes.
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, process) in self.system.processes() {
            if let Some(parent) = process.parent() {
                children.entry(parent).or_default().push(*pid);
            }
        }
        self.subtrees = roots
            .iter()
            .map(|(pty_id, root_pid)| {
                let mut pids = Vec::new();
                let mut stack = vec![Pid::from_u32(*root_pid)];
                while let Some(pid) = stack.pop() {
                    pids.push(pid);
                    if let Some(kids) = children.get(&pid) {
                        stack.extend(kids);
                    }
                }
                (*pty_id, *root_pid, pids)
            })
            .collect();
    }
}

impl Default for Sampler {
    fn default() -> Self {
        Self::new()
    }
}

/// Bytes as something a person reads at a glance.
pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [(&str, u64); 4] = [
        ("G", 1024 * 1024 * 1024),
        ("M", 1024 * 1024),
        ("K", 1024),
        ("B", 1),
    ];
    for (suffix, scale) in UNITS {
        if bytes >= scale {
            let value = bytes as f64 / scale as f64;
            return if value < 10.0 && suffix != "B" {
                format!("{value:.1}{suffix}")
            } else {
                format!("{:.0}{suffix}", value)
            };
        }
    }
    "0B".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_bytes_readably() {
        assert_eq!(human_bytes(0), "0B");
        assert_eq!(human_bytes(512), "512B");
        assert_eq!(human_bytes(2048), "2.0K");
        assert_eq!(human_bytes(15 * 1024), "15K");
        assert_eq!(human_bytes(1024 * 1024 * 3 / 2), "1.5M");
        assert_eq!(human_bytes(2 * 1024 * 1024 * 1024), "2.0G");
    }

    #[test]
    fn samples_our_own_process_tree() {
        let mut sampler = Sampler::new();
        let me = std::process::id();
        let usage = sampler.sample(&[(1, me)], false);
        let ours = usage.get(&1).expect("our own pid should be sampled");
        assert!(ours.processes >= 1, "expected to find at least ourselves");
        assert!(ours.memory_bytes > 0, "our process should be using memory");
    }

    #[test]
    fn an_unknown_pid_samples_as_nothing() {
        let mut sampler = Sampler::new();
        let usage = sampler.sample(&[(7, u32::MAX)], false);
        assert_eq!(usage.get(&7).copied(), Some(Usage::default()));
    }

    #[test]
    fn a_child_started_since_is_counted_once_the_terminal_was_used() {
        use std::io::Write;
        // A shell of this test's own — not this process, under which the
        // tests beside this one start and end things of theirs — that starts
        // a child when told to.
        let mut shell = std::process::Command::new("sh")
            .args(["-c", "read go; sleep 4 & wait"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("sh");
        let root = [(1, shell.id())];
        let mut sampler = Sampler::new();
        let before = sampler.sample(&root, false)[&1].processes;
        shell.stdin.take().unwrap().write_all(b"go\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(600));
        // Not looked for while nothing says anything changed…
        let quiet = sampler.sample(&root, false)[&1].processes;
        // …and found at the next sample after the terminal was used.
        let busy = sampler.sample(&root, true)[&1].processes;
        let _ = shell.kill();
        let _ = shell.wait();
        assert_eq!(
            (before, quiet, busy),
            (1, 1, 2),
            "the shell alone, still alone with nothing to prompt a look, then with its child"
        );
    }
}

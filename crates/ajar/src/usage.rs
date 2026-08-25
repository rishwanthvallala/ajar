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
}

impl Sampler {
    pub fn new() -> Self {
        Self {
            system: System::new_with_specifics(
                RefreshKind::nothing().with_processes(ProcessRefreshKind::everything()),
            ),
        }
    }

    /// Sample every pty's process subtree. CPU is measured between calls, so
    /// the first sample after startup reads as zero.
    pub fn sample(&mut self, roots: &[(u32, u32)]) -> HashMap<u32, Usage> {
        self.system
            .refresh_processes(ProcessesToUpdate::All, /* remove_dead */ true);

        // One pass to build the parent map, so the subtree walk is linear
        // rather than quadratic in the number of processes.
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, process) in self.system.processes() {
            if let Some(parent) = process.parent() {
                children.entry(parent).or_default().push(*pid);
            }
        }

        let mut out = HashMap::new();
        for (pty_id, root_pid) in roots {
            let mut usage = Usage::default();
            let mut stack = vec![Pid::from_u32(*root_pid)];
            while let Some(pid) = stack.pop() {
                if let Some(process) = self.system.process(pid) {
                    usage.cpu += process.cpu_usage();
                    usage.memory_bytes += process.memory();
                    usage.processes += 1;
                }
                if let Some(kids) = children.get(&pid) {
                    stack.extend(kids);
                }
            }
            out.insert(*pty_id, usage);
        }
        out
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
        let usage = sampler.sample(&[(1, me)]);
        let ours = usage.get(&1).expect("our own pid should be sampled");
        assert!(ours.processes >= 1, "expected to find at least ourselves");
        assert!(ours.memory_bytes > 0, "our process should be using memory");
    }

    #[test]
    fn an_unknown_pid_samples_as_nothing() {
        let mut sampler = Sampler::new();
        let usage = sampler.sample(&[(7, u32::MAX)]);
        assert_eq!(usage.get(&7).copied(), Some(Usage::default()));
    }
}

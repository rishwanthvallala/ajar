//! Pseudo-terminals on the host machine.
//!
//! `portable-pty` is blocking, so each pty's reader lives on its own OS
//! thread and pushes bytes into an async channel. Output also lands in a
//! fixed ring buffer, which is what a reconnecting client replays.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc::UnboundedSender;
use tracing::debug;

/// Per-pty scrollback kept for replay. Small on purpose: a client has to
/// re-parse every escape sequence in it, and a megabyte takes visibly long.
const RING_CAPACITY: usize = 256 * 1024;

/// Fixed-size overwriting buffer of recent terminal output.
pub struct Ring {
    buf: Vec<u8>,
    capacity: usize,
}

impl Ring {
    fn new(capacity: usize) -> Self {
        Self {
            buf: Vec::with_capacity(capacity.min(64 * 1024)),
            capacity,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        if self.buf.len() > self.capacity {
            let overflow = self.buf.len() - self.capacity;
            self.buf.drain(..overflow);
        }
    }

    fn snapshot(&self) -> Vec<u8> {
        self.buf.clone()
    }
}

/// One live terminal.
pub struct PtySession {
    pub cols: u16,
    pub rows: u16,
    pub opened_by: u32,
    /// The shell's pid, so the control panel can account for everything
    /// running underneath it.
    pub pid: Option<u32>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    ring: Arc<Mutex<Ring>>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl PtySession {
    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.cols = cols;
        self.rows = rows;
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resizing pty")?;
        Ok(())
    }

    pub fn replay(&self) -> Vec<u8> {
        self.ring.lock().expect("ring poisoned").snapshot()
    }
}

/// Output emitted by a pty, on its way to the relay.
pub struct PtyOutput {
    pub pty_id: u32,
    pub bytes: Vec<u8>,
}

/// A pty that has exited.
pub struct PtyExit {
    pub pty_id: u32,
}

pub struct PtyRegistry {
    sessions: HashMap<u32, PtySession>,
    next_id: u32,
    /// The command that actually gets spawned — the shell, or the sandbox
    /// wrapped around it.
    launch: (String, Vec<String>),
    confined: bool,
    limits: crate::limits::Limits,
    cwd: std::path::PathBuf,
}

impl PtyRegistry {
    pub fn new(
        cwd: std::path::PathBuf,
        sandbox: &crate::sandbox::Sandbox,
        limits: crate::limits::Limits,
    ) -> Self {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        // Limits outermost: rlimits are inherited across `exec`, so whatever
        // the sandbox launches inherits them too.
        let (program, args) = sandbox.wrap(&shell);
        // Ids start at 1 because 0 means "this frame is JSON, not stream bytes".
        Self {
            sessions: HashMap::new(),
            next_id: 1,
            launch: limits.wrap(program, args),
            confined: sandbox.is_confined(),
            limits,
            cwd,
        }
    }

    /// Whether another terminal may be opened, and why not if not.
    pub fn may_open(&self) -> Result<(), String> {
        if self.sessions.len() >= self.limits.terminals {
            return Err(format!(
                "{} terminals already open, which is the limit for one session",
                self.limits.terminals
            ));
        }
        Ok(())
    }

    pub fn ids(&self) -> Vec<u32> {
        let mut v: Vec<u32> = self.sessions.keys().copied().collect();
        v.sort_unstable();
        v
    }

    /// `(pty_id, shell_pid)` for everything we can account for.
    pub fn roots(&self) -> Vec<(u32, u32)> {
        let mut v: Vec<(u32, u32)> = self
            .sessions
            .iter()
            .filter_map(|(id, s)| s.pid.map(|pid| (*id, pid)))
            .collect();
        v.sort_unstable();
        v
    }

    pub fn get_mut(&mut self, id: u32) -> Option<&mut PtySession> {
        self.sessions.get_mut(&id)
    }

    pub fn get(&self, id: u32) -> Option<&PtySession> {
        self.sessions.get(&id)
    }

    pub fn remove(&mut self, id: u32) {
        self.sessions.remove(&id);
    }

    /// Spawn a shell and start pumping its output into `out`.
    pub fn open(
        &mut self,
        cols: u16,
        rows: u16,
        opened_by: u32,
        out: UnboundedSender<PtyOutput>,
        exits: UnboundedSender<PtyExit>,
    ) -> Result<u32> {
        let id = self.next_id;
        self.next_id += 1;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("opening pty")?;

        let (program, args) = &self.launch;
        let mut cmd = CommandBuilder::new(program);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.cwd(&self.cwd);
        // Without this many programs assume a dumb terminal and refuse colour.
        cmd.env("TERM", "xterm-256color");
        cmd.env("AJAR", "1");
        if self.confined {
            // The home directory is not writable inside the sandbox, and a
            // shell that cannot save its history says so on every exit.
            cmd.env("HISTFILE", "/dev/null");
        }

        let child = pair.slave.spawn_command(cmd).context("spawning shell")?;
        let pid = child.process_id();
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("cloning pty reader")?;
        let writer = pair.master.take_writer().context("taking pty writer")?;
        let ring = Arc::new(Mutex::new(Ring::new(RING_CAPACITY)));

        let ring_for_thread = ring.clone();
        std::thread::Builder::new()
            .name(format!("ajar-pty-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let bytes = buf[..n].to_vec();
                            ring_for_thread.lock().expect("ring poisoned").push(&bytes);
                            if out.send(PtyOutput { pty_id: id, bytes }).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            debug!("pty {id} read ended: {e}");
                            break;
                        }
                    }
                }
                let _ = exits.send(PtyExit { pty_id: id });
            })
            .context("spawning pty reader thread")?;

        self.sessions.insert(
            id,
            PtySession {
                cols,
                rows,
                opened_by,
                pid,
                master: pair.master,
                writer,
                ring,
                _child: child,
            },
        );
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_only_the_tail() {
        let mut r = Ring::new(8);
        r.push(b"abcdef");
        r.push(b"ghijkl");
        assert_eq!(r.snapshot(), b"efghijkl");
    }

    #[test]
    fn ring_handles_one_oversized_write() {
        let mut r = Ring::new(4);
        r.push(b"abcdefghij");
        assert_eq!(r.snapshot(), b"ghij");
    }
}

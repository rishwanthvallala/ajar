//! Pseudo-terminals on the host machine.
//!
//! `portable-pty` is blocking, so each pty's reader lives on its own OS
//! thread and pushes bytes into an async channel. Output also lands in a
//! fixed ring buffer, which is what a reconnecting client replays.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc::UnboundedSender;
use tracing::debug;

/// Per-pty scrollback kept for replay. Small on purpose: a client has to
/// re-parse every escape sequence in it, and a megabyte takes visibly long.
const RING_CAPACITY: usize = 256 * 1024;

/// Typing and pastes waiting for a program to read them, per terminal. Past
/// this the input is dropped: a program that never reads would otherwise hold
/// everything anyone pastes at it, for ever.
const MAX_QUEUED_INPUT: usize = 1024 * 1024;

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
    input: Input,
    ring: Arc<Mutex<Ring>>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// A terminal's input, written by a thread of its own.
///
/// A pty takes only so much input before the program on it reads some — about
/// a kilobyte, on macOS — and past that a write blocks. It used to be written
/// from the agent's one loop, so a paste into a terminal running `sleep`, or
/// anything else not reading, stopped the whole agent: every terminal, every
/// document, the panel, and ctrl-c. Now only that terminal waits, as it would
/// in any terminal emulator.
struct Input {
    tx: mpsc::Sender<(u64, Vec<u8>)>,
    queued: Arc<AtomicUsize>,
    /// Bumped by an interrupt. Input queued before it is dropped unwritten,
    /// so a ctrl-c is not stuck behind the paste it is meant to stop.
    epoch: Arc<AtomicU64>,
}

impl Input {
    fn start(id: u32, mut writer: Box<dyn Write + Send>) -> Result<Self> {
        let (tx, rx) = mpsc::channel::<(u64, Vec<u8>)>();
        let queued = Arc::new(AtomicUsize::new(0));
        let epoch = Arc::new(AtomicU64::new(0));
        let (left, current) = (queued.clone(), epoch.clone());
        std::thread::Builder::new()
            .name(format!("ajar-pty-in-{id}"))
            .spawn(move || {
                for (sent_in, bytes) in rx {
                    left.fetch_sub(bytes.len(), Ordering::Relaxed);
                    if sent_in < current.load(Ordering::Relaxed) {
                        continue;
                    }
                    if writer
                        .write_all(&bytes)
                        .and_then(|_| writer.flush())
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .context("spawning pty writer thread")?;
        Ok(Self { tx, queued, epoch })
    }

    fn send(&self, bytes: &[u8]) -> Result<()> {
        // ctrl-c, ctrl-\ and ctrl-z: whatever is still waiting was meant to
        // be interrupted too.
        let epoch = if bytes.iter().any(|b| matches!(b, 0x03 | 0x1c | 0x1a)) {
            self.epoch.fetch_add(1, Ordering::Relaxed) + 1
        } else {
            self.epoch.load(Ordering::Relaxed)
        };
        if self.queued.load(Ordering::Relaxed) + bytes.len() > MAX_QUEUED_INPUT {
            debug!("terminal input backed up; dropping {} bytes", bytes.len());
            return Ok(());
        }
        self.queued.fetch_add(bytes.len(), Ordering::Relaxed);
        self.tx
            .send((epoch, bytes.to_vec()))
            .context("the terminal has closed")
    }
}

impl PtySession {
    /// Queue input for the terminal. Never blocks: see `Input`.
    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.input.send(bytes)
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
    /// The shell, or the sandbox wrapped around it. The process limit goes
    /// around this at each open, because its value depends on what the host is
    /// running at that moment.
    launch: (String, Vec<String>),
    confined: bool,
    cargo_home: Option<std::path::PathBuf>,
    limits: crate::limits::Limits,
    cwd: std::path::PathBuf,
    /// Variables removed from every guest shell's environment. See
    /// [`crate::secrets::withheld_env`].
    withheld: Vec<String>,
}

impl PtyRegistry {
    pub fn new(
        cwd: std::path::PathBuf,
        sandbox: &crate::sandbox::Sandbox,
        limits: crate::limits::Limits,
        withheld: Vec<String>,
    ) -> Self {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let (program, args) = sandbox.wrap(&shell);
        // Ids start at 1 because 0 means "this frame is JSON, not stream bytes".
        let confined = sandbox.is_confined();
        let cargo_home = confined
            .then(|| std::env::var_os("HOME"))
            .flatten()
            .map(std::path::PathBuf::from)
            .map(|home| home.join(".cache/ajar/cargo"));
        if let Some(path) = &cargo_home {
            // Landlock can only grant paths that exist when the ruleset is
            // applied. The agent creates the isolated Cargo home first.
            let _ = std::fs::create_dir_all(path);
        }
        Self {
            sessions: HashMap::new(),
            next_id: 1,
            launch: (program, args),
            confined,
            cargo_home,
            limits,
            cwd,
            withheld,
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

        // Limits outermost: rlimits are inherited across `exec`, so whatever
        // the sandbox launches inherits them too.
        let guests: Vec<u32> = self.roots().into_iter().map(|(_, pid)| pid).collect();
        let (program, args) = self.limits.wrap(
            self.launch.0.clone(),
            self.launch.1.clone(),
            crate::limits::in_use(&guests),
        );
        let mut cmd = CommandBuilder::new(&program);
        for arg in &args {
            cmd.arg(arg);
        }
        cmd.cwd(&self.cwd);
        // The builder starts from this process's own environment, which is the
        // host's shell — so without this, every credential the host had
        // exported was one `env` away from a guest.
        for name in &self.withheld {
            cmd.env_remove(name);
        }
        // Without this many programs assume a dumb terminal and refuse colour.
        cmd.env("TERM", "xterm-256color");
        cmd.env("AJAR", "1");
        if self.confined {
            // The home directory is not writable inside the sandbox, and a
            // shell that cannot save its history says so on every exit.
            cmd.env("HISTFILE", "/dev/null");
            if let Some(path) = &self.cargo_home {
                cmd.env("CARGO_HOME", path);
            }
        }

        let child = pair.slave.spawn_command(cmd).context("spawning shell")?;
        let pid = child.process_id();
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("cloning pty reader")?;
        let input = Input::start(id, pair.master.take_writer().context("taking pty writer")?)?;
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
                input,
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

    /// A terminal whose program is not reading: every write waits for `open`.
    struct Stuck {
        entered: mpsc::Sender<()>,
        open: Arc<Mutex<mpsc::Receiver<()>>>,
        got: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for Stuck {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.entered.send(());
            let _ = self.open.lock().unwrap().recv();
            self.got.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn input_to_a_terminal_that_is_not_reading_never_blocks_and_ctrl_c_jumps_the_queue() {
        let (entered_tx, entered) = mpsc::channel();
        let (open_tx, open_rx) = mpsc::channel();
        let got = Arc::new(Mutex::new(Vec::new()));
        let input = Input::start(
            1,
            Box::new(Stuck {
                entered: entered_tx,
                open: Arc::new(Mutex::new(open_rx)),
                got: got.clone(),
            }),
        )
        .unwrap();

        let started = std::time::Instant::now();
        input.send(b"first").unwrap();
        entered.recv().unwrap();
        // The writer is now stuck on "first". None of this may wait for it.
        input.send(&[b'x'; 64 * 1024]).unwrap();
        input.send(b"more").unwrap();
        input.send(b"\x03").unwrap();
        assert!(started.elapsed() < std::time::Duration::from_millis(500));

        for _ in 0..2 {
            open_tx.send(()).unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while got.lock().unwrap().as_slice() != b"first\x03" {
            assert!(
                std::time::Instant::now() < deadline,
                "{:?}",
                String::from_utf8_lossy(&got.lock().unwrap())
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn input_past_the_cap_is_dropped_not_held() {
        let (entered_tx, entered) = mpsc::channel();
        let (_open_tx, open_rx) = mpsc::channel::<()>();
        let input = Input::start(
            1,
            Box::new(Stuck {
                entered: entered_tx,
                open: Arc::new(Mutex::new(open_rx)),
                got: Arc::new(Mutex::new(Vec::new())),
            }),
        )
        .unwrap();
        input.send(b"first").unwrap();
        entered.recv().unwrap();
        for _ in 0..4 {
            input.send(&vec![b'x'; MAX_QUEUED_INPUT / 2]).unwrap();
        }
        assert!(input.queued.load(Ordering::Relaxed) <= MAX_QUEUED_INPUT);
    }

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

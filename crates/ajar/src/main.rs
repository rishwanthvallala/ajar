//! ajar — leave a machine open to someone.
//!
//! v0: shared terminals over a link. No sandbox, no editing, no persistence.
//! See the build spec for what that deliberately leaves out and why.

mod archive;
mod checkpoint;
mod client;
mod docs;
mod fileops;
mod guard;
mod ids;
mod limits;
mod pty;
mod sandbox;
mod secrets;
mod ui;
mod usage;
mod workspace;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ajar_proto::{
    Channel, Cipher, Control, Doc as DocMsg, DocKind, Frame, Fs, Participant, Person, Presence,
    Pty, Role, SnapshotBody, SnapshotFile, Store, SNAPSHOT_STREAM, STREAM_CONTROL, TARGET_ALL,
};
#[cfg(unix)]
use anyhow::Context;
use anyhow::{bail, Result};
use clap::Parser;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::client::{RelayEvent, RelayHandle};
use crate::docs::Docs;
use crate::pty::{PtyExit, PtyOutput, PtyRegistry};
use crate::ui::{Action, GuestRow, KickStep, Status, Ui};
use crate::usage::Sampler;
use crate::workspace::{FsEvent, Workspace, MAX_ENTRIES};

/// A sustained install trips the resync threshold over and over. A full
/// tree is not cheap, so rebuild at most this often.
const RESYNC_COOLDOWN: Duration = Duration::from_secs(1);

/// The most of one terminal's output that goes in one frame.
const PTY_FRAME: usize = 64 * 1024;

/// How long the folder must sit still before a snapshot is offered. The copy
/// exists so guests can keep reading when the host drops; it does not need to
/// be current to the keystroke, and re-sending the whole thing on every save
/// would be absurd.
const SNAPSHOT_AFTER: Duration = Duration::from_secs(5);

/// How often the panel re-samples what guests are running. Process
/// accounting is not free, and a second is faster than anyone reads.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Parser, Debug)]
#[command(name = "ajar", version, about = "Leave a machine open to someone")]
struct Args {
    /// Folder to share.
    #[arg(default_value = ".")]
    path: PathBuf,

    /// Relay to dial out to.
    ///
    /// Defaults to the public relay, because that is what someone who just
    /// installed this wants and typing a flag to reach it every time is a
    /// papercut. Development points at a local one explicitly — every script
    /// in `scripts/` already does.
    #[arg(long, default_value = "https://ajar.rishwanth.dev", env = "AJAR_RELAY")]
    relay: String,

    /// Name shown to guests.
    #[arg(long)]
    name: Option<String>,

    /// Proceed past size warnings.
    #[arg(long)]
    force: bool,

    /// Cut off outbound network access for guests. Sensible for an
    /// interview, painful for anything that needs to install a dependency.
    #[arg(long)]
    no_network: bool,

    /// Share without a sandbox, on a platform that has one.
    #[arg(long)]
    no_sandbox: bool,

    /// Start read-only: guests watch and read, but cannot type, open a
    /// terminal or edit a file. What a lecture or a demo wants. Toggle it
    /// later with `l`.
    #[arg(long)]
    read_only: bool,

    /// Do not keep a copy on the relay. Guests then lose the folder the
    /// moment your connection drops, and get it back when you return.
    #[arg(long)]
    no_sync: bool,

    /// Terminals one session may have open at once.
    #[arg(long, default_value_t = limits::DEFAULT_TERMINALS)]
    max_terminals: usize,

    /// Processes a guest may create, enforced at fork. Low enough to stop a
    /// fork bomb, high enough for a parallel build.
    #[arg(long, default_value_t = limits::DEFAULT_PROCESSES)]
    max_processes: u32,
}

/// Everything the frame handler needs. Bundled because passing eight
/// arguments around was worse.
struct Host {
    ptys: PtyRegistry,
    workspace: Workspace,
    docs: Docs,
    /// Per-participant window sizes. The smallest attached client wins, or
    /// the terminal wraps wrongly for whoever has the narrowest window.
    sizes: HashMap<u32, (u16, u16)>,
    guests: HashMap<u32, String>,
    /// The host's own name, since the relay no longer carries one.
    host_name: String,
    /// Shown to guests as the name of what they are looking at.
    folder_name: String,
    joined_at: HashMap<u32, Instant>,
    ui: Ui,
    state: ui::State,
    sampler: Sampler,
    /// The folder's copy for the relay is being made, off the loop.
    copying: bool,
    /// And being sent, a piece at a time: the blob, and how much of it has
    /// gone. None while none is, or when the relay takes it whole.
    copy_out: Option<CopyOut>,
    /// A terminal was typed into or printed since the panel last looked at
    /// what the terminals are running: something may have started or ended.
    pty_busy: bool,
    last_resync: Instant,
    /// Off means no copy is kept, and the relay is told to forget any it has.
    syncing: bool,
    /// A snapshot is owed once the folder has been still for a while.
    snapshot_due: Option<Instant>,
    /// What the last accepted snapshot cost, for the panel.
    synced: Option<(u64, u32)>,
    /// Sealed and waiting for the relay to accept the offer.
    pending_snapshot: Option<Vec<u8>>,
    pending_files: u32,
    /// Open documents whose last write failed, so the failure is said once.
    failing_writes: std::collections::HashSet<u32>,
    cipher: Cipher,
    /// A rebuild is owed but the cooldown has not passed.
    resync_pending: bool,
    out_tx: mpsc::UnboundedSender<PtyOutput>,
    exit_tx: mpsc::UnboundedSender<PtyExit>,
    outbound: mpsc::UnboundedSender<Frame>,
    lock_state: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Shared with the relay connection: every guest let in, by the hash of
    /// their page's secret, less anyone kicked.
    admitted: client::Admitted,
    /// Which of those secrets each guest here introduced themselves with.
    passes: HashMap<u32, String>,
    /// Names of guests who have gone, for the terminals they left running.
    departed: HashMap<u32, String>,
    /// Downloads on their way out, by guest and id.
    downloads: HashMap<(u32, u32), Transfer>,
    /// Each guest's latest download request, so an older one still being
    /// built when they ask again is dropped rather than sent too.
    latest_download: HashMap<u32, u32>,
    next_download: u32,
    /// Where a download being built off the loop comes back to it.
    built_tx: mpsc::UnboundedSender<Built>,
    /// Uploads on their way in, by guest and the number the guest gave it.
    uploads: HashMap<(u32, u32), Upload>,
    /// Each guest's latest search, so one overtaken while it ran is dropped.
    latest_find: HashMap<u32, u32>,
    /// Where a search or a replace run off the loop comes back to it.
    worked_tx: mpsc::UnboundedSender<Worked>,
}

impl Host {
    /// One line of activity. In panel mode it lands in the activity pane; when
    /// stdout is piped it is just a printed line.
    fn log(&mut self, line: impl Into<String>) {
        self.ui.log(&mut self.state, line);
    }

    /// Refresh the rows the panel draws from live state.
    fn refresh_panel(&mut self) {
        let mut guests: Vec<GuestRow> = self
            .guests
            .iter()
            .map(|(id, name)| GuestRow {
                id: *id,
                name: shown_name(name, self.joined_at.get(id)),
                joined: self.joined_at.get(id).copied().unwrap_or_else(Instant::now),
                terminals: self
                    .ptys
                    .ids()
                    .iter()
                    .filter(|t| self.ptys.get(**t).is_some_and(|s| s.opened_by == *id))
                    .count(),
            })
            .collect();
        guests.sort_by_key(|g| g.id);
        self.state.guests = guests;

        let openers: HashMap<u32, String> = self
            .ptys
            .ids()
            .iter()
            .filter_map(|id| {
                let by = self.ptys.get(*id)?.opened_by;
                Some((
                    *id,
                    // Never "you": the host opens no terminals here. A guest
                    // who has gone keeps their name on what they started.
                    self.guests
                        .get(&by)
                        .cloned()
                        .or_else(|| self.departed.get(&by).map(|n| format!("{n} (left)")))
                        .unwrap_or_else(|| "someone who left".into()),
                ))
            })
            .collect();
        let sampled = self
            .sampler
            .sample(&self.ptys.roots(), std::mem::take(&mut self.pty_busy));
        self.state.terminals = ui::terminal_rows(&self.ptys.ids(), &openers, &sampled);
    }
}

fn main() -> Result<()> {
    // rustls 0.23 refuses to pick a crypto provider for you. Without this the
    // first `wss://` connection panics inside the TLS handshake — which only
    // ever happens against a real relay, since every test uses plaintext
    // localhost.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // On Linux the agent re-execs itself to confine a pty's shell: Landlock
    // restricts the calling process, so something has to restrict itself and
    // then become the shell. Handled before the runtime starts, because this
    // path ends in `exec` and never returns.
    #[cfg(target_os = "linux")]
    {
        let mut args = std::env::args_os();
        let _ = args.next();
        if args.next().as_deref() == Some(std::ffi::OsStr::new(sandbox::CONFINE_ARG)) {
            return sandbox::linux::confine_and_exec(args.collect());
        }
    }
    // The socket probe: run inside the sandbox by the agent itself, before any
    // link exists, to find out what a guest could actually connect to.
    #[cfg(unix)]
    {
        let mut args = std::env::args_os();
        let _ = args.next();
        if args.next().as_deref() == Some(std::ffi::OsStr::new(sandbox::REACH_ARG)) {
            let reached = args
                .next()
                .is_some_and(|p| std::os::unix::net::UnixStream::connect(p).is_ok());
            std::process::exit(if reached { 0 } else { 1 });
        }
    }
    run()
}

#[tokio::main]
async fn run() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ajar=warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let args = Args::parse();

    // Installed before the link is printed, and before scanning the folder.
    //
    // `ctrl_c()` only registers a handler when its future is first polled, so
    // using it in the select loop leaves a window between "here is your link"
    // and "we can hear ctrl-c" — press it in that window and the agent dies
    // without telling the relay, stranding the session for its whole grace
    // period. A signal stream queues from the moment it is created.
    let (interrupt_tx, mut interrupt) = mpsc::unbounded_channel::<()>();
    #[cfg(unix)]
    {
        use tokio::signal::unix::SignalKind;
        let mut signal = tokio::signal::unix::signal(SignalKind::interrupt())
            .context("installing the interrupt handler")?;
        tokio::spawn(async move {
            let _ = signal.recv().await;
            let _ = interrupt_tx.send(());
        });
    }
    #[cfg(not(unix))]
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = interrupt_tx.send(());
    });

    let verdict = guard::check(&args.path, args.force)?;
    let folder = verdict
        .path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| verdict.path.display().to_string());

    let (workspace, _entries) = open_workspace(&verdict.path, args.force)?;

    // Both of these run before the link is minted, because both are about
    // what the host is agreeing to before anyone can arrive.
    let sandbox = if args.no_sandbox {
        sandbox::Sandbox::open("asked for with --no-sandbox")
    } else {
        sandbox::Sandbox::build(&verdict.path, !args.no_network)
    };
    let caps = limits::Limits::new(args.max_terminals, args.max_processes);
    let mark = checkpoint::create(&verdict.path);
    let found = secrets::scan(&verdict.path, &workspace.filter());
    let withheld = secrets::withheld_env();

    let host_name = args
        .name
        .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "host".into()));
    let session = ids::generate();
    // The key rides in the link's fragment, which a browser never sends to a
    // server. The relay routes frames it cannot read.
    let (cipher, key) = Cipher::generate();
    // The agent seals its own snapshots, so it keeps a copy of the key.
    let cipher_for_host = cipher.clone();
    let lock_state = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let admitted = client::Admitted::default();

    let relay: RelayHandle = client::spawn(
        client::ws_url(&args.relay)?,
        Control::Hello {
            session: session.clone(),
            role: Role::Host,
            locked: false,
            protocol: ajar_proto::PROTOCOL_VERSION,
            code: None,
            // Proves to the relay, on every reconnect, that this is the
            // process that opened the session.
            host_key: Some(ids::host_key()),
            resume: None,
            admitted: Vec::new(),
        },
        cipher,
        lock_state.clone(),
        admitted.clone(),
    );
    let shutdown = relay.shutdown_handle();
    let mut events = relay.events;

    let link = format!("{}#k={key}", client::join_url(&args.relay, &session));
    let (ui, mut actions) = Ui::start()?;
    let mut warnings = verdict.warnings.clone();
    warnings.extend(sandbox.gaps());
    warnings.extend(sandbox.reachable_sockets());
    if !withheld.is_empty() {
        // Names only. The point is that a host whose guest says "the aws cli
        // does not work" knows why, and that nobody reading this over the
        // host's shoulder learns anything.
        const SHOWN: usize = 6;
        let mut names = withheld
            .iter()
            .take(SHOWN)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        if withheld.len() > SHOWN {
            names.push_str(&format!(", and {} more", withheld.len() - SHOWN));
        }
        warnings.push(format!(
            "withheld from guests' shells, because they look like credentials: {names}"
        ));
    }
    if !caps.enforces_processes() {
        // Worth saying out loud rather than leaving to the summary line: the
        // fork bomb this was meant to stop takes the machine down, and a host
        // who thinks it is covered will not think about it again.
        warnings.push(
            "no shell here can cap processes — a guest can fork until this machine stops \
             responding"
                .to_string(),
        );
    }
    if !found.is_empty() {
        warnings.push(format!(
            "{} credential{} in this folder — {}{}",
            found.len(),
            if found.len() == 1 { "" } else { "s" },
            secrets::summarise(&found),
            if sandbox.is_confined() {
                ". Readable by a guest, since they are inside the shared folder"
            } else {
                ". A guest with a terminal can read them; there is no sandbox"
            },
        ));
    }
    match &mark {
        Some(c) if c.had_changes => warnings.push(format!(
            "checkpoint saved, including uncommitted work — undo everything with: {}",
            c.restore_command()
        )),
        Some(c) => warnings.push(format!(
            "checkpoint saved — undo everything with: {}",
            c.restore_command()
        )),
        None => {}
    }
    let mut state = ui::State::new(
        folder.clone(),
        verdict.path.display().to_string(),
        // Files: "18 files shared" used to be ten files and eight folders.
        workspace.file_count(),
        sandbox.summary(),
        sandbox.is_confined(),
        link.clone(),
        warnings.clone(),
    );
    // Held for its lifetime: dropping the watcher stops the notifications,
    // silently, and the tree would just quietly stop updating.
    let (_watcher, mut fs_events) = workspace::watch::spawn(workspace.filter())?;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<PtyOutput>();
    let (exit_tx, mut exit_rx) = mpsc::unbounded_channel::<PtyExit>();
    let (built_tx, mut built_rx) = mpsc::unbounded_channel::<Built>();
    let (worked_tx, mut worked_rx) = mpsc::unbounded_channel::<Worked>();
    state.read_only = args.read_only;
    state.sync = if args.no_sync {
        " · keeping no copy — guests lose the files while you are away".into()
    } else {
        " · a sealed copy will be kept on the relay, so guests can read while you are away".into()
    };
    let mut host = Host {
        ptys: PtyRegistry::new(verdict.path.clone(), &sandbox, caps, withheld),
        workspace,
        docs: Docs::new(),
        sizes: HashMap::new(),
        guests: HashMap::new(),
        host_name: host_name.clone(),
        folder_name: folder.clone(),
        joined_at: HashMap::new(),
        ui,
        state,
        sampler: Sampler::new(),
        copying: false,
        copy_out: None,
        pty_busy: false,
        last_resync: Instant::now() - RESYNC_COOLDOWN,
        syncing: !args.no_sync,
        snapshot_due: Some(Instant::now()),
        synced: None,
        pending_snapshot: None,
        pending_files: 0,
        failing_writes: Default::default(),
        cipher: cipher_for_host,
        resync_pending: false,
        out_tx,
        exit_tx,
        outbound: relay.outbound.clone(),
        lock_state,
        admitted,
        passes: HashMap::new(),
        departed: HashMap::new(),
        downloads: HashMap::new(),
        latest_download: HashMap::new(),
        next_download: 1,
        built_tx,
        uploads: HashMap::new(),
        latest_find: HashMap::new(),
        worked_tx,
    };

    let mut online = false;
    let mut warned_offline = false;
    // Whether the link has ever worked. Once it has, a failed reconnect is a
    // blip in progress, not a link that "will not work" — which is what every
    // ordinary reconnect used to announce.
    let mut ever_online = false;
    // The banner is held until the relay answers. Printed any earlier it
    // announces a link that is refused for the next few hundred milliseconds —
    // invisible over loopback, where the gap is about a millisecond, and
    // reliably wrong over a real network.
    let mut banner_shown = false;
    // But a relay that never answers must not leave the terminal blank, so the
    // banner goes out regardless after this, saying whatever is actually true.
    let banner_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    // Why the relay cannot be reached, when that is known before the banner
    // is out: printed first, it sat above twenty lines ending in a link that
    // looked ready to send, where nobody reads.
    let mut held_warning: Option<String> = None;
    // Whether anything can still arrive from the keyboard. Without a terminal
    // nothing ever will, and a closed channel answers every poll at once —
    // the loop spun a whole core for as long as the session was open.
    let mut keys_open = true;
    // Drives deferred rebuilds: without it, a burst that ends during the
    // cooldown would leave the tree stale until something else changed.
    let mut resync_tick = tokio::time::interval(Duration::from_millis(250));
    let mut sample_tick = tokio::time::interval(SAMPLE_INTERVAL);
    host.refresh_panel();
    host.ui.draw(&host.state)?;

    loop {
        // When the next open document is to be written: woken for exactly
        // then, where until 20 November a tick four times a second looked —
        // a quarter of a second more, at worst, on every edit's way to the
        // disk. A write that is failing is tried again on that tick instead,
        // not as fast as the loop can turn.
        let write_due = host
            .docs
            .next_write()
            .filter(|_| host.failing_writes.is_empty());
        tokio::select! {
            _ = async { tokio::time::sleep_until(write_due.expect("guarded").into()).await }, if write_due.is_some() => {
                flush_documents(&mut host);
            }
            _ = tokio::time::sleep_until(banner_deadline), if !banner_shown && !host.ui.is_panel() => {
                banner(&host.state, &caps);
                banner_shown = true;
                if let Some(warning) = held_warning.take() {
                    host.log(warning);
                }
            }
            event = events.recv() => {
                let Some(event) = event else { break };
                match event {
                    RelayEvent::Connected { resumed, participants } => {
                        let first = !ever_online;
                        online = true;
                        ever_online = true;
                        warned_offline = false;
                        held_warning = None;
                        host.state.status = Status::Online;
                        if !host.ui.is_panel() {
                            if !banner_shown {
                                banner(&host.state, &caps);
                                banner_shown = true;
                            } else if first {
                                // The deadline below already printed a banner
                                // saying the link did not work yet. It does now.
                                host.log("the relay answered — the link works now");
                            }
                        }
                        if !first && !resumed {
                            host.log("reconnected — guests' pages rejoin by themselves");
                            // A relay that let the session go — or restarted —
                            // has no copy of the folder any more. It is offered
                            // again rather than left claimed on the panel.
                            if host.syncing {
                                host.synced = None;
                                host.snapshot_due = Some(Instant::now());
                                update_sync_line(&mut host);
                            }
                        }
                        // Before anything is resent: who is actually here. Joins
                        // and leaves during the gap were announced to nobody.
                        reconcile(&participants, &mut host)?;
                        if resumed {
                            host.log("reconnected — guests kept their session");
                            resend_after_gap(&mut host)?;
                        }
                        // A shell started now, for whoever opens the first
                        // terminal: at its prompt by the time they join,
                        // where they used to wait for it to start. Last, with
                        // the link printed and working: started any sooner,
                        // counting what the host is running — which its
                        // process limit is set from — put a twentieth of a
                        // second on the way to the link. Not in a session
                        // that begins read-only, where nobody may open one.
                        if first && !host.state.read_only {
                            host.ptys.warm(host.out_tx.clone(), host.exit_tx.clone());
                        }
                    }
                    RelayEvent::Disconnected(why) => {
                        // A copy part way to the relay went with the socket:
                        // the relay has forgotten what it had of it, and it
                        // is made and offered again.
                        if host.copy_out.take().is_some() {
                            host.snapshot_due = Some(Instant::now());
                        }
                        if online {
                            debug!("relay connection lost: {why}");
                            host.log("lost the relay — reconnecting; terminals keep running");
                        } else if !warned_offline && !ever_online {
                            // Never connected at all. Without this the agent
                            // prints a link and sits there looking healthy
                            // while nothing can reach it — which is exactly
                            // how a missing TLS feature stayed hidden.
                            warned_offline = true;
                            let warning = format!(
                                "cannot reach the relay ({why}) — the link will not work until this clears"
                            );
                            if banner_shown || host.ui.is_panel() {
                                host.log(warning);
                            } else {
                                held_warning = Some(warning);
                            }
                        }
                        // "reconnecting" would be a claim we had ever been
                        // connected. On the first attempt we have not.
                        host.state.status = if online {
                            Status::Reconnecting
                        } else {
                            Status::Connecting
                        };
                        online = false;
                    }
                    RelayEvent::Refused(why) => {
                        eprintln!("\n  relay refused the session: {why}\n");
                        return Ok(());
                    }
                    RelayEvent::Frame(frame) => handle_frame(frame, &mut host)?,
                }
            }
            built = built_rx.recv() => {
                if let Some(built) = built {
                    on_built(built, &mut host);
                }
            }
            worked = worked_rx.recv() => {
                if let Some(worked) = worked {
                    on_worked(worked, &mut host);
                }
            }
            output = out_rx.recv() => {
                let Some(PtyOutput { pty_id, mut bytes }) = output else { break };
                // A program printing fast is read eight kilobytes at a time,
                // and each read was a frame: sealed, sent and drawn by
                // itself. What is already waiting from the same terminal goes
                // with it, up to a frame of sixty-four.
                let mut next = None;
                while bytes.len() < PTY_FRAME {
                    match out_rx.try_recv() {
                        Ok(more) if more.pty_id == pty_id => bytes.extend_from_slice(&more.bytes),
                        Ok(other) => {
                            next = Some(other);
                            break;
                        }
                        Err(_) => break,
                    }
                }
                for PtyOutput { pty_id, bytes } in [Some(PtyOutput { pty_id, bytes }), next].into_iter().flatten() {
                    // Not what a shell says as it dies, after its terminal
                    // was closed and everyone told so: bytes for a terminal
                    // nobody has.
                    if host.ptys.get(pty_id).is_some() {
                        host.pty_busy = true;
                        let _ = host.outbound.send(Frame::stream(Channel::Pty, pty_id, TARGET_ALL, bytes));
                    }
                }
            }
            _ = resync_tick.tick() => {
                flush_resync(&mut host);
                flush_documents(&mut host);
                flush_snapshot(&mut host);
            }
            _ = sample_tick.tick() => {
                host.refresh_panel();
                host.ui.draw(&host.state)?;
            }
            action = actions.recv(), if keys_open => {
                let Some(action) = action else {
                    keys_open = false;
                    continue;
                };
                match host.state.kick_step(&action) {
                    KickStep::Chosen(id) => {
                        // Out for good, past a relay restart too.
                        if let Some(hash) = host.passes.remove(&id) {
                            if let Ok(mut set) = host.admitted.lock() {
                                set.remove(&hash);
                            }
                        }
                        if let Some(name) = host.guests.get(&id).cloned() {
                            let _ = host.outbound.send(Frame::json(
                                Channel::Control,
                                TARGET_ALL,
                                &Control::Kick { participant_id: id },
                            )?);
                            host.log(format!("kicked {name}"));
                        } else {
                            host.log(format!("nobody here is {id}"));
                        }
                        host.ui.draw(&host.state)?;
                        continue;
                    }
                    KickStep::Pending => {
                        host.ui.draw(&host.state)?;
                        continue;
                    }
                    KickStep::Ignored => {}
                }
                match action {
                    Action::Quit => {
                        host.state.status = Status::Closing;
                        host.ui.draw(&host.state)?;
                        break;
                    }
                    // Only ever meaningful inside "kick which one?".
                    Action::Kick | Action::Digit(_) | Action::Confirm | Action::Erase => {}
                    Action::ToggleLock => {
                        let locked = !host.state.locked;
                        host.state.locked = locked;
                        host.lock_state.store(locked, std::sync::atomic::Ordering::SeqCst);
                        // The relay enforces this: it is the only thing that
                        // sees a connection before the host does.
                        let _ = host.outbound.send(Frame::json(
                            Channel::Control,
                            TARGET_ALL,
                            &Control::Lock { locked },
                        )?);
                        host.log(if locked {
                            "locked — nobody new can join"
                        } else {
                            "unlocked — the link works again"
                        });
                    }
                    Action::ToggleSync => {
                        host.syncing = !host.syncing;
                        if host.syncing {
                            host.snapshot_due = Some(Instant::now());
                            host.log("keeping a copy again");
                        } else {
                            host.synced = None;
                            host.pending_snapshot = None;
                            host.copy_out = None;
                            // Tell the relay to forget what it has.
                            let _ = host.outbound.send(Frame::json(
                                Channel::Store,
                                TARGET_ALL,
                                &Store::Empty,
                            )?);
                            host.log("stopped keeping a copy — the relay was told to forget it");
                        }
                        update_sync_line(&mut host);
                    }
                    Action::ToggleReadOnly => {
                        let read_only = !host.state.read_only;
                        host.state.read_only = read_only;
                        // Enforced here rather than in the client: a guest who
                        // ignores the flag still gets their keystrokes dropped.
                        let _ = host.outbound.send(Frame::json(
                            Channel::Pty,
                            TARGET_ALL,
                            &Pty::ReadOnly { read_only },
                        )?);
                        host.log(if read_only {
                            "read-only — guests can watch, not type or edit"
                        } else {
                            "guests can type and edit again"
                        });
                    }
                    Action::CopyLink => {
                        // OSC 52: the terminal puts it on the clipboard, if it
                        // allows that — iTerm2, kitty, WezTerm, Windows
                        // Terminal and tmux do; Terminal.app does not.
                        use base64::Engine;
                        use std::io::Write;
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&host.state.link);
                        let mut out = std::io::stdout();
                        let _ = write!(out, "\x1b]52;c;{encoded}\x07");
                        let _ = out.flush();
                        host.log("link sent to the clipboard — if nothing pasted, this terminal does not allow it; select it above instead");
                    }
                    Action::Redraw => {}
                }
                host.ui.draw(&host.state)?;
            }
            fs_event = fs_events.recv() => {
                let Some(fs_event) = fs_event else { break };
                on_fs_event(fs_event, &mut host);
            }
            exit = exit_rx.recv() => {
                let Some(PtyExit { pty_id }) = exit else { break };
                // A terminal a guest closed is gone from the list already and
                // was said to be closed then; the shell kept ready was never
                // anyone's. Only one that ended by itself is news.
                if host.ptys.exited(pty_id) {
                    let _ = host.outbound.send(Frame::json(
                        Channel::Pty,
                        TARGET_ALL,
                        &Pty::Closed { pty_id, exit_code: 0 },
                    )?);
                    host.log(format!("terminal {pty_id} closed"));
                }
            }
            _ = interrupt.recv() => {
                host.state.status = Status::Closing;
                host.log("closing — every terminal ends and the link stops working");
                break;
            }
        }
    }

    // The debounce timer will never tick again. Persist every CRDT change
    // before telling the relay and guests that the session is gone.
    flush_all_documents(&mut host);

    // Tell the relay this is deliberate, so it tears the session down now
    // instead of holding it open for a reconnect that is not coming.
    let _ = host
        .outbound
        .send(Frame::json(Channel::Control, TARGET_ALL, &Control::Close)?);
    shutdown.trigger();
    tokio::time::sleep(Duration::from_millis(120)).await;

    host.ui.restore();
    println!("\n  closed {} — the link no longer works.", host.state.link);
    farewell(&verdict.path, mark.as_ref());
    Ok(())
}

fn handle_frame(frame: Frame, host: &mut Host) -> Result<()> {
    // Remote input is untrusted even after decryption. A malformed JSON
    // control frame is one bad message, not a reason to unwind the agent's
    // event loop and terminate the host session.
    if frame.channel == Channel::Control {
        if let Err(e) = frame.parse_json::<Control>() {
            debug!("dropping malformed control frame: {e}");
            return Ok(());
        }
    }
    if frame.channel == Channel::Pty && frame.stream_id == STREAM_CONTROL {
        if let Err(e) = frame.parse_json::<Pty>() {
            debug!("dropping malformed pty control frame: {e}");
            return Ok(());
        }
    }
    if frame.channel == Channel::Doc && frame.stream_id == STREAM_CONTROL {
        if let Err(e) = frame.parse_json::<DocMsg>() {
            debug!("dropping malformed document control frame: {e}");
            return Ok(());
        }
    }
    match frame.channel {
        Channel::Control => match frame.parse_json::<Control>()? {
            Control::Joined { participant } => on_join(&participant, host)?,
            Control::Left { participant_id } => {
                forget(participant_id, host);
                broadcast_roster(host)?;
                reflow(host);
            }
            Control::Closed { reason } => host.log(format!("session closed: {reason}")),
            other => debug!("ignoring control message: {other:?}"),
        },

        // stream_id 0 on the pty channel is JSON; anything else is raw
        // terminal input for that pty.
        Channel::Pty if frame.stream_id == STREAM_CONTROL => match frame.parse_json::<Pty>()? {
            Pty::Open { cols, rows } => {
                let asker = frame.target;
                // A shell nobody here may type into is a process for nothing.
                let allowed = if host.state.read_only {
                    Err("the host has made this session read-only".to_string())
                } else {
                    host.ptys.may_open()
                };
                if let Err(reason) = allowed {
                    host.outbound.send(Frame::json(
                        Channel::Pty,
                        asker,
                        &Pty::Refused {
                            reason: reason.clone(),
                        },
                    )?)?;
                    host.log(format!("refused a terminal — {reason}"));
                    return Ok(());
                }
                host.sizes.insert(asker, (cols, rows));
                let (id, printed) =
                    host.ptys
                        .open(cols, rows, asker, host.out_tx.clone(), host.exit_tx.clone())?;
                host.outbound.send(Frame::json(
                    Channel::Pty,
                    TARGET_ALL,
                    &Pty::Opened {
                        pty_id: id,
                        cols,
                        rows,
                        opened_by: asker,
                    },
                )?)?;
                // The shell that was kept ready has its prompt up already:
                // sent with the news of the terminal, as a late guest is sent
                // what a terminal has printed.
                if !printed.is_empty() {
                    host.outbound
                        .send(Frame::stream(Channel::Pty, id, TARGET_ALL, printed))?;
                }
                let who = host
                    .guests
                    .get(&asker)
                    .cloned()
                    .unwrap_or_else(|| "someone".into());
                host.log(format!("{who} opened terminal {id}"));
            }
            Pty::Resize { cols, rows, .. } => {
                host.sizes.insert(frame.target, (cols, rows));
                reflow(host);
            }
            Pty::Close { pty_id } => {
                // Read-only is watching: it stops a guest's keys, and so it
                // stops this too. No page offered it until 0.0.9, and a
                // guest who sent it anyway ended a terminal they could not
                // type in.
                if host.state.read_only {
                    return Ok(());
                }
                let who = host
                    .guests
                    .get(&frame.target)
                    .cloned()
                    .unwrap_or_else(|| "someone".into());
                host.log(format!("{who} closed terminal {pty_id}"));
                host.ptys.remove(pty_id);
                host.outbound.send(Frame::json(
                    Channel::Pty,
                    TARGET_ALL,
                    &Pty::Closed {
                        pty_id,
                        exit_code: 0,
                    },
                )?)?;
            }
            other => debug!("ignoring pty message: {other:?}"),
        },

        Channel::Pty => {
            if host.state.read_only {
                return Ok(());
            }
            // Enter, in a terminal: whatever it runs reads the files as they
            // are on disk, and what was typed into one a moment ago may not
            // be there yet. Written first — someone who edits a file and runs
            // it at once runs what they see, not what was there before.
            if frame.payload.iter().any(|b| matches!(b, b'\r' | b'\n')) {
                flush_all_documents(host);
            }
            host.pty_busy = true;
            if let Some(session) = host.ptys.get_mut(frame.stream_id) {
                if let Err(e) = session.write(&frame.payload) {
                    warn!("write to pty {} failed: {e}", frame.stream_id);
                }
            }
        }

        // stream 0 is JSON; anything else is bytes of an upload a guest was
        // told would be taken.
        Channel::Fs if frame.stream_id != STREAM_CONTROL => on_upload_bytes(frame, host),

        Channel::Fs => match frame.parse_json::<Fs>() {
            Ok(
                op @ (Fs::Make { .. }
                | Fs::Rename { .. }
                | Fs::Remove { .. }
                | Fs::Put { .. }
                | Fs::Find { .. }
                | Fs::Replace { .. }
                | Fs::Bytes { .. }),
            ) => on_file_op(op, frame.target, host),
            Ok(Fs::Read { path }) => {
                let content = host.workspace.read(&path);
                host.outbound
                    .send(Frame::json(Channel::Fs, frame.target, &content)?)?;
            }
            Ok(Fs::Download { path }) => start_download(path, frame.target, host),
            Ok(Fs::Received { id, received }) => {
                let key = (frame.target, id);
                let done = host
                    .downloads
                    .get_mut(&key)
                    .map(|t| {
                        t.acked = t.acked.max(received);
                        t.acked >= t.data.len() as u64
                    })
                    .unwrap_or(false);
                if done {
                    host.downloads.remove(&key);
                } else {
                    pump(key, host);
                }
            }
            _ => {}
        },

        // stream 0 is JSON; anything else is bytes belonging to that document.
        Channel::Doc if frame.stream_id == STREAM_CONTROL => match frame.parse_json::<DocMsg>()? {
            DocMsg::Open { path } => on_doc_open(&path, frame.target, host)?,
            DocMsg::Close { doc_id } => {
                if let Some((path, contents)) = host.docs.close(doc_id, frame.target) {
                    write_last(&path, &contents, host);
                }
            }
            other => debug!("ignoring doc message: {other:?}"),
        },

        Channel::Doc => {
            let Some((kind, body)) = DocKind::split(&frame.payload) else {
                debug!("doc frame with no kind tag");
                return Ok(());
            };
            match kind {
                DocKind::Update => {
                    // Read-only covers the files as well as the terminals.
                    // It used to stop at keystrokes: a guest's edit to an
                    // open file was applied, passed on to everyone and
                    // written to disk regardless. Dropped here, at the one
                    // place every edit passes, so a client that ignores the
                    // flag gains nothing — the same rule as the terminals.
                    if host.state.read_only {
                        return Ok(());
                    }
                    if let Err(e) = host.docs.apply(frame.stream_id, body) {
                        warn!("update for document {} rejected: {e}", frame.stream_id);
                        return Ok(());
                    }
                }
                // Cursors and selections. Never applied here, never written
                // to disk — the host is only a hub for them.
                DocKind::Awareness => {}
            }
            // Forwarded verbatim. Yjs updates are idempotent, so echoing one
            // back to its sender costs a little bandwidth and nothing else,
            // which is cheaper than addressing every guest individually.
            let _ = host.outbound.send(Frame::stream(
                Channel::Doc,
                frame.stream_id,
                TARGET_ALL,
                frame.payload,
            ));
        }

        Channel::Store => match frame.parse_json::<Store>() {
            Ok(Store::Accepted { parts }) => {
                if let Some(pending) = host.pending_snapshot.take() {
                    if parts {
                        // A piece at a time, each acknowledged, so that what
                        // else is sent meanwhile — a key's echo, an edit — is
                        // never behind more than a window of it.
                        host.copy_out = Some(CopyOut {
                            blob: pending,
                            sent: 0,
                        });
                        send_copy(0, host);
                    } else {
                        // A relay from before pieces: whole, in one frame.
                        let bytes = pending.len() as u64;
                        host.outbound.send(Frame::stream(
                            Channel::Store,
                            SNAPSHOT_STREAM,
                            TARGET_ALL,
                            pending,
                        ))?;
                        host.synced = Some((bytes, host.pending_files));
                        update_sync_line(host);
                    }
                }
            }
            Ok(Store::Got { received }) => send_copy(received, host),
            Ok(Store::Rejected { reason }) => {
                // Loudly, and then stop trying: a copy that is quietly
                // missing files is worse than no copy at all.
                host.pending_snapshot = None;
                host.copy_out = None;
                host.syncing = false;
                host.synced = None;
                host.log(format!("not keeping a copy — {reason}"));
                update_sync_line(host);
            }
            _ => {}
        },

        // Guests report where they're looking and who they are; we stamp the
        // sender and pass it on, because the relay knows neither.
        Channel::Presence => match frame.parse_json::<Presence>() {
            Ok(Presence::Report { active_pty }) => {
                host.outbound.send(Frame::json(
                    Channel::Presence,
                    TARGET_ALL,
                    &Presence::Update {
                        participant_id: frame.target,
                        active_pty,
                    },
                )?)?;
            }
            Ok(Presence::Iam { name, resume }) => {
                let name = name.chars().take(32).collect::<String>();
                // Vouched for to a restarted relay, so that a locked session
                // does not shut this guest out when they come back to it.
                if let Some(resume) = resume.filter(|r| r.len() <= 128) {
                    use sha2::{Digest, Sha256};
                    let hash: String = Sha256::digest(resume.as_bytes())
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect();
                    if let Ok(mut set) = host.admitted.lock() {
                        if set.len() < 1024 {
                            set.insert(hash.clone());
                        }
                    }
                    host.passes.insert(frame.target, hash);
                }
                // A guest re-introduces itself whenever the host comes back,
                // because an introduction made during the gap went nowhere.
                // Only a new name is news.
                let previous = host.guests.insert(frame.target, name.clone());
                if previous.as_deref() != Some(name.as_str()) {
                    host.log(format!("{name} joined"));
                }
                broadcast_roster(host)?;
            }
            _ => {}
        },
    }
    Ok(())
}

/// Someone wants to edit a file. Text only: a binary or truncated file has
/// no sensible collaborative representation, and pretending otherwise would
/// silently corrupt it on the next write-back.
fn on_doc_open(path: &str, reader: u32, host: &mut Host) -> Result<()> {
    let refuse = |host: &Host, message: &str| -> Result<()> {
        host.outbound.send(Frame::json(
            Channel::Doc,
            reader,
            &DocMsg::Error {
                path: path.to_string(),
                message: message.to_string(),
            },
        )?)?;
        Ok(())
    };

    if let Err(why) = host.docs.may_open(path, reader) {
        return refuse(host, why);
    }
    // Asked of a file already open too: someone else's copy of it may be
    // fine, and this one have changed since.
    let contents = match host.workspace.editable(path) {
        Ok(text) => text,
        Err(why) => return refuse(host, &why),
    };

    let (doc_id, state) = host.docs.open(path, &contents, reader);
    host.outbound.send(Frame::json(
        Channel::Doc,
        reader,
        &DocMsg::Opened {
            doc_id,
            path: path.to_string(),
        },
    )?)?;
    host.outbound.send(Frame::stream(
        Channel::Doc,
        doc_id,
        reader,
        DocKind::Update.frame(&state),
    ))?;
    host.log(format!("{path} opened for editing"));
    Ok(())
}

/// The panel's one line about what is being kept, and how to stop.
fn update_sync_line(host: &mut Host) {
    host.state.sync = match (host.syncing, host.synced) {
        (false, _) => " · keeping no copy — guests lose the files while you are away".into(),
        (true, Some((bytes, files))) => format!(
            " · keeping a sealed copy on the relay, {} in {files} files, so guests can read while you are away",
            crate::usage::human_bytes(bytes)
        ),
        (true, None) => " · a sealed copy will be kept on the relay, so guests can read while you are away".into(),
    };
}

/// Offer a fresh copy of the folder, if one is owed.
///
/// Sealed here, before it leaves — the relay stores bytes it cannot read.
fn flush_snapshot(host: &mut Host) {
    if !host.syncing {
        return;
    }
    let Some(due) = host.snapshot_due else { return };
    if due.elapsed() < SNAPSHOT_AFTER {
        return;
    }
    // One at a time: what changes while this one is being made is in the
    // next, which stays due.
    if host.copying {
        return;
    }
    let Fs::Tree { entries } = host.workspace.tree() else {
        return;
    };
    host.snapshot_due = None;
    host.copying = true;

    // Every text file read, written out as one and sealed: off the loop. It
    // was done here until 20 November, five seconds after each change — and
    // for as long as that took, a few hundredths of a second for a small
    // project and whole seconds for a large one, no terminal echoed a key
    // and no edit moved.
    let filter = host.workspace.filter();
    let cipher = host.cipher.clone();
    let tx = host.worked_tx.clone();
    tokio::task::spawn_blocking(move || {
        let mut body = SnapshotBody::default();
        for entry in entries {
            if entry.kind != ajar_proto::EntryKind::File {
                continue;
            }
            // Binary and oversized files are already refused everywhere else;
            // there is no reason to carry them here either.
            if let Fs::Content {
                text,
                binary: false,
                truncated: false,
                ..
            } = Workspace::read_with(&filter, &entry.path)
            {
                body.files.push(SnapshotFile {
                    path: entry.path,
                    text,
                });
            }
        }
        let files = body.files.len() as u32;
        let sealed = serde_json::to_vec(&body)
            .ok()
            .map(|plain| cipher.seal(&plain));
        let _ = tx.send(Worked::Copied { sealed, files });
    });
}

/// The folder's copy on its way to the relay, a piece at a time.
struct CopyOut {
    blob: Vec<u8>,
    sent: usize,
}

/// Send more of the copy: up to a window past what the relay says it has
/// (`received`), and say it is kept once it has all of it.
fn send_copy(received: u64, host: &mut Host) {
    let Some(copy) = host.copy_out.as_mut() else {
        return;
    };
    let received = (received as usize).min(copy.sent);
    while copy.sent < copy.blob.len() && copy.sent - received < ajar_proto::COPY_WINDOW {
        let end = (copy.sent + ajar_proto::COPY_PART).min(copy.blob.len());
        let _ = host.outbound.send(Frame::stream(
            Channel::Store,
            SNAPSHOT_STREAM,
            TARGET_ALL,
            copy.blob[copy.sent..end].to_vec(),
        ));
        copy.sent = end;
    }
    if received == copy.blob.len() {
        host.synced = Some((received as u64, host.pending_files));
        host.copy_out = None;
        update_sync_line(host);
    }
}

/// Tell everyone who is here. Only the host can: the relay has no names.
fn broadcast_roster(host: &Host) -> Result<()> {
    let mut people = vec![Person {
        id: 1,
        name: host.host_name.clone(),
        role: Role::Host,
    }];
    let mut guests: Vec<(&u32, &String)> = host.guests.iter().collect();
    guests.sort_by_key(|(id, _)| **id);
    people.extend(guests.into_iter().map(|(id, name)| Person {
        id: *id,
        name: name.clone(),
        role: Role::Guest,
    }));

    host.outbound.send(Frame::json(
        Channel::Presence,
        TARGET_ALL,
        &Presence::Roster {
            workspace: host.folder_name.clone(),
            people,
            can: CAN.iter().map(|c| c.to_string()).collect(),
        },
    )?)?;
    Ok(())
}

/// Why an open document was not saved.
enum Unsaved {
    /// Its file is gone, or no longer something editing can write: the
    /// document has to end.
    NotEditable(String),
    /// The write itself failed, and may work next time.
    Failed(std::io::Error),
}

/// Write a document back to the file it came from.
fn write_back(path: &str, contents: &str, host: &mut Host) -> Result<(), Unsaved> {
    // An open document may have changed underneath us since it was admitted.
    // Never replace a now-binary or over-limit file with the stale editable
    // prefix the CRDT was originally seeded from.
    host.workspace
        .editable(path)
        .map_err(Unsaved::NotEditable)?;
    let filter = host.workspace.filter();
    // `resolve` rather than `resolve_unchecked`: it canonicalises, so a
    // symlink planted where the document used to be cannot redirect the write
    // out of the workspace.
    let abs = filter
        .resolve(path)
        .ok_or_else(|| Unsaved::NotEditable("deleted or moved".into()))?;
    atomic_write(&abs, filter.root(), contents.as_bytes()).map_err(Unsaved::Failed)
}

/// Write a document nobody has open any more, saying so if that fails.
fn write_last(path: &str, contents: &str, host: &mut Host) {
    match write_back(path, contents, host) {
        Ok(()) => {}
        Err(Unsaved::NotEditable(why)) => {
            host.log(format!("{path}: {why} — the last edits were not saved"))
        }
        Err(Unsaved::Failed(e)) => {
            warn!("could not write {path}: {e}");
            host.log(format!("could not write {path}: {e}"));
        }
    }
}

/// Replace the directory entry rather than opening it for writing. If a
/// sandboxed process swaps the file for a symlink, persistence replaces that
/// symlink itself and never follows it to an outside target.
fn atomic_write(
    path: &std::path::Path,
    workspace: &std::path::Path,
    contents: &[u8],
) -> std::io::Result<()> {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    let trusted_root = workspace.canonicalize()?;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("document has no parent directory"))?
        .canonicalize()?;
    if !parent.starts_with(&trusted_root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "document parent escaped the workspace",
        ));
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("document has no file name"))?;
    let destination = parent.join(file_name);
    let permissions = std::fs::metadata(path)?.permissions();
    for _ in 0..100 {
        let n = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(".ajar-write-{}-{n}", std::process::id()));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        if !temp
            .canonicalize()
            .is_ok_and(|real| real.starts_with(&trusted_root))
        {
            drop(file);
            let _ = std::fs::remove_file(&temp);
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "temporary document escaped the workspace",
            ));
        }
        let written = file
            .write_all(contents)
            .and_then(|()| file.sync_all())
            .and_then(|()| file.set_permissions(permissions.clone()));
        drop(file);
        if let Err(e) = written {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
        if !matches!(parent.canonicalize(), Ok(ref real) if real == &parent) {
            let _ = std::fs::remove_file(&temp);
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "document parent changed during write-back",
            ));
        }
        // Unix rename atomically replaces the entry. Windows requires
        // removing it first; remove_file deletes a symlink itself.
        #[cfg(windows)]
        match std::fs::remove_file(&destination) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                let _ = std::fs::remove_file(&temp);
                return Err(e);
            }
        }
        let result = std::fs::rename(&temp, &destination);
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        return result;
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a temporary document path",
    ))
}

/// Fold changes that happened on disk into any document that is open on them.
///
/// Most calls here do nothing: the usual reason a watched file changed is
/// that we wrote it ourselves a moment ago.
fn reconcile_docs(paths: &[String], host: &mut Host) {
    for path in paths {
        let Some(doc_id) = host.docs.id_for_path(path) else {
            continue;
        };
        let text = match host.workspace.editable(path) {
            Ok(text) => text,
            // Deleted, moved, binary, grown past the limit: there is no file
            // left to save into, so the document ends here, for everyone,
            // with the reason. It used to stay open and editable, and every
            // keystroke went nowhere while the log said so four times a
            // second.
            Err(why) => {
                close_doc(doc_id, &why, host);
                continue;
            }
        };
        if let Some(update) = host.docs.reconcile(doc_id, &text) {
            let _ = host.outbound.send(Frame::stream(
                Channel::Doc,
                doc_id,
                TARGET_ALL,
                DocKind::Update.frame(&update),
            ));
            host.log(format!("{path} changed on disk"));
        }
    }
}

/// Write back every document that has stopped changing.
fn flush_documents(host: &mut Host) {
    for (id, path, contents) in host.docs.due_for_write(Instant::now()) {
        save(id, &path, &contents, host);
    }
}

fn flush_all_documents(host: &mut Host) {
    for (id, path, contents) in host.docs.pending_writes() {
        save(id, &path, &contents, host);
    }
}

/// Write one open document, and close it if its file is no longer there to
/// write to. A failure that may pass — a full disk — is retried next tick,
/// and said once rather than on every one of them.
fn save(id: u32, path: &str, contents: &str, host: &mut Host) {
    match write_back(path, contents, host) {
        Ok(()) => {
            host.docs.mark_written(id, contents);
            host.failing_writes.remove(&id);
        }
        Err(Unsaved::NotEditable(why)) => close_doc(id, &why, host),
        Err(Unsaved::Failed(e)) => {
            if host.failing_writes.insert(id) {
                warn!("could not write {path}: {e}");
                host.log(format!("could not write {path}: {e} — will keep trying"));
            }
        }
    }
}

/// End a document for everyone who has it open, saying why.
fn close_doc(id: u32, why: &str, host: &mut Host) {
    let Some((path, _readers)) = host.docs.remove(id) else {
        return;
    };
    host.failing_writes.remove(&id);
    if let Ok(frame) = Frame::json(
        Channel::Doc,
        TARGET_ALL,
        &DocMsg::Closed {
            doc_id: id,
            reason: why.to_string(),
        },
    ) {
        let _ = host.outbound.send(frame);
    }
    host.log(format!("{path}: {why} — closed for editing"));
}

/// Someone is gone: their name, their window size, and their hold on any
/// document, which is written back if they were its last reader.
fn forget(participant_id: u32, host: &mut Host) {
    let who = host
        .guests
        .remove(&participant_id)
        .unwrap_or_else(|| "someone".into());
    host.sizes.remove(&participant_id);
    host.joined_at.remove(&participant_id);
    if who != "…" && who != "someone" {
        host.departed.insert(participant_id, who.clone());
    }
    // Their secret stays vouched for: leaving looks exactly like a blip.
    host.passes.remove(&participant_id);
    host.downloads.retain(|(to, _), _| *to != participant_id);
    host.latest_download.remove(&participant_id);
    host.uploads.retain(|(from, _), _| *from != participant_id);
    host.latest_find.remove(&participant_id);
    for (path, contents) in host.docs.drop_reader(participant_id) {
        write_last(&path, &contents, host);
    }
    host.log(format!("{who} left"));
}

/// Make what we believe about the room match what the relay says is in it.
///
/// While the host is disconnected the relay still admits and loses guests, and
/// tells a host that is not there. Without this, someone who left during a gap
/// stayed in the panel for good — and so did their window size, shrinking every
/// terminal to fit a screen nobody was looking at — and someone who arrived got
/// no tree and no name. After a relay restart every id is new, so every old
/// entry is gone and nobody is resent anything twice.
fn reconcile(participants: &[Participant], host: &mut Host) -> Result<()> {
    let here: std::collections::HashSet<u32> = participants
        .iter()
        .filter(|p| p.role == Role::Guest)
        .map(|p| p.id)
        .collect();
    let mut gone: Vec<u32> = host
        .guests
        .keys()
        .chain(host.sizes.keys())
        .copied()
        .chain(host.docs.readers())
        .filter(|id| !here.contains(id))
        .collect();
    gone.sort_unstable();
    gone.dedup();
    let changed = !gone.is_empty();
    for id in gone {
        forget(id, host);
    }
    for p in participants {
        if p.role == Role::Guest && !host.guests.contains_key(&p.id) {
            on_join(p, host)?;
        }
    }
    if changed {
        broadcast_roster(host)?;
        reflow(host);
    }
    Ok(())
}

/// Everything guests would have been sent while we were away.
///
/// Frames are dropped rather than queued during a disconnect, which is right
/// for terminal output — the ring buffers replay it — and was wrong for
/// everything else: a patch for a file made during the gap, a document update
/// from the disk changing underneath an editor, were simply gone, and the
/// guests carried on confidently out of step. None of these is incremental, so
/// sending each whole again is both simple and complete.
fn resend_after_gap(host: &mut Host) -> Result<()> {
    let tree = host.workspace.tree();
    send_fs(host, &tree);
    announce_ptys(TARGET_ALL, &host.ptys, &host.outbound);
    send_read_only(TARGET_ALL, host)?;
    for (doc_id, state) in host.docs.states() {
        host.outbound.send(Frame::stream(
            Channel::Doc,
            doc_id,
            TARGET_ALL,
            DocKind::Update.frame(&state),
        ))?;
    }
    broadcast_roster(host)?;
    Ok(())
}

/// Someone connected. The relay does not know their name, so at this point
/// neither do we — it arrives separately, encrypted, as `Presence::Iam`.
fn on_join(participant: &Participant, host: &mut Host) -> Result<()> {
    host.joined_at.insert(participant.id, Instant::now());
    host.guests
        .entry(participant.id)
        .or_insert_with(|| "…".into());
    host.outbound.send(Frame::json(
        Channel::Fs,
        participant.id,
        &host.workspace.tree(),
    )?)?;
    announce_ptys(participant.id, &host.ptys, &host.outbound);
    send_read_only(participant.id, host)?;
    broadcast_roster(host)?;
    Ok(())
}

/// Tell someone whether the terminals take their typing.
///
/// Sent on arrival and after a gap, not only when the host toggles it. It used
/// to be only the toggle, so a guest joining a `--read-only` session was never
/// told: no badge, and every keystroke dropped at the host without a word. The
/// check that should have caught it compared an array's length with zero.
/// Always the current state, either way, since a toggle made during a gap was
/// lost like everything else.
fn send_read_only(target: u32, host: &Host) -> Result<()> {
    host.outbound.send(Frame::json(
        Channel::Pty,
        target,
        &Pty::ReadOnly {
            read_only: host.state.read_only,
        },
    )?)?;
    Ok(())
}

/// A batch of filesystem change, already coalesced by the watcher.
fn on_fs_event(event: FsEvent, host: &mut Host) {
    match event {
        FsEvent::Touched(paths) => {
            // File contents can change while size and tree metadata stay the
            // same. Such edits still invalidate the stored snapshot.
            host.snapshot_due = Some(Instant::now());
            if let Some(patch) = host.workspace.apply(&paths) {
                send_fs(host, &patch);
            }
            reconcile_docs(&paths, host);
        }
        FsEvent::Resync => {
            // More moved than is worth describing. A sustained install trips
            // this on every flush and a full tree is not cheap, so the
            // rebuild is rate-limited — but *deferred*, never dropped. A
            // dropped resync would leave the tree permanently stale once the
            // burst ends and no further events arrive.
            host.resync_pending = true;
            flush_resync(host);
        }
    }
}

/// Rebuild and broadcast the tree, if one is owed and the cooldown has passed.
fn flush_resync(host: &mut Host) {
    if !host.resync_pending || host.last_resync.elapsed() < RESYNC_COOLDOWN {
        return;
    }
    host.resync_pending = false;
    host.last_resync = Instant::now();
    match host.workspace.rescan(MAX_ENTRIES) {
        Ok(report) => {
            debug!("resynced to {} entries", report.count);
            let tree = host.workspace.tree();
            send_fs(host, &tree);
            host.snapshot_due = Some(Instant::now());
        }
        Err(e) => warn!("rescan failed: {e}"),
    }
}

fn send_fs(host: &mut Host, message: &Fs) {
    host.state.files = host.workspace.file_count();
    if let Ok(frame) = Frame::json(Channel::Fs, TARGET_ALL, message) {
        let _ = host.outbound.send(frame);
    }
}

/// Scans the folder and enforces the entry limit, which needs the real
/// ignore rules and so cannot live with the path guardrails.
fn open_workspace(path: &Path, force: bool) -> Result<(Workspace, usize)> {
    let (workspace, report) = Workspace::scan(path, MAX_ENTRIES)?;
    if report.truncated && !force {
        bail!(
            "{} has more than {MAX_ENTRIES} files once ignore rules are applied.\n\
             That is past what the tree can render usefully, and usually means \
             something generated is missing from .gitignore.\n\
             Re-run with --force if you are certain.",
            path.display()
        );
    }
    Ok((workspace, report.count))
}

/// Send every live terminal, each followed by its ring buffer, so whoever
/// receives this walks into a session already in progress.
fn announce_ptys(target: u32, ptys: &PtyRegistry, outbound: &mpsc::UnboundedSender<Frame>) {
    for id in ptys.ids() {
        let Some(session) = ptys.get(id) else {
            continue;
        };
        let Ok(opened) = Frame::json(
            Channel::Pty,
            target,
            &Pty::Opened {
                pty_id: id,
                cols: session.cols,
                rows: session.rows,
                opened_by: session.opened_by,
            },
        ) else {
            continue;
        };
        let _ = outbound.send(opened);
        let replay = session.replay();
        if !replay.is_empty() {
            let _ = outbound.send(Frame::stream(Channel::Pty, id, target, replay));
        }
    }
}

/// Apply the smallest attached window size to every terminal.
fn reflow(host: &mut Host) {
    let Some((cols, rows)) = host
        .sizes
        .values()
        .copied()
        .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1)))
    else {
        return;
    };
    if cols == 0 || rows == 0 {
        return;
    }
    for id in host.ptys.ids() {
        let Some(session) = host.ptys.get_mut(id) else {
            continue;
        };
        if session.cols == cols && session.rows == rows {
            continue;
        }
        if let Err(e) = session.resize(cols, rows) {
            warn!("resize of pty {id} failed: {e}");
            continue;
        }
        if let Ok(f) = Frame::json(
            Channel::Pty,
            TARGET_ALL,
            &Pty::Resize {
                pty_id: id,
                cols,
                rows,
            },
        ) {
            let _ = host.outbound.send(f);
        }
    }
}

/// What changed while the door was open, and how to put it back.
fn farewell(root: &Path, mark: Option<&checkpoint::Checkpoint>) {
    let Some(mark) = mark else { return };
    let changed = checkpoint::changed_since(root, mark);
    if changed.is_empty() {
        println!("  nothing in the folder changed.\n");
        return;
    }
    let shown: Vec<&str> = changed.iter().take(5).map(|s| s.as_str()).collect();
    println!(
        "\n  {} file{} changed: {}{}",
        changed.len(),
        if changed.len() == 1 { "" } else { "s" },
        shown.join(", "),
        if changed.len() > 5 {
            format!(", and {} more", changed.len() - 5)
        } else {
            String::new()
        }
    );
    println!("  to undo everything from before the session:");
    println!("      {}\n", mark.restore_command());
}

/// The plain-mode equivalent of the panel, for when stdout is piped.
///
/// Reads from the same `State` the panel draws rather than taking the same
/// eight values a second time — two renderings of one set of facts is how
/// they end up disagreeing.
/// A download being sent, a window at a time.
struct Transfer {
    data: Vec<u8>,
    sent: usize,
    acked: u64,
}

/// A download built off the loop, coming back to be sent.
struct Built {
    target: u32,
    id: u32,
    path: String,
    result: Result<archive::Download, String>,
}

/// How far ahead of what the guest has acknowledged a download runs. The
/// relay closes a guest whose queue grows past 8 MB, and a download sent all
/// at once to someone on a slow link did exactly that.
const DOWNLOAD_WINDOW: usize = 1024 * 1024;
const DOWNLOAD_CHUNK: usize = 128 * 1024;

/// A guest asked for a file, a folder or everything. Reading and zipping
/// happen off the loop: a large folder takes long enough to freeze every
/// terminal while it is read.
fn start_download(path: String, target: u32, host: &mut Host) {
    // One at a time per guest; asking again replaces the last — whether it
    // is being sent or still being built, which `on_built` checks.
    host.downloads.retain(|(to, _), _| *to != target);
    let id = host.next_download;
    host.next_download = host.next_download.wrapping_add(1).max(1);
    host.latest_download.insert(target, id);
    let entries = host.workspace.under(&path);
    let filter = host.workspace.filter();
    let folder = host.state.folder.clone();
    let tx = host.built_tx.clone();
    tokio::task::spawn_blocking(move || {
        let result = if entries.is_empty() {
            Err(format!("{path} is not in the shared folder"))
        } else {
            archive::build(&filter, &folder, &path, &entries)
        };
        let _ = tx.send(Built {
            target,
            id,
            path,
            result,
        });
    });
}

fn on_built(built: Built, host: &mut Host) {
    let Built {
        target,
        id,
        path,
        result,
    } = built;
    // Asked for again, or gone, while this was being read: the guest no
    // longer wants it, and two arriving would save two files.
    if host.latest_download.get(&target) != Some(&id) {
        return;
    }
    let download = match result {
        Ok(download) => download,
        Err(message) => {
            if let Ok(f) = Frame::json(Channel::Fs, target, &Fs::DownloadError { path, message }) {
                let _ = host.outbound.send(f);
            }
            return;
        }
    };
    let who = host
        .guests
        .get(&target)
        .cloned()
        .unwrap_or_else(|| "someone".into());
    host.log(format!(
        "{who} downloaded {} ({})",
        download.name,
        crate::usage::human_bytes(download.bytes.len() as u64)
    ));
    if let Ok(f) = Frame::json(
        Channel::Fs,
        target,
        &Fs::Archive {
            id,
            path,
            name: download.name,
            bytes: download.bytes.len() as u64,
            files: download.files,
        },
    ) {
        let _ = host.outbound.send(f);
    }
    host.downloads.insert(
        (target, id),
        Transfer {
            data: download.bytes,
            sent: 0,
            acked: 0,
        },
    );
    pump((target, id), host);
}

/// Send as much of a download as the window allows.
fn pump(key: (u32, u32), host: &mut Host) {
    let Some(transfer) = host.downloads.get_mut(&key) else {
        return;
    };
    while transfer.sent < transfer.data.len()
        && transfer.sent as u64 - transfer.acked.min(transfer.sent as u64) < DOWNLOAD_WINDOW as u64
    {
        let end = (transfer.sent + DOWNLOAD_CHUNK).min(transfer.data.len());
        let chunk = transfer.data[transfer.sent..end].to_vec();
        let _ = host
            .outbound
            .send(Frame::stream(Channel::Fs, key.1, key.0, chunk));
        transfer.sent = end;
    }
}

// ------------------------------------------------- a guest's file operations

/// What this agent does for a guest's page beyond reading, said in the
/// roster so a page offers it — and offers none of it to an agent that says
/// nothing, which is every one before 0.0.9.
const CAN: [&str; 3] = ["write", "search", "bytes"];

/// A file on its way in from a guest: held until it is whole, then written.
struct Upload {
    path: String,
    replace: bool,
    expected: u64,
    data: Vec<u8>,
    /// How much the guest has been told arrived.
    acked: u64,
}

/// How much of an upload arrives between acknowledgements. The page sends a
/// megabyte ahead of the last one and waits.
const UPLOAD_ACK_EVERY: u64 = 256 * 1024;

/// A search or a replace, run off the loop and come back.
enum Worked {
    Found {
        target: u32,
        id: u32,
        groups: Vec<ajar_proto::FoundFile>,
        truncated: bool,
    },
    Replaced {
        target: u32,
        id: u32,
        paths: Vec<String>,
        done: fileops::Replaced,
    },
    /// The folder's copy for the relay, sealed; none if it could not be made.
    Copied { sealed: Option<Vec<u8>>, files: u32 },
}

/// The answer to a guest's request: how it ended, in words they can be shown.
fn answer(host: &Host, target: u32, id: u32, result: Result<String, String>) {
    let (ok, message) = match result {
        Ok(message) => (true, message),
        Err(message) => (false, message),
    };
    if let Ok(f) = Frame::json(Channel::Fs, target, &Fs::Done { id, ok, message }) {
        let _ = host.outbound.send(f);
    }
}

fn name_of(host: &Host, guest: u32) -> String {
    host.guests
        .get(&guest)
        .cloned()
        .unwrap_or_else(|| "someone".into())
}

/// The tree, and any document open on these paths, told now rather than
/// when the watcher gets to it: a file made from the page is in the page's
/// tree as the answer arrives.
fn touched(paths: Vec<String>, host: &mut Host) {
    on_fs_event(FsEvent::Touched(paths), host);
}

/// `rel` and every folder on the way to it.
fn with_parents(rel: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(slash) = rel[at..].find('/') {
        out.push(rel[..at + slash].to_string());
        at += slash + 1;
    }
    out.push(rel.to_string());
    out
}

/// What a guest's page asked to be done to the folder. Each is the agent
/// acting on a guest's word, outside any sandbox: `fileops` holds every path
/// to the folder and to what the tree shows, and this to what the host
/// allows — nothing that changes anything while the session is read-only.
fn on_file_op(op: Fs, guest: u32, host: &mut Host) {
    const READ_ONLY: &str = "the host has made this session read-only";
    let filter = host.workspace.filter();
    let who = name_of(host, guest);
    match op {
        Fs::Make { id, path, dir } => {
            if host.state.read_only {
                return answer(host, guest, id, Err(READ_ONLY.into()));
            }
            let result = fileops::make(&filter, &path, dir);
            if result.is_ok() {
                host.log(format!(
                    "{who} made {} {path}",
                    if dir { "the folder" } else { "the file" }
                ));
                touched(with_parents(&path), host);
            }
            answer(host, guest, id, result.map(|()| String::new()));
        }
        Fs::Rename {
            id,
            from,
            to,
            replace,
        } => {
            if host.state.read_only {
                return answer(host, guest, id, Err(READ_ONLY.into()));
            }
            // What is typed and not yet on disk goes to disk first, under
            // the old name, so it moves with the file.
            let open = host.docs.paths_under(&from);
            for (doc, path, contents) in host.docs.pending_writes() {
                if open.contains(&path) {
                    save(doc, &path, &contents, host);
                }
            }
            let result = fileops::rename(&filter, &from, &to, replace);
            if result.is_ok() && from != to {
                host.log(format!("{who} moved {from} to {to}"));
                // Every page's tabs on it follow it, before the tree's patch
                // closes the documents under the old name.
                if let Ok(f) = Frame::json(
                    Channel::Fs,
                    TARGET_ALL,
                    &Fs::Moved {
                        from: from.clone(),
                        to: to.clone(),
                    },
                ) {
                    let _ = host.outbound.send(f);
                }
                let mut paths = with_parents(&to);
                paths.push(from);
                paths.extend(open);
                touched(paths, host);
            }
            answer(host, guest, id, result.map(|()| String::new()));
        }
        Fs::Remove { id, path } => {
            if host.state.read_only {
                return answer(host, guest, id, Err(READ_ONLY.into()));
            }
            let open = host.docs.paths_under(&path);
            let result = fileops::remove(&filter, &path);
            if let Ok(was_dir) = result {
                host.log(format!(
                    "{who} deleted {}{path}",
                    if was_dir { "the folder " } else { "" }
                ));
                let mut paths = vec![path];
                paths.extend(open);
                touched(paths, host);
            }
            answer(host, guest, id, result.map(|_| String::new()));
        }
        Fs::Put {
            id,
            path,
            bytes,
            replace,
        } => {
            if host.state.read_only {
                return answer(host, guest, id, Err(READ_ONLY.into()));
            }
            if bytes > ajar_proto::UPLOAD_MAX_BYTES {
                return answer(
                    host,
                    guest,
                    id,
                    Err(format!(
                        "it is {}, and one upload is at most {}",
                        crate::usage::human_bytes(bytes),
                        crate::usage::human_bytes(ajar_proto::UPLOAD_MAX_BYTES)
                    )),
                );
            }
            if let Err(why) = fileops::may_put(&filter, &path, replace) {
                return answer(host, guest, id, Err(why));
            }
            // One at a time from each guest: a second replaces the first.
            host.uploads.retain(|(from, _), _| *from != guest);
            let upload = Upload {
                path,
                replace,
                expected: bytes,
                data: Vec::new(),
                acked: 0,
            };
            if bytes == 0 {
                return finish_upload(guest, id, upload, host);
            }
            host.uploads.insert((guest, id), upload);
            if let Ok(f) = Frame::json(Channel::Fs, guest, &Fs::Taking { id }) {
                let _ = host.outbound.send(f);
            }
        }
        Fs::Find {
            id,
            query,
            folder,
            match_case,
            whole_word,
        } => {
            // Read off the loop: a large folder takes long enough to freeze
            // every terminal while it is searched.
            host.latest_find.insert(guest, id);
            let entries = host.workspace.under("");
            let tx = host.worked_tx.clone();
            tokio::task::spawn_blocking(move || {
                let options = fileops::FindOptions {
                    query,
                    folder,
                    match_case,
                    whole_word,
                };
                let (groups, truncated) = fileops::find(&filter, &entries, &options);
                let _ = tx.send(Worked::Found {
                    target: guest,
                    id,
                    groups,
                    truncated,
                });
            });
        }
        Fs::Replace {
            id,
            query,
            match_case,
            whole_word,
            replacement,
            files,
        } => {
            if host.state.read_only {
                return answer(host, guest, id, Err(READ_ONLY.into()));
            }
            // What is typed into any of them and not yet on disk goes to
            // disk first: the guest's preview was of the file on disk, and a
            // file written over typing would lose it.
            let wanted: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
            for (doc, path, contents) in host.docs.pending_writes() {
                if wanted.contains(&path) {
                    save(doc, &path, &contents, host);
                }
            }
            let tx = host.worked_tx.clone();
            tokio::task::spawn_blocking(move || {
                let options = fileops::FindOptions {
                    query,
                    folder: String::new(),
                    match_case,
                    whole_word,
                };
                let done = fileops::replace(&filter, &options, &replacement, &files);
                let _ = tx.send(Worked::Replaced {
                    target: guest,
                    id,
                    paths: wanted,
                    done,
                });
            });
        }
        Fs::Bytes { id, path } => match fileops::view(&filter, &path) {
            Ok(bytes) => {
                host.log(format!(
                    "{who} looked at {path} ({})",
                    crate::usage::human_bytes(bytes.len() as u64)
                ));
                let stream = host.next_download;
                host.next_download = host.next_download.wrapping_add(1).max(1);
                if let Ok(f) = Frame::json(
                    Channel::Fs,
                    guest,
                    &Fs::Sight {
                        id,
                        stream,
                        path,
                        bytes: bytes.len() as u64,
                    },
                ) {
                    let _ = host.outbound.send(f);
                }
                // In one go: it is under the relay's bound on what it queues
                // for one guest, and the page asks for one at a time.
                for chunk in bytes.chunks(DOWNLOAD_CHUNK) {
                    let _ = host.outbound.send(Frame::stream(
                        Channel::Fs,
                        stream,
                        guest,
                        chunk.to_vec(),
                    ));
                }
            }
            Err(why) => answer(host, guest, id, Err(why)),
        },
        _ => {}
    }
}

/// Bytes of an upload. Acknowledged as they come, so the page sends no more
/// than a window ahead; past what was announced, the upload is dropped.
fn on_upload_bytes(frame: Frame, host: &mut Host) {
    let key = (frame.target, frame.stream_id);
    // Made read-only while it was on its way: it stops here.
    if host.state.read_only {
        if host.uploads.remove(&key).is_some() {
            answer(
                host,
                key.0,
                key.1,
                Err("the host has made this session read-only".into()),
            );
        }
        return;
    }
    let Some(upload) = host.uploads.get_mut(&key) else {
        return;
    };
    upload.data.extend_from_slice(&frame.payload);
    let received = upload.data.len() as u64;
    if received > upload.expected {
        host.uploads.remove(&key);
        return answer(
            host,
            key.0,
            key.1,
            Err("more arrived than was announced".into()),
        );
    }
    if received == upload.expected {
        let Some(upload) = host.uploads.remove(&key) else {
            return;
        };
        return finish_upload(key.0, key.1, upload, host);
    }
    if received - upload.acked >= UPLOAD_ACK_EVERY {
        upload.acked = received;
        if let Ok(f) = Frame::json(
            Channel::Fs,
            key.0,
            &Fs::Got {
                id: key.1,
                received,
            },
        ) {
            let _ = host.outbound.send(f);
        }
    }
}

/// An upload whole: written, said, and answered.
fn finish_upload(guest: u32, id: u32, upload: Upload, host: &mut Host) {
    let filter = host.workspace.filter();
    let result = fileops::put(&filter, &upload.path, &upload.data, upload.replace);
    if result.is_ok() {
        let who = name_of(host, guest);
        host.log(format!(
            "{who} uploaded {} ({})",
            upload.path,
            crate::usage::human_bytes(upload.data.len() as u64)
        ));
        touched(with_parents(&upload.path), host);
    }
    answer(host, guest, id, result.map(|()| String::new()));
}

fn on_worked(worked: Worked, host: &mut Host) {
    match worked {
        Worked::Copied { sealed, files } => {
            host.copying = false;
            // Switched off while it was being made: not offered.
            let (true, Some(sealed)) = (host.syncing, sealed) else {
                return;
            };
            let bytes = sealed.len() as u64;
            host.pending_snapshot = Some(sealed);
            host.pending_files = files;
            // One being sent is overtaken: no more of it goes, and the
            // relay forgets what it had of it when it takes this offer.
            host.copy_out = None;
            let offer = Store::Offer {
                bytes,
                files,
                parts: true,
            };
            if let Ok(f) = Frame::json(Channel::Store, TARGET_ALL, &offer) {
                let _ = host.outbound.send(f);
            }
        }
        Worked::Found {
            target,
            id,
            groups,
            truncated,
        } => {
            // Asked again, or gone, while this was being read.
            if host.latest_find.get(&target) != Some(&id) {
                return;
            }
            if let Ok(f) = Frame::json(
                Channel::Fs,
                target,
                &Fs::Found {
                    id,
                    groups,
                    truncated,
                },
            ) {
                let _ = host.outbound.send(f);
            }
        }
        Worked::Replaced {
            target,
            id,
            paths,
            done,
        } => {
            let who = name_of(host, target);
            let count = |n: usize, one: &str, many: &str| {
                format!("{n} {}", if n == 1 { one } else { many })
            };
            let mut said = format!(
                "{} in {}",
                count(done.replacements, "replacement", "replacements"),
                count(done.files, "file", "files")
            );
            if done.files > 0 {
                host.log(format!("{who} made {said}"));
                // The open ones take it as they take any change on disk.
                touched(paths, host);
            }
            if !done.skipped.is_empty() {
                said.push_str(&format!(". Left alone: {}", done.skipped.join("; ")));
            }
            let result = if done.files > 0 || done.skipped.is_empty() {
                Ok(format!("{said}."))
            } else {
                Err(format!(
                    "nothing was changed. Left alone: {}",
                    done.skipped.join("; ")
                ))
            };
            answer(host, target, id, result);
        }
    }
}

/// A guest's name as the host should read it. "…" is someone who has not
/// said who they are; a few seconds on, they are not going to — their page
/// cannot read the session, which is a link cut short.
fn shown_name(name: &str, joined: Option<&Instant>) -> String {
    if name == "…" && joined.is_some_and(|t| t.elapsed() > Duration::from_secs(5)) {
        "someone with an incomplete link".into()
    } else {
        name.to_string()
    }
}

fn banner(state: &ui::State, caps: &limits::Limits) {
    println!();
    println!("{}", guard::notice(state.confined));
    println!();
    for w in &state.warnings {
        println!("  !  {w}");
    }
    if !state.warnings.is_empty() {
        println!();
    }
    println!(
        "  \u{25cf}  {}  {}  ({})",
        state.status.label(),
        state.folder,
        state.path
    );
    println!(
        "     {} {} shared",
        state.files,
        if state.files == 1 { "file" } else { "files" }
    );
    println!("     {}", state.sandbox);
    println!("     {}", caps.summary());
    // Said before the link, because "a copy of your source is being kept" is
    // not something to find out about afterwards.
    println!("     {}", state.sync.trim_start_matches([' ', '\u{b7}']));
    println!();
    println!("     {}", state.link);
    println!();
    println!("     ctrl-c to close");
    println!();
}

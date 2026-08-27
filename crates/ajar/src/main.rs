//! ajar — leave a machine open to someone.
//!
//! v0: shared terminals over a link. No sandbox, no editing, no persistence.
//! See the build spec for what that deliberately leaves out and why.

mod checkpoint;
mod client;
mod docs;
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
use anyhow::{bail, Context, Result};
use clap::Parser;
use tokio::signal::unix::SignalKind;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::client::{RelayEvent, RelayHandle};
use crate::docs::Docs;
use crate::pty::{PtyExit, PtyOutput, PtyRegistry};
use crate::ui::{Action, GuestRow, Status, Ui};
use crate::usage::Sampler;
use crate::workspace::{FsEvent, Workspace, MAX_ENTRIES};

/// A sustained install trips the resync threshold over and over. A full
/// tree is not cheap, so rebuild at most this often.
const RESYNC_COOLDOWN: Duration = Duration::from_secs(1);

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
    #[arg(long, default_value = "http://127.0.0.1:8787", env = "AJAR_RELAY")]
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

    /// Start with terminals read-only: guests watch, only the host types.
    /// What a lecture or a demo wants. Toggle it later with `l`.
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
    cipher: Cipher,
    /// A rebuild is owed but the cooldown has not passed.
    resync_pending: bool,
    out_tx: mpsc::UnboundedSender<PtyOutput>,
    exit_tx: mpsc::UnboundedSender<PtyExit>,
    outbound: mpsc::UnboundedSender<Frame>,
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
                name: name.clone(),
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
                    self.guests
                        .get(&by)
                        .cloned()
                        .unwrap_or_else(|| "you".into()),
                ))
            })
            .collect();
        let sampled = self.sampler.sample(&self.ptys.roots());
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
    let mut interrupt = tokio::signal::unix::signal(SignalKind::interrupt())
        .context("installing the interrupt handler")?;

    let verdict = guard::check(&args.path, args.force)?;
    let folder = verdict
        .path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| verdict.path.display().to_string());

    let (workspace, scan) = open_workspace(&verdict.path, args.force)?;

    // Both of these run before the link is minted, because both are about
    // what the host is agreeing to before anyone can arrive.
    let sandbox = if args.no_sandbox {
        sandbox::Sandbox::open("asked for with --no-sandbox")
    } else {
        sandbox::Sandbox::build(&verdict.path, !args.no_network)
    };
    let caps = limits::Limits {
        terminals: args.max_terminals,
        processes: args.max_processes,
    };
    let mark = checkpoint::create(&verdict.path);
    let found = secrets::scan(&verdict.path, &workspace.filter());

    let host_name = args
        .name
        .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "host".into()));
    let session = ids::generate();
    // The key rides in the link's fragment, which a browser never sends to a
    // server. The relay routes frames it cannot read.
    let (cipher, key) = Cipher::generate();
    // The agent seals its own snapshots, so it keeps a copy of the key.
    let cipher_for_host = cipher.clone();

    let relay: RelayHandle = client::spawn(
        client::ws_url(&args.relay)?,
        Control::Hello {
            session: session.clone(),
            role: Role::Host,
        },
        cipher,
    );
    let shutdown = relay.shutdown_handle();
    let mut events = relay.events;

    let link = format!("{}#k={key}", client::join_url(&args.relay, &session));
    let (ui, mut actions) = Ui::start()?;
    let mut warnings = verdict.warnings.clone();
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
        scan,
        sandbox.summary(),
        sandbox.is_confined(),
        link.clone(),
        warnings.clone(),
    );
    if !ui.is_panel() {
        banner(&state, &caps);
    }

    // Held for its lifetime: dropping the watcher stops the notifications,
    // silently, and the tree would just quietly stop updating.
    let (_watcher, mut fs_events) = workspace::watch::spawn(workspace.filter())?;

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<PtyOutput>();
    let (exit_tx, mut exit_rx) = mpsc::unbounded_channel::<PtyExit>();
    state.read_only = args.read_only;
    state.sync = if args.no_sync {
        " · keeping no copy".into()
    } else {
        " · copy pending".into()
    };
    let mut host = Host {
        ptys: PtyRegistry::new(verdict.path.clone(), &sandbox, caps),
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
        last_resync: Instant::now() - RESYNC_COOLDOWN,
        syncing: !args.no_sync,
        snapshot_due: Some(Instant::now()),
        synced: None,
        pending_snapshot: None,
        pending_files: 0,
        cipher: cipher_for_host,
        resync_pending: false,
        out_tx,
        exit_tx,
        outbound: relay.outbound.clone(),
    };

    let mut online = false;
    let mut warned_offline = false;
    // Drives deferred rebuilds: without it, a burst that ends during the
    // cooldown would leave the tree stale until something else changed.
    let mut resync_tick = tokio::time::interval(Duration::from_millis(250));
    let mut sample_tick = tokio::time::interval(SAMPLE_INTERVAL);
    host.refresh_panel();
    host.ui.draw(&host.state)?;

    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else { break };
                match event {
                    RelayEvent::Connected { resumed } => {
                        online = true;
                        warned_offline = false;
                        host.state.status = Status::Online;
                        if resumed {
                            host.log("reconnected — guests kept their session");
                            // Guests missed whatever we produced while we were
                            // away. Re-announce every terminal and replay it.
                            announce_ptys(TARGET_ALL, &host.ptys, &host.outbound);
                        }
                    }
                    RelayEvent::Disconnected(why) => {
                        if online {
                            host.log(format!("connection lost ({why}) — terminals keep running"));
                        } else if !warned_offline {
                            // Never connected at all. Without this the agent
                            // prints a link and sits there looking healthy
                            // while nothing can reach it — which is exactly
                            // how a missing TLS feature stayed hidden.
                            warned_offline = true;
                            host.log(format!(
                                "cannot reach the relay ({why}) — the link will not work until this clears"
                            ));
                        }
                        online = false;
                        host.state.status = Status::Reconnecting;
                    }
                    RelayEvent::Refused(why) => {
                        eprintln!("\n  relay refused the session: {why}\n");
                        return Ok(());
                    }
                    RelayEvent::Frame(frame) => handle_frame(frame, &mut host)?,
                }
            }
            output = out_rx.recv() => {
                let Some(PtyOutput { pty_id, bytes }) = output else { break };
                let _ = host.outbound.send(Frame::stream(Channel::Pty, pty_id, TARGET_ALL, bytes));
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
            action = actions.recv() => {
                let Some(action) = action else { continue };
                match action {
                    Action::Quit => {
                        host.state.status = Status::Closing;
                        host.ui.draw(&host.state)?;
                        break;
                    }
                    Action::Kick(0) => {
                        // First press: ask which one, rather than guessing.
                        host.state.kicking = true;
                    }
                    Action::Kick(id) => {
                        if host.state.kicking {
                            host.state.kicking = false;
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
                        }
                    }
                    Action::ToggleLock => {
                        let locked = !host.state.locked;
                        host.state.locked = locked;
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
                            "terminals are read-only — guests can watch"
                        } else {
                            "terminals accept input again"
                        });
                    }
                    Action::Redraw => host.state.kicking = false,
                }
                host.ui.draw(&host.state)?;
            }
            fs_event = fs_events.recv() => {
                let Some(fs_event) = fs_event else { break };
                on_fs_event(fs_event, &mut host);
            }
            exit = exit_rx.recv() => {
                let Some(PtyExit { pty_id }) = exit else { break };
                host.ptys.remove(pty_id);
                let _ = host.outbound.send(Frame::json(
                    Channel::Pty,
                    TARGET_ALL,
                    &Pty::Closed { pty_id, exit_code: 0 },
                )?);
                host.log(format!("terminal {pty_id} closed"));
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
    match frame.channel {
        Channel::Control => match frame.parse_json::<Control>()? {
            Control::Joined { participant } => on_join(&participant, host)?,
            Control::Left { participant_id } => {
                let who = host
                    .guests
                    .remove(&participant_id)
                    .unwrap_or_else(|| "someone".into());
                host.sizes.remove(&participant_id);
                host.joined_at.remove(&participant_id);
                broadcast_roster(host)?;
                for (path, contents) in host.docs.drop_reader(participant_id) {
                    write_back(&path, &contents, host);
                }
                host.log(format!("{who} left"));
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
                if let Err(reason) = host.ptys.may_open() {
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
                let id =
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
            if let Some(session) = host.ptys.get_mut(frame.stream_id) {
                if let Err(e) = session.write(&frame.payload) {
                    warn!("write to pty {} failed: {e}", frame.stream_id);
                }
            }
        }

        Channel::Fs => {
            if let Ok(Fs::Read { path }) = frame.parse_json::<Fs>() {
                let content = host.workspace.read(&path);
                host.outbound
                    .send(Frame::json(Channel::Fs, frame.target, &content)?)?;
            }
        }

        // stream 0 is JSON; anything else is bytes belonging to that document.
        Channel::Doc if frame.stream_id == STREAM_CONTROL => match frame.parse_json::<DocMsg>()? {
            DocMsg::Open { path } => on_doc_open(&path, frame.target, host)?,
            DocMsg::Close { doc_id } => {
                if let Some((path, contents)) = host.docs.close(doc_id, frame.target) {
                    write_back(&path, &contents, host);
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
            Ok(Store::Accepted) => {
                if let Some(pending) = host.pending_snapshot.take() {
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
            Ok(Store::Rejected { reason }) => {
                // Loudly, and then stop trying: a copy that is quietly
                // missing files is worse than no copy at all.
                host.pending_snapshot = None;
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
            Ok(Presence::Iam { name }) => {
                let name = name.chars().take(32).collect::<String>();
                host.log(format!("{name} joined"));
                host.guests.insert(frame.target, name);
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

    let contents = match host.workspace.read(path) {
        Fs::Content { binary: true, .. } => return refuse(host, "binary file"),
        Fs::Content {
            truncated: true, ..
        } => return refuse(host, "too large to edit — over 1 MB"),
        Fs::Content { text, .. } => text,
        Fs::ReadError { message, .. } => return refuse(host, &message),
        _ => return refuse(host, "not a file"),
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
        (false, _) => " · keeping no copy".into(),
        (true, Some((bytes, files))) => format!(
            " · keeping {} of {files} files so guests can read while you are away  [d] stop",
            crate::usage::human_bytes(bytes)
        ),
        (true, None) => " · copy pending".into(),
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
    host.snapshot_due = None;

    let mut body = SnapshotBody::default();
    for entry in match host.workspace.tree() {
        Fs::Tree { entries } => entries,
        _ => return,
    } {
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
        } = host.workspace.read(&entry.path)
        {
            body.files.push(SnapshotFile {
                path: entry.path,
                text,
            });
        }
    }

    let files = body.files.len() as u32;
    let Ok(plain) = serde_json::to_vec(&body) else {
        return;
    };
    let sealed = host.cipher.seal(&plain);
    let bytes = sealed.len() as u64;

    host.pending_snapshot = Some(sealed);
    host.pending_files = files;
    if let Ok(f) = Frame::json(Channel::Store, TARGET_ALL, &Store::Offer { bytes, files }) {
        let _ = host.outbound.send(f);
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
        },
    )?)?;
    Ok(())
}

/// Write a document back to the file it came from.
fn write_back(path: &str, contents: &str, host: &mut Host) {
    let filter = host.workspace.filter();
    let Some(abs) = filter.resolve(path) else {
        return;
    };
    if let Err(e) = atomic_write(&abs, filter.root(), contents.as_bytes()) {
        warn!("could not write {path}: {e}");
        host.log(format!("could not write {path}: {e}"));
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
        let Fs::Content {
            text,
            binary: false,
            ..
        } = host.workspace.read(path)
        else {
            continue;
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
    for (_, path, contents) in host.docs.due_for_write(Instant::now()) {
        write_back(&path, &contents, host);
    }
}

fn flush_all_documents(host: &mut Host) {
    for (_, path, contents) in host.docs.pending_writes() {
        write_back(&path, &contents, host);
    }
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
    broadcast_roster(host)?;
    Ok(())
}

/// A batch of filesystem change, already coalesced by the watcher.
fn on_fs_event(event: FsEvent, host: &mut Host) {
    match event {
        FsEvent::Touched(paths) => {
            if let Some(patch) = host.workspace.apply(&paths) {
                send_fs(host, &patch);
                host.snapshot_due = Some(Instant::now());
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

fn send_fs(host: &Host, message: &Fs) {
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
    let changed = checkpoint::changed_since(root);
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
    println!("  \u{25cf}  open  {}  ({})", state.folder, state.path);
    println!("     {} files shared", state.files);
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

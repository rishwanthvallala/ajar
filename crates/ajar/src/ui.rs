//! The host's control panel.
//!
//! The command does not return — it becomes a live view of who is connected,
//! what they are running and what it is costing. This is where "I feel safe
//! lending my machine" is won or lost, so it shows the uncomfortable things
//! as prominently as the reassuring ones.
//!
//! When stdout is not a terminal — piped, redirected, under a test — the
//! panel degrades to plain lines. Nobody wants ANSI in a log file.

use std::collections::HashMap;
use std::io::{self, IsTerminal, Stdout};
use std::time::{Duration, Instant};

use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, Paragraph, Row, Table, Wrap};
use tokio::sync::mpsc::{self, UnboundedReceiver};

use crate::usage::{human_bytes, Usage};

/// How many recent lines the activity pane keeps.
const ACTIVITY_LINES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Connecting,
    Online,
    Reconnecting,
    Closing,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Status::Connecting => "connecting",
            Status::Online => "open",
            Status::Reconnecting => "reconnecting",
            Status::Closing => "closing",
        }
    }

    fn colour(self) -> Color {
        match self {
            Status::Online => Color::Green,
            Status::Connecting | Status::Reconnecting => Color::Yellow,
            Status::Closing => Color::Red,
        }
    }
}

pub struct GuestRow {
    pub id: u32,
    pub name: String,
    pub joined: Instant,
    pub terminals: usize,
}

pub struct TerminalRow {
    pub id: u32,
    pub opened_by: String,
    pub usage: Usage,
}

/// Everything the panel draws. The agent owns it and mutates it directly.
pub struct State {
    pub folder: String,
    pub path: String,
    pub files: usize,
    /// What the sandbox is enforcing, in one line.
    pub sandbox: String,
    pub confined: bool,
    /// Sealed: no new guests.
    pub locked: bool,
    /// Guests can watch the terminals but not type.
    pub read_only: bool,
    /// What is being kept on the relay so guests can read while you are away.
    pub sync: String,
    pub link: String,
    pub status: Status,
    pub warnings: Vec<String>,
    pub guests: Vec<GuestRow>,
    pub terminals: Vec<TerminalRow>,
    activity: Vec<String>,
    /// Set while awaiting a digit for "kick which one?".
    pub kicking: bool,
}

impl State {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        folder: String,
        path: String,
        files: usize,
        sandbox: String,
        confined: bool,
        link: String,
        warnings: Vec<String>,
    ) -> Self {
        Self {
            folder,
            path,
            files,
            sandbox,
            confined,
            locked: false,
            read_only: false,
            sync: String::new(),
            link,
            status: Status::Connecting,
            warnings,
            guests: Vec::new(),
            terminals: Vec::new(),
            activity: Vec::new(),
            kicking: false,
        }
    }

    pub fn log(&mut self, line: impl Into<String>) {
        self.activity.push(line.into());
        if self.activity.len() > ACTIVITY_LINES {
            self.activity.remove(0);
        }
    }
}

/// What the panel asks the agent to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Quit,
    Kick(u32),
    /// Seal the room: nobody new gets in.
    ToggleLock,
    /// Guests can watch the terminals but not type into them.
    ToggleReadOnly,
    /// Stop or resume keeping a copy on the relay.
    ToggleSync,
    Redraw,
}

pub enum Ui {
    /// stdout is a terminal: take it over.
    Panel {
        terminal: Terminal<CrosstermBackend<Stdout>>,
        /// Teardown has already run. `restore` is called both explicitly on
        /// the way out and again from `Drop`, and doing it twice would leave
        /// the alternate screen in a strange state.
        restored: bool,
    },
    /// Piped or redirected: emit plain lines instead.
    Plain,
}

impl Ui {
    pub fn start() -> Result<(Self, UnboundedReceiver<Action>)> {
        let (tx, rx) = mpsc::unbounded_channel();

        if !io::stdout().is_terminal() {
            return Ok((Ui::Plain, rx));
        }

        enable_raw_mode()?;
        let mut out = io::stdout();
        execute!(out, EnterAlternateScreen)?;
        let terminal = Terminal::new(CrosstermBackend::new(out))?;

        // Blocking key reads on their own thread. The panel is the only
        // reader, so there is no contention to reason about.
        std::thread::Builder::new()
            .name("ajar-keys".into())
            .spawn(move || loop {
                match event::poll(Duration::from_millis(150)) {
                    Ok(true) => {
                        if let Ok(Event::Key(key)) = event::read() {
                            if let Some(action) = interpret(key) {
                                if tx.send(action).is_err() {
                                    return;
                                }
                            }
                        } else if tx.send(Action::Redraw).is_err() {
                            // A resize; redraw and carry on.
                            return;
                        }
                    }
                    Ok(false) => {}
                    Err(_) => return,
                }
            })?;

        Ok((
            Ui::Panel {
                terminal,
                restored: false,
            },
            rx,
        ))
    }

    pub fn is_panel(&self) -> bool {
        matches!(self, Ui::Panel { .. })
    }

    /// Emit a line. In plain mode this is the whole interface.
    pub fn log(&mut self, state: &mut State, line: impl Into<String>) {
        let line = line.into();
        match self {
            Ui::Panel { .. } => state.log(line),
            Ui::Plain => println!("  {line}"),
        }
    }

    pub fn draw(&mut self, state: &State) -> Result<()> {
        let Ui::Panel { terminal, .. } = self else {
            return Ok(());
        };
        terminal.draw(|f| render(f, state))?;
        Ok(())
    }

    /// Hand the terminal back. Safe to call more than once.
    ///
    /// Deliberately does not reassign `*self`: that would drop the old value,
    /// which runs `Drop`, which calls this again — a stack overflow reachable
    /// only on the shutdown path.
    pub fn restore(&mut self) {
        if let Ui::Panel { terminal, restored } = self {
            if *restored {
                return;
            }
            *restored = true;
            let _ = disable_raw_mode();
            let _ = execute!(terminal.backend_mut(), LeaveAlternateScreen);
            let _ = terminal.show_cursor();
        }
    }
}

impl Drop for Ui {
    fn drop(&mut self) {
        // A panic must not leave someone in raw mode with no echo.
        self.restore();
    }
}

fn interpret(key: KeyEvent) -> Option<Action> {
    if key.kind != KeyEventKind::Press {
        return None;
    }
    match (key.code, key.modifiers) {
        (KeyCode::Char('c'), KeyModifiers::CONTROL) => Some(Action::Quit),
        (KeyCode::Char('q'), _) => Some(Action::Quit),
        (KeyCode::Char('k'), _) => Some(Action::Kick(0)),
        (KeyCode::Char('x'), _) => Some(Action::ToggleLock),
        (KeyCode::Char('l'), _) => Some(Action::ToggleReadOnly),
        (KeyCode::Char('d'), _) => Some(Action::ToggleSync),
        (KeyCode::Char(c), _) if c.is_ascii_digit() => {
            Some(Action::Kick(c.to_digit(10).unwrap_or(0)))
        }
        _ => Some(Action::Redraw),
    }
}

fn render(f: &mut Frame, state: &State) {
    let chunks = Layout::vertical([
        Constraint::Length(7), // header, sandbox, link
        Constraint::Length(4), // the warning nobody should be able to miss
        Constraint::Min(6),    // who and what
        Constraint::Length(ACTIVITY_LINES as u16 + 2),
        Constraint::Length(1), // keys
    ])
    .split(f.area());

    header(f, chunks[0], state);
    warning(f, chunks[1], state);
    people_and_terminals(f, chunks[2], state);
    activity(f, chunks[3], state);
    keys(f, chunks[4], state);
}

fn header(f: &mut Frame, area: Rect, state: &State) {
    let dim = Style::new().fg(Color::DarkGray);
    let lines = vec![
        Line::from(vec![
            Span::styled("● ", Style::new().fg(state.status.colour())),
            Span::styled(
                state.status.label(),
                Style::new().fg(state.status.colour()).bold(),
            ),
            Span::raw("  "),
            Span::styled(&state.folder, Style::new().bold()),
            Span::styled(format!("  {}", state.path), dim),
        ]),
        Line::from(Span::styled(format!("  {} files shared", state.files), dim)),
        Line::from(Span::styled(
            format!("  {}{}", state.sandbox, state.sync),
            Style::new().fg(if state.confined {
                Color::Green
            } else {
                Color::Yellow
            }),
        )),
        Line::raw(""),
        Line::from(vec![
            Span::raw("  "),
            Span::styled(&state.link, Style::new().fg(Color::Cyan).underlined()),
            Span::styled("   ← send this", dim),
        ]),
    ];
    f.render_widget(Paragraph::new(lines), area);
}

fn warning(f: &mut Frame, area: Rect, state: &State) {
    let headline = if state.confined {
        "a guest has your toolchain, confined to this folder — not a virtual machine"
    } else {
        "no sandbox — anyone with this link gets a shell as you: your files, \
         your SSH keys, your cloud credentials"
    };
    let mut text = vec![Line::from(Span::styled(
        headline,
        Style::new().fg(if state.confined {
            Color::DarkGray
        } else {
            Color::Yellow
        }),
    ))];
    for w in &state.warnings {
        text.push(Line::from(Span::styled(
            w.clone(),
            Style::new().fg(Color::DarkGray),
        )));
    }
    f.render_widget(
        Paragraph::new(text).wrap(Wrap { trim: true }).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::new().fg(Color::Yellow)),
        ),
        area,
    );
}

fn people_and_terminals(f: &mut Frame, area: Rect, state: &State) {
    let columns =
        Layout::horizontal([Constraint::Percentage(40), Constraint::Percentage(60)]).split(area);

    let guests: Vec<Row> = if state.guests.is_empty() {
        vec![Row::new(vec![
            "—".to_string(),
            "nobody yet".to_string(),
            String::new(),
        ])]
    } else {
        state
            .guests
            .iter()
            .map(|g| {
                Row::new(vec![
                    format!("{}", g.id),
                    g.name.clone(),
                    format!("{}  ·  {} term", ago(g.joined), g.terminals),
                ])
            })
            .collect()
    };

    f.render_widget(
        Table::new(
            guests,
            [
                Constraint::Length(3),
                Constraint::Min(8),
                Constraint::Length(20),
            ],
        )
        .block(Block::default().borders(Borders::ALL).title(" here ")),
        columns[0],
    );

    let terminals: Vec<Row> = if state.terminals.is_empty() {
        vec![Row::new(vec![
            "—".to_string(),
            "no terminals open".to_string(),
            String::new(),
            String::new(),
        ])]
    } else {
        state
            .terminals
            .iter()
            .map(|t| {
                Row::new(vec![
                    format!("{}", t.id),
                    t.opened_by.clone(),
                    format!("{:.0}% cpu", t.usage.cpu),
                    format!(
                        "{}  ·  {} proc",
                        human_bytes(t.usage.memory_bytes),
                        t.usage.processes
                    ),
                ])
            })
            .collect()
    };

    f.render_widget(
        Table::new(
            terminals,
            [
                Constraint::Length(3),
                Constraint::Min(8),
                Constraint::Length(9),
                Constraint::Length(18),
            ],
        )
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" running on your machine "),
        ),
        columns[1],
    );
}

fn activity(f: &mut Frame, area: Rect, state: &State) {
    let lines: Vec<Line> = state
        .activity
        .iter()
        .map(|l| Line::from(Span::styled(l.clone(), Style::new().fg(Color::Gray))))
        .collect();
    f.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(" activity ")),
        area,
    );
}

fn keys(f: &mut Frame, area: Rect, state: &State) {
    let text = if state.kicking {
        Line::from(Span::styled(
            " kick which? press the number beside their name, or any other key to cancel",
            Style::new().fg(Color::Yellow),
        ))
    } else {
        let dim = Style::new().fg(Color::DarkGray);
        let on = Style::new().fg(Color::Yellow);
        Line::from(vec![
            Span::styled(" [k] kick   ", dim),
            Span::styled(
                if state.locked {
                    "[x] locked"
                } else {
                    "[x] lock"
                },
                if state.locked { on } else { dim },
            ),
            Span::styled("   ", dim),
            Span::styled(
                if state.read_only {
                    "[l] terminals read-only"
                } else {
                    "[l] read-only"
                },
                if state.read_only { on } else { dim },
            ),
            Span::styled("   [q] close — ends every terminal and stops the link", dim),
        ])
    };
    f.render_widget(Paragraph::new(text), area);
}

fn ago(since: Instant) -> String {
    let secs = since.elapsed().as_secs();
    match secs {
        0..=59 => format!("{secs}s ago"),
        60..=3599 => format!("{}m ago", secs / 60),
        _ => format!("{}h ago", secs / 3600),
    }
}

/// Terminal rows, ordered and paired with their sampled usage.
pub fn terminal_rows(
    ids: &[u32],
    openers: &HashMap<u32, String>,
    usage: &HashMap<u32, Usage>,
) -> Vec<TerminalRow> {
    ids.iter()
        .map(|id| TerminalRow {
            id: *id,
            opened_by: openers.get(id).cloned().unwrap_or_else(|| "—".into()),
            usage: usage.get(id).copied().unwrap_or_default(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q_and_ctrl_c_both_quit() {
        let q = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE);
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(interpret(q), Some(Action::Quit));
        assert_eq!(interpret(ctrl_c), Some(Action::Quit));
    }

    #[test]
    fn the_advertised_keys_all_do_something() {
        // The panel prints [k] [x] [l] [q]. A key that is drawn but does
        // nothing is worse than one that is not drawn at all.
        for (key, expected) in [
            ('k', Action::Kick(0)),
            ('x', Action::ToggleLock),
            ('l', Action::ToggleReadOnly),
            ('d', Action::ToggleSync),
            ('q', Action::Quit),
        ] {
            let ev = KeyEvent::new(KeyCode::Char(key), KeyModifiers::NONE);
            assert_eq!(interpret(ev), Some(expected), "key {key} does nothing");
        }
    }

    #[test]
    fn a_digit_selects_a_participant() {
        let three = KeyEvent::new(KeyCode::Char('3'), KeyModifiers::NONE);
        assert_eq!(interpret(three), Some(Action::Kick(3)));
    }

    #[test]
    fn key_releases_are_ignored() {
        let mut release = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE);
        release.kind = KeyEventKind::Release;
        assert_eq!(interpret(release), None);
    }

    #[test]
    fn activity_keeps_only_the_recent_lines() {
        let mut s = State::new(
            "p".into(),
            "/p".into(),
            0,
            "sandboxed".into(),
            true,
            "l".into(),
            vec![],
        );
        for i in 0..40 {
            s.log(format!("line {i}"));
        }
        assert_eq!(s.activity.len(), ACTIVITY_LINES);
        assert_eq!(s.activity.last().unwrap(), "line 39");
    }

    #[test]
    fn relative_times_read_naturally() {
        assert!(ago(Instant::now()).ends_with("s ago"));
        assert_eq!(
            ago(Instant::now() - Duration::from_secs(3 * 60 + 20)),
            "3m ago"
        );
        assert_eq!(ago(Instant::now() - Duration::from_secs(7200)), "2h ago");
    }

    #[test]
    fn terminal_rows_survive_a_missing_sample() {
        let openers = HashMap::from([(1u32, "priya".to_string())]);
        let rows = terminal_rows(&[1, 2], &openers, &HashMap::new());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].opened_by, "priya");
        assert_eq!(rows[1].opened_by, "—");
        assert_eq!(rows[1].usage, Usage::default());
    }
}

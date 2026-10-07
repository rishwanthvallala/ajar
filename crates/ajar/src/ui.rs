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
    pub fn label(self) -> &'static str {
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
    /// The number typed so far for "kick which one?", while it is being asked.
    pub kicking: Option<String>,
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
            kicking: None,
        }
    }

    pub fn log(&mut self, line: impl Into<String>) {
        self.activity.push(line.into());
        if self.activity.len() > ACTIVITY_LINES {
            self.activity.remove(0);
        }
    }

    /// One key's part in "kick which one?".
    ///
    /// The number is typed and then confirmed with Enter. It used to be one
    /// keypress, acted on at once, so only guests numbered 1 to 9 could be
    /// kicked — and ids are never reused, every reconnect burns one, so a
    /// long session soon had guests the panel could not reach.
    pub fn kick_step(&mut self, action: &Action) -> KickStep {
        let Some(typed) = self.kicking.as_mut() else {
            if *action == Action::Kick {
                self.kicking = Some(String::new());
                return KickStep::Pending;
            }
            return KickStep::Ignored;
        };
        match action {
            Action::Digit(d) => {
                // A u32 has ten digits; anything longer is not anyone.
                if typed.len() < 10 {
                    typed.extend(char::from_digit(*d, 10));
                }
                KickStep::Pending
            }
            Action::Erase => {
                typed.pop();
                KickStep::Pending
            }
            Action::Confirm => match self.kicking.take().unwrap_or_default().parse() {
                Ok(id) => KickStep::Chosen(id),
                Err(_) => KickStep::Pending,
            },
            // Quitting still quits.
            Action::Quit => {
                self.kicking = None;
                KickStep::Ignored
            }
            // Anything else cancels, and does nothing else: a stray key in
            // the middle of choosing someone must not lock the room.
            _ => {
                self.kicking = None;
                KickStep::Pending
            }
        }
    }
}

/// What a key did to "kick which one?".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KickStep {
    /// Not part of a kick; the key means what it usually does.
    Ignored,
    /// The question was asked, answered in part, or cancelled.
    Pending,
    /// Enter, on this number.
    Chosen(u32),
}

/// What the panel asks the agent to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Quit,
    /// Ask which guest to remove.
    Kick,
    /// A digit, for the number of the guest being kicked.
    Digit(u32),
    Confirm,
    Erase,
    /// Seal the room: nobody new gets in.
    ToggleLock,
    /// Guests can watch the terminals but not type into them.
    ToggleReadOnly,
    /// Stop or resume keeping a copy on the relay.
    ToggleSync,
    /// Put the link on the clipboard, where the terminal allows it.
    CopyLink,
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
        (KeyCode::Char('k'), _) => Some(Action::Kick),
        (KeyCode::Char('x'), _) => Some(Action::ToggleLock),
        (KeyCode::Char('l'), _) => Some(Action::ToggleReadOnly),
        (KeyCode::Char('d'), _) => Some(Action::ToggleSync),
        (KeyCode::Char('c'), _) => Some(Action::CopyLink),
        (KeyCode::Char(c), _) if c.is_ascii_digit() => c.to_digit(10).map(Action::Digit),
        (KeyCode::Enter, _) => Some(Action::Confirm),
        (KeyCode::Backspace, _) => Some(Action::Erase),
        _ => Some(Action::Redraw),
    }
}

fn render(f: &mut Frame, state: &State) {
    let area = f.area();
    let width = area.width;
    let status = status_lines(state);
    let link = link_lines(state);
    let warning = warning_lines(state);
    let keys = keys_line(state);

    // Rows go to what matters most first: the link and the keys, then the
    // warnings, then the rest. A terminal too short for everything loses the
    // activity log before it loses a character of the link.
    let mut left = area.height;
    let link_h = take(&mut left, rows(&link, width));
    let keys_h = take(&mut left, rows(&keys, width));
    let warning_h = take(&mut left, rows(&warning, width.saturating_sub(2)) + 2);
    let status_h = take(&mut left, rows(&status, width));
    // Who is here gets at least five rows, the activity log what is over.
    let people_want = left.saturating_sub(ACTIVITY_LINES as u16 + 2).max(5);
    let people_h = take(&mut left, people_want);
    let activity_h = take(&mut left, ACTIVITY_LINES as u16 + 2);

    let chunks = Layout::vertical([
        Constraint::Length(status_h),
        Constraint::Length(link_h),
        Constraint::Length(warning_h),
        Constraint::Length(people_h),
        Constraint::Length(activity_h),
        Constraint::Length(keys_h),
    ])
    .split(area);

    f.render_widget(Paragraph::new(status).wrap(Wrap { trim: false }), chunks[0]);
    f.render_widget(Paragraph::new(link).wrap(Wrap { trim: false }), chunks[1]);
    if warning_h > 2 {
        f.render_widget(
            Paragraph::new(warning).wrap(Wrap { trim: true }).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::new().fg(Color::Yellow)),
            ),
            chunks[2],
        );
    }
    if people_h > 2 {
        people_and_terminals(f, chunks[3], state);
    }
    if activity_h > 2 {
        activity(f, chunks[4], state);
    }
    f.render_widget(Paragraph::new(keys).wrap(Wrap { trim: false }), chunks[5]);
}

/// Up to `want` of the rows `left`, taken from it.
fn take(left: &mut u16, want: u16) -> u16 {
    let got = want.min(*left);
    *left -= got;
    got
}

/// How many rows `lines` take once wrapped at `width` — at least one each.
fn rows(lines: &[Line], width: u16) -> u16 {
    let width = usize::from(width.max(1));
    lines
        .iter()
        .map(|l| l.width().max(1).div_ceil(width))
        .sum::<usize>()
        .try_into()
        .unwrap_or(u16::MAX)
}

/// Who, where, and what a guest can reach.
fn status_lines(state: &State) -> Vec<Line<'_>> {
    let dim = Style::new().fg(Color::DarkGray);
    let posture = Style::new().fg(if state.confined {
        Color::Green
    } else {
        Color::Yellow
    });
    vec![
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
        Line::from(Span::styled(
            format!(
                "  {} {} shared",
                state.files,
                if state.files == 1 { "file" } else { "files" }
            ),
            dim,
        )),
        Line::from(Span::styled(format!("  {}", state.sandbox), posture)),
        // Its own line: it used to share one with the sandbox, which cut it
        // off at any width.
        Line::from(Span::styled(
            format!("  {}", state.sync.trim_start_matches([' ', '\u{b7}'])),
            dim,
        )),
    ]
}

/// The link, whole. It wraps rather than being cut: at 80 columns,
/// Terminal.app's default, it used to lose the end of its key, and a guest
/// given that link got a page that never worked and never said why.
fn link_lines(state: &State) -> Vec<Line<'_>> {
    let dim = Style::new().fg(Color::DarkGray);
    vec![
        Line::from(Span::styled(
            format!("  {}", state.link),
            Style::new().fg(Color::Cyan).underlined(),
        )),
        Line::from(Span::styled(
            "  ← send this whole link, all of it after the #   [c] copies it",
            dim,
        )),
    ]
}

/// The warning nobody should be able to miss, and every other one.
fn warning_lines(state: &State) -> Vec<Line<'_>> {
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
    // Every one of them. The box used to be two lines tall whatever it held,
    // so the credentials warning — third, after the sandbox's — was never
    // seen in the panel at any size.
    for w in &state.warnings {
        text.push(Line::from(Span::styled(
            format!("!  {w}"),
            Style::new().fg(Color::Yellow),
        )));
    }
    text
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
                    format!("{} · {} term", ago(g.joined), g.terminals),
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
                Constraint::Length(15),
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

fn keys_line(state: &State) -> Vec<Line<'_>> {
    if let Some(typed) = &state.kicking {
        // The number first: at 80 columns the end of this line is what is
        // cut, and it used to be exactly the digits being typed.
        return vec![Line::from(Span::styled(
            format!(
                " kick #{typed}_ — the number beside their name, then Enter; any other key cancels"
            ),
            Style::new().fg(Color::Yellow),
        ))];
    }
    let dim = Style::new().fg(Color::DarkGray);
    let on = Style::new().fg(Color::Yellow);
    vec![Line::from(vec![
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
                "[l] read-only: watching"
            } else {
                "[l] read-only"
            },
            if state.read_only { on } else { dim },
        ),
        Span::styled(
            if state.sync.contains("keeping no copy") {
                "   [d] keep a copy"
            } else {
                "   [d] stop the copy"
            },
            dim,
        ),
        Span::styled("   [c] copy link", dim),
        Span::styled("   [q] close — ends every terminal and stops the link", dim),
    ])]
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
            ('k', Action::Kick),
            ('x', Action::ToggleLock),
            ('l', Action::ToggleReadOnly),
            ('d', Action::ToggleSync),
            ('c', Action::CopyLink),
            ('q', Action::Quit),
        ] {
            let ev = KeyEvent::new(KeyCode::Char(key), KeyModifiers::NONE);
            assert_eq!(interpret(ev), Some(expected), "key {key} does nothing");
        }
    }

    /// The panel as drawn at `cols` × `rows`, one string per row.
    fn drawn(state: &State, cols: u16, rows: u16) -> Vec<String> {
        let mut terminal = Terminal::new(ratatui::backend::TestBackend::new(cols, rows)).unwrap();
        terminal.draw(|f| render(f, state)).unwrap();
        let buffer = terminal.backend().buffer().clone();
        (0..rows)
            .map(|y| {
                (0..cols)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect::<String>()
            })
            .collect()
    }

    fn realistic() -> State {
        let mut s = State::new(
            "api".into(),
            "/Users/you/projects/api".into(),
            412,
            "sandboxed with seatbelt — writes confined to the shared folder, temp and build caches, \
             credentials and shell history unreadable; the ssh, gpg and Docker sockets refused, network allowed"
                .into(),
            true,
            "https://ajar.rishwanth.dev/j/quiet-ember-4417#k=XrlugaMUbs_Cy0hUdWNczbHNS5SW1R-NM0123456789a".into(),
            vec![
                "not a git repository — there is no history to roll back to if a guest changes something".into(),
                "withheld from guests' shells, because they look like credentials: AWS_SECRET_ACCESS_KEY".into(),
                "1 credential in this folder — .env. Readable by a guest, since they are inside the shared folder".into(),
            ],
        );
        s.sync = " · keeping a sealed copy on the relay, 3.1 MB in 412 files, so guests can read while you are away".into();
        s
    }

    #[test]
    fn at_eighty_columns_the_whole_link_is_on_screen() {
        // Terminal.app opens at 80×24. The link used to lose the end of its
        // key there, and a guest given it got a page that never worked.
        let s = realistic();
        let screen = drawn(&s, 80, 24).join("");
        let squeezed: String = screen.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            squeezed.contains(&s.link),
            "the link is cut:\n{}",
            drawn(&s, 80, 24).join("\n")
        );
        assert!(screen.contains("send this whole link"));
    }

    #[test]
    fn every_warning_is_on_screen() {
        let s = realistic();
        let screen: String = drawn(&s, 100, 40)
            .join("")
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        for w in &s.warnings {
            let start: String = w.chars().filter(|c| !c.is_whitespace()).take(30).collect();
            assert!(screen.contains(&start), "missing: {w}");
        }
        assert!(
            screen.contains("sealedcopyontherelay"),
            "the copy line is cut"
        );
    }

    #[test]
    fn the_number_being_typed_for_a_kick_is_on_screen_at_eighty_columns() {
        let mut s = realistic();
        s.kicking = Some("12".into());
        let screen = drawn(&s, 80, 24).join("\n");
        assert!(screen.contains("kick #12_"), "{screen}");
    }

    fn state() -> State {
        State::new(
            "p".into(),
            "/p".into(),
            0,
            "s".into(),
            true,
            "l".into(),
            vec![],
        )
    }

    fn keys(state: &mut State, typed: &str) -> Vec<KickStep> {
        typed
            .chars()
            .map(|c| {
                let code = match c {
                    '\n' => KeyCode::Enter,
                    '\x08' => KeyCode::Backspace,
                    c => KeyCode::Char(c),
                };
                let action = interpret(KeyEvent::new(code, KeyModifiers::NONE)).unwrap();
                state.kick_step(&action)
            })
            .collect()
    }

    #[test]
    fn a_guest_numbered_over_nine_can_be_kicked() {
        // It was one keypress, acted on at once: guest 12 was unreachable.
        let mut s = state();
        assert_eq!(keys(&mut s, "k12\n").last(), Some(&KickStep::Chosen(12)));
        assert_eq!(s.kicking, None);
    }

    #[test]
    fn a_digit_can_be_taken_back() {
        let mut s = state();
        assert_eq!(
            keys(&mut s, "k15\x083\n").last(),
            Some(&KickStep::Chosen(13))
        );
    }

    #[test]
    fn any_other_key_cancels_without_acting() {
        let mut s = state();
        // `x` would lock the room; mid-question it only cancels.
        assert_eq!(keys(&mut s, "k1x"), vec![KickStep::Pending; 3]);
        assert_eq!(s.kicking, None);
        assert_eq!(
            keys(&mut s, "\n"),
            vec![KickStep::Ignored],
            "Enter after a cancel kicks nobody"
        );
    }

    #[test]
    fn digits_alone_kick_nobody() {
        let mut s = state();
        assert_eq!(
            keys(&mut s, "3\n"),
            vec![KickStep::Ignored, KickStep::Ignored]
        );
    }

    #[test]
    fn quitting_still_quits_mid_question() {
        let mut s = state();
        keys(&mut s, "k1");
        assert_eq!(s.kick_step(&Action::Quit), KickStep::Ignored);
        assert_eq!(s.kicking, None);
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

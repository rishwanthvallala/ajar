/**
 * The typing half of the terminal.
 *
 * This exists because the shell will not do it. bash in this runtime prints no
 * prompt and echoes nothing, even with a real pty attached — see the
 * measurement at the top of `shell.ts`. Left alone, a terminal here is a place
 * output appears and keystrokes vanish.
 *
 * So the page draws the prompt, echoes what you type, edits the line, and
 * sends it when you press enter — and it does that the way bash's readline
 * does, because that is what every hand on a keyboard expects: history on the
 * arrows, Tab completion, Ctrl+R, the emacs keys, Home and End. What it cannot
 * be is a full terminal for interactive programs: a shell that never echoes
 * cannot host one, so while a command runs, keys go to it raw.
 */
import type { Shell } from "./shell";

const PROMPT = "\x1b[2m$\x1b[0m ";
/** Visible width of the prompt, for placing the cursor on a wrapped line. */
const PROMPT_WIDTH = 2;

export interface Screen {
  write(data: string): void;
}

export interface ConsoleHooks {
  /**
   * Asked for only when a line is entered — the terminal is usable before the
   * runtime exists, and most of the time it arrives during the typing of the
   * first command.
   */
  shellFor: () => Promise<Shell>;
  /** Called after any command the person typed, so the folder can be synced. */
  onFinished: () => void;
  /** The shell if one is open already, for completion — never starts one. */
  openShell?: () => Shell | null;
  /** The terminal's width, so a line longer than it is redrawn correctly. */
  columns?: () => number;
}

interface Search {
  query: string;
  /** Index into history of the current match; history.length means none yet. */
  index: number;
  failed: boolean;
  saved: string;
}

export class Console {
  private shell: Shell | null = null;
  private line = "";
  /** Where the cursor sits within `line`, so arrow keys mean something. */
  private at = 0;
  private history: string[] = [];
  /** Position while walking history with the arrows; null when not walking. */
  private browsing: number | null = null;
  /** What was being typed before walking history, restored by ↓ past the end. */
  private draft = "";
  /** The last text cut with Ctrl+U, Ctrl+K or Ctrl+W, for Ctrl+Y. */
  private killed = "";
  private search: Search | null = null;
  /** The line as it was at the last Tab, so a second Tab can list choices. */
  private tabbedAt: string | null = null;
  private warned = false;
  private started = false;
  private running = false;
  /** A terminal may split one escape sequence across several callbacks. */
  private pendingInput = "";
  /** Input after a line that started a command — the rest of a paste. */
  private queued = "";
  /** Which row of a wrapped line the cursor is on, counted from the prompt. */
  private cursorRow = 0;

  /** Whether a command is in the foreground. */
  get busy(): boolean {
    return this.running;
  }

  constructor(
    private readonly screen: Screen,
    private readonly hooks: ConsoleHooks,
  ) {}

  /**
   * Hand over a shell that already exists.
   *
   * Without this the console asks for one on its first line and announces that
   * it is starting the runtime — even when Run already did, which reads as a
   * 60 MB download about to happen twice.
   */
  attach(shell: Shell): void {
    if (!this.shell?.alive) this.shell = shell;
    this.started = true;
  }

  /** Draw the first prompt. Nothing is on screen until this. */
  start(): void {
    this.screen.write(PROMPT);
    this.cursorRow = 0;
  }

  /** Bytes from the terminal. */
  handle(data: string): void {
    // While something is running, typing belongs to *it*, not to the line
    // editor. `cat` with no arguments, `python` with no script, anything that
    // reads input — all of them need what is typed, and swallowing it here is
    // why `cat` looked like a hang rather than a program waiting for you.
    //
    // Enter arrives from the terminal as a carriage return, and a program
    // reading lines wants a newline — that translation is normally the
    // line discipline's job, and there is not one here. Without it `cat`
    // receives characters and never a complete line, so it answers nothing
    // and still looks hung.
    //
    // Not echoed here. The terminal echoes what a running program reads —
    // bash only silences it for its own input — so doing both showed every
    // keystroke twice: `ttyyppeedd` for `typed`.
    //
    // ctrl-c ends the shell, not merely the command. Sending the byte and
    // waiting to notice was tried twice and does not work: bash does not
    // survive the interrupt, the output stream stays open afterwards so
    // nothing looks wrong, and every later command hangs against a shell that
    // cannot answer. Tearing it down here makes that deterministic instead of
    // a race — the next command starts a new one.
    //
    // ctrl-d is forwarded and does nothing: this pty has no canonical mode,
    // so there is no EOF to send and `cat` simply reads on.
    if (this.running) {
      if (data === "\x03") {
        this.queued = "";
        void this.interrupt();
        return;
      }
      void this.shell?.type(data.replace(/\r/g, "\n"));
      return;
    }
    this.pendingInput += data;
    while (this.pendingInput) {
      // A pasted script is a line per command. Once one of them is running,
      // the rest waits its turn instead of being typed into it — which is
      // what "a command is already running" used to be.
      if (this.running) {
        this.queued += this.pendingInput;
        this.pendingInput = "";
        return;
      }
      const taken = takeKey(this.pendingInput);
      if (taken === null) return; // the start of a sequence; wait for the rest
      this.pendingInput = this.pendingInput.slice(taken.length);
      this.key(taken.key);
    }
  }

  private key(key: string): void {
    if (this.search) return this.searchKey(key);
    if (key !== "\t") this.tabbedAt = null;
    switch (key) {
      case "\r":
      case "\n":
        return void this.submit();
      case "\x7f":
      case "\b":
        return this.backspace();
      case "\t":
        return void this.complete();
      case "\x03": // ctrl-c: abandon the line, like a real shell
        this.screen.write("^C\r\n" + PROMPT);
        this.cursorRow = 0;
        this.setLine("", false);
        this.browsing = null;
        return;
      case "\x04": // ctrl-d: delete forward; on an empty line there is nothing to end
        return this.deleteForward();
      case "\x01": // ctrl-a
      case "home":
        return this.moveTo(0);
      case "\x05": // ctrl-e
      case "end":
        return this.moveTo(this.line.length);
      case "\x02": // ctrl-b
      case "left":
        return this.moveTo(this.at - 1);
      case "\x06": // ctrl-f
      case "right":
        return this.moveTo(this.at + 1);
      case "word-left":
        return this.moveTo(wordStart(this.line, this.at));
      case "word-right":
        return this.moveTo(wordEnd(this.line, this.at));
      case "up":
      case "\x10": // ctrl-p
        return this.recall(-1);
      case "down":
      case "\x0e": // ctrl-n
        return this.recall(1);
      case "delete":
        return this.deleteForward();
      case "\x15": // ctrl-u: cut to the start
        return this.cut(0, this.at);
      case "\x0b": // ctrl-k: cut to the end
        return this.cut(this.at, this.line.length);
      case "\x17": // ctrl-w: cut the whitespace-separated word before the cursor
        return this.cut(bigWordStart(this.line, this.at), this.at);
      case "kill-word-back": // alt-backspace
        return this.cut(wordStart(this.line, this.at), this.at);
      case "kill-word": // alt-d
        return this.cut(this.at, wordEnd(this.line, this.at));
      case "\x19": // ctrl-y: paste back what was cut
        return this.insert(this.killed);
      case "\x0c": // ctrl-l: clear the screen, keep the line
        this.screen.write("\x1b[H\x1b[2J");
        this.cursorRow = 0;
        return this.redraw();
      case "\x12": // ctrl-r
        return this.startSearch();
      default:
        // Named keys this editor has no use for, and control characters.
        if (key.length !== 1 || key < " " || key === "\x7f") return;
        return this.insert(key);
    }
  }

  // ------------------------------------------------------------- editing

  private insert(text: string): void {
    if (!text) return;
    this.line = this.line.slice(0, this.at) + text + this.line.slice(this.at);
    this.at += text.length;
    this.redraw();
  }

  private backspace(): void {
    if (this.at === 0) return;
    this.line = this.line.slice(0, this.at - 1) + this.line.slice(this.at);
    this.at -= 1;
    this.redraw();
  }

  private deleteForward(): void {
    if (this.at >= this.line.length) return;
    this.line = this.line.slice(0, this.at) + this.line.slice(this.at + 1);
    this.redraw();
  }

  private cut(from: number, to: number): void {
    if (to <= from) return;
    this.killed = this.line.slice(from, to);
    this.line = this.line.slice(0, from) + this.line.slice(to);
    this.at = from;
    this.redraw();
  }

  private moveTo(position: number): void {
    const next = Math.max(0, Math.min(this.line.length, position));
    if (next === this.at) return;
    this.at = next;
    this.placeCursor();
  }

  private setLine(text: string, draw = true): void {
    this.line = text;
    this.at = text.length;
    if (draw) this.redraw();
  }

  /**
   * Repaint from the prompt, and put the cursor where it belongs.
   *
   * Aware of the terminal's width: a line longer than it wraps, and a repaint
   * that only returned to the start of the current row left the rows above it
   * stale — every edit to a long command smeared a copy of it up the screen.
   */
  private redraw(prefix = PROMPT, text = this.line, width = PROMPT_WIDTH): void {
    const cols = Math.max(1, this.hooks.columns?.() ?? 80);
    const up = this.cursorRow > 0 ? `\x1b[${this.cursorRow}A` : "";
    this.screen.write(`${up}\r\x1b[J${prefix}${text}`);
    const end = width + text.length;
    // At an exact multiple of the width xterm parks the cursor on the last
    // column rather than the next row; a space moves it on so the arithmetic
    // below holds, and is erased by the next repaint.
    if (end > 0 && end % cols === 0) this.screen.write(" \b");
    this.cursorRow = Math.floor(end / cols);
    if (prefix === PROMPT) this.placeCursor();
  }

  /** Move the cursor to character `at` of the line, from wherever it is. */
  private placeCursor(at = this.at): void {
    const cols = Math.max(1, this.hooks.columns?.() ?? 80);
    const target = PROMPT_WIDTH + at;
    const row = Math.floor(target / cols);
    const moves = (this.cursorRow > row ? `\x1b[${this.cursorRow - row}A` : "")
      + (row > this.cursorRow ? `\x1b[${row - this.cursorRow}B` : "")
      + `\x1b[${(target % cols) + 1}G`;
    this.screen.write(moves);
    this.cursorRow = row;
  }

  // ------------------------------------------------------------- history

  private recall(delta: number): void {
    if (this.history.length === 0) return;
    if (this.browsing === null) {
      if (delta > 0) return;
      this.draft = this.line;
      this.browsing = this.history.length;
    }
    const next = this.browsing + delta;
    if (next < 0) return;
    if (next >= this.history.length) {
      // Past the newest: back to what was being typed, as bash does.
      this.browsing = null;
      return this.setLine(this.draft);
    }
    this.browsing = next;
    this.setLine(this.history[next] ?? "");
  }

  private remember(command: string): void {
    if (!command.trim() || this.history[this.history.length - 1] === command) return;
    this.history.push(command);
    // A tab left open for a day should not accumulate a day of commands.
    if (this.history.length > 500) this.history.shift();
  }

  // ------------------------------------------------------ reverse search

  private startSearch(): void {
    this.search = { query: "", index: this.history.length, failed: false, saved: this.line };
    this.drawSearch();
  }

  private searchKey(key: string): void {
    const s = this.search!;
    switch (key) {
      case "\x12": // ctrl-r again: the next older match
        this.find(s.index - 1);
        return this.drawSearch();
      case "\x7f":
      case "\b":
        s.query = s.query.slice(0, -1);
        this.find(this.history.length - 1);
        return this.drawSearch();
      case "\x07": // ctrl-g: give up, put back what was there
        return this.endSearch(s.saved);
      case "\x03":
        this.search = null;
        return this.key("\x03");
      case "\r":
      case "\n": {
        this.endSearch(this.match() ?? s.saved);
        return void this.submit();
      }
      case "escape":
        return this.endSearch(this.match() ?? s.saved);
      default:
        if (key.length === 1 && key >= " " && key !== "\x7f") {
          s.query += key;
          this.find(Math.min(s.index, this.history.length - 1));
          return this.drawSearch();
        }
        // Anything else — an arrow, ctrl-a, Tab — takes the match to the line
        // and then does what it would have done there.
        this.endSearch(this.match() ?? s.saved);
        return this.key(key);
    }
  }

  private find(from: number): void {
    const s = this.search!;
    for (let i = from; i >= 0; i--) {
      if (this.history[i]!.includes(s.query)) {
        s.index = i;
        s.failed = false;
        return;
      }
    }
    s.failed = s.query !== "";
  }

  private match(): string | null {
    const s = this.search;
    if (!s || s.failed || s.index >= this.history.length) return null;
    return this.history[s.index] ?? null;
  }

  private drawSearch(): void {
    const s = this.search!;
    const label = `(${s.failed ? "failed " : ""}reverse-i-search)\`${s.query}': `;
    const shown = this.match() ?? "";
    this.redraw(label, shown, label.length);
  }

  private endSearch(line: string): void {
    this.search = null;
    this.setLine(line);
  }

  // ---------------------------------------------------------- completion

  /**
   * Complete the word before the cursor, the way bash does: a command name
   * in command position, a path anywhere else. One match is written out in
   * full; several are narrowed to what they share, and a second Tab lists
   * them. Asked of the open shell, so it knows the current directory — and
   * with no shell open yet there is nothing to ask, so Tab does nothing.
   */
  private async complete(): Promise<void> {
    const shell = this.hooks.openShell?.() ?? (this.shell?.alive ? this.shell : null);
    if (!shell || shell.busy) return;
    const before = this.line.slice(0, this.at);
    const word = before.match(/[^\s;|&()<>]*$/)![0];
    const start = this.at - word.length;
    const asCommand = /^\s*$|(?:[;|&(]|&&|\|\|)\s*$/.test(before.slice(0, start)) && !word.includes("/");
    const snapshot = this.line;
    const found = await shell.complete(word, asCommand);
    // Typing carried on while bash was being asked; the answer is for a line
    // that no longer exists.
    if (this.line !== snapshot || this.running || this.search) return;
    if (found.length === 0) return;

    const shared = found.reduce((a, b) => {
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      return a.slice(0, i);
    });
    const done = found.length === 1 && !found[0]!.endsWith("/");
    const text = escapeWord(found.length === 1 ? found[0]! : shared) + (done ? " " : "");
    if (text !== escapeWord(word)) {
      this.line = this.line.slice(0, start) + text + this.line.slice(this.at);
      this.at = start + text.length;
      this.tabbedAt = null;
      return this.redraw();
    }
    if (this.tabbedAt !== this.line) {
      this.tabbedAt = this.line;
      return;
    }
    // A second Tab with nothing more to add: show the choices, as bash does.
    const names = found.map((f) => (asCommand ? f : f.replace(/.*\/(?=.)/, "")));
    const width = Math.max(...names.map((n) => n.length)) + 2;
    const cols = Math.max(1, Math.floor((this.hooks.columns?.() ?? 80) / width));
    const rows: string[] = [];
    for (let i = 0; i < names.length; i += cols) {
      rows.push(names.slice(i, i + cols).map((n) => n.padEnd(width)).join("").trimEnd());
    }
    // Below the whole line, then the line again with the cursor where it was.
    this.placeCursor(this.line.length);
    this.screen.write(`\r\n${rows.join("\r\n")}\r\n`);
    this.cursorRow = 0;
    this.redraw();
  }

  // --------------------------------------------------------------- running

  /**
   * Stop whatever is running by ending the shell it runs in.
   *
   * The pending command resolves as the process goes, so the prompt comes
   * back on its own; the next command gets a fresh shell in the folder root.
   */
  private async interrupt(): Promise<void> {
    const shell = this.shell;
    this.shell = null;
    this.screen.write("^C\r\n");
    await shell?.close().catch(() => {});
  }

  private async submit(): Promise<void> {
    const command = this.line;
    // The cursor may be mid-line; the output belongs after all of it.
    this.placeCursor(this.line.length);
    this.screen.write("\r\n");
    this.cursorRow = 0;
    this.line = "";
    this.at = 0;
    this.browsing = null;

    if (!command.trim()) {
      this.screen.write(PROMPT);
      return;
    }
    this.remember(command);

    this.running = true;
    // Said once, the first time something waits: a prompt that has vanished
    // and a program waiting for input look exactly the same from here.
    if (!this.warned) {
      this.warned = true;
      this.screen.write("\x1b[2m(ctrl-c stops a running command)\x1b[0m\r\n");
    }
    try {
      // A shell that has exited is replaced rather than reused. Interrupting
      // a command takes bash with it here, so this is the normal path after a
      // ctrl-c — and a fresh shell starts in the folder root with none of the
      // previous one's variables, which is worth saying rather than letting
      // somebody discover their `cd` was forgotten.
      if (this.shell && !this.shell.alive) this.shell = null;
      if (!this.shell && this.started) {
        this.screen.write(
          "\x1b[2m(the shell restarted — you are back in the folder root)\x1b[0m\r\n",
        );
      }
      if (!this.shell) {
        if (!this.started) {
          this.started = true;
          this.screen.write("\x1b[2mstarting the runtime, first command only…\x1b[0m\r\n");
        }
        this.shell = await this.hooks.shellFor();
      }
      const { exitCode } = await this.shell.run(command);
      if (exitCode !== 0) this.screen.write(`\x1b[31mexit ${exitCode}\x1b[0m\r\n`);
    } catch (e) {
      this.screen.write(`\x1b[31m${(e as Error).message}\x1b[0m\r\n`);
    } finally {
      this.running = false;
      this.screen.write(PROMPT);
      this.cursorRow = 0;
    }
    // After the prompt is back, so a slow sync never delays the next command.
    this.hooks.onFinished();
    this.drainQueued();
  }

  /** Carry on with the rest of a paste, now that the prompt is back. */
  private drainQueued(): void {
    if (!this.queued) return;
    const rest = this.queued;
    this.queued = "";
    this.handle(rest);
  }

  /** Echo a command the page is running on the user's behalf. */
  announce(command: string): void {
    this.running = true;
    // In history too: the button is a shortcut for typing it, so ↑ should
    // find it like anything typed.
    this.remember(command);
    this.screen.write(`\r\x1b[K${PROMPT}${command}\r\n`);
    this.cursorRow = 0;
  }

  /** Redraw the prompt after something else wrote to the screen. */
  resume(): void {
    this.running = false;
    this.screen.write(PROMPT);
    this.cursorRow = 0;
    if (this.line) this.redraw();
    this.drainQueued();
  }
}

/**
 * The next key at the front of `input`: one character, or a whole escape
 * sequence named by what it means. Null when `input` is the start of a
 * sequence that has not finished arriving.
 *
 * Every sequence is consumed whole. The old reader knew the four arrows and
 * dropped only the ESC of anything else, so Home typed `[H` into the command,
 * Delete typed `[3~` and ctrl-← typed `[1;5D`.
 */
export function takeKey(input: string): { key: string; length: number } | null {
  if (input[0] !== "\x1b") return { key: input[0]!, length: 1 };
  if (input.length === 1) return null;
  const second = input[1]!;
  if (second === "[") {
    // CSI: parameters, intermediates, then one final byte.
    const m = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(input);
    if (!m) return /^\x1b\[[0-?]*[ -/]*$/.test(input) ? null : { key: "escape", length: 1 };
    const [whole, params, , final] = m;
    const mod = Number(params!.split(";")[1] ?? 1);
    const ctrlOrAlt = mod >= 3; // 3 alt, 5 ctrl, and combinations
    const named: Record<string, string> = {
      A: "up", B: "down", C: ctrlOrAlt ? "word-right" : "right", D: ctrlOrAlt ? "word-left" : "left",
      H: "home", F: "end",
    };
    const tilde: Record<string, string> = { "1": "home", "7": "home", "4": "end", "8": "end", "3": "delete" };
    const key = final === "~" ? tilde[params!.split(";")[0]!] : named[final!];
    return { key: key ?? "ignored", length: whole!.length };
  }
  if (second === "O") {
    // SS3, which xterm sends for the arrows, Home and End in application mode.
    if (input.length < 3) return null;
    const named: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
    return { key: named[input[2]!] ?? "ignored", length: 3 };
  }
  // Alt plus a key arrives as ESC and the key.
  const alt: Record<string, string> = { b: "word-left", f: "word-right", d: "kill-word", "\x7f": "kill-word-back", "\b": "kill-word-back" };
  if (alt[second]) return { key: alt[second]!, length: 2 };
  return { key: "escape", length: 1 };
}

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** The start of the word before `at`, as readline's alt-b counts words. */
export function wordStart(line: string, at: number): number {
  let i = at;
  while (i > 0 && !isWordChar(line[i - 1])) i--;
  while (i > 0 && isWordChar(line[i - 1])) i--;
  return i;
}

/** The end of the word after `at`, as readline's alt-f counts words. */
export function wordEnd(line: string, at: number): number {
  let i = at;
  while (i < line.length && !isWordChar(line[i])) i++;
  while (i < line.length && isWordChar(line[i])) i++;
  return i;
}

/** Ctrl+W's word: everything back to whitespace, as unix-word-rubout. */
export function bigWordStart(line: string, at: number): number {
  let i = at;
  while (i > 0 && /\s/.test(line[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(line[i - 1]!)) i--;
  return i;
}

/** A completed name, made safe to type: spaces and shell syntax escaped. */
function escapeWord(word: string): string {
  return word.replace(/([ \t'"\\$`!&;|<>()*?[\]#{}])/g, "\\$1");
}

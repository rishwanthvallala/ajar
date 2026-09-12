/**
 * The typing half of the terminal.
 *
 * This exists because the shell will not do it. bash in this runtime prints no
 * prompt and echoes nothing, even with a real pty attached — see the
 * measurement at the top of `shell.ts`. Left alone, a terminal here is a place
 * output appears and keystrokes vanish.
 *
 * So the page draws the prompt, echoes what you type, edits the line, and
 * sends it when you press enter. What it deliberately does *not* try to be is
 * a full terminal: there is no history search, no tab completion, and no
 * interactive program can run under it, because a shell that never echoes
 * cannot host one anyway. Line in, output out.
 */
import type { Shell } from "./shell";

const PROMPT = "\x1b[2m$\x1b[0m ";

export interface Screen {
  write(data: string): void;
}

export class Console {
  private shell: Shell | null = null;
  private line = "";
  /** Where the cursor sits within `line`, so arrow keys mean something. */
  private at = 0;
  private history: string[] = [];
  private warned = false;
  private started = false;
  private browsing: number | null = null;
  private running = false;

  /** Whether a command is in the foreground. */
  get busy(): boolean {
    return this.running;
  }

  constructor(
    private readonly screen: Screen,
    /**
     * Asked for only when a line is entered — the terminal is usable before
     * the 60 MB runtime exists, and most of the time it arrives during the
     * typing of the first command.
     */
    private readonly shellFor: () => Promise<Shell>,
    /** Called after any command the person typed, so the folder can be synced. */
    private readonly onFinished: () => void,
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
  }

  /** Bytes from the terminal. */
  handle(data: string): void {
    // While something is running, typing belongs to *it*, not to the line
    // editor. `cat` with no arguments, `python` with no script, anything that
    // reads input — all of them need what is typed, and swallowing it here is
    // why `cat` looked like a hang rather than a program waiting for you.
    //
    // Echoed locally on the way through, because the shell does not.
    // Exposed so the page and the checks can tell a running command from a
    // prompt waiting for input — from the outside they look identical.
    if (this.running) {
      // Enter arrives from the terminal as a carriage return, and a program
      // reading lines wants a newline — that translation is normally the
      // line discipline's job, and there is not one here. Without it `cat`
      // receives characters and never a complete line, so it answers nothing
      // and still looks hung.
      // Not echoed here. The terminal echoes what a running program reads —
      // bash only silences it for its own input — so doing both showed every
      // keystroke twice: `ttyyppeedd` for `typed`.
      // ctrl-c ends the shell, not merely the command.
      //
      // Sending the byte and waiting to notice was tried twice and does not
      // work: bash does not survive the interrupt, the output stream stays
      // open afterwards so nothing looks wrong, and every later command hangs
      // against a shell that cannot answer. Tearing it down here makes that
      // deterministic instead of a race — the next command starts a new one.
      //
      // ctrl-d is forwarded and does nothing: this pty has no canonical mode,
      // so there is no EOF to send and `cat` simply reads on.
      if (data === "\x03") {
        void this.interrupt();
        return;
      }
      void this.shell?.type(data.replace(/\r/g, "\n"));
      return;
    }
    for (const ch of data) this.key(ch);
  }

  private key(ch: string): void {
    switch (ch) {
      case "\r":
      case "\n":
        return void this.submit();
      case "\x7f":
      case "\b":
        return this.backspace();
      case "\x04": // ctrl-d on an empty line: nothing to end, so ignore it
        return;
      case "\x03": // ctrl-c: abandon the line, like a real shell
        this.screen.write("^C\r\n" + PROMPT);
        this.line = "";
        this.at = 0;
        return;
      case "\x1b[A":
        return this.recall(-1);
      case "\x1b[B":
        return this.recall(1);
      case "\x1b[C":
        if (this.at < this.line.length) {
          this.at += 1;
          this.screen.write("\x1b[C");
        }
        return;
      case "\x1b[D":
        if (this.at > 0) {
          this.at -= 1;
          this.screen.write("\x1b[D");
        }
        return;
      default:
        // Anything else that is not a control character is text.
        if (ch < " " || ch === "\x7f") return;
        this.line = this.line.slice(0, this.at) + ch + this.line.slice(this.at);
        this.at += 1;
        this.redraw();
    }
  }

  private backspace(): void {
    if (this.at === 0) return;
    this.line = this.line.slice(0, this.at - 1) + this.line.slice(this.at);
    this.at -= 1;
    this.redraw();
  }

  /** Repaint from the prompt. Simplest thing that is always correct. */
  private redraw(): void {
    this.screen.write(`\r\x1b[K${PROMPT}${this.line}`);
    const back = this.line.length - this.at;
    if (back > 0) this.screen.write(`\x1b[${back}D`);
  }

  private recall(delta: number): void {
    if (this.history.length === 0) return;
    const next =
      this.browsing === null
        ? this.history.length - 1
        : Math.min(this.history.length - 1, Math.max(0, this.browsing + delta));
    this.browsing = next;
    this.line = this.history[next] ?? "";
    this.at = this.line.length;
    this.redraw();
  }

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
    this.screen.write("\r\n");
    this.line = "";
    this.at = 0;
    this.browsing = null;

    if (!command.trim()) {
      this.screen.write(PROMPT);
      return;
    }
    if (this.history[this.history.length - 1] !== command) {
      this.history.push(command);
      // A tab left open for a day should not accumulate a day of commands.
      if (this.history.length > 200) this.history.shift();
    }

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
        this.shell = await this.shellFor();
      }
      const { exitCode } = await this.shell.run(command);
      if (exitCode !== 0) this.screen.write(`\x1b[31mexit ${exitCode}\x1b[0m\r\n`);
    } catch (e) {
      this.screen.write(`\x1b[31m${(e as Error).message}\x1b[0m\r\n`);
    } finally {
      this.running = false;
      this.screen.write(PROMPT);
    }
    // After the prompt is back, so a slow sync never delays the next command.
    this.onFinished();
  }

  /** Echo a command the page is running on the user's behalf. */
  announce(command: string): void {
    this.screen.write(`\r\x1b[K${PROMPT}${command}\r\n`);
  }

  /** Redraw the prompt after something else wrote to the screen. */
  resume(): void {
    this.screen.write(PROMPT + this.line);
  }
}

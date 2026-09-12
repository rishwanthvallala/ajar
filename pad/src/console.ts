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
  private line = "";
  /** Where the cursor sits within `line`, so arrow keys mean something. */
  private at = 0;
  private history: string[] = [];
  private browsing: number | null = null;
  private running = false;

  constructor(
    private readonly screen: Screen,
    private readonly shell: Shell,
    /** Called after any command the person typed, so the folder can be synced. */
    private readonly onFinished: () => void,
  ) {}

  /** Draw the first prompt. Nothing is on screen until this. */
  start(): void {
    this.screen.write(PROMPT);
  }

  /** Bytes from the terminal. */
  handle(data: string): void {
    // While something is running the only useful key is the one that stops it.
    if (this.running) {
      if (data === "\x03") void this.shell.type("\x03");
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
    if (this.history[this.history.length - 1] !== command) this.history.push(command);

    this.running = true;
    try {
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

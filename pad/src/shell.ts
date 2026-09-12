/**
 * The session's one shell, and how the page knows when a command has finished.
 *
 * ## bash here does not behave like a terminal, whatever it reports
 *
 * Measured, twice, because the first answer looked self-inflicted and was not:
 *
 * ```text
 *   test -t 0          ->  TTY        (a real pty is attached)
 *   after spawn        ->  ""         (no prompt)
 *   after `PS1=...`    ->  ""         (not even echoed)
 *   after `echo hi`    ->  "hi\n"     (output only)
 * ```
 *
 * So `PS1` cannot be the "I am idle" signal, and nothing a person types will
 * appear on screen by itself. This build of bash runs commands and returns
 * their output; everything else a terminal normally does is the page's job.
 *
 * ## The sentinel
 *
 * Each command is sent with a `printf` of `$?` after it, wrapped in `\x01` —
 * a control character no ordinary tool emits. That needs no prompt to work and
 * carries the exit status back for free. The marker is stripped before
 * anything reaches the screen, including one split across two chunks.
 */
import type { Runtime } from "./runtime";

const MARK = "";
/** Matches the sentinel and captures the exit status. */
const DONE = /(\d+)/;
// `$'...'` — ANSI-C quoting. Inside ordinary single quotes bash takes `\001`
// as four literal characters and the marker never appears, which reads exactly
// like the prompt not being printed at all.

export interface Finished {
  exitCode: number;
}

export class Shell {
  private buffer = "";
  private waiting: ((f: Finished) => void) | null = null;
  private readonly decoder = new TextDecoder();

  private constructor(
    private readonly proc: Awaited<ReturnType<Runtime["spawnShell"]>>,
    private readonly onOutput: (text: string) => void,
  ) {}

  static async open(
    rt: Runtime,
    size: { columns: number; rows: number },
    onOutput: (text: string) => void,
  ): Promise<Shell> {
    const proc = await rt.spawnShell(size.columns, size.rows);
    const shell = new Shell(proc, onOutput);
    void shell.drain();
    return shell;
  }

  /** Everything the shell says, with the sentinel taken out of it. */
  private async drain(): Promise<void> {
    for await (const chunk of this.proc.stdout!) {
      this.absorb(this.decoder.decode(chunk, { stream: true }));
    }
  }

  private absorb(text: string): void {
    this.buffer += text;
    for (;;) {
      const found = DONE.exec(this.buffer);
      if (!found) break;
      // Everything before the marker is real output; the marker itself is
      // bookkeeping and never reaches the terminal.
      const before = this.buffer.slice(0, found.index);
      if (before) this.onOutput(before);
      this.buffer = this.buffer.slice(found.index + found[0].length);
      const done = this.waiting;
      this.waiting = null;
      done?.({ exitCode: Number(found[1]) });
    }
    // A partial marker at the end is held back rather than shown, or the
    // terminal briefly renders a control character before it is completed.
    const held = this.buffer.lastIndexOf(MARK);
    const flushable = held === -1 ? this.buffer : this.buffer.slice(0, held);
    if (flushable) {
      this.onOutput(flushable);
      this.buffer = this.buffer.slice(flushable.length);
    }
  }

  /**
   * Run one command and resolve when it finishes.
   *
   * Rejects if another is already running: two commands interleaved in one
   * shell would return their sentinels in an order nothing can attribute.
   */
  run(command: string): Promise<Finished> {
    if (this.waiting) return Promise.reject(new Error("a command is already running"));
    return new Promise<Finished>((resolve, reject) => {
      this.waiting = resolve;
      this.proc.stdin!.write(`${command}\nprintf '\\001%s\\001' "$?"\n`).catch((e) => {
        this.waiting = null;
        reject(e);
      });
    });
  }

  /**
   * Raw bytes straight to the shell, bypassing the sentinel.
   *
   * For the one thing a line editor cannot express: an interrupt has to reach
   * a *running* process, so it cannot wait for a prompt that will not come.
   */
  type(data: string): Promise<void> {
    return this.proc.stdin!.write(data);
  }

  get busy(): boolean {
    return this.waiting !== null;
  }

  resize(columns: number, rows: number): void {
    this.proc.resizeTerminal(columns, rows);
  }

  close(): Promise<void> {
    return this.proc.terminate();
  }
}

/**
 * The session's one shell, and how the page knows when a command has finished.
 *
 * ## Why not the prompt
 *
 * The obvious completion signal is `PS1`: set it to something recognisable and
 * watch for it. Measured, that does not work here — `bash -i` spawned with a
 * terminal attached emits **no prompt and no echo of what it was sent**. A
 * command runs and its output arrives; nothing else does. So the shell behaves
 * like a pipe with a pty bolted on, and anything built on prompt behaviour
 * would be building on sand.
 *
 * ## The sentinel
 *
 * Each command is sent with a second line after it:
 *
 * ```sh
 *   python transform.py
 *   printf '\x01%s\x01' "$?"
 * ```
 *
 * That is just a command, so it needs no prompt semantics to work, and it
 * carries the exit status back for free. The page strips the marker before
 * anything reaches the terminal, so the user never sees it.
 *
 * `\x01` is used because it cannot appear in ordinary program output — it is a
 * C0 control character no tool emits — so a script printing the marker's shape
 * by accident is not a case worth worrying about.
 */
import type { Runtime } from "./runtime";

const MARK = "";
/** Matches the sentinel and captures the exit status. */
const DONE = /(\d+)/;

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

  /** Raw bytes from someone typing. No sentinel, so no completion is reported. */
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

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
// `?raw` so the python stays python — embedded in a template literal the
// TypeScript lexer objects to its escape sequences, and every `\` has to be
// doubled by hand forever after.
import AWK_PY from "./tools/awk.py?raw";
import type { Runtime } from "./runtime";

/** Where the shims live. Ignored by the sync, so it never joins the folder. */
export const TOOLS = ".ajar/awk.py";

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
  /** Discards output. Set while the shell is being configured. */
  silent = false;
  /**
   * Bytes we wrote that the terminal may hand straight back.
   *
   * `stty -echo` is asked for at startup, and mostly holds — but a program
   * that touches termios on its way out can leave it on again, so some
   * commands come back echoed and others do not, with no pattern worth
   * guessing at. Rather than fight the terminal, whatever was written is
   * remembered and consumed off the front of the output if it reappears.
   */
  private echoed = "";
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
    // Turn the terminal's own echo off, and wait until it is actually off.
    //
    // The pty echoes what is written to it, so without this every command
    // appears twice — once where the page drew it, once where the terminal
    // repeated it — and the `printf` carrying the exit status lands on screen
    // too. Probing the shell directly suggested there was no echo at all; a
    // screenshot of the running page showed there plainly was. The screenshot
    // was right, which is the argument for taking one.
    //
    // Awaited rather than fired off, because until it lands the shell is still
    // echoing — and the thing it would echo is the first command somebody
    // runs. `silent` swallows the setup's own echo along the way.
    shell.silent = true;
    await shell.run("stty -echo 2>/dev/null");

    // `awk`, backed by python, because no awk is published for this runtime —
    // grep, sed and find are real ports; this one is not.
    //
    // An alias, and that is the only mechanism that works. Measured:
    //
    //   hi() { echo x; }   defines fine
    //   hi                 prints `x` and never returns
    //   /workspace/bin/awk prints correctly and never returns
    //   alias aw=…         works
    //
    // Calling a bash function in this build hangs — the output arrives and the
    // shell never comes back — and so does a script on PATH. An alias is plain
    // textual substitution with nothing to fork, so it survives. It needs
    // `expand_aliases` because this shell is not interactive in bash's sense.
    //
    // Absolute path: an alias is expanded wherever the user has cd'd to.
    await rt.write(TOOLS, AWK_PY);
    await shell.run("shopt -s expand_aliases");
    await shell.run(`alias awk='python /workspace/${TOOLS}'`);

    shell.silent = false;
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
    this.dropEcho();
    for (;;) {
      const found = DONE.exec(this.buffer);
      if (!found) break;
      // Everything before the marker is real output; the marker itself is
      // bookkeeping and never reaches the terminal.
      const before = this.buffer.slice(0, found.index);
      if (before && !this.silent) this.onOutput(before);
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
      if (!this.silent) this.onOutput(flushable);
      this.buffer = this.buffer.slice(flushable.length);
    }
  }

  /**
   * Consume an echo of what we sent, if one comes back.
   *
   * All three cases have to be distinguished, and a character-at-a-time
   * comparison cannot do it: `grep …` and its output `gamma …` share a first
   * letter, so matching greedily ate the real output's `g`.
   *
   *   buffer is a prefix of what we sent   -> still arriving, wait
   *   buffer starts with what we sent      -> a real echo, drop it
   *   neither                              -> no echo; leave the output alone
   *
   * The wait always ends, because the sentinel follows every command.
   */
  private dropEcho(): void {
    if (!this.echoed || !this.buffer) return;
    if (this.echoed.startsWith(this.buffer)) return;
    if (this.buffer.startsWith(this.echoed)) {
      this.buffer = this.buffer.slice(this.echoed.length);
    }
    this.echoed = "";
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
      const sent = `${command}\nprintf '\\001%s\\001' "$?"\n`;
      this.echoed = sent;
      this.proc.stdin!.write(sent).catch((e) => {
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

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
import SORT_PY from "./tools/sort.py?raw";
import TAIL_PY from "./tools/tail.py?raw";
import BOX_PY from "./tools/box.py?raw";
import EDIT_PY from "./tools/edit.py?raw";
import type { Runtime } from "./runtime";

/** Where the shims live. Ignored by the sync, so it never joins the folder. */
/**
 * Commands python stands in for, and why each one is here.
 *
 * `awk` has no port at all. `sort` and `tail` do — they are advertised by the
 * shipped coreutils and are not actually compiled into it, so `sort file`
 * answers "file: function/utility not found". Both are things people type
 * constantly, and `ls | sort` failing is not something to leave standing.
 *
 * Each costs a python start, measured at 214ms against 39ms for a native
 * command. That is worth paying for a command that otherwise does not exist,
 * and not worth paying for one that works.
 */
export const TOOLS = {
  awk: ".ajar/awk.py",
  sort: ".ajar/sort.py",
  tail: ".ajar/tail.py",
} as const;

/**
 * The rest, dispatched out of one file on its first argument.
 *
 * Separate files would be eleven writes and eleven aliases before the first
 * prompt; this is one of each. The shape is the same multi-call trick the
 * shipped coreutils uses — and unlike that one, everything listed here is
 * actually present.
 *
 * `diff`, `zip`, `unzip`, `tree` and `xargs` have no port at all. The rest are
 * advertised by coreutils and not compiled into it.
 */
export const BOXED = [
  // Shadows the shipped findutils binary deliberately: that one cannot spawn,
  // so `-exec` silently produces nothing, and it exits 1 even on success
  // because it cannot restore its working directory under WASIX.
  "find",
  "diff",
  "patch",
  "cmp",
  "tree",
  "du",
  "stat",
  "split",
  "xargs",
  "zip",
  "unzip",
  "bzip2",
  "bunzip2",
  "xz",
  "unxz",
  "hexdump",
  "xxd",
  "cal",
  "rev",
  "which",
  "sha256sum",
  "sha1sum",
  "md5sum",
] as const;

export const BOX = ".ajar/box.py";

/**
 * The editor, aliased as `nano` and `edit`.
 *
 * `nano` because that is what people type, and neither nano nor vim can be
 * installed — both exist only inside packages the SDK cannot fetch. It is not
 * nano: no syntax highlighting, no undo, no multiple buffers. The keys match
 * so the muscle memory does.
 */
export const EDIT = ".ajar/edit.py";
export const EDITORS = ["nano", "edit"] as const;

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
  /** False once bash has exited; this shell can serve nothing more. */
  alive = true;
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
    void shell.watchForExit();
    // Echo off for the shell — and only for the shell.
    //
    // This looked unreliable for a long time: some commands came back echoed
    // and others did not. They were two different things. bash saves and
    // restores the terminal around a foreground job, so what *the shell*
    // reads is not echoed, while what a *running program* reads is. Which is
    // exactly the division wanted: the command this page writes stays off the
    // screen, and anything typed into `cat` appears because the terminal put
    // it there.
    //
    // Awaited rather than fired off: until it lands the shell still echoes,
    // and the thing it would echo is the first command somebody runs.
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
    const sources = { awk: AWK_PY, sort: SORT_PY, tail: TAIL_PY };
    await shell.run("shopt -s expand_aliases");
    for (const name of Object.keys(TOOLS) as (keyof typeof TOOLS)[]) {
      await rt.write(TOOLS[name], sources[name]);
    }
    await rt.write(BOX, BOX_PY);
    await rt.write(EDIT, EDIT_PY);

    // One `run` for every alias rather than one each: each is a round trip
    // through the pty, and fourteen of them is a visible pause before the
    // first prompt.
    const aliases = [
      ...Object.keys(TOOLS).map(
        (name) => `alias ${name}='python /workspace/${TOOLS[name as keyof typeof TOOLS]}'`,
      ),
      ...BOXED.map((name) => `alias ${name}='python /workspace/${BOX} ${name}'`),
      ...EDITORS.map((name) => `alias ${name}='python /workspace/${EDIT}'`),
    ];
    await shell.run(aliases.join("; "));

    shell.silent = false;
    return shell;
  }

  /** Everything the shell says, with the sentinel taken out of it. */
  private async drain(): Promise<void> {
    for await (const chunk of this.proc.stdout!) {
      this.absorb(this.decoder.decode(chunk, { stream: true }));
    }
  }

  /**
   * Notice when bash exits.
   *
   * `wait()` and not the end of the output stream: interrupting a command
   * takes the shell down with it here, and the stream stays open afterwards,
   * so a shell that could serve nothing more still looked healthy and every
   * command sent to it hung forever.
   */
  private async watchForExit(): Promise<void> {
    try {
      await this.proc.wait({ check: false });
    } catch {
      // Exiting badly is still exiting.
    }
    this.alive = false;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.({ exitCode: 130 });
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
      // The command is over, so anything still expected as an echo is not
      // coming — holding the tail past this point would swallow real output.
      this.echoed = "";
      const done = this.waiting;
      this.waiting = null;
      done?.({ exitCode: Number(found[1]) });
    }
    // Only a partial marker is held back, which would otherwise render as a
    // control character for an instant.
    //
    // Not the echo. Holding the tail until an expected echo arrived seemed
    // tidier and was much worse: the echo often never comes — bash silences
    // its own input — so everything after it was held forever and a running
    // `cat` printed nothing at all. A split echo showing for one frame is a
    // far smaller price than swallowing output.
    const marker = this.buffer.lastIndexOf(MARK);
    const flushable = marker === -1 ? this.buffer : this.buffer.slice(0, marker);
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
    // Anywhere, not only at the front. The previous command can leave a
    // trailing newline in the buffer, and requiring position zero meant the
    // echo was missed and every command appeared twice from then on.
    const at = this.buffer.indexOf(this.echoed);
    if (at !== -1) {
      // The line ending the terminal chose goes with it, whatever it was.
      let end = at + this.echoed.length;
      while (this.buffer[end] === "\r" || this.buffer[end] === "\n") end += 1;
      this.buffer = this.buffer.slice(0, at) + this.buffer.slice(end);
      this.echoed = "";
    }
    // Not found yet: it may still be arriving a chunk at a time. `absorb`
    // holds back the tail until this resolves, and the sentinel clears it
    // either way, so nothing is held for longer than one command.
  }

  /**
   * Run one command and resolve when it finishes.
   *
   * Rejects if another is already running: two commands interleaved in one
   * shell would return their sentinels in an order nothing can attribute.
   */
  run(command: string): Promise<Finished> {
    if (!this.alive) return Promise.reject(new Error("the shell has exited"));
    if (this.waiting) return Promise.reject(new Error("a command is already running"));
    return new Promise<Finished>((resolve, reject) => {
      this.waiting = resolve;
      // One line, joined with `;` rather than a newline.
      //
      // Sent as a second line, the sentinel is sitting in the terminal's input
      // buffer when the command starts — so anything that reads stdin eats it.
      // `cat` with no arguments consumed it, printed it as data, and then
      // waited forever for more, with nothing left to mark the command
      // finished. On one line bash parses both before running either, and the
      // command's stdin is the terminal, where it belongs.
      //
      // A trailing `&` is the exception: `cmd &; printf` is a syntax error,
      // while `cmd & printf` is not.
      const trimmed = command.trimEnd();
      const joiner = trimmed.endsWith("&") ? " " : "; ";
      const line = `${trimmed}${joiner}printf '\\001%s\\001' "$?"`;
      // Without the newline. The terminal echoes CRLF where this writes LF, so
      // including it meant the two strings never matched and every command
      // after the first foreground job appeared twice.
      this.echoed = line;
      this.proc.stdin!.write(`${line}\n`).catch((e) => {
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

  /** Close the guest's stdin, which is EOF to whatever is reading it. */
  closeStdin(): Promise<void> {
    return this.proc.stdin!.close();
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

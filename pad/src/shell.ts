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
 * a control character no ordinary tool emits — with a token of this shell's
 * own beside it. That needs no prompt to work and carries the exit status
 * back for free. The marker is stripped before anything reaches the screen,
 * including one split across two chunks.
 *
 * The token is random and never shown: a program that printed `\x01130\x01`
 * ended its own command as far as the page could tell — "exit 130", Run back
 * to Run, and the folder saved half written while it went on running.
 */
// `?raw` so the python stays python — embedded in a template literal the
// TypeScript lexer objects to its escape sequences, and every `\` has to be
// doubled by hand forever after.
import SORT_PY from "./tools/sort.py?raw";
import TAIL_PY from "./tools/tail.py?raw";
import BOX_PY from "./tools/box.py?raw";
import EDIT_PY from "./tools/edit.py?raw";
import SITE_PY from "./tools/sitecustomize.py?raw";
import PADFETCH_PY from "./tools/_padfetch.py?raw";
import CURL_PY from "./tools/curl.py?raw";
import GO_PY from "./tools/go.py?raw";
import CXX_PY from "./tools/cxx.py?raw";
// Built by scripts/build-awk.mjs, and committed: a URL to it in the build, so
// its bytes are one fetch the browser caches rather than part of the bundle.
import AWK_WASM from "./tools/awk.wasm?url";
import { CLANG_ALIASES, CXX_COMMANDS } from "./toolchains";
import type { Runtime } from "./runtime";

/** Where the shims live. Ignored by the sync, so it never joins the folder. */
/**
 * Commands python stands in for, and why each one is here.
 *
 * `sort` and `tail` are advertised by the shipped coreutils and are not
 * actually compiled into it, so `sort file` answers "file:
 * function/utility not found". Both are things people type constantly, and
 * `ls | sort` failing is not something to leave standing.
 *
 * Each costs a python start, measured at 214ms against 39ms for a native
 * command. That is worth paying for a command that otherwise does not exist,
 * and not worth paying for one that works.
 */
export const TOOLS = {
  sort: ".ajar/sort.py",
  tail: ".ajar/tail.py",
} as const;

/**
 * awk: The One True Awk — Kernighan's, the awk of the AWK book — built for
 * this runtime by scripts/build-awk.mjs, as no awk is published for it. A
 * WASIX program, so `system()`, `print | "cmd"` and `"cmd" | getline` start
 * their commands as any awk's do. It replaced a translator into python that
 * said of itself "it is not awk", and was right: ranges, `print length`,
 * `2^10` and `print > "file"` were all quietly wrong in it.
 *
 * And it starts as fast as a native command: 2 to 6 ms an invocation in the
 * browser against 85 for a python shim (20 October). Its limit is recursion,
 * about 500 calls deep before the browser's own stack runs out — a trap, exit
 * 11 and no message, and nothing of awk's memory written over (its stack is
 * first in memory, 8 MiB of it). Native, the same awk gets about 6,000 deep
 * on an 8 MiB stack, and mawk refuses 1,000.
 */
export const AWK = ".ajar/awk.wasm";
let awkFetched: Promise<Uint8Array> | null = null;
/** Fetched once a page — asked again only after a failure — and written into every shell's sandbox. */
function awkWasm(): Promise<Uint8Array> {
  awkFetched ??= fetch(AWK_WASM).then(async (res) => {
    if (!res.ok) throw new Error(`awk.wasm: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  });
  awkFetched.catch(() => (awkFetched = null));
  return awkFetched;
}

/**
 * The rest, dispatched out of one file on its first argument.
 *
 * Separate files would be twenty-three writes and twenty-three aliases before
 * the first prompt; this is one of each. The shape is the same multi-call trick the
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

/**
 * What every python imports first, from a directory of its own on PYTHONPATH
 * so none of the tools beside it can be imported by accident.
 */
export const SITE = ".ajar/site/sitecustomize.py";

/**
 * HTTP through the browser (fetch-bridge.ts): the sandbox's half, beside
 * sitecustomize so that it and the tools can import it, and `curl` — `wget`
 * too — made with it. No curl is published for this runtime, and the
 * sandbox's own sockets reach PyPI alone.
 */
export const PADFETCH = ".ajar/site/_padfetch.py";
export const CURL = ".ajar/curl.py";

/** Where pip installs, inside the folder rather than the interpreter. */
export const DEPS = ".deps";
/**
 * Wasmer's index of packages built for this runtime — numpy, pandas,
 * matplotlib, pillow — which PyPI has no wheels of. Asked beside PyPI.
 */
export const WHEELS = "https://python-registry.wasmer.app/simple/";

/**
 * go and gofmt, through a shim that hands them absolute paths: the Go the pad
 * fetches on first use cannot open a relative one. See tools/go.py. Aliased
 * whether or not Go has been fetched yet, so the line that names it is what
 * fetches it.
 */
export const GO = ".ajar/go.py";
/**
 * clang++, g++ and c++: the C++ compiler's steps, run one at a time — a WASI
 * compiler cannot start its own. See tools/cxx.py. Aliased before it is
 * fetched, as Go is.
 */
export const CXX = ".ajar/cxx.py";
export const EDITORS = ["nano", "edit"] as const;

const MARK = "";

/** A shell's marker token: random, so nothing a program prints can be its sentinel. */
function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// `$'...'` — ANSI-C quoting. Inside ordinary single quotes bash takes `\001`
// as four literal characters and the marker never appears, which reads exactly
// like the prompt not being printed at all.

export interface Finished {
  exitCode: number;
  /** Ended by `interrupt()`, so its status is the signal's, not the program's. */
  interrupted?: boolean;
  /**
   * Not stopped by the interrupt, so ended with the shell — and what it
   * started may still be running: see `Shell.interrupt`.
   */
  forced?: boolean;
}

/**
 * The runtime's own word when a pipe's reader leaves first, taken out of what
 * reaches the terminal.
 *
 * `awk … | head -1` printed its line and then, on a slow machine — CI's Mac on
 * 11 October — `Program recieved termination signal: Broken pipe` and a run of
 * `Program recieved fatal signal: Aborted`, typo and all: the runtime ending
 * the writer at its next write, and saying so. A real tool dies of SIGPIPE
 * without a word, which is what the pad's own tools now do too. So the broken
 * pipe notice goes, always; an abort notice goes only after one, in the same
 * command — a program that aborts by itself is still told about.
 *
 * Text arrives in pieces, so a piece that could be the start of a notice is
 * held until its line is whole, and never long: a program that prints
 * "Program re" and waits gets it on screen in 50 ms (`HOLD_MS`).
 */
export class RuntimeNotices {
  private held = "";
  private brokenPipe = false;
  /** In a Node stack, past the program's own frames: the runtime's, left out. */
  private runtimeFrames = false;
  /** After a Node syntax error: the parser's own fields, left out. */
  private parserDump = false;

  /** Text to show now, of what has arrived. */
  push(text: string): string {
    let rest = this.held + text;
    this.held = "";
    let out = "";
    for (;;) {
      const nl = rest.indexOf("\n");
      if (nl === -1) break;
      const line = rest.slice(0, nl + 1);
      rest = rest.slice(nl + 1);
      const bare = line.replace(/\r?\n$/, "");
      if (bare === BROKEN_PIPE) {
        this.brokenPipe = true;
        continue;
      }
      if (bare === ABORTED && this.brokenPipe) continue;
      const node = this.nodeLine(bare);
      if (node === null) continue;
      if (node !== bare) {
        out += node + line.slice(bare.length);
        continue;
      }
      // The runtime's own spelling, mended where people read it.
      out += bare.startsWith(NOTICE_START) ? line.replace(NOTICE_START, "Program received ") : line;
    }
    // Held until its line is whole: the start of a notice, or of a stack
    // frame or the loader's line, which are taken out or rewritten whole.
    if (rest && (this.parserDump || NOTICE_START.startsWith(rest) || rest.startsWith(NOTICE_START) || NODE_FAILED.startsWith(rest) || /^\s+(a|at( .*)?)?$/.test(rest) || "SyntaxError".startsWith(rest) || rest.startsWith("SyntaxError"))) this.held = rest;
    else out += rest;
    return out;
  }

  /**
   * A line of a Node error as it should read. The runtime's node shows its
   * own machinery around a program's error: a line about its loader, then the
   * program's frames as `eval at wasmer_napi_compile_function (…), <anonymous>:5:3`
   * — three lines past where they are, for the wrapper it compiles each file
   * in — and then a dozen of its loader's frames and the browser's
   * (`wasm-function[6457]`, `wasm_bindgen…`). Review of 17 October, M4. What
   * is left is the error and the program's frames, at their own lines. Null
   * for a line left out.
   */
  private nodeLine(bare: string): string | null {
    if (bare === NODE_FAILED) return null;
    // A syntax error, as the runtime's node says one: a line past where it
    // is — counted in the wrapper it parses each file in — and then the
    // parser's own `pos`, `loc` and `raisedAt`, which say nothing a person
    // needs. `let b = ;` on line 1 was "(2:8)" (review of 18 October, N3).
    const syntax = /^(SyntaxError: .*) \((\d+):(\d+)\)( \{)?$/.exec(bare);
    if (syntax) {
      this.parserDump = true;
      return `${syntax[1]} (${Math.max(1, Number(syntax[2]) - 1)}:${syntax[3]})`;
    }
    // The parser's own frames come between, and go as the runtime's do.
    if (this.parserDump && !/^\s+at /.test(bare)) {
      if (/^\s+(pos|loc|raisedAt): /.test(bare)) return null;
      this.parserDump = false;
      if (bare === "}") return null;
    }
    if (!/^\s+at /.test(bare)) {
      this.runtimeFrames = false;
      return bare;
    }
    if (this.runtimeFrames) return null;
    // The program's place first, so what is left to tell the runtime's frames
    // by is not the address every frame carries in its `eval at`.
    const frame = bare.replace(/eval at wasmer_napi_compile_\w+ \(.*?\), <anonymous>:(\d+):(\d+)/, (_, line: string, column: string) => `<anonymous>:${Math.max(1, Number(line) - 3)}:${column}`);
    if (/\/vendor\/wasmer\/|wasm-function\[|^\s+at (wasm_bindgen|real \(|Module\.|TracingChannel\.|wrapModuleLoad|Function\.executeUserEntryPoint|node:internal)/.test(frame)) {
      this.runtimeFrames = true;
      return null;
    }
    return frame;
  }

  /** Whether part of a line is being held. */
  get holding(): boolean {
    return this.held !== "";
  }

  /** What is held, now: it was not a notice after all, or not yet. */
  flush(): string {
    const held = this.held;
    this.held = "";
    return held.startsWith(NOTICE_START) ? held.replace(NOTICE_START, "Program received ") : held;
  }

  /** A command is over: the next one's abort is its own. */
  end(): void {
    this.brokenPipe = false;
    this.runtimeFrames = false;
  }
}

const NOTICE_START = "Program recieved ";
const BROKEN_PIPE = "Program recieved termination signal: Broken pipe";
const ABORTED = "Program recieved fatal signal: Aborted";
/** The runtime's node, before an uncaught error: its loader, not the program. */
const NODE_FAILED = "Failed to execute builtin 'internal/main/run_main_module':";
const HOLD_MS = 50;

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
  /** This shell's sentinel: `\x01<token>:<status>\x01`, and the start of one. */
  private readonly token = token();
  private readonly done = new RegExp(`${MARK}${this.token}:(\\d+)${MARK}`);
  private readonly opening = `${MARK}${this.token}:`;
  private notices = new RuntimeNotices();
  private releasing: ReturnType<typeof setTimeout> | null = null;
  /** While a `query` runs, what the shell says is collected here, not shown. */
  private captured: string | null = null;
  private waiting: ((f: Finished) => void) | null = null;
  /** Set by `interrupt()` until the command it interrupted is over. */
  private interrupted = false;
  /** Set when an interrupt was not enough and the shell was ended for it. */
  private forced = false;
  /** Set by `close()`; nothing this shell says afterwards is shown. */
  private closed = false;
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
    // Asked for now, while the shell starts. A page that cannot fetch it
    // still gets a terminal; `awk` then says it is not there.
    const awk = awkWasm().catch((e: Error) => {
      console.warn(`awk is missing from this shell: ${e.message}`);
      return null;
    });
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

    // The commands the pad provides itself — python shims, and awk, a
    // program of our own (AWK) — each an alias to its file.
    //
    // An alias, and that is the only mechanism that works. Measured:
    //
    //   hi() { echo x; }   defines fine
    //   hi                 prints `x` and never returns
    //   /workspace/bin/awk prints correctly and never returns
    //   alias aw=…         works
    //
    // Calling a bash function hung in the bash this replaced, sharrattj/bash —
    // the output arrived and the shell never came back; wasmer/bash 1.0.25
    // runs one (packages/catalogue.ts) — and so does a script on PATH. An alias is plain
    // textual substitution with nothing to fork, so it survives. It needs
    // `expand_aliases` because this shell is not interactive in bash's sense.
    //
    // Absolute path: an alias is expanded wherever the user has cd'd to.
    const sources = { sort: SORT_PY, tail: TAIL_PY };
    await shell.run("shopt -s expand_aliases");
    for (const name of Object.keys(TOOLS) as (keyof typeof TOOLS)[]) {
      await rt.write(TOOLS[name], sources[name]);
    }
    const awkBytes = await awk;
    if (awkBytes) await rt.writeBytes(AWK, awkBytes);
    await rt.write(BOX, BOX_PY);
    await rt.write(EDIT, EDIT_PY);
    await rt.write(SITE, SITE_PY);
    await rt.write(PADFETCH, PADFETCH_PY);
    await rt.write(CURL, CURL_PY);
    await rt.write(GO, GO_PY);
    await rt.write(CXX, CXX_PY);

    // One `run` for every alias rather than one each: each is a round trip
    // through the pty, and fourteen of them is a visible pause before the
    // first prompt.
    const aliases = [
      ...Object.keys(TOOLS).map(
        (name) => `alias ${name}='python /workspace/${TOOLS[name as keyof typeof TOOLS]}'`,
      ),
      // A program run by its path, which this bash does without a hang.
      `alias awk='/workspace/${AWK}'`,
      ...BOXED.map((name) => `alias ${name}='python /workspace/${BOX} ${name}'`),
      ...EDITORS.map((name) => `alias ${name}='python /workspace/${EDIT}'`),
      `alias curl='python /workspace/${CURL}'`,
      // pip installs a `flask` script under .deps/bin, which the shell does
      // not look in, and a script on PATH hangs this bash anyway (above).
      "alias flask='python -m flask'",
      `alias wget='python /workspace/${CURL} --as-wget'`,
      ...["go", "gofmt"].map((name) => `alias ${name}='python /workspace/${GO} ${name}'`),
      ...CLANG_ALIASES.map(([name, to]) => `alias ${name}='${to}'`),
      ...CXX_COMMANDS.map((name) => `alias ${name}='python /workspace/${CXX}'`),
      // No `clear` ships in any package here, and it is the first thing
      // people type to tidy a terminal. It only has to say two sequences.
      `alias clear='printf "\\033[H\\033[2J\\033[3J"'`,
      // Where `pip install` puts things, and where python looks for them.
      //
      // Neither is a convenience. python's own site-packages is under a
      // read-only /nix/store path: a plain `pip install` reports success and
      // the package is then not importable, because the write landed in a
      // layer that does not outlive the process. PIP_TARGET sends it to the
      // folder instead, which is somewhere real. Not saved with the pad since
      // 18 October — numpy alone is over a thousand files — so what reaches
      // whoever opens the link is requirements.txt, which a typed install adds
      // to (App.recordInstalled) and Run installs from.
      `export PIP_TARGET=/workspace/${DEPS}`,
      `export PYTHONPATH=/workspace/${DEPS}:/workspace/${SITE.slice(0, SITE.lastIndexOf("/"))}`,
      // No progress bar, because drawing one starts a thread — see
      // tools/sitecustomize.py. Measured on production on 27 September:
      // `pip install requests` froze the page for good with it, and finished
      // in 6 s without it — the same freeze the user guide put down to
      // installing several dependencies at once.
      //
      // And no warning about running as root, or check for a newer pip: the
      // first is true of every install here and says nothing, the second is a
      // network request and a notice on every one.
      //
      // And no cache: with no home directory pip kept it in the folder, as
      // `~/.cache/pip` — see the `~` rule in sync.ts.
      "export PIP_PROGRESS_BAR=off PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1",
      // numpy, pandas, matplotlib and the rest that are not pure python:
      // Wasmer builds them for this runtime and keeps them in an index of its
      // own, beside PyPI, which pip asks too. The egress endpoint lets it
      // through (deploy/wisp-server.mjs). See docs/dev/pad.md, "numpy".
      //
      // Those wheels are tagged wasix_wasm32 and this python calls itself
      // wasi_0_0_0_wasm32, so pip is told the platform, and pip then takes
      // wheels only. Without it, `pip install numpy` passed over the wheel and
      // spent two minutes failing to compile the source (16 October). The
      // cost: a package published only as source does not install, which is
      // rare, and most of those would not build here anyway.
      `export PIP_EXTRA_INDEX_URL=${WHEELS} PIP_PLATFORM=wasix_wasm32 PIP_ONLY_BINARY=:all:`,
      // matplotlib draws without a window, and keeps its font cache beside the
      // packages rather than building it again for every program.
      `export MPLBACKEND=Agg MPLCONFIGDIR=/workspace/${DEPS}/.matplotlib`,
      // A home, which the sandbox has none of: `~` was `/`, and Python's
      // expanduser('~') gave back '~'. Under /tmp, so what tools keep there
      // — caches, history — is the sandbox's and never the pad's.
      "mkdir -p /tmp/home && export HOME=/tmp/home",
      // Python 3.13's new prompt needs a terminfo database this runtime does
      // not find, so `python` on its own opened with "warning: can't use
      // pyrepl: setupterm: could not find terminfo database" and then used
      // the basic prompt anyway. Asked for directly, the basic prompt comes
      // without the warning.
      "export PYTHON_BASIC_REPL=1",
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
    waiting?.({ exitCode: 130, interrupted: this.interrupted, forced: this.forced });
  }

  private absorb(text: string): void {
    this.buffer += text;
    this.dropEcho();
    for (;;) {
      const found = this.done.exec(this.buffer);
      if (!found) break;
      // Everything before the marker is real output; the marker itself is
      // bookkeeping and never reaches the terminal.
      const before = this.buffer.slice(0, found.index);
      if (before) this.emit(before);
      this.buffer = this.buffer.slice(found.index + found[0].length);
      // The command is over, so anything still expected as an echo is not
      // coming — holding the tail past this point would swallow real output.
      this.echoed = "";
      const done = this.waiting;
      this.waiting = null;
      const interrupted = this.interrupted;
      if (interrupted) {
        this.interrupted = false;
        // Before anything else is written: see `interrupt()`.
        void this.proc.stdin!.write("\n").catch(() => {});
      }
      // Whatever was held is shown before the command is over, so what a
      // query captures is all of it.
      if (this.releasing) clearTimeout(this.releasing);
      this.releasing = null;
      this.show(this.notices.flush());
      this.notices.end();
      done?.({ exitCode: Number(found[1]), interrupted });
    }
    // Only a partial marker is held back, which would otherwise render as a
    // control character for an instant.
    //
    // Not the echo. Holding the tail until an expected echo arrived seemed
    // tidier and was much worse: the echo often never comes — bash silences
    // its own input — so everything after it was held forever and a running
    // `cat` printed nothing at all. A split echo showing for one frame is a
    // far smaller price than swallowing output.
    // Only what could still become this shell's sentinel: a `\x01` a program
    // printed is its output, shown now rather than held to the command's end.
    const marker = this.buffer.lastIndexOf(MARK);
    const tail = marker === -1 ? "" : this.buffer.slice(marker);
    const partial = tail !== "" && (this.opening.startsWith(tail) || new RegExp(`^${this.opening}\\d*$`).test(tail));
    const flushable = partial ? this.buffer.slice(0, marker) : this.buffer;
    if (flushable) {
      this.emit(flushable);
      this.buffer = this.buffer.slice(flushable.length);
    }
  }

  private emit(text: string): void {
    this.show(this.notices.push(text));
    if (this.releasing) clearTimeout(this.releasing);
    this.releasing = this.notices.holding
      ? setTimeout(() => {
          this.releasing = null;
          this.show(this.notices.flush());
        }, HOLD_MS)
      : null;
  }

  private show(text: string): void {
    if (!text || this.closed) return;
    if (this.captured !== null) this.captured += text;
    else if (!this.silent) this.onOutput(text);
  }

  /**
   * Run a command for the page's own use and hand back what it printed,
   * without any of it reaching the screen. Nothing if a command is running.
   */
  async query(command: string): Promise<string> {
    if (!this.alive || this.waiting) return "";
    this.captured = "";
    try {
      await this.run(command);
      return this.captured ?? "";
    } finally {
      this.captured = null;
    }
  }

  /**
   * What `word` could complete to, asked of bash itself so it follows the
   * shell's own directory, aliases and builtins.
   *
   * Not `compgen -c`: it answers nothing here. The package commands are
   * files in /usr/bin and /bin like anywhere else, but this filesystem gives
   * them no execute bit, and that is what `-c` looks for. So commands are
   * the directories' files by name, plus aliases (the shims), builtins and
   * keywords. Directories come back with a trailing `/`, as bash shows them.
   */
  async complete(word: string, asCommand: boolean): Promise<string[]> {
    const w = `'${word.replaceAll("'", `'\\''`)}'`;
    const script = asCommand
      ? `compgen -abk -- ${w}; compgen -f -- '/usr/bin/'${w}; compgen -f -- '/bin/'${w}`
      : `compgen -f -- ${w} | while IFS= read -r f; do if [ -d "$f" ]; then printf '%s/\\n' "$f"; else printf '%s\\n' "$f"; fi; done`;
    const found = (await this.query(script))
      .split(/\r?\n/)
      .map((s) => (asCommand ? s.replace(/^\/(usr\/)?bin\//, "") : s))
      .filter(Boolean);
    return [...new Set(found)].sort();
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
      // The command goes through `eval`, as one single-quoted word, so nothing
      // in it can reach the sentinel. Written straight onto the line, a `#`
      // commented the `printf` out, and an unclosed quote or `if` swallowed it
      // into the command — either way the marker never came and the terminal
      // hung until ctrl-c. Now the outer line always parses: a comment is an
      // empty command, a syntax error is `eval` failing with status 2, and the
      // sentinel follows both. `eval` runs in this shell, so `cd`, variables,
      // aliases and a trailing `&` behave exactly as typed.
      //
      // `2>&1` because this terminal is two pipes, not one: the SDK keeps
      // stderr apart even with a pty attached, and only stdout is read. Every
      // error went nowhere — a traceback was a bare "exit 1", `ls` of a
      // missing folder said nothing — until 27 September. Joined here, errors
      // arrive in the same stream as the output and the sentinel, so they
      // land in order and before the prompt. Reading stderr as a second
      // stream could not promise that. A redirect typed in the command still
      // wins, as it would in a terminal: `2>/dev/null` silences, `>file`
      // leaves errors on screen.
      const quoted = `'${command.trimEnd().replaceAll("'", `'\\''`)}'`;
      const line = `eval ${quoted} 2>&1; printf '\\001${this.token}:%s\\001' "$?"`;
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
   * Stop the command in the foreground the way a terminal does: ctrl-c
   * through the pty, which signals the program and leaves bash standing.
   *
   * This used to end the shell instead, and that never stopped anything but
   * bash. Measured on 27 September: after `terminate()` or `kill()`, a python
   * loop was still printing into the terminal a minute later, and one that did
   * not print went on burning a core unseen. The signal stopped every program
   * tried within 30 ms — a pure spin, `time.sleep`, `input()`, a print loop,
   * `cat`, `sleep` — and bash kept its directory and variables.
   *
   * A program killed in the middle of reading leaves its read pending on the
   * terminal, and that read takes the next line written: the command after a
   * ctrl-c at `input()` was swallowed and never ran. So once the interrupted
   * command is over, one newline goes first, to be taken instead — harmless to
   * bash when nothing was reading.
   *
   * When the signal lands on bash itself, in a builtin such as `read` or a
   * `while` loop, bash abandons the whole line, sentinel included, and nothing
   * would ever say the command ended. Anything still running after a second
   * and a half is ended the old way, with the shell. That is clean for bash's
   * own builtins; a program that took no notice of the signal — `nano`, which
   * has the terminal raw — outlives it, and `close()` stops listening to it.
   * So does one with a process of its own still running: the signal goes to
   * that one here, not to the program (measured on 16 October, with
   * `subprocess.Popen(["sleep", "100"])`). The program goes on unseen, and a
   * server goes on holding its port, so the console says so (`forced`).
   */
  interrupt(): void {
    const waiting = this.waiting;
    if (!waiting || !this.alive || this.interrupted) return;
    this.interrupted = true;
    this.proc.stdin!.write("\x03").catch(() => {});
    setTimeout(() => {
      if (this.waiting !== waiting) return;
      this.forced = true;
      this.close().catch(() => {});
    }, 1500);
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

  /**
   * End the shell, and stop listening to it.
   *
   * `terminate()` ends bash and not what bash started, and whatever it leaves
   * behind still writes into this shell's output: a stopped `nano` repainted
   * itself over the fresh prompt for as long as the page was open. By the time
   * this is called the page has moved on, so none of it is shown.
   */
  close(): Promise<void> {
    this.closed = true;
    // Gone as far as anyone asking is concerned, from now: a shell replaced
    // for a language just fetched is handed on before bash has finished dying.
    this.alive = false;
    return this.proc.terminate();
  }
}

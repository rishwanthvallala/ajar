/**
 * A terminal: its screen, the console that is its prompt and line editor
 * (console.ts), and the bash behind it (shell.ts).
 *
 * A pad has as many as somebody opens — a server in one, `curl` at it in
 * another — all in the one sandbox, so they share its files and its network,
 * and a port one listens on is one the others can reach. Each has its own
 * bash: its own directory, variables and history. Until 16 October there was
 * one, and a server running in it was the end of typing anything else.
 *
 * The page's own: they are not shared with the others on the pad, who each
 * have their own sandbox and their own terminals.
 */
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";

import { Console } from "./console";
import { IMAGE_OSC } from "./images";
import { type Place, placesIn } from "./problems";
import type { Runtime } from "./runtime";
import { type Finished, Shell } from "./shell";

export interface SessionHooks {
  runtime: () => Promise<Runtime>;
  /** Before a typed line runs: the languages it needs, and the fresh shell that needs. */
  prepare: (session: TerminalSession, command: string) => Promise<Shell | null>;
  onBusy: (session: TerminalSession, busy: boolean) => void;
  onFinished: (session: TerminalSession, finished: Finished | null) => void;
  /** How many languages the sandbox has had installed: a shell opened before one does not see it. */
  installs: () => number;
  /** A program asked for an image to be shown (`images.ts`): the escape's text. */
  onImage?: (data: string) => void;
  /** The pad file a path in the output is, or null when it is none of the pad's. */
  place?: (path: string) => string | null;
  /** A file and line in the output, clicked. */
  openPlace?: (place: Place) => void;
  /** Whether the runtime has started. */
  ready: () => boolean;
}

/** The most of a command's output kept for after it (`lastOutput`): its end. */
export const OUTPUT_KEPT = 64 * 1024;

export class TerminalSession {
  readonly console: Console;
  /**
   * What the shell printed for the command that ran last, typed or Run's —
   * its end, past [`OUTPUT_KEPT`]. For the errors in it (problems.ts) and the
   * pad's saved last run.
   */
  lastOutput = "";
  private recording: string[] | null = null;
  private recorded = 0;
  shell: Shell | null = null;
  private opening: Promise<Shell> | null = null;
  cols: number;
  rows: number;
  /** `installs()` when this shell opened. */
  shellInstalls = -1;

  constructor(
    /** 1, 2, 3 — what its tab says, kept when one before it is closed. */
    readonly number: number,
    readonly element: HTMLElement,
    readonly term: XTerm,
    readonly fit: FitAddon,
    private readonly hooks: SessionHooks,
  ) {
    this.cols = term.cols;
    this.rows = term.rows;
    // plt.show(), and anything else that prints the pad's image escape: shown
    // over the editor, and taken off the screen rather than printed as junk.
    term.parser.registerOscHandler(IMAGE_OSC, (data) => {
      hooks.onImage?.(data);
      return true;
    });
    // A traceback's file and line, a compiler's, a stack frame's: a link to
    // the place, when it is one of the pad's files.
    term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const links = placesIn(text).flatMap((found) => {
          const path = hooks.place?.(found.path);
          if (!path) return [];
          const place: Place = { path, line: found.line, ...(found.column ? { column: found.column } : {}) };
          return [{
            range: { start: { x: found.start + 1, y }, end: { x: found.end, y } },
            text: text.slice(found.start, found.end),
            decorations: { pointerCursor: true, underline: true },
            activate: () => hooks.openPlace?.(place),
          }];
        });
        callback(links.length ? links : undefined);
      },
    });
    // The console owns the prompt, the echo and the line editing — bash
    // provides none of them. It asks for a shell only when a line is entered,
    // and completes against one only if it is already open.
    this.console = new Console({ write: (d) => term.write(d) }, {
      shellFor: () => this.ensureShell(),
      onFinished: (finished) => hooks.onFinished(this, finished),
      openShell: () => (this.shell?.alive ? this.shell : null),
      columns: () => this.cols,
      onBusy: (busy) => {
        // Each command's output, from its start to its end, for after it.
        if (busy) {
          this.recording = [];
          this.recorded = 0;
        } else if (this.recording) {
          this.lastOutput = this.recording.join("").slice(-OUTPUT_KEPT);
          this.recording = null;
        }
        hooks.onBusy(this, busy);
      },
      fullScreen: () => term.buffer.active.type === "alternate",
      prepare: (command) => hooks.prepare(this, command),
      ready: () => hooks.ready(),
    });
    term.onData((data) => this.console.handle(data));
    // Keys the page takes from the terminal, left to bubble to its own
    // handler: Ctrl/⌘-Enter runs the file, as anywhere else on the page, and
    // F6 leaves for the next part of it.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) return false;
      if (e.key === "F6") return false;
      return true;
    });
    term.onResize(({ cols, rows }) => {
      this.cols = cols;
      this.rows = rows;
      void this.shell?.resize(cols, rows);
    });
  }

  get busy(): boolean {
    return this.console.busy;
  }

  /** Whether a shell opened before the latest language arrived, and so cannot see it. */
  get stale(): boolean {
    return this.shell !== null && this.shellInstalls < this.hooks.installs();
  }

  write(text: string): void {
    this.term.write(text);
  }

  /** What the shell prints: onto the screen, and kept while a command runs. */
  private output(text: string): void {
    this.term.write(text);
    if (!this.recording) return;
    this.recording.push(text);
    this.recorded += text.length;
    // Only the end is wanted, and a loop printing for minutes is megabytes.
    if (this.recorded > OUTPUT_KEPT * 2) {
      const end = this.recording.join("").slice(-OUTPUT_KEPT);
      this.recording = [end];
      this.recorded = end.length;
    }
  }

  start(): void {
    this.console.start();
  }

  ensureShell(): Promise<Shell> {
    // A shell that has exited cannot be reused. ctrl-d ends it, as does a
    // ctrl-c that a signal could not answer, so this is an ordinary path, not
    // an error case.
    if (this.shell && !this.shell.alive) this.shell = null;
    if (this.shell) return Promise.resolve(this.shell);
    // One opening at a time. The first shell is opened at load, so a Run
    // pressed while that is still in flight would otherwise start a second
    // bash and leave one of them orphaned.
    this.opening ??= (async () => {
      try {
        const rt = await this.hooks.runtime();
        const installs = this.hooks.installs();
        this.shell = await Shell.open(rt, { columns: this.cols, rows: this.rows }, (t) => this.output(t));
        this.shellInstalls = installs;
        return this.shell;
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  /**
   * A fresh shell where the old one was, with what it had exported. Shell
   * variables that were not exported, functions and aliases of the person's
   * own go with the old one.
   */
  async replaceShell(): Promise<Shell> {
    const old = this.shell?.alive ? this.shell : null;
    const where = old ? (await old.query("pwd")).trim() : "";
    const exported = old ? await old.query("export -p") : "";
    this.shell = null;
    await old?.close().catch(() => {});
    const sh = await this.ensureShell();
    // `export -p` writes `declare -x` lines bash reads back as they are —
    // only whole ones: a value with a line break in it spans lines, and half
    // of one would leave the shell waiting for a closing quote.
    const back = exported
      .split(/\r?\n/)
      .filter((l) => /^declare -x [A-Za-z_][A-Za-z0-9_]*(="(?:[^"\\]|\\.)*")?$/.test(l))
      .filter((l) => !/^declare -x (PWD|OLDPWD|SHLVL|_)[=]?/.test(l));
    if (back.length) await sh.query(back.join("; "));
    if (where && where !== "/workspace") await sh.query(`cd '${where.replace(/'/g, "'\\''")}'`);
    return sh;
  }

  /** Torn down with the page: nothing waited for. */
  dispose(): void {
    void this.shell?.close().catch(() => {});
    this.term.dispose();
  }

  /**
   * Gone: what runs in it is stopped first, as Stop would, and then its bash.
   * Waited for: ended with bash straight away, a server would go on unseen,
   * holding its port.
   */
  async close(): Promise<void> {
    this.element.hidden = true;
    if (this.busy) {
      this.console.stop();
      const until = performance.now() + 2500;
      while (this.busy && performance.now() < until) await new Promise((r) => setTimeout(r, 50));
    }
    await this.shell?.close().catch(() => {});
    this.shell = null;
    this.term.dispose();
    this.element.remove();
  }
}

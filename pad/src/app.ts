/**
 * The page: a file list, an editor, a terminal, and one Run.
 *
 * Everything heavy loads late. The editor is usable before the runtime exists,
 * because the first thing anyone does here is paste — and the runtime is a
 * 60 MB download that would otherwise be in the way of that.
 */
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";

import { Console } from "./console";
import { Peers } from "./peers";
import { interpreterFor, prefetch, Runtime } from "./runtime";
import { Shell } from "./shell";
import { Store, type Pad } from "./store";
import { diff, type Known, knownFrom } from "./sync";

const STARTER = `# Paste over this, or start typing.
import csv

rows = [{"n": i, "square": i * i} for i in range(10)]
with open("out.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["n", "square"])
    w.writeheader()
    w.writerows(rows)

print(f"wrote {len(rows)} rows to out.csv")
`;

type Status = "" | "loading" | "running" | "saving" | "error";

export class App {
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: typeof Monaco | null = null;
  private models = new Map<string, Monaco.editor.ITextModel>();
  private active = "";
  private runtime: Promise<Runtime> | null = null;
  private shell: Shell | null = null;
  private console: Console | null = null;
  private term: { write: (s: string) => void; fit: () => void } | null = null;
  private known: Known = new Map();
  private prefetched = false;
  private peers: Peers | null = null;
  private busy = false;
  private missed = false;

  constructor(
    private readonly name: string,
    private readonly store: Store,
    private readonly el: {
      files: HTMLElement;
      editor: HTMLElement;
      terminal: HTMLElement;
      add: HTMLButtonElement;
      run: HTMLButtonElement;
      share: HTMLButtonElement;
      status: HTMLElement;
      presence: HTMLElement;
      title: HTMLElement;
    },
  ) {}

  async start(): Promise<void> {
    this.el.title.textContent = this.name;
    this.say("loading", "opening…");

    let pad: Pad;
    try {
      pad = await this.store.read(this.name);
    } catch (e) {
      this.say("error", (e as Error).message);
      return;
    }

    const files = Object.entries(pad.files).filter(([, f]) => f.encoding === "utf8");
    this.known = knownFrom(pad.files);

    await this.openEditor();
    if (files.length === 0) {
      // A folder nobody has written to opens with something runnable in it, so
      // the first thing a visitor can do is press Run and watch it work.
      this.setFile("main.py", STARTER);
    } else {
      for (const [path, f] of files) this.setFile(path, f.content);
      this.show(files[0]![0]);
    }

    this.renderFiles();
    this.wire();
    this.joinPeers();
    this.say("", pad.exists ? "" : "new folder — nothing saved yet");
    this.editor?.focus();
  }

  // ----------------------------------------------------------------- peers

  private joinPeers(): void {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    this.peers = new Peers(url, this.name, {
      onMoved: () => void this.refresh(),
      onPresence: (others) => {
        this.el.presence.textContent = others === 0 ? "" : `${others + 1} here`;
      },
    });
    this.peers.connect();
  }

  /**
   * Somebody else changed the folder. Re-read it rather than trusting the
   * broadcast, which carries only the fact that something moved.
   *
   * Deferred while a command is running: the sandbox filesystem is mid-flight
   * then, and writing someone else's version of a file underneath a running
   * script is a way to produce output that matches no version of anything.
   */
  private async refresh(): Promise<void> {
    if (this.busy) {
      this.missed = true;
      return;
    }
    let pad: Pad;
    try {
      pad = await this.store.read(this.name);
    } catch {
      return;
    }
    const rt = this.runtime ? await this.runtime : null;
    const incoming = knownFrom(pad.files);

    for (const [path, content] of incoming) {
      if (this.known.get(path) === content) continue;
      this.setFile(path, content);
      // The sandbox too, or the next run uses the version this browser had
      // before the change arrived.
      if (rt) await rt.write(path, content);
    }
    for (const path of this.known.keys()) {
      if (incoming.has(path)) continue;
      this.models.get(path)?.dispose();
      this.models.delete(path);
    }
    this.known = incoming;
    if (!this.models.has(this.active)) {
      const first = [...this.models.keys()].sort()[0];
      if (first) this.show(first);
    }
    this.renderFiles();
  }

  // ---------------------------------------------------------------- editor

  private async openEditor(): Promise<void> {
    const monaco = await import("monaco-editor/esm/vs/editor/editor.api");
    // Monaco asks for workers by language. Only the plain editor worker can
    // run here, so every request gets that one — the language services are not
    // bundled and could not start anyway.
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: async () => {
        const W = await import("monaco-editor/esm/vs/editor/editor.worker?worker");
        return new W.default();
      },
    };
    this.monaco = monaco;
    // Exposed so the browser checks can drive the editor the way a person
    // would. Monaco's own API, not a hook invented for testing.
    (window as unknown as { monaco: typeof Monaco }).monaco = monaco;
    this.editor = monaco.editor.create(this.el.editor, {
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs",
    });
    this.editor.onDidChangeModelContent(() => this.warm());
  }

  private setFile(path: string, content: string): void {
    if (!this.monaco) return;
    const existing = this.models.get(path);
    if (existing) {
      if (existing.getValue() !== content) existing.setValue(content);
      return;
    }
    const language = path.endsWith(".py") ? "python" : path.endsWith(".json") ? "json" : "plaintext";
    this.models.set(path, this.monaco.editor.createModel(content, language));
    if (!this.active) this.show(path);
  }

  private show(path: string): void {
    const model = this.models.get(path);
    if (!model || !this.editor) return;
    this.active = path;
    this.editor.setModel(model);
    this.renderFiles();
    this.el.run.disabled = interpreterFor(path) === null;
    this.el.run.title = this.el.run.disabled ? `nothing here runs a ${path.split(".").pop()} file` : "";
  }

  /**
   * Make a file.
   *
   * Written straight into the sandbox as well as the editor, so the shell can
   * see it immediately — someone who makes `notes.py` and types `python
   * notes.py` should not have to press Run first to bring it into existence.
   */
  private addFile(): void {
    const name = prompt("New file", "untitled.py")?.trim();
    if (!name) return;
    if (this.models.has(name)) return this.show(name);
    if (name.startsWith("/") || name.split("/").some((p) => !p || p === "." || p === "..")) {
      this.say("error", "that path will not work");
      return;
    }
    this.setFile(name, "");
    this.show(name);
    void this.runtime?.then((rt) => rt.write(name, ""));
    this.editor?.focus();
  }

  private renderFiles(): void {
    this.el.files.replaceChildren(
      ...[...this.models.keys()].sort().map((path) => {
        const b = document.createElement("button");
        b.className = "file" + (path === this.active ? " on" : "");
        b.textContent = path;
        b.onclick = () => this.show(path);
        return b;
      }),
    );
  }

  // --------------------------------------------------------------- runtime

  /**
   * Start fetching the runtime on the first keystroke.
   *
   * Not on load: a shared link is opened to read at least as often as to run,
   * and 60 MB is not a reasonable greeting. Not on Run either, which would put
   * the whole download between pressing a button and seeing anything. Typing
   * is the first honest signal of intent, and it buys most of the download.
   */
  private warm(): void {
    if (this.prefetched) return;
    this.prefetched = true;
    prefetch();
    void this.ensureRuntime();
  }

  private ensureRuntime(): Promise<Runtime> {
    this.runtime ??= (async () => {
      const files: Record<string, string> = {};
      for (const [path, model] of this.models) files[path] = model.getValue();
      return Runtime.start(files);
    })();
    return this.runtime;
  }

  private async ensureShell(rt: Runtime): Promise<Shell> {
    if (this.shell) return this.shell;
    const { Terminal } = await import("@xterm/xterm");
    const { FitAddon } = await import("@xterm/addon-fit");
    await import("@xterm/xterm/css/xterm.css");
    const term = new Terminal({
      fontSize: 12,
      convertEol: true,
      theme: matchMedia("(prefers-color-scheme: dark)").matches
        ? { background: "#12181c", foreground: "#d8e2e6" }
        : { background: "#ffffff", foreground: "#1b2226" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.el.terminal);
    fit.fit();
    addEventListener("resize", () => fit.fit());
    this.term = { write: (s) => term.write(s), fit: () => fit.fit() };
    this.shell = await Shell.open(rt, { columns: term.cols, rows: term.rows }, (t) => term.write(t));

    // The prompt, the echo and the line editing are all the page's job here —
    // bash provides none of them. See `console.ts`.
    const shell = this.shell;
    this.console = new Console({ write: (d) => term.write(d) }, shell, () =>
      void this.afterCommand(),
    );
    term.onData((data) => this.console?.handle(data));
    term.onResize(({ cols, rows }) => shell.resize(cols, rows));
    this.console.start();
    return this.shell;
  }

  // ------------------------------------------------------------------- run

  private wire(): void {
    this.el.add.onclick = () => this.addFile();
    this.el.run.onclick = () => void this.run();
    this.el.share.onclick = () => void this.share();
    addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.run();
      }
    });
  }

  private async run(): Promise<void> {
    const program = interpreterFor(this.active);
    if (!program || this.el.run.disabled) return;

    this.el.run.disabled = true;
    this.busy = true;
    try {
      this.say("loading", this.runtime ? "" : "fetching python, first time only…");
      const rt = await this.ensureRuntime();
      const sh = await this.ensureShell(rt);

      // Flush every model before running. The editor holds the text; the
      // sandbox holds the file. They are not the same thing, and running
      // without this executes the previous version — the code on screen
      // correct, the output wrong, and nothing to suggest why.
      for (const [path, model] of this.models) await rt.write(path, model.getValue());

      this.say("running", "running…");
      const command = `${program} ${JSON.stringify(this.active)}`;
      // Shown the way a typed one would be, because that is what it is: the
      // button is a shortcut for typing, not a second way to execute.
      this.console?.announce(command);
      const { exitCode } = await sh.run(command);
      if (exitCode !== 0) this.term?.write(`\x1b[31mexit ${exitCode}\x1b[0m\r\n`);
      this.console?.resume();

      this.say("saving", "saving…");
      await this.publish(rt);
      this.say("", exitCode === 0 ? "done" : `exited ${exitCode}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    } finally {
      this.busy = false;
      this.el.run.disabled = interpreterFor(this.active) === null;
      // A change that arrived mid-run was put off rather than dropped.
      if (this.missed) {
        this.missed = false;
        void this.refresh();
      }
    }
  }

  /**
   * Sync after anything the shell did, typed or clicked.
   *
   * Skipped while Run is mid-flight: that path publishes once at the end, and
   * doing it here as well would send the same diff twice and nudge everyone
   * else for the second one.
   */
  private async afterCommand(): Promise<void> {
    if (this.busy || !this.runtime) return;
    try {
      await this.publish(await this.runtime);
    } catch (e) {
      this.say("error", (e as Error).message);
    }
  }

  /** Push whatever the command changed, and show any new files it made. */
  private async publish(rt: Runtime): Promise<void> {
    const { changes, next } = await diff(rt, this.known);
    if (changes.length === 0) return;
    const seq = await this.store.write(this.name, changes);
    // Only once the server has it: a failed write must not leave the page
    // believing it is in sync, or the change is never retried.
    this.known = next;
    for (const change of changes) {
      if (change.content === null) {
        this.models.get(change.path)?.dispose();
        this.models.delete(change.path);
      } else {
        this.setFile(change.path, change.content);
      }
    }
    this.renderFiles();
    // Only after the server has it, so nobody is told to read a version that
    // does not exist yet.
    this.peers?.moved(seq);
  }

  private async share(): Promise<void> {
    const url = `${location.origin}/${this.name}`;
    try {
      await navigator.clipboard.writeText(url);
      this.say("", "link copied");
    } catch {
      this.say("", url);
    }
  }

  private say(status: Status, text: string): void {
    this.el.status.textContent = text;
    this.el.status.dataset.status = status;
  }
}

/**
 * The page: a file list, an editor, a terminal, and one Run.
 *
 * Everything heavy loads late. The editor is usable before the runtime exists,
 * because the first thing anyone does here is paste — and the runtime is a
 * 60 MB download that would otherwise be in the way of that.
 */
import type * as Monaco from "monaco-editor";

import type { BrowserServer, SandboxOptions } from "@wasmer/sdk";

import { Console } from "./console";
import { DocSession } from "./editing";
import { FileTree } from "./files";
import { DOC_AWARENESS, DOC_UPDATE, DOC_WANT, Peers, streamFor } from "./peers";
import { interpreterFor, prefetch, Runtime } from "./runtime";
import { Shell } from "./shell";
import { Store, StoreError, type Pad } from "./store";
import { seedFiles } from "./seed";
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

/**
 * The origin that serves the sandbox's HTTP responses.
 *
 * A *different* origin, which the SDK requires and which is the right answer
 * anyway: a page served by whatever someone is running in their folder must
 * not be able to script the pad. Empty disables previews entirely, which is
 * what a build without the second origin should do.
 */
const WISP_URL: string = import.meta.env.VITE_WISP_URL ?? "";
const PREVIEW_ORIGIN = import.meta.env.VITE_PREVIEW_ORIGIN ?? "";

export class App {
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: typeof Monaco | null = null;
  private models = new Map<string, Monaco.editor.ITextModel>();
  private active = "";
  private runtime: Promise<Runtime> | null = null;
  private shell: Shell | null = null;
  private console: Console | null = null;
  private tree: FileTree | null = null;
  private term: { write: (s: string) => void; fit: () => void } | null = null;
  /** The port something in the folder is listening on, if any. */
  private listening: number | null = null;
  private served: BrowserServer | null = null;
  private cols = 80;
  private rows = 24;
  private known: Known = new Map();
  private prefetched = false;
  private peers: Peers | null = null;
  private busy = false;
  private missed = false;
  /** Models edited since the last save. */
  private dirty = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while a remote change is being written into the editor. */
  private applyingRemote = false;
  /**
   * Live documents, one per file somebody has open.
   *
   * Only open files get one. A folder of fifty files does not need fifty
   * CRDTs; the interesting state is whatever is on somebody's screen.
   */
  private docs = new Map<string, DocSession>();
  private byStream = new Map<number, string>();
  private unbind: (() => void) | null = null;
  /** Documents waiting on another browser to send their state. */
  private awaiting = new Map<string, () => void>();
  /** This browser's participant id and name, as cursors are labelled. */
  private me = 1;
  private whoami = "someone";

  constructor(
    private readonly name: string,
    private readonly store: Store,
    private readonly el: {
      files: HTMLElement;
      editor: HTMLElement;
      terminal: HTMLElement;
      run: HTMLButtonElement;
      share: HTMLButtonElement;
      preview: HTMLButtonElement;
      previewPane: HTMLElement;
      status: HTMLElement;
      presence: HTMLElement;
      title: HTMLElement;
    },
  ) {}

  /** Exposed for the browser checks, which need to see what synced. */
  private expose(): void {
    (window as unknown as { __pad: unknown }).__pad = {
      active: () => this.active,
      docs: () => [...this.docs.keys()],
      streams: () => [...this.byStream.entries()],
      text: (p: string) => this.docs.get(p)?.contents() ?? this.models.get(p)?.getValue(),
      known: () => [...this.known.keys()],
      counts: () => this.peers?.counts,
      shellBusy: () => this.console?.busy ?? false,
    };
  }

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

    this.joinPeers();
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
    await this.openTerminal();
    this.expose();
    this.say("", pad.exists ? "" : "new folder — nothing saved yet");
    this.editor?.focus();
  }

  // ----------------------------------------------------------------- peers

  private joinPeers(): void {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    this.peers = new Peers(url, this.name, {
      onMoved: () => void this.refresh(),
      onPresence: (others, id) => {
        this.el.presence.textContent = others === 0 ? "" : `${others + 1} here`;
        if (id === null) return;
        this.me = id;
        this.whoami = `guest ${id}`;
        // Every open document asks for state again.
        //
        // A dropped socket loses whatever updates were in flight, and nothing
        // would ever notice: both sides carry on believing they are in step
        // while their text quietly differs. On the first connect there are no
        // documents yet and this does nothing.
        for (const [path, doc] of this.docs) {
          this.peers?.doc(streamFor(path), DOC_WANT, doc.stateVector());
        }
      },
      onDoc: (stream, kind, bytes) => this.onDoc(stream, kind, bytes),
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

    this.applyingRemote = true;
    for (const [path, content] of incoming) {
      if (this.known.get(path) === content) continue;
      // A file with a live document is owned by the CRDT, which already has
      // every keystroke. Writing the store's copy over it would undo whatever
      // has been typed since that copy was saved.
      if (this.docs.has(path)) continue;
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
    this.applyingRemote = false;
    this.known = incoming;
    if (!this.models.has(this.active)) {
      const first = [...this.models.keys()].sort()[0];
      if (first) this.show(first);
    }
    this.renderFiles();
  }

  // -------------------------------------------------------------- documents

  /**
   * Give a file a live document and attach it to the editor.
   *
   * The store holds the durable copy and Yjs holds the live one. Seeding both
   * from the store independently would be wrong — two peers inserting the same
   * text are two different insertions to a CRDT, and the merge produces it
   * twice. So a newcomer asks for state instead, and only falls back to the
   * store when nobody answers.
   */
  private async readyDoc(path: string): Promise<DocSession> {
    const existing = this.docs.get(path);
    if (existing) return existing;

    const stream = streamFor(path);
    const doc = new DocSession(stream, path, { id: this.me, name: this.whoami }, (kind, bytes) => {
      this.peers?.doc(stream, kind === "update" ? DOC_UPDATE : DOC_AWARENESS, bytes);
      // Local changes only — the document returns early on anything applied
      // from somebody else — which makes this the right place to decide that
      // something needs saving.
      if (kind === "update") {
        this.dirty.add(path);
        this.saveSoon();
      }
    });
    this.docs.set(path, doc);
    this.byStream.set(stream, path);

    // The stored copy, or the model's when there is none — a folder nobody
    // has written to yet holds its starter only on screen. Safe as a seed
    // because seeding happens only when this browser is alone or nobody
    // answered, and in both cases no other document exists to disagree.
    // Wait for the relay to say who is here. Asked a moment earlier, the room
    // always looks empty and this browser seeds a document somebody else
    // already owns.
    await this.peers?.ready;

    const stored = this.known.get(path) ?? this.models.get(path)?.getValue() ?? "";
    if (!this.peers || this.peers.alone) {
      doc.seed(stored);
      return doc;
    }

    // Somebody else may have had this open for a while, with edits the store
    // has not seen. Their document is the truth and this one must take it
    // whole rather than start from the stored copy and merge.
    //
    // Seeding both would not merge anyway: `seed` uses a fixed client id so
    // that two browsers seeding the *same* text produce identical operations,
    // and two seeding *different* text produce conflicting ones under the same
    // ids — which Yjs discards as already known. The result is two documents
    // that exchange updates and silently ignore each other.
    this.peers.doc(stream, DOC_WANT, doc.stateVector());
    await new Promise<void>((resolve) => {
      this.awaiting.set(path, resolve);
      setTimeout(resolve, 600);
    });
    this.awaiting.delete(path);
    // Nobody answered, so nobody else has it open and the stored copy is safe.
    if (doc.length === 0) doc.seed(stored);
    return doc;
  }

  /**
   * Forget a file's document.
   *
   * A disposed model is not enough: the document outlives it, keeps its Yjs
   * state and awareness, holds a stylesheet for other people's cursors, and —
   * worst — stays subscribed to its stream, so a later update for a path this
   * browser no longer has can still be applied to a document nothing displays.
   */
  private closeDoc(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    if (this.active === path) {
      this.unbind?.();
      this.unbind = null;
    }
    this.docs.delete(path);
    this.byStream.delete(streamFor(path));
    this.awaiting.delete(path);
    doc.destroy();
  }

  private onDoc(stream: number, kind: number, bytes: Uint8Array): void {
    const path = this.byStream.get(stream);
    // A document nobody here has open. The folder still converges: whoever is
    // editing it saves, and the nudge that follows brings the text over.
    if (!path) return;
    const doc = this.docs.get(path);
    if (!doc) return;

    if (kind === DOC_UPDATE) {
      doc.applyUpdate(bytes);
      // Whoever was waiting for state has it now.
      this.awaiting.get(path)?.();
    }
    else if (kind === DOC_AWARENESS) doc.applyAwareness(bytes);
    else if (kind === DOC_WANT) {
      // Somebody wants what they are missing. Only what they lack is sent.
      this.peers?.doc(stream, DOC_UPDATE, doc.diffSince(bytes));
    }
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
    const model = this.monaco.editor.createModel(content, language);
    // Per model, not on the editor. `onDidChangeModelContent` fires only for
    // whichever model is attached right now, so a change to any other file —
    // including one arriving from the shell — would never be noticed.
    model.onDidChangeContent(() => {
      this.warm();
      // A change the page just wrote in on somebody else's behalf is not an
      // edit to send back. Without this every remote update bounces straight
      // home and two browsers push the same content at each other forever.
      if (this.applyingRemote) return;
      // A file with a document marks itself dirty from the document's own
      // send callback, which fires for local edits and not for applied
      // remote ones. Marking here as well would save — and nudge everyone —
      // once for every keystroke anybody else typed.
      if (this.docs.has(path)) return;
      this.dirty.add(path);
      this.saveSoon();
    });
    this.models.set(path, model);
    if (!this.active) this.show(path);
  }

  private show(path: string): void {
    const model = this.models.get(path);
    if (!model || !this.editor || !this.monaco) return;
    this.active = path;
    this.editor.setModel(model);
    this.unbind?.();
    this.unbind = null;
    // Bound once the document is ready, which may mean waiting for another
    // browser to send it. The model already shows the stored copy meanwhile,
    // so the wait is invisible rather than blank.
    void this.attach(path, model);
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
  private addFile(inDirectory = ""): void {
    const name = this.askFor("New file", "untitled.py", inDirectory);
    if (!name) return;
    if (this.models.has(name)) return this.show(name);
    this.setFile(name, "");
    this.show(name);
    // Into the sandbox too, so `python notes.py` works without pressing Run
    // first to bring the file into existence.
    void this.runtime?.then((rt) => rt.write(name, ""));
    this.editor?.focus();
  }

  /**
   * Make a directory.
   *
   * It exists in the sandbox immediately, but cannot be *stored* until
   * something is in it — the folder is derived from its contents, and an empty
   * one has none. The tree shows it meanwhile so the click is not silent.
   */
  private addFolder(inDirectory = ""): void {
    const name = this.askFor("New folder", "data", inDirectory);
    if (!name) return;
    this.tree?.addPendingFolder(name);
    void this.runtime?.then((rt) => rt.write(`${name}/.keep`, "").catch(() => {}));
    this.renderFiles();
    this.say("", "empty folders are not saved until something is in them");
  }

  /** One prompt, one set of rules, so both buttons refuse the same paths. */
  private askFor(title: string, placeholder: string, inDirectory: string): string | null {
    const raw = prompt(title, inDirectory ? `${inDirectory}/${placeholder}` : placeholder);
    const name = raw?.trim().replace(/^\/+|\/+$/g, "") ?? "";
    if (!name) return null;
    if (name.split("/").some((p) => !p || p === "." || p === "..")) {
      this.say("error", "that path will not work");
      return null;
    }
    return name;
  }


  private async attach(path: string, model: Monaco.editor.ITextModel): Promise<void> {
    const doc = await this.readyDoc(path);
    // Somebody may have clicked another file while this was waiting.
    if (this.active !== path || !this.editor || !this.monaco) return;
    this.unbind?.();
    this.unbind = doc.bind(this.monaco, this.editor, model);
  }

  private renderFiles(): void {
    this.tree ??= new FileTree(this.el.files, {
      onOpen: (path) => this.show(path),
      onNewFile: (dir) => this.addFile(dir),
      onNewFolder: (dir) => this.addFolder(dir),
    });
    this.tree.render([...this.models.keys()], this.active);
  }


  /**
   * Save what has been typed, shortly.
   *
   * Debounced rather than immediate: a burst of typing is one save, and every
   * save is an HTTP write plus a nudge to everyone else in the folder. Long
   * enough to coalesce a sentence, short enough that stopping to think means
   * the other person already has it.
   */
  private saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveEdits(), 500);
  }

  private async saveEdits(): Promise<void> {
    this.saveTimer = null;
    const paths = [...this.dirty];
    this.dirty.clear();
    const changes = paths
      .map((path) => ({
        path,
        // The document is the truth for a file somebody has open; the model
        // mirrors it, and reading the mirror is a race with the next update.
        content: this.docs.get(path)?.contents() ?? this.models.get(path)?.getValue(),
      }))
      .filter((c): c is { path: string; content: string } => c.content !== undefined)
      .filter((c) => this.known.get(c.path) !== c.content);
    if (changes.length === 0) return;

    try {
      const seq = await this.store.write(this.name, changes);
      for (const c of changes) this.known.set(c.path, c.content);
      // The sandbox too, when there is one, so a shell command run next sees
      // what is on screen rather than what was there before the typing.
      if (this.runtime) {
        const rt = await this.runtime;
        for (const c of changes) await rt.write(c.path, c.content);
      }
      this.peers?.moved(seq);
      this.say("", "saved");
    } catch (e) {
      const why = e as StoreError;
      // Some failures will never succeed however often they are tried: a pad
      // past its size cap, or a name that has expired. Retrying those is a
      // request every half second for as long as the tab is open, and it still
      // never saves. Say so once and stop.
      if (why.gone || why.tooBig) {
        this.say("error", `${why.message} — this is not being saved`);
        return;
      }
      // Anything else is worth another go: an unsaved change that nothing
      // retries is the one failure this product cannot afford.
      for (const p of paths) this.dirty.add(p);
      this.say("error", why.message);
      this.saveSoon();
    }
  }

  /**
   * Write every edited model into the sandbox.
   *
   * Called before anything diffs the sandbox. The editor holds the text and
   * the sandbox holds the file; if a typed command publishes while they
   * disagree, the diff sees the sandbox's older copy as the truth and pushes
   * it over what somebody just wrote.
   */
  private async flushModels(rt: Runtime): Promise<void> {
    for (const path of this.dirty) {
      const model = this.models.get(path);
      if (model) await rt.write(path, model.getValue());
    }
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
      const files = seedFiles(this.known, this.models, this.docs);
      // wisp carries egress *and* the http ingress the preview needs, so it
        // supersedes the http policy rather than sitting beside it. Without a
        // configured endpoint this falls back to http, which is what every
        // build that is not production does.
        const network: SandboxOptions["network"] | undefined = WISP_URL
          ? {
              mode: "wisp",
              url: WISP_URL,
              // Same origin, because the SDK resolves names over DoH with
              // `fetch` rather than through the tunnel, and its default host is
              // one `connect-src 'self'` refuses. Caddy proxies this.
              dnsUrl: `${location.origin}/dns-query`,
            }
          : PREVIEW_ORIGIN
            ? { mode: "http" }
            : undefined;
        const rt = await Runtime.start(files, network ? { network } : undefined);
      // Without a network policy the sandbox cannot listen at all, so this is
      // what makes a dev server started in the folder possible. It grants no
      // egress: `connect` is still refused. See docs/dev/networking.md.
      if (PREVIEW_ORIGIN) this.watchForServers(rt);
      return rt;
    })();
    return this.runtime;
  }

  /**
   * Offer a preview when something in the folder starts listening.
   *
   * The button appears rather than the preview opening itself: a server
   * starting is not a request to be shown it, and a page that rearranges
   * itself under someone mid-command is worse than one that waits to be asked.
   */
  private watchForServers(rt: Runtime): void {
    rt.sandbox().ports.onListen((port) => {
      this.listening = port;
      this.el.preview.hidden = false;
      this.el.preview.title = `Open the server on port ${port}`;
    });
  }

  /** Swap the editor for the running server, and back. */
  private async togglePreview(): Promise<void> {
    if (!this.el.previewPane.hidden) {
      this.el.previewPane.hidden = true;
      this.el.editor.hidden = false;
      this.el.preview.classList.remove("on");
      return;
    }
    const port = this.listening;
    if (port === null) return;
    try {
      const rt = await this.ensureRuntime();
      this.served ??= await rt
        .sandbox()
        .ports.expose(port, { serviceWorker: PREVIEW_ORIGIN, timeoutMs: 30_000 });
      const frame = this.served.createIframe();
      this.el.previewPane.replaceChildren(frame);
      this.el.previewPane.hidden = false;
      this.el.editor.hidden = true;
      this.el.preview.classList.add("on");
    } catch (e) {
      // The terminal is where everything else says what went wrong, and a
      // preview that fails silently is indistinguishable from one that is
      // slow.
      this.term?.write(`\r\n\x1b[31mpreview: ${(e as Error).message}\x1b[0m\r\n`);
    }
  }

  /**
   * Put the terminal on screen before anything can run in it.
   *
   * The prompt, the typing and the line editing are all the page's, so none of
   * them need the runtime. Waiting for it would leave an empty black rectangle
   * until somebody pressed Run — and the first command someone types is how
   * they find out the thing is a shell at all.
   *
   * The 16 MB still arrives lazily. A command typed before it is ready waits,
   * and says so.
   */
  private async openTerminal(): Promise<void> {
    if (this.term) return;
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
    this.cols = term.cols;
    this.rows = term.rows;

    // The console owns the prompt, the echo and the line editing — bash
    // provides none of them. It asks for a shell only when a line is entered.
    this.console = new Console({ write: (d) => term.write(d) }, () => this.ensureShell(), () =>
      void this.afterCommand(),
    );
    term.onData((data) => this.console?.handle(data));
    term.onResize(({ cols, rows }) => {
      this.cols = cols;
      this.rows = rows;
      void this.shell?.resize(cols, rows);
    });
    this.console.start();
  }

  private async ensureShell(): Promise<Shell> {
    // A shell that has exited cannot be reused. Interrupting a command takes
    // bash down with it in this runtime, so this is the ordinary path after
    // any ctrl-c, not an error case.
    if (this.shell && !this.shell.alive) this.shell = null;
    if (this.shell) return this.shell;
    const rt = await this.ensureRuntime();
    this.shell = await Shell.open(rt, { columns: this.cols, rows: this.rows }, (t) =>
      this.term?.write(t),
    );
    return this.shell;
  }

  // ------------------------------------------------------------------- run

  private wire(): void {
    this.el.run.onclick = () => void this.run();
    this.el.share.onclick = () => void this.share();
    this.el.preview.onclick = () => void this.togglePreview();
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
      const sh = await this.ensureShell();
      this.console?.attach(sh);

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
    await this.flushModels(rt);
    const { changes, next } = await diff(rt, this.known);
    if (changes.length === 0) return;
    const seq = await this.store.write(this.name, changes);
    // Only once the server has it: a failed write must not leave the page
    // believing it is in sync, or the change is never retried.
    this.known = next;
    for (const change of changes) {
      if (change.content === null) {
        this.closeDoc(change.path);
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

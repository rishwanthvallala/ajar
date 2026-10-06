/**
 * The page: a file list, an editor, a terminal, and one Run.
 *
 * Everything heavy loads late. The editor is usable before the runtime exists,
 * because the first thing anyone does here is paste — and the runtime is a
 * 60 MB download that would otherwise be in the way of that.
 */
import type * as Monaco from "monaco-editor";

import type { BrowserServer, SandboxOptions } from "@wasmer/sdk";
import { defineEditorThemes, editorTheme, languageFor, onThemeChange, registerDelimited } from "@ajar/workspace-ui";

import { acceptCode, type Access, account, AccountError, codeFor, forgetCode, OPEN, restorePreviousCode } from "./access";
import { carryOver } from "./carry";
import { Console } from "./console";
import { colourFor, DocSession, replaceText } from "./editing";
import { FileTree } from "./files";
import { DOC_AWARENESS, DOC_NONE, DOC_UPDATE, DOC_WANT, Peers, streamFor } from "./peers";
import { interpreterFor, prefetch, Runtime } from "./runtime";
import { Shell, type Finished } from "./shell";
import { ICONS } from "./icons";
import { openShare } from "./share";
import { clearBusy, confirmDialog, toast, toastRegions } from "./ui";
import { leftOut, makeZip, PAD_LIMITS, pickZip, type Prepared, prepareImport, readZip, save, ZipError, type ZipEntry } from "./zip";
import { type Change, mintName, Store, StoreError, type Pad } from "./store";
import { seedFiles } from "./seed";
import { type Binaries, binariesFrom, diff, fromBase64, isMarker, type Known, knownFrom, MARKER, markedFolder } from "./sync";
import type { PadWorkspace } from "./workspace";

/**
 * The longest a newcomer waits for the room to send a file's document. Most
 * waits end long before, when everyone present has answered; this is for a
 * browser that never will.
 */
const DOC_ANSWER_WAIT = 5000;

/**
 * How long a viewer's document may sit with updates it cannot place before it
 * is thrown away and asked for again. See `onDoc`.
 */
const STUCK_WAIT = 1500;

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

export interface AppHooks {
  /**
   * The pad is not this browser's to see, now or any more — private, deleted,
   * or not a pad name at all. `deadLink`: the code this browser held opened
   * nothing, because its link was reset or turned off.
   */
  onPrivate?: (why: "private" | "gone" | "invalid", deadLink?: boolean) => void;
}

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
  private readonly events = new AbortController();
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private monaco: typeof Monaco | null = null;
  private models = new Map<string, Monaco.editor.ITextModel>();
  private active = "";
  private runtime: Promise<Runtime> | null = null;
  private shell: Shell | null = null;
  private console: Console | null = null;
  private tree: FileTree | null = null;
  private term: { write: (s: string) => void; fit: () => void; dispose: () => void } | null = null;
  /** The port something in the folder is listening on, if any. */
  private listening: number | null = null;
  private served: BrowserServer | null = null;
  private cols = 80;
  private rows = 24;
  private known: Known = new Map();
  /**
   * The pad's binary files, as the store keeps them. Never in the editor;
   * in the tree, the sandbox, a download and a move like any other file.
   */
  private binaries: Binaries = new Map();
  /** Latest durable revision applied by this tab. */
  private storeSeq = 0;
  private prefetched = false;
  /** The runtime has started, not merely been asked for. */
  private runtimeReady = false;
  private shellOpening: Promise<Shell> | null = null;
  private peers: Peers | null = null;
  private busy = false;
  /** When Run was last pressed, so a double-click is not also a Stop. */
  private runPressed = 0;
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
  /** Each document's wait for its state, shared by everybody who asks. */
  private docReady = new Map<string, Promise<DocSession>>();
  /**
   * What a file's editor showed when it opened, until its document is bound —
   * so typing in between can be carried over rather than replaced.
   */
  private shownUnbound = new Map<string, string>();
  private byStream = new Map<number, string>();
  private unbind: (() => void) | null = null;
  /** Documents waiting on another browser to send their state. */
  private awaiting = new Map<string, (answered: boolean) => void>();
  /** For each of those, who has not answered yet. */
  private unanswered = new Map<string, Set<number>>();
  /** Store writes from this tab are strictly ordered. */
  private writeChain: Promise<void> = Promise.resolve();
  /** This browser's participant id and name, as cursors are labelled. */
  private me = 1;
  /** The room is shut to this page: an ajar session holds the name. */
  private notLive = false;
  private whoami = "someone";
  /** Who this browser is to the pad, as the store last said. */
  private access: Access = OPEN;
  /**
   * A viewer's own copies: files changed in this tab — edited, made by a
   * command, or deleted. Each is detached from the pad, so the pad's later
   * changes to it stop arriving and never fight what was typed.
   */
  private local = new Set<string>();
  /** A viewer allowed to edit since, with local changes that would be lost. */
  private promoted = false;
  /** What the server last said, before a viewer's local changes held them back. */
  private granted: Access = OPEN;
  /**
   * Access lost while this page held work nowhere else — private now, or
   * deleted. The page stays, with that work, for Save as my copy.
   */
  private lost: "private" | "gone" | null = null;
  /** The banner as last drawn, so it is not redrawn — and re-read aloud — for nothing. */
  private bannerKey = "";
  /** Save as my copy in flight: a second press would make a second pad. */
  private copying = false;
  /** The page opened an empty pad and put the starter in it, unsaved. */
  private starter = false;
  /** A zip being read or written in: one at a time. */
  private importing = false;
  /** A move between its store write and the page catching up. */
  private moving = false;
  /** Where each file was left in the editor: scrolled to, the cursor, folds. */
  private viewStates = new Map<string, Monaco.editor.ICodeEditorViewState>();
  /**
   * This page was the owner's, and the session behind it ended — signed out
   * in another tab, or expired. Their work stays here; signing in again, in
   * another tab, puts it back into the pad.
   */
  private signedOut = false;
  /** Set once the page is torn down — by leaving, or by being refused. */
  private disposed = false;
  /** Documents with updates they could not place, and when to give up on them. */
  private stuck = new Map<string, ReturnType<typeof setTimeout>>();

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
      backToEditor: HTMLButtonElement;
      previewPane: HTMLElement;
      status: HTMLElement;
      presence: HTMLElement;
      title: HTMLElement;
    },
    private readonly ui?: PadWorkspace,
    private readonly hooks: AppHooks = {},
  ) {
    this.ui?.onLayout(() => {
      this.editor?.layout();
      this.term?.fit();
    });
    this.ui?.onHighlightChange(() => this.relanguage());
  }

  /** Exposed for the browser checks, which need to see what synced. */
  private expose(): void {
    (window as unknown as { __pad: unknown }).__pad = {
      active: () => this.active,
      docs: () => [...this.docs.keys()],
      streams: () => [...this.byStream.entries()],
      text: (p: string) => this.docs.get(p)?.contents() ?? this.models.get(p)?.getValue(),
      known: () => [...this.known.keys()],
      counts: () => this.peers?.counts,
      room: () => this.peers?.seen,
      shellBusy: () => this.console?.busy ?? false,
      role: () => this.access.role,
      local: () => [...this.local].sort(),
    };
  }

  async start(): Promise<void> {
    this.el.title.textContent = this.name;
    document.title = `${this.name} — pad`;
    toastRegions();
    this.say("loading", "opening…");

    let pad: Pad;
    try {
      pad = await this.store.read(this.name);
    } catch (e) {
      if (e instanceof StoreError && e.refused && e.message.includes("no longer works")) {
        // A code-shaped hash that replaced a working code: back to that one.
        if (restorePreviousCode(this.name)) return location.reload();
        forgetCode(this.name);
        return this.hooks.onPrivate?.("private", true);
      }
      if (e instanceof StoreError && (e.refused || e.gone)) return this.hooks.onPrivate?.(e.gone ? "gone" : "private");
      // A reserved word or a name the store will not take: not a pad, and an
      // editor around an error would look like one that is broken.
      if (e instanceof StoreError && e.status === 400) return this.hooks.onPrivate?.("invalid");
      this.say("error", (e as Error).message);
      return;
    }
    this.adopt(pad.access);

    // Text for the editor; an empty folder's marker is the tree's, not a file.
    const files = Object.entries(pad.files).filter(([path, f]) => f.encoding === "utf8" && !isMarker(path, f.content));
    this.known = knownFrom(pad.files);
    this.binaries = binariesFrom(pad.files);
    this.storeSeq = pad.seq;

    this.joinPeers();
    await this.openEditor();
    // Turned away while the editor loaded: there is no page to fill any more.
    if (this.disposed) return;
    if (files.length === 0) {
      // A folder nobody has written to opens with something runnable in it, so
      // the first thing a visitor can do is press Run and watch it work.
      this.setFile("main.py", STARTER);
      this.starter = true;
    } else {
      for (const [path, f] of files) this.setFile(path, f.content);
      this.show(files[0]![0]);
    }

    this.renderFiles();
    this.wire();
    this.acceptDrops();
    await this.openTerminal();
    if (this.disposed) return;
    this.expose();
    this.say("", this.viewer ? "" : pad.exists ? "" : "new folder — nothing saved yet");
    this.welcomeCopy();
    this.editor?.focus();
    // Last, so the runtime is seeded with every file above and nothing it does
    // competes with putting the editor on screen. See `warm`.
    this.warm();
  }

  // ----------------------------------------------------------------- peers

  /**
   * Who is here, as a dot each in the colour of their cursor.
   *
   * Cursors used to carry a label — "guest 3" — which read as a rank or a
   * count and meant nothing a person could use. The colour is what connects a
   * cursor to a person, so it is all either one shows now, and this is where
   * the colours are explained: yours ringed, everyone else's beside it.
   * Nothing is drawn when you are alone.
   */
  private renderPresence(others: number[]): void {
    const el = this.el.presence;
    el.replaceChildren();
    if (this.notLive) {
      const mark = document.createElement("span");
      mark.className = "not-live";
      mark.textContent = "Not live";
      mark.title = "An ajar session is using this name, so this page cannot reach the others on it. Your changes still save; theirs show when you reload.";
      el.append(mark);
      return;
    }
    if (others.length === 0) return;
    for (const id of [this.me, ...others]) {
      const dot = document.createElement("span");
      dot.className = id === this.me ? "person-dot you" : "person-dot";
      dot.style.background = colourFor(id);
      dot.title = id === this.me ? "you — this is the colour others see" : "someone else here";
      el.append(dot);
    }
    el.append(`${others.length + 1} here`);
  }

  private joinPeers(): void {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    this.peers = new Peers(url, this.name, {
      onMoved: () => void this.refresh(),
      onPresence: (_others, id) => {
        const renamed = id !== null && id !== this.me;
        if (id !== null) this.me = id;
        this.renderPresence(id === null ? [] : (this.peers?.otherIds ?? []));
        if (id === null) return;
        this.whoami = `guest ${id}`;
        if (renamed) for (const doc of this.docs.values()) doc.setUser({ id, name: this.whoami });
        const present = new Set([id, ...(this.peers?.otherIds ?? [])]);
        for (const doc of this.docs.values()) doc.keepOnly(present);
        // Somebody who left will never answer a question about a file.
        for (const [path, waiting] of this.unanswered) {
          for (const who of [...waiting]) if (!present.has(who)) waiting.delete(who);
          if (waiting.size === 0) this.awaiting.get(path)?.(false);
        }
        // Every open document asks for state again.
        //
        // A dropped socket loses whatever updates were in flight, and nothing
        // would ever notice: both sides carry on believing they are in step
        // while their text quietly differs. On the first connect there are no
        // documents yet and this does nothing.
        for (const [path, doc] of this.docs) {
          this.peers?.doc(streamFor(path), DOC_WANT, doc.stateVector());
        }
        // The peer socket carries nudges, not history. Re-read the durable
        // folder to recover every nudge that may have been missed offline.
        void this.refresh();
      },
      onDoc: (stream, kind, bytes, from) => this.onDoc(stream, kind, bytes, from),
      onRefused: (code) => this.lose(code === "gone" ? "gone" : "private"),
      // It used to retry in silence, and two people on the name each saw
      // only their own typing with nothing to say why.
      onShut: (shut) => {
        this.notLive = shut;
        this.renderPresence(shut ? [] : (this.peers?.otherIds ?? []));
        // A toast, not the status line, which the next save or load writes over.
        if (shut) toast("Not live: an ajar session is using this name. Your changes save, but other people's on it show only when you reload.", "error");
        else toast("Live again — you'll see other people's changes as they make them.");
      },
    }, () => codeFor(this.name));
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
    } catch (e) {
      if (e instanceof StoreError && (e.refused || e.gone)) this.lose(e.gone ? "gone" : "private");
      return;
    }
    // Who may do what can change while the page is open: the owner locked
    // editing, revoked a link, or opened it up. The relay closes the room
    // when that happens, and this read follows the reconnect.
    this.adopt(pad.access);
    if (pad.seq <= this.storeSeq) return;
    // Only a runtime that is already up is written to here. One still starting
    // is not waited for: this used to wait, so a browser still downloading its
    // runtime — a first visit, for a while — showed nobody else's new or
    // deleted files until it arrived. On 2 October a file deleted in one
    // browser stayed in another's tree past app-check's twenty seconds, for as
    // long as one package took to come from the CDN. ensureRuntime writes in
    // whatever changed meanwhile before anything can use the sandbox.
    const rt = this.runtimeReady ? await this.runtime : null;
    const incoming = knownFrom(pad.files);

    this.applyingRemote = true;
    for (const [path, content] of incoming) {
      if (this.known.get(path) === content) continue;
      // A viewer's own copy keeps what they made of it.
      if (this.local.has(path)) continue;
      // An empty folder: in the sandbox, not the editor.
      if (isMarker(path, content)) {
        if (rt) await rt.write(path, "");
        continue;
      }
      // A file with a live document is owned by the CRDT, which already has
      // every keystroke. Writing the store's copy over it would undo whatever
      // has been typed since that copy was saved.
      const doc = this.docs.get(path);
      if (!doc) this.setFile(path, content);
      // The sandbox too, or the next run uses the version this browser had
      // before the change arrived.
      if (rt) await rt.write(path, doc?.contents() ?? content);
    }
    for (const path of this.known.keys()) {
      if (incoming.has(path) || this.local.has(path)) continue;
      this.dirty.delete(path);
      this.closeDoc(path);
      this.models.get(path)?.dispose();
      this.models.delete(path);
      // And the folders that leaves empty: kept, the next command would put
      // them back for everyone.
      if (rt) await rt.removeAndPrune(path);
    }
    // Binary files after text ones: a file that became binary was removed as
    // text just above, and is written back here as what it is now.
    const incomingBinaries = binariesFrom(pad.files);
    for (const [path, base64] of incomingBinaries) {
      if (this.binaries.get(path) === base64 || this.local.has(path)) continue;
      if (rt) await rt.writeBytes(path, fromBase64(base64));
    }
    for (const path of this.binaries.keys()) {
      if (incomingBinaries.has(path) || incoming.has(path) || this.local.has(path)) continue;
      if (rt) await rt.removeAndPrune(path);
    }
    this.applyingRemote = false;
    this.known = incoming;
    this.binaries = incomingBinaries;
    this.storeSeq = pad.seq;
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
   *
   * One wait per document, however many ask. Opening a folder shows its
   * first file twice, and the second used to be handed the document while the
   * first was still waiting for it — bound empty, so the open file went blank
   * until somebody answered, and anything typed meanwhile was merged into
   * that blank document wherever the merge put it.
   */
  private readyDoc(path: string): Promise<DocSession> {
    let ready = this.docReady.get(path);
    if (!ready) {
      ready = this.openDoc(path);
      this.docReady.set(path, ready);
    }
    return ready;
  }

  private async openDoc(path: string): Promise<DocSession> {
    const stream = streamFor(path);
    const doc = new DocSession(stream, path, { id: this.me, name: this.whoami }, (kind, bytes) => {
      // A viewer's typing makes the file their own copy, there and then. The
      // relay would drop the update anyway; sending it would only leave this
      // document ahead of everyone else's, and the next update from the room
      // merged into it.
      if (this.viewer) {
        if (kind === "update") queueMicrotask(() => this.detach(path));
        return;
      }
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
    //
    // Seeded only once everyone here has said they do not have it open. It
    // used to be after 600 ms whatever had been said, and an answer slower than
    // that — a distant relay, a slow network — left this browser seeding the
    // stored copy beside a room whose document had moved on: two documents
    // that ignore each other. Now the wait ends when the last person present
    // says DOC_NONE, or leaves, and a browser that never says it — one from
    // before it existed — costs the full wait, which is safe.
    this.unanswered.set(path, new Set(this.peers.otherIds));
    this.peers.doc(stream, DOC_WANT, doc.stateVector());
    const answered = await new Promise<boolean>((resolve) => {
      this.awaiting.set(path, resolve);
      setTimeout(() => resolve(false), DOC_ANSWER_WAIT);
    });
    this.awaiting.delete(path);
    this.unanswered.delete(path);
    // Nobody answered, so nobody else has it open and the stored copy is safe.
    if (!answered) doc.seed(stored);
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
    this.docReady.delete(path);
    this.shownUnbound.delete(path);
    this.byStream.delete(streamFor(path));
    this.awaiting.delete(path);
    this.unanswered.delete(path);
    clearTimeout(this.stuck.get(path));
    this.stuck.delete(path);
    doc.destroy();
  }

  private onDoc(stream: number, kind: number, bytes: Uint8Array, from: number): void {
    const path = this.byStream.get(stream);
    const doc = path ? this.docs.get(path) : undefined;
    // A document nobody here has open — or one this browser is itself still
    // waiting for, which is nothing to give. The folder still converges:
    // whoever is editing it saves, and the nudge that follows brings the text
    // over. Asked about it, say so, so the asker need not wait for us.
    //
    // A viewer always says so. What it holds is not its to give — the relay
    // drops anything else a viewer sends — and an editor arriving must not
    // wait out the deadline for an answer that cannot come.
    if (!path || !doc || (kind === DOC_WANT && (!doc.hasState || this.viewer))) {
      if (kind === DOC_WANT) this.peers?.doc(stream, DOC_NONE, new Uint8Array());
      return;
    }

    if (kind === DOC_NONE) {
      const waiting = this.unanswered.get(path);
      waiting?.delete(from);
      if (waiting?.size === 0) this.awaiting.get(path)?.(false);
      return;
    }

    if (kind === DOC_UPDATE) {
      doc.applyUpdate(bytes);
      if (this.viewer) this.unstick(path, doc);
      // Whoever was waiting for state has it now — if this was state. Any
      // update used to count, so a newcomer bound the empty document it had
      // after other people's traffic, and its open file went blank until the
      // real answer came.
      if (doc.hasState) this.awaiting.get(path)?.(true);
      // The document is also the source executed by the sandbox. Keeping only
      // Monaco current lets the next harmless command publish stale runtime
      // bytes over somebody else's edit.
      void this.runtime?.then((rt) => rt.write(path, doc.contents()));
    }
    else if (kind === DOC_AWARENESS) doc.applyAwareness(bytes);
    else if (kind === DOC_WANT) {
      // Somebody wants what they are missing. Only what they lack is sent.
      this.peers?.doc(stream, DOC_UPDATE, doc.diffSince(bytes));
    }
  }

  // ---------------------------------------------------------------- editor

  private async openEditor(): Promise<void> {
    const [monaco] = await Promise.all([
      import("monaco-editor/esm/vs/editor/editor.api"),
      // Colours, and the editor features that come with them — see
      // monaco-languages.ts.
      import("./monaco-languages"),
    ]);
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
    // Monaco cancels its own work when a file is switched or closed, and one
    // of the standard editor features lets that rejection go unhandled — an
    // uncaught "Canceled" with a stack inside Monaco's dispose. Monaco treats
    // cancellation as expected everywhere else; so does this, and only that.
    addEventListener("unhandledrejection", (e) => {
      const reason = e.reason as { name?: string; message?: string } | undefined;
      if (reason?.name === "Canceled" && reason.message === "Canceled") e.preventDefault();
    }, { signal: this.events.signal });
    // Exposed so the browser checks can drive the editor the way a person
    // would. Monaco's own API, not a hook invented for testing.
    (window as unknown as { monaco: typeof Monaco }).monaco = monaco;
    registerDelimited(monaco.languages);
    defineEditorThemes(monaco.editor);
    this.editor = monaco.editor.create(this.el.editor, {
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: this.codeFontPx(),
      scrollBeyondLastLine: false,
      theme: editorTheme(),
    });
    onThemeChange(() => {
      monaco.editor.setTheme(editorTheme());
      this.editor?.updateOptions({ fontSize: this.codeFontPx() });
    }, this.events.signal);
    this.editor.onDidChangeModelContent(() => this.warm());
  }

  private setFile(path: string, content: string): void {
    if (!this.monaco) return;
    const existing = this.models.get(path);
    if (existing) {
      // Only what differs, so where somebody was in the file survives it.
      replaceText(this.monaco, existing, content);
      return;
    }
    const model = this.monaco.editor.createModel(content, this.languageOf(path));
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
      if (this.viewer) return this.markLocal(path);
      this.saveSoon();
    });
    this.models.set(path, model);
    if (!this.active) this.show(path);
  }

  /** The file's language, or plain text while colours are switched off. */
  private languageOf(path: string): string {
    if (!this.monaco || this.ui?.highlight === false) return "plaintext";
    return languageFor(this.monaco.languages.getLanguages(), path);
  }

  /**
   * Colours switched on or off, for every file at once.
   *
   * Plain text rather than a theme with no colours in it: plain text is what
   * stops the tokenizer running at all.
   */
  private relanguage(): void {
    if (!this.monaco) return;
    for (const [path, model] of this.models) this.monaco.editor.setModelLanguage(model, this.languageOf(path));
  }

  private show(path: string): void {
    const model = this.models.get(path);
    if (!model || !this.editor || !this.monaco) return;
    // Where this file was left — scrolled to, the cursor, what was folded —
    // so coming back to it is coming back to there, not to its first line.
    const leaving = this.active;
    if (leaving && leaving !== path && this.editor.getModel()) {
      const state = this.editor.saveViewState();
      if (state) this.viewStates.set(leaving, state);
    }
    this.active = path;
    this.el.editor.dataset.active = path;
    this.ui?.setActiveFile(path);
    this.editor.setModel(model);
    const back = this.viewStates.get(path);
    if (back) this.editor.restoreViewState(back);
    this.unbind?.();
    this.unbind = null;
    // Bound once the document is ready, which may mean waiting for another
    // browser to send it. The model already shows the stored copy meanwhile,
    // so the wait is invisible rather than blank.
    void this.attach(path, model);
    this.renderFiles();
    this.paintRun();
    this.paintBanner();
  }

  /**
   * Run, or Stop while anything is running — Run's own command or one typed.
   *
   * There was no way to stop a program but ctrl-c in the terminal, which
   * nobody who has only ever pressed Run knows; `while True:` left the button
   * greyed out with nothing to press. And a typed command left Run enabled, so
   * pressing it answered "a command is already running".
   */
  private paintRun(): void {
    const running = this.console?.busy ?? false;
    const runnable = interpreterFor(this.active) !== null;
    this.el.run.querySelector("span")!.textContent = running ? "Stop" : "Run";
    this.el.run.querySelector("path")?.setAttribute("d", running ? "M4.5 4.5h7v7h-7z" : "M5 3.5l7 4.5-7 4.5V3.5Z");
    this.el.run.disabled = !running && (this.busy || !runnable);
    this.el.run.title = running
      ? "Stop what is running (ctrl-c)"
      : runnable
        ? "Run this file (⌘⏎)"
        : `nothing here runs a ${this.active.split(".").pop()} file`;
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
    if (this.viewer) this.local.add(name);
    this.setFile(name, "");
    this.show(name);
    // Into the sandbox too, so `python notes.py` works without pressing Run
    // first to bring the file into existence.
    void this.runtime?.then((rt) => rt.write(name, ""));
    // Saved now, empty as it is. Nothing changes in a file nobody has typed
    // in yet, so nothing used to save it: gone on reload, and never seen by
    // anyone else, until a command happened to publish it.
    if (!this.viewer) {
      this.dirty.add(name);
      this.saveSoon();
    }
    this.editor?.focus();
  }

  /**
   * Make a directory, for everyone.
   *
   * Folders are derived from the paths under them, so an empty one is stored
   * as its marker — an empty `.keep` inside it — and drawn as the folder. It
   * used to exist only in the tab that made it until something landed inside.
   * A viewer's stays in their tab, as their files do.
   */
  private addFolder(inDirectory = ""): void {
    const name = this.askFor("New folder", "data", inDirectory);
    if (!name) return;
    this.tree?.addPendingFolder(name);
    void this.runtime?.then((rt) => rt.write(`${name}/${MARKER}`, "").catch(() => {}));
    this.renderFiles();
    if (this.viewer) return this.say("", "a new folder here stays in this tab");
    void this.keepFolder(name);
  }

  private async keepFolder(name: string): Promise<void> {
    const marker = `${name}/${MARKER}`;
    try {
      await this.queueWrite(async () => {
        const seq = await this.store.write(this.name, [{ path: marker, content: "" }]);
        this.storeSeq = Math.max(this.storeSeq, seq);
        this.known.set(marker, "");
        this.tree?.forgetPending(name);
        this.renderFiles();
        this.peers?.moved(seq);
      });
      this.say("", `made ${name}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    }
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
    // A viewer's own copy has no live document: that is what makes it theirs.
    if (this.local.has(path)) return;
    // Kept until the document is bound, so a click away and back still knows
    // what the file looked like before anything was typed.
    if (!this.shownUnbound.has(path)) this.shownUnbound.set(path, model.getValue());
    const doc = await this.readyDoc(path);
    // Somebody may have clicked another file while this was waiting.
    if (this.active !== path || !this.editor || !this.monaco) return;
    const shown = this.shownUnbound.get(path) ?? model.getValue();
    this.shownUnbound.delete(path);
    const typed = model.getValue();
    this.unbind?.();
    // Binding puts the document's text in the editor, over whatever was typed
    // while it was on its way. That typing goes back in as an ordinary edit,
    // so it reaches everybody and is saved like any other.
    this.unbind = doc.bind(this.monaco, this.editor, model);
    const edit = carryOver(shown, typed, model.getValue());
    if (!edit) return;
    const from = model.getPositionAt(edit.at);
    const to = model.getPositionAt(edit.at + edit.remove);
    model.pushEditOperations(
      [],
      [{ range: new this.monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: edit.insert }],
      () => null,
    );
    this.editor.setPosition(model.getPositionAt(edit.at + edit.insert.length));
  }

  private renderFiles(): void {
    this.tree ??= new FileTree(this.el.files, {
      onOpen: (path) => {
        if (this.binaries.has(path) && !this.models.has(path)) {
          const kb = Math.max(1, Math.round((this.binaries.get(path)!.length * 3) / 4 / 1024));
          return this.say("", `${path} is not text (${kb} KB) — download it with the arrow beside it`);
        }
        this.show(path);
        if (this.ui?.fileSelected()) this.editor?.focus();
      },
      onNewFile: (dir) => this.addFile(dir),
      onNewFolder: (dir) => this.addFolder(dir),
      onDelete: (path) => void this.deleteFile(path),
      onDeleteFolder: (path) => void this.deleteFolder(path),
      onDownload: (path, folder) => void this.download(path, folder),
      onDownloadAll: () => void this.downloadAll(),
      onImport: (zip) => void this.importZip(zip),
      importable: () => !this.viewer,
      onMove: (from, folder, to) => void this.move(from, folder, to),
      movable: () => !this.viewer,
    });
    const binary = new Set([...this.binaries.keys()].filter((p) => !this.models.has(p)));
    this.tree.render([...this.models.keys(), ...binary], this.active, this.local, binary, this.keptFolders());
    this.ui?.setFileCount(this.models.size + binary.size);
  }

  /** The empty folders the pad keeps, by their markers. */
  private keptFolders(): string[] {
    return [...this.known].filter(([path, content]) => isMarker(path, content)).map(([path]) => markedFolder(path));
  }

  /**
   * Delete a file, for everyone with the link.
   *
   * The same way `rm` in the terminal does it: gone from the sandbox, and the
   * diff that follows every command publishes the removal and tells the other
   * browsers, which drop it on their next read. The editor's copy goes first —
   * publishing writes every open file back into the sandbox before it
   * compares, and would put this one straight back.
   */
  private async deleteFile(path: string): Promise<void> {
    if (this.binaries.has(path) && !this.models.has(path)) return this.deleteBinary(path);
    if (this.models.size <= 1) {
      this.say("error", "a folder keeps at least one file");
      return;
    }
    if (this.busy || this.console?.busy) {
      this.say("error", "wait for what is running to finish");
      return;
    }
    const where = this.viewer ? "Only in this tab — the pad keeps it." : "It goes for everyone with the link.";
    if (!confirm(`Delete ${path}? ${where}`)) return;
    try {
      const rt = await this.ensureRuntime();
      // Onto another file before this one's model is disposed under the editor.
      if (this.active === path) this.show([...this.models.keys()].filter((p) => p !== path).sort()[0]!);
      this.dirty.delete(path);
      this.closeDoc(path);
      this.models.get(path)?.dispose();
      this.models.delete(path);
      await rt.removeAndPrune(path);
      this.renderFiles();
      await this.publish(rt);
      this.say("", `deleted ${path}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    }
  }


  /**
   * A folder and everything in it, for everyone: one store write, like a
   * move. The pad keeps at least one file the editor can show, as deleting a
   * file does. Without this, an empty folder the pad keeps could only be
   * removed from the terminal.
   */
  private async deleteFolder(path: string): Promise<void> {
    if (this.viewer) return this.say("error", "only people who can edit can delete folders");
    if (this.busy || this.console?.busy) return this.say("error", "wait for what is running to finish");
    const under = (p: string) => p.startsWith(`${path}/`);
    const text = [...this.models.keys()].filter(under);
    const binary = [...this.binaries.keys()].filter((p) => under(p) && !this.models.has(p));
    const markers = [...this.known].filter(([p, c]) => under(p) && isMarker(p, c)).map(([p]) => p);
    if (text.length > 0 && text.length === this.models.size) return this.say("error", "a pad keeps at least one file the editor can open");
    const count = text.length + binary.length;
    // Made in this tab and never kept — a viewer's: nothing to tell anyone.
    if (count === 0 && markers.length === 0) {
      this.tree?.forgetPending(path);
      return this.renderFiles();
    }
    const yes = await confirmDialog({
      title: `Delete ${path}?`,
      body: count ? `${count === 1 ? "The file" : `The ${count} files`} in it go too, for everyone with the link.` : "It is empty. It goes for everyone with the link.",
      confirm: "Delete",
      danger: true,
    });
    if (!yes) return;
    this.say("saving", `deleting ${path}…`);
    try {
      await this.queueWrite(async () => {
        const seq = await this.store.write(this.name, [...text, ...binary, ...markers].map((p) => ({ path: p, content: null })));
        this.storeSeq = Math.max(this.storeSeq, seq);
        if (under(this.active)) {
          const other = [...this.models.keys()].filter((p) => !under(p)).sort()[0];
          if (other) this.show(other);
        }
        for (const p of text) {
          this.dirty.delete(p);
          this.known.delete(p);
          this.closeDoc(p);
          this.models.get(p)?.dispose();
          this.models.delete(p);
        }
        for (const p of binary) this.binaries.delete(p);
        for (const p of markers) this.known.delete(p);
        const rt = this.runtimeReady ? await this.runtime : null;
        await rt?.removeTree(path).catch(() => {});
        this.tree?.forgetPending(path);
        this.renderFiles();
        this.peers?.moved(seq);
      });
      this.say("", `deleted ${path}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    }
  }

  /** A binary file, the same way: gone from the sandbox, and the diff after publishes it. */
  private async deleteBinary(path: string): Promise<void> {
    if (this.viewer) return this.say("error", "only people who can edit can delete the pad's files that are not text");
    if (this.busy || this.console?.busy) return this.say("error", "wait for what is running to finish");
    if (!confirm(`Delete ${path}? It goes for everyone with the link.`)) return;
    try {
      const rt = await this.ensureRuntime();
      await rt.remove(path);
      await this.publish(rt);
      this.say("", `deleted ${path}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    }
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
    if (this.viewer) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // A save sends the whole file, and at a few megabytes that is a tenth of
    // a second of the typist's editor, every pause. The room has each
    // keystroke as it is typed either way; only the stored copy waits longer.
    const biggest = Math.max(0, ...[...this.dirty].map((p) => this.models.get(p)?.getValueLength() ?? 0));
    this.saveTimer = setTimeout(() => void this.saveEdits(), biggest > 1_000_000 ? 2000 : 500);
  }

  /** Whatever is waiting to be saved, now: the tab is going out of sight, or away. */
  private flushSaves(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    void this.saveEdits(true);
  }

  private async saveEdits(leaving = false): Promise<void> {
    this.saveTimer = null;
    const paths = [...this.dirty];
    this.dirty.clear();

    // What changed is worked out in its turn in the write queue, against
    // `known` as the writes ahead of it left it. It used to be worked out
    // first: a Run's publish still writing when this timer fired left
    // `known` stale, so the same text was saved again after it and the
    // status said "saved" over the run's "exited 3" — what made a check flaky
    // on CI's macOS runner on 2 October.
    return this.queueWrite(async () => {
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
        const seq = await this.store.write(this.name, changes, leaving);
        this.storeSeq = Math.max(this.storeSeq, seq);
        for (const c of changes) this.known.set(c.path, c.content);
        // Do not copy an older completed save over text edited while its
        // request was in flight. The later edit remains queued for saving.
        if (this.runtime) {
          const rt = await this.runtime;
          for (const c of changes) {
            const current = this.docs.get(c.path)?.contents() ?? this.models.get(c.path)?.getValue();
            if (current === c.content) await rt.write(c.path, c.content);
          }
        }
        this.peers?.moved(seq);
        this.say("", "saved");
      } catch (e) {
        const why = e as StoreError;
        if (why.tooBig) {
          this.say("error", `${why.message} — this is not being saved`);
          return;
        }
        // Not this browser's to change any more. Re-reading says what it is
        // now; retrying would be refused for as long as the page is open.
        // The typing stays marked unsaved, so that if access is gone for
        // good the page keeps it rather than dropping it.
        if (why.refused || why.gone) {
          for (const p of paths) this.dirty.add(p);
          this.say("error", why.message);
          // Demoted while this save was in flight, the page looked for
          // unsaved work to keep and found none — this save had it. Kept now;
          // otherwise the re-read below demotes it, and keeps it then.
          if (this.viewer) this.keepUnsaved();
          else void this.refresh();
          return;
        }
        for (const p of paths) this.dirty.add(p);
        this.say("error", why.message);
        this.saveSoon();
      }
    });
  }

  private queueWrite(work: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(work, work);
    this.writeChain = run.catch(() => {});
    return run;
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
      const text = this.current(path);
      if (text !== undefined) await rt.write(path, text);
    }
  }

  /**
   * A file's text as it stands: its live document's when it has one with
   * state, its model's otherwise.
   *
   * Not the model alone. Only the file on screen is bound to its document;
   * one somebody else is typing in while this browser looks at another keeps
   * the model it had when it was last shown. Run wrote models into the
   * sandbox, so it put that older text back, and the publish after it saved
   * the older text over the newer — and to a viewer it looked like a change
   * of their own.
   */
  private current(path: string): string | undefined {
    const doc = this.docs.get(path);
    if (doc?.hasState) return doc.contents();
    return this.models.get(path)?.getValue();
  }

  // --------------------------------------------------------------- runtime

  /**
   * Fetch and start the runtime as soon as the folder is on screen.
   *
   * It used to wait for the first keystroke, so that someone opening a link
   * only to read it downloaded nothing. Measured on 25 September, that made the
   * commonest first act — pressing Run on the code as it stands — the slowest
   * thing in the product: 7.7 to 10.1 s from the button to any output, all of
   * it the download. Started here, it overlaps the seconds spent reading.
   *
   * The price is paid by every first-time visitor, readers included: 18.6 MB,
   * once, then cached for a year. A returning visitor downloads nothing, and
   * starting here also puts the python start — 1.5 s from cache — behind them
   * before they reach for Run. Editing still calls this; it does nothing twice.
   */
  private warm(): void {
    if (this.prefetched) return;
    this.prefetched = true;
    prefetch();
    // The shell too. With python already up, opening it — bash, then a round
    // of setup commands — was most of what was left of the first Run: 1.0 s
    // from the button on a return visit, measured, against 0.3 s for a second
    // Run. A failure here is left for the Run or command that needs the shell
    // to report, where somebody is looking.
    void this.ensureRuntime()
      .then(() => this.ensureShell())
      .catch(() => {});
  }

  private ensureRuntime(): Promise<Runtime> {
    this.runtime ??= (async () => {
      const files = seedFiles(this.known, this.models, this.docs);
      const binaries = new Map(this.binaries);
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
        const seed: Record<string, string | Uint8Array> = { ...files };
        for (const [path, base64] of binaries) seed[path] = fromBase64(base64);
        const rt = await Runtime.start(seed, network ? { network } : undefined);
      // Without a network policy the sandbox cannot listen at all, so this is
      // what makes a dev server started in the folder possible. It grants no
      // egress: `connect` is still refused. See docs/dev/networking.md.
      if (PREVIEW_ORIGIN) this.watchForServers(rt);
      await this.catchUp(rt, files, binaries);
      return rt;
    })();
    return this.runtime;
  }

  /**
   * Write in what changed while the runtime was starting, then call it ready.
   *
   * The sandbox was seeded from a snapshot, and a download can take a while.
   * Other people's changes kept arriving meanwhile, and `refresh` puts them
   * on screen without writing them here, since nothing here could take them.
   * So they are written now, before anything can run against the sandbox —
   * a command waits for this. Repeated until a pass finds nothing new, and
   * marked ready in the same step as that last look, so a change cannot land
   * between the two and be left out.
   */
  private async catchUp(rt: Runtime, seeded: Record<string, string>, seededBinaries: Binaries): Promise<void> {
    let applied = seeded;
    let appliedBinaries = seededBinaries;
    for (;;) {
      const now = seedFiles(this.known, this.models, this.docs);
      const nowBinaries = new Map(this.binaries);
      const writes = Object.entries(now).filter(([path, text]) => applied[path] !== text);
      const binaryWrites = [...nowBinaries].filter(([path, base64]) => appliedBinaries.get(path) !== base64);
      const removals = [...Object.keys(applied), ...appliedBinaries.keys()].filter((path) => !(path in now) && !nowBinaries.has(path));
      if (writes.length === 0 && binaryWrites.length === 0 && removals.length === 0) {
        this.runtimeReady = true;
        return;
      }
      for (const path of removals) await rt.removeAndPrune(path);
      for (const [path, text] of writes) await rt.write(path, text);
      for (const [path, base64] of binaryWrites) await rt.writeBytes(path, fromBase64(base64));
      applied = now;
      appliedBinaries = nowBinaries;
    }
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
      this.ui?.setPreview(false);
      if (!this.ui) this.el.preview.classList.remove("on");
      this.editor?.layout();
      this.editor?.focus();
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
      this.ui?.setPreview(true);
      if (!this.ui) this.el.preview.classList.add("on");
    } catch (e) {
      // The terminal is where everything else says what went wrong, and a
      // preview that fails silently is indistinguishable from one that is
      // slow.
      this.term?.write(`\r\n\x1b[31mpreview: ${(e as Error).message}\x1b[0m\r\n`);
      this.say("error", `preview: ${(e as Error).message}`);
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
    const terminalTheme = () => {
      const style = getComputedStyle(document.documentElement);
      return {
        background: style.getPropertyValue("--surface").trim(),
        foreground: style.getPropertyValue("--ink-2").trim(),
      };
    };
    const term = new Terminal({
      fontSize: Math.max(11, this.codeFontPx() - 1),
      convertEol: true,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.el.terminal);
    fit.fit();
    onThemeChange(() => {
      term.options.theme = terminalTheme();
      term.options.fontSize = Math.max(11, this.codeFontPx() - 1);
      fit.fit();
    }, this.events.signal);
    this.term = { write: (s) => term.write(s), fit: () => fit.fit(), dispose: () => term.dispose() };
    this.cols = term.cols;
    this.rows = term.rows;

    // The console owns the prompt, the echo and the line editing — bash
    // provides none of them. It asks for a shell only when a line is entered,
    // and completes against one only if it is already open.
    this.console = new Console({ write: (d) => term.write(d) }, {
      shellFor: () => this.ensureShell(),
      onFinished: () => void this.afterCommand(),
      openShell: () => (this.shell?.alive ? this.shell : null),
      columns: () => this.cols,
      onBusy: () => this.paintRun(),
      fullScreen: () => term.buffer.active.type === "alternate",
    });
    term.onData((data) => this.console?.handle(data));
    term.onResize(({ cols, rows }) => {
      this.cols = cols;
      this.rows = rows;
      void this.shell?.resize(cols, rows);
    });
    this.console.start();
  }

  private async ensureShell(): Promise<Shell> {
    // A shell that has exited cannot be reused. ctrl-d ends it, as does a
    // ctrl-c that a signal could not answer, so this is an ordinary path, not
    // an error case.
    if (this.shell && !this.shell.alive) this.shell = null;
    if (this.shell) return this.shell;
    // One opening at a time. The shell is now opened at load, so a Run pressed
    // while that is still in flight would otherwise start a second bash and
    // leave one of them orphaned.
    this.shellOpening ??= (async () => {
      try {
        const rt = await this.ensureRuntime();
        this.shell = await Shell.open(rt, { columns: this.cols, rows: this.rows }, (t) =>
          this.term?.write(t),
        );
        return this.shell;
      } finally {
        this.shellOpening = null;
      }
    })();
    return this.shellOpening;
  }

  // ------------------------------------------------------------------- run

  private wire(): void {
    this.el.run.onclick = () => {
      if (!this.console?.busy) return void this.run();
      // Run becomes Stop as soon as the program starts, so the second click
      // of a double-click would stop what the first one started.
      if (performance.now() - this.runPressed > 500) this.console.stop();
    };
    this.el.share.onclick = () => void this.share();
    // A viewer's changes exist nowhere but this tab. Browsers write their own
    // words on this prompt; the banner has already said what they would lose.
    addEventListener("beforeunload", (e) => {
      if (this.viewer && this.local.size > 0) e.preventDefault();
    }, { signal: this.events.signal });
    // Typing still inside its save delay went nowhere when the tab closed —
    // half a second of it, or two seconds in a big file — unless someone else
    // in the room saved it. Hidden is the last moment a page can count on,
    // and closing is the last at all.
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flushSaves();
    }, { signal: this.events.signal });
    addEventListener("pagehide", () => this.flushSaves(), { signal: this.events.signal });
    this.el.preview.onclick = () => void this.togglePreview();
    this.el.backToEditor.onclick = () => void this.togglePreview();
    addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.run();
      }
      // The reflex after typing code, and here it opened the browser's "Save
      // page as" dialog over the editor. There is nothing to do: every change
      // is saved as it is typed.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        this.say("", "no need — changes save as you type");
      }
    }, { signal: this.events.signal });
  }

  private async run(): Promise<void> {
    const program = interpreterFor(this.active);
    // Not over a command already running, typed or not: the button is Stop
    // then, and ⌘⏎ is ignored rather than answered with an error.
    if (!program || this.busy || this.console?.busy) return;

    this.busy = true;
    this.runPressed = performance.now();
    this.paintRun();
    try {
      // Asked for at load now, so whether it exists says nothing about whether
      // it is ready — only a Run pressed within the first seconds waits here.
      this.say("loading", this.runtimeReady ? "" : "getting python ready…");
      const rt = await this.ensureRuntime();
      const sh = await this.ensureShell();
      this.console?.attach(sh);

      // Flush every model before running. The editor holds the text; the
      // sandbox holds the file. They are not the same thing, and running
      // without this executes the previous version — the code on screen
      // correct, the output wrong, and nothing to suggest why.
      for (const path of this.models.keys()) await rt.write(path, this.current(path)!);

      this.say("running", "running…");
      // From the folder root, where the file tree's paths are, wherever the
      // terminal has been. A `cd sub` typed earlier made Run answer "can't open
      // file '/workspace/sub/main.py'". A subshell, so the terminal stays where
      // it was put; and only when it is needed, so the usual command is the
      // one a person would type. /workspace is the folder — see runtime.ts.
      const plain = `${program} ${JSON.stringify(this.active)}`;
      const here = (await sh.query("pwd")).trim();
      const command = !here || here === "/workspace" ? plain : `(cd /workspace && ${plain})`;
      // Shown the way a typed one would be, because that is what it is: the
      // button is a shortcut for typing, not a second way to execute.
      this.console?.announce(command);
      let finished: Finished | null = null;
      try {
        finished = await sh.run(command);
      } finally {
        this.console?.resume(finished);
      }

      this.say("saving", "saving…");
      await this.publish(rt);
      const { exitCode, interrupted } = finished;
      this.say("", exitCode === 0 ? "done" : interrupted ? "stopped" : `exited ${exitCode}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    } finally {
      this.busy = false;
      this.paintRun();
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
    if (this.viewer) return this.keepLocally(rt);
    return this.queueWrite(async () => {
      await this.flushModels(rt);
      const { changes, next, nextBinaries } = await diff(rt, this.known, this.binaries);
      if (changes.length === 0) return;
      let seq: number;
      try {
        seq = await this.store.write(this.name, changes);
      } catch (e) {
        // Refused: this page may not change the pad any more — its access
        // went while the command ran. What the command made is kept here,
        // as a viewer's own, rather than reported as an error and lost.
        if (!(e instanceof StoreError && (e.refused || e.gone))) throw e;
        await this.recheckAccess();
        if (this.viewer) await this.keepLocally(rt);
        return;
      }
      this.storeSeq = Math.max(this.storeSeq, seq);
      this.known = next;
      this.binaries = nextBinaries;
      for (const change of changes) {
        // Gone, or now binary: either way, no longer the editor's.
        if (change.content === null || change.encoding === "base64") {
          if (this.active === change.path) {
            const other = [...this.models.keys()].filter((p) => p !== change.path).sort()[0];
            if (other) this.show(other);
          }
          this.closeDoc(change.path);
          this.models.get(change.path)?.dispose();
          this.models.delete(change.path);
        } else if (!isMarker(change.path, change.content)) {
          // A file with a live document that is not the one on screen: the
          // command's change goes into the document too. Into the model alone,
          // it was undone here the moment the file was shown again — bound to
          // the document, which still had the old text — and never reached
          // anybody else in the room, whose next save could undo it for good.
          // (The one on screen carries it through its binding.)
          const doc = this.docs.get(change.path);
          if (doc && !doc.bound && doc.hasState) doc.replace(change.content);
          this.setFile(change.path, change.content);
        }
      }
      this.renderFiles();
      this.peers?.moved(seq);
    });
  }

  private async share(): Promise<void> {
    if (this.access.account) {
      return openShare({ name: this.name, access: this.access, code: codeFor(this.name) });
    }
    const url = `${location.origin}/${this.name}`;
    try {
      await navigator.clipboard.writeText(url);
      this.say("", "link copied");
    } catch {
      this.say("", url);
    }
  }

  // ---------------------------------------------------------------- roles

  private get viewer(): boolean {
    return this.access.role === "viewer";
  }

  /**
   * Take on what the store says this browser is to the pad.
   *
   * A viewer made an editor keeps viewing while they have local changes:
   * switching would start saving their own copies into the pad behind their
   * back. They are told, and a reload makes the switch.
   */
  private adopt(next: Access | undefined): void {
    this.granted = next ?? OPEN;
    this.noticeDeadLink();
    this.applyAccess();
  }

  /**
   * Take on what the server last said. Also run when a viewer's last local
   * change goes, since that is what was holding a promotion back.
   */
  private applyAccess(): void {
    if (this.lost) return;
    const access = this.granted;
    const held = this.viewer && access.role !== "viewer" && this.local.size > 0;
    const next: Access = held ? { ...access, role: "viewer" } : access;
    const couldWrite = this.access.role === "editor" || this.access.role === "owner";
    if (this.access.role === "owner" && next.role !== "owner" && this.granted.account) this.noticeSignedOut();
    const same =
      next.role === this.access.role &&
      next.view === this.access.view &&
      next.edit === this.access.edit &&
      next.account === this.access.account &&
      held === this.promoted;
    if (same) return;
    // The banner is not a live region — it is redrawn on every file switch —
    // so the one change in it that matters is said aloud here.
    if (held && !this.promoted) toast("You can edit this pad now — reload to join in. Save your copy first, or your changes go.");
    this.promoted = held;
    this.access = next;
    if (this.viewer && this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (couldWrite && this.viewer) this.keepUnsaved();
    this.el.share.title = this.access.account ? "Share this pad" : "Copy the link";
    this.paintBanner();
    this.renderFiles();
  }

  /**
   * A link this browser kept for the pad that the server no longer honours —
   * reset, or turned off by its owner. Said once, and forgotten, rather than
   * leaving someone to wonder why their edit link opens it to view.
   */
  private noticeDeadLink(): void {
    if (!this.granted.account || this.granted.role === "owner") return;
    if (this.granted.link) return acceptCode(this.name);
    if (!codeFor(this.name)) return;
    // A code-shaped hash that replaced a working code: the working one comes back.
    if (restorePreviousCode(this.name)) return location.reload();
    forgetCode(this.name);
    toast("The link you opened this with no longer works — its owner reset it or turned it off.", "error");
  }

  /**
   * Access is gone: the pad was made private to this browser, or deleted, or
   * the session that owned it ended. With nothing unsaved here, the page
   * becomes the private (or deleted) screen. With work here that exists
   * nowhere else — typing not yet saved, a viewer's own copies — the page
   * stays, with that work, so it can be saved as a copy rather than lost.
   */
  private lose(why: "private" | "gone"): void {
    if (this.lost) return;
    if (this.access.role === "owner" && why === "private") this.noticeSignedOut();
    if (this.dirty.size === 0 && this.local.size === 0) return this.hooks.onPrivate?.(why);
    this.lost = why;
    this.peers?.close();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    for (const path of [...this.docs.keys()]) {
      this.closeDoc(path);
      this.local.add(path);
    }
    for (const path of this.dirty) this.local.add(path);
    this.access = { ...this.granted, role: "viewer" };
    this.renderFiles();
    this.paintBanner();
    // Short: the banner says the rest, and a long status wrapped the header.
    this.say("error", why === "gone" ? "deleted" : "no access");
  }

  /**
   * Typing that never reached the store when this page stopped being allowed
   * to save it — editing locked, the link reset, the owner's session ended.
   * It is the only copy, so it becomes this tab's own rather than being
   * dropped with the save that was refused.
   */
  private keepUnsaved(): void {
    let kept = 0;
    this.applyingRemote = true;
    try {
      for (const path of [...this.dirty]) {
        if (this.local.has(path)) continue;
        const text = this.current(path);
        if (text === undefined || text === this.known.get(path)) continue;
        this.closeDoc(path);
        this.setFile(path, text);
        this.local.add(path);
        kept += 1;
      }
    } finally {
      this.applyingRemote = false;
    }
    if (kept === 0) return;
    this.renderFiles();
    this.paintBanner();
    toast(`Your access to this pad changed before ${kept === 1 ? "a change" : `${kept} changes`} of yours could be saved. ${kept === 1 ? "It's" : "They're"} kept here as your own copy — Save as my copy to keep ${kept === 1 ? "it" : "them"}.`, "error");
  }

  /**
   * Ask the store what this page may do now — even mid-command, when
   * `refresh` holds off — after a save was refused.
   */
  private async recheckAccess(): Promise<void> {
    try {
      this.adopt((await this.store.read(this.name)).access);
    } catch (e) {
      if (e instanceof StoreError && (e.refused || e.gone)) this.lose(e.gone ? "gone" : "private");
    }
  }

  /**
   * The owner's session ended under this page. Said once, with the way back:
   * sign in again in another tab, and on returning here what this page kept
   * goes into the pad.
   */
  private noticeSignedOut(): void {
    if (this.signedOut) return;
    this.signedOut = true;
    toast("You were signed out. Sign in again in another tab — your work here stays, and goes into the pad when you're back.", "error");
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.regain();
    }, { signal: this.events.signal });
  }

  /** Back, signed in as the owner again: what this page kept goes into the pad, then it starts afresh. */
  private async regain(): Promise<void> {
    if (!this.signedOut) return;
    let pad: Pad;
    try {
      pad = await this.store.read(this.name);
    } catch {
      return;
    }
    if (pad.access?.role !== "owner") return;
    const changes = [...this.local].map((path) => ({ path, content: this.models.get(path)?.getValue() ?? null }));
    try {
      if (changes.length) await this.store.write(this.name, changes);
    } catch (e) {
      this.say("error", (e as Error).message);
      return;
    }
    this.local.clear();
    this.dirty.clear();
    location.reload();
  }

  // ------------------------------------------------------- zips, in and out

  /**
   * What is on this page, as files: each file's text as it stands here — a
   * viewer's own copies included — and the binary files the pad holds that
   * the editor does not show. `under` keeps one folder's.
   */
  private async collect(under = ""): Promise<ZipEntry[]> {
    const inside = (p: string) => !under || p.startsWith(`${under}/`);
    const out = new Map<string, Uint8Array>();
    for (const [path, base64] of this.binaries) {
      if (inside(path) && !this.local.has(path) && !this.models.has(path)) out.set(path, fromBase64(base64));
    }
    const enc = new TextEncoder();
    for (const path of this.models.keys()) if (inside(path)) out.set(path, enc.encode(this.current(path) ?? ""));
    // An empty folder as its marker, so it survives a download and coming back.
    for (const [path, content] of this.known) if (isMarker(path, content) && inside(path) && !out.has(path)) out.set(path, new Uint8Array());
    return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, data }));
  }

  /**
   * The whole pad, in a folder named after it as GitHub's zips are: it
   * unpacks into one place, and Upload a zip takes that folder off again, so
   * the files come back where they were whatever the pad's layout.
   */
  private async downloadAll(): Promise<void> {
    const entries = await this.collect();
    if (!entries.length) return this.say("", "nothing here to download yet");
    save(await makeZip(entries.map((e) => ({ path: `${this.name}/${e.path}`, data: e.data }))), `${this.name}.zip`);
    this.say("", `downloaded ${entries.length} ${entries.length === 1 ? "file" : "files"} as ${this.name}.zip`);
  }

  /** One file as itself; a folder as a zip, with the folder at its top. */
  private async download(path: string, folder: boolean): Promise<void> {
    const leaf = path.split("/").pop()!;
    if (!folder) {
      const entry = (await this.collect()).find((e) => e.path === path);
      if (entry) save(new Blob([entry.data as BlobPart], { type: "application/octet-stream" }), leaf);
      return;
    }
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const entries = (await this.collect(path)).map((e) => ({ path: e.path.slice(parent.length), data: e.data }));
    if (!entries.length) return this.say("", `${path} has nothing in it to download`);
    save(await makeZip(entries), `${leaf}.zip`);
  }

  /** The starter on an empty pad, as it was put there — unsaved and untouched. */
  private untouchedStarter(): boolean {
    return this.starter && !this.known.has("main.py") && this.models.get("main.py")?.getValue() === STARTER;
  }

  /**
   * A zip's files into this pad, for everyone on it. Read and checked here —
   * its text files only, the pad's limits held to before anything is sent —
   * and asked about first if it would replace files that are already here.
   */
  private async importZip(given?: File): Promise<void> {
    if (this.viewer || this.importing) return;
    const zip = given ?? (await pickZip());
    if (!zip) return;
    if (this.busy || this.console?.busy) return this.say("error", "wait for what is running to finish, then import");
    this.importing = true;
    try {
      this.say("loading", `reading ${zip.name}…`);
      let prepared: Prepared;
      try {
        prepared = prepareImport(await readZip(zip, PAD_LIMITS));
      } catch (e) {
        return this.say("error", e instanceof ZipError ? e.message : `could not read ${zip.name} as a zip`);
      }
      const { files } = prepared;
      const skipped = leftOut(prepared);
      if (!files.length) return this.say("error", `nothing in ${zip.name} a pad can hold${skipped ? ` — ${skipped}` : ""}`);
      // The starter makes way only for text: a zip of images alone would
      // leave the editor nothing to show.
      const starter = this.untouchedStarter() && files.some((f) => f.encoding === "utf8" && !isMarker(f.path, f.content));
      const after = new Set([...this.models.keys(), ...this.binaries.keys(), ...files.map((f) => f.path)]);
      if (starter && !files.some((f) => f.path === "main.py")) after.delete("main.py");
      if (after.size > PAD_LIMITS.maxFiles) return this.say("error", `that would make ${after.size} files here; a pad holds at most ${PAD_LIMITS.maxFiles}`);

      const replacing = files.filter((f) =>
        f.encoding === "base64"
          ? (this.binaries.has(f.path) && this.binaries.get(f.path) !== f.content) || this.models.has(f.path)
          : (this.models.has(f.path) && !(f.path === "main.py" && starter) && this.current(f.path) !== f.content) || this.binaries.has(f.path),
      );
      if (replacing.length) {
        const yes = await confirmDialog({
          title: replacing.length === 1 ? `Replace ${replacing[0]!.path}?` : `Replace ${replacing.length} files?`,
          body: `${zip.name} has ${replacing.length === 1 ? "a file" : `${replacing.length} files`} with the same ${replacing.length === 1 ? "name as one" : "names as ones"} here. Its ${replacing.length === 1 ? "version replaces" : "versions replace"} what is here, for everyone on this pad.`,
          confirm: "Replace",
        });
        if (!yes) return this.say("", "");
      }

      this.say("saving", `adding ${files.length} ${files.length === 1 ? "file" : "files"}…`);
      await this.queueWrite(async () => {
        const seq = await this.store.write(this.name, files.map((f) => ({ path: f.path, content: f.content, encoding: f.encoding })));
        this.storeSeq = Math.max(this.storeSeq, seq);
        const rt = this.runtimeReady ? await this.runtime : null;
        this.applyingRemote = true;
        try {
          for (const f of files) {
            if (f.encoding === "base64") {
              // Not the editor's: into the tree and the sandbox as it is.
              if (this.models.has(f.path)) {
                if (this.active === f.path) this.active = "";
                this.closeDoc(f.path);
                this.models.get(f.path)?.dispose();
                this.models.delete(f.path);
                this.known.delete(f.path);
              }
              this.binaries.set(f.path, f.content);
              await rt?.writeBytes(f.path, fromBase64(f.content));
              continue;
            }
            this.binaries.delete(f.path);
            this.known.set(f.path, f.content);
            this.dirty.delete(f.path);
            if (isMarker(f.path, f.content)) {
              await rt?.write(f.path, "");
              continue;
            }
            // A file someone has open changes as their typing would, so the
            // room's documents take it rather than undoing it on the next save.
            const doc = this.docs.get(f.path);
            if (doc?.bound) this.models.get(f.path)?.setValue(f.content);
            else if (doc) {
              doc.replace(f.content);
              this.setFile(f.path, f.content);
            } else this.setFile(f.path, f.content);
            await rt?.write(f.path, f.content);
          }
          // The starter makes way for what was brought in.
          if (starter && !files.some((f) => f.path === "main.py")) {
            if (this.active === "main.py") this.active = "";
            this.closeDoc("main.py");
            this.models.get("main.py")?.dispose();
            this.models.delete("main.py");
            await rt?.remove("main.py").catch(() => {});
          }
        } finally {
          this.applyingRemote = false;
        }
        this.starter = false;
        this.peers?.moved(seq);
      });
      if (!this.models.has(this.active)) {
        const first = files.filter((f) => f.encoding === "utf8" && !isMarker(f.path, f.content)).map((f) => f.path).sort()[0] ?? [...this.models.keys()].sort()[0];
        if (first) this.show(first);
      }
      this.renderFiles();
      this.say("", `added ${files.length} ${files.length === 1 ? "file" : "files"} from ${zip.name}${skipped ? ` — ${skipped}` : ""}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    } finally {
      this.importing = false;
    }
  }

  // ------------------------------------------------------------- moving

  /**
   * A file or folder to a new path, for everyone on the pad: dragged onto a
   * folder in the tree, or F2 and a path typed. One store write carries the
   * new paths and the old ones' removal together; then this page's editor,
   * documents and sandbox follow, and everyone else's next read does the same
   * for them. Like an import, it never waits for the sandbox to arrive.
   */
  private async move(from: string, folder: boolean, toRaw: string): Promise<void> {
    if (this.viewer || this.moving) return;
    const to = toRaw.trim().replace(/^\/+|\/+$/g, "");
    if (!to || to === from) return;
    const safe = to.split("/").every((p) => p && p !== "." && p !== ".." && !/[\u0000-\u001f\\]/.test(p)) && new TextEncoder().encode(to).length <= 512;
    if (!safe) return this.say("error", `${to} is not a path a pad can hold`);
    if (folder && to.startsWith(`${from}/`)) return this.say("error", "a folder cannot go inside itself");
    const isBinary = (p: string) => this.binaries.has(p) && !this.models.has(p);
    const isKeep = (p: string) => isMarker(p, this.known.get(p)) && !this.models.has(p);
    const exists = (p: string) => this.models.has(p) || this.binaries.has(p);
    const markers = [...this.known.keys()].filter(isKeep);
    const paths = [...this.models.keys(), ...[...this.binaries.keys()].filter(isBinary), ...markers];
    if (!folder && paths.some((p) => p.startsWith(`${to}/`))) return this.say("error", `there is already a folder called ${to}`);
    if (folder && exists(to)) return this.say("error", `there is already a file called ${to}`);
    if (this.busy || this.console?.busy) return this.say("error", "wait for what is running to finish, then move it");

    const pairs = paths.filter((p) => (folder ? p.startsWith(`${from}/`) : p === from)).map((p) => [p, to + p.slice(from.length)] as const);
    // A folder made in this tab with nothing in it yet exists only here.
    if (pairs.length === 0) {
      this.tree?.moved(from, to);
      return this.renderFiles();
    }
    const leaving = new Set(pairs.map(([p]) => p));
    // An empty folder's marker merges quietly; only files are asked about.
    const replacing = pairs.filter(([p, t]) => !isKeep(p) && exists(t) && !leaving.has(t));
    if (replacing.length) {
      const one = replacing.length === 1;
      const yes = await confirmDialog({
        title: one ? `Replace ${replacing[0]![1]}?` : `Replace ${replacing.length} files?`,
        body: `${one ? "A file" : `${replacing.length} files`} with the same ${one ? "name is" : "names are"} already there. Moving ${from} replaces ${one ? "it" : "them"}, for everyone on this pad.`,
        confirm: "Replace",
      });
      if (!yes) return;
    }

    this.moving = true;
    this.say("saving", `moving ${from}…`);
    try {
      await this.queueWrite(async () => {
        // The text as it stands here, typing not yet saved included; a
        // binary file as the store has it.
        const binaryPairs = pairs.filter(([p]) => isBinary(p));
        const markerPairs = pairs.filter(([p]) => isKeep(p));
        const textPairs = pairs.filter(([p]) => !isBinary(p) && !isKeep(p));
        const text = new Map(textPairs.map(([p]) => [p, this.current(p) ?? ""]));
        const changes: Change[] = [
          ...textPairs.map(([p, t]) => ({ path: t, content: text.get(p)! })),
          ...binaryPairs.map(([p, t]): Change => ({ path: t, content: this.binaries.get(p)!, encoding: "base64" })),
          ...markerPairs.map(([, t]) => ({ path: t, content: "" })),
          ...pairs.map(([p]) => ({ path: p, content: null })),
        ];
        const seq = await this.store.write(this.name, changes);
        this.storeSeq = Math.max(this.storeSeq, seq);
        const rt = this.runtimeReady ? await this.runtime : null;
        const active = this.active;
        this.applyingRemote = true;
        try {
          for (const [p, t] of binaryPairs) {
            const base64 = this.binaries.get(p)!;
            // Replacing a text file: it is not the editor's any more.
            if (this.models.has(t)) {
              this.closeDoc(t);
              this.models.get(t)?.dispose();
              this.models.delete(t);
              this.known.delete(t);
            }
            this.binaries.delete(p);
            this.binaries.set(t, base64);
            await rt?.writeBytes(t, fromBase64(base64));
            if (!folder) await rt?.removeAndPrune(p);
          }
          for (const [p, t] of markerPairs) {
            this.known.delete(p);
            this.known.set(t, "");
            await rt?.write(t, "");
          }
          for (const [p, t] of textPairs) {
            this.binaries.delete(t);
            this.closeDoc(t);
            this.setFile(t, text.get(p)!);
            this.known.set(t, text.get(p)!);
            this.dirty.delete(t);
          }
          // Onto the new path before the old model goes from under the editor,
          // and where it was in the file with it.
          const followed = textPairs.find(([p]) => p === active)?.[1];
          if (followed) {
            const state = this.editor?.saveViewState();
            if (state) this.viewStates.set(followed, state);
            this.show(followed);
          }
          for (const [p, t] of textPairs) {
            const state = this.viewStates.get(p);
            if (state && !this.viewStates.has(t)) this.viewStates.set(t, state);
            this.viewStates.delete(p);
          }
          for (const [p] of textPairs) {
            this.dirty.delete(p);
            this.known.delete(p);
            this.closeDoc(p);
            this.models.get(p)?.dispose();
            this.models.delete(p);
          }
          for (const [p, t] of textPairs) {
            await rt?.write(t, text.get(p)!);
            if (!folder) await rt?.removeAndPrune(p);
          }
          // A folder goes whole, so nothing of it is left to be published back.
          if (folder) await rt?.removeTree(from).catch(() => {});
        } finally {
          this.applyingRemote = false;
        }
        this.tree?.moved(from, to);
        this.renderFiles();
        this.peers?.moved(seq);
      });
      this.say("", `moved ${from} to ${to}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    } finally {
      this.moving = false;
    }
  }

  /** A zip dropped on the file list goes in as Upload a zip would take it. */
  private acceptDrops(): void {
    const files = this.el.files;
    const hasFiles = (e: DragEvent) => !this.viewer && [...(e.dataTransfer?.types ?? [])].includes("Files");
    files.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      files.classList.add("dropping");
    }, { signal: this.events.signal });
    files.addEventListener("dragleave", () => files.classList.remove("dropping"), { signal: this.events.signal });
    files.addEventListener("drop", (e) => {
      files.classList.remove("dropping");
      if (!hasFiles(e)) return;
      // Taken either way: left alone, the browser opens the file in place of the pad.
      e.preventDefault();
      const zip = [...(e.dataTransfer?.files ?? [])].find((f) => /\.zip$/i.test(f.name));
      if (zip) void this.importZip(zip);
      else this.say("error", "drop a .zip here to add the files in it");
    }, { signal: this.events.signal });
  }

  /** A pad that was just made by Save as my copy says so, once. */
  private welcomeCopy(): void {
    const params = new URLSearchParams(location.search);
    const imported = params.get("imported");
    if (imported) {
      const skipped = Number(params.get("skipped") ?? 0);
      params.delete("imported");
      params.delete("skipped");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
      toast(`Made from your zip: ${imported} ${imported === "1" ? "file" : "files"}${skipped ? `, and ${skipped} left out — ${skipped === 1 ? "its path was" : "their paths were"} outside the folder` : ""}.`);
      return;
    }
    // Made by Copy a pad on the dashboard. Only a name's shape is repeated.
    const from = params.get("from");
    if (from !== null) {
      const files = params.get("files") ?? "";
      params.delete("from");
      params.delete("files");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
      if (/^[a-z0-9-]{1,64}$/.test(from) && /^\d+$/.test(files)) {
        toast(`Copied from ${from}: ${files} ${files === "1" ? "file" : "files"}, as last saved. ${from} itself is unchanged.`);
      }
      return;
    }
    const copied = params.get("copied");
    if (!copied) return;
    params.delete("copied");
    const rest = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}`);
    toast(copied === "account" ? "This is your copy — a pad of your own. Share it from Share." : "This is your copy. It's an open pad: anyone with its link can edit it.");
  }

  /** A file a viewer has changed becomes theirs: no live document any more. */
  private detach(path: string): void {
    if (!this.viewer) return;
    this.closeDoc(path);
    this.dirty.add(path);
    this.markLocal(path);
  }

  private markLocal(path: string): void {
    if (this.local.has(path)) return;
    this.local.add(path);
    this.renderFiles();
    this.paintBanner();
  }

  /**
   * A viewer's document holding updates it cannot place.
   *
   * It happens when every editor who shared its history has left and the
   * next one to arrive starts the document again from the stored copy: the
   * viewer answered DOC_NONE, as it must, and now holds a history nobody
   * else does, so nothing that arrives fits. Given a moment to settle, it is
   * thrown away and asked for again, and the room's current one comes back.
   */
  private unstick(path: string, doc: DocSession): void {
    if (!doc.stuck) {
      clearTimeout(this.stuck.get(path));
      this.stuck.delete(path);
      return;
    }
    if (this.stuck.has(path)) return;
    this.stuck.set(
      path,
      setTimeout(() => {
        this.stuck.delete(path);
        if (this.docs.get(path) !== doc || !doc.stuck) return;
        this.closeDoc(path);
        if (this.active === path) this.show(path);
      }, STUCK_WAIT),
    );
  }

  /**
   * What a viewer's command changed, kept in this tab.
   *
   * The same comparison an editor's publish makes, minus the store: the
   * sandbox against the stored folder. A file that differs only because the
   * room has typed since the last save is not the viewer's change — its live
   * document says so — and stays live.
   */
  private async keepLocally(rt: Runtime): Promise<void> {
    await this.flushModels(rt);
    const { changes } = await diff(rt, this.known, this.binaries);
    this.applyingRemote = true;
    try {
      for (const change of changes) {
        // A viewer's binary files stay in their sandbox, where they made them:
        // the tree here shows the pad's, and the editor cannot hold them.
        if (change.encoding === "base64" || this.binaries.has(change.path)) continue;
        // Empty folders a viewer makes stay in their sandbox too.
        if (isMarker(change.path, change.content) || isMarker(change.path, this.known.get(change.path))) continue;
        const doc = this.docs.get(change.path);
        if (doc && change.content === doc.contents()) continue;
        if (this.local.has(change.path) && this.models.get(change.path)?.getValue() === change.content) continue;
        this.closeDoc(change.path);
        this.local.add(change.path);
        if (change.content === null) {
          if (this.active === change.path) {
            const other = [...this.models.keys()].filter((p) => p !== change.path).sort()[0];
            if (other) this.show(other);
          }
          this.models.get(change.path)?.dispose();
          this.models.delete(change.path);
        } else {
          this.setFile(change.path, change.content);
        }
      }
    } finally {
      this.applyingRemote = false;
    }
    this.renderFiles();
    this.paintBanner();
  }

  /** Throw away a viewer's copy of a file and go back to the pad's. */
  private async discard(path: string): Promise<void> {
    if (!this.local.has(path)) return;
    this.local.delete(path);
    this.dirty.delete(path);
    const stored = this.known.get(path);
    const rt = this.runtimeReady ? await this.runtime : null;
    this.applyingRemote = true;
    try {
      if (stored === undefined) {
        // Made here and never in the pad: going back to the pad's is deleting it.
        const other = [...this.models.keys()].filter((p) => p !== path).sort()[0];
        if (this.active === path && other) this.show(other);
        this.models.get(path)?.dispose();
        this.models.delete(path);
        await rt?.remove(path).catch(() => {});
      } else {
        this.setFile(path, stored);
        await rt?.write(path, stored);
      }
    } finally {
      this.applyingRemote = false;
    }
    // Showing it again joins the room's live document, which may be ahead of
    // the stored copy just put back.
    if (this.models.has(path) && this.active === path) this.show(path);
    this.renderFiles();
    this.paintBanner();
    this.say("", `back to the pad's ${path}`);
    // The last local change gone may be all that held back a promotion.
    this.applyAccess();
  }

  /** Every local change at once — including files a command deleted, which have no row to pick. */
  private async discardAll(): Promise<void> {
    const yes = await confirmDialog({
      title: "Discard all your changes?",
      body: `Every file you changed here goes back to the pad's version${this.local.size === 1 ? "" : ` — ${this.local.size} files`}. This can't be undone.`,
      confirm: "Discard all",
      danger: true,
    });
    if (!yes) return;
    for (const path of [...this.local]) await this.discard(path);
    if (this.models.has(this.active)) this.show(this.active);
    this.say("", "back to the pad as it is");
  }

  /**
   * Make a new pad of what a viewer has here: the pad as it stands, with
   * their changes on top. Theirs if they are signed in, and an open one —
   * anyone with its link edits — if not.
   */
  private async saveCopy(): Promise<void> {
    if (this.copying) return;
    this.copying = true;
    let leaving = false;
    this.say("saving", "making your copy…");
    try {
      const files = new Map<string, Change>();
      // The pad as stored, when this page may still read it; after access is
      // lost, what is on this page is all there is.
      if (!this.lost) {
        const pad = await this.store.read(this.name);
        for (const [path, f] of Object.entries(pad.files)) files.set(path, { path, content: f.content, encoding: f.encoding });
      } else {
        for (const [path, model] of this.models) files.set(path, { path, content: model.getValue() });
        for (const [path, base64] of this.binaries) if (!files.has(path)) files.set(path, { path, content: base64, encoding: "base64" });
        for (const [path, content] of this.known) if (isMarker(path, content) && !files.has(path)) files.set(path, { path, content: "" });
      }
      // Live documents are ahead of the stored copy.
      for (const [path, doc] of this.docs) if (doc.hasState) files.set(path, { path, content: doc.contents() });
      for (const path of this.local) {
        const model = this.models.get(path);
        if (model) files.set(path, { path, content: model.getValue() });
        else files.delete(path);
      }
      if (files.size === 0) throw new Error("there is nothing here to copy");

      let target = await this.newPadName();
      if (!target) return this.say("", "");
      try {
        await this.store.write(target.name, [...files.values()]);
      } catch (e) {
        // A pad of theirs was made for this; it must not stay behind empty,
        // using up a place in their account.
        if (target.account) await account.remove(target.name).catch(() => {});
        if (!(target.account && e instanceof StoreError && e.tooBig)) throw e;
        const open = await confirmDialog({
          title: "Your account is full",
          body: "Your pads together are at the space an account can hold, so this copy does not fit. Make an open pad instead? Anyone with its link can edit it.",
          confirm: "Make an open pad",
        });
        if (!open) return this.say("", "");
        target = { name: await this.openPadName(), account: false };
        await this.store.write(target.name, [...files.values()]);
      }
      // Nothing is left behind now, so leaving needs no warning.
      this.local.clear();
      this.dirty.clear();
      leaving = true;
      location.assign(`/${target.name}?copied=${target.account ? "account" : "open"}`);
    } catch (e) {
      this.say("error", `could not make your copy: ${(e as Error).message}`);
    } finally {
      // Held while the page goes; released for a cancelled or failed one.
      if (!leaving) this.copying = false;
    }
  }

  /** A pad of your own if you are signed in; otherwise a fresh open one. */
  private async newPadName(): Promise<{ name: string; account: boolean } | null> {
    // A failure to ask is an error, not a sign of being signed out: it must
    // not turn someone's copy into an open pad.
    const me = await account.me();
    if (!me.user && this.access.account) {
      // Copying a pad that is not open into one that is: never unasked.
      const open = await confirmDialog({
        title: "Make an open copy?",
        body: this.signedOut
          ? "You're signed out, so your copy would be an open pad: anyone with its link could view and edit it. Sign in again in another tab first to keep it yours."
          : "You're not signed in, so your copy will be an open pad: anyone with its link can view and edit it.",
        confirm: "Make an open pad",
      });
      return open ? { name: await this.openPadName(), account: false } : null;
    }
    if (me.user) {
      try {
        return { name: (await account.create()).name, account: true };
      } catch (e) {
        if (!(e instanceof AccountError && e.status === 507)) throw e;
        const open = await confirmDialog({
          title: "Your account is full",
          body: "You have as many pads as an account can hold. Make an open pad instead? Anyone with its link can edit it.",
          confirm: "Make an open pad",
        });
        if (!open) return null;
      }
    }
    return { name: await this.openPadName(), account: false };
  }

  /**
   * A free open-pad name. Minted here, as every anonymous name is — so
   * checked, because writing into somebody else's open pad would add these
   * files to theirs.
   */
  private async openPadName(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const name = mintName();
      if (!(await this.store.read(name)).exists) return name;
    }
    throw new Error("could not find a free name — try again");
  }

  /** What a viewer can do instead, always on screen. */
  private paintBanner(): void {
    if (!this.ui) return;
    const own = this.local.has(this.active) && this.models.has(this.active);
    const key = this.viewer ? `${this.lost}|${this.signedOut}|${own ? this.active : ""}|${this.local.size}|${this.promoted}` : "";
    if (key === this.bannerKey) return;
    this.bannerKey = key;
    if (!this.viewer) return this.ui.setBanner(null);
    const bar = document.createElement("div");
    bar.className = "viewing";
    const text = document.createElement("span");
    text.className = "viewing-text";
    const actions = document.createElement("span");
    actions.className = "viewing-actions";
    const button = (label: string, onClick: () => void, primary = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `quiet-button${primary ? " primary" : ""}`;
      b.textContent = label;
      b.onclick = onClick;
      return b;
    };
    const pill = document.createElement("span");
    pill.className = `viewing-pill${own || this.lost ? " own" : ""}`;
    pill.innerHTML = `${this.lost ? ICONS.lock : own ? ICONS.pencil : ICONS.eye}<span>${this.lost ? "No access" : own ? "Your copy" : "Viewing"}</span>`;
    if (this.signedOut && this.lost !== "gone") {
      text.textContent = "You were signed out. Sign in again in another tab and come back: what's on this page goes into the pad.";
      const again = document.createElement("a");
      again.className = "quiet-button";
      again.href = "/dashboard";
      again.target = "_blank";
      again.textContent = "Sign in again";
      actions.append(again);
    } else if (this.lost) {
      text.textContent =
        this.lost === "gone"
          ? "This pad was deleted. What's on this page stays until you leave — save it as your own copy to keep it."
          : "You no longer have access to this pad. What's on this page stays until you leave — save it as your own copy to keep it.";
    } else if (own) {
      text.textContent = `You're editing your own copy of ${this.active}. Changes to it from the pad no longer arrive.`;
      actions.append(button("Discard my changes", () => void this.discard(this.active)));
    } else if (this.local.size > 0) {
      const n = this.local.size;
      text.textContent = `${n} local ${n === 1 ? "change" : "changes"}, kept in this tab only. The rest follows the pad live.`;
      actions.append(button("Discard all my changes", () => void this.discardAll()));
    } else {
      text.textContent = "Watching live. You can run and change things, but your changes stay in this tab.";
    }
    if (this.promoted && !this.lost) {
      text.textContent += " You can edit this pad now: reload to join in — save your copy first, or your changes go.";
      actions.append(button("Reload", () => location.reload()));
    }
    actions.append(button("Save as my copy", () => void this.saveCopy(), true));
    bar.append(pill, text, actions);
    this.ui.setBanner(bar);
  }

  private say(status: Status, text: string): void {
    this.el.status.textContent = text;
    this.el.status.dataset.status = status;
  }

  private codeFontPx(): number {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return Math.max(11, Math.min(20, root * 0.8125));
  }

  /**
   * The page came back from the browser's back-forward cache — Back from Your
   * pads, say — exactly as it was left, editor and all. Only the world moved:
   * the room's socket was closed while it was frozen, and the pad may have
   * changed, or who this browser is to it — signed in or out meanwhile. So the
   * room is dialled again and the pad read again, which says both.
   */
  resume(): void {
    if (this.disposed) return;
    // A copy that navigated away left these set; back here, they would stop
    // Save as my copy for good.
    this.copying = false;
    clearBusy();
    this.peers?.resume();
    void this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const timer of this.stuck.values()) clearTimeout(timer);
    this.events.abort();
    this.peers?.close();
    this.unbind?.();
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.editor?.dispose();
    this.term?.dispose();
    void this.shell?.close().catch(() => {});
  }
}

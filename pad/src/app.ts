/**
 * The page: a file list, an editor, a terminal, and one Run.
 *
 * Everything heavy loads late. The editor is usable before the runtime exists,
 * because the first thing anyone does here is paste — and the runtime is a
 * 60 MB download that would otherwise be in the way of that.
 */
import type * as Monaco from "monaco-editor";

import type { SandboxOptions } from "@wasmer/sdk";
import { defineEditorThemes, editorTheme, languageFor, onThemeChange, registerDelimited } from "@ajar/workspace-ui";

import { acceptCode, type Access, account, AccountError, codeFor, forgetCode, OPEN, restorePreviousCode, size } from "./access";
import { applied, carryOver, type Edit, putBack } from "./carry";
import { Suggestions } from "./complete";
import { ProjectSearch } from "./search";
import { replaced, type ReplacementFile, type ReplacementPlan, type SearchMatch } from "./search-match";
import { colourFor, DocSession, replaceText, utf8Of } from "./editing";
import { FileTree } from "./files";
import { formatterFor, formatText, problemOf, usesTabs } from "./format";
import { DOC_AWARENESS, DOC_NONE, DOC_UPDATE, DOC_WANT, Peers, streamFor } from "./peers";
import { JavacBridge } from "./javac/bridge";
import { FetchBridge } from "./fetch-bridge";
import { PreviewBrowser } from "./preview";
import { at, interpreterFor, prefetch, ROOT, Runtime } from "./runtime";
import { neededBy, quoted, runnerFor, TOOLCHAINS } from "./toolchains";
import { type Finished, type Shell } from "./shell";
import type { TerminalSession } from "./terminals";
import { loadEditor } from "./editor-load";
import { ICONS } from "./icons";
import { openOpenShare, openShare } from "./share";
import { button, clearBusy, confirmDialog, el, modal, nameDialog, toast, toastRegions } from "./ui";
import { leftOut, makeZip, pickZip, type Prepared, prepareImport, readZip, save, ZipError, type ZipEntry } from "./zip";
import { loadLimits } from "./limits";
import { type Change, type LastRun, mintName, Store, StoreError, storedHash, type Pad, type Version } from "./store";
import { type Place, problemsIn } from "./problems";
import { seedFiles } from "./seed";
import { Texts } from "./texts";
import { starterFor } from "./starters";
import { type Binaries, binariesFrom, diff, fromBase64, ignored, isMarker, type Known, knownFrom, MARKER, MAX_FILES, markedFolder, textOf, toBase64, unstorable } from "./sync";
import { imageFromOsc, imageType } from "./images";
import { isMarkdown, linkFor, MARKDOWN_MAX, renderMarkdown, slug } from "./markdown";
import { countRun, languageOfFile, languageOfLine } from "./usage";
import { pipInstalled, requirementLines, requirementName } from "./requirements";
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

/**
 * How long a text file is before its saves go as edits. Below this the whole
 * file is a small request anyway, and hashing it would cost more than sending it.
 */
const EDITS_FROM = 16 * 1024;

/**
 * A save refused as stale is read, merged and sent again this many times in
 * all, the store's version named each time, before it is said to have failed
 * and left for the next save to try.
 */
const STALE_TRIES = 3;

/**
 * How long a merge waits, in a room with somebody else, for what the store
 * has and the document does not to arrive through the room before putting it
 * in itself (`writeOverStale`).
 */
const LIVE_SETTLE_MS = 600;

/** How long a page is out of the room before it says it is offline (`App.outSince`). */
const OFFLINE_AFTER_MS = 5000;

/**
 * Bytes of text a file can hold and still be edited together live. Above it
 * the file opens read-only and is changed from the terminal; its changes
 * reach everyone through the store, as a binary file's do.
 *
 * A live document reaches somebody arriving as its whole state in one
 * message, and the relay takes 32 MB of those (see `MAX_DOC_MESSAGE`). Every
 * file a 25 MB pad could hold is under this, as it was before pads grew past
 * that on 7 October; a 40 MB file open in two places stopped reaching the
 * second, until 11 October.
 */
export const LIVE_MAX = 24 * 1024 * 1024;

/** Whether a file's text is past `LIVE_MAX`; its length first, which is free. */
function tooBigToShare(units: number, text: () => string): boolean {
  if (units > LIVE_MAX) return true;
  if (units * 3 <= LIVE_MAX) return false;
  return new TextEncoder().encode(text()).length > LIVE_MAX;
}

/**
 * Whether `b` is still recognisably `a`, changed: most of their lines in
 * common, or — a short file — most of its text at the same start and end.
 * What tells a file moved and edited from another file of the same name.
 */
function alike(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  if ((start + end) * 2 >= longest) return true;
  const lines = new Set(a.split("\n").filter((l) => l.trim()));
  const theirs = b.split("\n").filter((l) => l.trim());
  const shared = theirs.filter((l) => lines.has(l)).length;
  return shared * 2 >= Math.min(lines.size, theirs.length) && shared > 0;
}

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
 * Once what is on the page now has been drawn. A tab nobody is looking at
 * draws nothing, so there it is soon instead.
 */
function painted(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 250);
  });
}

export interface AppHooks {
  /**
   * The pad is not this browser's to see, now or any more — private, deleted,
   * or not a pad name at all. `deadLink`: the code this browser held opened
   * nothing, because its link was reset or turned off.
   */
  onPrivate?: (why: "private" | "gone" | "invalid", deadLink?: boolean) => void;
  /**
   * The service worker that serves the runtime's packages, controlling the
   * page (runtime.ts `mirrorPackages`). The runtime waits for it, so its first
   * download goes through it; nothing else does.
   */
  mirrored?: Promise<unknown>;
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

/** Installed before Python first runs, and when it changes: `App.installRequirements`. */
const REQUIREMENTS = "requirements.txt";
/** The text of `REQUIREMENTS` that `.deps` was installed for, kept with the pad. */
const INSTALLED_FOR = ".deps/.installed-requirements.txt";
/** A line that runs Python, typed or by one of its tools. */
const RUNS_PYTHON = /(^|[\s;&|(])(python3?|flask|pytest|uvicorn|gunicorn)(\s|$)/;

/** Where the indent is kept: this browser's, like the theme. */
const INDENT_KEY = "pad.indent";

function readIndent(): 2 | 4 {
  try {
    return localStorage.getItem(INDENT_KEY) === "2" ? 2 : 4;
  } catch {
    return 4;
  }
}

/** The terminal's colours, from the page's own. */
/** A moment as a person says it: "12 minutes ago", "yesterday 14:05". */
function when(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * A name Windows can save a file or folder as: `con`, `nul`, `com1` and the
 * rest are its devices, with or without an extension, so a pad called `con`
 * downloaded as a con.zip nobody on Windows could keep.
 */
function windowsSafe(name: string): string {
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? `${name}-pad` : name;
}

/** The largest file kept in this browser while it cannot be saved (`App.journal`). */
const JOURNAL_MAX = 512 * 1024;

/** Where this browser remembers the terminal's Screen reader button. */
const SCREEN_READER_KEY = "pad.screenReader";

/** A Mac's keys or everyone else's, for what the page says a key is. */
const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const RUN_KEY = MAC ? "⌘⏎" : "Ctrl+Enter";
const FORMAT_KEY = MAC ? "⇧⌥F" : "Shift+Alt+F";
const PREVIEW_KEY = MAC ? "⇧⌘V" : "Ctrl+Shift+V";

/** How the status line starts when a command's file was not saved (`App.tellUnsaved`). */
const NOT_SAVED = "not saved:";

/** A refusal for what a save holds — a name, a cap — rather than for who sent it or the network. */
function contentRefusal(e: StoreError): boolean {
  return e.status === 400 || e.status === 413 || e.status === 507;
}

/** The owner of the editor's marks from a run (`App.markProblems`). */
const RUN_MARKS = "pad-run";

/** The largest output kept as a pad's last run, in bytes: the relay's `LAST_RUN_MAX`. */
const RUN_KEPT_BYTES = 32 * 1024;

/**
 * A run's output as it should be shown again: its colours kept, and nothing
 * else a terminal acts on — no image escape to open the image again, no
 * cursor moves to draw over the prompt. A line a progress bar redrew is what
 * it ended as. Its end, past what the relay keeps.
 */
function keptOutput(output: string): string {
  const text = output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, (seq) => (seq.endsWith("m") ? seq : ""))
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= RUN_KEPT_BYTES) return text;
  // Cut on a character, not inside one, and then on a line.
  const end = new TextDecoder().decode(bytes.slice(bytes.length - RUN_KEPT_BYTES)).replace(/^\uFFFD+/, "");
  return end.slice(end.indexOf("\n") + 1);
}

function terminalTheme(): { background: string; foreground: string } {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue("--surface").trim(),
    foreground: style.getPropertyValue("--ink-2").trim(),
  };
}

/** Of the texts a command may have read, the one its result differs from least — the latest of equals. */
function closest(candidates: readonly string[], result: string): string | undefined {
  let best: string | undefined;
  let size = Infinity;
  for (const text of candidates) {
    const edit = carryOver(text, result, text);
    const n = edit ? edit.remove + edit.insert.length : 0;
    if (n <= size) {
      size = n;
      best = text;
    }
  }
  return best;
}

export class App {
  private readonly events = new AbortController();
  /** This tab, among a browser's: whose journal is whose (`journalKey`). */
  private readonly tab = Math.random().toString(36).slice(2, 10);
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private suggestions: Suggestions | null = null;
  private search: ProjectSearch | null = null;
  private replacing = false;
  private restructuring = 0;
  private monaco: typeof Monaco | null = null;
  /** The pad's text files: a model for those the editor has needed, text for the rest (`Texts`). */
  private texts = new Texts<Monaco.editor.ITextModel>((path, text) => this.makeModel(path, text));
  private active = "";
  /**
   * Spaces to a level of indent, in every file: 4 unless set to 2, with
   * Spaces in the editor's bar. What Tab types, what Format indents by, and
   * what a starter is written with.
   */
  private indent = readIndent();
  private formatting = false;
  /** Whether Format Document, and Insert Starter Code, have anything to do: Monaco's own conditions. */
  private canFormat: Monaco.editor.IContextKey<boolean> | null = null;
  private canStart: Monaco.editor.IContextKey<boolean> | null = null;
  /** An empty file's offer of what it could start as, and for which file. */
  private starterHint: { widget: Monaco.editor.IContentWidget; key: string } | null = null;
  private runtime: Promise<Runtime> | null = null;
  /** Every terminal open here, and the one in front: Run and Stop are its. See terminals.ts. */
  private sessions: TerminalSession[] = [];
  private session: TerminalSession | null = null;
  /** Two terminals side by side: the one in front and the next. */
  private split = false;
  /** Languages installed into the sandbox so far; a shell older than the latest cannot see it. */
  private installs = 0;
  /** The terminal's code — xterm, and the shell's with its tools — fetched once the editor is on screen. */
  private xterm: Promise<{
    Terminal: typeof import("@xterm/xterm").Terminal;
    FitAddon: typeof import("@xterm/addon-fit").FitAddon;
    TerminalSession: typeof import("./terminals").TerminalSession;
  }> | null = null;
  private tree: FileTree | null = null;
  /** What the folder's servers show, made when the runtime starts. */
  private preview: PreviewBrowser | null = null;
  /** The image shown in place of the editor, if one is. */
  private imageShown: string | null = null;
  /** Markdown files shown formatted (markdown.ts), by path, for as long as the page is open. */
  private formatted = new Set<string>();
  private markdownTimer: ReturnType<typeof setTimeout> | null = null;
  /** The newest render asked for: one finishing after a newer was asked is dropped. */
  private markdownAsked = 0;
  /** The command each terminal ran last, typed or Run's: whether its output is a language's to read for problems. */
  private commandOf = new WeakMap<TerminalSession, string>();
  /** Files the last run marked problems in (`markProblems`). */
  private marked = new Set<string>();
  /** Whether the terminals give their text to screen readers (`addScreenReaderToggle`). */
  private screenReader = (() => {
    try {
      return localStorage.getItem(SCREEN_READER_KEY) === "1";
    } catch {
      return false;
    }
  })();
  /** Whether saving has been failing, until a save succeeds: what the leave warning asks about. */
  private saveTrouble = false;
  /** What the status line says of a binary file clicked in the tree, until another file opens. */
  private binaryNote = "";
  /** Files a command made that were not saved, and why, as last said (`tellUnsaved`). */
  private toldUnsaved = new Map<string, string>();
  /**
   * Where a link into another Markdown file asked to land: kept until a
   * render has the heading, as the first may come before the file's text
   * has all arrived.
   */
  private markdownAnchor: { path: string; id: string } | null = null;
  /** `requirements.txt` as it was when pip last installed it in this sandbox. */
  private requirementsInstalled: string | null = null;
  private requirementsSeen = false;
  private known: Known = new Map();
  /**
   * The pad's binary files, as the store keeps them. Never in the editor;
   * in the tree, the sandbox, a download and a move like any other file.
   */
  private binaries: Binaries = new Map();
  /** Latest durable revision applied by this tab. */
  private storeSeq = 0;
  private prefetched = false;
  /** See `AppHooks.mirrored`. */
  private readonly mirrored: Promise<unknown>;
  /** The runtime has started, not merely been asked for. */
  private runtimeReady = false;
  /** Makes the sandbox's http requests with the browser's fetch: fetch-bridge.ts. */
  private readonly fetcher = new FetchBridge(
    async () => (this.runtimeReady && this.runtime ? (await this.runtime).sandbox() : null),
    PREVIEW_ORIGIN ? [new URL(PREVIEW_ORIGIN).origin] : [],
    () => (this.preview ? (request, url) => this.preview!.fetchLocal(request, url) : null),
  );
  /** Answers the sandbox's `javac` with the fast one, once Java is here: javac/bridge.ts. */
  private readonly javac = new JavacBridge(
    async () => (this.runtimeReady && this.runtime ? (await this.runtime).sandbox() : null),
    (line) => this.session?.write(`\x1b[90mnote: ${line}\x1b[0m\r\n`),
  );
  private peers: Peers | null = null;
  private busy = false;
  /** When Run was last pressed, so a double-click is not also a Stop. */
  private runPressed = 0;
  /**
   * Until the pad is open: its files read, the editor and the terminal up.
   * Run pressed then — the button is there from the first paint, and the
   * editor takes typing before the terminal is there — was dropped without a
   * word until 18 October (review N1); now it is remembered (`runWanted`) and
   * runs once the pad is open.
   */
  private opening = true;
  private runWanted = false;
  private missed = false;
  /** And one of them was a refresh that may not be skipped (`refresh(true)`). */
  private missedForced = false;
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
  /**
   * What this browser seeded a file's document with, until it is bound. A
   * seed is the stored copy or the model, and either can hold typing done
   * while the binding waited: carried over from what was shown, it went in
   * twice — `abc` typed straight after New file was `abcabc`.
   */
  private seeds = new Map<string, string>();
  /**
   * A command has run here and what it changed is not read back yet: from
   * the moment it starts until the diff after it has read the sandbox.
   */
  private commandOut = false;
  /**
   * The files open here on each stream. A set, since 18 October: two paths
   * can hash to one stream, and the second to open took the first's place,
   * so its updates went into the wrong file (audit of 17 October, DC-09).
   * Messages name their file now; this is for those from older pages.
   */
  private byStream = new Map<number, Set<string>>();
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
  /**
   * Since when this page has been out of the room: from the start until the
   * first welcome, and from each drop until the next. Past `OFFLINE_AFTER_MS`
   * it says so where the people here are shown. A page whose WebSocket a
   * proxy blocked said nothing at all, and its typing still saved while
   * nobody else's reached it (review of 28 October).
   */
  private outSince: number | null = Date.now();
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
  /**
   * Each open document's text when this page last lost the room, kept until
   * a little after it is back: what was typed after it is what this place
   * has that the room may not, if the room grew a document of its own
   * meanwhile (`rejoin`).
   */
  private atDrop = new Map<string, { text: string; at: number }>();
  /**
   * Documents a stored change was merged into while this page was out of the
   * room it had been in. The same change reaches the room's copy through the
   * room, so back in it, the state exchange held it twice, once as this
   * page's edit (review of 28 October): these rejoin instead, the room's
   * copy taken and only what was typed here since the drop carried onto it.
   */
  private mergedAway = new Set<string>();
  /**
   * Files somebody else renamed or moved, as their nudge said: which became
   * which. Followed by name. Worked out from the text alone, a rename of a
   * file typed into meanwhile — the typing in the new copy, not in what this
   * page had stored — was a file gone and another arrived, and the editor
   * typed in lost the keyboard and every key after (review of 28 October).
   */
  private renamedTo = new Map<string, string>();
  /** In the room: from a welcome until the socket that earned it goes. */
  private inRoom = false;
  /** For each file this page kept when its access went, the stored text then. */
  private keptFrom = new Map<string, string | undefined>();
  private dropGeneration = 0;

  constructor(
    private readonly name: string,
    private readonly store: Store,
    private readonly el: {
      files: HTMLElement;
      editor: HTMLElement;
      terminal: HTMLElement;
      terms: HTMLElement;
      tabs: HTMLElement;
      newTerminal: HTMLButtonElement;
      split: HTMLButtonElement;
      run: HTMLButtonElement;
      share: HTMLButtonElement;
      preview: HTMLButtonElement;
      backToEditor: HTMLButtonElement;
      format: HTMLButtonElement;
      indent: HTMLButtonElement;
      markdown: HTMLButtonElement;
      suggest: HTMLButtonElement;
      previewPane: HTMLElement;
      imagePane: HTMLElement;
      markdownPane: HTMLElement;
      status: HTMLElement;
      presence: HTMLElement;
      title: HTMLElement;
    },
    private readonly ui?: PadWorkspace,
    private readonly hooks: AppHooks = {},
  ) {
    this.mirrored = hooks.mirrored ?? Promise.resolve();
    // A write that went past one this page never read: read the pad, all of it.
    this.store.onBehind = (pad) => {
      if (pad === this.name) void this.refresh(true);
    };
    this.ui?.onLayout(() => {
      this.editor?.layout();
      this.fitTerminals();
    });
    this.ui?.onHighlightChange(() => {
      this.relanguage();
      if (!this.el.markdownPane.hidden) this.renderMarkdownSoon(0);
    });
  }

  /** Exposed for the browser checks, which need to see what synced. */
  private expose(): void {
    (window as unknown as { __pad: unknown }).__pad = {
      active: () => this.active,
      docs: () => [...this.docs.keys()],
      streams: () => [...this.byStream].flatMap(([stream, paths]) => [...paths].map((path) => [stream, path])),
      text: (p: string) => this.docs.get(p)?.contents() ?? this.texts.get(p)?.getValue(),
      known: () => [...this.known.keys()],
      counts: () => this.peers?.counts,
      room: () => this.peers?.seen,
      shellBusy: () => this.anyBusy,
      terminals: () => this.sessions.map((t) => ({ number: t.number, busy: t.busy, front: t === this.session })),
      preview: () => this.preview?.state(),
      lastOutput: () => this.session?.lastOutput ?? "",
      role: () => this.access.role,
      local: () => [...this.local].sort(),
      // For fetch-packages.mjs, which records each by using it once.
      toolchains: () => TOOLCHAINS.map((t) => ({ name: t.name, pkg: t.pkg, command: t.commands[0] })),
    };
  }

  async start(): Promise<void> {
    // What the relay holds a pad to, asked now so a download into the
    // sandbox goes by it too; an import waits for the answer (limits.ts).
    void loadLimits();
    // This tab's journal is its own for as long as it is open: another tab
    // recovers only the journals of tabs whose lock is free.
    void navigator.locks?.request(this.tabLock(this.tab), () => new Promise<void>((resolve) => {
      this.events.signal.addEventListener("abort", () => resolve(), { once: true });
    }));
    // Answered from the start; `wire` puts the full handler on later.
    this.el.run.onclick = () => void this.run();
    try {
      await this.open();
    } finally {
      this.opening = false;
    }
    if (this.runWanted && !this.disposed) {
      this.runWanted = false;
      void this.run();
    }
  }

  private async open(): Promise<void> {
    this.el.title.textContent = this.name;
    document.title = `${this.name} — pad`;
    toastRegions();
    this.say("loading", "opening…");

    let pad: Pad;
    try {
      pad = await this.store.read(this.name, true);
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
    const files = Object.entries(pad.files).filter(([path, f]) => f.encoding === "utf8" && !isMarker(path, f.content) && !ignored(path));
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
    void this.recoverJournal();
    this.say("", this.viewer ? "" : pad.exists ? "" : "new folder — nothing saved yet");
    this.welcomeCopy();
    this.editor?.focus();
    // The editor first, taking what is typed or pasted, and the terminal
    // once it has been drawn: until 20 October the editor took no keys until
    // the terminal's code had been fetched and the terminal opened, and its
    // first frame waited for that work too. Opening a pad to paste into is
    // most of what people do with it. See "Opening a pad to paste into" in
    // docs/dev/pad.md.
    await painted();
    if (this.disposed) return;
    try {
      await this.openTerminal();
    } catch {
      // Fetched again by the next terminal asked for.
      this.xterm = null;
      this.say("error", "the terminal did not load — reload the page to try again");
    }
    if (this.disposed) return;
    void this.showLastRun();
    this.expose();
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
    if (this.outSince !== null && Date.now() - this.outSince >= OFFLINE_AFTER_MS) {
      const mark = document.createElement("span");
      mark.className = "not-live";
      mark.textContent = "Offline";
      mark.title = "Not connected to the others on this pad: your changes still save, but theirs reach this page only once it reconnects, which it keeps trying to.";
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
      onMoved: (_seq, renamed) => {
        for (const [from, to] of renamed ?? []) this.renamedTo.set(from, to);
        void this.refresh();
      },
      onPresence: (_others, id) => {
        if (id === null) {
          // As the room is lost, and not again: every retry that fails while
          // the network is gone says so too, and each took the text with what
          // had been typed since in it. A rejoin then measured from that saw
          // nothing typed, and the typing went. Found on 18 October, when
          // wider seed ids made the place that dropped out the one to rejoin
          // in `pair-check.mjs`.
          if (this.inRoom) for (const [path, doc] of this.docs) if (doc.ready) this.atDrop.set(path, { text: doc.contents(), at: Date.now() });
          this.inRoom = false;
          this.outSince ??= Date.now();
          this.offlineSoon();
        } else {
          this.inRoom = true;
          this.outSince = null;
          if (this.atDrop.size) {
            const generation = ++this.dropGeneration;
            setTimeout(() => {
              if (generation === this.dropGeneration) this.atDrop.clear();
            }, 30_000);
          }
        }
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
          if (this.mergedAway.delete(path)) {
            void this.rejoin(path, doc);
            continue;
          }
          this.peers?.doc(streamFor(path), DOC_WANT, doc.stateVector(), path);
        }
        // The peer socket carries nudges, not history. Re-read the durable
        // folder to recover every nudge that may have been missed offline.
        void this.refresh();
      },
      onDoc: (stream, kind, bytes, from, path) => this.onDoc(stream, kind, bytes, from, path),
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
    this.offlineSoon();
  }

  /** The presence shown again once a page still out of the room has been for `OFFLINE_AFTER_MS`. */
  private offlineSoon(): void {
    setTimeout(() => {
      if (!this.disposed && this.outSince !== null) this.renderPresence([]);
    }, OFFLINE_AFTER_MS + 100);
  }

  /**
   * Somebody else's text into this sandbox — but not over a command's change
   * before it is read back (`commandOut`). Written over, the file held what
   * the page last wrote and read as untouched, and the change was lost for
   * everyone: somebody typing in another place while a command here edited
   * the file, each keystroke and each save of theirs written in as it came.
   * macOS CI caught it on 15 October. Left alone, the diff after the command
   * puts its change on the document, and the document goes back in once it
   * is saved.
   */
  private async intoSandbox(rt: Runtime, path: string, text: () => string): Promise<void> {
    if (this.commandOut) {
      const wrote = rt.wrote(path);
      if (wrote !== undefined && (await rt.readBytes(path).then(textOf, () => null)) !== wrote) return;
    }
    await rt.write(path, text());
  }

  /**
   * Somebody else changed the folder. Re-read it rather than trusting the
   * broadcast, which carries only the fact that something moved.
   *
   * Deferred while a command is running: the sandbox filesystem is mid-flight
   * then, and writing someone else's version of a file underneath a running
   * script is a way to produce output that matches no version of anything.
   */
  /**
   * Read the pad again and take in what changed. `forced` when a save of
   * this page's came back past a write it never read (`Store.onBehind`): its
   * own number is no proof then of having seen everything up to it.
   */
  private async refresh(forced = false, tries = 0): Promise<void> {
    if (this.busy) {
      this.missed = true;
      this.missedForced ||= forced;
      return;
    }
    let pad: Pad;
    try {
      // How far this page has it, so a pad no further on is not sent whole
      // again: this runs on every welcome to the room and whenever anybody
      // joins or leaves it, and for a 78 MB pad each was 9 MB (18 October).
      pad = await this.store.read(this.name, false, forced ? undefined : this.storeSeq);
    } catch (e) {
      if (e instanceof StoreError && (e.refused || e.gone)) this.lose(e.gone ? "gone" : "private");
      return;
    }
    // Who may do what can change while the page is open: the owner locked
    // editing, revoked a link, or opened it up. The relay closes the room
    // when that happens, and this read follows the reconnect.
    this.adopt(pad.access);
    if (forced && pad.seq < this.storeSeq) {
      // Read before a save of this page's went in, so without it: taken in,
      // it would undo that save here. Asked again in a moment, a few times;
      // a pad that lapsed and began again at 1 never gets that far.
      if (tries < 3) setTimeout(() => void this.refresh(true, tries + 1), 1000);
      return;
    }
    if (!forced && (pad.unchanged || pad.seq <= this.storeSeq)) return;
    // Only a runtime that is already up is written to here. One still starting
    // is not waited for: this used to wait, so a browser still downloading its
    // runtime — a first visit, for a while — showed nobody else's new or
    // deleted files until it arrived. On 2 October a file deleted in one
    // browser stayed in another's tree past app-check's twenty seconds, for as
    // long as one package took to come from the CDN. ensureRuntime writes in
    // whatever changed meanwhile before anything can use the sandbox.
    const rt = this.runtimeReady ? await this.runtime : null;
    const incoming = knownFrom(pad.files);

    // Moved by somebody else: a file gone and one arrived with what it held.
    // This place follows it to its new name, where it was in it, and typing
    // here not yet saved goes along — until 18 October a rename half a
    // second after someone typed took their typing and sent them to main.py
    // (review of 17 October, M1).
    const moves = new Map<string, string>();
    for (const [from, to] of this.renamedTo) if (!incoming.has(to) || incoming.has(from)) this.renamedTo.delete(from);
    {
      const arrived = [...incoming.keys()].filter((p) => !this.known.has(p));
      const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
      for (const from of this.known.keys()) {
        if (incoming.has(from) || this.local.has(from) || ignored(from)) continue;
        const was = this.known.get(from);
        const free = arrived.filter((p) => ![...moves.values()].includes(p));
        const said = this.renamedTo.get(from);
        if (said !== undefined && free.includes(said)) {
          moves.set(from, said);
          continue;
        }
        const same = free.filter((p) => incoming.get(p) === was);
        // The same text, under the same name if one has it; or, the text
        // since changed by the mover, the one file of that name that arrived —
        // if it is still recognisably that file. A file deleted and another
        // of its name made somewhere else is not a move: until 20 October it
        // was taken for one, and its text went into the new file (review of
        // 19 October, C5).
        const named = free.filter((p) => base(p) === base(from) && was !== undefined && alike(was, incoming.get(p)!));
        const to = same.find((p) => base(p) === base(from)) ?? (same.length === 1 ? same[0] : named.length === 1 ? named[0] : undefined);
        if (to) moves.set(from, to);
      }
    }
    // Typing here not yet saved, in a file somebody moved: what this page last
    // knew stored, and what it holds now — only where the two differ. Until
    // 20 October every moved file's text was taken for typing, and carried
    // onto the file as the mover left it, it undid what they had changed in
    // it: a `mv` and a `sed` in one place reverted by a page merely open in
    // another (review of 19 October, C3).
    // And what was stored of each, read again below for the file on screen,
    // whatever was typed in it meanwhile.
    const storedBefore = new Map([...moves.keys()].map((from) => [from, this.known.get(from)] as const));
    const typedBefore = new Map<string, { shown: string; typed: string }>();
    for (const from of moves.keys()) {
      const shown = this.known.get(from);
      const typed = this.current(from);
      if (shown !== undefined && typed !== undefined && typed !== shown) typedBefore.set(from, { shown, typed });
    }
    const followFrom = moves.has(this.active) ? this.active : null;
    // Typing in it when it moved: the editor keeps the keyboard, and the
    // file it shows stays until the moved one is in its place. Its model was
    // disposed first, under the editor, which let go of the keyboard; a
    // person typing while someone renamed the file kept 9 of 38 keystrokes,
    // the rest going nowhere (review of 28 October).
    const typing = followFrom !== null && (this.editor?.hasTextFocus() ?? false);
    if (followFrom && this.editor) {
      const state = this.editor.saveViewState();
      if (state) this.viewStates.set(moves.get(followFrom)!, state);
    }

    // Files whose live document, shared in the room, lacks what the store
    // has: written by a page outside the room, which no room carries. Kept at
    // what they were, so the next save is refused as stale and merges it in
    // (`writeOverStale`); taken as known, that save went over it.
    const held = new Map<string, string>();
    this.applyingRemote = true;
    for (const [path, content] of incoming) {
      if (this.known.get(path) === content) continue;
      // A viewer's own copy keeps what they made of it.
      if (this.local.has(path)) continue;
      // What the pad never keeps, stored by an older page: not shown, not run.
      if (ignored(path)) continue;
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
      // Unless nobody shares it live here: then the document has none of
      // what the store has had since, and taking the store's version as
      // known without it, the next save went over it with the right base
      // and said "saved" — a page whose room was out of reach, re-reading
      // after any other save, wiped a teammate's function (review of 28
      // October, C6 again). Merged in now, as a save refused would be; with
      // nobody else holding the document it goes in once.
      else if (doc.ready && !this.peers?.shared) {
        const was = this.known.get(path);
        const now = doc.contents();
        const edit = was !== undefined && now !== content ? carryOver(was, content, now) : null;
        if (edit) {
          this.applyEdit(path, doc, edit);
          if (!this.inRoom && this.atDrop.has(path)) this.mergedAway.add(path);
        }
      } else if (doc.ready) {
        const was = this.known.get(path);
        if (was !== undefined && applied(doc.contents(), carryOver(was, content, doc.contents())) !== doc.contents()) held.set(path, was);
      }
      // The sandbox too, or the next run uses the version this browser had
      // before the change arrived.
      if (rt) await this.intoSandbox(rt, path, () => doc?.contents() ?? content);
    }
    for (const path of this.known.keys()) {
      if (incoming.has(path) || this.local.has(path)) continue;
      this.dirty.delete(path);
      // The file on screen, moved: let go once the editor shows where it went.
      if (path === followFrom && moves.has(path)) {
        if (rt) await rt.removeAndPrune(path);
        continue;
      }
      this.closeDoc(path);
      this.texts.delete(path);
      // And the folders that leaves empty: kept, the next command would put
      // them back for everyone.
      if (rt) await rt.removeAndPrune(path);
    }
    // Binary files after text ones: a file that became binary was removed as
    // text just above, and is written back here as what it is now.
    const incomingBinaries = binariesFrom(pad.files);
    for (const [path, base64] of incomingBinaries) {
      if (this.binaries.get(path) === base64 || this.local.has(path) || ignored(path)) continue;
      if (rt) await rt.writeBytes(path, fromBase64(base64));
    }
    for (const path of this.binaries.keys()) {
      if (incomingBinaries.has(path) || incoming.has(path) || this.local.has(path)) continue;
      if (rt) await rt.removeAndPrune(path);
    }
    this.applyingRemote = false;
    this.known = incoming;
    for (const [path, was] of held) this.known.set(path, was);
    this.binaries = incomingBinaries;
    this.storeSeq = pad.seq;
    for (const [from, to] of moves) {
      this.renamedTo.delete(from);
      if (this.formatted.delete(from)) this.formatted.add(to);
      // What was typed here before the move reached here, onto the file as it
      // now is: an edit like typing, which saves and reaches the room. For
      // the file on screen, up to now: it is still there to read.
      const shown = storedBefore.get(from);
      const typed = from === followFrom ? this.current(from) : typedBefore.get(from)?.typed;
      const carried = shown !== undefined && typed !== undefined && typed !== shown ? { shown, typed } : undefined;
      if (!carried || !this.texts.has(to) || this.docs.has(to) || !this.monaco) continue;
      // Into its model, made for it if it has none, as the edit typing is:
      // the typing, measured from what was stored, onto the file as it is.
      const model = this.texts.model(to)!;
      const edit = carryOver(carried.shown, carried.typed, model.getValue());
      if (!edit) continue;
      // What the file showed is the mover's text, without this typing: the
      // room's document for it, from the mover, has none of it either, and
      // binding carries what was typed since it was shown. Taken after the
      // carry, keys typed here that had not reached the mover when it moved
      // were in neither, and went — two of 38 on CI's slower machines.
      if (!this.shownUnbound.has(to)) this.shownUnbound.set(to, model.getValue());
      const start = model.getPositionAt(edit.at);
      const end = model.getPositionAt(edit.at + edit.remove);
      model.applyEdits([{ range: new this.monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: edit.insert }]);
    }
    const followed = followFrom !== null && this.texts.has(moves.get(followFrom)!);
    if (followed) {
      this.show(moves.get(followFrom!)!);
      if (typing) this.editor?.focus();
    }
    // The moved file on screen, kept until now: let go.
    if (followFrom && !incoming.has(followFrom)) {
      this.closeDoc(followFrom);
      this.texts.delete(followFrom);
    }
    if (!followed && !this.texts.has(this.active)) {
      const first = [...this.texts.keys()].sort()[0];
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
      if (this.peers && !this.peers.doc(stream, kind === "update" ? DOC_UPDATE : DOC_AWARENESS, bytes, path)) {
        this.say("error", `that change to ${path} is too large to share live; it is saved, and others get it as saved`);
      }
      // Local changes only — the document returns early on anything applied
      // from somebody else — which makes this the right place to decide that
      // something needs saving.
      if (kind === "update") {
        this.search?.invalidate();
        this.dirty.add(path);
        this.saveSoon();
      }
    });
    this.docs.set(path, doc);
    const sharing = this.byStream.get(stream) ?? new Set<string>();
    sharing.add(path);
    this.byStream.set(stream, sharing);

    // The stored copy, or the model's when there is none — a folder nobody
    // has written to yet holds its starter only on screen. Safe as a seed
    // because seeding happens only when this browser is alone or nobody
    // answered, and in both cases no other document exists to disagree.
    // Wait for the relay to say who is here. Asked a moment earlier, the room
    // always looks empty and this browser seeds a document somebody else
    // already owns.
    await this.peers?.ready;

    // A model with unsaved text in it is newer than the store: a file moved
    // with typing it carried, waiting for its save.
    const unsaved = this.dirty.has(path) ? this.texts.get(path)?.getValue() : undefined;
    const stored = unsaved ?? this.known.get(path) ?? this.texts.get(path)?.getValue() ?? "";
    if (!this.peers || this.peers.alone) {
      doc.seed(stored);
      this.seeds.set(path, stored);
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
    this.peers.doc(stream, DOC_WANT, doc.stateVector(), path);
    const answered = await new Promise<boolean>((resolve) => {
      this.awaiting.set(path, resolve);
      setTimeout(() => resolve(false), DOC_ANSWER_WAIT);
    });
    this.awaiting.delete(path);
    this.unanswered.delete(path);
    // Nobody answered, so nobody else has it open and the stored copy is safe.
    if (!answered) {
      doc.seed(stored);
      this.seeds.set(path, stored);
    }
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
    this.seeds.delete(path);
    const sharing = this.byStream.get(streamFor(path));
    sharing?.delete(path);
    if (sharing?.size === 0) this.byStream.delete(streamFor(path));
    this.awaiting.delete(path);
    this.unanswered.delete(path);
    clearTimeout(this.stuck.get(path));
    this.stuck.delete(path);
    doc.destroy();
  }

  private onDoc(stream: number, kind: number, bytes: Uint8Array, from: number, named: string | null): void {
    // The file the message names, whose stream `Peers` has checked it came
    // on. From a page that names none, the one open here on its stream —
    // and when two are, nothing can say which, and it is dropped.
    const open = this.byStream.get(stream);
    if (named === null && open && open.size > 1) return;
    const path = named ?? (open ? [...open][0] : undefined);
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
      if (kind === DOC_WANT) this.peers?.doc(stream, DOC_NONE, new Uint8Array(), path);
      return;
    }

    if (kind === DOC_NONE) {
      const waiting = this.unanswered.get(path);
      waiting?.delete(from);
      if (waiting?.size === 0) this.awaiting.get(path)?.(false);
      return;
    }

    if (kind === DOC_UPDATE) {
      // A document of this file that grew apart from this one. Both places
      // see it, and the same rule picks the one kept: the other gives its
      // own up and rejoins with what it had that was not saved.
      const foreign = doc.foreignRoot(bytes);
      if (foreign !== null) {
        const own = doc.rootClient;
        if (own === null || own < foreign) void this.rejoin(path, doc);
        return;
      }
      doc.applyUpdate(bytes);
      this.search?.invalidate();
      if (this.viewer) this.unstick(path, doc);
      // Whoever was waiting for state has it now — if this was state. Any
      // update used to count, so a newcomer bound the empty document it had
      // after other people's traffic, and its open file went blank until the
      // real answer came.
      if (doc.hasState) this.awaiting.get(path)?.(true);
      // The document is also the source executed by the sandbox. Keeping only
      // Monaco current lets the next harmless command publish stale runtime
      // bytes over somebody else's edit.
      void this.runtime?.then((rt) => this.intoSandbox(rt, path, () => doc.contents()));
    }
    else if (kind === DOC_AWARENESS) doc.applyAwareness(bytes);
    else if (kind === DOC_WANT) {
      // Somebody wants what they are missing. Only what they lack is sent —
      // unless that is more than one message carries, for a file that grew
      // past sharing while it was open. Then they take the stored copy.
      if (!this.peers?.doc(stream, DOC_UPDATE, doc.diffSince(bytes), path)) {
        this.peers?.doc(stream, DOC_NONE, new Uint8Array(), path);
        this.say("error", `${path} has grown too large to share live; others get it as saved`);
      }
    }
  }

  // ---------------------------------------------------------------- editor

  private async openEditor(): Promise<void> {
    // Asked for by main.ts as the page began, so usually here already.
    const [monaco, { errorHandler }] = await loadEditor();
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
    // Each model listens to the language service, and Monaco reports more
    // than 200 listeners on that as a leak — thrown, on a timer. A model was
    // made for every file until 18 October, so any pad of over 200 text files
    // threw it; now one is made for a file only once the editor needs it
    // (`Texts`), and only somebody who opens more than 200 files in one visit
    // gets there. It is not a leak then either: the models are the files they
    // opened. Only that report goes; Monaco still warns in the console.
    const report = errorHandler.unexpectedErrorHandler;
    errorHandler.unexpectedErrorHandler = (e) => {
      if ((e as Error | undefined)?.name !== "ListenerLeakError") report(e);
    };
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
    // Monaco's button for a phone's or a tablet's keyboard is a textarea
    // with no name, which axe called critical on a phone (review of 28
    // October). Monaco adds it a moment after the editor, and only where it
    // takes the device for iOS, which is where this watches for it.
    if (navigator.maxTouchPoints > 0 && /iPhone|iPad|Macintosh/.test(navigator.userAgent)) {
      const label = () => {
        const button = this.el.editor.querySelector("textarea.iPadShowKeyboard");
        button?.setAttribute("aria-label", "Show the keyboard, to type in the editor");
        return button !== null;
      };
      if (!label()) {
        const watch = new MutationObserver(() => {
          if (label()) watch.disconnect();
        });
        watch.observe(this.el.editor, { childList: true, subtree: true });
        this.events.signal.addEventListener("abort", () => watch.disconnect(), { once: true });
      }
    }
    onThemeChange(() => {
      monaco.editor.setTheme(editorTheme());
      this.editor?.updateOptions({ fontSize: this.codeFontPx() });
      // A code block's colours are numbered by the theme they were made in.
      if (!this.el.markdownPane.hidden) this.renderMarkdownSoon(0);
    }, this.events.signal);
    this.editor.onDidChangeModelContent(() => {
      this.warm();
      this.paintStarter();
      if (!this.el.markdownPane.hidden) this.renderMarkdownSoon();
    });
    // Monaco's Format Document, with its key and its place in the menu, for
    // the formatters here (format.ts) — its own are in the workers that
    // cannot start. And an empty file's starter, for the keyboard.
    this.canFormat = this.editor.createContextKey("padCanFormat", false);
    this.canStart = this.editor.createContextKey("padCanStart", false);
    this.editor.addAction({
      id: "pad.format",
      label: "Format Document",
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
      precondition: "padCanFormat",
      contextMenuGroupId: "1_modification",
      contextMenuOrder: 1.3,
      run: () => this.formatActive(),
    });
    // Ctrl/⌘-Enter runs, as the button says. Monaco's own binding for it —
    // a blank line below — won in the editor, so on Linux and Windows the key
    // typed a line instead (review of 17 October, M3).
    this.editor.addAction({
      id: "pad.run",
      label: "Run This File",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: () => void this.run(),
    });
    // Grey text as you type, from a model in this tab — see complete.ts.
    this.suggestions = new Suggestions(monaco, this.editor, this.el.suggest);
    this.editor.addAction({
      id: "pad.starter",
      label: "Insert Starter Code",
      precondition: "padCanStart",
      contextMenuGroupId: "1_modification",
      contextMenuOrder: 1.4,
      run: () => this.insertStarter(),
    });
  }

  /**
   * A file's text, new or changed. Into its model when it has one, and kept
   * as text when it has none (`Texts`) — told as an edit to a model would
   * be, so a file nobody has opened saves and marks itself as one that has.
   */
  private setFile(path: string, content: string): void {
    if (!this.monaco) return;
    const existing = this.texts.existing(path);
    if (existing) {
      // Only what differs, so where somebody was in the file survives it.
      replaceText(this.monaco, existing, content);
      return;
    }
    const fresh = !this.texts.has(path);
    if (this.texts.put(path, content) && !fresh) this.changed(path);
    if (fresh && !this.active) this.show(path);
  }

  /** A file's model, made the first time something needs one: `Texts`. */
  private makeModel(path: string, content: string): Monaco.editor.ITextModel {
    const model = this.monaco!.editor.createModel(content, this.languageOf(path));
    // The indent set here, not one guessed from the file.
    model.updateOptions(this.indentOptions(path));
    // Per model, not on the editor. `onDidChangeModelContent` fires only for
    // whichever model is attached right now, so a change to any other file —
    // including one arriving from the shell — would never be noticed.
    model.onDidChangeContent(() => this.changed(path));
    return model;
  }

  /** A file's text changed, in its model or as text. */
  private changed(path: string): void {
    this.warm();
    this.search?.invalidate();
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
    // A model made after this takes the choice as it is then.
    for (const [path, model] of this.texts.models()) this.monaco.editor.setModelLanguage(model, this.languageOf(path));
  }

  private show(path: string): void {
    const model = this.texts.model(path);
    if (!model || !this.editor || !this.monaco) return;
    if (this.imageShown !== null) this.closeImage();
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
    const solo = this.solo(path);
    // Only when it changes: setting an option, even to what it was, has the
    // editor work its options out again.
    if (this.editor.getOption(this.monaco.editor.EditorOption.readOnly) !== solo) this.editor.updateOptions({ readOnly: solo });
    if (solo) {
      const mb = Math.round(model.getValueLength() / (1024 * 1024));
      this.say("", `${path} is about ${mb} MB, too large to edit together live — read-only here; change it from the terminal`);
    }
    this.paintTools();
    this.paintMarkdown();
    this.paintStarter();
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
    const running = this.session?.busy ?? false;
    const runnable = interpreterFor(this.active) !== null || runnerFor(this.active) !== null;
    this.el.run.querySelector("span")!.textContent = running ? "Stop" : "Run";
    this.el.run.querySelector("path")?.setAttribute("d", running ? "M4.5 4.5h7v7h-7z" : "M5 3.5l7 4.5-7 4.5V3.5Z");
    this.el.run.disabled = !running && (this.busy || !runnable);
    this.el.run.title = running
      ? "Stop what is running (ctrl-c)"
      : runnable
        ? `Run this file (${RUN_KEY})`
        : `nothing here runs a ${this.active.split(".").pop()} file`;
  }

  /**
   * Make a file.
   *
   * Written straight into the sandbox as well as the editor, so the shell can
   * see it immediately — someone who makes `notes.py` and types `python
   * notes.py` should not have to press Run first to bring it into existence.
   */
  private addFile(name: string, open = true): void {
    if (this.replacing) return;
    if (this.texts.has(name)) return open ? this.show(name) : undefined;
    if (this.viewer) this.local.add(name);
    this.setFile(name, "");
    if (open) this.show(name);
    else this.renderFiles();
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
    if (open) this.editor?.focus();
  }

  /**
   * Make a directory, for everyone.
   *
   * Folders are derived from the paths under them, so an empty one is stored
   * as its marker — an empty `.keep` inside it — and drawn as the folder. It
   * used to exist only in the tab that made it until something landed inside.
   * A viewer's stays in their tab, as their files do.
   */
  private addFolder(name: string): void {
    if (this.replacing) return;
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


  private async attach(path: string, model: Monaco.editor.ITextModel): Promise<void> {
    // A viewer's own copy has no live document: that is what makes it theirs.
    if (this.local.has(path)) return;
    // Nor has a file too large to share live.
    if (this.solo(path)) return;
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
    // A document this browser seeded, and nobody has changed since, is this
    // browser's own text: what it lacks of the typing is all there is to
    // carry. One from somebody else carries what was typed since it was shown.
    // Compared as the editor held it — Monaco sets a file's byte-order mark
    // aside when it makes the model, so the typing never had one, and against
    // the document's that read as the mark deleted.
    const seed = this.seeds.get(path);
    this.seeds.delete(path);
    const now = model.getValue();
    const edit = carryOver(seed !== undefined && seed === now ? now.replace(/^\uFEFF/, "") : shown, typed, now);
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

  // ------------------------------------------------------- format, starters

  /** How a file is indented: by the indent set here, or with tabs where its kind says so. */
  private indentOptions(path: string): Monaco.editor.ITextModelUpdateOptions {
    return { tabSize: this.indent, indentSize: this.indent, insertSpaces: !usesTabs(path) };
  }

  private unitFor(path: string): string {
    return usesTabs(path) ? "\t" : " ".repeat(this.indent);
  }

  /** Format, and the indent, for the file in the editor. */
  private paintTools(): void {
    const formatter = this.active && !this.solo(this.active) ? formatterFor(this.active) : null;
    this.el.format.hidden = formatter === null;
    this.el.format.disabled = this.formatting;
    this.el.format.textContent = this.formatting ? "Formatting…" : "Format";
    if (formatter) this.el.format.title = `Format this file with ${formatter.name} (${FORMAT_KEY})`;
    this.canFormat?.set(formatter !== null && !this.formatting);
    const markdown = this.active !== "" && isMarkdown(this.active);
    const formatted = markdown && this.formatted.has(this.active);
    this.el.markdown.hidden = !markdown;
    this.el.markdown.classList.toggle("on", formatted);
    this.el.markdown.setAttribute("aria-pressed", String(formatted));
    this.el.markdown.title = formatted ? `Hide the formatted view (${PREVIEW_KEY})` : `See this file formatted, as it will look (${PREVIEW_KEY})`;
    const other = this.indent === 4 ? 2 : 4;
    const tabs = usesTabs(this.active);
    this.el.indent.textContent = tabs ? `Tab size: ${this.indent}` : `Spaces: ${this.indent}`;
    this.el.indent.title = tabs
      ? `This file is indented with tabs, shown ${this.indent} wide — show them ${other} wide`
      : `Indenting with ${this.indent} spaces, in every file — switch to ${other}`;
  }

  /** 4 spaces or 2: for every file open here, and for this browser from now on. */
  private setIndent(size: 2 | 4): void {
    this.indent = size;
    try {
      localStorage.setItem(INDENT_KEY, String(size));
    } catch {
      // For this visit, then.
    }
    for (const [path, model] of this.texts.models()) model.updateOptions(this.indentOptions(path));
    this.paintTools();
    // What is written already keeps its indent until it is formatted.
    this.say("", `indenting with ${size} spaces — Format re-indents a file`);
  }

  /**
   * The file in the editor, formatted. One edit, of only what changed, so one
   * undo takes it back and it reaches everyone on the pad as typing does.
   */
  private async formatActive(): Promise<void> {
    if (this.replacing) return;
    const editor = this.editor;
    const monaco = this.monaco;
    const path = this.active;
    const model = this.texts.model(path);
    if (!editor || !monaco || !model || this.formatting || this.solo(path) || !formatterFor(path)) return;
    this.formatting = true;
    this.paintTools();
    try {
      const before = model.getValue();
      // The first time, this fetches the formatter.
      const after = await formatText(path, before, this.indent);
      // Typed in meanwhile: formatting what was there would throw that away.
      if (model.isDisposed() || model.getValue() !== before) return this.say("", `${path} changed while it was being formatted — format it again`);
      const edit = carryOver(before, after, before);
      if (!edit) return this.say("", `${path} is formatted already`);
      const range = monaco.Range.fromPositions(model.getPositionAt(edit.at), model.getPositionAt(edit.at + edit.remove));
      if (editor.getModel() === model) {
        editor.pushUndoStop();
        editor.executeEdits("pad.format", [{ range, text: edit.insert }]);
        editor.pushUndoStop();
      } else {
        model.pushEditOperations([], [{ range, text: edit.insert }], () => null);
      }
      this.say("", `formatted ${path}`);
    } catch (e) {
      this.say("error", `${path} was not formatted: ${problemOf(e, model.getValue())}`);
    } finally {
      this.formatting = false;
      this.paintTools();
    }
  }

  /** An empty file's offer of what it could start as, on its first line where the code would go. */
  private paintStarter(): void {
    const editor = this.editor;
    const monaco = this.monaco;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    const starter = model && model.getValueLength() === 0 && !this.solo(this.active) ? starterFor(this.active, this.unitFor(this.active)) : null;
    this.canStart?.set(starter !== null);
    const key = starter ? `${this.active}\n${starter.label}` : "";
    if (this.starterHint?.key === key) return;
    if (this.starterHint) editor.removeContentWidget(this.starterHint.widget);
    this.starterHint = null;
    if (!starter) return;
    const node = document.createElement("div");
    node.className = "starter-hint";
    const take = document.createElement("button");
    take.type = "button";
    take.textContent = `Insert ${starter.label}`;
    take.title = "A few lines that run and print — undo takes them out again";
    take.onclick = () => this.insertStarter();
    const or = document.createElement("span");
    or.textContent = "or start typing";
    node.append(take, or);
    const widget: Monaco.editor.IContentWidget = {
      getId: () => "pad.starter-hint",
      getDomNode: () => node,
      getPosition: () => ({ position: { lineNumber: 1, column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] }),
    };
    editor.addContentWidget(widget);
    this.starterHint = { widget, key };
  }

  /** The starter, put in as typing would be: one undo takes it out, and everyone on the pad sees it. */
  private insertStarter(): void {
    const editor = this.editor;
    const model = editor?.getModel();
    if (!editor || !model || model.getValueLength() !== 0) return;
    const starter = starterFor(this.active, this.unitFor(this.active));
    if (!starter) return;
    editor.pushUndoStop();
    editor.executeEdits("pad.starter", [{ range: model.getFullModelRange(), text: starter.text }]);
    editor.pushUndoStop();
    const line = Math.min(starter.line, model.getLineCount());
    editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
    editor.revealLineInCenterIfOutsideViewport(line);
    editor.focus();
  }

  private renderFiles(): void {
    this.search?.invalidate();
    this.tree ??= new FileTree(this.el.files, {
      onOpen: (path) => {
        if (this.binaries.has(path) && !this.texts.has(path) && imageType(path)) return void this.showImage(path);
        if (this.binaries.has(path) && !this.texts.has(path)) {
          const base64 = this.binaries.get(path)!;
          const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
          this.binaryNote = `${path} is not text (${size(bytes)}) — download it with the arrow beside it`;
          return this.say("", this.binaryNote);
        }
        // What was said of a file that could not open is not about this one.
        if (this.binaryNote && this.el.status.textContent === this.binaryNote) this.say("", "");
        this.binaryNote = "";
        this.show(path);
        if (this.ui?.fileSelected()) this.editor?.focus();
      },
      onCreateFile: (path, open) => this.addFile(path, open),
      onCreateFolder: (path) => this.addFolder(path),
      onDelete: (path) => void this.deleteFile(path),
      onDeleteFolder: (path) => void this.deleteFolder(path),
      onDownload: (path, folder) => void this.download(path, folder),
      onDownloadAll: () => void this.downloadAll(),
      onHistory: () => void this.openHistory(),
      onImport: (zip) => void this.importZip(zip),
      importable: () => !this.viewer,
      onMove: (from, folder, to) => void this.move(from, folder, to),
      movable: () => !this.viewer,
    });
    const binary = new Set([...this.binaries.keys()].filter((p) => !this.texts.has(p) && !ignored(p)));
    this.tree.render([...this.texts.keys(), ...binary], this.active, this.local, binary, this.keptFolders());
    this.ui?.setFileCount(this.texts.size + binary.size);
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
    if (this.replacing) return;
    if (this.binaries.has(path) && !this.texts.has(path)) return this.deleteBinary(path);
    if (this.texts.size <= 1) {
      this.say("error", "a folder keeps at least one file");
      return;
    }
    if (this.busy || this.anyBusy) {
      this.say("error", "wait for what is running to finish");
      return;
    }
    const where = this.viewer ? "Only in this tab — the pad keeps it." : "It goes for everyone with the link.";
    if (!confirm(`Delete ${path}? ${where}`)) return;
    this.restructuring++;
    try {
      const rt = await this.ensureRuntime();
      // Onto another file before this one's model is disposed under the editor.
      if (this.active === path) this.show([...this.texts.keys()].filter((p) => p !== path).sort()[0]!);
      this.dirty.delete(path);
      this.closeDoc(path);
      this.texts.delete(path);
      await rt.removeAndPrune(path);
      this.renderFiles();
      await this.publish(rt);
      this.say("", `deleted ${path}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    } finally { this.restructuring--; }
  }


  /**
   * A folder and everything in it, for everyone: one store write, like a
   * move. The pad keeps at least one file the editor can show, as deleting a
   * file does. Without this, an empty folder the pad keeps could only be
   * removed from the terminal.
   */
  private async deleteFolder(path: string): Promise<void> {
    if (this.replacing) return;
    if (this.viewer) return this.say("error", "only people who can edit can delete folders");
    if (this.busy || this.anyBusy) return this.say("error", "wait for what is running to finish");
    const under = (p: string) => p.startsWith(`${path}/`);
    const text = [...this.texts.keys()].filter(under);
    const binary = [...this.binaries.keys()].filter((p) => under(p) && !this.texts.has(p));
    const markers = [...this.known].filter(([p, c]) => under(p) && isMarker(p, c)).map(([p]) => p);
    if (text.length > 0 && text.length === this.texts.size) return this.say("error", "a pad keeps at least one file the editor can open");
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
    this.restructuring++;
    try {
      await this.queueWrite(async () => {
        const seq = await this.store.write(this.name, [...text, ...binary, ...markers].map((p) => ({ path: p, content: null })));
        this.storeSeq = Math.max(this.storeSeq, seq);
        if (under(this.active)) {
          const other = [...this.texts.keys()].filter((p) => !under(p)).sort()[0];
          if (other) this.show(other);
        }
        for (const p of text) {
          this.dirty.delete(p);
          this.known.delete(p);
          this.closeDoc(p);
          this.texts.delete(p);
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
    } finally { this.restructuring--; }
  }

  /** A binary file, the same way: gone from the sandbox, and the diff after publishes it. */
  private async deleteBinary(path: string): Promise<void> {
    if (this.replacing) return;
    if (this.viewer) return this.say("error", "only people who can edit can delete the pad's files that are not text");
    if (this.busy || this.anyBusy) return this.say("error", "wait for what is running to finish");
    if (!confirm(`Delete ${path}? It goes for everyone with the link.`)) return;
    this.restructuring++;
    try {
      const rt = await this.ensureRuntime();
      await rt.remove(path);
      await this.publish(rt);
      this.say("", `deleted ${path}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    } finally { this.restructuring--; }
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
    const biggest = Math.max(0, ...[...this.dirty].map((p) => this.texts.get(p)?.getValueLength() ?? 0));
    this.saveTimer = setTimeout(() => void this.saveEdits(), biggest > 1_000_000 ? 2000 : 500);
  }

  /** Whatever is waiting to be saved, now: the tab is going out of sight, or away. */
  private flushSaves(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    void this.saveEdits(true);
  }

  /**
   * Whole files and deletions, each with the version it was made from, for a
   * relay that holds them to it: a text file this page knows with its hash,
   * a new one with an empty one — "not there" — and a deletion with the hash
   * of what it deletes. Command output, a rename and New file went with none
   * until 28 October, over a teammate's newer save they had not read (review
   * of 28 October). Binary files go as they did.
   */
  private async withBases(changes: Change[]): Promise<Change[]> {
    if (!this.store.basesWork) return changes;
    return Promise.all(changes.map(async (c) => {
      if (c.base !== undefined || c.edits || c.encoding === "base64") return c;
      const was = this.known.get(c.path);
      if (was !== undefined) return { ...c, base: await storedHash(was) };
      if (c.content === null || this.binaries.has(c.path)) return c;
      return { ...c, base: "" };
    }));
  }

  /**
   * Changes as edits where that is worth it: a text file of some size whose
   * stored version this page knows. The rest go whole, as does everything to
   * a relay that does not take edits.
   */
  private async asEdits(changes: { path: string; content: string }[]): Promise<Change[]> {
    if (!this.store.editsWork) return changes;
    let any = false;
    const out: Change[] = [];
    for (const c of changes) {
      const was = this.known.get(c.path);
      const edit = was !== undefined && was.length >= EDITS_FROM ? carryOver(was, c.content, was) : null;
      if (was === undefined) {
        // A file this page made: refused if somebody else has made one of
        // that name meanwhile, which New file wrote nothing over (review of
        // 28 October).
        if (this.store.basesWork) {
          out.push({ ...c, base: "" });
          any = true;
        } else out.push(c);
        continue;
      }
      if (!edit) {
        // Whole, with the hash of the version it was typed over: the relay
        // refuses it if that has moved on, and it is merged as an edit's is
        // (writeOverStale). Without, a page whose room was out of reach saved
        // its copy over somebody's newer one and said "saved" (review of
        // 19 October, C6).
        out.push({ ...c, base: await storedHash(was) });
        any = true;
        continue;
      }
      out.push({ path: c.path, content: null, base: await storedHash(was), edits: [edit] });
      any = true;
    }
    return any ? out : changes;
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
          // But not a document still waiting for the room: it is empty, and
          // a save in that moment stored the file as nothing.
          content: this.current(path),
        }))
        .filter((c): c is { path: string; content: string } => c.content !== undefined)
        .filter((c) => this.known.get(c.path) !== c.content);
      // A file taken back to what is stored — an undo after Replace, before
      // its save — has nothing to save, and nothing to keep: kept, it came
      // back at the next visit over the undo (review of 28 October).
      this.unjournal(paths.filter((p) => this.known.get(p) !== undefined && this.known.get(p) === this.current(p)));
      if (changes.length === 0) return;
      try {
        // A large file goes as what changed in it, measured from the text the
        // relay has: a keystroke in a 10 MB file sent 10 MB. If the relay
        // holds something else by now, it says so, and the files go whole.
        const sent = await this.asEdits(changes);
        let seq: number;
        try {
          seq = await this.store.write(this.name, sent, leaving);
        } catch (e) {
          if (!(e instanceof StoreError && e.stale) || sent === changes) throw e;
          seq = await this.writeOverStale(changes, leaving);
        }
        this.storeSeq = Math.max(this.storeSeq, seq);
        for (const c of changes) this.known.set(c.path, c.content);
        this.saveTrouble = false;
        this.unjournal(changes.map((c) => c.path));
        // Do not copy an older completed save over text edited while its
        // request was in flight. The later edit remains queued for saving.
        // Into the sandbox once it is up, without holding the saves behind
        // for it: on a first visit each waited here for the runtime's
        // download, and "saved" with it — 11 s on production (review of 28
        // October). What the sandbox reads is settled before a command runs.
        void this.runtime?.then(async (rt) => {
          for (const c of changes) if (this.current(c.path) === c.content) await rt.write(c.path, c.content);
        }).catch(() => {});
        this.peers?.moved(seq);
        this.say("", "saved");
      } catch (e) {
        const why = e as StoreError;
        // Kept here while it cannot be saved, against a closed tab (DC-05).
        this.saveTrouble = true;
        this.journal(paths);
        if (why.tooBig) {
          // Still unsaved, so said and kept as such: the next edit tries
          // again. Dropped from the unsaved files, freeing room or saving
          // another file never retried it, and leaving warned of nothing
          // (audit DC-04).
          for (const p of paths) this.dirty.add(p);
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

  /**
   * A save the store refused as made against an older version (409): the
   * store's version read, this page's change merged onto it, and that saved
   * — never this page's text over it. It was sent whole, unconditionally,
   * and the newer version that caused the refusal was gone with "saved" said
   * (audit DC-03). The merged text goes into the editor as well, and into
   * `changes`, which is what the caller records as known.
   */
  private async writeOverStale(changes: Change[], leaving: boolean): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      const stored = (await this.store.read(this.name)).files;
      const sent: Change[] = [];
      let reread = false;
      for (const c of changes) {
        const theirs = stored[c.path];
        const text = theirs?.encoding === "utf8" ? theirs.content : undefined;
        // Binary, here or there: whole, as before.
        if (c.encoding === "base64" || (theirs && text === undefined)) {
          sent.push(c);
          continue;
        }
        if (c.content === null) {
          // A deletion: made of a file nobody has changed since, held to that
          // version; of one somebody has, not made — theirs stays, read in.
          if (text === undefined) continue;
          if (text !== this.known.get(c.path)) {
            reread = true;
            continue;
          }
          sent.push({ ...c, base: await storedHash(text) });
          continue;
        }
        if (text === undefined) {
          // Not there (any more): made, unless somebody makes it first.
          sent.push(this.store.basesWork ? { ...c, base: "" } : c);
          continue;
        }
        if (text !== (this.known.get(c.path) ?? "")) c.content = await this.mergeInto(c.path, text, c.content, leaving);
        // Over the version just read, and no other: a save landing between
        // that read and this write was written over until 28 October (review
        // of 19 October, item 5). Refused, it is read and merged again.
        sent.push({ ...c, base: await storedHash(text) });
      }
      if (reread) queueMicrotask(() => void this.refresh(true));
      if (!sent.length) return this.storeSeq;
      try {
        return await this.store.write(this.name, sent, leaving);
      } catch (e) {
        if (!(e instanceof StoreError && e.stale) || attempt >= STALE_TRIES) throw e;
      }
    }
  }

  /**
   * The store's version of a text file, `theirs`, merged into what this page
   * has of it — `mine`, as sent, and the editor's as it is now — from what
   * the page last knew stored (nothing, for a file it made). The editor takes
   * the merge as an edit, the store's version becomes known, and the merge is
   * returned, to be sent over it.
   *
   * In a room with somebody else, what the store has and this document lacks
   * may only be on its way here: a teammate's typing, saved by their page a
   * moment before it reached this one. Put in now, it arrives twice. A moment
   * for it, then the document as it is then.
   */
  private async mergeInto(path: string, theirs: string, mine = this.current(path) ?? "", leaving = false): Promise<string> {
    const base = this.known.get(path) ?? "";
    let merged = applied(theirs, carryOver(base, mine, theirs));
    if (merged !== this.current(path) && this.docs.get(path)?.ready && this.peers?.shared && !leaving) {
      await new Promise((resolve) => setTimeout(resolve, LIVE_SETTLE_MS));
      mine = this.current(path) ?? mine;
      merged = applied(theirs, carryOver(base, mine, theirs));
    }
    // Into what the editor holds now, typing since included.
    const now = this.current(path);
    if (now !== undefined && now !== merged) {
      const edit = carryOver(mine, merged, now);
      const doc = this.docs.get(path);
      if (edit && doc?.ready) {
        this.applyEdit(path, doc, edit);
        if (!this.inRoom && this.atDrop.has(path)) this.mergedAway.add(path);
      } else if (edit) this.setFile(path, applied(now, edit));
    }
    this.known.set(path, theirs);
    return merged;
  }

  /**
   * Where this tab keeps typing saving could not deliver (`journal`): a key
   * of its own. It was one key for every tab of a browser until 28 October,
   * so the second of two tabs offline wrote over the first's typing, and a
   * save that went in either cleared the other's (review of 19 October,
   * item 7).
   */
  private get journalKey(): string {
    return `${this.journalPrefix}.${this.tab}`;
  }

  private get journalPrefix(): string {
    return `pad.unsaved.${this.name}`;
  }

  /** The lock a tab holds while it is open, so another knows its journal is not to be taken. */
  private tabLock(tab: string): string {
    return `pad.tab.${this.name}.${tab}`;
  }

  private readJournal(key = this.journalKey): Record<string, { base: string | null; text: string }> {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, { base: string | null; text: string }>;
    } catch {
      return {};
    }
  }

  /**
   * Unsaved typing kept in this browser while saving fails — the text, and
   * the stored text it was typed over — so a closed tab or a crash does not
   * take the only copy (audit DC-05). Cleared as each file saves; brought
   * back at the next visit (`recoverJournal`).
   */
  private journal(paths: Iterable<string>): void {
    const kept = this.readJournal();
    for (const path of paths) {
      const text = this.current(path);
      if (text === undefined || text.length > JOURNAL_MAX) continue;
      kept[path] = { base: kept[path]?.base ?? this.known.get(path) ?? null, text };
    }
    try {
      localStorage.setItem(this.journalKey, JSON.stringify(kept));
    } catch {
      // Full or blocked: the leave warning still stands.
    }
  }

  private unjournal(paths: Iterable<string>): void {
    const kept = this.readJournal();
    let changed = false;
    for (const path of paths) changed = delete kept[path] || changed;
    if (!changed) return;
    try {
      if (Object.keys(kept).length) localStorage.setItem(this.journalKey, JSON.stringify(kept));
      else localStorage.removeItem(this.journalKey);
    } catch {
      // Nothing to do: it is cleared at the next visit's recovery.
    }
  }

  /**
   * What a last visit could not save, merged into the pad as it stands now —
   * each file's typing onto whatever was saved since — saved, and said.
   */
  private async recoverJournal(): Promise<void> {
    if (this.viewer) return;
    // Every tab's that is closed now — whose lock is free — and the one key
    // of every tab from before 28 October. A tab still open saves its own.
    const prefix = this.journalPrefix;
    const keys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key !== this.journalKey && (key === prefix || key.startsWith(`${prefix}.`))) keys.push(key);
      }
    } catch {
      return;
    }
    const back = new Set<string>();
    for (const key of keys) {
      const tab = key.slice(prefix.length + 1);
      if (tab && navigator.locks) {
        const closed = await navigator.locks.request(this.tabLock(tab), { ifAvailable: true }, (lock) => lock !== null);
        if (!closed) continue;
      }
      const kept = this.readJournal(key);
      for (const [path, { base, text }] of Object.entries(kept)) {
        const now = this.known.get(path);
        if (now === undefined && base !== null) continue;
        // Onto what is here now: another closed tab's typing in the same
        // file, brought back a moment ago, included.
        const here = this.current(path) ?? now;
        const merged = here === undefined || base === null || base === here ? text : applied(here, carryOver(base, text, here));
        if (merged === here) continue;
        this.setFile(path, merged);
        this.dirty.add(path);
        back.add(path);
      }
      try {
        localStorage.removeItem(key);
      } catch {
        // Taken in already; it is merged as unchanged if it comes again.
      }
    }
    if (!back.size) return;
    this.say("", `brought back what your last visit could not save: ${[...back].join(", ")}`);
    this.renderFiles();
    this.saveSoon();
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
    await rt.settled();
    for (const path of [...this.dirty]) {
      const text = this.current(path);
      if (text === undefined) continue;
      // Not over a command's change. This runs after the command, and a file
      // it changed that also held typing not yet saved had the typing written
      // over it — the command's change gone before anything read it. Such a
      // file no longer holds what the page last wrote; the diff takes the
      // command's change from it and puts it on top of the typing.
      const wrote = rt.wrote(path);
      if (wrote !== undefined && (await rt.readBytes(path).then(textOf, () => wrote)) !== wrote) continue;
      await rt.write(path, text);
    }
  }

  /**
   * A file's text as it stands: its live document's when it has one with
   * state, its model's otherwise — or, for a file the editor has not needed
   * yet, its text as it was given (`Texts`).
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
    if (doc?.ready) return doc.contents();
    return this.texts.get(path)?.getValue();
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
    void this.mirrored.then(prefetch);
    // The shell too. With python already up, opening it — bash, then a round
    // of setup commands — was most of what was left of the first Run: 1.0 s
    // from the button on a return visit, measured, against 0.3 s for a second
    // Run. A failure here is left for the Run or command that needs the shell
    // to report, where somebody is looking.
    void this.ensureRuntime()
      .then(() => this.session?.ensureShell())
      .catch(() => {});
  }

  private ensureRuntime(): Promise<Runtime> {
    this.runtime ??= (async () => {
      // Its packages through the service worker, which a first visit may
      // still be installing (bootstrap.ts).
      await this.mirrored;
      const files = seedFiles(this.known, this.texts, this.docs);
      const binaries = new Map([...this.binaries].filter(([path]) => !ignored(path)));
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
    })().catch((e: unknown) => {
      // Not kept: a download that failed once — a dropped connection, a CDN
      // that stalled — made every Run after it fail the same way until the
      // page was reloaded (audit R6). The next Run tries again.
      this.runtime = null;
      throw e;
    });
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
      const now = seedFiles(this.known, this.texts, this.docs);
      const nowBinaries = new Map([...this.binaries].filter(([path]) => !ignored(path)));
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
   * Offer a preview when something in the folder starts listening, on
   * whatever port: each one is a server the preview can show.
   *
   * The button appears rather than the preview opening itself: a server
   * starting is not a request to be shown it, and a page that rearranges
   * itself under someone mid-command is worse than one that waits to be asked.
   */
  private watchForServers(rt: Runtime): void {
    const preview = new PreviewBrowser(
      this.el.previewPane,
      PREVIEW_ORIGIN,
      async () => (await this.ensureRuntime()).sandbox(),
      (message) => this.previewFailed(message),
      this.events.signal,
    );
    this.preview = preview;
    const paint = () => {
      const ports = preview.listening;
      if (ports.length) this.el.preview.hidden = false;
      this.el.preview.title = ports.length
        ? `Show ${ports.map((p) => `localhost:${p}`).join(", ")}`
        : "Nothing in the folder is listening now";
    };
    rt.sandbox().ports.onListen((port) => {
      preview.listen(port);
      paint();
    }, {
      onClose: (port) => {
        preview.unlisten(port);
        paint();
      },
    });
  }

  /**
   * An image in place of the editor: a plot `plt.show()` saved, or an image
   * file opened from the tree. Read from the sandbox when there is one, as a
   * figure just saved is there before the pad's copy is; from the pad's own
   * copy otherwise. A `data:` URL, because the pad's CSP allows no others
   * for images. Shown again when shown again: a figure redrawn by the next
   * run is the same file with new bytes.
   */
  private async showImage(path: string): Promise<void> {
    const type = imageType(path);
    if (!type) return;
    let base64 = this.binaries.get(path) ?? null;
    if (this.runtimeReady && this.runtime) {
      const bytes = await (await this.runtime).readBytes(path).catch(() => null);
      if (bytes) base64 = toBase64(bytes);
    }
    if (!base64) return this.say("error", `${path} could not be read`);
    if (this.preview?.isOpen) await this.togglePreview();
    const img = document.createElement("img");
    img.alt = path;
    img.src = `data:${type};base64,${base64}`;
    const caption = document.createElement("p");
    caption.className = "image-caption";
    caption.textContent = `${path} · ${Math.max(1, Math.round((base64.length * 3) / 4 / 1024))} KB`;
    img.onload = () => {
      caption.textContent = `${path} · ${img.naturalWidth} × ${img.naturalHeight} · ${Math.max(1, Math.round((base64!.length * 3) / 4 / 1024))} KB`;
    };
    // Named like an image and not one the browser can read: said, and the
    // editor left as it was rather than a broken picture in its place.
    img.onerror = () => {
      if (this.imageShown !== path) return;
      this.closeImage();
      this.say("", `${path} is not an image the browser can show — download it with the arrow beside it`);
    };
    this.el.imagePane.replaceChildren(img, caption);
    this.el.imagePane.hidden = false;
    this.el.editor.hidden = true;
    this.imageShown = path;
    this.ui?.setImage(path);
  }

  private closeImage(): void {
    this.el.imagePane.hidden = true;
    this.el.imagePane.replaceChildren();
    this.el.editor.hidden = false;
    this.imageShown = null;
    this.ui?.setImage(null);
    this.editor?.layout();
  }

  /**
   * The terminal's text for screen readers, on or off, beside New terminal:
   * remembered in this browser, and for every terminal at once.
   */
  private addScreenReaderToggle(): void {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "screen-reader";
    button.textContent = "Screen reader";
    const paint = () => {
      button.setAttribute("aria-pressed", String(this.screenReader));
      button.title = this.screenReader ? "The terminal's text is read out — off again" : "Let a screen reader read the terminal's text";
    };
    button.onclick = () => {
      this.screenReader = !this.screenReader;
      try {
        localStorage.setItem(SCREEN_READER_KEY, this.screenReader ? "1" : "0");
      } catch {
        // Not remembered, then; it still holds for this page.
      }
      for (const t of this.sessions) t.term.options.screenReaderMode = this.screenReader;
      paint();
    };
    paint();
    this.el.newTerminal.parentElement?.prepend(button);
  }

  /**
   * Focus to the next part of the page, or the one before: the header's Run,
   * the files, the editor, the terminal. What a keyboard needs to leave the
   * terminal, where Tab completes and Esc belongs to the program (WCAG 2.1.2;
   * review of 17 October, H4).
   */
  private cycleRegion(back: boolean): void {
    const regions: Array<{ holds: (el: Element) => boolean; focus: () => void }> = [
      { holds: (el) => this.el.run.parentElement?.contains(el) ?? false, focus: () => this.el.run.focus() },
      { holds: (el) => this.el.files.contains(el), focus: () => (this.el.files.querySelector<HTMLElement>(".row.on") ?? this.el.files.querySelector<HTMLElement>(".row, button"))?.focus() },
      { holds: (el) => this.el.editor.contains(el) || this.el.markdownPane.contains(el), focus: () => (this.el.markdownPane.hidden || !this.el.editor.parentElement?.classList.contains("md-shown") ? this.editor?.focus() : this.el.markdownPane.focus()) },
      { holds: (el) => this.el.terms.contains(el), focus: () => this.session?.term.focus() },
    ];
    const at = document.activeElement;
    const here = at ? regions.findIndex((r) => r.holds(at)) : -1;
    const next = here < 0 ? (back ? regions.length - 1 : 0) : (here + (back ? -1 : 1) + regions.length) % regions.length;
    regions[next]!.focus();
  }

  // ------------------------------------------------------------- the last run

  /**
   * A path a program printed, as the pad's file it is: under /workspace, or
   * relative — to wherever a typed command ran, which is not known here, so
   * the one pad file it can be. Null for anything else, a library's file or
   * a file the pad does not have.
   */
  private padPath(printed: string): string | null {
    const path = printed.replace(/^\/workspace\//, "").replace(/^(\.\/)+/, "");
    if (!path || path.startsWith("/") || path.startsWith("../")) return null;
    if (this.texts.has(path)) return path;
    const ends = [...this.texts.keys()].filter((p) => p.endsWith(`/${path}`));
    return ends.length === 1 ? ends[0]! : null;
  }

  /** A file and line from the terminal, opened there in the editor. */
  private openPlace(place: Place): void {
    const model = this.texts.model(place.path);
    if (!model || !this.editor) return;
    if (this.preview?.isOpen) void this.togglePreview();
    if (this.active !== place.path || this.imageShown !== null) this.show(place.path);
    const line = Math.max(1, Math.min(place.line, model.getLineCount()));
    const column = place.column ?? (model.getLineFirstNonWhitespaceColumn(line) || 1);
    this.editor.setPosition({ lineNumber: line, column });
    this.editor.revealLineInCenter(line);
    this.editor.focus();
  }

  /**
   * The errors a run printed, as squiggles where they are — each with what
   * it said, on hover and in F8's list. The last run's alone: what an earlier
   * one marked goes, here and in every file. They move with the text as it is
   * edited, and stay until the next run says otherwise.
   */
  private markProblems(output: string, command = ""): void {
    const monaco = this.monaco;
    if (!monaco) return;
    // The file a `node` command ran: Node names it `<anonymous>`.
    const node = /(?:^|[\s;&(])node\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|)'"]+))/.exec(command);
    const evaluated = node ? this.padPath(node[1] ?? node[2] ?? node[3]!) : null;
    for (const path of this.marked) {
      const model = this.texts.existing(path);
      if (model) monaco.editor.setModelMarkers(model, RUN_MARKS, []);
    }
    this.marked.clear();
    const byFile = new Map<string, ReturnType<typeof problemsIn>>();
    for (const problem of problemsIn(output, (p) => this.padPath(p), evaluated)) {
      byFile.set(problem.path, [...(byFile.get(problem.path) ?? []), problem]);
    }
    for (const [path, problems] of byFile) {
      // A mark is the model's: made for a file the run named that has none.
      const model = this.texts.model(path);
      if (!model) continue;
      monaco.editor.setModelMarkers(model, RUN_MARKS, problems.map((p) => {
        const line = Math.max(1, Math.min(p.line, model.getLineCount()));
        return {
          severity: p.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
          message: p.message,
          source: "last run",
          startLineNumber: line,
          startColumn: p.column ?? (model.getLineFirstNonWhitespaceColumn(line) || 1),
          endLineNumber: line,
          endColumn: model.getLineMaxColumn(line),
        };
      }));
      this.marked.add(path);
    }
  }

  /**
   * Run's output kept with the pad, so whoever opens it next sees what it
   * printed before running anything (`showLastRun`). Not for someone who
   * can only view, whose runs are their own; and only its end, as much as
   * the relay keeps.
   */
  private keepRun(path: string, command: string, finished: Finished | null, output: string): void {
    if (this.viewer || !finished) return;
    const run = { path, command, exit: finished.exitCode, output: keptOutput(output) };
    void this.store.keepRun(this.name, run).catch(() => {});
  }

  /**
   * The pad's last run, in the terminal as the pad opens: what it printed,
   * and when — and its errors marked, as they were. Not over anything typed
   * meanwhile, which is the person's screen by then.
   */
  private async showLastRun(): Promise<void> {
    let run: LastRun | null = null;
    try {
      run = await this.store.lastRun(this.name);
    } catch {
      return;
    }
    const session = this.sessions[0];
    if (!run || typeof run.output !== "string" || typeof run.command !== "string" || !session || this.disposed) return;
    const ended = run.exit === 0 ? "done" : `exit ${run.exit}`;
    const rule = (text: string) => `\x1b[90m── ${text} ──\x1b[0m\r\n`;
    const body = run.output.endsWith("\n") || !run.output ? run.output : `${run.output}\n`;
    if (session.console.printAbove(`${rule(`the last run, ${when(run.at_ms)}: ${run.command} · ${ended}`)}${body}${rule("Run to run it again")}`)) {
      this.markProblems(run.output, run.command);
    }
  }

  // ------------------------------------------------------------- markdown

  /** The Markdown file in the editor formatted, or back to its text alone. */
  private toggleMarkdown(): void {
    const path = this.active;
    if (!path || !isMarkdown(path)) return;
    if (!this.formatted.delete(path)) this.formatted.add(path);
    this.paintMarkdown();
    this.paintTools();
  }

  /**
   * The formatted pane, as the file in the editor and the choice for it say.
   * Beside the editor where there is room for both, over it where there is
   * not (style.css, by the viewer's width); gone with the editor when an
   * image or the server preview takes its place.
   */
  private paintMarkdown(): void {
    const on = this.active !== "" && this.formatted.has(this.active) && isMarkdown(this.active) && this.texts.has(this.active);
    this.el.markdownPane.hidden = !on;
    this.el.markdownPane.parentElement?.classList.toggle("md-shown", on);
    if (on) return this.renderMarkdownSoon(0);
    this.markdownAsked++;
    this.markdownAnchor = null;
    this.el.markdownPane.replaceChildren();
  }

  /** Again once typing pauses: anyone's, a command's, a restore's. */
  private renderMarkdownSoon(delay = 150): void {
    if (this.markdownTimer) clearTimeout(this.markdownTimer);
    this.markdownTimer = setTimeout(() => {
      this.markdownTimer = null;
      void this.renderMarkdown();
    }, delay);
  }

  private async renderMarkdown(): Promise<void> {
    const path = this.active;
    const file = this.texts.get(path);
    const pane = this.el.markdownPane;
    if (!file || pane.hidden) return;
    const asked = ++this.markdownAsked;
    pane.setAttribute("aria-label", `${path}, formatted`);
    const note = (text: string) => pane.replaceChildren(Object.assign(document.createElement("p"), { className: "md-note", textContent: text }));
    if (file.getValueLength() > MARKDOWN_MAX) return note(`${path} is more than ${MARKDOWN_MAX / 1024 / 1024} MB, too long to show formatted.`);
    const source = file.getValue();
    if (!source.trim()) return note("Nothing to show yet: the file is empty.");
    let fragment: DocumentFragment;
    try {
      fragment = await renderMarkdown(source, path, {
        image: (p) => this.imageUrl(p),
        colorize: (code, language) => this.colorize(code, language),
      });
    } catch (e) {
      if (asked === this.markdownAsked) note(`${path} could not be formatted: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (asked !== this.markdownAsked || this.active !== path || pane.hidden) return;
    const body = document.createElement("div");
    body.className = "md-body";
    body.append(fragment);
    pane.replaceChildren(body);
    const anchor = this.markdownAnchor;
    if (anchor && (anchor.path !== path || this.scrollMarkdownTo(anchor.id))) this.markdownAnchor = null;
  }

  /** A pad file as a `data:` URL for an image in a formatted file: the pad's copy, or the sandbox's when the pad has none yet. */
  private async imageUrl(path: string): Promise<string | null> {
    const svg = path.toLowerCase().endsWith(".svg");
    const type = imageType(path) ?? (svg ? "image/svg+xml" : null);
    if (!type) return null;
    let base64 = this.binaries.get(path) ?? null;
    // SVG is text, and an editor's model here. In an <img> it is a picture
    // and nothing else: its scripts do not run.
    if (!base64 && svg && this.texts.has(path)) base64 = toBase64(new TextEncoder().encode(this.texts.get(path)!.getValue()));
    if (!base64 && this.runtimeReady && this.runtime) {
      const bytes = await (await this.runtime).readBytes(path).catch(() => null);
      if (bytes) base64 = toBase64(bytes);
    }
    return base64 ? `data:${type};base64,${base64}` : null;
  }

  /** A code block in a formatted file, coloured by the editor's own tokenizer for its language. */
  private async colorize(code: string, language: string): Promise<string | null> {
    const monaco = this.monaco;
    if (!monaco || this.ui?.highlight === false) return null;
    const wanted = language.toLowerCase();
    const found = monaco.languages.getLanguages().find((l) =>
      l.id === wanted || l.aliases?.some((a) => a.toLowerCase() === wanted) || l.extensions?.includes(`.${wanted}`));
    if (!found) return null;
    return monaco.editor.colorize(code.replace(/\n$/, ""), found.id, { tabSize: this.indent });
  }

  /**
   * A link in a formatted file, followed inside the pad: another file opens
   * here — formatted too if it is Markdown, at its heading if it names one —
   * and `#heading` scrolls to it. Links out of the pad open in a tab of their
   * own, as their target says; the browser does that.
   */
  private followMarkdownLink(e: MouseEvent): void {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!a || !this.el.markdownPane.contains(a)) return;
    const link = linkFor(this.active, a.getAttribute("href") ?? "");
    if (link.kind === "outside") return;
    e.preventDefault();
    if (e.type === "auxclick" && e.button !== 1) return;
    if (link.kind === "here") return void this.scrollMarkdownTo(link.id);
    if (link.kind === "none") return;
    const { path, fragment } = link;
    if (this.texts.has(path)) {
      if (isMarkdown(path)) {
        this.formatted.add(path);
        this.markdownAnchor = fragment ? { path, id: fragment } : null;
      }
      if (path === this.active) return void this.scrollMarkdownTo(fragment);
      return this.show(path);
    }
    if (this.binaries.has(path) && imageType(path)) return void this.showImage(path);
    const folder = [...this.texts.keys(), ...this.binaries.keys()].some((p) => p.startsWith(`${path}/`));
    this.say("", folder ? `${path} is a folder — its files are in the list` : `there is no ${path} in this pad`);
  }

  /** To the heading `id` names, if the file has it; whether it had. */
  private scrollMarkdownTo(id: string): boolean {
    if (!id) return false;
    let wanted = id;
    try {
      wanted = decodeURIComponent(id);
    } catch {
      // As written.
    }
    const pane = this.el.markdownPane;
    const found = [`md-${wanted}`, `user-content-${wanted}`, `md-${slug(wanted)}`]
      .map((candidate) => pane.querySelector(`#${CSS.escape(candidate)}`))
      .find((el) => el !== null);
    found?.scrollIntoView({ block: "start" });
    return !!found;
  }

  // ------------------------------------------------------------- history

  /**
   * The pad's earlier versions, kept by the relay: the way it was after a
   * pause of ten minutes or more, and every ten minutes of a long session
   * (`VERSION_EVERY` in pad.rs). One is shown against the pad as it is, a file
   * at a time, and can be gone back to.
   */
  private async openHistory(): Promise<void> {
    const { dialog, body } = modal("History", this.name, "history-dialog");
    body.append(el("p", { className: "history-note" }, "Looking for earlier versions…"));
    dialog.showModal();
    let versions: Version[];
    try {
      versions = await this.store.history(this.name);
    } catch (e) {
      body.replaceChildren(el("p", { className: "history-note" }, `The history could not be read: ${(e as Error).message}`));
      return;
    }
    if (!versions.length) {
      body.replaceChildren(el("p", { className: "history-note" }, "No earlier versions yet. One is kept when this pad is changed after a pause of ten minutes or more, and every ten minutes while it is being changed."));
      return;
    }
    const list = el("div", { className: "history-list" });
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Earlier versions");
    const detail = el("div", { className: "history-detail" });
    body.replaceChildren(el("div", { className: "history-layout" }, list, detail));
    const pick = async (v: Version, row: HTMLElement) => {
      for (const r of list.children) r.setAttribute("aria-selected", String(r === row));
      detail.replaceChildren(el("p", { className: "history-note" }, "Reading that version…"));
      try {
        const files = await this.store.version(this.name, v.id);
        if (dialog.open) this.showVersion(detail, v, files, () => dialog.close());
      } catch (e) {
        detail.replaceChildren(el("p", { className: "history-note" }, `That version could not be read: ${(e as Error).message}`));
      }
    };
    for (const v of versions) {
      const row = button("", { className: "history-row", onClick: () => void pick(v, row) });
      row.setAttribute("role", "option");
      row.replaceChildren(el("strong", {}, when(v.at_ms)), el("span", {}, `${v.files} ${v.files === 1 ? "file" : "files"} · ${size(v.bytes)}`));
      row.title = new Date(v.at_ms).toLocaleString();
      list.append(row);
    }
    void pick(versions[0]!, list.firstElementChild as HTMLElement);
  }

  /** One version beside the pad as it is: each file marked by how it differs, one shown, and the way back. */
  private showVersion(host: HTMLElement, v: Version, files: Pad["files"], close: () => void): void {
    const now = new Map<string, string>();
    for (const path of this.texts.keys()) now.set(path, this.current(path) ?? "");
    for (const [path, base64] of this.binaries) if (!this.texts.has(path)) now.set(path, base64);
    const shown = (path: string) => !path.endsWith(`/${MARKER}`) && path !== MARKER;
    const paths = [...new Set([...Object.keys(files), ...now.keys()])].filter(shown).sort();
    const state = (path: string) => (!(path in files) ? "added" : !now.has(path) ? "deleted" : now.get(path) === files[path]!.content ? "same" : "changed");
    const label = { added: "added since", deleted: "deleted since", changed: "changed since", same: "the same" } as const;
    const changed = paths.filter((p) => state(p) !== "same").length;
    const fileList = el("div", { className: "history-files" });
    const preview = el("pre", { className: "history-preview" });
    const show = (path: string, row: HTMLElement) => {
      for (const r of fileList.children) r.classList.toggle("on", r === row);
      const f = files[path];
      if (!f) preview.textContent = `${path} did not exist then.`;
      else if (f.encoding === "base64") preview.textContent = `${path} is not text: ${size(Math.round((f.content.length * 3) / 4))}.`;
      else preview.textContent = f.content.length > 200_000 ? `${f.content.slice(0, 200_000)}\n… (the rest is not shown)` : f.content || "(empty)";
    };
    for (const path of paths) {
      const st = state(path);
      const row = button("", { className: `history-file ${st}`, onClick: () => show(path, row) });
      row.replaceChildren(el("span", { className: "history-path" }, path), el("span", { className: "history-state" }, label[st]));
      fileList.append(row);
    }
    const editable = this.access.role === "owner" || this.access.role === "editor";
    const restore = button("Restore this version", {
      className: "btn-primary",
      onClick: async () => {
        const ok = await confirmDialog({
          title: `Go back to ${when(v.at_ms)}?`,
          body: `Every file becomes what it was then, for everyone on this pad: ${changed} ${changed === 1 ? "file differs" : "files differ"}. What is here now is kept as a version first, so this can be undone the same way.`,
          confirm: "Restore it",
        });
        if (!ok) return;
        close();
        await this.restoreVersion(files, v.at_ms);
      },
    });
    restore.disabled = !editable || changed === 0;
    host.replaceChildren(
      el("div", { className: "history-head" }, el("strong", {}, new Date(v.at_ms).toLocaleString()), el("span", {}, changed ? `${changed} ${changed === 1 ? "file differs" : "files differ"} from now` : "the same as now")),
      el("div", { className: "history-body" }, fileList, preview),
      el("div", { className: "history-actions" }, editable ? restore : el("span", { className: "history-note" }, "Only someone who can edit this pad can restore it.")),
    );
    const first = paths.find((p) => state(p) !== "same") ?? paths[0];
    if (first) show(first, fileList.children[paths.indexOf(first)] as HTMLElement);
  }

  /**
   * Every file back to what it was in a version, the way a command that
   * copied them into the folder would: written into the sandbox behind the
   * page's back and published as a command's changes are, so open documents,
   * everyone else on the pad and the store all take it as they take any
   * command's work, and typing meanwhile is kept. The pad as it was is kept as
   * a version first.
   */
  private async restoreVersion(files: Pad["files"], at_ms: number): Promise<void> {
    if (this.replacing) return;
    if (this.busy || this.anyBusy) return this.say("", "stop what is running first: a restore changes files it may be using");
    this.say("saving", "restoring…");
    this.restructuring++;
    try {
      const rt = await this.ensureRuntime();
      await this.store.keepVersion(this.name);
      await this.queueWrite(() => this.flushModels(rt));
      await rt.settled();
      // As a command's start: what the page has written is what the change
      // is measured from.
      this.commandOut = true;
      rt.recordVersions();
      const box = rt.sandbox();
      for (const [path, f] of Object.entries(files)) {
        const slash = path.lastIndexOf("/");
        if (slash > 0) await box.fs.mkdir(at(path.slice(0, slash)), { recursive: true });
        if (f.encoding === "base64") await box.fs.writeFile(at(path), fromBase64(f.content));
        else await box.fs.writeText(at(path), f.content);
      }
      const here = [...this.texts.keys(), ...this.binaries.keys(), ...[...this.known.keys()].filter((p) => p.endsWith(MARKER))];
      for (const path of new Set(here)) if (!(path in files)) await rt.removeAndPrune(path);
      await this.publish(rt);
      this.say("", `restored to ${when(at_ms)}`);
    } catch (e) {
      this.say("error", `could not restore: ${(e as Error).message}`);
    } finally { this.restructuring--; }
  }

  /** Swap the editor for the running servers, and back. */
  private async togglePreview(): Promise<void> {
    const preview = this.preview;
    if (!preview) return;
    if (preview.isOpen) {
      preview.close();
      this.el.editor.hidden = false;
      this.ui?.setPreview(false);
      if (!this.ui) this.el.preview.classList.remove("on");
      this.editor?.layout();
      this.editor?.focus();
      return;
    }
    if (!preview.listening.length) return;
    this.el.editor.hidden = true;
    this.ui?.setPreview(true);
    if (!this.ui) this.el.preview.classList.add("on");
    await preview.open();
  }

  /**
   * The terminal is where everything else says what went wrong, and a
   * preview that fails silently is indistinguishable from one that is slow.
   */
  private previewFailed(message: string): void {
    this.session?.write(`\r\n\x1b[31mpreview: ${message}\x1b[0m\r\n`);
    this.say("error", `preview: ${message}`);
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
    if (this.sessions.length) return;
    await this.addTerminal(this.el.terminal);
    this.el.newTerminal.title = "Another terminal, in the same folder (its own bash)";
    this.el.newTerminal.onclick = () => void this.addTerminal();
    this.el.split.title = "Two terminals side by side";
    this.el.split.onclick = () => void this.toggleSplit();
    this.addTouchKeys();
    this.addScreenReaderToggle();
    onThemeChange(() => {
      for (const t of this.sessions) {
        t.term.options.theme = terminalTheme();
        t.term.options.fontSize = Math.max(11, this.codeFontPx() - 1);
      }
      this.fitTerminals();
    }, this.events.signal);
  }

  /**
   * Another terminal, in front: its own bash in the same sandbox, so the same
   * files, and a server one runs is one the other can reach. `element` is the
   * first's, which the workspace made; the rest are made here.
   */
  private async addTerminal(element?: HTMLElement): Promise<TerminalSession> {
    const { Terminal, FitAddon, TerminalSession } = await (this.xterm ??= (async () => {
      const [{ Terminal }, { FitAddon }, { TerminalSession }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        // The shell, and the tools it writes into the sandbox: 400 KB the
        // editor does not need, and the page's opening fetched until 20 October.
        import("./terminals"),
      ]);
      await import("@xterm/xterm/css/xterm.css");
      return { Terminal, FitAddon, TerminalSession };
    })());
    const number = (this.sessions.at(-1)?.number ?? 0) + 1;
    const host = element ?? Object.assign(document.createElement("div"), { className: "terminal", id: `terminal-${number}` });
    if (!element) this.el.terms.append(host);
    // On screen before it is opened, or it measures nothing and fits to it.
    this.session = null;
    this.layoutTerminals();
    host.classList.add("shown");
    const term = new Terminal({
      fontSize: Math.max(11, this.codeFontPx() - 1),
      convertEol: true,
      theme: terminalTheme(),
      // What it prints, for screen readers too, when asked for (the terminal's
      // Screen reader button): off, a program's output and its errors were on
      // screen and nowhere a screen reader could read (audit of 17 October,
      // UX1). Not always on: in that mode xterm takes no plain text input,
      // which is what a phone's keyboard and a pasted "ï" send.
      screenReaderMode: this.screenReader,
      // Text held to WCAG AA against its background in either theme — grey
      // notes included, which were dim and too faint (review M6).
      minimumContrastRatio: 4.5,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // Tab is the terminal's, as in any shell, so the way out is F6
    // (`cycleRegion`) — and a way out nobody is told of is no way out (WCAG
    // 2.1.2; review, 18 October). Said as the terminal takes focus, and on
    // screen beside the first wait (console.ts).
    let keys = document.getElementById("terminal-keys");
    if (!keys) {
      keys = Object.assign(document.createElement("span"), {
        id: "terminal-keys",
        className: "visually-hidden",
        textContent: "Tab types a tab here. F6 moves on to the next part of the page, Shift+F6 back; Ctrl+Enter runs the file.",
      });
      this.el.terms.append(keys);
    }
    term.textarea?.setAttribute("aria-describedby", "terminal-keys");
    host.title = "F6 leaves the terminal";
    const session = new TerminalSession(number, host, term, fit, {
      runtime: () => this.ensureRuntime(),
      prepare: (t, command) => {
        countRun(languageOfLine(command), "typed");
        this.commandOf.set(t, command);
        return this.prepare(t, command);
      },
      onBusy: (t, busy) => {
        this.onBusy(t, busy);
        // A language's run says what is wrong where: marked in the editor.
        // Anything else — ls, cd, pip — leaves the last run's marks alone.
        if (!busy && languageOfLine(this.commandOf.get(t) ?? "")) this.markProblems(t.lastOutput, this.commandOf.get(t));
      },
      place: (path) => this.padPath(path),
      openPlace: (place) => this.openPlace(place),
      onFinished: (t, finished) => void this.afterCommand(t, finished),
      installs: () => this.installs,
      ready: () => this.runtimeReady,
      onImage: (data) => {
        const path = imageFromOsc(data, ROOT);
        if (path) void this.showImage(path);
      },
    });
    this.sessions.push(session);
    this.session = session;
    session.start();
    this.layoutTerminals();
    if (!element) {
      term.focus();
      // Its bash now, so the first line typed in it does not wait for one.
      if (this.runtimeReady) void session.ensureShell().catch(() => {});
    }
    return session;
  }

  /** Which terminals are on screen — the one in front, and the next beside it when split — and their tabs. */
  private layoutTerminals(): void {
    const at = this.session ? this.sessions.indexOf(this.session) : -1;
    const beside = this.split && this.sessions.length > 1 && at >= 0 ? this.sessions[(at + 1) % this.sessions.length] : null;
    for (const t of this.sessions) t.element.classList.toggle("shown", t === this.session || t === beside);
    this.el.terms.classList.toggle("split", beside !== null);
    this.el.split.setAttribute("aria-pressed", String(this.split));
    this.renderTabs();
    this.paintRun();
    this.fitTerminals();
  }

  private fitTerminals(): void {
    requestAnimationFrame(() => {
      for (const t of this.sessions) if (t.element.classList.contains("shown")) t.fit.fit();
    });
  }

  /** A tab a terminal, once there are two: which one is in front, which have something running, and a way to close each. */
  private renderTabs(): void {
    if (this.sessions.length < 2) return this.el.tabs.replaceChildren();
    this.el.tabs.replaceChildren(...this.sessions.map((t) => {
      const wrap = document.createElement("span");
      wrap.className = "tab-wrap";
      const tab = document.createElement("button");
      tab.className = `tab${t === this.session ? " active" : ""}${t.busy ? " running" : ""}`;
      tab.textContent = `Terminal ${t.number}`;
      tab.title = t.busy ? `Terminal ${t.number} — something is running in it` : `Terminal ${t.number}`;
      tab.setAttribute("aria-pressed", String(t === this.session));
      tab.onclick = () => this.showTerminal(t);
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = t.busy ? `Stop what runs in terminal ${t.number}, and close it` : `Close terminal ${t.number}`;
      close.setAttribute("aria-label", `Close terminal ${t.number}`);
      close.onclick = () => void this.closeTerminal(t);
      wrap.append(tab, close);
      return wrap;
    }));
  }

  private showTerminal(t: TerminalSession): void {
    this.session = t;
    this.layoutTerminals();
    t.term.focus();
  }

  private async closeTerminal(t: TerminalSession): Promise<void> {
    if (this.sessions.length < 2) return;
    const at = this.sessions.indexOf(t);
    this.sessions.splice(at, 1);
    if (this.session === t) this.session = this.sessions[Math.min(at, this.sessions.length - 1)] ?? null;
    this.layoutTerminals();
    await t.close();
    this.onBusy(t, false);
    this.session?.term.focus();
  }

  private async toggleSplit(): Promise<void> {
    this.split = !this.split;
    if (this.split && this.sessions.length < 2) {
      const first = this.session;
      await this.addTerminal();
      // The new one beside the one that was in front, rather than in its place.
      if (first) this.session = first;
    }
    this.layoutTerminals();
  }

  /**
   * The keys a phone's keyboard does not have and a terminal needs: Tab to
   * complete, Ctrl-C to stop, the arrows for history and the line, Esc and
   * Ctrl-D. A row of them under the terminal's header on a touch screen, each
   * sent to the terminal in front as its key would be. Pressed without taking
   * the focus, so the phone's keyboard stays up.
   */
  private addTouchKeys(): void {
    if (!matchMedia("(pointer: coarse)").matches) return;
    const head = this.el.terms.parentElement?.querySelector(".terminal-head");
    if (!head || head.querySelector(".term-keys")) return;
    const row = document.createElement("div");
    row.className = "term-keys";
    row.setAttribute("role", "toolbar");
    row.setAttribute("aria-label", "Terminal keys");
    const keys: Array<[string, string, string]> = [
      ["Tab", "\t", "Tab: complete"],
      ["Ctrl-C", "\x03", "Ctrl-C: stop"],
      ["↑", "\x1b[A", "Up: the command before"],
      ["↓", "\x1b[B", "Down: the command after"],
      ["←", "\x1b[D", "Left"],
      ["→", "\x1b[C", "Right"],
      ["Esc", "\x1b", "Escape"],
      ["Ctrl-D", "\x04", "Ctrl-D: end of input"],
    ];
    for (const [label, data, title] of keys) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "term-key";
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", title);
      // Not a focus change: the keyboard would close and the terminal lose
      // its place.
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        const session = this.session;
        if (!session) return;
        session.console.handle(data);
        session.term.focus();
      });
      row.append(b);
    }
    head.append(row);
  }

  /** Whether anything is running in any terminal. */
  private get anyBusy(): boolean {
    return this.sessions.some((t) => t.busy);
  }

  /** A command started or finished in one of the terminals. */
  private onBusy(_t: TerminalSession, busy: boolean): void {
    if (busy) {
      this.commandOut = true;
      if (this.runtimeReady) void this.runtime?.then((rt) => rt.recordVersions());
    }
    const any = this.anyBusy;
    this.javac.busy(any);
    this.fetcher.busy(any);
    this.paintRun();
    this.renderTabs();
  }

  /**
   * Fetch any language a line needs that this pad does not have yet, and hand
   * back the fresh shell that has to run it — or null when nothing changed.
   * See toolchains.ts for why a fresh one. A terminal whose shell opened
   * before a language arrived in another gets a fresh one too, at its next
   * line.
   */
  private async prepare(session: TerminalSession, command: string): Promise<Shell | null> {
    if (this.replacing) throw new Error("Wait for replacements to finish.");
    const rt = await this.ensureRuntime();
    // What the editor holds, in the sandbox before the line reads it, as Run
    // does: a file edited a moment ago is otherwise still being saved, and a
    // command quick enough to read it first — javac answered by the page, in
    // milliseconds — compiles the copy from before the edit.
    await this.queueWrite(() => this.flushModels(rt));
    const fresh = await this.fetchFor(session, command, rt);
    if (fresh === false) return null;
    if (RUNS_PYTHON.test(command) && !/\bpip3?\b/.test(command)) {
      await this.installRequirements(rt, session, fresh ?? (await session.ensureShell()));
    }
    return fresh;
  }

  /**
   * `requirements.txt`, installed before the first thing that runs Python,
   * and again whenever it changes: a Flask app shared as a link runs on Run,
   * without a `pip install` its author knew to type.
   *
   * pip installs into `.deps`, and what was installed for which text is kept
   * there too (`INSTALLED_FOR`). `.deps` is not saved with the pad since
   * 18 October, so this holds for the sandbox it is in: a page's later
   * commands find it installed and nothing is fetched again, and a reload or
   * the next person installs afresh. Keyed on the file's text, so a package
   * that will not install is tried once per change rather than before every
   * command.
   *
   * Stopped with Ctrl-C, the line it was installing for does not run either:
   * that was the person asking for nothing to happen.
   */
  private async installRequirements(rt: Runtime, session: TerminalSession, sh: Shell): Promise<void> {
    const text = await rt.read(REQUIREMENTS).catch(() => null);
    if (text === null || !/^\s*[^#\s]/m.test(text) || text === this.requirementsInstalled) return;
    if ((await rt.read(INSTALLED_FOR).catch(() => null)) === text) {
      this.requirementsInstalled = text;
      return;
    }
    this.requirementsInstalled = text;
    session.write(`\x1b[90m${REQUIREMENTS} ${this.requirementsSeen ? "changed" : "is here"}: installing it first, as pip install -r ${REQUIREMENTS}…\x1b[0m\r\n`);
    this.requirementsSeen = true;
    const stopped = () => {
      // Asked again next time: it never finished.
      this.requirementsInstalled = null;
      return new Error(`stopped while installing ${REQUIREMENTS}, so the line did not run`);
    };
    const finished = await sh.run(`(cd /workspace && python -m pip install --disable-pip-version-check -q -r ${REQUIREMENTS})`);
    if (finished.interrupted) throw stopped();
    if (finished.exitCode === 0) {
      await rt.write(INSTALLED_FOR, text);
      return;
    }
    // pip resolves the whole file at once, so one misspelt line installed
    // nothing — six==1.17.0 beside it too, and the program then failed on
    // `import six` (18 October). Each line on its own, so the rest go in.
    const failed: string[] = [];
    for (const line of requirementLines(text)) {
      const each = await sh.run(`(cd /workspace && python -m pip install --disable-pip-version-check -q ${quoted(line)})`);
      if (each.interrupted) throw stopped();
      if (each.exitCode !== 0) failed.push(line);
    }
    if (!failed.length) {
      await rt.write(INSTALLED_FOR, text);
      return;
    }
    // Not recorded as installed: the next visitor, or this page after a
    // reload, tries again. This page does not until the file changes.
    session.write(`\x1b[33mpip could not install ${failed.join(", ")} from ${REQUIREMENTS}; the rest is installed and the program runs anyway. It is tried again when the file changes.\x1b[0m\r\n`);
  }

  /** The languages a line needs and this pad has not fetched yet: a fresh shell once they are here, false when one could not be. */
  private async fetchFor(session: TerminalSession, command: string, rt: Runtime): Promise<Shell | null | false> {
    const needed = neededBy(command, rt.installed);
    if (!needed.length) return session.stale ? session.replaceShell() : null;
    for (const t of needed) {
      session.write(`\x1b[90mfetching ${t.name} for this pad, the first time it is used — about ${t.mb} MB…\x1b[0m\r\n`);
      const began = performance.now();
      // Java's fast javac loads alongside the package, so the line about to
      // run finds it ready rather than compiling the slow way.
      const javac = t.commands.includes("javac") ? this.javac.load() : null;
      try {
        await rt.install(t.pkg);
        this.installs++;
      } catch (e) {
        session.write(`\x1b[31m${t.name} could not be fetched: ${(e as Error).message}\x1b[0m\r\n`);
        return false;
      }
      const fast = javac ? await this.javac.whenReady(20_000) : false;
      session.write(`\x1b[90m${t.name} is here (${Math.round((performance.now() - began) / 1000)} s)\x1b[0m\r\n`);
      // The note says compiling is slow; with the fast javac it is not.
      if (t.note && !fast) session.write(`\x1b[90mnote: ${t.note}\x1b[0m\r\n`);
    }
    return session.replaceShell();
  }

  // ------------------------------------------------------------------- run

  private openSearchResult(path: string, match?: SearchMatch, before?: string): void {
    if (!this.texts.has(path)) {
      if (this.binaries.has(path) && imageType(path)) void this.showImage(path);
      else this.say("", `${path} is not text — download it from Files`);
      this.ui?.fileSelected();
      return;
    }
    if (match && this.current(path) !== before) {
      this.search?.invalidate();
      this.say("", `${path} changed — search results refreshed`);
      return;
    }
    if (this.preview?.isOpen) void this.togglePreview();
    this.show(path);
    if (match && this.editor && this.monaco) {
      const editor = this.editor, monaco = this.monaco;
      const model = editor.getModel()!;
      const selectMatch = () => {
        // Monaco initially strips the BOM; binding can put it back into the
        // model's text. Calculate the range from the model as it stands now.
        const bom = match.line === 1 && before?.startsWith("\uFEFF") && !model.getValue().startsWith("\uFEFF");
        const from = { lineNumber: match.line, column: match.column - (bom ? 1 : 0) };
        const range = monaco.Range.fromPositions(from, { ...from, column: from.column + match.end - match.start });
        editor.setSelection(range);
        editor.revealRangeInCenterIfOutsideViewport(range);
      };
      selectMatch();
      // Bind may have been waiting for live state. Never carry the old selection to another file.
      if (!this.solo(path)) void this.readyDoc(path).then(() => {
        if (this.active === path && this.editor === editor && editor.getModel() === model && this.current(path) === before) selectMatch();
      }).catch(() => {});
    }
    this.ui?.fileSelected();
    this.editor?.focus();
  }

  private replacementBlocked(): boolean {
    const editable = this.access.role === "editor" || this.access.role === "owner";
    return !editable || !!this.lost || this.disposed || this.opening || this.busy || this.anyBusy || this.importing || this.moving || this.formatting || this.restructuring > 0;
  }

  private async prepareReplacements(files: ReplacementFile[], replacement: string): Promise<ReplacementPlan> {
    if (this.replacing || this.replacementBlocked()) throw new Error("Wait for running commands or workspace operations to finish; replacement requires edit access.");
    const plan: ReplacementPlan = { files: [], replacement, skipped: [] };
    const targets = await Promise.all(files.map(async (file) => {
      if (this.current(file.path) !== file.before || tooBigToShare(file.before.length, () => file.before)) return null;
      const doc = await this.readyDoc(file.path);
      return doc.ready && this.current(file.path) === file.before ? file : null;
    }));
    for (let i = 0; i < files.length; i++) {
      const file = targets[i];
      if (!file || this.replacementBlocked()) {
        plan.skipped.push(`${files[i]!.path} (changed, read-only, or no longer editable)`); continue;
      }
      const after = replaced(file.before, file.matches, replacement);
      if (after === file.before) { plan.skipped.push(`${file.path} (unchanged)`); continue; }
      if (tooBigToShare(after.length, () => after)) { plan.skipped.push(`${file.path} (replacement exceeds the editing limit)`); continue; }
      plan.files.push(file);
    }
    return plan;
  }

  private async applyReplacements(plan: ReplacementPlan): Promise<string> {
    if (this.replacing || this.replacementBlocked()) throw new Error("Replacement requires edit access and an idle workspace.");
    this.replacing = true;
    const skipped = [...plan.skipped];
    let count = 0, files = 0;
    let stopped = "";
    try {
      for (const file of plan.files) {
        if (this.replacementBlocked() || this.current(file.path) !== file.before) {
          skipped.push(`${file.path} (changed or no longer editable)`); continue;
        }
        const doc = this.docs.get(file.path);
        if (!doc?.ready || doc.contents() !== file.before || tooBigToShare(file.before.length, () => file.before)) {
          skipped.push(`${file.path} (changed or read-only)`); continue;
        }
        const edits = file.matches.map((m) => ({ at: m.start, remove: m.end - m.start, insert: plan.replacement }));
        const model = this.texts.existing(file.path);
        if (doc.bound && model && this.monaco) {
          model.pushStackElement();
          model.pushEditOperations([], edits.map((edit) => ({
            range: this.monaco!.Range.fromPositions(model.getPositionAt(edit.at), model.getPositionAt(edit.at + edit.remove)), text: edit.insert,
          })), () => null);
          model.pushStackElement();
        } else {
          doc.editMany(edits);
          this.setFile(file.path, doc.contents());
        }
        count += file.matches.length; files++;
        // Yield between files so role changes and incoming document updates can take effect.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (e) { stopped = ` Stopped: ${(e as Error).message}. Some files may remain unchanged.`; }
    finally {
      if (files) { this.journal(this.dirty); this.saveSoon(); }
      this.replacing = false; this.search?.invalidate();
    }
    const saving = this.saveTrouble ? " Some changes could not be saved; they remain in this browser." : " Changes save automatically; check the workspace status for save errors.";
    const message = `Applied ${count} ${count === 1 ? "replacement" : "replacements"} in ${files} ${files === 1 ? "file" : "files"}.${skipped.length ? ` Skipped: ${skipped.join("; ")}.` : ""}${stopped}${saving}`;
    this.say(stopped || this.saveTrouble ? "error" : "", message);
    return message;
  }

  private wire(): void {
    if (this.ui) this.search = new ProjectSearch(this.ui, {
      files: () => [
        ...[...this.texts.keys()].map((path) => ({ path, text: this.current(path) })),
        ...[...this.binaries.keys()].filter((p) => !this.texts.has(p) && !ignored(p)).map((path) => ({ path })),
      ],
      folders: () => {
        const folders = new Set(this.keptFolders());
        for (const path of [...this.texts.keys(), ...this.binaries.keys()]) {
          const parts = path.split("/"); parts.pop();
          while (parts.length) { folders.add(parts.join("/")); parts.pop(); }
        }
        return [...folders].sort();
      },
      canReplace: () => (this.access.role === "editor" || this.access.role === "owner") && !this.lost && !this.disposed,
      open: (path, match, before) => this.openSearchResult(path, match, before),
      prepare: (files, replacement) => this.prepareReplacements(files, replacement),
      apply: (plan) => this.applyReplacements(plan),
    });
    this.el.run.onclick = () => {
      const front = this.session;
      if (!front?.busy) return void this.run();
      // Run becomes Stop as soon as the program starts, so the second click
      // of a double-click would stop what the first one started.
      if (performance.now() - this.runPressed > 500) front.console.stop();
    };
    this.el.share.onclick = () => void this.share();
    // A viewer's changes exist nowhere but this tab. Browsers write their own
    // words on this prompt; the banner has already said what they would lose.
    addEventListener("beforeunload", (e) => {
      if (this.viewer && this.local.size > 0) e.preventDefault();
      // An editor's typing that saving has been failing to deliver: kept in
      // this browser too (`journal`), but asked about, as a viewer's is.
      if (!this.viewer && this.saveTrouble && this.dirty.size > 0) e.preventDefault();
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
    this.el.backToEditor.onclick = () => (this.imageShown !== null ? this.closeImage() : void this.togglePreview());
    this.el.format.onclick = () => void this.formatActive();
    this.el.indent.onclick = () => this.setIndent(this.indent === 4 ? 2 : 4);
    this.el.markdown.onclick = () => this.toggleMarkdown();
    // Middle clicks too: a link to a pad file followed by the browser would
    // open a pad of that name.
    for (const kind of ["click", "auxclick"] as const) {
      this.el.markdownPane.addEventListener(kind, (e) => this.followMarkdownLink(e), { signal: this.events.signal });
    }
    this.paintTools();
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
      // F6 and Shift-F6: to the next part of the page and back. The terminal
      // keeps Tab for completing, so this is the keyboard's way out of it.
      if (e.key === "F6" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.cycleRegion(e.shiftKey);
      }
      // VS Code's key for a Markdown preview.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "v" && isMarkdown(this.active)) {
        e.preventDefault();
        this.toggleMarkdown();
      }
    }, { signal: this.events.signal });
  }

  private async run(): Promise<void> {
    if (this.replacing) return;
    if (this.opening) {
      this.runWanted = true;
      this.say("loading", "opening… — Run starts as soon as the pad is open");
      return;
    }
    const program = interpreterFor(this.active);
    // A language fetched the first time it is used — C, Go, Node, PHP.
    const runner = program ? null : runnerFor(this.active);
    // Not over a command already running, typed or not: the button is Stop
    // then, and ⌘⏎ is ignored rather than answered with an error.
    // In the terminal in front, as typing it there would.
    const session = this.session;
    if ((!program && !runner) || this.busy || !session || session.busy) return;

    this.busy = true;
    this.runPressed = performance.now();
    this.paintRun();
    try {
      // Asked for at load now, so whether it exists says nothing about whether
      // it is ready — only a Run pressed within the first seconds waits here.
      this.say("loading", this.runtimeReady ? "" : "getting python ready…");
      const rt = await this.ensureRuntime();
      let sh = await session.ensureShell();
      if (session.stale) sh = await session.replaceShell();
      session.console.attach(sh);

      // Flush every model before running. The editor holds the text; the
      // sandbox holds the file. They are not the same thing, and running
      // without this executes the previous version — the code on screen
      // correct, the output wrong, and nothing to suggest why.
      for (const path of this.texts.keys()) await rt.write(path, this.current(path)!);

      this.say("running", "running…");
      // From the folder root, where the file tree's paths are, wherever the
      // terminal has been. A `cd sub` typed earlier made Run answer "can't open
      // file '/workspace/sub/main.py'". A subshell, so the terminal stays where
      // it was put; and only when it is needed, so the usual command is the
      // one a person would type. /workspace is the folder — see runtime.ts.
      // In single quotes: in double ones a file called `$HOME.py` or
      // `a$(x).py`, which a pad holds happily, ran some other file.
      const plain = runner ? runner.line : `${program} ${quoted(this.active)}`;
      if (runner) {
        const fresh = await this.prepare(session, plain);
        if (fresh) {
          sh = fresh;
          session.console.attach(fresh);
        }
      }
      const here = (await sh.query("pwd")).trim();
      const command = !here || here === "/workspace" ? plain : `(cd /workspace && ${plain})`;
      // Shown the way a typed one would be, because that is what it is: the
      // button is a shortcut for typing, not a second way to execute.
      session.console.announce(command);
      countRun(languageOfFile(this.active), "run");
      this.commandOf.set(session, command);
      const ran = this.active;
      let finished: Finished | null = null;
      try {
        if (program?.startsWith("python")) await this.installRequirements(rt, session, sh);
        finished = await sh.run(command);
      } finally {
        session.console.resume(finished);
      }

      this.say("saving", "saving…");
      await this.publish(rt);
      // After the files, so a pad saved for the first time by this Run is
      // there to keep it with.
      this.keepRun(ran, command, finished, session.lastOutput);
      const { exitCode, interrupted } = finished;
      this.say("", exitCode === 0 ? "done" : interrupted ? "stopped" : `exited ${exitCode}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    } finally {
      this.busy = false;
      this.paintRun();
      // A change that arrived mid-run was put off rather than dropped.
      if (this.missed) {
        const forced = this.missedForced;
        this.missed = false;
        this.missedForced = false;
        void this.refresh(forced);
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
  private async afterCommand(session?: TerminalSession, finished?: Finished | null): Promise<void> {
    if (this.busy || !this.runtime) return;
    try {
      // A typed `pip install` that worked goes into requirements.txt first,
      // so the save below takes it along.
      const command = session ? this.commandOf.get(session) : undefined;
      const installed = command && finished?.exitCode === 0 && !finished.interrupted ? pipInstalled(command) : null;
      if (session && installed?.length) await this.recordInstalled(await this.runtime, session, installed);
      await this.publish(await this.runtime);
      // Marked again now its files are the page's: a file the same line made
      // — `printf … > s.js; node s.js` — was not yet when the command ended.
      if (session && command && languageOfLine(command)) this.markProblems(session.lastOutput, command);
      // Ctrl-C on a pipe the runtime did not end (docs/use/pad.md, "A
      // pipeline can hang") can leave Python in this page answering nothing
      // after: the prompt is back, and the next `python` prints nothing at
      // all. Nothing else would say why (review, 18 October).
      const piped = command && /\|(?!\|)/.test(command.replace(/'[^']*'|"[^"]*"|\|\|/g, ""));
      if (session && finished?.interrupted && piped && /\b(python3?|pip3?)\b/.test(command)) {
        session.console.printAbove("\x1b[90mnote: a pipe stopped with ctrl-c can leave Python in this page stuck — if it prints nothing now, reload the page; your files are saved\x1b[0m\r\n");
      }
    } catch (e) {
      this.say("error", (e as Error).message);
    }
  }

  /**
   * Give up this place's document of a file for the room's, keeping what
   * was typed here and not yet saved: from the stored copy to this
   * document's text, rebased onto the room's.
   */
  private async rejoin(path: string, doc: DocSession): Promise<void> {
    if (this.docs.get(path) !== doc) return;
    const mine = doc.contents();
    // From where this place's history and the room's parted: what it had
    // when it lost the room, or what it seeded from while the room's was out
    // of reach, whichever came later. Not the stored copy, which may have
    // moved on since with work of either side's — measured from it, that
    // work would be taken out again, or left out.
    const dropped = this.atDrop.get(path);
    const seeded = doc.seededWith;
    const parted = dropped && (!seeded || dropped.at > seeded.at) ? dropped : seeded;
    const base = parted?.text ?? this.known.get(path) ?? mine;
    this.atDrop.delete(path);
    const shown = this.active === path;
    this.closeDoc(path);
    const room = await this.readyDoc(path);
    if (this.docs.get(path) !== room) return;
    const made = carryOver(base, mine, room.contents());
    if (made) this.applyEdit(path, room, made);
    else this.setFile(path, room.contents());
    if (shown && this.active === path) this.show(path);
  }

  /**
   * A change made outside the editor — a command's — put into a file's live
   * document as if typed there: through the editor when the file is on
   * screen, so the binding carries it, and into the document otherwise.
   */
  private applyEdit(path: string, doc: DocSession, change: Edit): void {
    const model = this.texts.existing(path);
    if (doc.bound && model && this.monaco) {
      // As replaceText does: an edit, so the view and the cursor stay where
      // they were, moving only as far as the text before them changed.
      const from = model.getPositionAt(change.at);
      const to = model.getPositionAt(change.at + change.remove);
      model.applyEdits([{ range: new this.monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: change.insert }]);
      return;
    }
    doc.edit(change.at, change.remove, change.insert);
    this.setFile(path, doc.contents());
  }

  /** Push whatever the command changed, and show any new files it made. */
  private async publish(rt: Runtime): Promise<void> {
    if (this.viewer) return this.keepLocally(rt);
    return this.queueWrite(async () => {
      await this.flushModels(rt);
      // Read nothing back before what the page has already written is there.
      await rt.settled();
      const found = await diff(rt, this.known, this.binaries);
      // Read back: what a command changed is in `found` now, and a document
      // may be written into the sandbox again whatever it holds.
      if (!this.anyBusy) this.commandOut = false;
      // What the page wrote to each file while the command ran, one of which
      // it read (`Runtime.recordVersions`). A command starting now keeps its
      // own from here.
      const versions = rt.takeVersions();
      if (this.anyBusy) rt.recordVersions();
      const { next, nextBinaries } = found;
      // A file with a live document is the document's. What the sandbox
      // holds of it is the page's own copy, written in as the document moved
      // — unless the command changed it. Taken back as it was, it put that
      // older text over whatever had been typed since, in this place and
      // every other: a character, or a paste, gone. Until 9 October.
      // A file somebody else has open, changed here by a command this page
      // has no document for: the change goes into their document — from
      // here, once. Stored alone, it never reached them; their editor kept
      // the old text, and their next keystroke saved it back over the
      // command's work for everyone. (Taken in by each of them instead, it
      // would be put in once per person, and a CRDT keeps every copy.)
      const elsewhere = new Set<string>();
      if (this.peers && !this.peers.alone) {
        for (const c of found.changes) {
          if (c.content === null || c.encoding === "base64" || isMarker(c.path, c.content)) continue;
          if (this.docs.has(c.path) || !this.known.has(c.path) || this.local.has(c.path)) continue;
          // Nobody has a live document of it: the store carries it.
          const content = c.content;
          if (tooBigToShare(content.length, () => content)) continue;
          elsewhere.add(c.path);
        }
        await Promise.all([...elsewhere].map((path) => this.readyDoc(path)));
      }
      const changes: typeof found.changes = [];
      for (const change of found.changes) {
        const doc = this.docs.get(change.path);
        if (!doc?.ready || change.content === null || change.encoding === "base64" || isMarker(change.path, change.content)) {
          changes.push(change);
          continue;
        }
        const wrote = rt.wrote(change.path);
        if (change.content === wrote) {
          // Untouched by the command: nothing to take back. What is stored
          // is the document as it is, not the sandbox's older copy of it.
          const live = doc.contents();
          next.set(change.path, live);
          if (live !== this.known.get(change.path)) changes.push({ ...change, content: live });
          continue;
        }
        // Changed by the command: that change, on top of the document as it
        // is now, and the result stored.
        const live = doc.contents();
        // Measured from the version the command read: of those the page
        // wrote while it ran, the one its result differs from least. From the
        // last write alone, typing that came after the command read the file
        // looked like the command taking it out. With no record of what the
        // page wrote, the difference from the document itself, which is what
        // taking it back used to do.
        const made = carryOver(closest(versions.get(change.path) ?? [], change.content) ?? wrote ?? live, change.content, live);
        if (made) this.applyEdit(change.path, doc, made);
        changes.push({ ...change, content: doc.contents() });
        next.set(change.path, doc.contents());
      }
      // Joined only to put the change in; nothing here shows them.
      for (const path of elsewhere) if (this.active !== path) this.closeDoc(path);
      // What the sandbox holds now is what the next command starts from —
      // the command's text, whatever the documents have since made of it.
      for (const change of found.changes) {
        if (change.content !== null && change.encoding !== "base64") rt.saw(change.path, change.content);
      }
      // And what the documents made of it goes back in, so the next command
      // runs the text everybody has: typing that came while this one ran was
      // kept out of the sandbox (intoSandbox), not lost.
      for (const change of found.changes) {
        const doc = this.docs.get(change.path);
        if (!doc?.ready || change.content === null || change.encoding === "base64" || isMarker(change.path, change.content)) continue;
        const text = doc.contents();
        if (text !== change.content) await rt.write(change.path, text);
      }
      // What the store will not keep — a name with a backslash or a tab, a
      // file past the pad's count — left out and said, not sent with the rest
      // for the store to refuse whole. Until 18 October one such file, or the
      // 1,336 of numpy, stopped everything any later command made from being
      // saved: refused, never remembered, sent again and refused again.
      const unsaved = this.unsavable(changes);
      let sendable = changes.filter((c) => !unsaved.has(c.path));
      let seq = this.storeSeq;
      if (sendable.length) {
        try {
          // Each with the version it was made from: written over a teammate's
          // newer save until 28 October.
          const based = await this.withBases(sendable);
          try {
            seq = await this.store.write(this.name, based);
          } catch (e) {
            if (!(e instanceof StoreError && e.stale) || based === sendable) throw e;
            seq = await this.writeOverStale(sendable, false);
          }
        } catch (e) {
          // Refused: this page may not change the pad any more — its access
          // went while the command ran. What the command made is kept here,
          // as a viewer's own, rather than reported as an error and lost.
          if (e instanceof StoreError && (e.refused || e.gone)) {
            await this.recheckAccess();
            if (this.viewer) await this.keepLocally(rt);
            return;
          }
          // Refused for something in it the checks above did not foresee: each
          // on its own, so a file refuses only itself.
          if (!(e instanceof StoreError && contentRefusal(e)) || sendable.length === 1) {
            if (e instanceof StoreError && contentRefusal(e)) unsaved.set(sendable[0]!.path, e.message);
            else throw e;
          } else {
            const each = await this.writeEach(sendable);
            seq = each.seq;
            for (const [path, why] of each.refused) unsaved.set(path, why);
          }
          sendable = sendable.filter((c) => !unsaved.has(c.path));
        }
      }
      // What was not saved is not what the store holds: the next command
      // offers it again, and it goes then if it can.
      for (const path of unsaved.keys()) {
        if (this.known.has(path)) next.set(path, this.known.get(path)!);
        else next.delete(path);
        if (this.binaries.has(path)) nextBinaries.set(path, this.binaries.get(path)!);
        else nextBinaries.delete(path);
      }
      this.tellUnsaved(unsaved);
      this.storeSeq = Math.max(this.storeSeq, seq);
      // What was sent, merged if it had to be, is what the store has of it.
      for (const c of sendable) {
        if (c.content === null) next.delete(c.path);
        else if (c.encoding !== "base64") next.set(c.path, c.content);
      }
      // Only what this command changed, onto what is known now: a read of the
      // pad while it was saving took in newer versions of other files, and
      // the snapshot from before put them back, so the next command's output
      // went over a newer save (review of 19 October, item 6).
      for (const c of found.changes) {
        const text = next.get(c.path);
        if (text !== undefined) this.known.set(c.path, text);
        else this.known.delete(c.path);
        const bytes = nextBinaries.get(c.path);
        if (bytes !== undefined) this.binaries.set(c.path, bytes);
        else this.binaries.delete(c.path);
      }
      if (!sendable.length) return;
      if (!this.el.markdownPane.hidden && sendable.some((c) => c.encoding === "base64")) this.renderMarkdownSoon();
      for (const change of sendable) {
        // Gone, or now binary: either way, no longer the editor's.
        if (change.content === null || change.encoding === "base64") {
          if (this.active === change.path) {
            const other = [...this.texts.keys()].filter((p) => p !== change.path).sort()[0];
            if (other) this.show(other);
          }
          this.closeDoc(change.path);
          this.texts.delete(change.path);
        } else if (!isMarker(change.path, change.content)) {
          // A file with a live document that is not the one on screen: the
          // command's change goes into the document too. Into the model alone,
          // it was undone here the moment the file was shown again — bound to
          // the document, which still had the old text — and never reached
          // anybody else in the room, whose next save could undo it for good.
          // (The one on screen carries it through its binding.) A live one
          // took the command's change above, before anything was awaited.
          const doc = this.docs.get(change.path);
          if (!doc?.ready) this.setFile(change.path, change.content);
        }
      }
      this.renderFiles();
      this.peers?.moved(seq);
    });
  }

  /**
   * Which of a command's changes the store would refuse, and why: a name it
   * will not keep, and new files past the pad's count, in the order made.
   */
  private unsavable(changes: Change[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const c of changes) {
      if (c.content === null) continue;
      const why = unstorable(c.path);
      if (why) out.set(c.path, why);
    }
    const stored = new Set([...this.known.keys(), ...this.binaries.keys()]);
    let count = stored.size;
    for (const c of changes) if (c.content === null && stored.has(c.path)) count--;
    for (const c of changes) {
      if (c.content === null || stored.has(c.path) || out.has(c.path)) continue;
      if (count >= MAX_FILES) out.set(c.path, `the pad holds at most ${MAX_FILES} files`);
      else count++;
    }
    return out;
  }

  /** Each change on its own, so one the store refuses refuses only itself: the newest sequence, and what was refused. */
  private async writeEach(changes: Change[]): Promise<{ seq: number; refused: Map<string, string> }> {
    let seq = this.storeSeq;
    const refused = new Map<string, string>();
    for (const change of changes) {
      try {
        seq = Math.max(seq, await this.store.write(this.name, [change]));
      } catch (e) {
        if (!(e instanceof StoreError && contentRefusal(e))) throw e;
        refused.set(change.path, e.message);
      }
    }
    return { seq, refused };
  }

  /**
   * Files a command made that the pad did not keep: by name and why, once
   * for each until it changes — in the status line, and above the prompt
   * where the command's output is. And the line cleared once saving is back
   * to everything.
   */
  private tellUnsaved(unsaved: Map<string, string>): void {
    if (!unsaved.size) {
      if (this.el.status.textContent?.startsWith(NOT_SAVED)) this.say("", "");
      return;
    }
    const fresh = [...unsaved].filter(([path, why]) => this.toldUnsaved.get(path) !== why);
    for (const [path, why] of fresh) this.toldUnsaved.set(path, why);
    if (!fresh.length) return;
    const [path, why] = fresh[0]!;
    const more = fresh.length > 1 ? ` and ${fresh.length - 1} more` : "";
    this.say("error", `${NOT_SAVED} ${path}${more} — ${why}`);
    this.session?.console.printAbove(`\x1b[33m${NOT_SAVED} ${path}${more} — ${why}\x1b[0m\r\n`);
  }

  /**
   * What a typed `pip install` put in, added to requirements.txt — the
   * packages themselves are not saved with the pad (`.deps` is ignored), so
   * the file is how whoever opens it next gets them: Run installs from it
   * first. Only names not there already; said above the prompt.
   */
  private async recordInstalled(rt: Runtime, session: TerminalSession, specs: string[]): Promise<void> {
    const text = (await rt.read(REQUIREMENTS).catch(() => null)) ?? "";
    const have = new Set(requirementLines(text).map(requirementName));
    const add = [...new Set(specs)].filter((spec) => !have.has(requirementName(spec)));
    if (!add.length) return;
    const lines = `${add.join("\n")}\n`;
    const next = text && !text.endsWith("\n") ? `${text}\n${lines}` : `${text}${lines}`;
    const model = this.texts.model(REQUIREMENTS);
    if (model) {
      // Open somewhere: an edit like typing, which saves and reaches the room.
      const end = model.getFullModelRange().getEndPosition();
      model.pushEditOperations([], [{ range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: next.slice(text.length) }], () => null);
    } else {
      await rt.write(REQUIREMENTS, next);
    }
    // Installed already, by the command itself: Run need not do it again.
    this.requirementsInstalled = next;
    session.console.printAbove(`\x1b[90m(added ${add.join(", ")} to ${REQUIREMENTS}, so ${add.length === 1 ? "it installs" : "they install"} for whoever opens this pad)\x1b[0m\r\n`);
  }

  private async share(): Promise<void> {
    // A copy of any pad, for anyone who can open it: the files into a new pad
    // of their own, named as they like while their account has names left.
    const ctx = { name: this.name, access: this.access, code: codeFor(this.name), onCopy: () => void this.saveCopy() };
    if (this.access.account) return openShare(ctx);
    // An open pad's link is copied at once, as it always was, and the dialog
    // only adds the copy beside it.
    const url = `${location.origin}/${this.name}`;
    try {
      await navigator.clipboard.writeText(url);
      this.say("", "link copied");
    } catch {
      this.say("", url);
    }
    openOpenShare(ctx);
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
    this.search?.invalidate();
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
    // Each model takes its document's text before the document goes. Only
    // the one on screen followed it; the rest held what they had when last
    // shown, and that older text was what came back.
    this.applyingRemote = true;
    try {
      for (const path of [...this.docs.keys()]) {
        const text = this.current(path);
        if (text !== undefined) this.setFile(path, text);
        this.closeDoc(path);
        this.local.add(path);
      }
    } finally {
      this.applyingRemote = false;
    }
    for (const path of this.dirty) this.local.add(path);
    for (const path of this.local) if (!this.keptFrom.has(path)) this.keptFrom.set(path, this.known.get(path));
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
    const kept = new Map([...this.local].map((path) => [path, { base: this.keptFrom.get(path), mine: this.texts.get(path)?.getValue() ?? null }]));
    const changes = putBack(kept, knownFrom(pad.files));
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
      if (inside(path) && !this.local.has(path) && !this.texts.has(path)) out.set(path, fromBase64(base64));
    }
    const enc = new TextEncoder();
    for (const path of this.texts.keys()) if (inside(path)) out.set(path, enc.encode(this.current(path) ?? ""));
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
    const name = windowsSafe(this.name);
    save(await makeZip(entries.map((e) => ({ path: `${name}/${e.path}`, data: e.data }))), `${name}.zip`);
    this.say("", `downloaded ${entries.length} ${entries.length === 1 ? "file" : "files"} as ${name}.zip`);
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
    save(await makeZip(entries), `${windowsSafe(leaf)}.zip`);
  }

  /** The starter on an empty pad, as it was put there — unsaved and untouched. */
  private untouchedStarter(): boolean {
    return this.starter && !this.known.has("main.py") && this.texts.get("main.py")?.getValue() === STARTER;
  }

  /**
   * A zip's files into this pad, for everyone on it. Read and checked here —
   * its text files only, the pad's limits held to before anything is sent —
   * and asked about first if it would replace files that are already here.
   */
  private async importZip(given?: File): Promise<void> {
    if (this.replacing) return;
    if (this.viewer || this.importing) return;
    const zip = given ?? (await pickZip());
    if (!zip || this.replacing) return;
    if (this.busy || this.anyBusy) return this.say("error", "wait for what is running to finish, then import");
    this.importing = true;
    try {
      this.say("loading", `reading ${zip.name}…`);
      let prepared: Prepared;
      const limits = await loadLimits();
      try {
        prepared = prepareImport(await readZip(zip, limits));
      } catch (e) {
        return this.say("error", e instanceof ZipError ? e.message : `could not read ${zip.name} as a zip`);
      }
      const { files } = prepared;
      const skipped = leftOut(prepared);
      if (!files.length) return this.say("error", `nothing in ${zip.name} a pad can hold${skipped ? ` — ${skipped}` : ""}`);
      // The starter makes way only for text: a zip of images alone would
      // leave the editor nothing to show.
      const starter = this.untouchedStarter() && files.some((f) => f.encoding === "utf8" && !isMarker(f.path, f.content));
      const after = new Set([...this.texts.keys(), ...this.binaries.keys(), ...files.map((f) => f.path)]);
      if (starter && !files.some((f) => f.path === "main.py")) after.delete("main.py");
      if (after.size > limits.maxFiles) return this.say("error", `that would make ${after.size} files here; a pad holds at most ${limits.maxFiles}`);

      const replacing = files.filter((f) =>
        f.encoding === "base64"
          ? (this.binaries.has(f.path) && this.binaries.get(f.path) !== f.content) || this.texts.has(f.path)
          : (this.texts.has(f.path) && !(f.path === "main.py" && starter) && this.current(f.path) !== f.content) || this.binaries.has(f.path),
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
      // A file this replaces that somebody else has open: its document is the
      // room's, and their next keystroke saved it back over the import — the
      // import gone, quietly (audit DC-01). Joined first, so the import goes
      // into the room's document, as a command's change does in publish().
      const elsewhere =
        this.peers && !this.peers.alone
          ? files.filter((f) => f.encoding === "utf8" && !isMarker(f.path, f.content) && this.known.has(f.path) && !this.docs.has(f.path)).map((f) => f.path)
          : [];
      await Promise.all(elsewhere.map((path) => this.readyDoc(path).catch(() => null)));
      await this.queueWrite(async () => {
        const seq = await this.store.write(this.name, files.map((f) => ({ path: f.path, content: f.content, encoding: f.encoding })));
        this.storeSeq = Math.max(this.storeSeq, seq);
        const rt = this.runtimeReady ? await this.runtime : null;
        this.applyingRemote = true;
        try {
          for (const f of files) {
            if (f.encoding === "base64") {
              // Not the editor's: into the tree and the sandbox as it is.
              if (this.texts.has(f.path)) {
                if (this.active === f.path) this.active = "";
                this.closeDoc(f.path);
                this.texts.delete(f.path);
                this.known.delete(f.path);
              }
              this.binaries.set(f.path, f.content);
              await rt?.writeBytes(f.path, fromBase64(f.content));
              if (!this.el.markdownPane.hidden) this.renderMarkdownSoon();
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
            if (doc?.bound) this.texts.existing(f.path)?.setValue(f.content);
            else if (doc) {
              doc.replace(f.content);
              this.setFile(f.path, f.content);
            } else this.setFile(f.path, f.content);
            await rt?.write(f.path, f.content);
          }
          // Joined only to put the import in; nothing here shows them.
          for (const path of elsewhere) if (this.active !== path) this.closeDoc(path);
          // The starter makes way for what was brought in.
          if (starter && !files.some((f) => f.path === "main.py")) {
            if (this.active === "main.py") this.active = "";
            this.closeDoc("main.py");
            this.texts.delete("main.py");
            await rt?.remove("main.py").catch(() => {});
          }
        } finally {
          this.applyingRemote = false;
        }
        this.starter = false;
        this.peers?.moved(seq);
      });
      if (!this.texts.has(this.active)) {
        const first = files.filter((f) => f.encoding === "utf8" && !isMarker(f.path, f.content)).map((f) => f.path).sort()[0] ?? [...this.texts.keys()].sort()[0];
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
  private async move(from: string, folder: boolean, toRaw: string, again = false): Promise<void> {
    if (this.viewer || this.moving || this.replacing) return;
    const to = toRaw.trim().replace(/^\/+|\/+$/g, "");
    if (!to || to === from) return;
    const safe = to.split("/").every((p) => p && p !== "." && p !== ".." && !/[\u0000-\u001f\\]/.test(p)) && new TextEncoder().encode(to).length <= 512;
    if (!safe) return this.say("error", `${to} is not a path a pad can hold`);
    if (folder && to.startsWith(`${from}/`)) return this.say("error", "a folder cannot go inside itself");
    const isBinary = (p: string) => this.binaries.has(p) && !this.texts.has(p);
    const isKeep = (p: string) => isMarker(p, this.known.get(p)) && !this.texts.has(p);
    const exists = (p: string) => this.texts.has(p) || this.binaries.has(p);
    const markers = [...this.known.keys()].filter(isKeep);
    const paths = [...this.texts.keys(), ...[...this.binaries.keys()].filter(isBinary), ...markers];
    if (!folder && paths.some((p) => p.startsWith(`${to}/`))) return this.say("error", `there is already a folder called ${to}`);
    if (folder && exists(to)) return this.say("error", `there is already a file called ${to}`);
    if (this.busy || this.anyBusy) return this.say("error", "wait for what is running to finish, then move it");

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
    let stale = false;
    try {
      await this.queueWrite(async () => {
        // The text as it stands here, typing not yet saved included; a
        // binary file as the store has it.
        const binaryPairs = pairs.filter(([p]) => isBinary(p));
        const markerPairs = pairs.filter(([p]) => isKeep(p));
        const textPairs = pairs.filter(([p]) => !isBinary(p) && !isKeep(p));
        const text = new Map(textPairs.map(([p]) => [p, this.current(p) ?? ""]));
        // A path both left and arrived at — `a/a` merged into `a`, where
        // `a/a/a/x.txt` comes to `a/a/x.txt` as `a/a/x.txt` leaves — is not
        // deleted after it is written: the deletion won, and a moved file was
        // gone while the status said moved (audit DC-02). Here and below.
        const arriving = new Set(pairs.map(([, t]) => t));
        const gone = (p: string) => !arriving.has(p);
        const binaryValue = new Map(binaryPairs.map(([p]) => [p, this.binaries.get(p)!]));
        const changes: Change[] = [
          ...textPairs.map(([p, t]) => ({ path: t, content: text.get(p)! })),
          ...binaryPairs.map(([p, t]): Change => ({ path: t, content: binaryValue.get(p)!, encoding: "base64" })),
          ...markerPairs.map(([, t]) => ({ path: t, content: "" })),
          ...pairs.filter(([p]) => gone(p)).map(([p]) => ({ path: p, content: null })),
        ];
        // Each with the version it was made from. A file somebody changed
        // since this page read it, or made at the new name, was written over
        // until 28 October: their version deleted, this page's older copy put
        // under the new name.
        let seq: number;
        try {
          seq = await this.store.write(this.name, await this.withBases(changes));
        } catch (e) {
          if (!(e instanceof StoreError && e.stale) || again) throw e;
          stale = true;
          return;
        }
        this.storeSeq = Math.max(this.storeSeq, seq);
        // Typed while the write was on its way, into the file's old document:
        // it goes with the file, to be saved next. Taken from before the
        // write alone, it went when the old document was closed.
        const later = new Map(textPairs.map(([p]) => [p, this.current(p) ?? text.get(p)!]));
        const rt = this.runtimeReady ? await this.runtime : null;
        const active = this.active;
        this.applyingRemote = true;
        try {
          for (const [p] of binaryPairs) if (gone(p)) this.binaries.delete(p);
          for (const [p, t] of binaryPairs) {
            const base64 = binaryValue.get(p)!;
            // Replacing a text file: it is not the editor's any more.
            if (this.texts.has(t)) {
              this.closeDoc(t);
              this.texts.delete(t);
              this.known.delete(t);
            }
            this.binaries.set(t, base64);
            await rt?.writeBytes(t, fromBase64(base64));
            if (!folder && gone(p)) await rt?.removeAndPrune(p);
          }
          for (const [p] of markerPairs) if (gone(p)) this.known.delete(p);
          for (const [, t] of markerPairs) {
            this.known.set(t, "");
            await rt?.write(t, "");
          }
          for (const [p, t] of textPairs) {
            this.binaries.delete(t);
            this.closeDoc(t);
            this.setFile(t, later.get(p)!);
            this.known.set(t, text.get(p)!);
            if (later.get(p) === text.get(p)) this.dirty.delete(t);
            else this.dirty.add(t);
          }
          for (const [p, t] of textPairs) if (this.formatted.delete(p)) this.formatted.add(t);
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
            if (gone(p)) this.viewStates.delete(p);
          }
          for (const [p] of textPairs) {
            if (!gone(p)) continue;
            this.dirty.delete(p);
            this.known.delete(p);
            this.closeDoc(p);
            this.texts.delete(p);
          }
          for (const [p, t] of textPairs) {
            await rt?.write(t, later.get(p)!);
            if (!folder && gone(p)) await rt?.removeAndPrune(p);
          }
          // A folder goes whole, so nothing of it is left to be published back
          // — unless it went into a folder of its own, where what arrived is
          // in it: then only what left.
          if (folder && pairs.every(([p]) => gone(p))) await rt?.removeTree(from).catch(() => {});
          else if (folder) for (const [p] of pairs) if (gone(p)) await rt?.removeAndPrune(p).catch(() => {});
        } finally {
          this.applyingRemote = false;
        }
        this.tree?.moved(from, to);
        this.renderFiles();
        this.peers?.moved(seq, pairs.filter(([p]) => gone(p)).map(([p, t]): [string, string] => [p, t]));
        if (textPairs.some(([p]) => later.get(p) !== text.get(p))) this.saveSoon();
      });
      if (!stale) this.say("", `moved ${from} to ${to}`);
    } catch (e) {
      this.say("error", (e as Error).message);
    } finally {
      this.moving = false;
    }
    if (!stale) return;
    // Somebody changed or made one of these since: the pad read again, their
    // changes merged into the files being moved, and the move made once more,
    // asked about again if it now replaces something.
    await this.refresh(true);
    const stored = (await this.store.read(this.name).catch(() => null))?.files ?? {};
    for (const path of this.texts.keys()) {
      if (path !== from && !(folder && path.startsWith(`${from}/`))) continue;
      const theirs = stored[path];
      if (theirs?.encoding === "utf8" && theirs.content !== this.known.get(path)) await this.mergeInto(path, theirs.content);
    }
    return this.move(from, folder, toRaw, true);
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
        if (this.local.has(change.path) && this.texts.get(change.path)?.getValue() === change.content) continue;
        this.closeDoc(change.path);
        this.local.add(change.path);
        if (change.content === null) {
          if (this.active === change.path) {
            const other = [...this.texts.keys()].filter((p) => p !== change.path).sort()[0];
            if (other) this.show(other);
          }
          this.texts.delete(change.path);
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
        const other = [...this.texts.keys()].filter((p) => p !== path).sort()[0];
        if (this.active === path && other) this.show(other);
        this.texts.delete(path);
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
    if (this.texts.has(path) && this.active === path) this.show(path);
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
    if (this.texts.has(this.active)) this.show(this.active);
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
        for (const [path, file] of this.texts) files.set(path, { path, content: file.getValue() });
        for (const [path, base64] of this.binaries) if (!files.has(path)) files.set(path, { path, content: base64, encoding: "base64" });
        for (const [path, content] of this.known) if (isMarker(path, content) && !files.has(path)) files.set(path, { path, content: "" });
      }
      // Live documents are ahead of the stored copy.
      for (const [path, doc] of this.docs) if (doc.hasState) files.set(path, { path, content: doc.contents() });
      for (const path of this.local) {
        const file = this.texts.get(path);
        if (file) files.set(path, { path, content: file.getValue() });
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
        // A name of their own, while the account has named places left.
        const limit = me.limits?.named ?? 0;
        const used = limit ? (await account.pads()).filter((p) => p.chosen).length : 0;
        const chosen = await nameDialog({
          title: "Name your copy",
          body: "A new pad of yours, with these files.",
          confirm: "Make the copy",
          left: limit - used,
          limit,
          check: (name) => account.nameFree(name),
        });
        if (chosen === null) return null;
        return { name: (await account.create(chosen || undefined)).name, account: true };
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
    const own = this.local.has(this.active) && this.texts.has(this.active);
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

  /**
   * A file shown with no live document: past `LIVE_MAX` by what its model
   * holds. One already live here, that grew past it while open, stays live —
   * it is already shared, and each change is its own message.
   */
  private solo(path: string): boolean {
    const model = this.texts.model(path);
    if (!model || this.docs.has(path)) return false;
    const units = model.getValueLength();
    if (units > LIVE_MAX) return true;
    if (units * 3 <= LIVE_MAX) return false;
    // Counting the bytes builds and encodes the whole text: 20 ms for 20 MB,
    // and it was paid on every switch to the file. Counted once a model now,
    // and after that bounded: a character added since is three bytes at most.
    // (Typed over rather than added, it can be more; `MAX_DOC_MESSAGE` is what
    // holds regardless.)
    const was = this.sized.get(path);
    if (was?.model === model.id && was.bytes + 3 * Math.max(0, units - was.units) <= LIVE_MAX) return false;
    const bytes = utf8Of(model);
    this.sized.set(path, { model: model.id, units, bytes });
    return bytes > LIVE_MAX;
  }

  /**
   * A file's bytes when `solo` last counted them, its length then, and which
   * model — by id, so a disposed one is not kept alive by this.
   */
  private sized = new Map<string, { model: string; units: number; bytes: number }>();

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
    this.search?.dispose();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const timer of this.stuck.values()) clearTimeout(timer);
    this.events.abort();
    this.peers?.close();
    this.unbind?.();
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
    this.texts.clear();
    this.suggestions?.dispose();
    this.editor?.dispose();
    for (const session of this.sessions) session.dispose();
  }
}

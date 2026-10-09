import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { applyStoredTheme, applyTheme, isDark, onThemeChange, THEME_CHOICES, themeChoice } from "@ajar/workspace-ui/theme";
import "@ajar/workspace-ui/theme.css";
import "./style.css";
import "@ajar/workspace-ui/workspace.css";

import { colourFor } from "./colours";
import { Connection, ConnState } from "./connection";
import { FileTree } from "./tree";
import { Workspace } from "./workspace";
import type { DocSession } from "./editing";
import type { Sealer } from "./sealed";
import { codeFontPx } from "./scale";
import {
  Channel,
  Control,
  Doc,
  DocKind,
  Frame,
  Fs,
  isStream,
  jsonFrame,
  parseJson,
  Person,
  Presence,
  Pty,
  SnapshotBody,
  SNAPSHOT_STREAM,
  Store,
  streamFrame,
  tagged,
  TARGET_ALL,
  textEncoder,
  untag,
  PROTOCOL_VERSION,
} from "./proto";

applyStoredTheme("ajar");

const app = document.getElementById("app")!;

/** `/j/quiet-ember-4417` → `quiet-ember-4417` */
function sessionFromPath(): string | null {
  const m = location.pathname.match(/^\/j\/([a-z0-9-]+)\/?$/i);
  return m ? m[1] : null;
}

const session = sessionFromPath();
if (import.meta.env.DEV && new URLSearchParams(location.search).get("preview") === "workspace") {
  void import("./workspace-preview").then(({ renderPreview }) => renderPreview(app));
} else if (!session) {
  renderLanding();
} else if (!hasKey(location.hash)) {
  // Every host sends a key, after the #. Without it — or with it cut short,
  // as a narrow terminal used to cut it — the page joined anyway, could read
  // nothing, and sat on "Loading…" for good.
  incompleteLink(session);
} else {
  renderJoin(session);
}

// ------------------------------------------------------------ dead ends

/** Whether the link carries a whole key: 32 bytes, as 43 base64url characters. */
function hasKey(hash: string): boolean {
  return /[#&]k=[A-Za-z0-9_-]{43}(?:&|$)/.test(hash);
}

interface GateOptions {
  title: string;
  /** The session it is about, shown as a chip. */
  session?: string;
  lines: string[];
  /** A command to copy, shown whole and scrollable. */
  command?: string;
  /** The one thing to do next. */
  action?: { label: string; run: () => void };
  /** "alert" for something wrong, "info" for a plain end. */
  tone?: "alert" | "info";
}

/**
 * A screen with nowhere further to go: what happened, in a sentence or two,
 * and the one thing to do about it. It takes the page's title and the
 * focus, so it is announced rather than silently swapped in.
 */
function gate(options: GateOptions) {
  const icon =
    options.tone === "info"
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9.5 17h-19z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  app.innerHTML = `
    <main class="centered">
      <section class="gate ${options.tone ?? "alert"}">
        <div class="gate-icon">${icon}</div>
        <h1 tabindex="-1">${escapeHtml(options.title)}</h1>
        ${options.session ? `<code class="name-chip">${escapeHtml(options.session)}</code>` : ""}
        ${options.lines.map((l) => `<p class="muted">${escapeHtml(l)}</p>`).join("")}
        ${options.command ? `<div class="install gate-command"><code id="gate-command">${escapeHtml(options.command)}</code><button type="button" id="gate-copy">copy</button></div>` : ""}
        ${options.action ? `<button type="button" id="gate-action" class="gate-action">${escapeHtml(options.action.label)}</button>` : ""}
      </section>
    </main>`;
  document.title = `${options.title} · ajar`;
  if (options.action) (document.getElementById("gate-action") as HTMLButtonElement).onclick = options.action.run;
  const copy = document.getElementById("gate-copy") as HTMLButtonElement | null;
  if (copy && options.command) {
    const text = options.command;
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "copied";
      } catch {
        copy.textContent = "select it";
      }
    };
  }
  (app.querySelector(".gate h1") as HTMLElement).focus();
}

function incompleteLink(session: string) {
  gate({
    title: "This link is incomplete",
    session,
    lines: [
      "The part after #k= is missing or cut short, and without it nothing in the session can be read.",
      "Ask the host to send the whole link — [c] on their panel copies it.",
    ],
  });
}

// ------------------------------------------------------------ landing page

function renderLanding() {
  app.innerHTML = `
    <main class="landing">
      <header class="landing-head">
        <h1>ajar</h1>
        <p class="tagline">Leave a machine open to someone.</p>
        <button type="button" class="theme-toggle landing-theme" id="landing-theme"></button>
      </header>

      <p class="lede">
        One command turns a folder on your machine into a live workspace —
        real terminals, the real toolchain, your actual files. Whoever you
        send the link to opens it and starts working. Nothing to install on
        their side, no account, no port forwarding.
      </p>

      <div class="install">
        <code id="install-cmd">curl -sSf ${location.origin}/run.sh | sh</code>
        <button id="copy" title="Copy">copy</button>
      </div>

      <ol class="steps">
        <li><code>ajar ~/projects/api</code> — it prints a link and keeps running</li>
        <li>Send the link. They type a name and they're in.</li>
        <li>Press <kbd>q</kbd>. Every terminal ends and the link stops working.</li>
      </ol>

      <section class="caveats">
        <h2>What a guest can and cannot do</h2>
        <p>
          A guest gets a shell with your real toolchain, confined by the
          operating system: they cannot write outside the folder you shared,
          and they cannot read your SSH keys or cloud credentials. Temp
          directories and build caches stay writable, because otherwise
          nothing compiles.
        </p>
        <p>
          <strong>macOS</strong> uses Seatbelt, which denies a named list of
          credential locations. <strong>Linux</strong> uses Landlock, which
          only grants — so the whole of your home directory is invisible
          apart from the shell config and build caches handed back. Linux is
          the stricter of the two.
        </p>
        <p>
          <strong>It is a sandbox, not a virtual machine.</strong> It stops
          the ordinary case — a stray <code>rm -rf</code>, an idle look
          through <code>~/.ssh</code>. It does not stop someone determined
          with a kernel bug.
        </p>
        <p>
          Either way: anything inside the shared folder is theirs to read,
          including a <code>.env</code> sitting next to the code. The agent
          points that out before it prints the link.
        </p>
      </section>

      <section class="facts">
        <h2>What it does today</h2>
        <ul>
          <li>Shared terminals — everyone sees the same output, everyone can type</li>
          <li>A live file tree, with the project's own ignore rules applied</li>
          <li>Files two people can edit at once, with cursors</li>
          <li>End-to-end encryption — the relay routes what it cannot read</li>
          <li>Reconnects invisibly; terminals keep running while you're away</li>
        </ul>
        <h2>What it doesn't</h2>
        <ul>
          <li>Keep anything once you close it. While it is open the relay holds a
            sealed copy of the folder, which it cannot read, so guests can still
            read the files if you drop off; <code>--no-sync</code> turns that off</li>
          <li>macOS and Linux. Windows works through WSL2, untested</li>
        </ul>
      </section>

      <footer class="landing-foot">
        Already have a link? It looks like <code>/j/quiet-ember-4417</code>.
      </footer>
    </main>`;

  // The same three choices as the workspace, kept under the same name.
  const themeButton = document.getElementById("landing-theme") as HTMLButtonElement;
  const paintTheme = () => {
    const now = themeChoice();
    const next = THEME_CHOICES[(THEME_CHOICES.indexOf(now) + 1) % THEME_CHOICES.length]!;
    themeButton.textContent = `Theme: ${now[0]!.toUpperCase()}${now.slice(1)}`;
    themeButton.setAttribute("aria-label", `Theme: ${now}. Switch to ${next}.`);
  };
  themeButton.onclick = () => {
    const now = themeChoice();
    const next = THEME_CHOICES[(THEME_CHOICES.indexOf(now) + 1) % THEME_CHOICES.length]!;
    try {
      localStorage.setItem("ajar.theme", next);
    } catch {
      // Not kept, but still applied for this page.
    }
    applyTheme(next);
    paintTheme();
  };
  paintTheme();

  const copy = document.getElementById("copy") as HTMLButtonElement;
  copy.onclick = async () => {
    const cmd = document.getElementById("install-cmd")!.textContent ?? "";
    try {
      await navigator.clipboard.writeText(cmd);
      copy.textContent = "copied";
      setTimeout(() => (copy.textContent = "copy"), 1500);
    } catch {
      copy.textContent = "select it";
    }
  };
}

// --------------------------------------------------------------- join screen

function renderJoin(session: string) {
  // Read the key before the fragment can be lost to navigation.
  const sealerReady = import("./sealed").then((m) => m.Sealer.fromHash(location.hash));
  app.innerHTML = `
    <main class="centered">
      <h1>ajar</h1>
      <p class="muted">Joining <code>${session}</code></p>
      <form id="join">
        <label for="name" class="join-label">Your name, as others will see it</label>
        <input id="name" placeholder="Ada" autocomplete="nickname" maxlength="32" required />
        <button type="submit">Join</button>
      </form>
      <p class="notice">
        You'll get a shell on someone else's machine. Everything you run there
        runs as them, in the folder they shared.
      </p>
    </main>`;

  const form = document.getElementById("join") as HTMLFormElement;
  const input = document.getElementById("name") as HTMLInputElement;
  input.value = localStorage.getItem("ajar.name") ?? "";
  input.focus();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    localStorage.setItem("ajar.name", name);
    const sealer = await sealerReady;
    if (!sealer) return incompleteLink(session);
    renderSession(session, name, sealer);
  };
}

// ------------------------------------------------------------ session screen

interface TerminalTab {
  ptyId: number;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

function renderSession(session: string, name: string, sealer: Sealer | null) {
  const workspace = new Workspace(app, session);

  const statusEl = document.getElementById("status")!;
  /** Beside the status, not in it: the retry countdown is not news. */
  const statusDetailEl = document.createElement("span");
  statusDetailEl.className = "status-detail";
  statusEl.after(statusDetailEl);
  const dotEl = document.getElementById("dot")!;
  const peopleEl = document.getElementById("people")!;
  const tabsEl = document.getElementById("tabs")!;
  const termsEl = document.getElementById("terms")!;
  const emptyEl = document.getElementById("empty")!;
  const newBtn = document.getElementById("new-terminal") as HTMLButtonElement;
  const splitBtn = document.getElementById("split") as HTMLButtonElement;
  // Said where the keys are needed, and to screen readers on the terminal.
  const termHint = document.createElement("span");
  termHint.className = "term-hint";
  termHint.id = "term-hint";
  termHint.textContent = "F6 leaves the terminal";
  document.querySelector(".terminal-head")?.appendChild(termHint);
  /** Why the last New terminal did nothing, until one opens. */
  const termNotice = document.createElement("span");
  termNotice.className = "term-notice";
  termNotice.setAttribute("role", "status");
  document.getElementById("terminal-actions")!.prepend(termNotice);

  const awayEl = document.getElementById("away")!;
  const lockedEl = document.getElementById("locked") as HTMLElement;
  const readOnlyEl = document.getElementById("readonly") as HTMLElement;
  /** Set by the host. Enforced there too — this only stops us wasting bytes. */
  let readOnly = false;
  /**
   * Whether this page has decided about opening a first terminal. Once per
   * page: someone who closes their last terminal meant to.
   */
  let firstTerminalSettled = false;
  /**
   * Files from the copy the relay keeps, used while the host is away.
   *
   * Read-only on purpose: the host is authoritative whenever it is online,
   * and a store nobody can write to can never disagree with it.
   */
  let offlineFiles: Map<string, string> | null = null;
  /** Between `host_away` and `host_back`: the relay is here, the host is not. */
  let hostAway = false;
  /** When the relay stops holding the session, for the countdown. */
  let awayUntil = 0;
  let awayTimer: ReturnType<typeof setInterval> | null = null;
  /** What the away banner says about the saved copy, once the relay answers. */
  let copyNote = "";
  /** The file on screen from the saved copy, to swap for the live one later. */
  let fromCopy: string | null = null;
  /**
   * Terminals the host has named since we last lost touch with it, or null
   * when nothing is being checked. The host names every live one and then
   * says whether they are read-only, so at that point any tab it did not name
   * is a terminal that ended while we could not hear about it.
   */
  let announced: Set<number> | null = null;
  let connState: ConnState = "connecting";
  /**
   * Whether the host has said anything on this socket. Until it does, the
   * session is connected only as far as the relay: a host whose laptop is
   * asleep holds its socket open and answers nothing, and the page used to
   * look like an empty, working session with a button that did nothing.
   */
  let hostHeard = false;
  let waitingTimer: ReturnType<typeof setTimeout> | null = null;
  let connDetail: string | undefined;
  /**
   * Typing that has gone nowhere yet: made while the socket was down or the
   * host away. It is handed back when they return — unless the tab is closed
   * first, which is what the leave prompt is for.
   */
  let unsent = false;
  const fileCountEl = document.getElementById("filecount")!;
  const viewerEl = document.getElementById("viewer")!;
  let selection = 0;
  let disposed = false;
  let focusSelectedFile = false;

  /** The file currently open for editing, if any. */
  let editing: DocSession | null = null;
  let detach: (() => void) | null = null;
  let reconnectingDocument: { path: string; base: string; local?: string } | null = null;
  /**
   * Document bytes that arrived before the editor was ready.
   *
   * The host sends a document's full state immediately after `opened`, but
   * binding it means loading Monaco and the editing module first. Without
   * this the initial state lands in the gap and the file opens empty.
   */
  const earlyDocFrames: Array<[number, DocKind, Uint8Array]> = [];
  /** Why the host would not let the file on screen be edited, for its read-only copy. */
  let refusedBecause: { path: string; why: string } | null = null;
  // ---- downloads ------------------------------------------------------
  // A file comes as itself; a folder, or everything, as a zip the host makes.
  // It arrives in pieces, each acknowledged, so the host never sends more
  // than the relay will queue for a slow connection.
  const downloads = new Map<number, { name: string; bytes: number; chunks: Uint8Array[]; received: number; acked: number }>();
  let downloadWait: ReturnType<typeof setTimeout> | null = null;

  function requestDownload(path: string) {
    conn.send(jsonFrame(Channel.Fs, TARGET_ALL, { t: "download", path } satisfies Fs));
    toast(`Preparing ${path || "the whole workspace"} to download…`);
    if (downloadWait) clearTimeout(downloadWait);
    // An agent from before downloads says nothing at all. A minute, not
    // less: a large folder is read whole before the host answers.
    downloadWait = setTimeout(() => {
      downloadWait = null;
      toast("No answer from the host after a minute. Their ajar may be too old to send downloads — ask them to update.");
    }, 60_000);
  }

  function downloadAnswered() {
    if (downloadWait) clearTimeout(downloadWait);
    downloadWait = null;
  }

  function startReceiving(id: number, name: string, bytes: number) {
    downloadAnswered();
    downloads.set(id, { name, bytes, chunks: [], received: 0, acked: 0 });
    if (bytes > 1024 * 1024) toast(`Downloading ${name} (${(bytes / (1024 * 1024)).toFixed(1)} MB)…`);
    if (bytes === 0) finishDownload(id);
  }

  function receiveDownload(id: number, chunk: Uint8Array) {
    const d = downloads.get(id);
    if (!d) return;
    d.chunks.push(chunk.slice());
    d.received += chunk.length;
    if (d.received >= d.bytes || d.received - d.acked >= 256 * 1024) {
      d.acked = d.received;
      conn.send(jsonFrame(Channel.Fs, TARGET_ALL, { t: "received", id, received: d.received } satisfies Fs));
    }
    if (d.received >= d.bytes) finishDownload(id);
  }

  function finishDownload(id: number) {
    const d = downloads.get(id);
    if (!d) return;
    downloads.delete(id);
    const url = URL.createObjectURL(new Blob(d.chunks as BlobPart[]));
    const a = document.createElement("a");
    a.href = url;
    a.download = d.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(`Downloaded ${d.name}.`);
  }

  // Everything, or the folder the file tree is on; and the open file.
  const downloadAll = document.createElement("button");
  downloadAll.type = "button";
  downloadAll.className = "quiet-button download";
  const labelDownloadAll = () => {
    const folder = tree.focusedFolder;
    downloadAll.textContent = folder ? `Download ${folder.split("/").pop()}/` : "Download all";
    downloadAll.title = folder ? `Download ${folder} as a zip` : "Download the whole workspace as a zip";
  };
  downloadAll.onclick = () => requestDownload(tree.focusedFolder ?? "");
  document.getElementById("sidebar-actions")?.appendChild(downloadAll);
  const downloadFile = document.createElement("button");
  downloadFile.type = "button";
  downloadFile.className = "quiet-button download";
  downloadFile.textContent = "Download";
  downloadFile.hidden = true;
  downloadFile.onclick = () => {
    if (workspace.editor.path) requestDownload(workspace.editor.path);
  };
  document.getElementById("editor-actions")?.appendChild(downloadFile);

  /** Documents typed into while the host was away. */
  const typedAway = new Set<DocSession>();
  /** Of those, the ones no longer on screen, waiting to be handed back. */
  const parked: DocSession[] = [];
  /** Typing that was waiting for a host that came back on a different footing. */
  function dropParked() {
    for (const doc of parked.splice(0)) doc.destroy();
    typedAway.clear();
  }

  /** A document bound for the editor, waiting for its first state. */
  let awaitingState: { docId: number; resolve: () => void } | null = null;

  function closeDocument() {
    reconnectingDocument = null;
    discardDocument(true);
  }

  function discardDocument(notifyHost: boolean) {
    earlyDocFrames.length = 0;
    if (!editing) return;
    if (notifyHost && hostAway && typedAway.has(editing)) {
      // Typed into while the host was away, and none of it has reached them.
      // Closing it now would throw that away, so it is kept — off screen —
      // and handed back, then closed, when they return.
      detach?.();
      parked.push(editing);
      editing = null;
      detach = null;
      delete viewerEl.dataset.editing;
      return;
    }
    if (notifyHost) {
      conn.send(
        jsonFrame(Channel.Doc, TARGET_ALL, { t: "close", doc_id: editing.docId } satisfies Doc),
      );
    }
    detach?.();
    editing.destroy();
    editing = null;
    detach = null;
    delete viewerEl.dataset.editing;
  }

  const tree = new FileTree(document.getElementById("tree")!, async (path) => {
    const version = ++selection;
    downloadFile.hidden = false;
    focusSelectedFile = workspace.fileSelected();
    tree.setActive(path);
    closeDocument();
    // Load the editor before asking for content, so the reply can never
    // arrive before there is somewhere to put it.
    const v = await workspace.editor.open(path);
    if (!v || version !== selection || disposed) return;
    // With the host away, the saved copy is all there is — and it is
    // read-only, because nothing can be written back to a host that is gone.
    // Asking the host would only be dropped by the relay, and the file would
    // sit there loading for as long as the host was gone.
    if (hostAway) {
      showFromCopy(path);
      if (focusSelectedFile) workspace.editor.focus();
      requestAnimationFrame(() => {
        v.layout();
        layout();
      });
      return;
    }
    // Ask to edit. The host refuses anything binary or oversized, and we
    // fall back to reading it.
    conn.send(jsonFrame(Channel.Doc, TARGET_ALL, { t: "open", path } satisfies Doc));
    // The pane was hidden a moment ago, so it has no size yet.
    requestAnimationFrame(() => {
      v.layout();
      layout();
    });
  });

  /** The open file from the saved copy, or why it cannot be. */
  function showFromCopy(path: string) {
    const v = workspace.editor.viewer;
    if (!v || v.current !== path) return;
    fromCopy = path;
    const text = offlineFiles?.get(path);
    if (text !== undefined) v.show(path, text, false, true, "saved copy, read-only while the host is away");
    else if (offlineFiles) v.problem(path, "not in the saved copy — it opens when the host is back");
    else v.problem(path, "the host is away — waiting for the saved copy");
  }

  tree.onFocusMove = labelDownloadAll;
  labelDownloadAll();

  (document.getElementById("close-file") as HTMLButtonElement).onclick = () => {
    ++selection;
    downloadFile.hidden = true;
    fromCopy = null;
    closeDocument();
    workspace.editor.close();
    workspace.editor.focus();
    tree.setActive(null);
    requestAnimationFrame(layout);
  };

  const tabs = new Map<number, TerminalTab>();
  /** From the host's roster. The relay never sends names. */
  let people: Person[] = [];
  /** participant id → the terminal they're looking at. */
  const watching = new Map<number, number | null>();
  let me = 0;
  /**
   * Which terminal is in each pane. One entry means a single view, two means
   * split — a dev server in one and a shell in the other is the shape this
   * exists for.
   */
  let panes: (number | null)[] = [null];
  /** The pane a tab click lands in. */
  let focused = 0;
  const active = () => panes[focused] ?? null;
  const themeEvents = new AbortController();
  onThemeChange(() => {
    for (const tab of tabs.values()) tab.term.options.theme = terminalTheme();
    drawPeople();
  }, themeEvents.signal);

  const resume = resumeSecret(session);
  const conn = new Connection({
    session,
    name,
    sealer,
    resume,
    // Every frame from the host fails to open: the key is the wrong one —
    // whole, so it passed the check above, but not this session's.
    onUnreadable: () => {
      dispose();
      conn.close();
      gate({
        title: "This link's key doesn't fit",
        session,
        lines: [
          "The part after #k= is not the one this session was opened with, so nothing in it can be read.",
          "Ask the host to send the link again — [c] on their panel copies it.",
        ],
      });
    },
    onState: setState,
    onFrame: onFrame,
  });

  function setState(s: ConnState, detail?: string) {
    connState = s;
    connDetail = detail;
    paintStatus();
    if (s === "reconnecting" && editing && !reconnectingDocument) {
      reconnectingDocument = { path: editing.path, base: editing.ytext.toString() };
    }
  }

  /**
   * The connection, as far as the person here can tell. "Connected" with the
   * host gone was true of the socket and wrong about everything they cared
   * about.
   */
  function paintStatus() {
    const away = hostAway && connState === "open";
    const waiting = !away && connState === "open" && !hostHeard;
    const word = away ? "host away" : waiting ? "waiting for the host" : STATE_WORDS[connState];
    // The live region says only what changed state. The countdown to the
    // next retry is beside it, not in it, or it was read out at every step.
    statusEl.textContent = word;
    statusDetailEl.textContent = connDetail && !away && !waiting ? ` · ${connDetail}` : "";
    dotEl.className = `dot ${away || waiting ? "away" : connState}`;
    newBtn.disabled = connState !== "open" || hostAway || readOnly || !hostHeard;
    newBtn.title = readOnly ? "The host made terminals read-only" : hostAway ? "The host is away" : "";
    for (const tab of tabs.values()) tab.term.options.disableStdin = readOnly || hostAway;
  }

  /** Whether closing the tab now would lose typing, and the prompt if so. */
  function setUnsent(value: boolean) {
    if (unsent === value) return;
    unsent = value;
    if (value) window.addEventListener("beforeunload", warnUnsent);
    else window.removeEventListener("beforeunload", warnUnsent);
  }
  function warnUnsent(e: BeforeUnloadEvent) {
    e.preventDefault();
    e.returnValue = "";
  }

  /** The host is back, or might be: out of the away state. */
  function leaveAway() {
    if (!hostAway) return;
    hostAway = false;
    if (awayTimer) clearInterval(awayTimer);
    awayTimer = null;
    offlineFiles = null;
    paintAway();
    paintStatus();
    // A file read from the saved copy is the live one again — and may have
    // changed. The reader stays where they were in it.
    const stale = fromCopy;
    fromCopy = null;
    if (stale && !editing && workspace.editor.path === stale) {
      conn.send(jsonFrame(Channel.Doc, TARGET_ALL, { t: "open", path: stale } satisfies Doc));
    }
  }

  let welcomedOnce = false;

  function waitingForHost(code: string) {
    awayEl.textContent =
      code === "rate_limited"
        ? "The relay is turning away new connections for a moment. Trying again…"
        : "The relay restarted and the host's agent hasn't reconnected yet. Trying again — terminals keep running on their machine.";
    awayEl.hidden = false;
  }

  function paintAway() {
    if (!hostAway) {
      awayEl.hidden = true;
      return;
    }
    const left = Math.max(0, Math.ceil((awayUntil - Date.now()) / 1000));
    const holding = left > 0
      ? `Holding this session for ${left < 60 ? `${left}s` : `${Math.floor(left / 60)}m ${String(left % 60).padStart(2, "0")}s`}`
      : "Still waiting";
    awayEl.textContent = `The host's connection dropped. ${holding} — terminals are still running on their machine, but take no typing until they are back. Typing in a file you have open is kept and sent when they return.${copyNote}`;
    awayEl.hidden = false;
  }

  function drawPeople() {
    // A list, read as one: it was a span whose label screen readers ignored,
    // the names run together, and which one was you shown only by an
    // outline nobody could see.
    peopleEl.setAttribute("role", "list");
    peopleEl.setAttribute("aria-label", "People here");
    peopleEl.innerHTML = people
      .map((p) => {
        // "…" is someone who has not said who they are yet.
        const name = p.name === "…" ? "someone joining" : p.name;
        const tags = [p.role === "host" ? "host" : "", p.id === me ? "you" : ""].filter(Boolean).join(", ");
        // A dot in their cursor's colour, so who is typing where can be told
        // at a glance; on a phone, the dots and a count are all that fit.
        return `<span role="listitem" data-id="${p.id}" class="person${p.role === "host" ? " host" : ""}${p.id === me ? " me" : ""}" title="${escapeHtml(name)}${tags ? ` (${tags})` : ""}"><span class="person-dot" style="background:${colourFor(p.id)}" aria-hidden="true"></span><span class="person-name">${escapeHtml(name)}</span>${tags ? ` <span class="person-tag">(${tags})</span>` : ""}</span>`;
      })
      .join("") + `<span class="people-count" aria-hidden="true">${people.length} here</span>`;
  }

  function onFrame(f: Frame) {
    if (disposed) return;
    // Anything on a content channel is the host speaking.
    if (f.channel !== Channel.Control && f.channel !== Channel.Store && !hostHeard) {
      hostHeard = true;
      if (waitingTimer) clearTimeout(waitingTimer);
      waitingTimer = null;
      if (!hostAway) awayEl.hidden = true;
      paintStatus();
    }
    if (f.channel === Channel.Control) {
      const msg = parseJson<Control>(f);
      switch (msg.t) {
        case "welcome": {
          // Checked before anything else, because everything else is sealed.
          //
          // A host on a different protocol cannot read a byte this client
          // sends, and nothing anywhere reports that: both ends drop what they
          // cannot decrypt. Left alone the session connects, the terminal
          // draws, and typing does nothing — which reads as the product being
          // broken rather than the agent being old.
          // Absent and zero are different answers. A relay that predates this
          // field sends nothing, and knows nothing — blocking on that would
          // refuse working sessions during a partial rollout. A current relay
          // always serialises it, so a zero is that relay saying the host it
          // is connected to is older than this client.
          const hostProtocol = msg.host_protocol;
          if (hostProtocol !== undefined && hostProtocol !== PROTOCOL_VERSION) {
            dispose();
            conn.close();
            if (hostProtocol < PROTOCOL_VERSION) {
              gate({
                title: "The host's ajar is older than this page",
                session,
                lines: [
                  "This page cannot talk to it, so the session was not opened.",
                  "Send them this to update, then ask for a new link:",
                ],
                command: `curl -sSf ${location.origin}/install.sh | sh`,
              });
            } else {
              gate({
                title: "This page is out of date",
                session,
                lines: ["The host is running a newer ajar than this page. Reloading picks up the current one."],
                action: { label: "Reload", run: () => location.reload() },
              });
            }
            break;
          }
          me = msg.participant_id;
          welcomedOnce = true;
          // Heard from the relay; the host has yet to answer on this socket.
          hostHeard = false;
          if (waitingTimer) clearTimeout(waitingTimer);
          waitingTimer = setTimeout(() => {
            waitingTimer = null;
            if (hostHeard || hostAway || disposed) return;
            awayEl.textContent =
              "Waiting for the host's machine to answer. If their laptop is asleep, this connects when it wakes — nothing to do here.";
            awayEl.hidden = false;
          }, 10_000);
          paintStatus();
          // Their document ids belonged to the last socket.
          dropParked();
          if (!editing) setUnsent(false);
          if (!hostAway) awayEl.hidden = true;
          // A new socket: any terminal that ended while we were gone is
          // still a tab here. The host is about to name the live ones.
          announced = new Set();
          // Whatever we last heard about the host is from before the gap.
          // The relay says `host_away` again, straight after this, if it is
          // still true.
          leaveAway();
          // The relay has no idea who we are. Say so on the encrypted
          // channel; the host answers with a roster.
          conn.send(
            jsonFrame(Channel.Presence, TARGET_ALL, { t: "iam", name, resume } satisfies Presence),
          );
          if (editing) {
            const base = reconnectingDocument?.base ?? editing.ytext.toString();
            reconnectingDocument = {
              path: editing.path,
              base,
              local: editing.ytext.toString(),
            };
            const path = editing.path;
            discardDocument(false);
            conn.send(jsonFrame(Channel.Doc, TARGET_ALL, { t: "open", path } satisfies Doc));
          }
          break;
        }
        case "joined":
          // A roster follows once they have introduced themselves.
          break;
        case "left":
          watching.delete(msg.participant_id);
          editing?.forget(msg.participant_id);
          drawTabs();
          break;
        case "host_away":
          // Terminals stay alive on the host the whole time; this is only
          // the socket between us and them.
          hostAway = true;
          awayUntil = Date.now() + msg.grace_secs * 1000;
          copyNote = "";
          if (awayTimer) clearInterval(awayTimer);
          awayTimer = setInterval(paintAway, 1000);
          paintAway();
          paintStatus();
          // Fall back to the copy the relay keeps, so the folder does not
          // simply go dead while we wait.
          conn.send(jsonFrame(Channel.Store, TARGET_ALL, { t: "fetch" } satisfies Store));
          // A file asked for in the instant before is never going to arrive.
          if (!editing && workspace.editor.path) showFromCopy(workspace.editor.path);
          break;
        case "host_back": {
          if (hostAway) toast("The host is back.");
          leaveAway();
          // The host names its terminals again on the way back.
          announced = new Set();
          // Everything said while the host was away was dropped by the relay,
          // not queued: an introduction made in the gap, where we are
          // looking, and — the one that matters — any typing. Say them again.
          // The host treats a repeated name as no news, and a whole document
          // state as nothing it did not already have.
          conn.send(jsonFrame(Channel.Presence, TARGET_ALL, { t: "iam", name, resume } satisfies Presence));
          reportPresence();
          if (editing) {
            conn.send(
              streamFrame(Channel.Doc, editing.docId, tagged(DocKind.Update, editing.fullState())),
            );
          }
          // Files typed into in the gap and then left: theirs too, then closed.
          for (const doc of parked.splice(0)) {
            conn.send(streamFrame(Channel.Doc, doc.docId, tagged(DocKind.Update, doc.fullState())));
            conn.send(jsonFrame(Channel.Doc, TARGET_ALL, { t: "close", doc_id: doc.docId } satisfies Doc));
            doc.destroy();
          }
          typedAway.clear();
          if (connState === "open") setUnsent(false);
          break;
        }
        case "locked":
          if (lockedEl.hidden === msg.locked) {
            toast(msg.locked ? "The host locked this session: nobody new can join. You're still in." : "The host unlocked this session.");
          }
          lockedEl.hidden = !msg.locked;
          lockedEl.title = msg.locked ? "Nobody new can join. You're still in, and a reload keeps you in." : "";
          break;
        case "closed":
          dispose();
          conn.close();
          // Not necessarily the end: a host that went away for longer than
          // the relay would wait can still come back on the same link, and
          // this page was the only one that did not know it.
          gate({ ...ended(msg.reason), session });
          break;
        case "error":
          // Once in, a refusal on the way back is usually a pause, not an
          // end. A restarted relay knows nothing of this session until the
          // host's agent reconnects — often a second or two after the guests
          // — and a page that gave up on the first "no such session" lost
          // everyone for good while a fresh load of the same link worked.
          if (welcomedOnce && RETRYABLE.has(msg.code)) {
            waitingForHost(msg.code);
            break;
          }
          dispose();
          conn.close();
          gate({ ...refused(msg.code, msg.message), session });
          break;
      }
      return;
    }

    if (f.channel === Channel.Pty) {
      if (isStream(f)) {
        // Hot path: raw terminal bytes, written straight through so UTF-8
        // sequences split across frames still land correctly.
        tabs.get(f.streamId)?.term.write(f.payload);
        return;
      }
      const msg = parseJson<Pty>(f);
      if (msg.t === "opened") {
        announced?.add(msg.pty_id);
        openTab(msg.pty_id, msg.cols, msg.rows);
        if (msg.opened_by === me) termNotice.textContent = "";
      } else if (msg.t === "refused") {
        // Said out loud: a button that silently does nothing reads as a bug.
        termNotice.textContent = `No new terminal: ${msg.reason}`;
        toast(`No new terminal: ${msg.reason}.`);
      } else if (msg.t === "closed") {
        closeTab(msg.pty_id);
      } else if (msg.t === "resize") {
        const tab = tabs.get(msg.pty_id);
        if (tab) resizeFromHost(tab.term, msg.cols, msg.rows);
      } else if (msg.t === "read_only") {
        // The end of the host naming its terminals, after a join or its own
        // return: a tab it did not name ended while we could not hear.
        if (announced) {
          for (const id of [...tabs.keys()]) if (!announced.has(id)) closeTab(id);
          announced = null;
          // And to a host that has just (re)met us, our own size. The tabs we
          // already had were set to its size, not measured, so nothing else
          // would say — and with no size from us, the host kept the smallest
          // guest's long after they had gone.
          requestAnimationFrame(reportOwnSize);
        }
        const flipped = readOnly !== msg.read_only;
        readOnly = msg.read_only;
        readOnlyEl.hidden = !readOnly;
        // Edits the host refused while this was on never reached anyone, and
        // every later edit depends on them: the host would park those for
        // ever and this page would quietly disagree with everyone else's. The
        // file is opened again, from the host's copy, whichever way it went.
        if (flipped && editing) {
          const path = editing.path;
          discardDocument(true);
          // Nothing typed until it is bound again would be kept.
          workspace.editor.viewer?.setReadOnly(true);
          conn.send(jsonFrame(Channel.Doc, TARGET_ALL, { t: "open", path } satisfies Doc));
        }
        readOnlyEl.title = readOnly ? "The host has made this session read-only: you can watch and read, not type or edit." : "";
        if (flipped && firstTerminalSettled) {
          toast(readOnly ? "The host made this session read-only: you can watch and read, not type or edit." : "You can type and edit again.");
        }
        for (const tab of tabs.values()) tab.term.options.cursorBlink = !readOnly;
        paintStatus();
        // The host drops edits while this is on; the editor says so by not
        // taking them, rather than letting someone type into a file that
        // will not keep it.
        if (editing) workspace.editor.viewer?.setReadOnly(readOnly);
        // Arriving to "No terminals yet" meant a click before anything worked,
        // and a shell is what most people came for. The host sends every live
        // terminal before this message, on one ordered stream, so an empty set
        // here means there really are none — opening one sooner could race a
        // terminal still being announced and leave two.
        if (!firstTerminalSettled) {
          firstTerminalSettled = true;
          if (tabs.size === 0 && !readOnly) requestTerminal();
        }
      }
      return;
    }

    if (f.channel === Channel.Presence) {
      const msg = parseJson<Presence>(f);
      if (msg.t === "update") {
        watching.set(msg.participant_id, msg.active_pty);
        drawTabs();
      } else if (msg.t === "roster") {
        people = msg.people;
        document.getElementById("workspace")!.textContent = msg.workspace;
        document.getElementById("workspace")!.title = msg.workspace;
        drawPeople();
        drawTabs();
      }
      return;
    }

    if (f.channel === Channel.Doc) {
      if (f.streamId === 0) {
        const msg = parseJson<Doc>(f);
        if (msg.t === "opened") void startEditing(msg.doc_id, msg.path);
        else if (msg.t === "closed") {
          // The host ended the document: its file was deleted, moved, turned
          // binary or grew past the limit, so nothing more can be saved.
          // Typing into it used to carry on, and go nowhere.
          const kept = parked.findIndex((d) => d.docId === msg.doc_id);
          if (kept >= 0) parked.splice(kept, 1)[0]!.destroy();
          if (editing?.docId !== msg.doc_id) return;
          const path = editing.path;
          discardDocument(false);
          workspace.editor.viewer?.stranded(path, msg.reason);
        } else if (msg.t === "error") {
          // Not editable — binary, or too large. Show it read-only and say
          // why rather than silently doing nothing.
          if (workspace.editor.path !== msg.path) return;
          refusedBecause = { path: msg.path, why: msg.message };
          workspace.editor.viewer?.problem(msg.path, msg.message);
          conn.send(jsonFrame(Channel.Fs, TARGET_ALL, { t: "read", path: msg.path } satisfies Fs));
        }
        return;
      }
      const split = untag(f.payload);
      if (!split) return;
      const [kind, body] = split;
      if (editing && editing.docId === f.streamId) {
        if (kind === DocKind.Update) {
          editing.applyUpdate(body);
          if (awaitingState?.docId === f.streamId) awaitingState.resolve();
        } else editing.applyAwareness(body);
      } else if (earlyDocFrames.length < 256) {
        earlyDocFrames.push([f.streamId, kind, body]);
      }
      return;
    }

    if (f.channel === Channel.Store) {
      if (f.streamId === SNAPSHOT_STREAM) {
        void useOfflineCopy(f.payload);
      } else {
        const msg = parseJson<Store>(f);
        if (msg.t === "empty") {
          offlineFiles = new Map();
          copyNote = " No copy of the files was kept, so they open again when the host is back.";
          paintAway();
          if (fromCopy && workspace.editor.path === fromCopy) showFromCopy(fromCopy);
        }
      }
      return;
    }

    if (f.channel === Channel.Fs) {
      if (isStream(f)) {
        receiveDownload(f.streamId, f.payload);
        return;
      }
      const msg = parseJson<Fs>(f);
      switch (msg.t) {
        case "archive":
          startReceiving(msg.id, msg.name, msg.bytes);
          break;
        case "download_error":
          downloadAnswered();
          toast(`Can't download ${msg.path || "the workspace"}: ${msg.message}.`);
          break;
        case "tree":
          tree.setEntries(msg.entries);
          fileCountEl.textContent = fileCount(tree.count);
          break;
        case "patch":
          tree.applyPatch(msg.added, msg.changed, msg.removed);
          fileCountEl.textContent = fileCount(tree.count);
          break;
        case "content":
          if (msg.binary) workspace.editor.viewer?.problem(msg.path, "binary file");
          else {
            // Shown to read because it could not be edited: still say why.
            const why = refusedBecause?.path === msg.path ? refusedBecause.why : undefined;
            workspace.editor.viewer?.show(msg.path, msg.text, msg.truncated, true, why && `read-only: ${why}`);
          }
          if (focusSelectedFile && workspace.editor.path === msg.path) { workspace.editor.focus(); focusSelectedFile = false; }
          break;
        case "read_error":
          workspace.editor.viewer?.problem(msg.path, msg.message);
          break;
      }
    }
  }

  function openTab(ptyId: number, cols: number, rows: number) {
    const existing = tabs.get(ptyId);
    if (existing) {
      // The host re-announced this terminal, which happens when it comes
      // back from a drop. A full replay follows, so start from a blank
      // screen rather than appending to what we already had.
      existing.term.reset();
      resizeFromHost(existing.term, cols, rows);
      return;
    }
    emptyEl.remove();

    const term = new Terminal({
      cols,
      rows,
      fontSize: codeFontPx(),
      fontFamily:
        'ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, Consolas, monospace',
      cursorBlink: !readOnly,
      disableStdin: readOnly || hostAway,
      allowProposedApi: true,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const el = document.createElement("div");
    el.className = "term";
    el.onmousedown = () => {
      const pane = panes.indexOf(ptyId);
      if (pane >= 0 && pane !== focused) {
        focused = pane;
        layout();
        reportPresence();
      }
    };
    termsEl.appendChild(el);
    term.open(el);
    term.textarea?.setAttribute("aria-describedby", "term-hint");
    term.textarea?.setAttribute("aria-label", `Terminal ${ptyId}`);

    // A terminal takes every key, Tab and Escape included, so keyboard focus
    // that went in could not come out. F6 is the conventional way between
    // regions: forward to the terminal's controls, Shift+F6 back to the
    // editor.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key !== "F6") return true;
      if (e.type === "keydown") {
        e.preventDefault();
        if (e.shiftKey) workspace.editor.focus();
        else (newBtn.disabled ? splitBtn : newBtn).focus();
      }
      return false;
    });

    term.onData((data) => {
      // The host drops these anyway when terminals are read-only; not
      // sending them just saves the round trip.
      if (readOnly) return;
      conn.send(streamFrame(Channel.Pty, ptyId, textEncoder.encode(data)));
    });

    term.onResize(({ cols, rows }) => {
      // The host's size for everyone is not this window's size. Reported back
      // as ours, it stuck: the smallest guest left and the terminal stayed
      // their size, because everyone else had "agreed" to it.
      if (resizingFromHost) return;
      conn.send(
        jsonFrame(Channel.Pty, TARGET_ALL, {
          t: "resize",
          pty_id: ptyId,
          cols,
          rows,
        } satisfies Pty),
      );
    });

    tabs.set(ptyId, { ptyId, term, fit, el });
    select(ptyId);
  }

  /** Rebuilds the tab strip, including who else is watching each terminal. */
  function drawTabs() {
    for (const b of Array.from(tabsEl.querySelectorAll(".tab"))) b.remove();
    for (const ptyId of [...tabs.keys()].sort((a, b) => a - b)) {
      const others = people
        .filter((p) => p.id !== me && watching.get(p.id) === ptyId)
        .map((p) => p.name);

      const pane = panes.indexOf(ptyId);
      const b = document.createElement("button");
      b.className =
        "tab" + (pane === focused ? " active" : pane >= 0 ? " shown" : "");
      b.dataset.pty = String(ptyId);
      b.textContent = `terminal ${ptyId}`;
      if (others.length) {
        const w = document.createElement("span");
        w.className = "watchers";
        // Read as "terminal 1, also here: bob", not "terminal 1bob".
        const said = document.createElement("span");
        said.className = "visually-hidden";
        said.textContent = ", also here: ";
        b.appendChild(said);
        w.textContent = others.join(", ");
        w.title = `${others.join(", ")} ${others.length === 1 ? "is" : "are"} here`;
        b.appendChild(w);
      }
      b.onclick = () => select(ptyId);
      b.setAttribute("aria-pressed", String(pane === focused));
      tabsEl.appendChild(b);
    }
  }

  /** Tell the host what fits in this window — one size per guest is all it keeps. */
  function reportOwnSize() {
    if (disposed) return;
    for (const id of panes) {
      const dims = id === null ? undefined : tabs.get(id)?.fit.proposeDimensions();
      if (id === null || !dims || !(dims.cols > 0 && dims.rows > 0)) continue;
      conn.send(jsonFrame(Channel.Pty, TARGET_ALL, { t: "resize", pty_id: id, cols: dims.cols, rows: dims.rows } satisfies Pty));
      return;
    }
  }

  /** Set while applying the host's size, which xterm reports like any other. */
  let resizingFromHost = false;
  function resizeFromHost(term: Terminal, cols: number, rows: number) {
    resizingFromHost = true;
    try {
      term.resize(cols, rows);
    } finally {
      resizingFromHost = false;
    }
  }

  function select(ptyId: number) {
    // A terminal already on screen gets focus rather than being duplicated
    // into both panes.
    const existing = panes.indexOf(ptyId);
    if (existing >= 0) focused = existing;
    else panes[focused] = ptyId;
    layout();
    tabs.get(ptyId)?.term.focus();
    reportPresence();
  }

  /** Show whatever the panes point at, and size it to the space it got. */
  function layout() {
    if (disposed) return;
    for (const [id, tab] of tabs) {
      const pane = panes.indexOf(id);
      tab.el.classList.toggle("shown", pane >= 0);
      tab.el.classList.toggle("focused", pane === focused && panes.length > 1);
      tab.el.style.order = String(pane);
    }
    drawTabs();
    // Fitting has to wait for the browser to apply the new widths, or every
    // terminal measures itself against the layout it had a moment ago.
    requestAnimationFrame(() => {
      if (disposed) return;
      for (const id of panes) {
        if (id !== null) tabs.get(id)?.fit.fit();
      }
      workspace.editor.viewer?.layout();
    });
  }

  function toggleSplit() {
    if (panes.length > 1) {
      panes = [panes[focused] ?? panes[0] ?? null];
      focused = 0;
    } else {
      // Open the split on a different terminal if there is one, so the second
      // pane starts out useful rather than showing the same thing twice.
      const other = [...tabs.keys()].find((id) => id !== panes[0]) ?? null;
      panes = [panes[0] ?? null, other];
      focused = other === null ? 0 : 1;
    }
    termsEl.classList.toggle("split", panes.length > 1);
    splitBtn.classList.toggle("on", panes.length > 1);
    splitBtn.setAttribute("aria-pressed", String(panes.length > 1));
    layout();
    reportPresence();
  }

  /**
   * Tell the host where we're looking. It stamps our id and rebroadcasts —
   * the relay has no idea what a participant is, and we would like to keep
   * it that way.
   */
  /**
   * Bind a document to the editor. The host has already sent `opened`; the
   * full state arrives immediately after and lands via applyUpdate.
   */
  async function startEditing(docId: number, path: string) {
    const v = workspace.editor.viewer;
    const version = selection;
    if (!v || v.current !== path || disposed) return;
    const { DocSession } = await import("./editing");
    if (version !== selection || v.current !== path || disposed) return;

    const doc = new DocSession(docId, path, { id: me, name }, (kind, bytes) => {
      if (kind === "update" && (hostAway || connState !== "open")) {
        setUnsent(true);
        if (hostAway) typedAway.add(doc);
      }
      conn.send(
        streamFrame(
          Channel.Doc,
          docId,
          tagged(kind === "update" ? DocKind.Update : DocKind.Awareness, bytes),
        ),
      );
    });
    editing = doc;

    // Anything that arrived while Monaco was loading — including the full
    // initial state — applies now, before the model is built from it.
    let hasState = false;
    for (const [id, kind, body] of earlyDocFrames.splice(0)) {
      if (id !== docId) continue;
      if (kind === DocKind.Update) {
        doc.applyUpdate(body);
        hasState = true;
      } else doc.applyAwareness(body);
    }
    // And if it has not arrived yet, it is on its way: the host sends it
    // straight after `opened`. Building the model before it lands showed an
    // empty file, then the whole text as one insert — which put the view at
    // line 1, every reconnect, wherever the reader had been.
    if (!hasState) {
      await new Promise<void>((resolve) => {
        awaitingState = { docId, resolve };
        setTimeout(resolve, 5000);
      });
      awaitingState = null;
      if (editing !== doc || version !== selection || v.current !== path || disposed) return;
    }

    const resume = reconnectingDocument?.path === path ? reconnectingDocument : null;
    // The model kept the file on screen between the old document going and
    // this one arriving, and took whatever was typed into it meanwhile.
    if (resume && v.handles && v.shownPath === path) resume.local = v.handles.model.getValue();
    if (resume?.local !== undefined && resume.local !== resume.base) {
      // Replay only the local splice made while disconnected onto the host's
      // fresh state. This preserves unrelated host edits better than replacing
      // the entire file with a stale browser copy.
      let prefix = 0;
      const shared = Math.min(resume.base.length, resume.local.length);
      while (prefix < shared && resume.base[prefix] === resume.local[prefix]) prefix++;
      let suffix = 0;
      while (
        suffix < shared - prefix &&
        resume.base[resume.base.length - 1 - suffix] ===
          resume.local[resume.local.length - 1 - suffix]
      ) {
        suffix++;
      }
      const remove = resume.base.length - prefix - suffix;
      const insert = resume.local.slice(prefix, resume.local.length - suffix);
      doc.ydoc.transact(() => {
        const available = Math.max(0, doc.ytext.length - prefix);
        if (remove > 0 && available > 0) doc.ytext.delete(prefix, Math.min(remove, available));
        if (insert) doc.ytext.insert(Math.min(prefix, doc.ytext.length), insert);
      }, "local");
    }
    if (resume) {
      reconnectingDocument = null;
      // Handed back: what was typed while away now goes out with this state.
      if (!hostAway) setUnsent(false);
    }
    fromCopy = null;

    // The model has to exist before the document can drive it.
    const text = doc.ytext.toString();
    v.show(path, text, false, readOnly);
    const handles = v.handles;
    if (!handles) return;
    // Monaco keeps one line ending per model and drops a byte-order mark, so
    // for some files the editor's text is not the document's. Every offset
    // would then be off — an edit made after the BOM landed a character
    // early on disk — so such a file is shown, read-only, and not edited.
    if (handles.model.getValue() !== text) {
      discardDocument(true);
      v.show(path, text, false, true, "read-only: mixed line endings or a byte-order mark");
      return;
    }
    doc.onDrift = () => {
      if (editing !== doc) return;
      const now = doc.ytext.toString();
      discardDocument(true);
      v.show(path, now, false, true, "read-only: its line endings changed — reopen it to edit");
    };
    detach = doc.bind(handles.editor, handles.model);
    // Which file is being edited, not merely shown — for anything outside
    // that needs to tell the two apart, the browser checks among them.
    viewerEl.dataset.editing = path;
    v.setReadOnly(readOnly);
    if (focusSelectedFile) { workspace.editor.focus(); focusSelectedFile = false; }
  }

  /** The stored copy arrives sealed; the key is the one from the link. */
  async function useOfflineCopy(sealed: Uint8Array<ArrayBuffer>) {
    if (!sealer) return;
    const opened = await sealer.openPayload(sealed);
    if (!opened) return;
    let body: SnapshotBody;
    try {
      body = JSON.parse(new TextDecoder().decode(opened));
    } catch {
      return;
    }
    if (!hostAway) return;
    offlineFiles = new Map(body.files.map((f) => [f.path, f.text]));
    // Which ones, roughly: the copy leaves out what it cannot usefully keep.
    const all = tree.count;
    copyNote =
      offlineFiles.size < all
        ? ` ${offlineFiles.size} of ${all} files are still readable from a saved copy — large and binary files aren't kept.`
        : ` All ${all} files are still readable from a saved copy.`;
    paintAway();
    if (fromCopy && workspace.editor.path === fromCopy) showFromCopy(fromCopy);
  }

  function reportPresence() {
    conn.send(
      jsonFrame(Channel.Presence, TARGET_ALL, {
        t: "report",
        active_pty: active(),
      } satisfies Presence),
    );
  }

  function closeTab(ptyId: number) {
    const tab = tabs.get(ptyId);
    if (!tab) return;
    tab.term.dispose();
    tab.el.remove();
    tabs.delete(ptyId);

    // Backfill any pane that was showing it, so a split doesn't collapse to
    // a blank half the moment one side exits.
    const spare = [...tabs.keys()].filter((id) => !panes.includes(id));
    panes = panes.map((id) => (id === ptyId ? spare.shift() ?? null : id));

    if (tabs.size === 0) {
      termsEl.appendChild(emptyEl);
    }
    layout();
    reportPresence();
  }

  function requestTerminal() {
    const { cols, rows } = probeSize();
    conn.send(jsonFrame(Channel.Pty, TARGET_ALL, { t: "open", cols, rows } satisfies Pty));
  }
  newBtn.onclick = requestTerminal;

  workspace.onLayout = () => {
    const px = codeFontPx();
    for (const tab of tabs.values()) {
      if (tab.term.options.fontSize !== px) tab.term.options.fontSize = px;
    }
    layout();
  };
  splitBtn.onclick = toggleSplit;
  function dispose() {
    if (disposed) return;
    ++selection;
    closeDocument();
    disposed = true;
    if (awayTimer) clearInterval(awayTimer);
    awayTimer = null;
    if (waitingTimer) clearTimeout(waitingTimer);
    waitingTimer = null;
    dropParked();
    setUnsent(false);
    tree.dispose();
    workspace.dispose();
    themeEvents.abort();
    for (const tab of tabs.values()) tab.term.dispose();
    tabs.clear();
    pageEvents.abort();
  }

  // Leaving for good ends the session here. Going into the back/forward cache
  // is not leaving: the page may come back exactly as it is, and tearing it
  // down then meant a Back that showed a dead page — and, worse, a socket the
  // dead page still reconnected, so everyone's roster gained a nameless "…".
  const pageEvents = new AbortController();
  window.addEventListener("pagehide", (e) => {
    if (e.persisted) return;
    dispose();
    conn.close();
  }, { signal: pageEvents.signal });
  // Back from the cache: its socket died while it was frozen, whatever it
  // says now. A new one goes as a reconnect, which re-opens the file being
  // edited and has the host name its terminals again.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && !disposed) conn.resume();
  }, { signal: pageEvents.signal });

  /** A screen that ends the session view, with a way back in. */
}

const rejoin = { label: "Rejoin", run: () => location.reload() };
const tryAgain = { label: "Try again", run: () => location.reload() };

/** Why the session ended, in words someone joining would use. */
function ended(reason: string): GateOptions {
  if (/removed by the host/i.test(reason)) {
    return { title: "You were removed from this session", lines: ["If that was a mistake, ask the host to let you back in."], action: rejoin };
  }
  if (/did not come back/i.test(reason)) {
    return {
      title: "The host has been away too long",
      lines: [
        "The relay stopped waiting for them. Their terminals may still be running on their machine.",
        "If their ajar is still running, it takes this link back when their machine reconnects, and you can rejoin then.",
      ],
      action: rejoin,
      tone: "info",
    };
  }
  if (/closed this session/i.test(reason)) {
    return { title: "The host ended the session", lines: ["Every terminal has stopped, and this link no longer works."], tone: "info" };
  }
  return { title: "Session ended", lines: [sentence(reason)], action: rejoin, tone: "info" };
}

/** Why the relay would not let us in, and what to do about it. */
function refused(code: string, message: string): GateOptions {
  switch (code) {
    case "no_such_session":
      return {
        title: "This link isn't open right now",
        lines: ["The host may have closed it, or the link was mistyped. Ask them for a fresh one."],
        action: tryAgain,
      };
    case "locked":
      return {
        title: "This session is locked",
        lines: ["The host has locked it, so nobody new can join. Ask them to press x to unlock it, then try again."],
        action: tryAgain,
      };
    case "rate_limited":
      return {
        title: "Too many connections from your network",
        lines: ["The relay is turning some away for a moment. Try again in a minute."],
        action: tryAgain,
      };
    case "wrong_shape":
      return { title: "This address is a pad, not a session", lines: ["Pads open at their own address, without /j/."] };
    default:
      return { title: "Can't join", lines: [sentence(message)], action: tryAgain };
  }
}

/** The relay's lowercase reasons, as sentences. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * This tab's secret for a session, made once and kept for the tab: a reload
 * is someone already in, coming back. Not shared between tabs, and gone with
 * the tab — a new tab is a new arrival, which a lock is for.
 */
function resumeSecret(session: string): string {
  const key = `ajar.resume.${session}`;
  try {
    const kept = sessionStorage.getItem(key);
    if (kept && /^[0-9a-f]{32}$/.test(kept)) return kept;
  } catch {
    // Storage refused: the secret lives as long as the page.
  }
  const made = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    sessionStorage.setItem(key, made);
  } catch {
    // As above.
  }
  return made;
}

function fileCount(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** The words for each state, as someone joining would put them. */
const STATE_WORDS: Record<ConnState, string> = {
  connecting: "connecting",
  open: "connected",
  reconnecting: "reconnecting",
  closed: "disconnected",
};

/**
 * A passing note: shown for a few seconds, read out once. The region is
 * always in the page — one shown only when there is something to say is
 * often missed by screen readers — and outside the workspace's grid.
 */
function toast(text: string) {
  let region = document.getElementById("toasts");
  if (!region) {
    region = document.createElement("div");
    region.id = "toasts";
    region.className = "toasts";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = text;
  region.appendChild(item);
  setTimeout(() => item.remove(), 5000);
}

/** Refusals worth waiting out, for a page that has been in the session. */
const RETRYABLE = new Set(["no_such_session", "rate_limited"]);

/** A rough size for a brand-new terminal before its element is measured. */
function probeSize(): { cols: number; rows: number } {
  // Only used for the moment between asking for a terminal and measuring the
  // element it lands in; `fit()` corrects it. Derived from the actual font
  // size so a zoomed-in reader does not start with a wildly wrong guess.
  const px = codeFontPx();
  const cell = { w: px * 0.6, h: px * 1.35 };
  const w = Math.max(320, window.innerWidth - 32);
  const h = Math.max(200, window.innerHeight * 0.5);
  return {
    cols: Math.max(20, Math.floor(w / cell.w)),
    rows: Math.max(6, Math.floor(h / cell.h)),
  };
}

/** The terminal in the page's own colours, as the pad's is. */
function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const dark = isDark();
  return {
    background: token("--surface", dark ? "#161a22" : "#ffffff"),
    foreground: token("--ink", dark ? "#e7eaf0" : "#13171e"),
    cursor: token("--accent", dark ? "#8ca6ff" : "#2447c9"),
  };
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

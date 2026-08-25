import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { Connection, ConnState } from "./connection";
import { FileTree } from "./tree";
import type { Viewer } from "./viewer";
import type { DocSession } from "./editing";
import type { Sealer } from "./sealed";
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
} from "./proto";

const app = document.getElementById("app")!;

/** `/j/quiet-ember-4417` → `quiet-ember-4417` */
function sessionFromPath(): string | null {
  const m = location.pathname.match(/^\/j\/([a-z0-9-]+)\/?$/i);
  return m ? m[1] : null;
}

const session = sessionFromPath();
if (!session) {
  renderLanding();
} else {
  renderJoin(session);
}

// ------------------------------------------------------------ landing page

function renderLanding() {
  app.innerHTML = `
    <div class="landing">
      <header class="landing-head">
        <h1>ajar</h1>
        <p class="tagline">Leave a machine open to someone.</p>
      </header>

      <p class="lede">
        One command turns a folder on your machine into a live workspace —
        real terminals, the real toolchain, your actual files. Whoever you
        send the link to opens it and starts working. Nothing to install on
        their side, no account, no port forwarding.
      </p>

      <div class="install">
        <code id="install-cmd">curl -sSf https://ajar.sh/install.sh | sh</code>
        <button id="copy" title="Copy">copy</button>
      </div>

      <ol class="steps">
        <li><code>ajar ~/projects/api</code> — it prints a link and keeps running</li>
        <li>Send the link. They type a name and they're in.</li>
        <li>Press <kbd>q</kbd>. Every terminal ends and the link stops working.</li>
      </ol>

      <section class="danger">
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
          <li>Nothing is persisted — close the session and it's gone</li>
          <li>macOS and Linux. Windows works through WSL2, untested</li>
        </ul>
      </section>

      <footer class="landing-foot">
        Already have a link? It looks like <code>/j/quiet-ember-4417</code>.
      </footer>
    </div>`;

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
    <div class="centered">
      <h1>ajar</h1>
      <p class="muted">Joining <code>${session}</code></p>
      <form id="join">
        <input id="name" placeholder="Your name" autocomplete="off" maxlength="32" required />
        <button type="submit">Join</button>
      </form>
      <p class="notice">
        You'll get a shell on someone else's machine. Everything you run there
        runs as them, in the folder they shared.
      </p>
    </div>`;

  const form = document.getElementById("join") as HTMLFormElement;
  const input = document.getElementById("name") as HTMLInputElement;
  input.value = localStorage.getItem("ajar.name") ?? "";
  input.focus();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    localStorage.setItem("ajar.name", name);
    renderSession(session, name, await sealerReady);
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
  app.innerHTML = `
    <div class="shell">
      <header>
        <span class="dot" id="dot"></span>
        <strong id="workspace">${session}</strong>
        <span class="status" id="status">connecting</span>
        <span class="badge" id="locked" hidden>locked</span>
        <span class="badge" id="readonly" hidden>read-only</span>
        <span class="spacer"></span>
        <span class="people" id="people"></span>
      </header>
      <div class="away" id="away" hidden></div>
      <div class="body">
        <aside id="sidebar">
          <div class="side-head"><span id="filecount">…</span></div>
          <div id="tree"></div>
        </aside>
        <div class="main">
          <section class="viewer" id="viewer-pane" hidden>
            <div class="viewer-head">
              <span id="viewer-title"></span>
              <button class="close-file" id="close-file" title="Close file">×</button>
            </div>
            <div class="viewer-body" id="viewer"></div>
          </section>
          <section class="terminals">
            <nav class="tabs" id="tabs">
              <button class="new" id="new-terminal" title="New terminal">+</button>
              <span class="tabs-spacer"></span>
              <button class="split" id="split" title="Split — two terminals side by side">◫</button>
            </nav>
            <div class="terms" id="terms">
              <div class="empty" id="empty">No terminals yet — press <kbd>+</kbd> to open one.</div>
            </div>
          </section>
        </div>
      </div>
    </div>`;

  const statusEl = document.getElementById("status")!;
  const dotEl = document.getElementById("dot")!;
  const peopleEl = document.getElementById("people")!;
  const tabsEl = document.getElementById("tabs")!;
  const termsEl = document.getElementById("terms")!;
  const emptyEl = document.getElementById("empty")!;
  const newBtn = document.getElementById("new-terminal") as HTMLButtonElement;
  const splitBtn = document.getElementById("split") as HTMLButtonElement;

  const awayEl = document.getElementById("away")!;
  const lockedEl = document.getElementById("locked") as HTMLElement;
  const readOnlyEl = document.getElementById("readonly") as HTMLElement;
  /** Set by the host. Enforced there too — this only stops us wasting bytes. */
  let readOnly = false;
  /**
   * Files from the copy the relay keeps, used while the host is away.
   *
   * Read-only on purpose: the host is authoritative whenever it is online,
   * and a store nobody can write to can never disagree with it.
   */
  let offlineFiles: Map<string, string> | null = null;
  const fileCountEl = document.getElementById("filecount")!;
  const viewerPane = document.getElementById("viewer-pane") as HTMLElement;

  // Monaco is several megabytes. A session where nobody opens a file — or a
  // visitor who never leaves the landing page — should not pay for it, so it
  // arrives on first use.
  let viewer: Viewer | null = null;
  async function ensureViewer(): Promise<Viewer> {
    if (!viewer) {
      const { Viewer } = await import("./viewer");
      viewer = new Viewer(
        document.getElementById("viewer")!,
        document.getElementById("viewer-title")!,
      );
    }
    return viewer;
  }

  /** The file currently open for editing, if any. */
  let editing: DocSession | null = null;
  let detach: (() => void) | null = null;
  /**
   * Document bytes that arrived before the editor was ready.
   *
   * The host sends a document's full state immediately after `opened`, but
   * binding it means loading Monaco and the editing module first. Without
   * this the initial state lands in the gap and the file opens empty.
   */
  const earlyDocFrames: Array<[number, DocKind, Uint8Array]> = [];

  function closeDocument() {
    earlyDocFrames.length = 0;
    if (!editing) return;
    conn.send(jsonFrame(Channel.Doc, TARGET_ALL, { t: "close", doc_id: editing.docId } satisfies Doc));
    detach?.();
    editing.destroy();
    editing = null;
    detach = null;
  }

  const tree = new FileTree(document.getElementById("tree")!, async (path) => {
    viewerPane.hidden = false;
    tree.setActive(path);
    closeDocument();
    // Load the editor before asking for content, so the reply can never
    // arrive before there is somewhere to put it.
    const v = await ensureViewer();
    v.opening(path);
    // With the host away, the saved copy is all there is — and it is
    // read-only, because nothing can be written back to a host that is gone.
    const offline = offlineFiles?.get(path);
    if (offline !== undefined) {
      v.show(path, offline, false, true);
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

  (document.getElementById("close-file") as HTMLButtonElement).onclick = () => {
    closeDocument();
    viewerPane.hidden = true;
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

  const conn = new Connection({
    session,
    name,
    sealer,
    onState: setState,
    onFrame: onFrame,
  });

  function setState(s: ConnState, detail?: string) {
    statusEl.textContent = detail ? `${s} · ${detail}` : s;
    dotEl.className = `dot ${s}`;
    newBtn.disabled = s !== "open";
  }

  function drawPeople() {
    peopleEl.innerHTML = people
      .map(
        (p) =>
          `<span class="person${p.role === "host" ? " host" : ""}${
            p.id === me ? " me" : ""
          }">${escapeHtml(p.name)}${p.role === "host" ? " · host" : ""}</span>`,
      )
      .join("");
  }

  function onFrame(f: Frame) {
    if (f.channel === Channel.Control) {
      const msg = parseJson<Control>(f);
      switch (msg.t) {
        case "welcome":
          me = msg.participant_id;
          // The relay has no idea who we are. Say so on the encrypted
          // channel; the host answers with a roster.
          conn.send(
            jsonFrame(Channel.Presence, TARGET_ALL, { t: "iam", name } satisfies Presence),
          );
          break;
        case "joined":
          // A roster follows once they have introduced themselves.
          break;
        case "left":
          watching.delete(msg.participant_id);
          drawTabs();
          break;
        case "host_away":
          // Terminals stay alive on the host the whole time; this is only
          // the socket between us and them.
          awayEl.hidden = false;
          awayEl.textContent = `The host's connection dropped. Holding this session for ${msg.grace_secs}s — terminals are still running.`;
          // Fall back to the copy the relay keeps, so the folder does not
          // simply go dead while we wait.
          conn.send(jsonFrame(Channel.Store, TARGET_ALL, { t: "fetch" } satisfies Store));
          break;
        case "host_back":
          awayEl.hidden = true;
          offlineFiles = null;
          break;
        case "locked":
          lockedEl.hidden = !msg.locked;
          break;
        case "closed":
          closeDocument();
          conn.close();
          app.innerHTML = `
            <div class="centered">
              <h1>Session ended</h1>
              <p class="muted">${escapeHtml(msg.reason)}</p>
            </div>`;
          break;
        case "error":
          app.innerHTML = `
            <div class="centered">
              <h1>Can't join</h1>
              <p class="muted">${escapeHtml(msg.message)}</p>
            </div>`;
          conn.close();
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
        openTab(msg.pty_id, msg.cols, msg.rows);
      } else if (msg.t === "closed") {
        closeTab(msg.pty_id);
      } else if (msg.t === "resize") {
        const tab = tabs.get(msg.pty_id);
        tab?.term.resize(msg.cols, msg.rows);
      } else if (msg.t === "read_only") {
        readOnly = msg.read_only;
        readOnlyEl.hidden = !readOnly;
        for (const tab of tabs.values()) tab.term.options.cursorBlink = !readOnly;
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
        drawPeople();
        drawTabs();
      }
      return;
    }

    if (f.channel === Channel.Doc) {
      if (f.streamId === 0) {
        const msg = parseJson<Doc>(f);
        if (msg.t === "opened") void startEditing(msg.doc_id, msg.path);
        else if (msg.t === "error") {
          // Not editable — binary, or too large. Show it read-only and say
          // why rather than silently doing nothing.
          viewer?.problem(msg.path, msg.message);
          conn.send(jsonFrame(Channel.Fs, TARGET_ALL, { t: "read", path: msg.path } satisfies Fs));
        }
        return;
      }
      const split = untag(f.payload);
      if (!split) return;
      const [kind, body] = split;
      if (editing && editing.docId === f.streamId) {
        if (kind === DocKind.Update) editing.applyUpdate(body);
        else editing.applyAwareness(body);
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
          awayEl.textContent += " No offline copy was kept, so files are unavailable until they return.";
        }
      }
      return;
    }

    if (f.channel === Channel.Fs) {
      const msg = parseJson<Fs>(f);
      switch (msg.t) {
        case "tree":
          tree.setEntries(msg.entries);
          fileCountEl.textContent = `${tree.count} files`;
          break;
        case "patch":
          tree.applyPatch(msg.added, msg.changed, msg.removed);
          fileCountEl.textContent = `${tree.count} files`;
          break;
        case "content":
          if (msg.binary) viewer?.problem(msg.path, "binary file");
          else viewer?.show(msg.path, msg.text, msg.truncated);
          break;
        case "read_error":
          viewer?.problem(msg.path, msg.message);
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
      existing.term.resize(cols, rows);
      return;
    }
    emptyEl.remove();

    const term = new Terminal({
      cols,
      rows,
      fontSize: 13,
      fontFamily:
        'ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
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

    term.onData((data) => {
      // The host drops these anyway when terminals are read-only; not
      // sending them just saves the round trip.
      if (readOnly) return;
      conn.send(streamFrame(Channel.Pty, ptyId, textEncoder.encode(data)));
    });

    term.onResize(({ cols, rows }) => {
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
        w.textContent = others.join(", ");
        w.title = `${others.join(", ")} ${others.length === 1 ? "is" : "are"} here`;
        b.appendChild(w);
      }
      b.onclick = () => select(ptyId);
      tabsEl.insertBefore(b, newBtn);
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
      for (const id of panes) {
        if (id !== null) tabs.get(id)?.fit.fit();
      }
      viewer?.layout();
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
    const v = await ensureViewer();
    if (v.current !== path) return; // navigated away while we were loading
    const { DocSession } = await import("./editing");

    const doc = new DocSession(docId, path, { id: me, name }, (kind, bytes) => {
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
    for (const [id, kind, body] of earlyDocFrames.splice(0)) {
      if (id !== docId) continue;
      if (kind === DocKind.Update) doc.applyUpdate(body);
      else doc.applyAwareness(body);
    }

    // The model has to exist before the document can drive it.
    v.show(path, doc.ytext.toString(), false, false);
    const handles = v.handles;
    if (!handles) return;
    detach = doc.bind(handles.editor, handles.model);
    v.setReadOnly(false);
  }

  /** The stored copy arrives sealed; the key is the one from the link. */
  async function useOfflineCopy(sealed: Uint8Array<ArrayBuffer>) {
    if (!sealer) return;
    const opened = await sealer.open({
      channel: Channel.Fs, // any sealed channel; only the payload matters
      streamId: 0,
      target: 0,
      payload: sealed,
    });
    if (!opened) return;
    let body: SnapshotBody;
    try {
      body = JSON.parse(new TextDecoder().decode(opened.payload));
    } catch {
      return;
    }
    offlineFiles = new Map(body.files.map((f) => [f.path, f.text]));
    awayEl.textContent += ` ${offlineFiles.size} files are still readable from a saved copy.`;
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

  newBtn.onclick = () => {
    const { cols, rows } = probeSize();
    conn.send(jsonFrame(Channel.Pty, TARGET_ALL, { t: "open", cols, rows } satisfies Pty));
  };

  splitBtn.onclick = toggleSplit;
  window.addEventListener("resize", layout);
}

/** A rough size for a brand-new terminal before its element is measured. */
function probeSize(): { cols: number; rows: number } {
  const w = Math.max(320, window.innerWidth - 32);
  const h = Math.max(200, window.innerHeight - 120);
  return { cols: Math.max(20, Math.floor(w / 8)), rows: Math.max(6, Math.floor(h / 18)) };
}

function terminalTheme() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return dark
    ? { background: "#12151b", foreground: "#e7eaf0", cursor: "#8ca6ff" }
    : { background: "#ffffff", foreground: "#13171e", cursor: "#2447c9" };
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

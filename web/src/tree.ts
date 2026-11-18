import { imageType } from "@ajar/workspace-ui/images";
import { canDrop, folderOf, nameProblem, pathFor, type Taken } from "@ajar/workspace-ui/names";
import { TREE_ICONS } from "@ajar/workspace-ui/tree-icons";

import type { Entry } from "./proto";

/**
 * The shared folder, as a collapsible tree.
 *
 * Windowed from the start. A source tree with the ignore rules applied is
 * usually a few thousand entries, but "usually" is not a guarantee, and a
 * tree that dies at ten thousand nodes will die during the first real demo.
 *
 * Drawn as the pad draws its own since 19 November — an icon for a file and
 * a folder, a bar of buttons above, each row's own at its end — and able to
 * do what the pad's can where the host's `ajar` can do it for a guest: make a
 * file or a folder, its name typed into the tree where it will be; rename
 * one, or drag it somewhere else; delete one; take files dropped on it.
 * The pad's tree is a list of buttons drawn whole each time, which a pad's
 * few hundred files allow; this one stays an ARIA tree with one stop, and
 * paints only the rows on screen.
 */

/**
 * Read from CSS rather than declared here.
 *
 * The row height lives in `--tree-row` and drives both the stylesheet and the
 * scroll maths below. Written twice — once as `height: 22px`, once as a
 * constant here — the two drift the moment either is touched, and rows either
 * overlap or leave gaps with nothing obviously wrong in either file.
 *
 * It is also in rem, so a reader with a larger default font gets taller rows
 * and the virtualisation still lands on them.
 */
function rowHeight(el: HTMLElement): number {
  const declared = getComputedStyle(el).getPropertyValue("--tree-row").trim();
  if (declared.endsWith("rem")) {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return parseFloat(declared) * (root || 16);
  }
  return parseFloat(declared) || 22;
}

const OVERSCAN = 8;

/** What a row being dragged carries, so a drag from anywhere else is not mistaken for one. */
const DRAG = "application/x-ajar-path";

/** The row a name is being typed in: not a path, so no path can be it. */
const NAMING_KEY = "\u0000naming";

export interface TreeEvents {
  onOpen: (path: string) => void;
  /** A file as itself, a folder as a zip; "" is everything. */
  onDownload: (path: string) => void;
  /**
   * Whether the host's `ajar` can make, move and delete things for a guest at
   * all. Where it cannot — an older one — none of that is offered.
   */
  offered: () => boolean;
  /** Whether it would now: not while the session is read-only, or the host away. */
  writable: () => boolean;
  /** Why not, for the buttons that are there and off. */
  whyNot: () => string;
  /** A file or a folder to make, its name typed and checked: the whole path. */
  onCreate: (path: string, dir: boolean, open: boolean) => void;
  /** To a new path: dropped on a folder, or renamed. `to` is the whole new path. */
  onMove: (from: string, dir: boolean, to: string) => void;
  onDelete: (path: string, dir: boolean) => void;
  /** Files into `folder`: the ones dropped on it, or with none, ones to be picked. */
  onUpload: (folder: string, files: File[] | null) => void;
}

interface Node {
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  children: Node[];
}

interface Row {
  /** What the row is, among the rows: its path, or the naming row's own key. */
  key: string;
  node: Node;
  expanded: boolean;
  /** The line under an open folder with nothing in it, saying so. */
  empty?: boolean;
  /** Where a name is being typed. */
  naming?: boolean;
}

/** A name being typed in the tree. */
interface Naming {
  dir: boolean;
  /** The folder it is typed in; "" is the top. */
  folder: string;
  /** What is being renamed, or null for something new. */
  from: string | null;
  input: HTMLInputElement;
  problem: HTMLElement;
  /** Taken away when the naming ends. */
  done: AbortController;
}

export class FileTree {
  private entries = new Map<string, Entry>();
  private expanded = new Set<string>();
  private rows: Row[] = [];
  private active: string | null = null;
  /**
   * The one row Tab lands on: the tree is a single stop, moved through with
   * the arrow keys. Every row used to be its own stop, and once Tab reached
   * the end of the painted window the repaint dropped focus to the page — a
   * long tree could not be reached past its first screenful by keyboard.
   */
  private focusPath: string | null = null;
  private bar: HTMLDivElement;
  private viewport: HTMLDivElement;
  private spacer: HTMLDivElement;
  private surface: HTMLDivElement;
  private rowPx = 22;
  private readonly events = new AbortController();
  private readonly observer: ResizeObserver;
  /** The name being typed, kept across repaints: the tree repaints whenever a file changes. */
  private naming: Naming | null = null;
  /** The row being dragged, while it is. */
  private dragging: { path: string; folder: boolean } | null = null;
  /** A row's menu, while it is open. */
  private menu: HTMLElement | null = null;
  /** What the rows were last drawn able to do, so a change redraws them. */
  private drawn = "";

  constructor(
    private host: HTMLElement,
    private handlers: TreeEvents,
  ) {
    this.host.classList.add("tree");
    this.bar = document.createElement("div");
    this.bar.className = "tree-bar";
    this.viewport = document.createElement("div");
    this.viewport.className = "tree-viewport";
    this.spacer = document.createElement("div");
    this.spacer.className = "tree-spacer";
    this.surface = document.createElement("div");
    this.surface.className = "tree-surface";
    this.spacer.appendChild(this.surface);
    this.viewport.appendChild(this.spacer);
    this.host.append(this.bar, this.viewport);
    this.viewport.setAttribute("role", "tree");
    this.viewport.setAttribute("aria-label", "Files");
    const signal = this.events.signal;
    this.viewport.addEventListener("keydown", (e) => this.key(e), { signal });
    // Tab reached the tree while its focus row is scrolled out of the
    // window: bring the row into view and give it the focus.
    this.viewport.addEventListener("focus", () => {
      if (document.activeElement === this.viewport) this.focusRow(this.focusIndex());
    }, { signal });
    // Whatever row has the focus is the tree's stop, however it came by it —
    // a click, the arrows, or a screen reader putting its cursor there: the
    // keys act on the row the person is on, never on one they left.
    this.viewport.addEventListener("focusin", (e) => {
      const path = (e.target as Element | null)?.closest<HTMLElement>(".tree-row[data-path]")?.dataset.path;
      if (path === undefined || path === this.focusPath || this.painting) return;
      this.focusPath = path;
      this.onFocusMove();
      this.paintBar();
      this.paint();
    }, { signal });
    this.viewport.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element | null)?.closest<HTMLElement>(".tree-row[data-path]");
      if (!row || row.classList.contains("empty-folder")) return;
      e.preventDefault();
      this.showMenu(row.dataset.path!, e.clientX, e.clientY);
    }, { signal });
    this.acceptDrags();

    this.rowPx = rowHeight(this.host);
    this.viewport.addEventListener("scroll", () => this.paint(), { passive: true, signal });
    // Zoom and font-size changes both land here. Re-reading the row height is
    // cheap and keeps the scroll maths matching what is actually rendered.
    window.addEventListener("resize", () => {
      this.rowPx = rowHeight(this.host);
      this.rebuild();
    }, { signal });
    document.addEventListener("pointerdown", (e) => {
      if (this.menu && !this.menu.contains(e.target as Element)) this.closeMenu();
    }, { signal });
    this.observer = new ResizeObserver(() => this.paint());
    this.observer.observe(this.viewport);
    this.paintBar();
  }

  dispose() {
    this.stopNaming();
    this.closeMenu();
    this.events.abort();
    this.observer.disconnect();
  }

  private seeded = false;

  /**
   * Replace the whole tree. Arrives on join, and again whenever the host
   * gives up describing a burst of change.
   *
   * Expanded state is preserved deliberately: a dependency install triggers
   * several of these in a row, and a tree that collapsed each time would be
   * unusable during exactly the moment you're watching it.
   */
  setEntries(entries: Entry[]) {
    this.entries = new Map(entries.map((e) => [e.path, e]));
    if (!this.seeded) {
      // Top-level directories start open; anything deeper stays closed, or a
      // large project buries the interesting files under scrolling.
      for (const e of entries) {
        if (e.kind === "dir" && !e.path.includes("/")) this.expanded.add(e.path);
      }
      this.seeded = true;
    }
    this.rebuild();
  }

  applyPatch(added: Entry[], changed: Entry[], removed: string[]) {
    for (const e of [...added, ...changed]) this.entries.set(e.path, e);
    for (const p of removed) {
      this.entries.delete(p);
      this.expanded.delete(p);
    }
    this.rebuild();
  }

  setActive(path: string | null) {
    this.active = path;
    if (path) this.focusPath = path;
    // Open every directory on the way to the active file.
    if (path) this.reveal(path);
    this.rebuild();
  }

  /** Every folder on the way to `path`, opened. */
  private reveal(path: string) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join("/"));
  }

  /** The folder the tree's stop is on, if it is on one. */
  get focusedFolder(): string | null {
    // Nothing chosen yet means nothing chosen: the stop falls back to the
    // first row, which is a folder whenever there is one, and Download all
    // on a fresh page downloaded that folder alone.
    if (this.focusPath === null) return null;
    const row = this.rows[this.focusIndex()];
    return row?.node.dir && row.node.path === this.focusPath ? row.node.path : null;
  }

  /** Called when the tree's stop moves, for anything that depends on it. */
  onFocusMove: () => void = () => {};

  /** Files, not counting the folders they are in. */
  get count(): number {
    let files = 0;
    for (const e of this.entries.values()) if (e.kind === "file") files++;
    return files;
  }

  /** Every file's path, and every folder's: for a search by name, and for where a search can be kept to. */
  get paths(): { files: string[]; folders: string[] } {
    const files: string[] = [];
    const folders: string[] = [];
    for (const e of this.entries.values()) (e.kind === "file" ? files : folders).push(e.path);
    return { files, folders };
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** What `path` is in the folder, if anything. */
  kindOf(path: string): "file" | "dir" | null {
    return this.entries.get(path)?.kind ?? null;
  }

  /** What the host can do for a guest, or whether it will, changed: the bar and the rows' buttons follow. */
  refresh() {
    this.paintBar();
    if (this.naming && !this.handlers.writable()) this.stopNaming();
    this.rebuild();
  }

  // ------------------------------------------------------------------ the bar

  private iconButton(icon: keyof typeof TREE_ICONS, label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = TREE_ICONS[icon];
    b.onclick = onClick;
    return b;
  }

  /**
   * The buttons over the rows: what makes things at the start, what goes in
   * and out whole at the end, as the pad's bar has them. Making and uploading
   * are there only where the host's `ajar` can do them, and off — saying why
   * — while it will not.
   */
  private paintBar() {
    const had = document.activeElement instanceof HTMLElement && this.bar.contains(document.activeElement) ? document.activeElement.getAttribute("aria-label") : null;
    this.bar.replaceChildren();
    const offered = this.handlers.offered();
    const writable = this.handlers.writable();
    const off = (b: HTMLButtonElement) => {
      if (writable) return b;
      b.disabled = true;
      b.title = `${b.title} — ${this.handlers.whyNot()}`;
      return b;
    };
    if (offered) {
      this.bar.append(
        off(this.iconButton("newFile", "New file", () => this.create(false))),
        off(this.iconButton("newFolder", "New folder", () => this.create(true))),
      );
    }
    const whole = document.createElement("span");
    whole.className = "tree-bar-end";
    if (offered) whole.append(off(this.iconButton("upload", "Upload files", () => this.handlers.onUpload(this.target(), null))));
    const folder = this.focusedFolder;
    const download = this.iconButton("download", folder ? `Download ${folder} as a zip` : "Download the whole workspace as a zip", () => this.handlers.onDownload(this.focusedFolder ?? ""));
    download.classList.add("download");
    download.dataset.what = folder ?? "";
    whole.append(download);
    this.bar.append(whole);
    if (had) [...this.bar.querySelectorAll<HTMLElement>("button")].find((b) => b.getAttribute("aria-label") === had)?.focus();
  }

  // ---------------------------------------------------------------- names

  /** Where something new goes: the folder the stop is on, else beside the file it is on, else beside the open file. */
  private target(): string {
    const row = this.focusPath === null ? null : this.rows[this.focusIndex()];
    if (row && row.node.path === this.focusPath) return row.node.dir ? row.node.path : folderOf(row.node.path);
    return this.active ? folderOf(this.active) : "";
  }

  private taken(): Taken {
    const files = new Set<string>();
    const folders = new Set<string>();
    for (const e of this.entries.values()) (e.kind === "file" ? files : folders).add(e.path);
    return { files, folders };
  }

  /**
   * Start typing a new file's or folder's name, in a row where it will be:
   * the folder the tree is on, or beside the open file. That folder opens, so
   * the row can be seen there.
   */
  create(dir: boolean, folder = this.target()) {
    if (!this.handlers.writable()) return;
    this.settle();
    if (folder) {
      this.reveal(`${folder}/x`);
    }
    this.startNaming(dir, folder, null, "");
  }

  /** A row turned into its name, the part before the extension selected to type over. */
  rename(path: string) {
    const entry = this.entries.get(path);
    if (!entry || !this.handlers.writable()) return;
    this.settle();
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    const dir = entry.kind === "dir";
    this.startNaming(dir, folderOf(path), path, leaf);
    const dot = leaf.lastIndexOf(".");
    this.naming?.input.setSelectionRange(0, !dir && dot > 0 ? dot : leaf.length);
  }

  private startNaming(dir: boolean, folder: string, from: string | null, value: string) {
    const done = new AbortController();
    const signal = done.signal;
    const input = document.createElement("input");
    input.className = "name-input";
    input.value = value;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("aria-label", from ? `New name for ${from}` : `Name of the new ${dir ? "folder" : "file"}${folder ? ` in ${folder}` : ""}`);
    const problem = document.createElement("div");
    problem.className = "name-problem";
    problem.id = "name-problem";
    problem.setAttribute("aria-live", "polite");
    problem.hidden = true;
    input.setAttribute("aria-describedby", problem.id);
    input.addEventListener("input", () => this.showProblem(), { signal });
    input.addEventListener("keydown", (e) => {
      // Its own: not Escape to the drawer it is in, nor the tree's arrows.
      e.stopPropagation();
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      this.finish(e.key === "Enter");
    }, { signal });
    // Clicking elsewhere keeps a name that will do, as an editor's explorer
    // does. Not until the click is over: the repaint that ends the naming
    // would otherwise take the row being clicked out from under it.
    let pressed = false;
    addEventListener("pointerdown", (e) => {
      if (e.target !== input) pressed = true;
    }, { capture: true, signal });
    const away = () => setTimeout(() => {
      pressed = false;
      if (this.naming?.input === input && document.activeElement !== input) this.finish(true, true);
    });
    addEventListener("pointerup", () => pressed && away(), { capture: true, signal });
    input.addEventListener("blur", () => {
      if (!this.painting && !pressed) away();
    }, { signal });
    this.naming = { dir, folder, from, input, problem, done };
    this.rebuild();
    const at = this.rows.findIndex((r) => r.naming);
    if (at < 0) return this.stopNaming();
    this.scrollTo(at);
    this.paint();
    input.focus({ preventScroll: true });
  }

  /** Where the typed name stands, and why it will not do. */
  private checked(): { path: string; problem: string | null } | null {
    const n = this.naming;
    if (!n) return null;
    const typed = n.input.value.trim();
    if (!typed) return { path: "", problem: null };
    const path = pathFor(typed, n.folder);
    const from = n.from === null ? null : { path: n.from, folder: n.dir };
    return { path, problem: nameProblem(path, this.taken(), from, "this folder") };
  }

  private showProblem() {
    const n = this.naming;
    const problem = this.checked()?.problem ?? null;
    if (!n) return;
    n.problem.textContent = problem ?? "";
    n.problem.hidden = problem === null;
    n.input.toggleAttribute("aria-invalid", problem !== null);
  }

  /**
   * Enter makes it; Escape, or an empty name, makes nothing. A name that will
   * not do stays to be put right — unless the naming was left by clicking
   * elsewhere, when it goes.
   */
  private finish(keep: boolean, left = false) {
    const n = this.naming;
    const result = this.checked();
    if (!n || !result) return;
    if (keep && result.path && result.problem) {
      if (!left) return this.showProblem();
      keep = false;
    }
    this.stopNaming();
    if (keep && result.path) this.reveal(result.path);
    this.rebuild();
    if (keep && result.path) {
      if (n.from !== null) {
        if (result.path !== n.from) this.handlers.onMove(n.from, n.dir, result.path);
      } else this.handlers.onCreate(result.path, n.dir, !left);
    }
    // Back to the tree's stop, so the keyboard carries on from there.
    if (!left) this.focusRow(this.focusIndex());
  }

  /** A name half typed when another is started is kept if it will do. */
  private settle() {
    if (this.naming) this.finish(true, true);
  }

  private stopNaming() {
    this.naming?.done.abort();
    this.naming = null;
  }

  // ------------------------------------------------------------- a row's menu

  private closeMenu(restore = false) {
    this.menu?.remove();
    this.menu = null;
    if (restore) this.focusRow(this.focusIndex());
  }

  /**
   * What can be done with a row, for a right click and for the keyboard
   * (Shift+F10, or the menu key): the row's buttons are a pointer's, since
   * the tree is one stop.
   */
  private showMenu(path: string, x?: number, y?: number) {
    this.closeMenu();
    const entry = this.entries.get(path);
    if (!entry) return;
    this.focusPath = path;
    this.onFocusMove();
    this.paintBar();
    const dir = entry.kind === "dir";
    const menu = document.createElement("div");
    menu.className = "editor-context-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", path);
    const action = (label: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("role", "menuitem");
      b.onclick = () => {
        this.closeMenu();
        run();
      };
      menu.append(b);
    };
    if (!dir) action("Open", () => this.handlers.onOpen(path));
    if (this.handlers.offered() && this.handlers.writable()) {
      action("New file here", () => this.create(false, dir ? path : folderOf(path)));
      action("New folder here", () => this.create(true, dir ? path : folderOf(path)));
      action("Rename (F2)", () => this.rename(path));
    }
    action(dir ? "Download as a zip" : "Download", () => this.handlers.onDownload(path));
    if (this.handlers.offered() && this.handlers.writable()) action("Delete", () => this.handlers.onDelete(path, dir));
    const row = this.surface.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x ?? (row?.left ?? 0) + 24, innerWidth - 225))}px`;
    menu.style.top = `${Math.max(4, Math.min(y ?? row?.bottom ?? 0, innerHeight - 260))}px`;
    document.body.append(menu);
    this.menu = menu;
    (menu.firstElementChild as HTMLElement | null)?.focus();
    menu.onkeydown = (e) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        return this.closeMenu(true);
      }
      const items = [...menu.querySelectorAll<HTMLElement>("button")];
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        items[e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
  }

  // ------------------------------------------------------------- dragging

  /**
   * Drag and drop within the tree, as in an editor's file explorer: onto a
   * folder puts it inside, onto a file puts it beside that file, onto empty
   * space puts it at the top. And files dragged in from the desktop are
   * uploaded where they are dropped. One set of listeners on the viewport
   * rather than on every row: rows come and go as the tree scrolls.
   */
  private acceptDrags() {
    const signal = this.events.signal;
    const targetOf = (e: DragEvent): string => {
      const row = (e.target as Element | null)?.closest<HTMLElement>(".tree-row[data-path]");
      if (!row) return "";
      const path = row.dataset.path!.replace(/\/$/, "");
      return this.entries.get(path)?.kind === "dir" ? path : folderOf(path);
    };
    const mark = (folder: string | null) => {
      for (const el of this.surface.querySelectorAll(".drop-into")) el.classList.remove("drop-into");
      this.viewport.classList.toggle("drop-into", folder === "");
      if (folder) this.surface.querySelector(`.tree-row[data-path="${CSS.escape(folder)}"]`)?.classList.add("drop-into");
    };
    const files = (e: DragEvent) => !this.dragging && (e.dataTransfer?.types.includes("Files") ?? false);
    this.viewport.addEventListener("dragstart", (e) => {
      const row = (e.target as Element | null)?.closest<HTMLElement>(".tree-row[data-path]");
      const entry = row ? this.entries.get(row.dataset.path!) : undefined;
      if (!row || !entry || !e.dataTransfer || !this.handlers.writable()) return void e.preventDefault();
      this.dragging = { path: entry.path, folder: entry.kind === "dir" };
      e.dataTransfer.setData(DRAG, entry.path);
      e.dataTransfer.setData("text/plain", entry.path);
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    }, { signal });
    this.viewport.addEventListener("dragend", () => {
      this.dragging = null;
      mark(null);
      for (const el of this.surface.querySelectorAll(".dragging")) el.classList.remove("dragging");
    }, { signal });
    this.viewport.addEventListener("dragover", (e) => {
      if (!this.handlers.offered() || !this.handlers.writable()) return;
      const folder = targetOf(e);
      if (files(e)) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "copy";
        return mark(folder);
      }
      if (!this.dragging || !e.dataTransfer?.types.includes(DRAG)) return;
      if (!canDrop(this.dragging, folder)) return mark(null);
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      mark(folder);
    }, { signal });
    this.viewport.addEventListener("dragleave", (e) => {
      if (!(e.relatedTarget instanceof Element && this.viewport.contains(e.relatedTarget))) mark(null);
    }, { signal });
    this.viewport.addEventListener("drop", (e) => {
      if (!this.handlers.offered() || !this.handlers.writable()) return;
      const folder = targetOf(e);
      if (files(e)) {
        e.preventDefault();
        mark(null);
        const dropped = [...(e.dataTransfer?.files ?? [])];
        if (dropped.length) this.handlers.onUpload(folder, dropped);
        return;
      }
      const what = this.dragging;
      if (!what || !e.dataTransfer?.types.includes(DRAG)) return;
      e.preventDefault();
      mark(null);
      if (!canDrop(what, folder)) return;
      const leaf = what.path.split("/").pop()!;
      this.handlers.onMove(what.path, what.folder, folder ? `${folder}/${leaf}` : leaf);
    }, { signal });
  }

  // ------------------------------------------------------------- internals

  /** Flat paths → a real hierarchy, so directories can sort before files. */
  private rebuild() {
    const roots: Node[] = [];
    const byPath = new Map<string, Node>();

    for (const entry of this.entries.values()) {
      const parts = entry.path.split("/");
      const node: Node = {
        path: entry.path,
        name: parts[parts.length - 1],
        dir: entry.kind === "dir",
        depth: parts.length - 1,
        children: [],
      };
      byPath.set(entry.path, node);
    }

    for (const node of byPath.values()) {
      const slash = node.path.lastIndexOf("/");
      const parent = slash === -1 ? null : byPath.get(node.path.slice(0, slash));
      if (parent) parent.children.push(node);
      else if (slash === -1) roots.push(node);
      // A node whose parent directory isn't in the tree is unreachable; the
      // patch that adds the parent will bring it back.
    }

    const order = (a: Node, b: Node) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1;
    roots.sort(order);
    for (const n of byPath.values()) n.children.sort(order);

    // What a rename is of is gone, or where a new thing was going: the
    // naming has nowhere to be.
    const naming = this.naming;
    if (naming && ((naming.from !== null && !byPath.has(naming.from)) || (naming.folder !== "" && !byPath.get(naming.folder)?.dir))) this.stopNaming();

    this.rows = [];
    const namingRow = (depth: number): Row => ({
      key: NAMING_KEY,
      node: { path: NAMING_KEY, name: "", dir: this.naming!.dir, depth, children: [] },
      expanded: false,
      naming: true,
    });
    const walk = (nodes: Node[], folder: string, depth: number) => {
      // A new thing's name is typed where it will appear: a folder first
      // among the folders, a file first among the files.
      const n = this.naming;
      const newHere = n !== null && n.from === null && n.folder === folder ? (n.dir ? "dir" : "file") : null;
      if (newHere === "dir") this.rows.push(namingRow(depth));
      let filesBegun = false;
      for (const node of nodes) {
        if (newHere === "file" && !filesBegun && !node.dir) this.rows.push(namingRow(depth));
        if (!node.dir) filesBegun = true;
        const open = node.dir && this.expanded.has(node.path);
        if (n?.from === node.path) this.rows.push(namingRow(depth));
        else this.rows.push({ key: node.path, node, expanded: open });
        const typingInside = n !== null && n.from === null && n.folder === node.path;
        if (open && node.children.length === 0 && !typingInside) {
          // An open folder that showed nothing looked like one still loading.
          this.rows.push({
            key: `${node.path}/`,
            node: { path: `${node.path}/`, name: "empty", dir: false, depth: node.depth + 1, children: [] },
            expanded: false,
            empty: true,
          });
        }
        if (open) walk(node.children, node.path, depth + 1);
      }
      if (newHere === "file" && !filesBegun) this.rows.push(namingRow(depth));
    };
    walk(roots, "", 0);

    this.spacer.style.height = `${this.rows.length * this.rowPx}px`;
    this.paint();
  }

  private focusIndex(): number {
    const i = this.focusPath === null ? -1 : this.rows.findIndex((r) => r.node.path === this.focusPath);
    return i >= 0 ? i : 0;
  }

  private scrollTo(index: number) {
    const top = index * this.rowPx;
    const height = this.viewport.clientHeight || 400;
    if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
    else if (top + this.rowPx > this.viewport.scrollTop + height) this.viewport.scrollTop = top + this.rowPx - height;
  }

  /** Move the tree's one stop to row `i`, scrolled into view and focused. */
  private focusRow(i: number) {
    if (!this.rows.length) return;
    let index = Math.max(0, Math.min(this.rows.length - 1, i));
    // Never the row a name is being typed in: that is the input's.
    if (this.rows[index].naming) index = index + 1 < this.rows.length ? index + 1 : Math.max(0, index - 1);
    if (this.rows[index].naming) return;
    this.focusPath = this.rows[index].node.path;
    this.onFocusMove();
    this.paintBar();
    this.scrollTo(index);
    this.paint();
    this.surface.querySelector<HTMLElement>(`[data-path="${CSS.escape(this.focusPath)}"]`)?.focus({ preventScroll: true });
  }

  private toggle(node: Node) {
    if (this.expanded.has(node.path)) this.expanded.delete(node.path);
    else this.expanded.add(node.path);
    this.rebuild();
  }

  /** The tree's keys, as the ARIA tree pattern has them. */
  private key(e: KeyboardEvent) {
    if (!this.rows.length || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof HTMLInputElement) return;
    const i = this.focusIndex();
    const { node, expanded, empty } = this.rows[i];
    const parent = () => {
      const slash = node.path.lastIndexOf("/");
      return slash === -1 ? -1 : this.rows.findIndex((r) => r.node.path === node.path.slice(0, slash));
    };
    const real = !empty && this.entries.has(node.path);
    const mine = real && this.handlers.offered() && this.handlers.writable();
    let handled = true;
    switch (e.key) {
      case "ArrowDown": this.focusRow(i + 1); break;
      case "ArrowUp": this.focusRow(i - 1); break;
      case "Home": this.focusRow(0); break;
      case "End": this.focusRow(this.rows.length - 1); break;
      case "ArrowRight":
        if (node.dir && !expanded) { this.toggle(node); this.focusRow(i); }
        else if (node.dir) this.focusRow(i + 1);
        break;
      case "ArrowLeft":
        if (node.dir && expanded) { this.toggle(node); this.focusRow(i); }
        else if (parent() >= 0) this.focusRow(parent());
        break;
      case "Enter":
      case " ":
        if (node.dir) { this.toggle(node); this.focusRow(i); }
        else if (!empty) this.handlers.onOpen(node.path);
        break;
      // The keys an editor's explorer has for what the row's buttons do.
      case "F2":
        if (mine) this.rename(node.path);
        else handled = false;
        break;
      case "Delete":
        if (mine) this.handlers.onDelete(node.path, node.dir);
        else handled = false;
        break;
      case "F10":
        if (e.shiftKey && real) this.showMenu(node.path);
        else handled = false;
        break;
      case "ContextMenu":
        if (real) this.showMenu(node.path);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  /** A row's own buttons, at its end: Rename and Delete where the host can do them, and Download. */
  private actions(node: Node): HTMLElement {
    const actions = document.createElement("span");
    actions.className = "row-actions";
    // A pointer's: the keyboard has F2, Delete and the row's menu, and the
    // tree stays one stop.
    const button = (icon: keyof typeof TREE_ICONS, label: string, kind: string, run: () => void) => {
      const b = this.iconButton(icon, label, run);
      b.classList.add(kind);
      b.tabIndex = -1;
      actions.append(b);
      return b;
    };
    const mine = this.handlers.offered();
    if (mine) {
      const rename = button("rename", `Rename ${node.path}`, "rename", () => this.rename(node.path));
      rename.title = "Rename (F2)";
      rename.disabled = !this.handlers.writable();
    }
    button("download", node.dir ? `Download ${node.path} as a zip` : `Download ${node.path}`, "get", () => this.handlers.onDownload(node.path));
    if (mine) {
      const del = button("trash", `Delete ${node.path}`, "delete", () => this.handlers.onDelete(node.path, node.dir));
      del.disabled = !this.handlers.writable();
    }
    return actions;
  }

  /** The row a name is typed in: an input where the name would be, and what is wrong with it under it. */
  private namingRow(row: HTMLElement, depth: number) {
    const n = this.naming!;
    row.className = "tree-row naming";
    row.removeAttribute("role");
    row.style.paddingLeft = `${0.35 + depth * 0.75}rem`;
    if (row.firstElementChild !== null && row.contains(n.input)) return;
    row.innerHTML = `<span class="twisty">${n.dir ? TREE_ICONS.chevron : ""}</span><span class="ico">${n.dir ? TREE_ICONS.folder : TREE_ICONS.file}</span>`;
    row.append(n.input, n.problem);
  }

  /** Set while rows are being put on screen: a blur then is the tree's doing, not the person's. */
  private painting = false;

  private paint() {
    this.painting = true;
    try {
      this.paintRows();
    } finally {
      this.painting = false;
    }
  }

  private paintRows() {
    const focused = this.surface.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const typing = this.naming !== null && focused === this.naming.input;
    const caret = [this.naming?.input.selectionStart ?? 0, this.naming?.input.selectionEnd ?? 0] as const;
    const focusedPath = focused && !typing ? focused.closest<HTMLElement>(".tree-row")?.dataset.path ?? null : null;
    const stop = this.rows[this.focusIndex()]?.node.path ?? null;
    const scrollTop = this.viewport.scrollTop;
    const height = this.viewport.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / this.rowPx) - OVERSCAN);
    const last = Math.min(
      this.rows.length,
      Math.ceil((scrollTop + height) / this.rowPx) + OVERSCAN,
    );

    this.surface.style.transform = `translateY(${first * this.rowPx}px)`;

    // What the rows can do is part of what they are: when the host starts or
    // stops letting a guest change things, they are drawn afresh.
    const able = `${this.handlers.offered()} ${this.handlers.writable()}`;
    if (able !== this.drawn) {
      this.drawn = able;
      for (const el of [...this.surface.children]) if ((el as HTMLElement).dataset.key !== NAMING_KEY) el.remove();
    }

    // Rows are kept, not rebuilt. A click is a press and a release on the
    // same element, and every file change repaints: a fresh row under the
    // pointer between the two was a click that never happened — in a folder
    // a build was writing to, files could hardly be opened at all.
    const wanted = new Set<string>();
    for (let i = first; i < last; i++) wanted.add(this.rows[i].key);
    const kept = new Map<string, HTMLElement>();
    for (const el of [...this.surface.children] as HTMLElement[]) {
      if (wanted.has(el.dataset.key!)) kept.set(el.dataset.key!, el);
      else el.remove();
    }
    const movable = this.handlers.offered() && this.handlers.writable();
    let at = this.surface.firstElementChild;
    for (let i = first; i < last; i++) {
      const { key, node, expanded, empty, naming } = this.rows[i];
      let row = kept.get(key);
      const fresh = !row;
      if (!row) {
        row = document.createElement("div");
        row.dataset.key = key;
      }
      if (naming) {
        this.namingRow(row, node.depth);
      } else {
        if (fresh) {
          row.setAttribute("role", "treeitem");
          row.dataset.path = node.path;
          row.title = node.path;
          row.setAttribute("aria-label", node.name);
          const twisty = document.createElement("span");
          twisty.className = "twisty";
          const ico = document.createElement("span");
          ico.className = "ico";
          const label = document.createElement("span");
          label.textContent = node.name;
          row.append(twisty, ico, label);
          if (!empty) row.append(this.actions(node));
        }
        // A path can be a file one moment and a folder the next.
        const label = row.children[2] as HTMLElement;
        label.className = node.dir ? "name dir" : "name";
        row.setAttribute("aria-level", String(node.depth + 1));
        row.tabIndex = node.path === stop ? 0 : -1;
        if (node.dir) row.setAttribute("aria-expanded", String(expanded));
        else row.removeAttribute("aria-expanded");
        row.setAttribute("aria-selected", String(node.path === this.active));
        // An image is looked at, not edited: said by its row, as the pad's says it.
        const image = !node.dir && !empty && imageType(node.path) !== null;
        row.className = `tree-row${empty ? " empty-folder" : ""}${node.dir ? " dir" : ""}${image ? " image" : ""}`;
        if (empty) row.setAttribute("aria-disabled", "true");
        else row.removeAttribute("aria-disabled");
        if (node.path === this.active) row.classList.add("active");
        if (this.dragging?.path === node.path) row.classList.add("dragging");
        row.draggable = movable && !empty;
        if (movable && !empty) row.setAttribute("aria-keyshortcuts", "F2 Delete");
        else row.removeAttribute("aria-keyshortcuts");
        const actions = row.querySelector<HTMLElement>(".row-actions");
        row.style.setProperty("--actions", String(actions?.childElementCount ?? 0));
        row.style.paddingLeft = `${0.35 + node.depth * 0.75}rem`;

        // Drawn, not typed: the ▾ and ▸ glyphs were 11 px and came out a
        // different size in every font.
        const twisty = row.children[0] as HTMLElement;
        const shape = node.dir ? (expanded ? "open" : "shut") : "";
        if (twisty.dataset.d !== shape) {
          twisty.dataset.d = shape;
          twisty.innerHTML = node.dir ? TREE_ICONS.chevron : "";
          twisty.classList.toggle("open", shape === "open");
        }
        const ico = row.children[1] as HTMLElement;
        const kind = empty ? "" : node.dir ? "folder" : "file";
        if (ico.dataset.d !== kind) {
          ico.dataset.d = kind;
          ico.innerHTML = kind ? TREE_ICONS[kind] : "";
        }

        // The tree's nodes are new on every rebuild, so the handler is too.
        row.onclick = (e) => {
          if ((e.target as Element).closest(".row-actions")) return;
          this.focusPath = node.path;
          this.onFocusMove();
          this.paintBar();
          if (node.dir) this.toggle(node);
          else if (!empty) this.handlers.onOpen(node.path);
        };
      }

      // Moved only when out of place; a row moved is a row taken out and
      // put back, which loses a click as surely as a new one.
      if (row !== at) this.surface.insertBefore(row, at);
      else at = at.nextElementSibling;
      if (!naming && node.path === focusedPath && document.activeElement !== row && !row.contains(document.activeElement)) row.focus({ preventScroll: true });
    }
    // The name being typed went with its row and came back with it: the
    // same input, and where its caret was.
    if (typing && this.naming && this.naming.input.isConnected && document.activeElement !== this.naming.input) {
      this.naming.input.focus({ preventScroll: true });
      this.naming.input.setSelectionRange(caret[0], caret[1]);
    }
    // Tab must always have somewhere to land in the tree. When the stop is
    // scrolled out of the window, the tree itself takes it and hands it on.
    this.viewport.tabIndex = stop !== null && !this.surface.querySelector('[tabindex="0"]') ? 0 : -1;
  }
}

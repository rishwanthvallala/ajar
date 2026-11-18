/**
 * The folder, drawn as a folder.
 *
 * Paths arrive flat — `sub/nested.txt` — because that is how they are stored
 * and how the sandbox reports them. Rendering them flat means a project with
 * any structure reads as a list of long strings, and a directory made in the
 * shell looks like it did not happen.
 *
 * Directories are therefore *derived* from the paths rather than stored. An
 * empty one is kept by a marker — an empty `.keep`, never drawn — and arrives
 * here as one of `folders`. `pending` carries a viewer's, made in this tab
 * and kept only there, and the moment between New folder and its marker
 * being stored.
 *
 * Names are typed into the tree itself, where the thing will be, as in an
 * editor's file explorer: New file opens a row in the folder it lands in, F2
 * turns a row into its name, selected to type over. A prompt asked for a whole
 * path instead, and said nothing about where that was until it was made.
 */
import { imageType } from "@ajar/workspace-ui/images";
import { canDrop, folderOf, nameProblem, pathFor, type Taken } from "@ajar/workspace-ui/names";
import { TREE_ICONS as ICONS } from "@ajar/workspace-ui/tree-icons";

export { canDrop, nameProblem, pathFor, type Taken } from "@ajar/workspace-ui/names";

export interface TreeEvents {
  onOpen: (path: string) => void;
  /**
   * A file to make, its name typed and checked: the whole path. Opened unless
   * the naming was left by going elsewhere — what was clicked is what is wanted.
   */
  onCreateFile: (path: string, open: boolean) => void;
  /** A folder to make, the same way. */
  onCreateFolder: (path: string) => void;
  onDelete: (path: string) => void;
  /** A folder and everything in it. */
  onDeleteFolder?: (path: string) => void;
  /** A file as itself, or a folder as a zip. */
  onDownload: (path: string, folder: boolean) => void;
  /** The whole pad as a zip. */
  onDownloadAll: () => void;
  /** The pad's earlier versions, to look at and go back to. */
  onHistory?: () => void;
  /** A zip's files into this pad. */
  onImport?: (zip?: File) => void;
  /** Whether this page may add files at all — a viewer may not. */
  importable?: () => boolean;
  /**
   * A file or folder to a new path: dropped on a folder, or F2 and a name
   * typed. `to` is the whole new path, not just the folder it lands in.
   */
  onMove?: (from: string, folder: boolean, to: string) => void;
  /** Whether this page may move things — a viewer may not. */
  movable?: () => boolean;
}

/** What a row being dragged carries, so a drag from anywhere else is not mistaken for one. */
const DRAG = "application/x-pad-path";

/** A name being typed in the tree. */
interface Naming {
  kind: "file" | "folder";
  /** The folder it is typed in; "" is the top. */
  folder: string;
  /** What is being renamed, or null for something new. */
  from: string | null;
  input: HTMLInputElement;
  problem: HTMLElement;
  /** Taken away when the naming ends. */
  done: AbortController;
}

interface Node {
  name: string;
  path: string;
  children: Map<string, Node> | null;
}

function build(paths: string[], pending: string[]): Node {
  const root: Node = { name: "", path: "", children: new Map() };
  const place = (path: string, isDir: boolean) => {
    const parts = path.split("/").filter(Boolean);
    let at = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const here = parts.slice(0, i + 1).join("/");
      let next = at.children!.get(part);
      // A file and one of its descendants cannot both exist in a real
      // filesystem. The server rejects this now; keep rendering defensive for
      // any pad written by an older relay.
      if (next?.children === null && !last) {
        next.children = new Map();
      }
      if (!next) {
        next = { name: part, path: here, children: last && !isDir ? null : new Map() };
        at.children!.set(part, next);
      }
      at = next;
    });
  };
  for (const p of paths) place(p, false);
  for (const p of pending) place(p, true);
  return root;
}

/** A row's name, in an element of its own, so it can end in an ellipsis before the row's buttons. */
function nameOf(name: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "name";
  span.textContent = name;
  return span;
}


export class FileTree {
  /** Directories made here that hold nothing yet, so cannot be stored. */
  private pending = new Set<string>();
  private collapsed = new Set<string>();
  /** The last thing drawn, so folding can redraw without the caller's help. */
  private shown: string[] = [];
  private active = "";
  /** Files that are this tab's own copy — a viewer's changes. */
  private local: ReadonlySet<string> = new Set();
  /** Files that are not text: shown, downloadable, movable, never opened in the editor. */
  private binary: ReadonlySet<string> = new Set();
  /** Empty folders the pad keeps — by their markers — so shown though nothing implies them. */
  private folders: readonly string[] = [];
  /** The row being dragged, while it is. */
  private dragging: { path: string; folder: boolean } | null = null;
  /**
   * The folder clicked last, which new things go in, as in an editor's
   * explorer — "" for the space below the rows, the top. Null once a file is
   * clicked: then they go beside the open file.
   */
  private picked: string | null = null;
  /** The name being typed, kept across redraws: the tree is redrawn whenever anything changes. */
  private naming: Naming | null = null;
  private redrawing = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: TreeEvents,
  ) {}

  addPendingFolder(path: string): void {
    this.pending.add(path);
  }

  /** A folder this tab made that the pad now keeps, or one that is gone. */
  forgetPending(path: string): void {
    for (const p of [...this.pending]) if (p === path || p.startsWith(`${path}/`)) this.pending.delete(p);
  }

  /**
   * After a move: empty folders made here, and folded ones, go with what
   * moved, and the folder it went into opens so it can be seen there.
   */
  moved(from: string, to: string): void {
    const shift = (set: Set<string>) => {
      for (const p of [...set]) {
        if (p !== from && !p.startsWith(`${from}/`)) continue;
        set.delete(p);
        set.add(to + p.slice(from.length));
      }
    };
    shift(this.pending);
    shift(this.collapsed);
    for (let at = folderOf(to); at; at = folderOf(at)) this.collapsed.delete(at);
  }

  render(paths: string[], active: string, local: ReadonlySet<string> = this.local, binary: ReadonlySet<string> = this.binary, folders: readonly string[] = this.folders): void {
    this.shown = paths;
    this.active = active;
    this.local = local;
    this.binary = binary;
    this.folders = folders;
    // A directory with something in it is no longer pending — it exists
    // because its contents imply it.
    for (const p of [...this.pending]) {
      if (paths.some((f) => f.startsWith(`${p}/`))) this.pending.delete(p);
    }

    const root = build([...paths].sort(), [...this.pending, ...this.folders]);
    const list = document.createElement("div");
    list.className = "tree";
    this.draw(root, list, active, 0);
    if (this.events.movable?.()) this.acceptMoves(list);
    // Below the rows is the top folder, as in an editor's explorer.
    list.addEventListener("click", (e) => {
      if (e.target === list) this.picked = "";
    });

    const bar = document.createElement("div");
    bar.className = "tree-bar";
    bar.append(
      this.iconButton("newFile", "New file", () => this.create("file")),
      this.iconButton("newFolder", "New folder", () => this.create("folder")),
    );
    // Apart from making things: what goes in and out whole.
    const whole = document.createElement("span");
    whole.className = "tree-bar-end";
    if (this.events.onImport && (this.events.importable?.() ?? true)) whole.append(this.iconButton("upload", "Upload a zip", () => this.events.onImport?.()));
    if (this.events.onHistory) whole.append(this.iconButton("history", "History: earlier versions of this pad", () => this.events.onHistory?.()));
    whole.append(this.iconButton("download", "Download as zip", () => this.events.onDownloadAll()));
    bar.append(whole);

    // The name being typed goes into the new rows as it was — the same input,
    // with where its caret was.
    const naming = this.naming;
    const typing = naming !== null && document.activeElement === naming.input;
    const caret = [naming?.input.selectionStart ?? 0, naming?.input.selectionEnd ?? 0] as const;
    this.redrawing = true;
    try {
      this.host.replaceChildren(bar, list);
    } finally {
      this.redrawing = false;
    }
    if (!naming) return;
    // Its row is gone with what it was in: somebody else moved or deleted it.
    if (!naming.input.isConnected) return this.stopNaming();
    if (typing) {
      naming.input.focus({ preventScroll: true });
      naming.input.setSelectionRange(caret[0], caret[1]);
    }
  }

  /**
   * Start typing a new file's or folder's name, in a row where it will be:
   * the folder clicked last, or beside the open file. That folder opens, so
   * the row can be seen there.
   */
  create(kind: "file" | "folder"): void {
    this.settle();
    const folder = this.target();
    for (let at = folder; at; at = folderOf(at)) this.collapsed.delete(at);
    this.startNaming(kind, folder, null, "");
  }

  /** A row turned into its name, the part before the extension selected to type over. */
  rename(path: string, folder: boolean): void {
    if (!(this.events.movable?.() ?? false)) return;
    this.settle();
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    this.startNaming(folder ? "folder" : "file", folderOf(path), path, leaf);
    const dot = leaf.lastIndexOf(".");
    this.naming?.input.setSelectionRange(0, !folder && dot > 0 ? dot : leaf.length);
  }

  /** Where New file puts it: in the folder clicked last, else beside the open file. */
  private target(): string {
    const picked = this.picked;
    if (picked !== null && (picked === "" || this.taken().folders.has(picked))) return picked;
    return folderOf(this.active);
  }

  private taken(): Taken {
    const folders = new Set<string>([...this.pending, ...this.folders]);
    for (const p of [...this.shown, ...this.pending, ...this.folders]) {
      for (let at = folderOf(p); at; at = folderOf(at)) folders.add(at);
    }
    return { files: new Set(this.shown), folders };
  }

  private startNaming(kind: Naming["kind"], folder: string, from: string | null, value: string): void {
    const done = new AbortController();
    const signal = done.signal;
    const input = document.createElement("input");
    input.className = "name-input";
    input.value = value;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("aria-label", from ? `New name for ${from}` : `Name of the new ${kind}${folder ? ` in ${folder}` : ""}`);
    const problem = document.createElement("div");
    problem.className = "name-problem";
    problem.id = "name-problem";
    problem.setAttribute("aria-live", "polite");
    problem.hidden = true;
    input.setAttribute("aria-describedby", problem.id);
    input.addEventListener("input", () => this.showProblem(), { signal });
    input.addEventListener("keydown", (e) => {
      // Its own: not Escape to the drawer it is in. The page's own keys —
      // ctrl-s, Run's — still reach the page.
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      this.finish(e.key === "Enter");
    }, { signal });
    // Clicking elsewhere keeps a name that will do, as an editor's explorer
    // does. Not until the click is over: the redraw that ends the naming
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
      if (!this.redrawing && !pressed) away();
    }, { signal });
    this.naming = { kind, folder, from, input, problem, done };
    this.render(this.shown, this.active);
    if (!input.isConnected) return this.stopNaming();
    input.focus({ preventScroll: true });
    input.scrollIntoView({ block: "nearest" });
  }

  /** Where the typed name stands, and why it will not do. */
  private checked(): { path: string; problem: string | null } | null {
    const n = this.naming;
    if (!n) return null;
    const typed = n.input.value.trim();
    if (!typed) return { path: "", problem: null };
    const path = pathFor(typed, n.folder);
    const from = n.from === null ? null : { path: n.from, folder: n.kind === "folder" };
    return { path, problem: nameProblem(path, this.taken(), from) };
  }

  private showProblem(): void {
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
  private finish(keep: boolean, left = false): void {
    const n = this.naming;
    const result = this.checked();
    if (!n || !result) return;
    if (keep && result.path && result.problem) {
      if (!left) return this.showProblem();
      keep = false;
    }
    const returnTo = n.from;
    this.stopNaming();
    this.render(this.shown, this.active);
    if (keep && result.path) {
      if (n.from !== null) {
        if (result.path !== n.from) this.events.onMove?.(n.from, n.kind === "folder", result.path);
      } else if (n.kind === "folder") this.events.onCreateFolder(result.path);
      else this.events.onCreateFile(result.path, !left);
      return;
    }
    // Back to where it came from — the row, or the button — so the keyboard
    // carries on from there.
    if (left) return;
    const from = returnTo !== null ? `.row[data-path="${CSS.escape(returnTo)}"]` : `.tree-bar button[aria-label="New ${n.kind}"]`;
    this.host.querySelector<HTMLElement>(from)?.focus();
  }

  /** A name half typed when another is started is kept if it will do. */
  private settle(): void {
    if (this.naming) this.finish(true, true);
  }

  private stopNaming(): void {
    this.naming?.done.abort();
    this.naming = null;
  }

  /** The row a name is typed in: an input where the name would be, and what is wrong with it under it. */
  private namingRow(depth: number): HTMLElement {
    const n = this.naming!;
    const wrap = document.createElement("div");
    wrap.className = "file-row naming";
    const row = document.createElement("div");
    row.className = `row ${n.kind === "folder" ? "dir" : "file"} naming`;
    row.style.paddingLeft = `${0.35 + depth * 0.75}rem`;
    row.innerHTML = `<span class="chev">${n.kind === "folder" ? ICONS.chevron : ""}</span><span class="ico">${n.kind === "folder" ? ICONS.folder : ICONS.file}</span>`;
    row.append(n.input);
    // Under the input, not under the icons: past the indent, the chevron, the icon and the gaps between.
    n.problem.style.left = `${0.35 + depth * 0.75 + 0.6875 + 0.8125 + 0.6}rem`;
    wrap.append(row, n.problem);
    return wrap;
  }

  /**
   * A row's buttons, at its end: Rename first, for those who may move things.
   * Renaming was F2 alone until 24 October — nothing to see or to tap, so on
   * a phone there was no way to rename at all.
   */
  private actions(path: string, folder: boolean, movable: boolean): HTMLElement {
    const actions = document.createElement("span");
    actions.className = "row-actions";
    if (movable) {
      const rename = this.iconButton("rename", `Rename ${path}`, () => this.rename(path, folder));
      rename.classList.add("rename");
      rename.title = "Rename (F2)";
      rename.setAttribute("aria-keyshortcuts", "F2");
      actions.append(rename);
    }
    return actions;
  }

  private iconButton(icon: keyof typeof ICONS, label: string, onClick: () => void): HTMLElement {
    const b = document.createElement("button");
    b.className = "icon";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = ICONS[icon];
    b.onclick = onClick;
    return b;
  }

  /**
   * Drag and drop within the tree, as in an editor's file explorer: onto a
   * folder puts it inside, onto a file puts it beside that file, onto empty
   * space puts it at the top. One set of listeners on the list rather than on
   * every row, and the tree is not redrawn while a drag is under way — the
   * row being dragged has to outlive it.
   */
  private acceptMoves(list: HTMLElement): void {
    const targetOf = (e: DragEvent): string => {
      const row = (e.target as Element | null)?.closest<HTMLElement>(".row");
      if (!row) return "";
      const path = row.dataset.path ?? "";
      return row.classList.contains("dir") ? path : folderOf(path);
    };
    const mark = (folder: string | null) => {
      for (const el of list.querySelectorAll(".drop-into")) el.classList.remove("drop-into");
      list.classList.toggle("drop-into", folder === "");
      if (folder) list.querySelector(`.row.dir[data-path="${CSS.escape(folder)}"]`)?.classList.add("drop-into");
    };
    list.addEventListener("dragstart", (e) => {
      const row = (e.target as Element | null)?.closest<HTMLElement>(".row");
      if (!row?.dataset.path || !e.dataTransfer) return;
      this.dragging = { path: row.dataset.path, folder: row.classList.contains("dir") };
      e.dataTransfer.setData(DRAG, row.dataset.path);
      e.dataTransfer.setData("text/plain", row.dataset.path);
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    list.addEventListener("dragend", () => {
      this.dragging = null;
      mark(null);
      for (const el of list.querySelectorAll(".dragging")) el.classList.remove("dragging");
    });
    list.addEventListener("dragover", (e) => {
      // A file from the desktop is the zip drop's business, not a move.
      if (!this.dragging || !e.dataTransfer?.types.includes(DRAG)) return;
      const folder = targetOf(e);
      if (!canDrop(this.dragging, folder)) return mark(null);
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      mark(folder);
    });
    list.addEventListener("dragleave", (e) => {
      if (!(e.relatedTarget instanceof Element && list.contains(e.relatedTarget))) mark(null);
    });
    list.addEventListener("drop", (e) => {
      const what = this.dragging;
      if (!what || !e.dataTransfer?.types.includes(DRAG)) return;
      e.preventDefault();
      mark(null);
      const folder = targetOf(e);
      if (!canDrop(what, folder)) return;
      const leaf = what.path.split("/").pop()!;
      this.events.onMove?.(what.path, what.folder, folder ? `${folder}/${leaf}` : leaf);
    });
    // The keyboard's way to do the same: F2 on a row, then its new name —
    // within its folder, or from the top with a / in front.
    list.addEventListener("keydown", (e) => {
      if (e.key !== "F2") return;
      const row = (e.target as Element | null)?.closest<HTMLElement>(".row");
      if (!row?.dataset.path) return;
      e.preventDefault();
      this.rename(row.dataset.path, row.classList.contains("dir"));
    });
  }

  private draw(node: Node, into: HTMLElement, active: string, depth: number): void {
    const children = [...(node.children?.values() ?? [])].sort((a, b) => {
      const dirs = Number(b.children !== null) - Number(a.children !== null);
      return dirs || a.name.localeCompare(b.name);
    });

    const movable = this.events.movable?.() ?? false;
    // A new thing's name is typed where it will appear: a folder first among
    // the folders, a file first among the files.
    const naming = this.naming;
    const newHere = naming !== null && naming.from === null && naming.folder === node.path ? naming.kind : null;
    if (newHere === "folder") into.append(this.namingRow(depth));
    let filesBegun = false;
    for (const child of children) {
      if (newHere === "file" && !filesBegun && child.children === null) into.append(this.namingRow(depth));
      if (child.children === null) filesBegun = true;
      if (naming?.from === child.path) {
        into.append(this.namingRow(depth));
        if (child.children && !this.collapsed.has(child.path)) this.draw(child, into, active, depth + 1);
        continue;
      }
      const row = document.createElement("button");
      row.style.paddingLeft = `${0.35 + depth * 0.75}rem`;
      if (movable) {
        row.draggable = true;
        row.setAttribute("aria-keyshortcuts", "F2");
      }

      if (child.children) {
        const open = !this.collapsed.has(child.path);
        row.className = `row dir${open ? " open" : ""}`;
        row.innerHTML = `<span class="chev">${ICONS.chevron}</span><span class="ico">${ICONS.folder}</span>`;
        row.append(nameOf(child.name));
        row.onclick = () => {
          this.picked = child.path;
          if (open) this.collapsed.add(child.path);
          else this.collapsed.delete(child.path);
          this.render(this.shown, this.active);
          // The redraw made a new row; the keyboard stays on this folder.
          this.host.querySelector<HTMLElement>(`.row.dir[data-path="${CSS.escape(child.path)}"]`)?.focus({ preventScroll: true });
        };
        row.dataset.path = child.path;
        // A folder's row with its actions beside it, as a file's has.
        const wrap = document.createElement("div");
        wrap.className = "file-row dir-row";
        const actions = this.actions(child.path, true, movable);
        const zip = this.iconButton("download", `Download ${child.path} as a zip`, () => this.events.onDownload(child.path, true));
        zip.classList.add("get");
        actions.append(zip);
        if (this.events.onDeleteFolder && movable) {
          const del = this.iconButton("trash", `Delete ${child.path}`, () => this.events.onDeleteFolder?.(child.path));
          del.classList.add("delete");
          actions.append(del);
        }
        wrap.append(row, actions);
        wrap.style.setProperty("--actions", String(actions.childElementCount));
        into.append(wrap);
        if (open) this.draw(child, into, active, depth + 1);
      } else {
        const mine = this.local.has(child.path);
        const binary = this.binary.has(child.path);
        row.className = `row file${child.path === active ? " on" : ""}${mine ? " local" : ""}${binary ? " binary" : ""}`;
        if (binary) row.title = imageType(child.path) ? "An image — opens to view" : "Not text — download it to open it";
        row.innerHTML = `<span class="chev"></span><span class="ico">${ICONS.file}</span>`;
        row.append(nameOf(child.name));
        if (mine) {
          const mark = document.createElement("span");
          mark.className = "local-mark";
          mark.textContent = "local";
          mark.title = "Your own copy — changed in this tab only";
          row.append(mark);
        }
        row.dataset.path = child.path;
        row.onclick = () => {
          this.picked = null;
          this.events.onOpen(child.path);
        };
        // Beside the row rather than in it: a button cannot contain a button,
        // and the row's text stays the file's name alone.
        const wrap = document.createElement("div");
        wrap.className = "file-row";
        const actions = this.actions(child.path, false, movable);
        const get = this.iconButton("download", `Download ${child.path}`, () => this.events.onDownload(child.path, false));
        get.classList.add("get");
        const del = this.iconButton("trash", `Delete ${child.path}`, () => this.events.onDelete(child.path));
        del.classList.add("delete");
        actions.append(get, del);
        wrap.append(row, actions);
        wrap.style.setProperty("--actions", String(actions.childElementCount));
        into.append(wrap);
      }
    }
    if (newHere === "file" && !filesBegun) into.append(this.namingRow(depth));
  }
}

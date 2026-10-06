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
 */

export interface TreeEvents {
  onOpen: (path: string) => void;
  onNewFile: (inDirectory: string) => void;
  onNewFolder: (inDirectory: string) => void;
  onDelete: (path: string) => void;
  /** A folder and everything in it. */
  onDeleteFolder?: (path: string) => void;
  /** A file as itself, or a folder as a zip. */
  onDownload: (path: string, folder: boolean) => void;
  /** The whole pad as a zip. */
  onDownloadAll: () => void;
  /** A zip's files into this pad. */
  onImport?: (zip?: File) => void;
  /** Whether this page may add files at all — a viewer may not. */
  importable?: () => boolean;
  /**
   * A file or folder to a new path: dropped on a folder, or F2 and a path
   * typed. `to` is the whole new path, not just the folder it lands in.
   */
  onMove?: (from: string, folder: boolean, to: string) => void;
  /** Whether this page may move things — a viewer may not. */
  movable?: () => boolean;
}

/** What a row being dragged carries, so a drag from anywhere else is not mistaken for one. */
const DRAG = "application/x-pad-path";

/** The folder something lands in when dropped on `row`: a folder itself, or a file's own folder. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * Whether `what` may go into `folder`. Not where it already is — that moves
 * nothing — and never a folder into itself or anything under it.
 */
export function canDrop(what: { path: string; folder: boolean }, folder: string): boolean {
  if (folderOf(what.path) === folder) return false;
  if (what.folder && (folder === what.path || folder.startsWith(`${what.path}/`))) return false;
  return true;
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

const ICONS = {
  file: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.5V5a.5.5 0 0 0 .5.5H13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  folder: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3h4.4A1.5 1.5 0 0 1 14 6.1v6.4A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-8Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
  newFile: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.5 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M11.5 1.5v4M9.5 3.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  newFolder: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3h2.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2 4.5v8A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M12.5 2.5v4M10.5 4.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  chevron: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  download: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.8 7.3 8 10.5l3.2-3.2M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  upload: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10.5v-8M4.8 5.7 8 2.5l3.2 3.2M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  trash: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.6 9a1.5 1.5 0 0 0 1.5 1.4h3.8a1.5 1.5 0 0 0 1.5-1.4L12 4M6.5 6.5v5M9.5 6.5v5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
} as const;

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

    const bar = document.createElement("div");
    bar.className = "tree-bar";
    bar.append(
      this.iconButton("newFile", "New file", () => this.events.onNewFile(this.folderFor(active))),
      this.iconButton("newFolder", "New folder", () =>
        this.events.onNewFolder(this.folderFor(active)),
      ),
    );
    // Apart from making things: what goes in and out whole.
    const whole = document.createElement("span");
    whole.className = "tree-bar-end";
    if (this.events.onImport && (this.events.importable?.() ?? true)) whole.append(this.iconButton("upload", "Upload a zip", () => this.events.onImport?.()));
    whole.append(this.iconButton("download", "Download as zip", () => this.events.onDownloadAll()));
    bar.append(whole);

    this.host.replaceChildren(bar, list);
  }

  /** New things land beside what you are looking at, not always at the root. */
  private folderFor(active: string): string {
    const cut = active.lastIndexOf("/");
    return cut === -1 ? "" : active.slice(0, cut);
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
    // The keyboard's way to do the same: F2 on a row, then a path.
    list.addEventListener("keydown", (e) => {
      if (e.key !== "F2") return;
      const row = (e.target as Element | null)?.closest<HTMLElement>(".row");
      if (!row?.dataset.path) return;
      e.preventDefault();
      const from = row.dataset.path;
      const to = prompt(`Move or rename ${from} — its new path:`, from);
      if (to === null) return;
      this.events.onMove?.(from, row.classList.contains("dir"), to);
    });
  }

  private draw(node: Node, into: HTMLElement, active: string, depth: number): void {
    const children = [...(node.children?.values() ?? [])].sort((a, b) => {
      const dirs = Number(b.children !== null) - Number(a.children !== null);
      return dirs || a.name.localeCompare(b.name);
    });

    const movable = this.events.movable?.() ?? false;
    for (const child of children) {
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
        row.append(child.name);
        row.onclick = () => {
          if (open) this.collapsed.add(child.path);
          else this.collapsed.delete(child.path);
          this.render(this.shown, this.active);
        };
        row.dataset.path = child.path;
        // A folder's row with its one action beside it, as a file's has.
        const wrap = document.createElement("div");
        wrap.className = "file-row dir-row";
        const zip = this.iconButton("download", `Download ${child.path} as a zip`, () => this.events.onDownload(child.path, true));
        zip.classList.add("get");
        wrap.append(row, zip);
        if (this.events.onDeleteFolder && movable) {
          const del = this.iconButton("trash", `Delete ${child.path}`, () => this.events.onDeleteFolder?.(child.path));
          del.classList.add("delete");
          wrap.append(del);
        }
        into.append(wrap);
        if (open) this.draw(child, into, active, depth + 1);
      } else {
        const mine = this.local.has(child.path);
        const binary = this.binary.has(child.path);
        row.className = `row file${child.path === active ? " on" : ""}${mine ? " local" : ""}${binary ? " binary" : ""}`;
        if (binary) row.title = "Not text — download it to open it";
        row.innerHTML = `<span class="chev"></span><span class="ico">${ICONS.file}</span>`;
        row.append(child.name);
        if (mine) {
          const mark = document.createElement("span");
          mark.className = "local-mark";
          mark.textContent = "local";
          mark.title = "Your own copy — changed in this tab only";
          row.append(mark);
        }
        row.dataset.path = child.path;
        row.onclick = () => this.events.onOpen(child.path);
        // Beside the row rather than in it: a button cannot contain a button,
        // and the row's text stays the file's name alone.
        const wrap = document.createElement("div");
        wrap.className = "file-row";
        const get = this.iconButton("download", `Download ${child.path}`, () => this.events.onDownload(child.path, false));
        get.classList.add("get");
        const del = this.iconButton("trash", `Delete ${child.path}`, () => this.events.onDelete(child.path));
        del.classList.add("delete");
        wrap.append(row, get, del);
        into.append(wrap);
      }
    }
  }
}

/**
 * The folder, drawn as a folder.
 *
 * Paths arrive flat — `sub/nested.txt` — because that is how they are stored
 * and how the sandbox reports them. Rendering them flat means a project with
 * any structure reads as a list of long strings, and a directory made in the
 * shell looks like it did not happen.
 *
 * Directories are therefore *derived* from the paths rather than stored. The
 * consequence is worth stating: an empty directory cannot survive a reload,
 * because there is no file in it to imply it. `pending` carries the ones made
 * in this tab so they are at least visible until something lands inside.
 */

export interface TreeEvents {
  onOpen: (path: string) => void;
  onNewFile: (inDirectory: string) => void;
  onNewFolder: (inDirectory: string) => void;
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
} as const;

export class FileTree {
  /** Directories made here that hold nothing yet, so cannot be stored. */
  private pending = new Set<string>();
  private collapsed = new Set<string>();
  /** The last thing drawn, so folding can redraw without the caller's help. */
  private shown: string[] = [];
  private active = "";

  constructor(
    private readonly host: HTMLElement,
    private readonly events: TreeEvents,
  ) {}

  addPendingFolder(path: string): void {
    this.pending.add(path);
  }

  render(paths: string[], active: string): void {
    this.shown = paths;
    this.active = active;
    // A directory with something in it is no longer pending — it exists
    // because its contents imply it.
    for (const p of [...this.pending]) {
      if (paths.some((f) => f.startsWith(`${p}/`))) this.pending.delete(p);
    }

    const root = build([...paths].sort(), [...this.pending]);
    const list = document.createElement("div");
    list.className = "tree";
    this.draw(root, list, active, 0);

    const bar = document.createElement("div");
    bar.className = "tree-bar";
    bar.append(
      this.iconButton("newFile", "New file", () => this.events.onNewFile(this.folderFor(active))),
      this.iconButton("newFolder", "New folder", () =>
        this.events.onNewFolder(this.folderFor(active)),
      ),
    );

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

  private draw(node: Node, into: HTMLElement, active: string, depth: number): void {
    const children = [...(node.children?.values() ?? [])].sort((a, b) => {
      const dirs = Number(b.children !== null) - Number(a.children !== null);
      return dirs || a.name.localeCompare(b.name);
    });

    for (const child of children) {
      const row = document.createElement("button");
      row.style.paddingLeft = `${0.35 + depth * 0.75}rem`;

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
        into.append(row);
        if (open) this.draw(child, into, active, depth + 1);
      } else {
        row.className = `row file${child.path === active ? " on" : ""}`;
        row.innerHTML = `<span class="chev"></span><span class="ico">${ICONS.file}</span>`;
        row.append(child.name);
        row.dataset.path = child.path;
        row.onclick = () => this.events.onOpen(child.path);
        into.append(row);
      }
    }
  }
}

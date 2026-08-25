import type { Entry } from "./proto";

/**
 * The shared folder, as a collapsible tree.
 *
 * Windowed from the start. A source tree with the ignore rules applied is
 * usually a few thousand entries, but "usually" is not a guarantee, and a
 * tree that dies at ten thousand nodes will die during the first real demo.
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

interface Node {
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  children: Node[];
}

interface Row {
  node: Node;
  expanded: boolean;
}

export class FileTree {
  private entries = new Map<string, Entry>();
  private expanded = new Set<string>();
  private rows: Row[] = [];
  private active: string | null = null;
  private viewport: HTMLDivElement;
  private spacer: HTMLDivElement;
  private surface: HTMLDivElement;
  private rowPx = 22;

  constructor(
    private host: HTMLElement,
    private onOpen: (path: string) => void,
  ) {
    this.host.classList.add("tree");
    this.viewport = document.createElement("div");
    this.viewport.className = "tree-viewport";
    this.spacer = document.createElement("div");
    this.spacer.className = "tree-spacer";
    this.surface = document.createElement("div");
    this.surface.className = "tree-surface";
    this.spacer.appendChild(this.surface);
    this.viewport.appendChild(this.spacer);
    this.host.appendChild(this.viewport);

    this.rowPx = rowHeight(this.host);
    this.viewport.addEventListener("scroll", () => this.paint(), { passive: true });
    // Zoom and font-size changes both land here. Re-reading the row height is
    // cheap and keeps the scroll maths matching what is actually rendered.
    window.addEventListener("resize", () => {
      this.rowPx = rowHeight(this.host);
      this.rebuild();
    });
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
    // Open every directory on the way to the active file.
    if (path) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        this.expanded.add(parts.slice(0, i).join("/"));
      }
    }
    this.rebuild();
  }

  get count(): number {
    return this.entries.size;
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

    this.rows = [];
    const walk = (nodes: Node[]) => {
      for (const node of nodes) {
        const open = node.dir && this.expanded.has(node.path);
        this.rows.push({ node, expanded: open });
        if (open) walk(node.children);
      }
    };
    walk(roots);

    this.spacer.style.height = `${this.rows.length * this.rowPx}px`;
    this.paint();
  }

  private paint() {
    const scrollTop = this.viewport.scrollTop;
    const height = this.viewport.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / this.rowPx) - OVERSCAN);
    const last = Math.min(
      this.rows.length,
      Math.ceil((scrollTop + height) / this.rowPx) + OVERSCAN,
    );

    this.surface.style.transform = `translateY(${first * this.rowPx}px)`;
    this.surface.replaceChildren();

    for (let i = first; i < last; i++) {
      const { node, expanded } = this.rows[i];
      const row = document.createElement("div");
      row.className = "tree-row";
      if (node.path === this.active) row.classList.add("active");
      // Indent in em so it tracks the row's own font size.
      row.style.paddingLeft = `${0.4 + node.depth * 0.85}em`;
      row.title = node.path;

      const twisty = document.createElement("span");
      twisty.className = "twisty";
      twisty.textContent = node.dir ? (expanded ? "▾" : "▸") : "";
      row.appendChild(twisty);

      const label = document.createElement("span");
      label.className = node.dir ? "name dir" : "name";
      label.textContent = node.name;
      row.appendChild(label);

      row.onclick = () => {
        if (node.dir) {
          if (this.expanded.has(node.path)) this.expanded.delete(node.path);
          else this.expanded.add(node.path);
          this.rebuild();
        } else {
          this.onOpen(node.path);
        }
      };

      this.surface.appendChild(row);
    }
  }
}

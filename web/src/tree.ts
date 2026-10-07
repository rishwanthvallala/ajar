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
  /** The line under an open folder with nothing in it, saying so. */
  empty?: boolean;
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
  private viewport: HTMLDivElement;
  private spacer: HTMLDivElement;
  private surface: HTMLDivElement;
  private rowPx = 22;
  private readonly events = new AbortController();
  private readonly observer: ResizeObserver;

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
    this.viewport.setAttribute("role", "tree");
    this.viewport.setAttribute("aria-label", "Files");
    this.viewport.addEventListener("keydown", (e) => this.key(e), { signal: this.events.signal });
    // Tab reached the tree while its focus row is scrolled out of the
    // window: bring the row into view and give it the focus.
    this.viewport.addEventListener("focus", () => {
      if (document.activeElement === this.viewport) this.focusRow(this.focusIndex());
    }, { signal: this.events.signal });

    this.rowPx = rowHeight(this.host);
    this.viewport.addEventListener("scroll", () => this.paint(), { passive: true, signal: this.events.signal });
    // Zoom and font-size changes both land here. Re-reading the row height is
    // cheap and keeps the scroll maths matching what is actually rendered.
    window.addEventListener("resize", () => {
      this.rowPx = rowHeight(this.host);
      this.rebuild();
    }, { signal: this.events.signal });
    this.observer = new ResizeObserver(() => this.paint());
    this.observer.observe(this.viewport);
  }

  dispose() { this.events.abort(); this.observer.disconnect(); }

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
    if (path) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        this.expanded.add(parts.slice(0, i).join("/"));
      }
    }
    this.rebuild();
  }

  /** The folder the tree's stop is on, if it is on one. */
  get focusedFolder(): string | null {
    const row = this.rows[this.focusIndex()];
    return row?.node.dir ? row.node.path : null;
  }

  /** Called when the tree's stop moves, for anything that depends on it. */
  onFocusMove: () => void = () => {};

  /** Files, not counting the folders they are in. */
  get count(): number {
    let files = 0;
    for (const e of this.entries.values()) if (e.kind === "file") files++;
    return files;
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
        if (open && node.children.length === 0) {
          // An open folder that showed nothing looked like one still loading.
          this.rows.push({
            node: { path: `${node.path}/`, name: "empty", dir: false, depth: node.depth + 1, children: [] },
            expanded: false,
            empty: true,
          });
        }
        if (open) walk(node.children);
      }
    };
    walk(roots);

    this.spacer.style.height = `${this.rows.length * this.rowPx}px`;
    this.paint();
  }

  private focusIndex(): number {
    const i = this.focusPath === null ? -1 : this.rows.findIndex((r) => r.node.path === this.focusPath);
    return i >= 0 ? i : 0;
  }

  /** Move the tree's one stop to row `i`, scrolled into view and focused. */
  private focusRow(i: number) {
    if (!this.rows.length) return;
    const index = Math.max(0, Math.min(this.rows.length - 1, i));
    this.focusPath = this.rows[index].node.path;
    this.onFocusMove();
    const top = index * this.rowPx;
    const height = this.viewport.clientHeight || 400;
    if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
    else if (top + this.rowPx > this.viewport.scrollTop + height) this.viewport.scrollTop = top + this.rowPx - height;
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
    const i = this.focusIndex();
    const { node, expanded } = this.rows[i];
    const parent = () => {
      const slash = node.path.lastIndexOf("/");
      return slash === -1 ? -1 : this.rows.findIndex((r) => r.node.path === node.path.slice(0, slash));
    };
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
        else if (!this.rows[i].empty) this.onOpen(node.path);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  private paint() {
    const focusedPath = this.surface.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.path : null;
    const stop = this.rows[this.focusIndex()]?.node.path ?? null;
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
      const { node, expanded, empty } = this.rows[i];
      const row = document.createElement("div");
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(node.depth + 1));
      row.tabIndex = node.path === stop ? 0 : -1;
      row.dataset.path = node.path;
      row.setAttribute("aria-label", node.name);
      if (node.dir) row.setAttribute("aria-expanded", String(expanded));
      row.setAttribute("aria-selected", String(node.path === this.active));
      row.className = empty ? "tree-row empty-folder" : "tree-row";
      if (empty) row.setAttribute("aria-disabled", "true");
      if (node.path === this.active) row.classList.add("active");
      // Indent in em so it tracks the row's own font size.
      row.style.paddingLeft = `${0.4 + node.depth * 0.85}em`;
      row.title = node.path;

      const twisty = document.createElement("span");
      twisty.className = "twisty";
      // Drawn, not typed: the ▾ and ▸ glyphs were 11 px and came out a
      // different size in every font.
      if (node.dir) {
        twisty.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${expanded ? "M3 4.5l3 3 3-3" : "M4.5 3l3 3-3 3"}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      }
      row.appendChild(twisty);

      const label = document.createElement("span");
      label.className = node.dir ? "name dir" : "name";
      label.textContent = node.name;
      row.appendChild(label);

      row.onclick = () => {
        this.focusPath = node.path;
        this.onFocusMove();
        if (node.dir) this.toggle(node);
        else if (!empty) this.onOpen(node.path);
      };

      this.surface.appendChild(row);
      if (node.path === focusedPath) row.focus({ preventScroll: true });
    }
    // Tab must always have somewhere to land in the tree. When the stop is
    // scrolled out of the window, the tree itself takes it and hands it on.
    this.viewport.tabIndex = stop !== null && !this.surface.querySelector('[tabindex="0"]') ? 0 : -1;
  }
}

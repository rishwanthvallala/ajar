export type LayoutStorage = Pick<Storage, "getItem" | "setItem">;

export interface WorkspaceShellOptions {
  title: string;
  preferencePrefix: "ajar" | "pad" | string;
  storage?: LayoutStorage | null;
  terminalActions?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Shared workspace structure and responsive layout. Product code owns data and embedded tools. */
export class WorkspaceShell {
  readonly shell: HTMLElement;
  private readonly events = new AbortController();
  private readonly observer: ResizeObserver;
  private readonly narrow = matchMedia("(max-width: 47.999rem)");
  private readonly storage: LayoutStorage | null;
  private readonly prefix: string;
  private hidden = false;
  private width = 15;
  private split = 0.6;
  private drawer = false;
  private frame = 0;
  private disposed = false;
  private drag: { el: HTMLElement; id: number; axis: "x" | "y" } | null = null;
  onLayout = () => {};

  constructor(app: HTMLElement, options: WorkspaceShellOptions) {
    const terminalActions = options.terminalActions === false ? "" : `<button class="new" id="new-terminal">New terminal</button><button class="split" id="split" aria-label="Split terminal" aria-pressed="false">Split</button>`;
    app.innerHTML = `
      <div class="shell">
        <div class="preview-bar" id="preview-bar" hidden></div>
        <header class="workspace-head">
          <button class="side-toggle" id="side-toggle" aria-controls="sidebar">Files</button>
          <strong id="workspace"></strong>
          <div class="connection-status"><span class="dot" id="dot"></span><span class="status" id="status" role="status">connecting</span></div>
          <span class="badge" id="locked" hidden>locked</span>
          <span class="badge" id="readonly" hidden>read-only</span>
          <span class="people" id="people" aria-label="Participants"></span>
          <div class="workspace-actions" id="workspace-actions"></div>
        </header>
        <div class="away" id="away" role="status" hidden></div>
        <div class="body">
          <div class="drawer-backdrop" id="drawer-backdrop" hidden></div>
          <aside id="sidebar" aria-label="Files">
            <div class="side-head"><strong>Files</strong><span id="filecount">Loading…</span><div class="sidebar-actions" id="sidebar-actions"></div><button id="drawer-close" aria-label="Close files" hidden>Close</button></div>
            <div id="tree"></div>
          </aside>
          <div class="sidebar-splitter" id="sidebar-splitter" role="separator" aria-orientation="vertical" aria-label="Resize file sidebar" tabindex="0"></div>
          <div class="main">
            <section class="viewer" id="viewer-pane" aria-label="Editor">
              <div class="viewer-head"><span class="region-label">Editor</span><span id="viewer-title">No file selected</span><div class="editor-actions" id="editor-actions"></div><button class="close-file" id="close-file" aria-label="Close file" hidden>Close</button></div>
              <div class="editor-content">
                <div class="editor-empty" id="editor-empty" tabindex="-1"><span class="empty-symbol" aria-hidden="true">{ }</span><strong>Select a file to start</strong><p>Open a file from Files to view or edit it.</p><button class="quiet-button" id="browse-files">Browse files</button></div>
                <div class="viewer-body" id="viewer" tabindex="-1" hidden></div>
              </div>
            </section>
            <div class="splitter" id="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize editor and terminal" tabindex="0"></div>
            <section class="terminals" aria-label="Terminal">
              <div class="terminal-head"><span class="region-label">Terminal</span><div class="terminal-actions" id="terminal-actions">${terminalActions}</div></div>
              <nav class="tabs" id="tabs" aria-label="Terminal tabs"></nav>
              <div class="terms" id="terms"><div class="empty" id="empty"><strong>No terminals yet</strong><span>Choose New terminal to open a shell.</span></div></div>
            </section>
          </div>
        </div>
      </div>`;
    this.shell = app.querySelector<HTMLElement>(".shell")!;
    this.prefix = options.preferencePrefix;
    this.el("workspace").textContent = options.title;
    this.el("workspace").title = options.title;
    if (options.storage !== undefined) this.storage = options.storage;
    else { try { this.storage = window.localStorage; } catch { this.storage = null; } }
    this.hidden = this.read("sidebar") === "hidden";
    this.width = this.number("sidebarWidth", 15, 0, Infinity);
    this.split = this.number("split", 0.6, 0, 1);
    const signal = this.events.signal;
    this.el("side-toggle").addEventListener("click", () => {
      if (this.narrow.matches) this.setDrawer(!this.drawer);
      else { this.hidden = !this.hidden; this.write("sidebar", this.hidden ? "hidden" : "shown"); this.arrange(); }
    }, { signal });
    this.el("browse-files").addEventListener("click", () => this.showFiles(), { signal });
    this.el("drawer-close").addEventListener("click", () => this.setDrawer(false), { signal });
    this.el("drawer-backdrop").addEventListener("click", () => this.setDrawer(false), { signal });
    this.shell.addEventListener("keydown", (event) => this.drawerKeys(event), { signal });
    this.narrow.addEventListener("change", () => {
      const focusedInFiles = this.el("sidebar").contains(document.activeElement);
      this.setDrawer(false, false);
      this.arrange();
      if (focusedInFiles && (this.narrow.matches || this.hidden || document.activeElement === this.el("drawer-close"))) this.el("side-toggle").focus();
    }, { signal });
    window.addEventListener("resize", () => this.schedule(), { signal });
    this.bindSeparator("sidebar-splitter", "x");
    this.bindSeparator("splitter", "y");
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(this.shell);
    this.observer.observe(this.shell.querySelector<HTMLElement>(".main")!);
    this.observer.observe(this.el("sidebar"));
    this.arrange();
  }

  el<T extends HTMLElement = HTMLElement>(id: string): T { return this.shell.querySelector<T>(`#${id}`)!; }
  requestLayout() { this.schedule(); }
  private key(name: string) { return `${this.prefix}.${name}`; }
  private read(name: string) { try { return this.storage?.getItem(this.key(name)) ?? null; } catch { return null; } }
  private write(name: string, value: string) { try { this.storage?.setItem(this.key(name), value); } catch { /* Layout still works for this visit. */ } }
  private number(name: string, fallback: number, min: number, max: number) {
    const raw = this.read(name);
    const value = raw?.trim() ? Number(raw) : NaN;
    return Number.isFinite(value) && value > min && value < max ? value : fallback;
  }
  private rem() { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; }
  private limits() {
    const body = this.shell.querySelector<HTMLElement>(".body")!;
    const main = this.shell.querySelector<HTMLElement>(".main")!;
    const rem = this.rem();
    const maxWidth = Math.max(11, Math.min(24, (body.clientWidth - 20 * rem - 8) / rem));
    const height = Math.max(1, main.clientHeight - this.el("splitter").offsetHeight);
    const minHeight = Math.min(8 * rem, height * 0.4);
    return { maxWidth, height, minSplit: minHeight / height, maxSplit: 1 - minHeight / height };
  }
  private schedule() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.arrange(); this.onLayout(); });
  }
  private arrange() {
    if (this.disposed) return;
    const narrow = this.narrow.matches;
    const shown = narrow ? this.drawer : !this.hidden;
    this.shell.classList.toggle("narrow", narrow);
    this.shell.classList.toggle("drawer-open", this.drawer);
    this.shell.classList.toggle("no-sidebar", !shown);
    this.el("sidebar").hidden = !shown;
    this.el("sidebar-splitter").hidden = narrow || !shown;
    this.el("drawer-close").hidden = !narrow;
    this.el("drawer-backdrop").hidden = !this.drawer;
    this.el("side-toggle").setAttribute("aria-expanded", String(shown));
    const { maxWidth, height, minSplit, maxSplit } = this.limits();
    const width = clamp(this.width, 11, maxWidth);
    const split = clamp(this.split, minSplit, maxSplit);
    this.shell.style.setProperty("--sidebar-width", `${width}rem`);
    this.shell.style.setProperty("--editor-height", `${height * split}px`);
    this.range(this.el("sidebar-splitter"), 11, maxWidth, width, `${width.toFixed(1)} rem`);
    this.range(this.el("splitter"), minSplit * 100, maxSplit * 100, split * 100, `${Math.round(split * 100)}% editor`);
  }
  private range(el: HTMLElement, min: number, max: number, value: number, text: string) {
    el.setAttribute("aria-valuemin", String(Math.round(min)));
    el.setAttribute("aria-valuemax", String(Math.round(max)));
    el.setAttribute("aria-valuenow", String(Math.round(value)));
    el.setAttribute("aria-valuetext", text);
  }
  private bindSeparator(id: string, axis: "x" | "y") {
    const el = this.el(id);
    const signal = this.events.signal;
    const update = (value: number) => {
      const limits = this.limits();
      if (axis === "x") this.width = clamp(value, 11, limits.maxWidth);
      else this.split = clamp(value, limits.minSplit, limits.maxSplit);
      this.arrange(); this.schedule();
    };
    const persist = () => this.write(axis === "x" ? "sidebarWidth" : "split", String(axis === "x" ? this.width : this.split));
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault(); el.focus(); el.setPointerCapture(event.pointerId);
      this.drag = { el, id: event.pointerId, axis }; el.classList.add("dragging");
    }, { signal });
    el.addEventListener("pointermove", (event) => {
      if (this.drag?.el !== el || this.drag.id !== event.pointerId) return;
      const box = this.shell.querySelector(axis === "x" ? ".body" : ".main")!.getBoundingClientRect();
      update(axis === "x" ? (event.clientX - box.left) / this.rem() : (event.clientY - box.top) / this.limits().height);
    }, { signal });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(event, () => {
      if (this.drag?.el !== el) return;
      const drag = this.drag; this.drag = null; el.classList.remove("dragging");
      if (el.hasPointerCapture(drag.id)) el.releasePointerCapture(drag.id);
      persist();
    }, { signal });
    el.addEventListener("keydown", (event) => {
      const direction = event.key === (axis === "x" ? "ArrowLeft" : "ArrowUp") ? -1 : event.key === (axis === "x" ? "ArrowRight" : "ArrowDown") ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      const bounds = this.limits();
      const current = axis === "x" ? clamp(this.width, 11, bounds.maxWidth) : clamp(this.split, bounds.minSplit, bounds.maxSplit);
      update(current + direction * (axis === "x" ? 0.5 : 0.02) * (event.shiftKey ? 5 : 1));
      persist();
    }, { signal });
  }
  showFiles() {
    if (this.narrow.matches) this.setDrawer(true);
    else { this.hidden = false; this.write("sidebar", "shown"); this.arrange(); this.schedule(); this.focusFile(); }
  }
  private focusFile() {
    (this.el("sidebar").querySelector<HTMLElement>(".tree-row.active, .row.on, .tree-row, .row") ?? this.el("drawer-close")).focus();
  }
  fileSelected() { const focus = this.drawer; this.setDrawer(false, false); return focus; }
  private setDrawer(open: boolean, restore = true) {
    const wasOpen = this.drawer;
    this.drawer = open && this.narrow.matches;
    const sidebar = this.el("sidebar");
    if (this.drawer) { sidebar.setAttribute("role", "dialog"); sidebar.setAttribute("aria-modal", "true"); }
    else { sidebar.removeAttribute("role"); sidebar.removeAttribute("aria-modal"); }
    for (const el of this.shell.querySelectorAll<HTMLElement>(".workspace-head, .preview-bar, .away, .main")) el.inert = this.drawer;
    this.arrange(); this.schedule();
    if (this.drawer) this.focusFile();
    else if (wasOpen && restore) this.el("side-toggle").focus();
  }
  private drawerKeys(event: KeyboardEvent) {
    if (!this.drawer) return;
    if (event.key === "Escape") { event.preventDefault(); this.setDrawer(false); return; }
    if (event.key !== "Tab") return;
    const items = [...this.el("sidebar").querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length > 0);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  dispose() {
    if (this.disposed) return;
    this.setDrawer(false, false);
    this.disposed = true;
    this.events.abort(); this.observer.disconnect(); cancelAnimationFrame(this.frame);
    if (this.drag && this.drag.el.hasPointerCapture(this.drag.id)) this.drag.el.releasePointerCapture(this.drag.id);
    this.drag?.el.classList.remove("dragging"); this.drag = null;
  }
}

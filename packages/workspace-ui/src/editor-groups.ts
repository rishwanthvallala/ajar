import { EditorLayoutModel, readLayout, type EditorGroup, type EditorNode } from "./editor-layout";

export interface EditorGroupView { id: string; element: HTMLElement; content: HTMLElement; title: HTMLElement }
export interface EditorGroupsOptions {
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  key: string;
  /** Existing editor content is adopted into the first group. */
  content: HTMLElement;
}

/** Common tabs, layout, keyboard and pointer interactions. No editor or transport dependency. */
export class EditorGroups {
  readonly model: EditorLayoutModel;
  readonly views = new Map<string, EditorGroupView>();
  readonly root = document.createElement("div");
  readonly switcher = document.createElement("select");
  onSelect = (_group: EditorGroupView, _path: string | null) => {};
  onRemove = (_view: EditorGroupView) => {};
  onChange = () => {};
  onFocusEditor = (_group: EditorGroupView) => {};
  private readonly events = new AbortController();
  private adopted = false;
  private menu: HTMLElement | null = null;
  private dragging: { path: string; group: string } | null = null;
  private selected = new Map<string, string | null>();
  private readonly mac = /Mac|iPhone|iPad/.test(navigator.platform);
  private readonly options: EditorGroupsOptions;
  readonly restored: boolean;

  constructor(host: HTMLElement, options: EditorGroupsOptions) {
    this.options = options;
    let saved: string | null = null;
    try { saved = options.storage?.getItem(options.key) ?? null; } catch { /* Storage is optional. */ }
    const restored = readLayout(saved);
    this.restored = restored !== null;
    this.model = new EditorLayoutModel(restored ?? undefined);
    this.root.className = "editor-groups";
    this.switcher.className = "editor-group-switcher";
    this.switcher.setAttribute("aria-label", "Editor group");
    host.append(this.switcher, this.root);
    const signal = this.events.signal;
    this.switcher.addEventListener("change", () => { this.focus(this.switcher.value); this.focusEditor(); }, { signal });
    host.addEventListener("keydown", e => this.keys(e), { capture: true, signal });
    document.addEventListener("pointerdown", e => { if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu(); }, { signal });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && this.menu) { e.preventDefault(); this.closeMenu(true); } }, { signal });
    addEventListener("blur", () => this.endDrag(), { signal });
    this.render();
  }
  get current() { return this.model.current; }
  get currentView() { return this.views.get(this.current.id)!; }
  get paths() { return new Set(this.model.groups.flatMap(g => g.tabs)); }
  get visiblePaths() {
    const shown = this.root.closest(".shell.narrow") ? [this.current] : this.model.groups;
    return new Set(shown.flatMap(g => g.active ? [g.active] : []));
  }
  open(path: string, group?: string) { this.model.open(path, group); this.render(); }
  close(path = this.current.active, group = this.current.id) { if (path) { this.model.close(path, group); this.render(); } }
  focus(group: string) {
    if (!this.model.group(group)) return;
    const changed = this.current.id !== group;
    this.model.focus(group); this.paintFocus(); this.persist();
    if (changed) this.onSelect(this.currentView, this.current.active);
    this.onChange();
  }
  split(direction: "right" | "down") { this.model.split(direction); this.render(); this.focusEditor(); }
  rename(from: string, to: string) { this.model.rename(from, to); this.render(); }
  prune(exists: (path: string) => boolean) { this.model.prune(exists); this.render(); }
  /** Call after adapters have registered callbacks. */
  refresh() { this.selected.clear(); this.render(); }
  private persist() { try { this.options.storage?.setItem(this.options.key, JSON.stringify(this.model.state)); } catch { /* Keep working without preferences. */ } }
  private focusEditor() { this.onFocusEditor(this.currentView); }
  private button(label: string, action: () => void, text = label) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.title = label; b.setAttribute("aria-label", label);
    b.onclick = action; return b;
  }
  private paintFocus() {
    const list = this.model.groups;
    for (const group of list) {
      const view = this.views.get(group.id)!;
      view.element.classList.toggle("focused", group.id === this.current.id);
      view.element.setAttribute("aria-label", `Editor group ${list.indexOf(group) + 1}`);
      const option = [...this.switcher.options].find(option => option.value === group.id);
      if (option) option.selected = group.id === this.current.id;
    }
    this.switcher.hidden = list.length < 2;
  }
  private render() {
    const wanted = new Set(this.model.groups.map(g => g.id));
    for (const [id, view] of this.views) if (!wanted.has(id)) { this.onRemove(view); view.element.remove(); this.views.delete(id); this.selected.delete(id); }
    const select: Array<[EditorGroupView, string | null]> = [];
    const draw = (node: EditorNode): HTMLElement => {
      if (node.kind === "group") {
        let view = this.views.get(node.id);
        if (!view) {
          const element = document.createElement("section"); element.className = "editor-group"; element.dataset.group = node.id;
          const head = document.createElement("div"); head.className = "editor-group-head";
          const nav = document.createElement("div"); nav.className = "editor-tab-list"; nav.setAttribute("role", "tablist"); nav.setAttribute("aria-label", "Editor tabs");
          const tools = document.createElement("div"); tools.className = "editor-group-actions";
          tools.append(this.button(`Split right (${this.mac ? "⌘" : "Ctrl"}+\\)`, () => { this.focus(node.id); this.split("right"); }, "◫"), this.button("Editor group actions", () => this.showMenu(node.id), "⋯"));
          const content = this.adopted ? document.createElement("div") : this.options.content;
          this.adopted = true; content.classList.add("editor-group-content"); content.id ||= `content-${node.id}`; content.setAttribute("role", "tabpanel");
          const title = document.createElement("span"); title.className = "editor-group-note"; title.setAttribute("role", "status"); title.hidden = true;
          const empty = document.createElement("div"); empty.className = "editor-group-placeholder"; empty.textContent = "Select a file from Files to start";
          head.append(nav, tools); element.append(head, title, content, empty);
          view = { id: node.id, element, content, title }; this.views.set(node.id, view);
          element.onpointerdown = () => this.focus(node.id);
          element.addEventListener("focusin", () => { if (!this.menu) this.focus(node.id); });
          this.bindDrop(view);
        }
        view.element.querySelector<HTMLElement>(".editor-group-placeholder")!.hidden = node.active !== null;
        this.tabs(view, node);
        if (!this.selected.has(node.id) || this.selected.get(node.id) !== node.active) { this.selected.set(node.id, node.active); select.push([view, node.active]); }
        return view.element;
      }
      const box = document.createElement("div"); box.className = `editor-split ${node.direction}`;
      const divider = document.createElement("div"); divider.className = "editor-group-divider"; divider.tabIndex = 0; divider.setAttribute("role", "separator"); divider.setAttribute("aria-label", "Resize editor groups"); divider.setAttribute("aria-orientation", node.direction === "right" ? "vertical" : "horizontal");
      const size = () => {
        box.style.gridTemplateColumns = node.direction === "right" ? `minmax(0, ${node.ratio}fr) 5px minmax(0, ${1 - node.ratio}fr)` : "minmax(0, 1fr)";
        box.style.gridTemplateRows = node.direction === "down" ? `minmax(0, ${node.ratio}fr) 5px minmax(0, ${1 - node.ratio}fr)` : "minmax(0, 1fr)";
        divider.setAttribute("aria-valuemin", "10"); divider.setAttribute("aria-valuemax", "90"); divider.setAttribute("aria-valuenow", String(Math.round(node.ratio * 100)));
      };
      size();
      let pointer: number | null = null;
      divider.onpointerdown = e => { if (e.button !== 0) return; e.preventDefault(); divider.focus(); pointer = e.pointerId; divider.setPointerCapture(e.pointerId); divider.classList.add("dragging"); };
      divider.onpointermove = e => {
        if (pointer !== e.pointerId) return;
        const rect = box.getBoundingClientRect();
        node.ratio = Math.max(.1, Math.min(.9, node.direction === "right" ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height)); size(); this.onChange();
      };
      divider.onlostpointercapture = () => { pointer = null; divider.classList.remove("dragging"); this.persist(); };
      divider.onpointerup = divider.onpointercancel = e => { if (divider.hasPointerCapture(e.pointerId)) divider.releasePointerCapture(e.pointerId); };
      divider.onkeydown = e => {
        const down = node.direction === "down", step = (e.key === (down ? "ArrowUp" : "ArrowLeft") ? -1 : e.key === (down ? "ArrowDown" : "ArrowRight") ? 1 : 0) * (e.shiftKey ? .1 : .02);
        if (!step) return; e.preventDefault(); node.ratio = Math.max(.1, Math.min(.9, node.ratio + step)); size(); this.persist(); this.onChange();
      };
      box.append(draw(node.first), divider, draw(node.second)); return box;
    };
    // Moving existing group elements preserves their editors, iframe state and event handlers.
    const active = document.activeElement as HTMLElement | null;
    this.root.replaceChildren(draw(this.model.state.root));
    this.switcher.replaceChildren(...this.model.groups.map((g, i) => new Option(`Group ${i + 1}${g.active ? ` · ${g.active.split("/").pop()}` : ""}`, g.id)));
    this.paintFocus(); this.persist();
    for (const [view, path] of select) this.onSelect(view, path);
    if (active?.isConnected && active.closest(".editor-group-content") && active.closest<HTMLElement>(".editor-group")?.dataset.group === this.current.id) active.focus({ preventScroll: true });
    this.onChange();
  }
  private tabs(view: EditorGroupView, group: EditorGroup) {
    const nav = view.element.querySelector<HTMLElement>(".editor-tab-list")!;
    nav.replaceChildren();
    for (const path of group.tabs) {
      const item = document.createElement("div"); item.className = `editor-tab${group.active === path ? " active" : ""}`; item.draggable = true; item.dataset.path = path;
      const leaf = path.split("/").pop()!;
      const duplicate = group.tabs.some(other => other !== path && other.split("/").pop() === leaf);
      const label = duplicate ? `${leaf} · ${path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."}` : leaf;
      const tab = this.button(path, () => { this.open(path, group.id); this.focusEditor(); }, label);
      tab.className = "editor-tab-label"; tab.id = `tab-${group.id}-${group.tabs.indexOf(path)}`; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(group.active === path)); tab.setAttribute("aria-controls", view.content.id); tab.tabIndex = group.active === path ? 0 : -1;
      if (group.active === path) view.content.setAttribute("aria-labelledby", tab.id);
      const close = this.button(`Close ${path}`, () => { this.close(path, group.id); this.focusEditor(); }, "×"); close.className = "editor-tab-close";
      item.append(tab, close); nav.append(item);
      item.onauxclick = e => { if (e.button === 1) { e.preventDefault(); this.close(path, group.id); } };
      item.oncontextmenu = e => { e.preventDefault(); this.showMenu(group.id, path, e.clientX, e.clientY); };
      item.ondragstart = e => { this.dragging = { path, group: group.id }; e.dataTransfer!.effectAllowed = "move"; e.dataTransfer!.setData("application/x-ajar-editor-tab", JSON.stringify(this.dragging)); item.classList.add("dragging"); };
      item.ondragend = () => this.endDrag();
      tab.onkeydown = e => {
        const index = group.tabs.indexOf(path), next = e.key === "ArrowLeft" ? (index - 1 + group.tabs.length) % group.tabs.length : e.key === "ArrowRight" ? (index + 1) % group.tabs.length : e.key === "Home" ? 0 : e.key === "End" ? group.tabs.length - 1 : -1;
        if (next >= 0) { e.preventDefault(); this.open(group.tabs[next]!, group.id); this.views.get(group.id)?.element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(); }
        if (e.key === "Delete") { e.preventDefault(); this.close(path, group.id); this.focusEditor(); }
        if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") { e.preventDefault(); this.showMenu(group.id, path); }
      };
    }
    if (!group.tabs.length) { const label = document.createElement("span"); label.className = "editor-tabs-empty"; label.textContent = "Editor"; nav.append(label); }
    requestAnimationFrame(() => nav.querySelector(".editor-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }
  private bindDrop(view: EditorGroupView) {
    view.element.ondragover = e => {
      if (!this.dragging) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer!.dropEffect = "move";
      const rect = view.element.getBoundingClientRect();
      const top = view.element.querySelector(".editor-group-head")!.getBoundingClientRect().bottom;
      const edge = e.clientY >= top && e.clientX > rect.right - rect.width * .23 ? "right" : e.clientY > rect.bottom - rect.height * .23 ? "down" : "center";
      view.element.dataset.drop = edge;
    };
    view.element.ondragleave = e => { if (!view.element.contains(e.relatedTarget as Node | null)) delete view.element.dataset.drop; };
    view.element.ondrop = e => {
      const dragged = this.dragging; if (!dragged) return; e.preventDefault(); e.stopPropagation();
      const edge = view.element.dataset.drop;
      const tab = (e.target as HTMLElement).closest<HTMLElement>(".editor-tab");
      if (edge === "right" || edge === "down") {
        const created = this.model.split(edge, view.id, dragged.path);
        if (created) this.model.close(dragged.path, dragged.group);
      } else this.model.move(dragged.path, dragged.group, view.id, tab ? this.model.group(view.id)!.tabs.indexOf(tab.dataset.path!) : undefined);
      this.endDrag(); this.render(); this.focusEditor();
    };
  }
  private endDrag() { this.dragging = null; for (const view of this.views.values()) { delete view.element.dataset.drop; view.element.querySelectorAll(".dragging").forEach(e => e.classList.remove("dragging")); } }
  private closeMenu(restore = false) { this.menu?.remove(); this.menu = null; if (restore) this.focusEditor(); }
  private showMenu(group: string, path = this.model.group(group)?.active ?? null, x?: number, y?: number) {
    this.closeMenu(); this.focus(group);
    const menu = document.createElement("div"); menu.className = "editor-context-menu"; menu.setAttribute("role", "menu");
    const action = (label: string, fn: () => void) => { const button = this.button(label, () => { this.closeMenu(); fn(); this.focusEditor(); }); button.setAttribute("role", "menuitem"); menu.append(button); };
    const split = (direction: "right" | "down") => { if (path) this.model.open(path, group); this.split(direction); };
    action(`Split right (${this.mac ? "⌘" : "Ctrl"}+\\)`, () => split("right"));
    action(`Split down (${this.mac ? "⌘" : "Ctrl"}+Shift+\\)`, () => split("down"));
    if (this.model.groups.length > 1) action("Close group", () => { this.model.removeGroup(group); this.render(); });
    if (path) {
      action(`Close tab (${this.mac ? "⌘" : "Ctrl"}+W)`, () => this.close(path, group));
      action("Close other tabs", () => { for (const p of [...this.model.group(group)!.tabs]) if (p !== path) this.model.close(p, group); this.render(); });
      action("Close all tabs", () => { for (const p of [...this.model.group(group)!.tabs]) this.model.close(p, group); this.render(); });
      const tabs = this.model.group(group)!.tabs, at = tabs.indexOf(path);
      if (at > 0) action("Move tab left", () => { this.model.move(path, group, group, at - 1); this.render(); });
      if (at < tabs.length - 1) action("Move tab right", () => { this.model.move(path, group, group, at + 2); this.render(); });
      for (const [i, target] of this.model.groups.entries()) if (target.id !== group) action(`Move to group ${i + 1}`, () => { this.model.move(path, group, target.id); this.render(); });
    }
    const box = this.currentView.element.querySelector(".editor-group-head")!.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x ?? box.right - 200, innerWidth - 225))}px`; menu.style.top = `${Math.max(4, Math.min(y ?? box.bottom, innerHeight - 320))}px`;
    document.body.append(menu); this.menu = menu; (menu.firstElementChild as HTMLElement)?.focus();
    menu.onkeydown = e => {
      if (e.key === "Tab") { this.closeMenu(true); return; }
      const items = [...menu.querySelectorAll<HTMLElement>("button")], at = items.indexOf(document.activeElement as HTMLElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) { e.preventDefault(); items[e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    };
  }
  private keys(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest(".editor-group") || (target.closest("input,select,textarea,[contenteditable=true]") && !target.closest(".monaco-editor"))) return;
    const mod = this.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    let action: (() => void) | null = null;
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "w") action = () => this.close();
    if (mod && !e.altKey && (e.code === "Backslash" || e.key === "\\")) action = () => this.split(e.shiftKey ? "down" : "right");
    if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) action = () => { const group = this.model.groups[Number(e.key) - 1]; if (group) this.focus(group.id); };
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && ["PageUp", "PageDown"].includes(e.key)) action = () => { const group = this.current, at = group.tabs.indexOf(group.active ?? ""); const path = group.tabs[(at + (e.key === "PageUp" ? -1 : 1) + group.tabs.length) % group.tabs.length]; if (path) this.open(path); };
    if (action) { e.preventDefault(); e.stopPropagation(); action(); this.focusEditor(); }
  }
  dispose() { this.persist(); this.events.abort(); this.closeMenu(); for (const view of this.views.values()) this.onRemove(view); this.views.clear(); this.root.remove(); this.switcher.remove(); }
}

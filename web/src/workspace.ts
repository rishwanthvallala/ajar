import { WorkspaceShell, EditorGroups, type EditorGroupView, type LayoutStorage } from "@ajar/workspace-ui";
import { formatterFor, usesTabs } from "@ajar/workspace-ui/format";
import { imageType } from "@ajar/workspace-ui/images";
import { isMarkdown } from "@ajar/workspace-ui/markdown";
import type { SearchSurface } from "@ajar/workspace-ui/search";
import type { Viewer, ViewerTools } from "./viewer";
import type * as Monaco from "monaco-editor/editor/editor.api";

export type { LayoutStorage } from "@ajar/workspace-ui";

const APPLE = /Mac|iPhone|iPad/.test(navigator.platform);
/** Shift-Alt-F, as it is written on this machine's keys. */
const FORMAT_KEY = APPLE ? "⇧⌥F" : "Shift+Alt+F";
/** VS Code's key for a Markdown preview. */
const PREVIEW_KEY = APPLE ? "⇧⌘V" : "Ctrl+Shift+V";

/** What the editor does to the file in it: the buttons beside Colours, as the pad has them. */
export interface EditorTools {
  /** All of them, hidden together when an image has the editor's place. */
  all: HTMLElement;
  /** Format the file in the editor; hidden where nothing formats it. */
  format: HTMLButtonElement;
  /** A Markdown file formatted, or not; hidden for other files. */
  markdown: HTMLButtonElement;
  /** The indent, 4 spaces or 2. */
  indent: HTMLButtonElement;
  /** Suggestions as you type, on or off (suggest.ts). */
  suggest: HTMLButtonElement;
}

export class Workspace extends WorkspaceShell {
  readonly editor: EditorPane;
  /** What the shared search panel is drawn on (@ajar/workspace-ui's search.ts). */
  readonly search: SearchSurface;
  readonly tools: EditorTools;

  constructor(app: HTMLElement, title: string, storage?: LayoutStorage | null) {
    super(app, { title, storage, preferencePrefix: "ajar" });
    let preferences = storage;
    if (preferences === undefined) { try { preferences = localStorage; } catch { preferences = null; } }

    // Search shares the sidebar with the files: a magnifier beside Files, and
    // on a phone another at the start of the header, as the pad has them.
    const searchButton = (mobile: boolean) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `icon search-toggle${mobile ? " search-mobile" : ""}`;
      b.setAttribute("aria-label", "Search files and contents");
      b.setAttribute("aria-controls", "project-search");
      b.setAttribute("aria-expanded", "false");
      b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m10 10 3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
      b.onclick = () => this.search.onSearch();
      return b;
    };
    const searchButtons = [searchButton(false), searchButton(true)];
    this.el("sidebar").querySelector(".side-head strong")!.after(searchButtons[0]!);
    this.el("side-toggle").after(searchButtons[1]!);
    const searchHost = document.createElement("section");
    searchHost.id = "project-search";
    searchHost.className = "project-search";
    searchHost.setAttribute("aria-label", "Project search");
    searchHost.hidden = true;
    this.el("tree").after(searchHost);
    this.search = {
      shell: this,
      searchHost,
      searchButtons,
      onSearch: () => {},
      showSearch: (open) => {
        this.el("tree").hidden = open;
        searchHost.hidden = !open;
        this.el("sidebar").setAttribute("aria-label", open ? "Files and search" : "Files");
        for (const b of searchButtons) b.setAttribute("aria-expanded", String(open));
        if (open) this.showFiles();
        this.requestLayout();
      },
    };

    // Quiet beside Colours, as an editor's status bar has them: no more than
    // a word each until wanted.
    const all = document.createElement("span");
    all.className = "editor-tools";
    const tool = (id: string, label: string) => {
      const element = document.createElement("button");
      element.type = "button";
      element.id = id;
      element.className = "editor-tool";
      element.textContent = label;
      return element;
    };
    const format = tool("format-file", "Format");
    format.hidden = true;
    const markdown = tool("markdown-view", "Preview");
    markdown.hidden = true;
    markdown.setAttribute("aria-pressed", "false");
    const indent = tool("indent", "Spaces: 4");
    // Shown by suggest.ts once the editor is up and it knows there is a model.
    const suggest = tool("suggest", "Suggest");
    suggest.hidden = true;
    all.append(format, markdown, indent, suggest);
    this.el("editor-actions").append(all);
    this.tools = { all, format, markdown, indent, suggest };
    // A tab's own cross closes it, as in the pad: no second way beside the tools.
    this.el("close-file").hidden = true;

    this.editor = new EditorPane(this.shell, () => this.highlight, preferences, `ajar.editors.${title}`, this.tools);
    this.onHighlightChange = () => { for (const v of this.editor.viewers.values()) v.highlightChanged(); };
  }
  override dispose() { this.editor.dispose(); super.dispose(); }
}

interface FileStatus { text?: string; truncated: boolean; readOnly: boolean; note?: string; problem?: string }

/** What the pane asks of the session it is in. */
export interface PaneHooks {
  /** Said to the person: a passing note, or what went wrong. */
  say(text: string, kind?: "ok" | "error"): void;
  /** What `path` is in the folder, if anything. */
  kind(path: string): "file" | "dir" | null;
  /** Whether the host can send a file's bytes to look at: without it, an image is a file that will not open. */
  viewable(): boolean;
  /** A file's bytes, as a `data:` URL of its type; why not, when they cannot be had. */
  bytes(path: string, type: string): Promise<{ url: string; bytes: number } | { why: string }>;
  /** The file as itself, saved by the browser. */
  download(path: string): void;
}

/** Lazy Monaco views in shared editor groups, backed by one model per file. */
export class EditorPane {
  readonly groups: EditorGroups;
  readonly viewers = new Map<string, Viewer>();
  readonly models = new Map<string, Monaco.editor.ITextModel>();
  private readonly files = new Map<string, FileStatus>();
  private readonly versions = new Map<string, number>();
  private readonly savedViews = new Map<string, Monaco.editor.ICodeEditorViewState>();
  private module: Promise<typeof import("./viewer")> | null = null;
  private disposed = false;
  private pendingFocus: string | null = null;
  /** A place to put the cursor once the file being opened is on screen. */
  private pendingReveal: { path: string; line: number; column?: number; length?: number } | null = null;
  onSelect = (_path: string | null) => {};
  onViews = () => {};
  private storage: LayoutStorage | null;
  private stateKey: string;
  /** 4 spaces or 2: this browser's, like the theme. */
  private indent: 2 | 4 = 4;
  /** The Markdown files shown formatted, in this session in this browser. */
  private readonly formatted = new Set<string>();
  private hooks: PaneHooks = { say: () => {}, kind: () => null, viewable: () => false, bytes: async () => ({ why: "not available" }), download: () => {} };
  private readonly viewerTools: ViewerTools;
  private readonly events = new AbortController();
  /** The editor suggestions are attached to. */
  private suggesting: Monaco.editor.IStandaloneCodeEditor | null = null;

  constructor(private root: HTMLElement, private highlight: () => boolean = () => true, storage: LayoutStorage | null = null, key = "ajar.editors.preview", private tools: EditorTools | null = null) {
    this.storage = storage; this.stateKey = `${key}.views`;
    try { const values = JSON.parse(storage?.getItem(this.stateKey) ?? "{}"); for (const [k, v] of Object.entries(values)) this.savedViews.set(k, v as Monaco.editor.ICodeEditorViewState); } catch { /* Optional preferences. */ }
    try { if (storage?.getItem("ajar.indent") === "2") this.indent = 2; } catch { /* Four, then. */ }
    try { const paths = JSON.parse(storage?.getItem(`${key}.markdown`) ?? "[]"); if (Array.isArray(paths)) for (const p of paths) if (typeof p === "string") this.formatted.add(p); } catch { /* None, then. */ }
    this.viewerTools = {
      indent: () => this.indent,
      formatted: (path) => this.formatted.has(path),
      setFormatted: (path, on) => this.setFormatted(path, on),
      say: (text, kind) => this.hooks.say(text, kind),
      changed: () => this.paintTools(),
      image: async (path) => {
        const type = imageType(path) ?? (path.toLowerCase().endsWith(".svg") ? "image/svg+xml" : null);
        if (!type || !this.hooks.viewable()) return null;
        const got = await this.hooks.bytes(path, type);
        return "url" in got ? got.url : null;
      },
      kind: (path) => this.hooks.kind(path),
      open: (path) => { void this.open(path).then(() => this.focus()); },
    };
    const host = this.el("viewer"), content = document.createElement("div");
    content.className = "viewer-body";
    host.hidden = false; host.classList.add("has-editor-groups");
    host.parentElement!.classList.add("has-editor-groups");
    this.groups = new EditorGroups(host, { content, storage, key });
    this.groups.onSelect = (view, path) => { if (this.viewers.get(view.id)?.current !== path) void this.select(view, path); if (view.id === this.groups.current.id) this.onSelect(path); };
    this.groups.onFocusEditor = view => {
      const viewer = this.viewers.get(view.id);
      if (viewer?.imageShown) { this.pendingFocus = null; view.element.focus(); }
      else if (viewer?.handles) { this.pendingFocus = null; viewer.handles.editor.focus(); }
      else this.pendingFocus = view.id;
    };
    this.groups.onRemove = view => { this.saveView(view.id); this.viewers.get(view.id)?.dispose(); this.viewers.delete(view.id); this.versions.delete(view.id); };
    this.groups.onChange = () => { this.chrome(); this.onViews(); };
    if (tools) {
      tools.format.onclick = () => void this.viewer?.format();
      tools.indent.onclick = () => this.setIndent(this.indent === 4 ? 2 : 4);
      tools.markdown.onclick = () => this.toggleMarkdown();
    }
    // VS Code's key for a Markdown preview, anywhere on the page.
    addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "v" && this.path && isMarkdown(this.path)) {
        e.preventDefault();
        this.toggleMarkdown();
      }
    }, { signal: this.events.signal });
    this.chrome();
  }
  /** What the session gives the pane: its voice, its files, a file's bytes. */
  use(hooks: PaneHooks) { this.hooks = hooks; this.paintTools(); }
  private el(id: string) { return this.root.querySelector<HTMLElement>(`#${id}`)!; }
  get viewer() { return this.viewers.get(this.groups.current.id) ?? null; }
  get path() { return this.groups.current.active; }
  load() { return this.module ??= import("./viewer").catch(error => { this.module = null; throw error; }); }
  /** Whether `path` is shown as a picture rather than opened as text: an image, where the host can send its bytes. */
  image(path: string) { return imageType(path) !== null && this.hooks.viewable(); }
  private saveView(id: string) {
    const viewer = this.viewers.get(id), path = viewer?.current, state = viewer?.saveState();
    if (path && state) this.savedViews.set(`${id}:${path}`, state);
  }
  private chrome() {
    const file = this.path ? this.files.get(this.path) : null;
    const note = file?.problem ? `${file.problem} — not saved, read-only` : file?.note ?? (file?.truncated ? "truncated at 1 MB" : "");
    this.el("viewer-title").textContent = this.path ? `${this.path}${note ? ` · ${note}` : ""}` : "No file selected";
    this.el("viewer-title").title = this.path ?? "";
    this.el("editor-empty").hidden = !!this.path || this.groups.model.groups.length > 1;
    this.el("viewer-pane").setAttribute("aria-label", this.path && this.viewer?.imageShown === this.path ? "Image" : "Editor");
    this.paintTools();
  }

  // ------------------------------------------------------------- the tools

  /** Format, Preview and the indent, for the file in the editor in front. */
  private paintTools() {
    const tools = this.tools;
    if (!tools) return;
    const viewer = this.viewer, path = this.path ?? "";
    const image = !!viewer?.imageShown;
    tools.all.hidden = image;
    this.el("highlight-toggle").hidden = image;
    const formatter = viewer?.formatter ?? null;
    tools.format.hidden = formatter === null;
    tools.format.disabled = viewer?.formatting ?? false;
    tools.format.textContent = viewer?.formatting ? "Formatting…" : "Format";
    if (formatter) tools.format.title = `Format this file with ${formatterFor(path)?.name} (${FORMAT_KEY})`;
    const markdown = path !== "" && isMarkdown(path) && !image;
    const on = markdown && this.formatted.has(path);
    tools.markdown.hidden = !markdown;
    tools.markdown.classList.toggle("on", on);
    tools.markdown.setAttribute("aria-pressed", String(on));
    tools.markdown.title = on ? `Hide the formatted view (${PREVIEW_KEY})` : `See this file formatted, as it will look (${PREVIEW_KEY})`;
    const other = this.indent === 4 ? 2 : 4;
    const tabs = path !== "" && usesTabs(path);
    tools.indent.textContent = tabs ? `Tab size: ${this.indent}` : `Spaces: ${this.indent}`;
    tools.indent.title = tabs
      ? `This file is indented with tabs, shown ${this.indent} wide — show them ${other} wide`
      : `Indenting with ${this.indent} spaces, in every file — switch to ${other}`;
    viewer?.paintTools();
    // Suggestions go with the editor in front.
    const editor = viewer?.handles?.editor;
    if (editor && editor !== this.suggesting) {
      this.suggesting = editor;
      void this.load().then(({ suggestIn }) => { if (!this.disposed && this.suggesting === editor) suggestIn(editor, tools.suggest); }).catch(() => {});
    }
  }

  /** 4 spaces or 2: for every file open here, and for this browser from now on. */
  private setIndent(size: 2 | 4) {
    this.indent = size;
    try { this.storage?.setItem("ajar.indent", String(size)); } catch { /* For this visit, then. */ }
    void this.load().then(({ reindent }) => { if (!this.disposed) reindent(this.models, size); }).catch(() => {});
    for (const viewer of this.viewers.values()) viewer.paintStarter();
    this.paintTools();
    // What is written already keeps its indent until it is formatted.
    this.hooks.say(`Indenting with ${size} spaces — Format re-indents a file`);
  }

  private setFormatted(path: string, on: boolean) {
    if (on) this.formatted.add(path); else this.formatted.delete(path);
    try { this.storage?.setItem(`${this.stateKey.replace(/\.views$/, "")}.markdown`, JSON.stringify([...this.formatted].slice(-200))); } catch { /* For this visit, then. */ }
    for (const viewer of this.viewers.values()) if (viewer.current === path) viewer.paintMarkdown();
    this.paintTools();
  }

  private toggleMarkdown() {
    const path = this.path;
    if (!path || !isMarkdown(path)) return;
    this.setFormatted(path, !this.formatted.has(path));
  }

  // ------------------------------------------------------------- the files

  private async select(view: EditorGroupView, path: string | null) {
    this.saveView(view.id);
    const version = (this.versions.get(view.id) ?? 0) + 1; this.versions.set(view.id, version);
    this.viewers.get(view.id)?.clear();
    view.content.hidden = !path; view.title.hidden = true;
    if (!path) { this.chrome(); return; }
    view.content.setAttribute("aria-busy", "true");
    try {
      const { Viewer } = await this.load();
      if (this.disposed || this.versions.get(view.id) !== version || !this.groups.views.has(view.id)) return;
      let viewer = this.viewers.get(view.id);
      if (!viewer) { viewer = new Viewer(view.content, view.title, this.highlight, this.models, this.viewerTools); this.viewers.set(view.id, viewer); }
      viewer.opening(path);
      if (this.image(path)) { void this.paintImage(viewer, view, path); this.chrome(); this.onViews(); return; }
      const file = this.files.get(path), model = this.models.get(path);
      // Kept across the paint, which shows it and then has where the file
      // was left put back over it just below.
      const reveal = this.pendingReveal;
      if (file || model) this.paint(viewer, path, file ?? { truncated: false, readOnly: true });
      const back = this.savedViews.get(`${view.id}:${path}`);
      if (back) { try { viewer.restoreState(back); } catch { this.savedViews.delete(`${view.id}:${path}`); } }
      if (reveal?.path === path) this.pendingReveal = reveal;
      this.revealPending(viewer);
      this.onViews();
    } catch (error) {
      console.error(error); view.title.textContent = `${path} · Couldn't load the editor. Select the file to retry.`; view.title.hidden = false;
    } finally { view.content.removeAttribute("aria-busy"); }
  }
  /** A picture in the editor's place: its bytes asked of the host, and until they come, a word saying so. */
  private async paintImage(viewer: Viewer, view: EditorGroupView, path: string) {
    const download = () => this.hooks.download(path);
    viewer.imageNote(path, `Fetching ${path}…`, null);
    const got = await this.hooks.bytes(path, imageType(path)!);
    if (this.disposed || viewer.current !== path) return;
    if ("url" in got) viewer.showImage(path, got.url, got.bytes, download);
    else viewer.imageNote(path, `${path} could not be shown: ${got.why}`, download);
    if (this.pendingFocus === view.id && this.groups.current.id === view.id) { this.pendingFocus = null; view.element.focus(); }
    this.chrome();
  }
  private paint(viewer: Viewer, path: string, file: FileStatus) {
    const first = viewer.shownPath !== path;
    viewer.show(path, this.models.get(path)?.getValue() ?? file.text ?? "", file.truncated, file.readOnly, file.note);
    if (file.problem) viewer.stranded(path, file.problem);
    const group = [...this.viewers].find(([, v]) => v === viewer)?.[0], note = group ? this.groups.views.get(group)?.title : null;
    if (note) note.hidden = !file.note && !file.problem && !file.truncated;
    if (this.pendingFocus === group && this.groups.current.id === group && viewer.handles) { this.pendingFocus = null; viewer.handles.editor.focus(); }
    if (first && group) {
      const state = this.savedViews.get(`${group}:${path}`);
      if (state) { try { viewer.restoreState(state); } catch { this.savedViews.delete(`${group}:${path}`); } }
    }
    this.revealPending(viewer);
  }
  /**
   * The cursor put where a link or a search's result pointed, once that file
   * is the one on screen. After the place it was left at is put back, not
   * before: restored second, that place won, and a result on line 4 opened
   * its file on line 11.
   */
  private revealPending(viewer: Viewer | null) {
    const reveal = this.pendingReveal;
    if (!reveal || !viewer || viewer !== this.viewer || viewer.shownPath !== reveal.path) return;
    this.pendingReveal = null;
    viewer.reveal(reveal.line, reveal.column, reveal.length);
  }
  async open(path: string): Promise<Viewer | null> {
    this.groups.open(path);
    const view = this.groups.currentView;
    if (this.viewer?.current !== path) await this.select(view, path);
    return this.viewer?.current === path ? this.viewer : null;
  }
  /**
   * A file opened with the cursor on a line of it: where a link in a
   * terminal's output, or a search's result, points. The file's text may be
   * a moment behind the tab — it comes from the host — so the place is kept
   * until it is on screen.
   */
  async openAt(path: string, line: number, column?: number, length?: number) {
    this.pendingReveal = { path, line, column, length };
    const viewer = await this.open(path);
    this.revealPending(viewer);
    this.focus();
  }
  async show(path: string, text: string, truncated = false, readOnly = true, note?: string) {
    const { fileModel, updateFileModel } = await this.load();
    if (this.disposed) return null;
    let model = this.models.get(path);
    if (!model) { model = fileModel(path, text, this.highlight(), this.indent); this.models.set(path, model); }
    else updateFileModel(model, text);
    const file = { truncated, readOnly, note }; this.files.set(path, file);
    for (const viewer of this.viewers.values()) if (viewer.current === path) this.paint(viewer, path, file);
    this.chrome(); this.onViews(); return model;
  }
  problem(path: string, message: string) {
    this.files.set(path, { truncated: false, readOnly: true, problem: message });
    for (const viewer of this.viewers.values()) if (viewer.current === path) viewer.problem(path, message);
    this.chrome();
  }
  stranded(path: string, why: string) {
    const file = this.files.get(path) ?? { truncated: false, readOnly: true };
    file.problem = why; file.readOnly = true; this.files.set(path, file);
    for (const viewer of this.viewers.values()) if (viewer.current === path) this.paint(viewer, path, file);
    this.chrome();
  }
  setReadOnly(path: string, value: boolean) {
    const file = this.files.get(path); if (file) file.readOnly = value;
    for (const viewer of this.viewers.values()) if (viewer.current === path) viewer.setReadOnly(value);
  }
  forget(path: string) { this.files.delete(path); this.models.get(path)?.dispose(); this.models.delete(path); }
  /** A picture changed on the host, or the host can now send it: shown again from its bytes. */
  refreshImages(path?: string) {
    for (const [id, viewer] of this.viewers) {
      const current = viewer.current;
      const view = this.groups.views.get(id);
      if (current && view && (!path || current === path) && this.image(current)) void this.paintImage(viewer, view, current);
    }
  }
  close() { this.groups.close(); }
  focus() {
    if (this.viewer?.handles && !this.viewer.imageShown) return this.viewer.handles.editor.focus();
    // Its text has yet to come from the host: the tab has the keyboard until
    // it does, and then the editor takes it.
    if (this.path && !this.image(this.path)) this.pendingFocus = this.groups.current.id;
    this.groups.currentView.element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }
  layout() { for (const viewer of this.viewers.values()) viewer.layout(); this.onViews(); }
  dispose() {
    if (this.disposed) return;
    for (const id of this.viewers.keys()) this.saveView(id);
    try { this.storage?.setItem(this.stateKey, JSON.stringify(Object.fromEntries(this.savedViews))); } catch { /* Optional preferences. */ }
    this.disposed = true; this.events.abort(); this.groups.dispose();
    void this.module?.then(({ forgetSuggestions }) => forgetSuggestions()).catch(() => {});
    for (const model of this.models.values()) model.dispose(); this.models.clear();
  }
}

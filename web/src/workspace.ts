import { WorkspaceShell, EditorGroups, type EditorGroupView, type LayoutStorage } from "@ajar/workspace-ui";
import type { Viewer } from "./viewer";
import type * as Monaco from "monaco-editor/editor/editor.api";

export type { LayoutStorage } from "@ajar/workspace-ui";

export class Workspace extends WorkspaceShell {
  readonly editor: EditorPane;
  constructor(app: HTMLElement, title: string, storage?: LayoutStorage | null) {
    super(app, { title, storage, preferencePrefix: "ajar" });
    let preferences = storage;
    if (preferences === undefined) { try { preferences = localStorage; } catch { preferences = null; } }
    this.editor = new EditorPane(this.shell, () => this.highlight, preferences, `ajar.editors.${title}`);
    this.onHighlightChange = () => { for (const v of this.editor.viewers.values()) v.highlightChanged(); };
  }
  override dispose() { this.editor.dispose(); super.dispose(); }
}

interface FileStatus { text?: string; truncated: boolean; readOnly: boolean; note?: string; problem?: string }
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
  onSelect = (_path: string | null) => {};
  onViews = () => {};
  private storage: LayoutStorage | null;
  private stateKey: string;
  constructor(private root: HTMLElement, private highlight: () => boolean = () => true, storage: LayoutStorage | null = null, key = "ajar.editors.preview") {
    this.storage = storage; this.stateKey = `${key}.views`;
    try { const values = JSON.parse(storage?.getItem(this.stateKey) ?? "{}"); for (const [k, v] of Object.entries(values)) this.savedViews.set(k, v as Monaco.editor.ICodeEditorViewState); } catch { /* Optional preferences. */ }
    const host = this.el("viewer"), content = document.createElement("div");
    content.className = "viewer-body";
    host.hidden = false; host.classList.add("has-editor-groups");
    host.parentElement!.classList.add("has-editor-groups");
    this.groups = new EditorGroups(host, { content, storage, key });
    this.groups.onSelect = (view, path) => { if (this.viewers.get(view.id)?.current !== path) void this.select(view, path); if (view.id === this.groups.current.id) this.onSelect(path); };
    this.groups.onFocusEditor = view => {
      const viewer = this.viewers.get(view.id);
      if (viewer?.handles) { this.pendingFocus = null; viewer.handles.editor.focus(); }
      else this.pendingFocus = view.id;
    };
    this.groups.onRemove = view => { this.saveView(view.id); this.viewers.get(view.id)?.dispose(); this.viewers.delete(view.id); this.versions.delete(view.id); };
    this.groups.onChange = () => { this.chrome(); this.onViews(); };
    this.chrome();
  }
  private el(id: string) { return this.root.querySelector<HTMLElement>(`#${id}`)!; }
  get viewer() { return this.viewers.get(this.groups.current.id) ?? null; }
  get path() { return this.groups.current.active; }
  load() { return this.module ??= import("./viewer").catch(error => { this.module = null; throw error; }); }
  private saveView(id: string) {
    const viewer = this.viewers.get(id), path = viewer?.current, state = viewer?.saveState();
    if (path && state) this.savedViews.set(`${id}:${path}`, state);
  }
  private chrome() {
    const file = this.path ? this.files.get(this.path) : null;
    const note = file?.problem ? `${file.problem} — not saved, read-only` : file?.note ?? (file?.truncated ? "truncated at 1 MB" : "");
    this.el("viewer-title").textContent = this.path ? `${this.path}${note ? ` · ${note}` : ""}` : "No file selected";
    this.el("viewer-title").title = this.path ?? "";
    this.el("close-file").hidden = !this.path;
    this.el("editor-empty").hidden = !!this.path || this.groups.model.groups.length > 1;
  }
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
      if (!viewer) { viewer = new Viewer(view.content, view.title, this.highlight, this.models); this.viewers.set(view.id, viewer); }
      viewer.opening(path);
      const file = this.files.get(path), model = this.models.get(path);
      if (file || model) this.paint(viewer, path, file ?? { truncated: false, readOnly: true });
      const back = this.savedViews.get(`${view.id}:${path}`);
      if (back) { try { viewer.restoreState(back); } catch { this.savedViews.delete(`${view.id}:${path}`); } }
      this.onViews();
    } catch (error) {
      console.error(error); view.title.textContent = `${path} · Couldn't load the editor. Select the file to retry.`; view.title.hidden = false;
    } finally { view.content.removeAttribute("aria-busy"); }
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
  }
  async open(path: string): Promise<Viewer | null> {
    this.groups.open(path);
    const view = this.groups.currentView;
    if (this.viewer?.current !== path) await this.select(view, path);
    return this.viewer?.current === path ? this.viewer : null;
  }
  async show(path: string, text: string, truncated = false, readOnly = true, note?: string) {
    const { fileModel, updateFileModel } = await this.load();
    if (this.disposed) return null;
    let model = this.models.get(path);
    if (!model) { model = fileModel(path, text, this.highlight()); this.models.set(path, model); }
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
  close() { this.groups.close(); }
  focus() { if (this.viewer?.handles) this.viewer.handles.editor.focus(); else this.groups.currentView.element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(); }
  layout() { for (const viewer of this.viewers.values()) viewer.layout(); this.onViews(); }
  dispose() {
    if (this.disposed) return;
    for (const id of this.viewers.keys()) this.saveView(id);
    try { this.storage?.setItem(this.stateKey, JSON.stringify(Object.fromEntries(this.savedViews))); } catch { /* Optional preferences. */ }
    this.disposed = true; this.groups.dispose();
    for (const model of this.models.values()) model.dispose(); this.models.clear();
  }
}

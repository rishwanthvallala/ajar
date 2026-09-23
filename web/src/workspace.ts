import { WorkspaceShell, type LayoutStorage } from "@ajar/workspace-ui";
import type { Viewer } from "./viewer";

export type { LayoutStorage } from "@ajar/workspace-ui";

/** Ajar adapter: the shared shell plus Ajar's lazy collaborative editor. */
export class Workspace extends WorkspaceShell {
  readonly editor: EditorPane;

  constructor(app: HTMLElement, title: string, storage?: LayoutStorage | null) {
    super(app, { title, storage, preferencePrefix: "ajar" });
    this.editor = new EditorPane(this.shell);
  }

  override dispose() {
    this.editor.dispose();
    super.dispose();
  }
}

/** Lazy editor loading and stale-selection protection shared by live sessions and preview. */
export class EditorPane {
  viewer: Viewer | null = null;
  path: string | null = null;
  private version = 0;
  private loading: Promise<Viewer> | null = null;
  private disposed = false;

  constructor(private root: HTMLElement) {}

  private el(id: string) { return this.root.querySelector<HTMLElement>(`#${id}`)!; }

  async open(path: string): Promise<Viewer | null> {
    if (this.disposed) return null;
    const version = ++this.version;
    this.path = path;
    this.viewer?.clear();
    this.el("editor-empty").hidden = true;
    this.el("viewer").hidden = false;
    this.el("viewer").setAttribute("aria-busy", "true");
    this.el("viewer-title").textContent = path;
    this.el("viewer-title").title = path;
    this.el("close-file").hidden = false;
    try {
      this.loading ??= import("./viewer").then(({ Viewer }) => new Viewer(this.el("viewer"), this.el("viewer-title")));
      const viewer = await this.loading;
      if (this.disposed) { viewer.dispose(); return null; }
      this.viewer = viewer;
      if (version !== this.version) return null;
      viewer.opening(path);
      return viewer;
    } catch {
      this.loading = null;
      if (version === this.version && !this.disposed) this.el("viewer-title").textContent = `${path} · Couldn't load the editor. Select the file to retry.`;
      return null;
    } finally {
      if (version === this.version) this.el("viewer").removeAttribute("aria-busy");
    }
  }

  close() {
    ++this.version;
    this.path = null;
    this.viewer?.clear();
    this.el("editor-empty").hidden = false;
    this.el("viewer").hidden = true;
    this.el("viewer").removeAttribute("aria-busy");
    this.el("viewer-title").textContent = "No file selected";
    this.el("viewer-title").title = "";
    this.el("viewer-title").classList.remove("problem");
    this.el("close-file").hidden = true;
  }

  focus() {
    if (this.viewer?.handles) this.viewer.handles.editor.focus();
    else this.el(this.path ? "viewer" : "editor-empty").focus();
  }

  dispose() {
    this.close();
    this.disposed = true;
    this.viewer?.dispose();
  }
}

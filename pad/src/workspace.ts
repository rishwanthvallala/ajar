import { WorkspaceShell, type LayoutStorage } from "@ajar/workspace-ui";

const RUN_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5l7 4.5-7 4.5V3.5Z" fill="currentColor"/></svg>`;
const PREVIEW_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v7A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2 6h12" stroke="currentColor" stroke-width="1.2"/></svg>`;
const SHARE_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5a2.5 2.5 0 0 0 3.6.1l2.2-2.2a2.5 2.5 0 0 0-3.5-3.5l-1 1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M9.5 6.5a2.5 2.5 0 0 0-3.6-.1L3.7 8.6a2.5 2.5 0 0 0 3.5 3.5l1-1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;

export interface PadElements {
  files: HTMLElement;
  editor: HTMLElement;
  terminal: HTMLElement;
  run: HTMLButtonElement;
  share: HTMLButtonElement;
  preview: HTMLButtonElement;
  backToEditor: HTMLButtonElement;
  previewPane: HTMLElement;
  status: HTMLElement;
  presence: HTMLElement;
  title: HTMLElement;
}

function button(id: string, label: string, icon: string, title: string, primary = false) {
  const element = document.createElement("button");
  element.id = id;
  element.className = `pad-action${primary ? " primary" : ""}`;
  element.title = title;
  element.innerHTML = `${icon}<span>${label}</span>`;
  return element;
}

/** Pad's product controls and tool hosts mounted into the shared workspace shell. */
export class PadWorkspace {
  readonly shell: WorkspaceShell;
  readonly elements: PadElements;

  constructor(root: HTMLElement, title: string, storage?: LayoutStorage | null) {
    this.shell = new WorkspaceShell(root, {
      title,
      storage,
      preferencePrefix: "pad",
      terminalActions: false,
    });
    this.shell.shell.classList.add("pad-shell");

    const titleText = document.createElement("span");
    titleText.id = "title";
    titleText.textContent = title;
    this.shell.el("workspace").replaceChildren(titleText);

    const presence = document.createElement("span");
    presence.id = "presence";
    presence.className = "presence";
    this.shell.el("people").replaceChildren(presence);

    const run = button("run", "Run", RUN_ICON, "Run this file (⌘⏎)", true);
    const preview = button("preview", "Preview", PREVIEW_ICON, "Open the server running in this folder");
    preview.hidden = true;
    const share = button("share", "Share", SHARE_ICON, "Copy the link");
    this.shell.el("workspace-actions").append(run, preview, share);

    const backToEditor = button("back-to-editor", "Back to editor", "", "Return to the editor");
    backToEditor.hidden = true;
    this.shell.el("editor-actions").append(backToEditor);
    this.shell.el("close-file").hidden = true;

    const files = this.shell.el("tree");
    files.id = "files";
    files.className = "files";

    this.shell.el("editor-empty").hidden = true;
    const viewer = this.shell.el("viewer");
    viewer.hidden = false;
    const editor = document.createElement("div");
    editor.id = "editor";
    editor.className = "editor";
    const previewPane = document.createElement("div");
    previewPane.id = "preview-pane";
    previewPane.className = "preview";
    previewPane.hidden = true;
    viewer.replaceChildren(editor, previewPane);

    const terms = this.shell.el("terms");
    this.shell.el("empty").remove();
    const terminal = document.createElement("div");
    terminal.id = "terminal";
    terminal.className = "terminal";
    terms.append(terminal);

    this.shell.el("status").textContent = "opening…";
    this.shell.el("viewer-title").textContent = "No file selected";
    this.elements = {
      files,
      editor,
      terminal,
      run,
      share,
      preview,
      backToEditor,
      previewPane,
      status: this.shell.el("status"),
      presence,
      title: titleText,
    };
  }

  setActiveFile(path: string) {
    const title = this.shell.el("viewer-title");
    title.textContent = path || "No file selected";
    title.title = path;
  }

  setFileCount(count: number) {
    this.shell.el("filecount").textContent = `${count} ${count === 1 ? "file" : "files"}`;
  }

  setPreview(open: boolean) {
    this.elements.preview.classList.toggle("on", open);
    this.elements.backToEditor.hidden = !open;
    this.shell.el("viewer-pane").setAttribute("aria-label", open ? "Server preview" : "Editor");
    this.shell.el("viewer-title").textContent = open ? "Server preview" : this.elements.editor.dataset.active ?? "No file selected";
    this.shell.requestLayout();
  }

  fileSelected() { return this.shell.fileSelected(); }
  onLayout(callback: () => void) { this.shell.onLayout = callback; }
  dispose() { this.shell.dispose(); }
}

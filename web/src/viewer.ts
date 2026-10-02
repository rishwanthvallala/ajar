// The core editor plus Monarch tokenizers, rather than `monaco-editor`'s
// index. That index also pulls in the TypeScript, JSON, HTML and CSS language
// services and their web workers — roughly nine megabytes of them — which can
// never run here: `MonacoEnvironment.getWorker` below returns the editor
// worker for every request, so nothing else is ever instantiated. Highlighting
// comes from the basic-languages contribution and needs no worker at all.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
import { defineEditorThemes, editorTheme, languageFor, onThemeChange, registerDelimited } from "@ajar/workspace-ui";
import { codeFontPx } from "./scale";
// monaco-editor 0.56 exposes workers through its exports map, which rewrites
// `./editor/…` to `./esm/vs/editor/…`. Importing the esm path directly
// resolves to a doubled prefix and fails only at build time.
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

/**
 * Read-only Monaco.
 *
 * It looks like overkill for a release with no editing, but building the
 * viewer in something lighter would mean writing it twice — v1 turns editing
 * on by binding a CRDT to this exact instance.
 *
 * Only the base editor worker is loaded. The TypeScript and JSON language
 * workers arrive with editing, since read-only highlighting is Monarch and
 * runs on the main thread anyway.
 */
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

// Once, as this module loads: CSV and TSV, which Monaco has no tokenizer for,
// and the editor's light and dark themes with their column colours.
registerDelimited(monaco.languages);
defineEditorThemes(monaco.editor);

export class Viewer {
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private path: string | null = null;
  private readonly events = new AbortController();

  constructor(
    private host: HTMLElement,
    private titleEl: HTMLElement,
    /** Whether the workspace has syntax colours switched on. */
    private highlight: () => boolean = () => true,
  ) {
    onThemeChange(() => monaco.editor.setTheme(editorTheme()), this.events.signal);
  }

  /** The file's language, or plain text while colours are switched off. */
  private languageOf(path: string): string {
    return this.highlight() ? languageFor(monaco.languages.getLanguages(), path) : "plaintext";
  }

  /** Colours switched on or off: the open file follows at once. */
  highlightChanged() {
    const model = this.editor?.getModel();
    if (model && this.path) monaco.editor.setModelLanguage(model, this.languageOf(this.path));
  }

  /** The file whose content we're waiting for or showing. */
  get current(): string | null {
    return this.path;
  }

  opening(path: string) {
    this.path = path;
    this.titleEl.textContent = path;
    this.titleEl.classList.remove("problem");
    this.titleEl.title = path;
  }

  /** The live editor and model, once something has been opened. */
  get handles(): { editor: monaco.editor.IStandaloneCodeEditor; model: monaco.editor.ITextModel } | null {
    const model = this.editor?.getModel();
    return this.editor && model ? { editor: this.editor, model } : null;
  }

  setReadOnly(readOnly: boolean) {
    this.editor?.updateOptions({ readOnly });
  }

  show(path: string, text: string, truncated: boolean, readOnly = true) {
    // A slow read for a file the user has already navigated away from.
    if (path !== this.path) return;

    const model = monaco.editor.createModel(text, this.languageOf(path));
    if (!this.editor) {
      this.editor = monaco.editor.create(this.host, {
        model,
        readOnly,
        automaticLayout: true,
        theme: editorTheme(),
        fontSize: codeFontPx(),
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        fontFamily:
          'ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, Consolas, monospace',
      });
    } else {
      const previous = this.editor.getModel();
      this.editor.setModel(model);
      previous?.dispose();
      this.editor.updateOptions({ readOnly });
    }

    this.titleEl.textContent = truncated ? `${path} · truncated at 1 MB` : path;
    this.titleEl.classList.toggle("problem", truncated);
  }

  problem(path: string, message: string) {
    if (path !== this.path) return;
    this.titleEl.textContent = `${path} · ${message}`;
    this.titleEl.classList.add("problem");
    this.show(path, "", false);
  }

  layout() {
    this.editor?.updateOptions({ fontSize: codeFontPx() });
    this.editor?.layout();
  }

  clear() {
    this.path = null;
    const model = this.editor?.getModel();
    this.editor?.setModel(null);
    model?.dispose();
  }

  dispose() {
    this.clear();
    this.events.abort();
    this.editor?.dispose();
    this.editor = null;
  }
}

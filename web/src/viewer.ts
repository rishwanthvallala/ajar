// The core editor plus Monarch tokenizers, rather than `monaco-editor`'s
// index. That index also pulls in the TypeScript, JSON, HTML and CSS language
// services and their web workers — roughly nine megabytes of them — which can
// never run here: `MonacoEnvironment.getWorker` below returns the editor
// worker for every request, so nothing else is ever instantiated. Highlighting
// comes from the basic-languages contribution and needs no worker at all.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
import { defineEditorThemes, editorTheme, languageFor, onThemeChange, registerDelimited } from "@ajar/workspace-ui";
import { replaceText } from "./replace";
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
  /** The file whose model is in the editor now, which `path` runs ahead of. */
  private shown: string | null = null;
  /**
   * Where each file was left — scrolled to, the cursor, what was folded — so
   * coming back to one is coming back to there, not to its first line.
   */
  private readonly viewStates = new Map<string, monaco.editor.ICodeEditorViewState>();
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

  /** The file whose model is in the editor, if any. */
  get shownPath(): string | null {
    return this.shown;
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

  /**
   * Put `text` on screen as `path`. `note` says, after the name, where the
   * text came from when that is not simply the file.
   */
  show(path: string, text: string, truncated: boolean, readOnly = true, note?: string) {
    // A slow read for a file the user has already navigated away from.
    if (path !== this.path) return;

    const current = this.editor?.getModel();
    if (this.editor && current && this.shown === path) {
      // The same file again: back from a reconnect, or from the saved copy to
      // the live one. Only what differs is replaced, so the reader stays
      // where they were — a fresh model put them at line 1, and the next
      // keystroke landed there.
      replaceText(current, text);
      this.editor.updateOptions({ readOnly });
      this.title(path, truncated ? "truncated at 1 MB" : note, truncated);
      return;
    }

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
    this.shown = path;
    const back = this.viewStates.get(path);
    if (back) this.editor.restoreViewState(back);

    this.title(path, truncated ? "truncated at 1 MB" : note, truncated);
  }

  private title(path: string, note: string | undefined, problem: boolean) {
    this.titleEl.textContent = note ? `${path} · ${note}` : path;
    this.titleEl.classList.toggle("problem", problem);
    // A screen reader otherwise hears "Editor content" for every file alike.
    this.editor?.updateOptions({ ariaLabel: note ? `${path}, ${note}` : path });
  }

  /**
   * What is on screen can no longer be saved, and why. It stays, read-only,
   * so whatever was typed into it can still be read and copied.
   */
  stranded(path: string, why: string) {
    if (path !== this.path) return;
    this.editor?.updateOptions({ readOnly: true });
    this.title(path, `${why} — not saved, read-only`, true);
  }

  /** Nothing to show for `path`, and why. The reason stays in the title. */
  problem(path: string, message: string) {
    if (path !== this.path) return;
    // Shown first: showing sets the title, and this one is the point.
    this.show(path, "", false);
    this.title(path, message, true);
  }

  layout() {
    this.editor?.updateOptions({ fontSize: codeFontPx() });
    this.editor?.layout();
  }

  clear() {
    const model = this.editor?.getModel();
    if (this.editor && model && this.shown) {
      const state = this.editor.saveViewState();
      if (state) this.viewStates.set(this.shown, state);
    }
    this.path = null;
    this.shown = null;
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

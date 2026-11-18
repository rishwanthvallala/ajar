// The core editor plus Monarch tokenizers, rather than `monaco-editor`'s
// index. That index also pulls in the TypeScript, JSON, HTML and CSS language
// services and their web workers — roughly nine megabytes of them — which can
// never run here: `MonacoEnvironment.getWorker` below returns the editor
// worker for every request, so nothing else is ever instantiated. Highlighting
// comes from the basic-languages contribution and needs no worker at all.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
// And the editor's own features — find and replace, comment toggling,
// folding, its right-click menu, several cursors, grey text for a suggestion.
// The bare API has none of them, and until 19 November this page had none:
// Ctrl-F found nothing to open, and a right click was the browser's. The pad
// has always had them, because in its Monaco, a version behind, registering
// any language loads them; in this one they are asked for by name. Still not
// the index: these are the editor's, with no language service among them.
import "monaco-editor/features/register.all";
import { defineEditorThemes, editorTheme, languageFor, onThemeChange, registerDelimited } from "@ajar/workspace-ui";
import { formatterFor, formatText, problemOf, usesTabs } from "@ajar/workspace-ui/format";
import { imageType } from "@ajar/workspace-ui/images";
import { isMarkdown, linkFor, MARKDOWN_MAX, renderMarkdown, slug } from "@ajar/workspace-ui/markdown";
import { starterFor } from "@ajar/workspace-ui/starters";
import { Suggestions, suggestServed } from "@ajar/workspace-ui/suggest";
import { replaceText } from "./replace";
import { codeFontPx } from "./scale";
import { eolOf } from "@ajar/workspace-ui/eol";
// monaco-editor 0.56 exposes workers through its exports map, which rewrites
// `./editor/…` to `./esm/vs/editor/…`. Importing the esm path directly
// resolves to a doubled prefix and fails only at build time.
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

/**
 * Only the base editor worker is loaded. The TypeScript and JSON language
 * workers could not start here anyway; highlighting is Monarch and runs on
 * the main thread.
 */
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

// Once, as this module loads: CSV and TSV, which Monaco has no tokenizer for,
// and the editor's light and dark themes with their column colours.
registerDelimited(monaco.languages);
defineEditorThemes(monaco.editor);

// Monaco cancels its own work when a file is switched or closed, and one of
// its features lets that rejection go unhandled — an uncaught "Canceled"
// with a stack inside Monaco's dispose. Monaco treats cancellation as
// expected everywhere else; so does this page, and only that. As the pad does.
addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { name?: string; message?: string } | undefined;
  if (reason?.name === "Canceled" && reason.message === "Canceled") e.preventDefault();
});

/**
 * Suggestions as you type, for the editor in front: one model in the tab,
 * moved between editors as the keyboard moves between groups. Whether this
 * site serves the model is asked once — a relay with the pad's packages
 * beside it does, one without does not — and where it does not there is no
 * Suggest switch.
 */
let suggestions: Suggestions | null = null;
let served: Promise<boolean> | null = null;
export function suggestIn(editor: monaco.editor.IStandaloneCodeEditor, button: HTMLButtonElement) {
  // The shared switch is written against the pad's Monaco, a version behind
  // this one: what it uses of either is the same.
  if (suggestions) return suggestions.setEditor(editor as never);
  served ??= suggestServed();
  void served.then((available) => {
    if (suggestions) return suggestions.setEditor(editor as never);
    suggestions = new Suggestions(monaco as never, editor as never, button, { prefix: "ajar", available });
  });
}
/** The session's editors are gone, and the switch with them. */
export function forgetSuggestions() {
  suggestions?.dispose();
  suggestions = null;
}

/** A file's indent: the page's, in spaces — or tabs, where the file's kind says so. */
function indentOptions(path: string, indent: number): monaco.editor.ITextModelUpdateOptions {
  return { tabSize: indent, indentSize: indent, insertSpaces: !usesTabs(path) };
}

export function fileModel(path: string, text: string, highlight: boolean, indent = 4) {
  const model = monaco.editor.createModel(text, highlight ? languageFor(monaco.languages.getLanguages(), path) : "plaintext");
  model.updateOptions(indentOptions(path, indent));
  return model;
}

/** The page's indent changed: every file open here follows. */
export function reindent(models: Iterable<[string, monaco.editor.ITextModel]>, indent: number) {
  for (const [path, model] of models) model.updateOptions(indentOptions(path, indent));
}

/** A cached model must adopt a freshly reopened document's line ending too. */
export function updateFileModel(model: monaco.editor.ITextModel, text: string) {
  const eol = eolOf(text) ?? "\n";
  if (model.getEOL() !== eol) model.setEOL(eol === "\r\n" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
  replaceText(model, text);
}

/** What a viewer asks of the pane it is in: the page's settings, its files, and its voice. */
export interface ViewerTools {
  /** How much an indent is: 4 spaces, or 2. */
  indent(): number;
  /** Whether a Markdown file is to be shown formatted. */
  formatted(path: string): boolean;
  setFormatted(path: string, on: boolean): void;
  /** Said to the person: a passing note, or what went wrong. */
  say(text: string, kind?: "ok" | "error"): void;
  /** Something the buttons over the editor show has changed. */
  changed(): void;
  /** A file of the folder as a `data:` URL, for a picture in a formatted file; null when it cannot be had. */
  image(path: string): Promise<string | null>;
  /** What `path` is in the folder, if anything. */
  kind(path: string): "file" | "dir" | null;
  /** Another file, opened in this group. */
  open(path: string): void;
}

/**
 * One editor group's editor: Monaco, with what can stand beside it or in its
 * place — a Markdown file formatted, an image.
 */
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
  /** Monaco in here; the formatted pane and an image beside or over it (tools.css). */
  readonly editorHost: HTMLElement;
  readonly markdownPane: HTMLElement;
  readonly imagePane: HTMLElement;
  private canFormat: monaco.editor.IContextKey<boolean> | null = null;
  private canStart: monaco.editor.IContextKey<boolean> | null = null;
  private starterHint: { widget: monaco.editor.IContentWidget; key: string } | null = null;
  formatting = false;
  private markdownTimer: ReturnType<typeof setTimeout> | null = null;
  private markdownAsked = 0;
  /** A heading to scroll to once the file a link opened has been formatted. */
  private markdownAnchor: { path: string; id: string } | null = null;
  /** The image in place of the editor, if one is. */
  imageShown: string | null = null;

  constructor(
    private host: HTMLElement,
    private titleEl: HTMLElement,
    /** Whether the workspace has syntax colours switched on. */
    private highlight: () => boolean = () => true,
    private models = new Map<string, monaco.editor.ITextModel>(),
    private tools: ViewerTools | null = null,
  ) {
    this.editorHost = document.createElement("div");
    this.editorHost.className = "editor";
    // After the editor, which it sits beside or covers, and which it leaves
    // with when an image replaces it.
    this.markdownPane = document.createElement("article");
    this.markdownPane.className = "md-view";
    this.markdownPane.tabIndex = 0;
    this.markdownPane.hidden = true;
    this.imagePane = document.createElement("div");
    this.imagePane.className = "image-view";
    this.imagePane.hidden = true;
    host.append(this.editorHost, this.markdownPane, this.imagePane);
    onThemeChange(() => {
      monaco.editor.setTheme(editorTheme());
      // A code block's colours are numbered by the theme they were made in.
      this.renderMarkdownSoon(0);
    }, this.events.signal);
    // Middle clicks too: a link to a file followed by the browser would
    // leave the session for an address that is nothing.
    for (const kind of ["click", "auxclick"] as const) {
      this.markdownPane.addEventListener(kind, (e) => this.followMarkdownLink(e), { signal: this.events.signal });
    }
  }

  /** The file's language, or plain text while colours are switched off. */
  private languageOf(path: string): string {
    return this.highlight() ? languageFor(monaco.languages.getLanguages(), path) : "plaintext";
  }

  /** Colours switched on or off: the open file follows at once. */
  highlightChanged() {
    const model = this.editor?.getModel();
    if (model && this.path) monaco.editor.setModelLanguage(model, this.languageOf(this.path));
    this.renderMarkdownSoon(0);
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
    if (this.imageShown && this.imageShown !== path) this.clearImage();
    this.paintMarkdown();
  }

  /** The live editor and model, once something has been opened. */
  get handles(): { editor: monaco.editor.IStandaloneCodeEditor; model: monaco.editor.ITextModel } | null {
    const model = this.editor?.getModel();
    return this.editor && model ? { editor: this.editor, model } : null;
  }

  /** Whether the file on screen takes typing. */
  get editable(): boolean {
    return !!this.editor?.getModel() && !this.editor.getOption(monaco.editor.EditorOption.readOnly);
  }

  setReadOnly(readOnly: boolean) {
    this.editor?.updateOptions({ readOnly });
    this.paintStarter();
    this.tools?.changed();
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
      updateFileModel(current, text);
      this.editor.updateOptions({ readOnly });
      this.title(path, truncated ? "truncated at 1 MB" : note, truncated);
      this.paintStarter();
      this.tools?.changed();
      return;
    }

    let model = this.models.get(path);
    if (!model) { model = fileModel(path, text, this.highlight(), this.tools?.indent()); this.models.set(path, model); }
    else updateFileModel(model, text);
    if (!this.editor) {
      this.editor = monaco.editor.create(this.editorHost, {
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
      this.configure(this.editor);
    } else {
      this.editor.setModel(model);
      this.editor.updateOptions({ readOnly });
    }
    monaco.editor.setModelLanguage(model, this.languageOf(path));
    this.shown = path;
    const back = this.viewStates.get(path);
    if (back) this.editor.restoreViewState(back);

    this.title(path, truncated ? "truncated at 1 MB" : note, truncated);
    this.paintStarter();
    this.paintMarkdown();
    this.tools?.changed();
  }

  /**
   * What an editor has beyond typing, as the pad's has it: Format Document
   * with its key and its place in the menu — Monaco's own formatters are in
   * the language workers, which cannot start here — and an empty file's
   * starter, for the keyboard.
   */
  private configure(editor: monaco.editor.IStandaloneCodeEditor) {
    // Monaco's button for a phone's or a tablet's keyboard is a textarea with
    // no name. It adds it a moment after the editor, and only where it takes
    // the device for iOS, which is where this watches for it. As the pad does.
    const host = editor.getDomNode();
    if (host && navigator.maxTouchPoints > 0 && /iPhone|iPad|Macintosh/.test(navigator.userAgent)) {
      const label = () => {
        const button = host.querySelector("textarea.iPadShowKeyboard");
        button?.setAttribute("aria-label", "Show the keyboard, to type in the editor");
        return button !== null;
      };
      if (!label()) {
        const watch = new MutationObserver(() => {
          if (label()) watch.disconnect();
        });
        watch.observe(host, { childList: true, subtree: true });
        this.events.signal.addEventListener("abort", () => watch.disconnect(), { once: true });
      }
    }
    editor.onDidChangeModelContent(() => {
      this.paintStarter();
      this.renderMarkdownSoon();
    });
    this.canFormat = editor.createContextKey("ajarCanFormat", false);
    this.canStart = editor.createContextKey("ajarCanStart", false);
    editor.addAction({
      id: "ajar.format",
      label: "Format Document",
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
      precondition: "ajarCanFormat",
      contextMenuGroupId: "1_modification",
      contextMenuOrder: 1.3,
      run: () => this.format(),
    });
    editor.addAction({
      id: "ajar.starter",
      label: "Insert Starter Code",
      precondition: "ajarCanStart",
      contextMenuGroupId: "1_modification",
      contextMenuOrder: 1.4,
      run: () => this.insertStarter(),
    });
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
    this.paintStarter();
    this.tools?.changed();
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

  saveState() { return this.editor?.saveViewState() ?? null; }
  restoreState(state: monaco.editor.ICodeEditorViewState) { this.editor?.restoreViewState(state); }

  /** The cursor on a line, and that line on screen: where a link in a terminal, or a search's result, points. */
  reveal(line: number, column?: number, length = 0) {
    const editor = this.editor;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const at = Math.max(1, Math.min(line, model.getLineCount()));
    const from = { lineNumber: at, column: Math.min(column ?? (model.getLineFirstNonWhitespaceColumn(at) || 1), model.getLineMaxColumn(at)) };
    const range = monaco.Range.fromPositions(from, { lineNumber: at, column: Math.min(from.column + length, model.getLineMaxColumn(at)) });
    editor.setSelection(range);
    editor.revealRangeInCenterIfOutsideViewport(range);
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
    this.clearImage();
    this.paintStarter();
    this.paintMarkdown();
  }

  dispose() {
    this.clear();
    this.events.abort();
    if (this.markdownTimer) clearTimeout(this.markdownTimer);
    this.editor?.dispose();
    this.editor = null;
    this.editorHost.remove();
    this.markdownPane.remove();
    this.imagePane.remove();
  }

  // ------------------------------------------------------------- formatting

  /** What formats the file on screen, when it can be formatted now. */
  get formatter(): { name: string } | null {
    return this.path && this.shown === this.path && this.editable && !this.imageShown ? formatterFor(this.path) : null;
  }

  /** The key's and the menu's Format follow the button. */
  paintTools() {
    this.canFormat?.set(this.formatter !== null && !this.formatting);
  }

  /**
   * The file in the editor, formatted. One edit, of only what changed, so one
   * undo takes it back and it reaches everyone in the session as typing does.
   */
  async format(): Promise<void> {
    const editor = this.editor;
    const model = editor?.getModel();
    const path = this.path;
    if (!editor || !model || !path || this.formatting || !this.formatter) return;
    this.formatting = true;
    this.tools?.changed();
    try {
      const before = model.getValue();
      // The first time, this fetches the formatter.
      const after = await formatText(path, before, this.tools?.indent() ?? 4);
      // Typed in meanwhile: formatting what was there would throw that away.
      if (model.isDisposed() || model.getValue() !== before) return this.tools?.say(`${path} changed while it was being formatted — format it again`);
      if (after === before) return this.tools?.say(`${path} is formatted already`);
      // No longer the file's to change: the host made the session read-only
      // while the formatter was being fetched.
      if (editor.getModel() !== model || !this.editable) return;
      const limit = Math.min(before.length, after.length);
      let head = 0;
      while (head < limit && before.charCodeAt(head) === after.charCodeAt(head)) head++;
      let tail = 0;
      while (tail < limit - head && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
      const range = monaco.Range.fromPositions(model.getPositionAt(head), model.getPositionAt(before.length - tail));
      editor.pushUndoStop();
      editor.executeEdits("ajar.format", [{ range, text: after.slice(head, after.length - tail) }]);
      editor.pushUndoStop();
      this.tools?.say(`Formatted ${path}`);
    } catch (e) {
      this.tools?.say(`${path} was not formatted: ${problemOf(e, model.getValue())}`, "error");
    } finally {
      this.formatting = false;
      this.tools?.changed();
    }
  }

  // --------------------------------------------------------------- starters

  private unit(): string {
    return this.path && usesTabs(this.path) ? "\t" : " ".repeat(this.tools?.indent() ?? 4);
  }

  /** An empty file's offer of what it could start as, on its first line where the code would go. */
  paintStarter() {
    const editor = this.editor;
    if (!editor) return;
    const model = editor.getModel();
    const path = this.shown;
    const starter = model && path && model.getValueLength() === 0 && this.editable ? starterFor(path, this.unit()) : null;
    this.canStart?.set(starter !== null);
    const key = starter ? `${path}\n${starter.label}` : "";
    if (this.starterHint?.key === key) return;
    if (this.starterHint) editor.removeContentWidget(this.starterHint.widget);
    this.starterHint = null;
    if (!starter) return;
    const node = document.createElement("div");
    node.className = "starter-hint";
    const take = document.createElement("button");
    take.type = "button";
    take.textContent = `Insert ${starter.label}`;
    take.title = "A few lines to start from — undo takes them out again";
    take.onclick = () => this.insertStarter();
    const or = document.createElement("span");
    or.textContent = "or start typing";
    node.append(take, or);
    const widget: monaco.editor.IContentWidget = {
      getId: () => "ajar.starter-hint",
      getDomNode: () => node,
      getPosition: () => ({ position: { lineNumber: 1, column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] }),
    };
    editor.addContentWidget(widget);
    this.starterHint = { widget, key };
  }

  /** The starter, put in as typing would be: one undo takes it out, and everyone in the session sees it. */
  private insertStarter() {
    const editor = this.editor;
    const model = editor?.getModel();
    if (!editor || !model || !this.shown || model.getValueLength() !== 0 || !this.editable) return;
    const starter = starterFor(this.shown, this.unit());
    if (!starter) return;
    editor.pushUndoStop();
    editor.executeEdits("ajar.starter", [{ range: model.getFullModelRange(), text: starter.text }]);
    editor.pushUndoStop();
    const line = Math.min(starter.line, model.getLineCount());
    editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
    editor.revealLineInCenterIfOutsideViewport(line);
    editor.focus();
  }

  // --------------------------------------------------------------- markdown

  /** Whether the file here is Markdown, and so can be shown formatted. */
  get markdown(): boolean {
    return this.path !== null && !this.imageShown && isMarkdown(this.path);
  }

  /**
   * The formatted pane, as the file in the editor and the choice for it say.
   * Beside the editor where there is room for both, over it where there is
   * not (tools.css, by the group's width); gone when an image takes the
   * editor's place.
   */
  paintMarkdown() {
    const on = this.path !== null && this.markdown && (this.tools?.formatted(this.path) ?? false) && this.shown === this.path;
    this.markdownPane.hidden = !on;
    this.host.classList.toggle("md-shown", on);
    if (on) return this.renderMarkdownSoon(0);
    this.markdownAsked++;
    this.markdownPane.replaceChildren();
  }

  /** Again once typing pauses: anyone's, or the host's disk changing under it. */
  private renderMarkdownSoon(delay = 150) {
    if (this.markdownPane.hidden) return;
    if (this.markdownTimer) clearTimeout(this.markdownTimer);
    this.markdownTimer = setTimeout(() => {
      this.markdownTimer = null;
      void this.renderMarkdown();
    }, delay);
  }

  private async renderMarkdown(): Promise<void> {
    const pane = this.markdownPane;
    const path = this.path;
    const model = this.editor?.getModel();
    if (!path || !model || pane.hidden) return;
    const asked = ++this.markdownAsked;
    pane.setAttribute("aria-label", `${path}, formatted`);
    const note = (text: string) => pane.replaceChildren(Object.assign(document.createElement("p"), { className: "md-note", textContent: text }));
    if (model.getValueLength() > MARKDOWN_MAX) return note(`${path} is more than ${MARKDOWN_MAX / 1024 / 1024} MB, too long to show formatted.`);
    const source = model.getValue();
    if (!source.trim()) return note("Nothing to show yet: the file is empty.");
    let fragment: DocumentFragment;
    try {
      fragment = await renderMarkdown(source, path, {
        where: "this folder",
        image: (p) => this.tools?.image(p) ?? Promise.resolve(null),
        colorize: (code, language) => this.colorize(code, language),
      });
    } catch (e) {
      if (asked === this.markdownAsked) note(`${path} could not be formatted: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (asked !== this.markdownAsked || pane.hidden || this.path !== path) return;
    const body = document.createElement("div");
    body.className = "md-body";
    body.append(fragment);
    pane.replaceChildren(body);
    const anchor = this.markdownAnchor;
    if (anchor && (anchor.path !== path || this.scrollMarkdownTo(anchor.id))) this.markdownAnchor = null;
  }

  /** A code block in a formatted file, coloured by the editor's own tokenizer for its language. */
  private async colorize(code: string, language: string): Promise<string | null> {
    if (!this.highlight()) return null;
    const wanted = language.toLowerCase();
    const found = monaco.languages.getLanguages().find((l) =>
      l.id === wanted || l.aliases?.some((a) => a.toLowerCase() === wanted) || l.extensions?.includes(`.${wanted}`));
    if (!found) return null;
    return monaco.editor.colorize(code.replace(/\n$/, ""), found.id, { tabSize: this.tools?.indent() ?? 4 });
  }

  /**
   * A link in a formatted file, followed inside the session: another file
   * opens here — formatted too if it is Markdown, at its heading if it names
   * one — and `#heading` scrolls to it. Links out open in a tab of their own,
   * as their target says; the browser does that.
   */
  private followMarkdownLink(e: MouseEvent) {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!a || !this.path) return;
    const link = linkFor(this.path, a.getAttribute("href") ?? "");
    if (link.kind === "outside") return;
    e.preventDefault();
    if (e.type === "auxclick" && e.button !== 1) return;
    if (link.kind === "here") return void this.scrollMarkdownTo(link.id);
    if (link.kind === "none") return;
    const { path, fragment } = link;
    const kind = this.tools?.kind(path) ?? null;
    if (kind === "file") {
      if (isMarkdown(path)) {
        this.tools?.setFormatted(path, true);
        this.markdownAnchor = fragment ? { path, id: fragment } : null;
      }
      if (path === this.path) return void this.scrollMarkdownTo(fragment);
      return this.tools?.open(path);
    }
    this.tools?.say(kind === "dir" ? `${path} is a folder — its files are in the list` : `There is no ${path} in this folder`);
  }

  /** To the heading `id` names, if the file has it; whether it had. */
  private scrollMarkdownTo(id: string): boolean {
    if (!id) return false;
    let wanted = id;
    try {
      wanted = decodeURIComponent(id);
    } catch {
      // As written.
    }
    const found = [`md-${wanted}`, `user-content-${wanted}`, `md-${slug(wanted)}`]
      .map((candidate) => this.markdownPane.querySelector(`#${CSS.escape(candidate)}`))
      .find((el) => el !== null);
    found?.scrollIntoView({ block: "start" });
    return !!found;
  }

  // ----------------------------------------------------------------- images

  /** A picture in place of the editor: `url` is its bytes, as a `data:` URL. */
  showImage(path: string, url: string, bytes: number, download: () => void) {
    if (path !== this.path) return;
    const img = document.createElement("img");
    img.alt = path;
    img.src = url;
    const kb = Math.max(1, Math.round(bytes / 1024));
    const caption = document.createElement("p");
    caption.className = "image-caption";
    caption.textContent = `${path} · ${kb} KB`;
    img.onload = () => {
      caption.textContent = `${path} · ${img.naturalWidth} × ${img.naturalHeight} · ${kb} KB`;
    };
    // One the browser cannot draw stays in its tab, saying so, with a way to have it.
    img.onerror = () => {
      if (this.imageShown !== path) return;
      this.imageNote(path, `${path} is not an image the browser can show`, download);
    };
    this.imagePane.replaceChildren(img, caption);
    this.imageOn(path);
  }

  /** In place of a picture that cannot be shown: why, and a way to have the file. */
  imageNote(path: string, text: string, download: (() => void) | null) {
    if (path !== this.path) return;
    const note = document.createElement("p");
    note.className = "image-caption";
    note.textContent = text;
    this.imagePane.replaceChildren(note);
    if (download) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quiet-button";
      button.textContent = `Download ${path.split("/").pop()}`;
      button.onclick = download;
      this.imagePane.append(button);
    }
    this.imageOn(path);
  }

  private imageOn(path: string) {
    this.imageShown = path;
    this.imagePane.dataset.path = path;
    this.imagePane.hidden = false;
    this.editorHost.hidden = true;
    this.markdownPane.hidden = true;
    this.host.classList.remove("md-shown");
    this.titleEl.textContent = path;
    this.titleEl.classList.remove("problem");
    this.tools?.changed();
  }

  private clearImage() {
    if (!this.imageShown) return;
    this.imageShown = null;
    this.imagePane.hidden = true;
    this.imagePane.replaceChildren();
    this.editorHost.hidden = false;
    this.editor?.layout();
  }
}

/** Whether `path` is a picture the page shows rather than opens as text. */
export function isImage(path: string): boolean {
  return imageType(path) !== null;
}

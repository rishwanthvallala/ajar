// The core editor plus Monarch tokenizers, rather than `monaco-editor`'s
// index. That index also pulls in the TypeScript, JSON, HTML and CSS language
// services and their web workers — roughly nine megabytes of them — which can
// never run here: `MonacoEnvironment.getWorker` below returns the editor
// worker for every request, so nothing else is ever instantiated. Highlighting
// comes from the basic-languages contribution and needs no worker at all.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
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

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  // Monaco has no Monarch tokenizer for JSON — it ships a full language
  // service instead, whose worker cannot run here. JSON is a subset of a
  // JavaScript object literal, so the JS tokenizer colours it correctly;
  // what is lost is validation, which nothing else has either until
  // language servers land.
  json: "javascript",
  html: "html",
  css: "css",
  scss: "scss",
  md: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  dockerfile: "dockerfile",
};

const BY_FILENAME: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  ".gitignore": "plaintext",
  "Cargo.lock": "ini",
};

export function languageFor(path: string): string {
  const name = path.split("/").pop() ?? path;
  if (BY_FILENAME[name]) return BY_FILENAME[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "plaintext";
}

function theme(): string {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs";
}

export class Viewer {
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private path: string | null = null;

  constructor(
    private host: HTMLElement,
    private titleEl: HTMLElement,
  ) {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      monaco.editor.setTheme(theme());
    });
  }

  /** The file whose content we're waiting for or showing. */
  get current(): string | null {
    return this.path;
  }

  opening(path: string) {
    this.path = path;
    this.titleEl.textContent = path;
    this.titleEl.classList.remove("problem");
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

    const model = monaco.editor.createModel(text, languageFor(path));
    if (!this.editor) {
      this.editor = monaco.editor.create(this.host, {
        model,
        readOnly,
        automaticLayout: true,
        theme: theme(),
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
    this.editor?.layout();
  }
}

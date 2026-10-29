import type * as Monaco from "monaco-editor";
import { Completer } from "@ajar/complete";
import { attachCompleter } from "@ajar/complete/monaco";

/**
 * Suggestions as you type: the rest of the line in grey, Tab to take it, from
 * a model that runs in this tab (packages/complete). The code it reads never
 * leaves the browser.
 *
 * The model is 17 MB on the wire, served from /packages like the runtime's
 * packages, and that is what decides when it loads: at the first key typed in
 * the editor, so a visitor who only reads a pad never pays for it, and never
 * on a phone or with Save-Data on. Once it has loaded here it comes from Cache
 * Storage, in about a tenth of a second, and starts with the editor.
 *
 * "Suggest" beside Format switches it off and on for this browser. A build
 * without the model (no ajar-complete.json in its packages) has no switch at
 * all: `__SUGGEST__`, from vite.config.ts. Asked for at the first key, as it
 * was, the switch offered the download and then vanished as typing began, on
 * every visit.
 */
declare const __SUGGEST__: boolean;
const MANIFEST = "/packages/ajar-complete.json";
const SWITCH_KEY = "pad.suggest";
/** Set once the model has loaded in this browser: from then on it is in Cache Storage. */
const LOADED_KEY = "pad.suggest.loaded";

/** A module with one SIMD128 instruction: the engine has no build without it. */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

type State = "waiting" | "loading" | "ready" | "failed";

export class Suggestions {
  private completer: Completer | null = null;
  private attached: Monaco.IDisposable | null = null;
  private state: State = "waiting";
  private on: boolean;
  private percent = 0;
  private why = "";
  private readonly events = new AbortController();
  private readonly monaco: typeof Monaco;
  private editor: Monaco.editor.IStandaloneCodeEditor;
  private typed: Monaco.IDisposable | null = null;
  private readonly button: HTMLButtonElement;

  constructor(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor, button: HTMLButtonElement) {
    this.monaco = monaco;
    this.editor = editor;
    this.button = button;
    this.on = read(SWITCH_KEY) !== "off";
    button.onclick = () => this.toggle();
    if (!__SUGGEST__ || !suitable()) return;
    button.hidden = false;
    if (this.on && read(LOADED_KEY) === "1") this.start();
    this.watchEditor();
    this.paint();
  }

  /** Reuse one completion model as focus moves between editor groups. */
  setEditor(editor: Monaco.editor.IStandaloneCodeEditor): void {
    if (this.editor === editor) return;
    this.typed?.dispose(); this.attached?.dispose(); this.attached = null;
    this.editor = editor;
    if (!__SUGGEST__ || !suitable()) return;
    this.watchEditor(); this.attach();
  }
  private watchEditor(): void {
    this.typed = this.editor.onKeyDown(e => {
      const key = e.browserEvent.key;
      if (this.on && this.state === "waiting" && !e.ctrlKey && !e.metaKey && (key.length === 1 || key === "Enter" || key === "Tab")) {
        if (!this.editor.getOption(this.monaco.editor.EditorOption.readOnly)) this.start();
      }
    });
  }
  private attach(): void {
    if (!this.completer) return;
    this.attached = attachCompleter(this.monaco, this.editor, this.completer, {
      enabled: model => this.on && this.state === "ready" && this.editor.getModel() === model && !this.editor.getOption(this.monaco.editor.EditorOption.readOnly),
    });
  }

  private start(): void {
    if (this.completer) return;
    this.state = "loading";
    this.paint();
    const completer = new Completer({
      manifest: MANIFEST,
      onProgress: (loaded, total) => {
        const p = Math.floor((100 * loaded) / total);
        if (p !== this.percent) {
          this.percent = p;
          this.paint();
        }
      },
    });
    this.completer = completer;
    completer.ready.then(
      () => {
        this.state = "ready";
        write(LOADED_KEY, "1");
        this.paint();
      },
      (e: Error) => {
        this.state = "failed";
        this.why = e.message;
        // A server without the model this build was made with: nothing to switch.
        if (/ajar-complete\.json: HTTP 404/.test(e.message)) this.button.hidden = true;
        this.paint();
        completer.dispose();
      },
    );
    this.attach();
  }

  private toggle(): void {
    this.on = !this.on;
    write(SWITCH_KEY, this.on ? "on" : "off");
    if (!this.on) this.editor.trigger("pad", "editor.action.inlineSuggest.hide", null);
    this.paint();
  }

  private paint(): void {
    const b = this.button;
    b.setAttribute("aria-pressed", String(this.on));
    b.classList.toggle("off", !this.on);
    b.textContent = this.on && this.state === "loading" ? `Suggest ${this.percent}%` : "Suggest";
    b.title = !this.on
      ? "Suggestions off — suggest the rest of the line as you type"
      : this.state === "failed"
        ? `Suggestions could not start: ${this.why}`
        : this.state === "loading"
          ? "Fetching the suggestion model, 17 MB, once — switch off"
          : this.state === "ready"
            ? "Suggestions on: Tab takes one, Escape leaves it. They run in this tab — switch off"
            : "Suggestions on: they start at the first key you type (17 MB, once) — switch off";
  }

  dispose(): void {
    this.events.abort();
    this.typed?.dispose();
    this.attached?.dispose();
    this.completer?.dispose();
  }
}

/** Not on a phone, not with Save-Data, and only where the engine can run. */
function suitable(): boolean {
  // A phone has no fine pointer at all; a tablet with a trackpad has one.
  if (!matchMedia("(any-pointer: fine)").matches) return false;
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  try {
    return typeof Worker === "function" && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // For this visit, then.
  }
}

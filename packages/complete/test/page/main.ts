// The page test/browser.mjs drives: a Monaco editor with the completer
// attached as the pad attaches it, and the pieces exposed for the checks.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import { Completer, type Completion } from "../../src/index";
import { attachCompleter } from "../../src/monaco";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" }),
};
const q = new URLSearchParams(location.search);
const status = document.getElementById("status")!;
const completer = new Completer({
  manifest: "/packages/ajar-complete.json",
  threads: q.has("threads") ? Number(q.get("threads")) : undefined,
  relaxed: q.get("relaxed") === "0" ? false : undefined,
  onProgress: (loaded, total) => (status.textContent = `model ${Math.round((100 * loaded) / total)}%`),
});
const editor = monaco.editor.create(document.getElementById("editor")!, {
  automaticLayout: true,
  minimap: { enabled: false },
  theme: "vs-dark",
  language: "python",
  value: "",
});
const log: { c: Completion; shown: boolean; at: number }[] = [];
attachCompleter(monaco, editor, completer, { enabled: (m) => m === editor.getModel(), onCompletion: (c, shown) => log.push({ c, shown, at: performance.now() }) });
completer.ready.then(
  (info) => (status.textContent = `ready: ${info.model} ${info.build} ×${info.threads} in ${Math.round(info.ms)} ms${info.cached ? " (cached)" : ""}`),
  (e: Error) => (status.textContent = `failed: ${e.message}`),
);
// Long tasks on this thread while the checks type: the completer should cause none.
const long: number[] = [];
new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration))).observe({ type: "longtask", buffered: true });
Object.assign(window, { monaco, editor, completer, log, long, attachCompleter, isolated: crossOriginIsolated });

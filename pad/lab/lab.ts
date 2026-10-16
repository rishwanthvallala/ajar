/**
 * The completion lab: small code-completion models in the browser, side by
 * side, on what they cost to download and how well and how fast they finish
 * a line. A page for deciding which model the pad's editor would use, if
 * any, and not part of the pad itself (docs/open-points.md).
 */
import "./lab.css";
import { CASES, firstLine, score, tidy } from "./cases";
import type { Fetched, Reply, Request } from "./worker";

interface Model {
  key: string;
  name: string;
  about: string;
  /** A directory under /vendor/lab/models/, or a Hugging Face model id. */
  model: string;
  local: boolean;
  dtype: string;
  shape: "span" | "fim";
  /** Shown before loading: about what it will cost. */
  expect: string;
}

const MODELS: Model[] = [
  {
    key: "t5-q4",
    name: "CodeT5-small, 4-bit",
    about: "60M parameters (Salesforce, 2021). Matrices at 4 bits, the vocabulary table at 8.",
    model: "codet5-small-q4",
    local: true,
    dtype: "q4",
    shape: "span",
    expect: "60 MB measured",
  },
  {
    key: "t5-q4e4",
    name: "CodeT5-small, 4-bit throughout",
    about: "The same, with the vocabulary table at 4 bits too, and one scale per 128 weights rather than 32: 50 MB, the smallest this model's files get. It does not load yet: ONNX Runtime's WebAssembly build has no 4-bit vocabulary lookup (GatherBlockQuantized).",
    model: "codet5-small-q4e4",
    local: true,
    dtype: "q4",
    shape: "span",
    expect: "50 MB unpacked",
  },
  {
    key: "t5-q8",
    name: "CodeT5-small, 8-bit",
    about: "The same model at 8 bits everywhere: what the 4-bit builds give up, if anything.",
    model: "codet5-small-q8",
    local: true,
    dtype: "q8",
    shape: "span",
    expect: "67 MB measured",
  },
  {
    key: "starcoder",
    name: "tiny_starcoder_py, 4-bit (yardstick)",
    about: "164M parameters, Python only, trained to fill in the middle. Far over budget: here to show what a bigger model buys. From Hugging Face.",
    model: "Xenova/tiny_starcoder_py",
    local: false,
    dtype: "q4",
    shape: "fim",
    expect: "about 320 MB",
  },
];

const MAX_TOKENS = 24;

type State = "absent" | "idle" | "loading" | "ready" | "failed";
interface Status {
  state: State;
  error?: string;
  progress: Map<string, { loaded: number; total: number }>;
  ms?: number;
  fetched?: Fetched[];
}

const status = new Map<string, Status>(MODELS.map((m) => [m.key, { state: "idle", progress: new Map() }]));
const results = new Map<string, Map<string, { text: string; ms: number; error?: string }>>();
let runtime: Fetched[] = [];
let threads = 0;

/**
 * A worker for each model. One model's failure stays its own: a session
 * that failed to load left the runtime it shared unable to load any other
 * (seen with an opset-21 build, 16 October). The asks still go one at a
 * time, across all of them (`queue`), so no timing is another model's
 * contention.
 */
const workers = new Map<string, Worker>();
function workerFor(key: string): Worker {
  let worker = workers.get(key);
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<Reply>) => hear(event.data));
    workers.set(key, worker);
  }
  return worker;
}
const send = (key: string, request: Request) => workerFor(key).postMessage(request);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  env: $("env"),
  device: $<HTMLSelectElement>("device"),
  clear: $<HTMLButtonElement>("clear-cache"),
  models: $("models"),
  runtimeNote: $("runtime-note"),
  run: $<HTMLButtonElement>("run"),
  results: $<HTMLTableElement>("results"),
  play: $<HTMLTextAreaElement>("play"),
  tidy: $<HTMLInputElement>("tidy"),
  take: $<HTMLSelectElement>("take"),
  suggestions: $("suggestions"),
};

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const sum = (list: Fetched[], key: "transfer" | "size") => list.reduce((n, f) => n + f[key], 0);
const ready = () => MODELS.filter((m) => status.get(m.key)!.state === "ready");
/** What a model's line becomes on screen: CodeT5's tidied, when asked. */
const shown = (key: string, text: string) => (el.tidy.checked && MODELS.find((m) => m.key === key)?.shape === "span" ? tidy(text) : text);

// ------------------------------------------------------------------ models

/** Our own builds exist only where build-models.sh made them; a missing one is said, not offered. */
async function discover(): Promise<void> {
  await Promise.all(MODELS.filter((m) => m.local).map(async (m) => {
    const res = await fetch(`/vendor/lab/models/${m.model}/config.json`).catch(() => null);
    // A path that is not a file is answered with the pad's own page, so the type says which it was.
    if (!res?.ok || !/json/.test(res.headers.get("content-type") ?? "")) status.get(m.key)!.state = "absent";
  }));
}

function paintModels(): void {
  el.models.replaceChildren(...MODELS.map((m) => {
    const s = status.get(m.key)!;
    const card = document.createElement("article");
    card.className = `model ${s.state}`;
    card.dataset.key = m.key;
    const title = document.createElement("h3");
    title.textContent = m.name;
    const about = document.createElement("p");
    about.className = "about";
    about.textContent = m.about;
    const facts = document.createElement("dl");
    const fact = (term: string, value: string) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      facts.append(dt, dd);
    };
    if (s.state === "ready" && s.fetched) {
      const wire = sum(s.fetched, "transfer");
      const size = sum(s.fetched, "size") || totalProgress(s);
      // Hugging Face does not let a page see a download's timing, so only
      // its size is known; from this site, nothing on the wire is the cache.
      if (!m.local) fact("Download", `${mb(size)} from Hugging Face`);
      else fact("Download", wire ? `${mb(wire)} on the wire` : "from the browser's cache");
      fact("Size", mb(size));
      fact("Ready in", `${(s.ms! / 1000).toFixed(1)} s`);
    } else {
      fact("Download", m.expect);
    }
    const action = document.createElement("div");
    action.className = "action";
    if (s.state === "absent") {
      action.textContent = "Not built on this server: pad/lab/build-models.sh makes it.";
    } else if (s.state === "loading") {
      const bar = document.createElement("progress");
      const { loaded, total } = [...s.progress.values()].reduce((a, p) => ({ loaded: a.loaded + p.loaded, total: a.total + p.total }), { loaded: 0, total: 0 });
      bar.max = total || 1;
      bar.value = loaded;
      const label = document.createElement("span");
      label.textContent = total ? `${mb(loaded)} of ${mb(total)}` : "starting…";
      action.append(bar, label);
    } else if (s.state === "ready") {
      action.textContent = "Loaded";
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = s.state === "failed" ? "Try again" : "Load";
      button.onclick = () => load(m);
      action.append(button);
      if (s.error) {
        const error = document.createElement("p");
        error.className = "error";
        error.textContent = s.error;
        action.append(error);
      }
    }
    card.append(title, about, facts, action);
    return card;
  }));
  el.run.disabled = ready().length === 0;
  paintTake();
}

function totalProgress(s: Status): number {
  return [...s.progress.values()].reduce((n, p) => n + p.total, 0);
}

function load(m: Model): void {
  const s = status.get(m.key)!;
  s.state = "loading";
  s.error = undefined;
  s.progress.clear();
  paintModels();
  // A fresh worker for a retry: whatever the failed attempt left is gone with it.
  workers.get(m.key)?.terminate();
  workers.delete(m.key);
  send(m.key, { type: "load", key: m.key, model: m.model, dtype: m.dtype, local: m.local, device: el.device.value as "wasm" | "webgpu", shape: m.shape });
}

function paintRuntime(): void {
  if (!runtime.length) return;
  const wasm = runtime.find((f) => f.name.endsWith(".wasm"));
  const wire = sum(runtime, "transfer");
  el.runtimeNote.textContent =
    `The runtime, once for all models: ${wire ? `${mb(wire)} on the wire` : "from the browser's cache"} ` +
    `(${mb(sum(runtime, "size"))} unpacked)${wasm ? `, ${wasm.name.split("/").pop()}` : ""}` +
    `${threads ? `, ${threads} threads` : ""}.`;
}

// --------------------------------------------------------------- the cases

type Answer = Extract<Reply, { type: "completed" | "complete-failed" }>;
const pending = new Map<number, (reply: Answer) => void>();
let asks = 0;
let queue: Promise<unknown> = Promise.resolve();

function ask(key: string, prefix: string, suffix: string): Promise<Answer> {
  const id = ++asks;
  const answer = queue.then(() => new Promise<Answer>((resolve) => {
    pending.set(id, resolve);
    send(key, { type: "complete", key, ask: id, prefix, suffix, maxTokens: MAX_TOKENS });
  }));
  queue = answer;
  return answer;
}

async function runCases(): Promise<void> {
  el.run.disabled = true;
  const models = ready();
  for (const m of models) {
    const mine = new Map<string, { text: string; ms: number; error?: string }>();
    results.set(m.key, mine);
    // One ask first, not counted: the first run of a model compiles and warms it.
    await ask(m.key, CASES[0]!.prefix, CASES[0]!.suffix);
    for (const c of CASES) {
      const reply = await ask(m.key, c.prefix, c.suffix);
      mine.set(c.name, reply.type === "completed" ? { text: firstLine(reply.text), ms: reply.ms } : { text: "", ms: 0, error: reply.error });
      paintResults();
    }
  }
  el.run.disabled = false;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
}

function paintResults(): void {
  const models = MODELS.filter((m) => results.has(m.key));
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Case", "The line it should finish with", ...models.map((m) => m.name)]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const c of CASES) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.innerHTML = `<span class="lang"></span><span class="name"></span>`;
    name.querySelector(".lang")!.textContent = c.lang;
    name.querySelector(".name")!.textContent = c.name;
    const expected = document.createElement("td");
    expected.className = "code";
    expected.textContent = c.expected;
    row.append(name, expected);
    for (const m of models) {
      const td = document.createElement("td");
      const got = results.get(m.key)!.get(c.name);
      if (got) {
        const line = shown(m.key, got.text);
        const { exact, share } = score(line, c.expected);
        td.className = `code ${exact ? "right" : share > 0 ? "partly" : "wrong"}`;
        const text = document.createElement("span");
        text.textContent = got.error ? `(${got.error})` : line || "(nothing)";
        if (line !== got.text) td.title = `as written: ${got.text}`;
        const ms = document.createElement("small");
        ms.textContent = `${got.ms} ms`;
        td.append(text, ms);
      }
      row.append(td);
    }
    body.append(row);
  }
  const foot = document.createElement("tfoot");
  const footRow = document.createElement("tr");
  const label = document.createElement("th");
  label.colSpan = 2;
  label.textContent = "Right / kept / time: median, and the slowest tenth";
  footRow.append(label);
  for (const m of models) {
    const mine = [...results.get(m.key)!.entries()].map(([name, r]) => [name, { ...r, text: shown(m.key, r.text) }] as const);
    const scored = mine.map(([name, r]) => score(r.text, CASES.find((c) => c.name === name)!.expected));
    const right = scored.filter((s) => s.exact).length;
    // Spacing apart: `factorial(n-1)` for `factorial(n - 1)` is a formatter's
    // business, not a wrong answer, and worth telling from one.
    const nearly = mine.filter(([name, r]) => r.text.replace(/\s+/g, "") === CASES.find((c) => c.name === name)!.expected.replace(/\s+/g, "")).length;
    const kept = scored.length ? scored.reduce((n, s) => n + s.share, 0) / scored.length : 0;
    const times = mine.map(([, r]) => r.ms).sort((a, b) => a - b);
    const p90 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.9))]! : 0;
    const td = document.createElement("td");
    td.className = "summary";
    td.textContent = `${right} of ${mine.length} right, ${nearly} ignoring spaces · ${Math.round(kept * 100)}% kept · ${median(times)} ms, ${p90} ms`;
    footRow.append(td);
  }
  foot.append(footRow);
  el.results.replaceChildren(head, body, foot);
}

// --------------------------------------------------------------- playground

const SAMPLE = `from flask import Flask, render_template, request

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/hello")
def hello():
    name = request.args.get(`;

const suggestions = new Map<string, { text: string; ms: number }>();
/** Per model: an ask under way, and whether the text changed meanwhile. */
const asking = new Map<string, { busy: boolean; again: boolean }>();
let typingTimer: ReturnType<typeof setTimeout> | undefined;

function paintTake(): void {
  const keys = ready().map((m) => m.key);
  const was = el.take.value;
  el.take.replaceChildren(...ready().map((m) => {
    const o = document.createElement("option");
    o.value = m.key;
    o.textContent = m.name;
    return o;
  }));
  if (keys.includes(was)) el.take.value = was;
}

function suggestAll(): void {
  for (const m of ready()) void suggest(m.key);
}

async function suggest(key: string): Promise<void> {
  const state = asking.get(key) ?? { busy: false, again: false };
  asking.set(key, state);
  if (state.busy) {
    state.again = true;
    return;
  }
  state.busy = true;
  const at = el.play.selectionStart;
  const reply = await ask(key, el.play.value.slice(0, at), el.play.value.slice(at));
  if (reply.type === "completed") suggestions.set(key, { text: shown(key, firstLine(reply.text)), ms: reply.ms });
  state.busy = false;
  paintSuggestions();
  if (state.again) {
    state.again = false;
    void suggest(key);
  }
}

function paintSuggestions(): void {
  el.suggestions.replaceChildren(...ready().map((m) => {
    const row = document.createElement("div");
    row.className = "suggestion";
    const name = document.createElement("span");
    name.className = "who";
    name.textContent = m.name;
    const text = document.createElement("code");
    const got = suggestions.get(m.key);
    text.textContent = got ? got.text || "(nothing)" : "…";
    const ms = document.createElement("small");
    ms.textContent = got ? `${got.ms} ms` : "";
    row.append(name, text, ms);
    return row;
  }));
}

el.play.value = SAMPLE;
el.play.addEventListener("input", () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(suggestAll, 350);
});
el.play.addEventListener("click", () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(suggestAll, 350);
});
el.play.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const got = suggestions.get(el.take.value);
  if (!got?.text) return;
  e.preventDefault();
  el.play.setRangeText(got.text, el.play.selectionStart, el.play.selectionEnd, "end");
  suggestions.clear();
  paintSuggestions();
  suggestAll();
});

// ------------------------------------------------------------------ wiring

function hear(reply: Reply): void {
  if (reply.type === "progress") {
    status.get(reply.key)!.progress.set(reply.file, { loaded: reply.loaded, total: reply.total });
    paintModels();
  } else if (reply.type === "loaded") {
    const s = status.get(reply.key)!;
    s.state = "ready";
    s.ms = reply.ms;
    s.fetched = reply.fetched;
    if (reply.runtime.length) runtime = reply.runtime;
    threads = reply.threads || threads;
    paintModels();
    paintRuntime();
    paintSuggestions();
    suggestAll();
  } else if (reply.type === "load-failed") {
    const s = status.get(reply.key)!;
    s.state = "failed";
    s.error = reply.error;
    paintModels();
  } else if (reply.type === "completed" || reply.type === "complete-failed") {
    pending.get(reply.ask)?.(reply);
    pending.delete(reply.ask);
  }
}

el.run.onclick = () => void runCases();
el.tidy.onchange = () => paintResults();
// transformers.js's own cache, and only it: the pad keeps its language
// packages in caches on this origin too, and they are not the lab's to drop.
el.clear.onclick = async () => {
  await caches.delete("transformers-cache");
  el.clear.textContent = "Forgotten: the next load downloads again";
};

const gpu = "gpu" in navigator;
if (!gpu) el.device.querySelector<HTMLOptionElement>('option[value="webgpu"]')!.disabled = true;
el.env.textContent = [
  crossOriginIsolated ? "Cross-origin isolated, so the runtime can use threads" : "Not cross-origin isolated: one thread only",
  `${navigator.hardwareConcurrency} cores`,
  gpu ? "WebGPU available" : "no WebGPU",
].join(" · ");

await discover();
paintModels();
paintResults();

// For the lab's own check (scripts/lab-check.mjs): what the page believes.
(window as unknown as { __lab: unknown }).__lab = {
  status: () => Object.fromEntries([...status].map(([k, s]) => [k, { state: s.state, error: s.error, ms: s.ms, wire: s.fetched ? sum(s.fetched, "transfer") : null, size: s.fetched ? sum(s.fetched, "size") || totalProgress(s) : null, files: s.fetched?.map((f) => f.name) }])),
  runtime: () => runtime,
  results: () => Object.fromEntries([...results].map(([k, r]) => [k, Object.fromEntries(r)])),
  suggestions: () => Object.fromEntries(suggestions),
  load: (key: string) => load(MODELS.find((m) => m.key === key)!),
  run: () => runCases(),
};

/**
 * The lab's models, off the page's thread: transformers.js from
 * /vendor/lab/ (scripts/fetch-lab.mjs), loading a model and asking it for
 * what goes at the cursor.
 *
 * Two shapes of model:
 *   - "span": CodeT5, trained to fill a masked span. The cursor becomes
 *     `<extra_id_0>`, and the answer is what it writes for it.
 *   - "fim": a fill-in-the-middle causal model, StarCoder's
 *     `<fim_prefix>…<fim_suffix>…<fim_middle>`, and the answer is what follows.
 */

export interface LoadRequest {
  type: "load";
  key: string;
  model: string;
  dtype: string;
  local: boolean;
  device: "wasm" | "webgpu";
  shape: "span" | "fim";
}

export interface CompleteRequest {
  type: "complete";
  key: string;
  ask: number;
  prefix: string;
  suffix: string;
  maxTokens: number;
}

export type Request = LoadRequest | CompleteRequest;

/** Files fetched for a load, from the resource timing: what crossed the wire and what it was. */
export interface Fetched {
  name: string;
  transfer: number;
  size: number;
}

export type Reply =
  | { type: "progress"; key: string; file: string; loaded: number; total: number }
  | { type: "loaded"; key: string; ms: number; fetched: Fetched[]; runtime: Fetched[]; threads: number }
  | { type: "load-failed"; key: string; error: string }
  | { type: "completed"; key: string; ask: number; text: string; ms: number; tokens: number }
  | { type: "complete-failed"; key: string; ask: number; error: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Lib = any;
let lib: Promise<Lib> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loaded = new Map<string, { tokenizer: any; model: any; shape: "span" | "fim" }>();
let runtimeReported = false;

function transformers(): Promise<Lib> {
  lib ??= (async () => {
    const tf = await import(/* @vite-ignore */ `${location.origin}/vendor/lab/transformers.min.js`);
    // Its default is a CDN this site's CSP does not allow, and should not:
    // the runtime is ours, at the version the bundle was built against.
    tf.env.backends.onnx.wasm.wasmPaths = `${location.origin}/vendor/lab/ort/`;
    tf.env.allowLocalModels = false;
    tf.env.allowRemoteModels = true;
    return tf;
  })();
  return lib;
}

const post = (reply: Reply) => (self as unknown as Worker).postMessage(reply);

function fetchedSince(mark: number, filter: (name: string) => boolean): Fetched[] {
  return (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((e) => e.startTime >= mark && filter(e.name))
    .map((e) => ({ name: new URL(e.name).pathname, transfer: e.transferSize, size: e.decodedBodySize }));
}

async function load(request: LoadRequest): Promise<void> {
  const mark = performance.now();
  const started = Date.now();
  try {
    const tf = await transformers();
    // Our own builds from this origin, the others from Hugging Face: where
    // transformers.js looks is global, so it is set for each load. Ours are
    // "remote" too, at a host of our own: a local path that is a URL is not
    // one transformers.js 4 takes.
    if (request.local) {
      tf.env.remoteHost = `${location.origin}/vendor/lab/models/`;
      tf.env.remotePathTemplate = "{model}/";
    } else {
      tf.env.remoteHost = "https://huggingface.co/";
      tf.env.remotePathTemplate = "{model}/resolve/{revision}/";
    }
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.file) post({ type: "progress", key: request.key, file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    };
    const tokenizer = await tf.AutoTokenizer.from_pretrained(request.model, { progress_callback });
    const Model = request.shape === "span" ? tf.AutoModelForSeq2SeqLM : tf.AutoModelForCausalLM;
    const model = await Model.from_pretrained(request.model, { dtype: request.dtype, device: request.device, progress_callback });
    loaded.set(request.key, { tokenizer, model, shape: request.shape });
    const runtime = runtimeReported ? [] : fetchedSince(0, (n) => n.includes("/vendor/lab/ort/") || n.endsWith("transformers.min.js"));
    runtimeReported = true;
    post({
      type: "loaded",
      key: request.key,
      ms: Date.now() - started,
      fetched: fetchedSince(mark, (n) => !n.includes("/vendor/lab/ort/") && !n.endsWith("transformers.min.js")),
      runtime,
      threads: Number(tf.env.backends.onnx.wasm.numThreads ?? 0),
    });
  } catch (e) {
    post({ type: "load-failed", key: request.key, error: (e as Error)?.message ?? String(e) });
  }
}

/** The text before and after the cursor, cut to what a small model's context holds, at line ends where it can be. */
function around(prefix: string, suffix: string): { before: string; after: string } {
  let before = prefix.slice(-1200);
  if (before.length < prefix.length) before = before.slice(before.indexOf("\n") + 1);
  let after = suffix.slice(0, 400);
  if (after.length < suffix.length && after.lastIndexOf("\n") > 0) after = after.slice(0, after.lastIndexOf("\n"));
  return { before, after };
}

async function complete(request: CompleteRequest): Promise<void> {
  const entry = loaded.get(request.key);
  if (!entry) return post({ type: "complete-failed", key: request.key, ask: request.ask, error: "not loaded" });
  const { tokenizer, model, shape } = entry;
  const { before, after } = around(request.prefix, request.suffix);
  const started = performance.now();
  try {
    if (shape === "span") {
      const inputs = tokenizer(`${before}<extra_id_0>${after}`, { truncation: true, max_length: 512 });
      // Stop at the next sentinel: what follows it is another span, not this one.
      const next = tokenizer.convert_tokens_to_ids("<extra_id_1>");
      const eos = [model.generation_config?.eos_token_id ?? tokenizer.eos_token_id, next].filter((t) => t !== undefined);
      const out = await model.generate({ ...inputs, max_new_tokens: request.maxTokens, do_sample: false, eos_token_id: eos });
      const text: string = tokenizer.decode(out[0], { skip_special_tokens: false });
      const span = text.split("<extra_id_0>")[1] ?? "";
      const answer = span.split(/<extra_id_\d+>|<\/s>/)[0]!.replace(/<pad>|<s>/g, "");
      post({ type: "completed", key: request.key, ask: request.ask, text: answer, ms: Math.round(performance.now() - started), tokens: out[0].dims?.at(-1) ?? 0 });
    } else {
      const inputs = tokenizer(`<fim_prefix>${before}<fim_suffix>${after}<fim_middle>`);
      const length = inputs.input_ids.dims.at(-1);
      const out = await model.generate({ ...inputs, max_new_tokens: request.maxTokens, do_sample: false });
      const fresh = out.slice(null, [length, null]);
      const answer: string = tokenizer.decode(fresh[0], { skip_special_tokens: true });
      post({ type: "completed", key: request.key, ask: request.ask, text: answer, ms: Math.round(performance.now() - started), tokens: (out.dims?.at(-1) ?? length) - length });
    }
  } catch (e) {
    post({ type: "complete-failed", key: request.key, ask: request.ask, error: (e as Error)?.message ?? String(e) });
  }
}

/** In order: a model's load before its first ask. */
let queue: Promise<void> = Promise.resolve();
self.addEventListener("message", (event: MessageEvent<Request>) => {
  const request = event.data;
  queue = queue.then(async () => {
    if (request.type === "load") await load(request);
    else if (request.type === "complete") await complete(request);
  });
});

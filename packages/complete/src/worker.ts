/**
 * The completion worker: fetches the model once — Cache Storage keeps it after
 * that — runs the engine, and answers one request at a time, always the newest.
 *
 * A request that another has overtaken stops at its next chunk of prompt or
 * its next token. With SharedArrayBuffer the page says so through a shared
 * integer, which costs nothing to read; without it the worker gives its
 * message queue a turn between chunks and tokens.
 */
import { Engine, type Build } from "./engine";
import type { FileRef, Manifest } from "./manifest";
import type { Request } from "./prompt";
import { Session, type Completion } from "./session";
import { Tokenizer } from "./tokenizer";

export type ToWorker =
  | { type: "init"; manifest: string; threads: number; latest: SharedArrayBuffer | null; relaxed?: boolean }
  | { type: "complete"; id: number; request: Request; prepare?: boolean; eval?: boolean }
  | { type: "cancel"; id: number };

export type FromWorker =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; info: Info }
  | { type: "failed"; message: string }
  | { type: "done"; id: number; completion: Completion | null; stopped?: boolean };

export interface Info {
  model: string;
  build: Build;
  threads: number;
  kv8: boolean;
  /** From the start of loading to ready. */
  ms: number;
  /** Whether the model came from Cache Storage rather than the network. */
  cached: boolean;
  confidence: Record<string, number>;
}

/** The builds, as files the bundler hashes and serves beside this worker. */
const BUILDS: Record<Build, URL> = {
  relaxed: new URL("../assets/engine-relaxed.wasm", import.meta.url),
  simd: new URL("../assets/engine-simd.wasm", import.meta.url),
  "relaxed-mt": new URL("../assets/engine-relaxed-mt.wasm", import.meta.url),
  "simd-mt": new URL("../assets/engine-simd-mt.wasm", import.meta.url),
};
const CACHE = "ajar-complete";

/**
 * The worker's own scope, typed by hand: the `webworker` lib would retype
 * every global for the page that imports this package too.
 */
const scope = self as unknown as { onmessage: ((e: MessageEvent<ToWorker>) => void) | null; postMessage(m: FromWorker): void };
const post = (m: FromWorker) => scope.postMessage(m);
let session: Session | null = null;
let latest: Int32Array | null = null;
let newest = 0;
const cancelled = new Set<number>();
let pending: Extract<ToWorker, { type: "complete" }> | null = null;
let busy = false;
/** Settles true once the model is in, false if it never will be. */
let ready: Promise<boolean> | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    ready ??= init(m);
    void pump();
  } else if (m.type === "cancel") cancelled.add(m.id);
  else if (m.type === "complete") {
    newest = Math.max(newest, m.id);
    if (pending) post({ type: "done", id: pending.id, completion: null, stopped: true });
    pending = m;
    void pump();
  }
};

async function pump(): Promise<void> {
  if (busy || !ready) return;
  busy = true;
  try {
    if (!(await ready) && pending) {
      post({ type: "done", id: pending.id, completion: null });
      pending = null;
    }
    while (pending && session) {
      const job = pending;
      pending = null;
      const id = job.id;
      const stop = latest
        ? () => Atomics.load(latest!, 0) !== id
        : async () => {
            await turn();
            return newest !== id || cancelled.has(id);
          };
      try {
        const r = (await stop()) ? "stopped" : await session.complete(job.request, stop, { prepare: job.prepare, eval: job.eval });
        post({ type: "done", id, completion: r === "stopped" ? null : r, stopped: r === "stopped" });
      } catch (err) {
        // An engine that failed mid-pass holds a half-written cache.
        session.engine.reset();
        post({ type: "done", id, completion: null });
        console.error(err);
      }
      cancelled.delete(id);
    }
  } finally {
    busy = false;
  }
}

/** One turn of the message queue, without the 4 ms a nested setTimeout costs. */
const channel = new MessageChannel();
let woken: (() => void) | null = null;
channel.port1.onmessage = () => {
  const w = woken;
  woken = null;
  w?.();
};
function turn(): Promise<void> {
  return new Promise((resolve) => {
    woken = resolve;
    channel.port2.postMessage(0);
  });
}

async function init(m: Extract<ToWorker, { type: "init" }>): Promise<boolean> {
  const t0 = performance.now();
  latest = m.latest ? new Int32Array(m.latest) : null;
  try {
    const base = new URL(m.manifest);
    const res = await fetch(base, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${base.pathname}: HTTP ${res.status}`);
    const man = (await res.json()) as Manifest;
    if (man.format !== 1) throw new Error(`manifest format ${man.format}`);
    const cache = await caches.open(CACHE).catch(() => null);
    const keep = [new URL(man.model.file, base).href, new URL(man.vocab.file, base).href];
    const vocab = await fetchFile(cache, keep[1]!, man.vocab);
    let cached = false;
    let lastPost = 0;
    const engine = await Engine.load({
      shape: man.shape,
      used: man.tokens.used,
      threads: m.threads,
      relaxed: m.relaxed,
      compile: (b) => compile(BUILDS[b]),
      async fill(into) {
        const model = await fetchFile(cache, keep[0]!, man.model, (loaded) => {
          const now = performance.now();
          if (now - lastPost > 100 || loaded === man.model.bytes) {
            lastPost = now;
            post({ type: "progress", loaded, total: man.model.bytes });
          }
        });
        if (into.length !== model.data.length) throw new Error(`the engine wants ${into.length} bytes, the model is ${model.data.length}`);
        into.set(model.data);
        cached = model.cached;
      },
      spawn,
      log: (line) => console.error(`complete: ${line}`),
    });
    session = new Session(engine, new Tokenizer(vocab.data.buffer as ArrayBuffer), man);
    // Older models, from before a deploy changed the files.
    if (cache) for (const r of await cache.keys()) if (!keep.includes(r.url)) await cache.delete(r);
    post({
      type: "ready",
      info: { model: man.name, build: engine.build, threads: engine.threads, kv8: engine.kv8, ms: performance.now() - t0, cached, confidence: man.confidence },
    });
    return true;
  } catch (err) {
    post({ type: "failed", message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function compile(url: URL): Promise<WebAssembly.Module> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  // compileStreaming wants application/wasm; a server that says otherwise
  // still gets compiled, a little later.
  if (res.headers.get("content-type")?.startsWith("application/wasm")) return WebAssembly.compileStreaming(res);
  return WebAssembly.compile(await res.arrayBuffer());
}

/**
 * A file of the model directory, from Cache Storage or the network, checked
 * against its size and hash either way. A copy that fails the check is
 * dropped and fetched again once.
 */
async function fetchFile(cache: Cache | null, url: string, ref: FileRef, progress?: (loaded: number) => void): Promise<{ data: Uint8Array; cached: boolean }> {
  for (let attempt = 0; ; attempt++) {
    const hit = attempt === 0 ? await cache?.match(url) : undefined;
    const res = hit ?? (await fetch(url));
    if (!res.ok || !res.body) throw new Error(`${new URL(url).pathname}: HTTP ${res.status}`);
    const data = new Uint8Array(ref.bytes);
    const reader = res.body.getReader();
    let n = 0;
    let ok = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > data.length) {
        ok = false;
        await reader.cancel();
        break;
      }
      data.set(value, n);
      n += value.length;
      progress?.(n);
    }
    ok &&= n === ref.bytes && (await sha256(data)) === ref.sha256;
    if (ok) {
      if (!hit) await cache?.put(url, new Response(data, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
      return { data, cached: !!hit };
    }
    if (hit) {
      await cache?.delete(url);
      continue;
    }
    throw new Error(`${new URL(url).pathname}: ${n} bytes that do not match the manifest`);
  }
}

async function sha256(data: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A pool thread: the same module on the same memory, in a worker of its own.
 * One that has not started in 5 s is ended, so it cannot start later and
 * wait on the pool forever.
 */
function spawn(module: WebAssembly.Module, memory: WebAssembly.Memory, tid: number): Promise<{ stop(): void }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./thread.ts", import.meta.url), { type: "module", name: `complete-${tid}` });
    const fail = (why: string) => {
      clearTimeout(timer);
      w.terminate();
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail("thread did not start"), 5000);
    w.onmessage = (e: MessageEvent<string>) => {
      if (e.data !== "ready") return fail(e.data);
      clearTimeout(timer);
      resolve({ stop: () => w.terminate() });
    };
    w.onerror = (e) => fail(e.message || "thread failed");
    w.postMessage({ module, memory, tid });
  });
}

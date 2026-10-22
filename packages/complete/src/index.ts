/**
 * Code completion that runs in the page.
 *
 * A 36M-parameter model, 4-bit, 18 MB, in a worker with its own WebAssembly
 * engine: no server sees the code, and a keystroke costs about 10 ms of one
 * core once the file's beginning is in the cache. It completes the rest of
 * the line, filling in between the code before the cursor and the code after.
 *
 *   const c = new Completer({ manifest: "/packages/ajar-complete.json" });
 *   const r = await c.complete({ key, line, prefix, suffix }, signal);
 *   if (r && c.shows(r)) …
 *
 * `./monaco` wires it into a Monaco editor as inline (ghost text) suggestions.
 * The model directory — manifest, model, vocabulary — is served separately
 * from the code: see scripts/install-model.mjs.
 */
import type { Request } from "./prompt";
import type { Completion } from "./session";
import type { FromWorker, Info, ToWorker } from "./worker";

export type { Request } from "./prompt";
export type { Completion } from "./session";
export type { Info } from "./worker";

export interface CompleterOptions {
  /** The model directory's manifest.json, absolute or relative to the page. */
  manifest: string | URL;
  /**
   * Threads for long prompts — a cursor moved to a new place runs about a
   * thousand tokens. Needs cross-origin isolation; default half the cores, at most 4.
   */
  threads?: number;
  /** Bytes of the model fetched so far, during the first load. */
  onProgress?(loaded: number, total: number): void;
  /**
   * Share of shown completions that should be exactly right, as a percentage
   * the manifest has a cut for: 50, 60, 70 or 80. Default 70.
   */
  precision?: number;
  /** false runs the plain SIMD128 engine where relaxed SIMD is there too: for the checks. */
  relaxed?: boolean;
}

export class Completer {
  /** Settles once the model is loaded; rejects if it cannot be. */
  readonly ready: Promise<Info>;
  private readonly worker: Worker;
  private readonly latest: Int32Array | null;
  private readonly waiting = new Map<number, (c: Completion | null) => void>();
  private readonly onProgress?: (loaded: number, total: number) => void;
  private precision: number;
  private info: Info | null = null;
  private next = 1;
  private disposed = false;

  constructor(o: CompleterOptions) {
    this.onProgress = o.onProgress;
    this.precision = o.precision ?? 70;
    const isolated = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
    this.latest = isolated ? new Int32Array(new SharedArrayBuffer(4)) : null;
    const threads = o.threads ?? (isolated ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) >> 1)) : 1);
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "complete" });
    let settle!: { resolve(i: Info): void; reject(e: Error): void };
    this.ready = new Promise<Info>((resolve, reject) => (settle = { resolve, reject }));
    // Nobody may be waiting on it; a failed load is reported through `ready`
    // and through every completion coming back empty.
    this.ready.catch(() => {});
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === "progress") this.onProgress?.(m.loaded, m.total);
      else if (m.type === "ready") {
        this.info = m.info;
        settle.resolve(m.info);
      } else if (m.type === "failed") settle.reject(new Error(m.message));
      else if (m.type === "done") {
        this.waiting.get(m.id)?.(m.completion);
        this.waiting.delete(m.id);
      }
    };
    // A worker that dies — at its start or later — leaves no request waiting.
    this.worker.onerror = (e) => {
      settle.reject(new Error(e.message || "the completion worker failed"));
      for (const done of this.waiting.values()) done(null);
      this.waiting.clear();
    };
    const manifest = new URL(o.manifest, location.href).href;
    this.send({ type: "init", manifest, threads, latest: this.latest ? (this.latest.buffer as SharedArrayBuffer) : null, relaxed: o.relaxed });
  }

  /**
   * The completion at a cursor, or null when there is none or `signal`
   * aborted it. A newer request stops an older one that is still running.
   */
  complete(request: Request, signal?: AbortSignal): Promise<Completion | null> {
    return this.request(request, false, signal);
  }

  /**
   * Runs the prompt for a cursor into the cache without completing, for a
   * cursor that has moved: the first keystroke there is then as fast as any.
   */
  prepare(request: Request): void {
    void this.request(request, true);
  }

  /** The evaluation's prompt rather than the typing one, for the checks. */
  completeAsEvaluated(request: Request): Promise<Completion | null> {
    return this.request(request, false, undefined, true);
  }

  /** Whether a completion is sure enough to show, at the precision chosen. */
  shows(c: Completion): boolean {
    const cut = this.info?.confidence[String(this.precision)];
    return c.text.trim() !== "" && (cut === undefined || c.confidence >= cut);
  }

  setPrecision(p: number): void {
    this.precision = p;
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
  }

  private request(request: Request, prepare: boolean, signal?: AbortSignal, asEvaluated = false): Promise<Completion | null> {
    if (this.disposed || signal?.aborted) return Promise.resolve(null);
    const id = this.next++;
    if (this.latest) Atomics.store(this.latest, 0, id);
    return new Promise((resolve) => {
      const abort = () => {
        if (this.latest) Atomics.compareExchange(this.latest, 0, id, 0);
        else this.send({ type: "cancel", id });
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiting.set(id, (c) => {
        signal?.removeEventListener("abort", abort);
        resolve(signal?.aborted ? null : c);
      });
      this.send({ type: "complete", id, request, prepare, eval: asEvaluated });
    });
  }

  private send(m: ToWorker): void {
    this.worker.postMessage(m);
  }
}

/**
 * The engine (engine/complete.c) as the worker drives it: which build this
 * browser can run, starting it — on shared memory, with a pool of threads for
 * long prompts, when the page is cross-origin isolated — and the two things
 * it does: run a prompt, reusing whatever beginning the cache already holds,
 * and decode greedily from there.
 *
 * Nothing here fetches or knows about pages. The caller hands over a way to
 * compile a build by name, to fill the model's bytes in, and to start a
 * thread, so the same code runs in a browser worker and under Node in the
 * tests.
 */
import type { Shape } from "./manifest";

export type Build = "relaxed" | "simd" | "relaxed-mt" | "simd-mt";

/**
 * A module of one function using i32x4.relaxed_dot_i8x16_i7x16_add_s, the
 * instruction the fast kernels are built on. Chrome and Edge have had relaxed
 * SIMD since 114; where it is missing the plain SIMD128 build runs, 1.3–1.8×
 * slower and with f32 attention instead of int8.
 */
const RELAXED_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 19, 1, 17, 0,
  65, 1, 253, 15, 65, 2, 253, 15, 65, 3, 253, 17, 253, 147, 2, 11,
]);

export function relaxedSimd(): boolean {
  try {
    return WebAssembly.validate(RELAXED_PROBE);
  } catch {
    return false;
  }
}

interface Exports {
  memory?: WebAssembly.Memory;
  _initialize(): void;
  pc_init(V: number, d: number, L: number, nh: number, nkv: number, ffn: number): number;
  pc_blob(): number;
  pc_mask(): number;
  pc_load(threads: number): number;
  pc_tokens(): number;
  pc_logits(): number;
  pc_tmax(): number;
  pc_maxctx(): number;
  pc_threads(): number;
  pc_kv8(): number;
  pc_lp(): number;
  pc_forward(n: number, pos0: number, logits: number): number;
  pc_pick(n: number, allowed: number): number;
}

/** Says whether the work in hand has been overtaken; checked between chunks and tokens. */
export type Stop = () => boolean | Promise<boolean>;

export interface EngineOptions {
  shape: Shape;
  /** Tokens that can be picked: the first `used` logits. */
  used: number;
  /** The compiled build of that name. */
  compile(build: Build): Promise<WebAssembly.Module>;
  /** Writes the model's bytes into `into`, which is exactly the blob's size. */
  fill(into: Uint8Array): Promise<void>;
  /** Threads wanted for long prompts. More than one needs `spawn` and SharedArrayBuffer. */
  threads?: number;
  /** false runs the plain SIMD128 build even where relaxed SIMD is there, for the checks. */
  relaxed?: boolean;
  /** Starts a pool thread: instantiates `module` on `memory` and runs worker_entry(tid). Resolves once it runs. */
  spawn?(module: WebAssembly.Module, memory: WebAssembly.Memory, tid: number): Promise<{ stop(): void }>;
  /** What the engine prints, which is only ever an error. */
  log?(line: string): void;
}

export class Engine {
  readonly build: Build;
  readonly threads: number;
  /** Tokens whose keys and values are in the cache, by position. */
  private readonly cached: number[] = [];
  private readonly x: Exports;
  private readonly memory: WebAssembly.Memory;
  private readonly tmax: number;
  private readonly maxctx: number;
  private readonly used: number;
  private readonly pool: { stop(): void }[];

  private constructor(build: Build, x: Exports, memory: WebAssembly.Memory, used: number, pool: { stop(): void }[]) {
    this.build = build;
    this.x = x;
    this.memory = memory;
    this.used = used;
    this.pool = pool;
    this.tmax = x.pc_tmax();
    this.maxctx = x.pc_maxctx();
    this.threads = x.pc_threads();
  }

  static async load(o: EngineOptions): Promise<Engine> {
    const relaxed = o.relaxed !== false && relaxedSimd();
    const want = Math.max(1, Math.min(o.threads ?? 1, 16));
    const mt = want > 1 && !!o.spawn && typeof SharedArrayBuffer === "function" && (globalThis.crossOriginIsolated ?? true);
    let build: Build = `${relaxed ? "relaxed" : "simd"}${mt ? "-mt" : ""}` as Build;
    let module: WebAssembly.Module;
    try {
      module = await o.compile(build);
    } catch (e) {
      // A browser that validates the probe and still refuses the build —
      // or a build missing from the deploy — gets the plain one.
      if (!relaxed) throw e;
      build = mt ? "simd-mt" : "simd";
      module = await o.compile(build);
    }
    // Shared memory is made here and imported; the single-thread builds
    // export their own. 256 MB is the builds' declared maximum; about 30 is used.
    const shared = mt ? new WebAssembly.Memory({ initial: 512, maximum: 4096, shared: true }) : null;
    let memory: WebAssembly.Memory | null = shared;
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi(() => memory!, o.log ?? (() => {})),
      ...(shared ? { env: { memory: shared } } : {}),
    });
    const x = instance.exports as unknown as Exports;
    memory ??= x.memory!;
    x._initialize();
    const size = x.pc_init(o.shape.V, o.shape.d, o.shape.L, o.shape.nh, o.shape.nkv, o.shape.ffn);
    await o.fill(new Uint8Array(memory.buffer, x.pc_blob(), size));
    let pool: { stop(): void }[] = [];
    let threads = 1;
    if (mt) {
      // All or none: the pool counts its threads in, so one that never
      // started would leave every long prompt waiting for it.
      const started = await Promise.allSettled(
        Array.from({ length: want - 1 }, (_, i) => withTimeout(o.spawn!(module, memory!, i + 1), 10_000)),
      );
      pool = started.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      if (pool.length === want - 1) threads = want;
      else {
        pool.forEach((t) => t.stop());
        pool = [];
      }
    }
    if (x.pc_load(threads) !== 0) throw new Error("the engine could not load the model");
    return new Engine(build, x, memory, o.used, pool);
  }

  get kv8(): boolean {
    return this.x.pc_kv8() === 1;
  }

  /** The most tokens a prompt plus its completion can hold. */
  get capacity(): number {
    return this.maxctx;
  }

  /**
   * Puts `prompt` in the cache and leaves the last token's logits. Only what
   * differs from the cache's contents is run — at least the last token, for
   * its logits. Returns how many tokens ran, or null when `stop` said to.
   */
  async prefill(prompt: readonly number[], stop: Stop): Promise<number | null> {
    if (!prompt.length || prompt.length > this.maxctx) throw new Error(`prompt of ${prompt.length} tokens`);
    const c = this.cached;
    const limit = Math.min(c.length, prompt.length - 1);
    let k = 0;
    while (k < limit && c[k] === prompt[k]) k++;
    c.length = k;
    const ran = prompt.length - k;
    while (k < prompt.length) {
      if (await stop()) return null;
      const n = Math.min(this.tmax, prompt.length - k);
      new Int32Array(this.memory.buffer, this.x.pc_tokens(), n).set(prompt.slice(k, k + n));
      if (this.x.pc_forward(n, k, k + n === prompt.length ? 1 : 0) !== 0) throw new Error("forward failed");
      for (let i = k; i < k + n; i++) c.push(prompt[i]!);
      k += n;
    }
    return ran;
  }

  /**
   * Greedy decoding from the logits prefill left. The first pick is limited
   * to `first` (a 0/1 mask over the vocabulary) when given; decoding ends
   * when `end` says so or after `maxNew + 1` tokens. Each picked token but the
   * last is run, so the cache holds the prompt and all but the last of these.
   */
  async decode(first: Uint8Array | null, maxNew: number, end: (id: number) => boolean, stop: Stop): Promise<{ ids: number[]; lps: number[] } | null> {
    const ids: number[] = [];
    const lps: number[] = [];
    if (first) new Uint8Array(this.memory.buffer, this.x.pc_mask(), first.length).set(first);
    for (;;) {
      const id = this.x.pc_pick(this.used, ids.length === 0 && first ? this.x.pc_mask() : 0);
      if (id < 0) return { ids, lps };
      ids.push(id);
      lps.push(this.x.pc_lp());
      if (end(id) || ids.length > maxNew) return { ids, lps };
      if (this.cached.length >= this.maxctx) return { ids, lps };
      if (await stop()) return null;
      new Int32Array(this.memory.buffer, this.x.pc_tokens(), 1)[0] = id;
      if (this.x.pc_forward(1, this.cached.length, 1) !== 0) throw new Error("forward failed");
      this.cached.push(id);
    }
  }

  /** The last logits, for the tests. */
  logits(n: number): Float32Array {
    return new Float32Array(this.memory.buffer, this.x.pc_logits(), n).slice();
  }

  /** Forgets the cache, so the next prompt runs whole. */
  reset(): void {
    this.cached.length = 0;
  }

  stop(): void {
    this.pool.forEach((t) => t.stop());
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * The six WASI calls the C library makes: its clock, and writing an error
 * before exiting. Text is copied out of memory before decoding, since
 * TextDecoder refuses views of shared memory.
 */
export function wasi(memory: () => WebAssembly.Memory, log: (line: string) => void): Record<string, (...a: number[]) => number> {
  const dec = new TextDecoder();
  return {
    fd_write(_fd, iovs, n, written) {
      const dv = new DataView(memory().buffer);
      let total = 0;
      let s = "";
      for (let i = 0; i < n!; i++) {
        const p = dv.getUint32(iovs! + i * 8, true);
        const l = dv.getUint32(iovs! + i * 8 + 4, true);
        s += dec.decode(new Uint8Array(memory().buffer, p, l).slice());
        total += l;
      }
      dv.setUint32(written!, total, true);
      if (s.trim()) log(s.trimEnd());
      return 0;
    },
    fd_close: () => 0,
    fd_seek: () => 70, // ESPIPE: nothing here is seekable
    fd_fdstat_get(_fd, stat) {
      new Uint8Array(memory().buffer, stat!, 24).fill(0);
      return 0;
    },
    clock_time_get(_id, _precision, out) {
      new DataView(memory().buffer).setBigUint64(out!, BigInt(Math.round(performance.now() * 1e6)), true);
      return 0;
    },
    proc_exit(code) {
      throw new Error(`the engine stopped (exit ${code})`);
    },
  };
}

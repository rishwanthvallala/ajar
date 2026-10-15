/**
 * The fast javac, off the page's thread: javac compiled ahead of time to
 * WebAssembly by TeaVM (build-java.mjs), given the class library it compiles
 * against once and then each request as it comes. See protocol.ts.
 *
 * It needs WebAssembly GC and exception references. A browser without them
 * fails to load it, says so once, and `javac` in the sandbox goes on using the
 * slow compiler, which works everywhere.
 */
import { compile, decodeRequest, encodeAnswer, type TeaJavac } from "./protocol";

export interface JavacAssets {
  /** TeaVM's runtime for the module, an ES module. */
  runtime: string;
  wasm: string;
  /** The class library, in teavm-javac's archive format. */
  sdk: string;
  /** The Java release that class library is, as --release names it. */
  release: string;
}

export type ToWorker = { kind: "load"; assets: JavacAssets } | { kind: "compile"; id: string; request: ArrayBuffer };
export type FromWorker =
  | { kind: "ready"; ms: number }
  | { kind: "failed"; error: string }
  | { kind: "answer"; id: string; answer: ArrayBuffer }
  | { kind: "error"; id: string; error: string };

// Typed by hand: the webworker library's types would replace the DOM's for
// the whole program.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
};
let assets: JavacAssets | null = null;
let javac: Promise<TeaJavac> | null = null;

async function start(a: JavacAssets): Promise<TeaJavac> {
  const { load } = (await import(/* @vite-ignore */ a.runtime)) as {
    load(src: string, options: unknown): Promise<{ exports: { createJavac(sdk: Int8Array, release: string): TeaJavac } }>;
  };
  const [module, sdk] = await Promise.all([
    load(a.wasm, { stackDeobfuscator: { enabled: false } }),
    fetch(a.sdk).then((r) => {
      if (!r.ok) throw new Error(`${a.sdk}: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return module.exports.createJavac(new Int8Array(sdk), a.release);
}

scope.onmessage = async (event: MessageEvent<ToWorker>) => {
  const m = event.data;
  if (m.kind === "load") {
    assets = m.assets;
    const began = performance.now();
    javac = start(m.assets);
    javac.then(
      () => scope.postMessage({ kind: "ready", ms: Math.round(performance.now() - began) } satisfies FromWorker),
      (e) => scope.postMessage({ kind: "failed", error: String(e?.message ?? e) } satisfies FromWorker),
    );
    return;
  }
  try {
    if (!javac && assets) javac = start(assets);
    if (!javac) throw new Error("javac was never loaded");
    const answer = encodeAnswer(compile(await javac, decodeRequest(new Uint8Array(m.request))));
    const buffer = answer.buffer as ArrayBuffer;
    scope.postMessage({ kind: "answer", id: m.id, answer: buffer } satisfies FromWorker, [buffer]);
  } catch (e) {
    // A trap in the module — a stack overflow on a deeply nested expression —
    // can leave it unusable, so the next request gets a fresh one.
    javac = null;
    scope.postMessage({ kind: "error", id: m.id, error: String((e as Error)?.message ?? e) } satisfies FromWorker);
  }
};

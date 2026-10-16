/**
 * The page's half of the fast javac: it answers the sandbox's `javac`.
 *
 * Everything goes through files in `.ajar/javac/`, the one place both sides
 * see (protocol.ts says what is in them):
 *
 *   ready         the page has a compiler; without it `javac` does not ask
 *   <id>.req      a request, renamed into place by the sandbox once whole
 *   <id>.claim    the page has it. Unclaimed after two seconds, the sandbox
 *                 removes the request and compiles it itself; a claim made as
 *                 it does so is answered -1, "compile it yourself"
 *   <id>.ans      the answer, renamed into place once written whole
 *
 * The page only reads the sandbox's files. A rename made from the page left
 * the old name listed in the sandbox, unreadable; so it writes its own, and the
 * sandbox removes all of them once it has its answer.
 *
 * The folder is looked at only while a command runs, and only once Java is
 * here, so a pad that never uses Java never polls.
 *
 * The compiler loads when Java arrives, not at the first `javac`, so it is
 * ready by then: about 3.5 MB on a first visit, and a quarter of a second to
 * start. If it cannot load, there is no `ready`, and `javac` keeps using the
 * compiler that is in the sandbox.
 */
import type { Sandbox } from "@wasmer/sdk";
import { encodeAnswer } from "./protocol";
import type { FromWorker, JavacAssets, ToWorker } from "./worker";

const DIR = "/workspace/.ajar/javac";
/** How often the folder is looked at while a command runs. */
const POLL_MS = 40;

export class JavacBridge {
  private worker: Worker | null = null;
  private ready = false;
  private started: Promise<boolean> | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private looking = false;
  /** Requests claimed and not yet answered. */
  private serving = new Set<string>();
  private pending = new Map<string, (r: FromWorker) => void>();

  constructor(
    private readonly box: () => Promise<Sandbox | null>,
    private readonly note: (line: string) => void = () => {},
  ) {}

  /**
   * Java is arriving: start the compiler alongside it. Resolves true when it
   * is ready and `ready` is written, false when it could not start.
   */
  load(): Promise<boolean> {
    if (this.started) {
      return this.started.then(async (ok) => {
        if (ok) await this.markReady();
        return ok;
      });
    }
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    this.started = new Promise<boolean>((resolve) => {
      worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const m = event.data;
        if (m.kind === "ready") {
          this.ready = true;
          void this.markReady().then(() => resolve(true));
          this.poll();
        } else if (m.kind === "failed") {
          // javac still works, just slowly: say why once, where it shows.
          this.note(`the fast javac could not start here (${m.error}); javac compiles in the sandbox instead`);
          resolve(false);
        } else {
          this.pending.get(m.id)?.(m);
          this.pending.delete(m.id);
        }
      };
      void assets().then((a) => {
        if (a) worker.postMessage({ kind: "load", assets: a } satisfies ToWorker);
        else resolve(false);
      });
    });
    return this.started;
  }

  /** Whether the compiler is ready, waiting at most `ms` for it. */
  async whenReady(ms: number): Promise<boolean> {
    if (!this.started) return false;
    return Promise.race([this.started, new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  }

  /** A command started or finished: look for requests only while one runs. */
  busy(running: boolean): void {
    this.running = running;
    this.poll();
  }

  private poll(): void {
    if (this.ready && this.running && !this.timer) {
      this.timer = setInterval(() => void this.look(), POLL_MS);
    } else if (!(this.ready && this.running) && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async markReady(): Promise<void> {
    const box = await this.box();
    if (!box) return;
    await box.fs.mkdir(DIR, { recursive: true }).catch(() => {});
    await box.fs.writeFile(`${DIR}/ready`, new Uint8Array()).catch(() => {});
  }

  private async look(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    try {
      const box = await this.box();
      if (!box) return;
      const names = new Set((await box.fs.readDir(DIR).catch(() => [])).map((e) => e.name));
      for (const name of names) {
        if (!name.endsWith(".req")) continue;
        const id = name.slice(0, -4);
        if (this.serving.has(id) || names.has(`${id}.claim`)) continue;
        this.serving.add(id);
        void box.fs
          .writeFile(`${DIR}/${id}.claim`, new Uint8Array())
          .then(() => this.serve(box, id))
          .finally(() => this.serving.delete(id));
      }
    } finally {
      this.looking = false;
    }
  }

  private async serve(box: Sandbox, id: string): Promise<void> {
    let answer: ArrayBuffer;
    try {
      const request = await box.fs.readFile(`${DIR}/${id}.req`);
      const reply = await this.ask(id, request);
      // A compiler that failed answers -1: compile it in the sandbox instead.
      answer = reply.kind === "answer" ? reply.answer : fallback();
    } catch {
      answer = fallback();
    }
    await box.fs.writeFile(`${DIR}/${id}.ans.part`, new Uint8Array(answer)).catch(() => {});
    await box.fs.rename(`${DIR}/${id}.ans.part`, `${DIR}/${id}.ans`).catch(() => {});
  }

  private ask(id: string, request: Uint8Array): Promise<FromWorker> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("no compiler"));
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const copy = request.slice().buffer as ArrayBuffer;
      worker.postMessage({ kind: "compile", id, request: copy } satisfies ToWorker, [copy]);
    });
  }
}

/** The answer that means "compile it yourself". */
function fallback(): ArrayBuffer {
  return encodeAnswer({ exit: -1, stdout: "", stderr: "", written: [] }).buffer as ArrayBuffer;
}

/** Where the compiler's files are: own.json, written by build-java.mjs. */
async function assets(): Promise<JavacAssets | null> {
  try {
    const own = (await (await fetch("/packages/own.json")).json()) as { javac?: JavacAssets };
    return own.javac ?? null;
  } catch {
    return null;
  }
}

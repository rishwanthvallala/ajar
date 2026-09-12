/**
 * The WASIX runtime: one sandbox per session, and a way to run things in it.
 *
 * ## Where the files are
 *
 * The JavaScript filesystem view and the process filesystem view are *not the
 * same namespace*, and nothing in the API says so. Measured:
 *
 * ```text
 *   JS  rt.fs.readDir("/")        ->  transform.py  data.txt
 *   py  os.getcwd()               ->  /workspace
 *   py  os.listdir(".")           ->  transform.py  data.txt
 * ```
 *
 * So **the JS root is the process's working directory**. A file JS writes to
 * `/out.csv` is `out.csv` to the program, and a file the program writes in its
 * cwd is readable at `/out.csv`. Paths the JS side invents that look absolute
 * to a process — `/app/thing.py` — land at `/workspace/app/thing.py` instead,
 * which is how the first version of this file spent an afternoon watching
 * Python report `[Errno 44]` for a file `readDir` could plainly see.
 *
 * The convention, therefore: **every path in this application is root-relative
 * in the JS view, and every command is given a bare relative path.**
 *
 * ## Why the SDK is vendored
 *
 * `@wasmer/sdk` resolves its worker at runtime with `new URL(…,
 * import.meta.url)`, and that worker statically imports two siblings. Bundling
 * flattens the layout, the siblings 404, and every command hangs forever with
 * nothing thrown. See `vendor-wasmer-sdk` in vite.config.ts.
 *
 * ## Browser only
 *
 * The same package fails to compile under Node with `Validate("Unknown
 * validation error")`. The browser is the target, so this is not a problem to
 * solve — but it does mean the checks have to drive a real browser.
 */
import type { CommandRef, Sandbox, Wasmer as WasmerClass } from "@wasmer/sdk";

declare const __SDK_URL__: string;

/**
 * The binary set, pinned.
 *
 * Which versions are available is part of the product rather than an
 * implementation detail — a folder that ran last week has to run this week.
 *
 * Every one of these is a version the registry actually publishes. An invented
 * one fails at sandbox construction with a registry error, which is a long way
 * from the line that guessed it.
 */
export const PACKAGES = {
  shell: "sharrattj/bash@1.0.18",
  coreutils: "sharrattj/coreutils@1.0.16",
  python: "python/python@3.13.20",
  // The text-processing three. They live under `wasmer/`, not `sharrattj/`,
  // which is why an earlier search concluded they did not exist at all — the
  // registry's own search returns nothing for any query, including `python`,
  // so a namespace guess is the only way to find anything.
  grep: "wasmer/grep@3.12.0",
  sed: "wasmer/sed@4.9.0",
  find: "wasmer/find@4.10.0",
} as const;

/** Extension to the command that runs it. Anything absent is not runnable. */
export const INTERPRETERS: Record<string, string> = {
  py: "python",
};

export function interpreterFor(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return INTERPRETERS[ext] ?? null;
}

let loading: Promise<{ Wasmer: typeof WasmerClass }> | null = null;

function sdk() {
  // `@vite-ignore` keeps the bundler out of this path so the browser resolves
  // it against the vendored copy, where the SDK's own relative imports line up.
  loading ??= import(/* @vite-ignore */ `${__SDK_URL__}/dist/index.js`) as Promise<{
    Wasmer: typeof WasmerClass;
  }>;
  return loading;
}

/**
 * Serve the pinned packages from this origin.
 *
 * Registered before anything asks for a package. The SDK has no registry
 * override and its browser build cannot decode in-memory WEBC —
 * `packages.load(bytes)` fails with `FeatureNotEnabled { "authoring" }` — so
 * rewriting the request in a service worker is the available interception
 * point, and the only one that also covers the workers the SDK downloads in.
 *
 * Failure here is not fatal: without the worker the packages come from
 * Wasmer's CDN, uncompressed and slower, which is worse but not broken.
 */
export async function mirrorPackages(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    // A worker that is registered but not yet controlling this page would let
    // the first — and largest — download slip past it.
    if (!navigator.serviceWorker.controller && reg.active) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
          once: true,
        });
        setTimeout(resolve, 2000);
      });
    }
    return navigator.serviceWorker.controller !== null;
  } catch {
    return false;
  }
}

/**
 * Start fetching the runtime without waiting for it.
 *
 */
export function prefetch(): void {
  void sdk();
}

export interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Entry {
  path: string;
  size: number;
}

export class Runtime {
  private constructor(
    private readonly box: Sandbox,
    private readonly bash: CommandRef,
  ) {}

  /** `files` keys are root-relative JS paths: `"main.py"`, not `"/app/main.py"`. */
  static async start(files: Record<string, string> = {}): Promise<Runtime> {
    const { Wasmer } = await sdk();
    const wasmer = new Wasmer();

    // By registry name, with the service worker quietly serving our mirror.
    // Loaded as an object rather than a string because more than one installed
    // package exports a command called `bash` — the python package ships one
    // too — and a bare name is refused as ambiguous.
    const shellPkg = await wasmer.packages.load(PACKAGES.shell);
    const bash = shellPkg.command("bash");

    const box = await wasmer.sandboxes.create({
      packages: [
        shellPkg,
        PACKAGES.coreutils,
        PACKAGES.python,
        PACKAGES.grep,
        PACKAGES.sed,
        PACKAGES.find,
      ],
      shell: bash,
      files: Object.fromEntries(Object.entries(files).map(([p, c]) => [`/${p}`, c])),
    });
    return new Runtime(box, bash);
  }

  /**
   * Run a command. A non-zero exit is a result, not an exception — a failing
   * script is the normal case here and the output is the point.
   */
  async run(program: string, args: string[]): Promise<Ran> {
    const out = await this.box.command(program, args).run({ check: false });
    return { exitCode: out.exitCode, stdout: out.stdout.text(), stderr: out.stderr.text() };
  }

  read(path: string): Promise<string> {
    return this.box.fs.readText(`/${path}`);
  }

  async write(path: string, contents: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      await this.box.fs.mkdir(`/${path.slice(0, slash)}`, { recursive: true });
    }
    await this.box.fs.writeText(`/${path}`, contents);
  }

  /**
   * Every file in the sandbox, recursively.
   *
   * `FileStat` carries `kind` and `size` and nothing else — no mtime, no hash —
   * so a caller comparing this against a previous listing can only use size as
   * a first filter and must read anything it cannot rule out. That is
   * affordable because the folder is capped; it would not be otherwise.
   */
  async list(dir = ""): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const entry of await this.box.fs.readDir(`/${dir}`)) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        out.push(...(await this.list(path)));
      } else {
        out.push({ path, size: entry.size });
      }
    }
    return out;
  }

  /**
   * A long-lived interactive shell with a terminal attached.
   *
   * One of these per session, not one per command — the whole point of Run
   * typing into a shell rather than executing on its own is that there is a
   * single environment, and a fresh process per command would be several.
   */
  spawnShell(columns: number, rows: number) {
    // Only `terminal`. The SDK's own docs say it implies piped stdio, and
    // naming the three explicitly alongside it silently replaces the pty with
    // plain pipes — bash then sees no tty, prints no prompt, echoes nothing,
    // and the terminal can only ever be written to. That cost this project a
    // wrong conclusion in a design note: interactive shells are fine here.
    return this.box.command(this.bash, ["-i"]).spawn({ terminal: { columns, rows } });
  }

  close(): Promise<void> {
    return this.box.close();
  }
}

/**
 * Install each candidate package and make it prove it works.
 *
 * Runs in a browser because the runtime needs cross-origin isolation for
 * SharedArrayBuffer, and because a package can fail wasm validation under node
 * while being perfectly fine here — the python package does exactly that.
 *
 * Each candidate gets its own sandbox. A package that fails to load, or hangs,
 * must not take the rest of the run with it: the whole point is to find out
 * which of a long list are usable, and one bad entry would otherwise hide the
 * answer for every entry after it.
 */
import { PACKAGES, Runtime } from "./runtime";
import { Shell } from "./shell";
import { CANDIDATES, type Candidate, type Check } from "./packages/catalogue";

export interface CheckResult {
  run: string;
  covers: string;
  ok: boolean;
  optional: boolean;
  why?: string;
  got?: string;
  want?: string;
  exit?: number;
}

export interface Result {
  name: string;
  gives: string;
  shipped: boolean;
  heavy: boolean;
  loaded: boolean;
  /** Wall-clock cost of installing it, which is what a first command pays. */
  loadMs: number;
  error?: string;
  checks: CheckResult[];
}

/** A package that hangs is a result, not a reason to wait forever. */
function within<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Output arrives through a pty, so a tool that colourises for a terminal —
// jq does — will have done so. Comparing against plain text would fail a
// working tool for being well behaved, so the colour comes off first.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const norm = (s: string) => s.replace(ANSI, "").replace(/\r\n/g, "\n").trim();

async function probe(c: Candidate): Promise<Result> {
  const out: Result = {
    name: c.name,
    gives: c.gives,
    shipped: !!c.shipped,
    heavy: !!c.heavy,
    loaded: false,
    loadMs: 0,
    checks: [],
  };

  let rt: Runtime | null = null;
  let sh: Shell | null = null;
  let captured = "";
  try {
    // Built the way the product builds it, and driven through the same pty
    // shell. An earlier version of this probe called `box.command("bash",
    // ["-c", …])` directly and every candidate failed with a wasm signature
    // mismatch — that path is not the one the product uses and not one the
    // runtime supports for a shell.
    const began = performance.now();

    // The candidate is installed *alongside the shipped set*, not on its own.
    //
    // A reduced sandbox changes behaviour in ways that look like the candidate
    // failing. Two were found the hard way: without python the working
    // directory is wrong and every relative path resolves against `/`; without
    // the full set a file written by python is invisible to `cat`. Both looked
    // exactly like a broken package. Testing against what the product actually
    // installs is the only environment whose results transfer.
    const shipped: string[] = [
      PACKAGES.coreutils,
      PACKAGES.python,
      PACKAGES.grep,
      PACKAGES.sed,
      PACKAGES.find,
      PACKAGES.jq,
      PACKAGES.gzip,
      PACKAGES.tar,
      PACKAGES.sqlite,
      PACKAGES.quickjs,
    ];
    const packages = shipped.filter((pkg) => pkg !== c.name);
    if (!c.isShell && !packages.includes(c.name)) packages.push(c.name);
    for (const extra of c.with ?? []) packages.push(extra);

    rt = await within(
      `install ${c.name}`,
      300_000,
      // Seeded with a file so the working directory exists. An empty sandbox
      // has no /workspace, and every check that writes then reads came back
      // empty with exit 1 — which looks exactly like a broken package.
      c.name === "__shipped__"
        ? Runtime.start({ "seed.txt": "seeded\n" })
        : Runtime.start(
            { "seed.txt": "seeded\n" },
            { shell: c.isShell ? c.name : PACKAGES.shell, packages },
          ),
    );
    // Shell.run reports only an exit code; what a command printed arrives
    // through this callback, so each check clears the buffer and then reads it.
    sh = await within(
      `shell for ${c.name}`,
      120_000,
      Shell.open(rt, { columns: 80, rows: 24 }, (t) => {
        captured += t;
      }),
    );
    out.loadMs = Math.round(performance.now() - began);
    out.loaded = true;
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }

  for (const check of c.checks) {
    captured = "";
    out.checks.push(await one(sh, check, () => captured));
  }
  try {
    await sh.close();
    await rt.close();
  } catch {
    /* best effort: the page is torn down after the run either way */
  }
  return out;
}

async function one(sh: Shell, check: Check, printed: () => string): Promise<CheckResult> {
  const base: CheckResult = {
    run: check.run,
    covers: check.covers,
    ok: false,
    optional: !!check.optional,
    why: check.why,
  };
  try {
    const ran = await within(check.run, check.timeoutMs ?? 90_000, sh.run(check.run));
    const got = norm(printed());
    base.got = got.slice(0, 2000);
    base.exit = ran.exitCode;
    if (check.want !== undefined) {
      base.want = check.want;
      base.ok = got === norm(check.want);
    } else if (check.match !== undefined) {
      base.want = `/${check.match}/`;
      base.ok = new RegExp(check.match, "m").test(got);
    }
  } catch (e) {
    base.got = (e as Error).message;
  }
  return base;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const all = params.get("all") === "1";
  const only = params.get("only");

  let list = CANDIDATES;
  if (only) list = list.filter((c) => only.split(",").includes(c.name));
  else if (!all) list = list.filter((c) => !c.heavy || c.shipped);

  const results: Result[] = [];
  for (const c of list) {
    results.push(await probe(c));
    (window as unknown as { __progress: number }).__progress = results.length;
  }
  (window as unknown as { __results: Result[] }).__results = results;
  (window as unknown as { __done: boolean }).__done = true;
}

void main();

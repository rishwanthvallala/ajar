/**
 * What has to be true for any of this to work, asserted in a real browser.
 *
 * Node cannot run these — the python package fails wasm validation there — so
 * this page is driven by `scripts/browser-check.mjs` under headless Chromium.
 */
import { interpreterFor, Runtime } from "./runtime";

const results: string[] = [];
const el = document.getElementById("log")!;
const report = (line: string) => {
  results.push(line);
  el.textContent = results.join("\n");
  (window as unknown as { __results: string[] }).__results = results;
};
const ok = (m: string) => report(`ok   ${m}`);
const fail = (m: string) => report(`FAIL ${m}`);
const is = (actual: unknown, expected: unknown, m: string) =>
  actual === expected ? ok(m) : fail(`${m} — got ${JSON.stringify(actual)}`);

async function main() {
  is(globalThis.crossOriginIsolated, true, "the document is cross-origin isolated");
  is(typeof SharedArrayBuffer !== "undefined", true, "SharedArrayBuffer is available");

  const started = performance.now();
  const rt = await Runtime.start({
    "transform.py": "print(open('data.txt').read().strip().upper())\n",
    "data.txt": "hello\n",
  });
  ok(`runtime started (${Math.round(performance.now() - started)}ms cold)`);

  // The convention this whole application rests on: the JS filesystem root is
  // the process's working directory, so a bare filename means the same file on
  // both sides.
  const cwd = await rt.run("python", ["-c", "import os;print(os.getcwd())"]);
  is(cwd.stdout.trim(), "/workspace", "the process works in /workspace");

  const ran = await rt.run("python", ["transform.py"]);
  is(ran.exitCode, 0, "a script runs by its bare relative path");
  is(ran.stdout.trim(), "HELLO", "the script read a file the page wrote");

  await rt.run("python", ["-c", "open('out.csv','w').write('n,sq\\n2,4\\n')"]);
  is((await rt.read("out.csv")).trim(), "n,sq\n2,4", "the page reads a file the script wrote");

  await rt.write("nested/deep.txt", "made by the page");
  const nested = await rt.run("python", ["-c", "print(open('nested/deep.txt').read())"]);
  is(nested.stdout.trim(), "made by the page", "nested directories are created on write");

  const listing = await rt.list();
  const paths = listing.map((e) => e.path).sort().join(" ");
  is(paths, "data.txt nested/deep.txt out.csv transform.py", "list() walks the tree recursively");

  // A failing script is the normal case, not an exception.
  const boom = await rt.run("python", ["-c", "raise SystemExit(3)"]);
  is(boom.exitCode, 3, "a non-zero exit is returned rather than thrown");

  is(interpreterFor("a.py"), "python", "a .py file knows its interpreter");
  is(interpreterFor("a.rs"), null, "an unrunnable extension says so");

  const warm = performance.now();
  await rt.run("python", ["-c", "pass"]);
  ok(`a warm run costs ${Math.round(performance.now() - warm)}ms`);

  await rt.close();
  report("DONE");
}

main().catch((e) => {
  fail(`${e?.message ?? e} | ${e?.cause?.message ?? ""}`);
  report("DONE");
});

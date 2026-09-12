/**
 * What has to be true for any of this to work, asserted in a real browser.
 *
 * Node cannot run these — the python package fails wasm validation there — so
 * this page is driven by `scripts/browser-check.mjs` under headless Chromium.
 */
import { interpreterFor, Runtime } from "./runtime";
import { Shell } from "./shell";
import { mintName, Store, StoreError } from "./store";
import { diff, ignored, knownFrom } from "./sync";

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

  // ---- the shell, which the Run design depends on ----
  let printed = "";
  const sh = await Shell.open(rt, { columns: 80, rows: 24 }, (t) => {
    printed += t;
  });

  // Recorded rather than asserted: whether bash sees a tty decides whether a
  // prompt or an echo can ever be relied on, and the answer here is no.
  const tty = await sh.run("test -t 0 && echo TTY || echo NOTTY");
  report(`note: stdin is a ${printed.includes("TTY") && !printed.includes("NOTTY") ? "tty" : "pipe"} to bash`);
  is(tty.exitCode, 0, "a command reports its exit status back");

  printed = "";
  const ran2 = await sh.run("python -c 'print(21*2)'");
  is(printed.includes("42"), true, "python runs inside the session shell");
  is(ran2.exitCode, 0, "a successful command reports 0");
  is(printed.includes("\u0001"), false, "the sentinel never reaches the terminal");

  const bad = await sh.run("python -c 'raise SystemExit(7)'");
  is(bad.exitCode, 7, "a failing command reports its real status");

  printed = "";
  await sh.run("python -c \"open('from-shell.txt','w').write('via bash')\"");
  try {
    is(await rt.read("from-shell.txt"), "via bash", "the page sees what the shell wrote");
  } catch (e) {
    fail(`the page could not read what the shell wrote: ${(e as Error).message}`);
  }

  // Sequential commands keep their own output and their own status.
  printed = "";
  await sh.run("echo first");
  const second = await sh.run("echo second");
  is(printed.includes("first") && printed.includes("second"), true, "commands run in sequence");
  is(second.exitCode, 0, "and each reports separately");
  is(sh.busy, false, "the shell reports itself idle once a command has finished");

  // ---- the diff, which decides what anyone else ever sees ----
  let known = knownFrom({});
  const first = await diff(rt, known);
  is(
    first.changes.some((c) => c.path === "from-shell.txt"),
    true,
    "a file the shell made shows up as a change",
  );
  known = first.next;

  const quiet = await diff(rt, known);
  is(quiet.changes.length, 0, "running the diff again finds nothing to send");

  await sh.run("python -c \"open('note.txt','w').write('hello')\"");
  const added = await diff(rt, known);
  is(
    added.changes.filter((c) => c.path === "note.txt").length,
    1,
    "a new file is one change",
  );
  known = added.next;

  // The case size alone cannot catch, and the reason this reads every file.
  await sh.run("python -c \"open('note.txt','w').write('HELLO')\"");
  const rewritten = await diff(rt, known);
  is(
    rewritten.changes.find((c) => c.path === "note.txt")?.content,
    "HELLO",
    "a same-length rewrite is still detected",
  );
  known = rewritten.next;

  await sh.run("rm note.txt");
  const removed = await diff(rt, known);
  is(
    removed.changes.find((c) => c.path === "note.txt")?.content,
    null,
    "a deleted file is sent as a removal",
  );
  known = removed.next;

  // Tool droppings stay out of the shared folder.
  await rt.write("__pycache__/x.pyc", "bytecode");
  const noise = await diff(rt, known);
  is(noise.changes.length, 0, "generated files are not published");
  is(ignored("a/__pycache__/m.pyc"), true, "the ignore rule matches nested paths");

  // ---- names ----
  is(/^[a-z]+-[a-z]+-\d{4}$/.test(mintName()), true, "a minted name fits the server's rule");
  is(mintName() !== mintName(), true, "two minted names differ");

  // ---- the store, over real http ----
  const store = new Store();
  const name = mintName();
  const fresh = await store.read(name);
  is(fresh.exists, false, "a name nobody holds reads as free rather than 404");

  const seq1 = await store.write(name, [{ path: "main.py", content: "print(1)" }]);
  is(seq1, 1, "the first write is sequence 1");
  const loaded = await store.read(name);
  is(loaded.files["main.py"]?.content, "print(1)", "what was written comes back");
  is(loaded.exists, true, "and the pad now exists");

  const seq2 = await store.write(name, [{ path: "main.py", content: null }]);
  is(seq2, 2, "the sequence advances on every accepted write");
  is(Object.keys((await store.read(name)).files).length, 0, "a null content deletes");

  try {
    await store.write("api", [{ path: "x", content: "y" }]);
    fail("a reserved name was accepted");
  } catch (e) {
    is(e instanceof StoreError && e.status === 400, true, "a reserved name is refused");
  }

  await sh.close();

  await rt.close();
  report("DONE");
}

main().catch((e) => {
  fail(`${e?.message ?? e} | ${e?.cause?.message ?? ""}`);
  report("DONE");
});

/**
 * What has to be true for any of this to work, asserted in a real browser.
 *
 * Node cannot run these — the python package fails wasm validation there — so
 * this page is driven by `scripts/browser-check.mjs` under headless Chromium.
 */
import { interpreterFor, Runtime } from "./runtime";
import { cssString } from "./editing";
import { Shell } from "./shell";
import { mintName, Store, StoreError } from "./store";
import { seedFiles } from "./seed";
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

  // What the sandbox is seeded with. These run before the runtime because a
  // wrong answer here is invisible afterwards: the sandbox comes up with every
  // filename present and the wrong contents inside, which reads as a working
  // pad that quietly does nothing.
  //
  // Three attempts to catch this through the browser all passed against the
  // broken code — the snapshot is taken during the editor binding, and the race
  // did not land the same way under a driver. See docs/dev/testing.md.
  {
    const model = (text: string) => ({ getValue: () => text });
    const doc = (text: string) => ({ contents: () => text });

    // The bug. The store has the file, the model has not been filled yet.
    is(
      seedFiles(new Map([["a.py", "print(1)\n"]]), new Map([["a.py", model("")]]), new Map())["a.py"],
      "print(1)\n",
      "a file whose model has not loaded yet is seeded from the store",
    );
    // And the reason the store cannot simply win outright.
    is(
      seedFiles(new Map([["a.py", "old\n"]]), new Map([["a.py", model("edited\n")]]), new Map())["a.py"],
      "edited\n",
      "an unsaved edit beats the stored copy",
    );
    // A document, once there is one, is ahead of the model it fills.
    is(
      seedFiles(
        new Map([["a.py", "old\n"]]),
        new Map([["a.py", model("")]]),
        new Map([["a.py", doc("from the room\n")]]),
      )["a.py"],
      "from the room\n",
      "a document beats both the model and the store",
    );
    // Empty is the truth only for a file the store has never heard of.
    is(
      seedFiles(new Map(), new Map([["new.txt", model("")]]), new Map())["new.txt"],
      "",
      "a brand new empty file is still created in the sandbox",
    );
    is(
      Object.keys(seedFiles(new Map([["only-stored.txt", "x\n"]]), new Map(), new Map())).join(),
      "only-stored.txt",
      "a stored file nobody has opened is seeded too",
    );
  }

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

  // ---- a name cannot escape the stylesheet it is written into ----
  //
  // Cursor labels put a participant's chosen name inside a CSS string, and in
  // ajar that name is whatever somebody typed on joining. Stripping double
  // quotes — what this used to do — stops a name breaking *out* of the string,
  // and does nothing about a trailing backslash, which escapes the closing
  // quote so the string runs on and eats whatever rule comes next. A real
  // stylesheet always has a next rule: the labels are written one per person.
  {
    const sheet = document.createElement("style");
    document.head.append(sheet);

    // The label, then a rule that must survive it.
    const survives = (escaped: string) => {
      sheet.textContent =
        `.a::after { content: "${escaped}"; }\n` + `.sentinel { color: rgb(1, 2, 3); }`;
      return [...(sheet.sheet?.cssRules ?? [])].some((r) => r.cssText.includes("sentinel"));
    };
    const naive = (t: string) => t.replace(/"/g, "");
    const trailingSlash = "someone\\";

    is(survives(cssString(trailingSlash)), true, "a name ending in a backslash cannot eat the next rule");
    is(survives(cssString('quote" and brace }')), true, "quotes and braces in a name are harmless");
    is(survives(cssString("line\nbreak")), true, "a newline in a name does not end the rule");
    is(survives(cssString("plain")), true, "and an ordinary name is fine");

    // The check has to be able to fail. This is the exact escaping it
    // replaced, and it must not survive — otherwise the assertions above pass
    // for free and `cssString` could be gutted without anyone noticing.
    is(survives(naive(trailingSlash)), false, "the escaping this replaced would have eaten it");

    sheet.remove();
    is(cssString("plain name"), "plain name", "an ordinary name is left alone");
  }

  // ---- the text-processing tools ----
  //
  // grep, sed and find are real ports; awk is a python shim, because no awk is
  // published for this runtime. Checked the same way regardless — what matters
  // is that someone typing them gets what they expect.
  await rt.write("poem.txt", "alpha one 10\nbeta two 20\ngamma three 30\nalpha four 40\n");
  for (const [cmd, want] of [
    ["grep alpha poem.txt", "alpha one 10\nalpha four 40"],
    ["grep -c alpha poem.txt", "2"],
    ["grep -n beta poem.txt", "2:beta two 20"],
    ["grep -iE 'GAMMA|delta' poem.txt", "gamma three 30"],
    ["sed 's/alpha/ALPHA/' poem.txt | head -1", "ALPHA one 10"],
    ["sed -n '2p' poem.txt", "beta two 20"],
    ["cat poem.txt | grep two", "beta two 20"],
    ["awk '{print $1}' poem.txt | head -1", "alpha"],
    ["awk '$3 > 20 {print $1}' poem.txt", "gamma\nalpha"],
    ["awk '/beta/ {print $2}' poem.txt", "two"],
    ["awk -F' ' '{n += $3} END {print n}' poem.txt", "100"],
    ["awk '{print $1 \"-\" $3}' poem.txt | head -1", "alpha-10"],
    ["awk '$1 !~ /alpha/ {print $1}' poem.txt", "beta\ngamma"],
  ] as const) {
    printed = "";
    const r = await sh.run(cmd);
    if (printed.trim() === want) ok(cmd);
    else fail(`${cmd} — wanted ${JSON.stringify(want)}, got ${JSON.stringify(printed.trim())} (exit ${r.exitCode})`);
  }

  // find is ours now. The shipped binary did the work and then exited 1,
  // unable to restore its working directory under WASIX, and `-exec` produced
  // nothing at all because it cannot spawn — both invisible until something is
  // chained onto a search, at which point a correct result looks like a failed
  // one. The exit code is asserted here precisely because it used to be wrong.
  printed = "";
  const found = await sh.run("find . -name 'poem*'");
  is(printed.trim(), "./poem.txt", "find locates the file");
  is(found.exitCode, 0, "find exits 0 when it succeeds");

  printed = "";
  await sh.run("find . -name 'poem*' -exec wc -l {} \\;");
  is(printed.trim().split(/\s+/)[0], "4", "find -exec runs the command");

  printed = "";
  await sh.run("find . -name 'poem*' -exec cat {} +");
  is(printed.includes("alpha"), true, "find -exec ... + batches its matches");

  printed = "";
  await sh.run("find . -type f -name 'poem*' -o -name 'nothing*'");
  is(printed.trim(), "./poem.txt", "find understands -o");

  // The example in docs/use/pad.md, run verbatim. A user doc that promises a
  // command should be a check, not a hope.
  printed = "";
  await sh.run("find . -name '*.py' -exec wc -l {} +");
  is(printed.includes("transform.py"), true, "the -exec example from the user docs works");

  printed = "";
  const chained = await sh.run("find . -name 'poem*' && echo CHAINED");
  is(printed.includes("CHAINED"), true, "a search can be chained onto");
  is(chained.exitCode, 0, "and the chain succeeds");

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

/**
 * What has to be true for any of this to work, asserted in a real browser.
 *
 * Node cannot run these — the python package fails wasm validation there — so
 * this page is driven by `scripts/browser-check.mjs` under headless Chromium.
 */
import { parsePadLink } from "./access";
import { interpreterFor, mirrorPackages, Runtime } from "./runtime";
import { DelimitedState, tokenizeLine } from "@ajar/workspace-ui/delimited-tokens";
import { carryOver } from "./carry";
import type * as Monaco from "monaco-editor";
import { asEditorHolds, cssString, DocSession, eolOf, participantId } from "./editing";
import { Shell } from "./shell";
import { mintName, Store, StoreError } from "./store";
import { seedFiles } from "./seed";
import { diff, fromBase64, ignored, knownFrom, textOf, toBase64 } from "./sync";
import { crc32, makeZip, prepareImport, readZip, ZipError } from "./zip";

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
  // The packages from this origin, the way a visitor gets them. Without the
  // worker every run fetched them from Wasmer's CDN instead — python is 62 MB
  // there, uncompressed — and on 2 October that download stalled for minutes
  // at a time from one network, so three runs in a row ran out of time at the
  // runtime's start and never reached anything after it. A package the mirror
  // lacks still comes from the CDN, as it would for a visitor.
  is(await mirrorPackages(), true, "the package mirror's worker controls the page");

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

  // Whether the WISP transport can be loaded and used at all. It has been
  // recorded as the one thing between this sandbox and outbound TCP:
  // `wisp-network.js` imports its client by bare specifier, and until the
  // import map in index.html there was nothing to resolve it — the runtime
  // failed before a sandbox existed.
  //
  // Asserted by starting a sandbox rather than by importing the module here.
  // An `import()` written in this file is resolved by vite at build time, so it
  // passes with the import map deleted and proves nothing about the page; the
  // SDK's own dynamic import is the one that has to work. Removing either the
  // map or the compat substitution fails the check below, each with its own
  // unresolved specifier.
  //
  // It asserts the transport loads, not that traffic flows. Egress also needs a
  // WISP server to point at, which is a decision about whose machine carries
  // somebody's traffic, not a missing import. See docs/dev/networking.md.
  // And whether a sandbox will start with that transport actually selected.
  // This is the measurement the networking doc was missing: before the import
  // map it failed before a sandbox existed, so nothing behind it had ever been
  // tried. Started with the shell and nothing else — the subject is the
  // transport, not the tools — and with no server to point at, because the WISP
  // connection is opened lazily on first egress rather than at startup.
  try {
    const wispStarted = performance.now();
    await Runtime.start({}, { packages: [], network: { mode: "wisp" } });
    ok(`a sandbox starts with the WISP transport selected (${Math.round(performance.now() - wispStarted)}ms)`);
  } catch (e) {
    fail(`a sandbox would not start in wisp mode — ${(e as Error).message}`);
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

  // Nothing typed can hide the end of a command. The sentinel rides on the
  // command's own line, so a `#` used to comment it out and an unclosed quote
  // or `if` left bash waiting for the rest — the terminal hung until ctrl-c.
  // Raced against a timeout, so a hang fails here instead of stalling the check.
  const settles = (cmd: string) =>
    Promise.race([sh.run(cmd), new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
  let wedged = false;
  for (const [cmd, what] of [
    ["# only a comment", "a line that is only a comment"],
    ["echo kept # and a comment", "a command with a trailing comment"],
    ['echo "unclosed', "an unclosed quote"],
    ["if true; then", "an unfinished if"],
  ] as const) {
    printed = "";
    const r = await settles(cmd);
    is(r !== null, true, `${what} still finishes`);
    if (r === null) {
      wedged = true;
      break;
    }
    if (cmd.startsWith("echo kept")) is(printed.includes("kept"), true, "the command before a comment runs");
    if (cmd.startsWith('echo "')) is(r.exitCode !== 0, true, "a syntax error reports failure");
  }
  if (!wedged) {
    // Wrapped in `eval`, so the wrapping has to be invisible: quotes arrive as
    // typed, and `cd` still moves this shell rather than a subshell.
    printed = "";
    await sh.run(`echo 'single' "double" it\\'s`);
    is(printed.trim(), "single double it's", "quotes reach bash as they were typed");
    printed = "";
    await sh.run("cd .ajar");
    await sh.run("pwd");
    is(printed.trim().endsWith("/.ajar"), true, "cd moves the shell itself");
    await sh.run("cd ..");
  }

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

  // A cursor's id goes into a stylesheet and a class name, and it comes from
  // another browser. Only the relay's integers count as one.
  is(participantId(3), 3, "a participant id is a non-negative integer");
  is(participantId(0), 0, "zero included");
  is(participantId("3 { } body { display: none } .x"), null, "a string is not an id, however it reads");
  is(participantId(-1), null, "nor a negative number");
  is(participantId(1.5), null, "nor a fraction");
  is(participantId(Number.NaN), null, "nor NaN");

  // ---- typing before a document arrives ----
  //
  // Each case as the text it leaves: the document with the carried-over edit
  // applied. What was typed has to survive, where it was typed, and nobody
  // else's work may go with it.
  {
    const after = (shown: string, typed: string, doc: string) => {
      const e = carryOver(shown, typed, doc);
      return e ? doc.slice(0, e.at) + e.insert + doc.slice(e.at + e.remove) : doc;
    };
    is(carryOver("a\nb\n", "a\nb\n", "a\nb\n"), null, "nothing typed, nothing to carry");
    is(after("a\nb\n", "a\nb\nc\n", "a\nb\n"), "a\nb\nc\n", "a line typed at the end is kept");
    is(after("abcdef", "abcXYdef", "abcdef"), "abcXYdef", "and in the middle, in place");
    is(after("hello world", "hello there", "hello world"), "hello there", "and a word replaced");
    is(after("one\ntwo\n", "one\ntwo\nmine\n", "theirs\none\ntwo\n"), "theirs\none\ntwo\nmine\n", "somebody's line above it stays, and it lands after the text it followed");
    is(after("x = 1\ny = 2\n", "x = 1\nz = 0\ny = 2\n", "x = 1\ny = 2\ntheirs\n"), "x = 1\nz = 0\ny = 2\ntheirs\n", "somebody's line below it stays too");
    is(after("keep this", "keep", "keep that"), "keep that", "a deletion over text somebody changed removes none of theirs");
  }

  // ---- line endings an editor converts ------------------------------------
  // A Monaco model holds one line ending. A document with mixed ones put every
  // offset after a converted one off by a character between the editor and
  // the document: a paste over a value in a CSV left part of the old value
  // in what was saved and in what every other place showed. 9 October.
  {
    is(eolOf("a\nb\r\nc\r\n"), "\r\n", "two CRLF of three: the editor's line ending is CRLF");
    is(eolOf("a\nb\nc\r\n"), "\n", "one CRLF of three: LF");
    is(eolOf("abc"), null, "no line breaks, no line ending");
    is(asEditorHolds("a\r\nb\nc\r\n"), "a\r\nb\r\nc\r\n", "mixed text is held with the one line ending");
    is(asEditorHolds("a\rb\r\n"), "a\r\nb\r\n", "a lone carriage return too");

    const monaco = await import("monaco-editor/esm/vs/editor/editor.api");
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: async () => new (await import("monaco-editor/esm/vs/editor/editor.worker?worker")).default(),
    };
    // Places that hand each other their updates a moment later, as the network would.
    let places: DocSession[] = [];
    const place = (id: number) => {
      const doc = new DocSession(1, "sheet.csv", { id, name: `p${id}` }, (kind, bytes) => {
        if (kind !== "update") return;
        for (const other of places) if (other !== doc) setTimeout(() => other.applyUpdate(bytes), 5);
      });
      places.push(doc);
      return doc;
    };
    const editors: Monaco.editor.IStandaloneCodeEditor[] = [];
    const show = (doc: DocSession) => {
      const host = document.createElement("div");
      host.style.cssText = "width: 400px; height: 120px";
      document.body.append(host);
      const editor = monaco.editor.create(host, {});
      const model = monaco.editor.createModel("", "plaintext");
      editor.setModel(model);
      editors.push(editor);
      doc.bind(monaco, editor, model);
      return model;
    };
    const settle = () => new Promise((r) => setTimeout(r, 150));
    const paste = (model: Monaco.editor.ITextModel, line: number, from: number, to: number, text: string) =>
      model.pushEditOperations([], [{ range: new monaco.Range(line, from, line, to), text }], () => null);
    const sheet = "name,qty\r\nalpha,1\nbeta,2\r\n";

    // Opened from the stored copy, as two places do.
    {
      const a = place(1);
      const b = place(2);
      a.seed(sheet);
      b.seed(sheet);
      const ma = show(a);
      const mb = show(b);
      paste(ma, 3, 6, 7, "1233132");
      await settle();
      is(b.contents(), "name,qty\r\nalpha,1\r\nbeta,1233132\r\n", "a paste over a value in a mixed-ending sheet is exactly what the other place holds");
      is(mb.getValue(), b.contents(), "and what it shows");
      is(ma.getValue(), a.contents(), "and the place that pasted holds what it shows");
    }

    // Mixed text put in by a page from before this, with two places showing it.
    // Both mend at once, and agree.
    {
      places = [];
      const a = place(3);
      const b = place(4);
      const older = place(5);
      const ma = show(a);
      const mb = show(b);
      older.ydoc.transact(() => older.ytext.insert(0, sheet), "local");
      await settle();
      await settle();
      const same = a.contents() === b.contents() && b.contents() === older.contents();
      is(same && !a.contents().includes("\r"), true, `mixed text from elsewhere is mended to LF, the same in every place — ${JSON.stringify([a.contents(), b.contents(), older.contents()])}`);
      is(ma.getValue() === a.contents() && mb.getValue() === b.contents(), true, "and each editor shows its document");
      paste(mb, 3, 6, 7, "1233132");
      await settle();
      is(a.contents(), "name,qty\nalpha,1\nbeta,1233132\n", "then a paste lands where it was made");
      is(ma.getValue(), a.contents(), "and the other place shows it");
    }

    // A document already mixed when a place opens it.
    {
      places = [];
      const older = place(6);
      const a = place(7);
      older.ydoc.transact(() => older.ytext.insert(0, "x\r\ny\nz\r\n"), "local");
      await settle();
      const ma = show(a);
      await settle();
      is(a.contents(), "x\ny\nz\n", "a mixed document is mended when opened");
      is(older.contents(), a.contents(), "for everyone");
      is(ma.getValue(), a.contents(), "and shown as it is");
    }

    // A command's output, written into a document with its own line endings.
    {
      places = [];
      const a = place(8);
      a.seed("one\r\ntwo\r\n");
      a.replace("one\r\ntwo\nthree\n");
      is(a.contents(), "one\r\ntwo\r\nthree\r\n", "a command's output goes in with the document's line ending");
    }

    for (const editor of editors) {
      editor.getModel()?.dispose();
      editor.dispose();
    }
  }

  // ---- CSV and TSV colours ----
  //
  // Each line as its coloured runs: `c1=` is the second column's colour, `d=`
  // a delimiter. What matters is that a column keeps its colour across quotes,
  // commas inside them, and line breaks inside them.
  {
    const START = new DelimitedState(0, false);
    const runs = (line: string, state = START, delimiter = ",") => {
      const { tokens, endState } = tokenizeLine(line, state, delimiter, "csv");
      const parts = tokens.map((t, i) => {
        const text = line.slice(t.startIndex, tokens[i + 1]?.startIndex ?? line.length);
        return `${t.scopes.startsWith("delimiter") ? "d" : `c${/column(\d+)/.exec(t.scopes)?.[1]}`}=${text}`;
      });
      return { runs: parts.join(" "), endState };
    };
    is(runs('1,"Smith, J",x').runs, 'c0=1 d=, c1="Smith, J" d=, c2=x', "a comma inside quotes is part of the field");
    is(runs('"said ""hi""",b').runs, 'c0="said ""hi""" d=, c1=b', "a doubled quote does not end the field");
    const open = runs('2,"multi');
    is(open.runs, 'c0=2 d=, c1="multi', "a quoted field left open");
    is(open.endState.equals(new DelimitedState(1, true)), true, "carries its column to the next line");
    const closed = runs('line",z', open.endState);
    is(closed.runs, 'c1=line" d=, c2=z', "which continues it in the same colour");
    is(closed.endState.equals(START), true, "and the line after starts at the first column again");
    is(runs("a,,c").runs, "c0=a d=,, c2=c", "an empty field still counts as a column");
    const stray = runs('3,5" screen,y');
    is(stray.runs, 'c0=3 d=, c1=5" screen d=, c2=y', "a quote in the middle of a field is a character");
    is(stray.endState.equals(START), true, "and opens nothing");
    is(runs("a\tb, c", START, "\t").runs, "c0=a d=\t c1=b, c", "TSV splits on tabs, and a comma is text");
    is(runs("a,b,c,d,e,f,g,h,i").runs.split(" ").at(-1), "c0=i", "colours cycle after eight columns");
  }

  // ---- a pasted pad link ----
  // Copy a pad takes whatever someone pastes. Each case is what a person
  // might have in their clipboard; the answer is the name and code, or a
  // reason in words.
  {
    const SITE = "https://code.example.com";
    const CODE = "AbCdEfGhIjKlMnOpQrStUv";
    const said = (text: string) => {
      const r = parsePadLink(text, SITE);
      return "error" in r ? `error: ${r.error}` : `${r.name} ${r.code ?? "-"}`;
    };
    for (const [text, want] of [
      [`https://code.example.com/amber-falcon-river#${CODE}`, `amber-falcon-river ${CODE}`],
      [`code.example.com/amber-falcon-river#${CODE}`, `amber-falcon-river ${CODE}`],
      ["  https://code.example.com/Amber-Falcon-River/  ", "amber-falcon-river -"],
      [`amber-falcon-river#${CODE}`, `amber-falcon-river ${CODE}`],
      ["quiet-ember-4417", "quiet-ember-4417 -"],
      ["https://code.example.com/notes#installation", "notes -"],
      ["https://code.example.com/notes?x=1#" + encodeURIComponent(CODE), `notes ${CODE}`],
      ["https://elsewhere.example/amber", "error: That's a link to elsewhere.example, not to a pad here."],
      ["https://code.example.com/dashboard", "error: That link isn't to a pad."],
      ["https://code.example.com/", "error: That link isn't to a pad."],
      ["https://code.example.com/a/b", "error: That link isn't to a pad."],
      ["", "error: Paste a link to a pad."],
    ] as const) {
      is(said(text), want, `a pasted link: ${JSON.stringify(text.slice(0, 50))}`);
    }
  }

  // ---- zips, in and out ----
  //
  // Made here and read here, and — the one that matters — read when made by
  // something else: this fixture is Python's zipfile, deflated, the way a
  // download from anywhere arrives. Wrapped in one folder, with a name in
  // UTF-8, a binary file, a Mac's leftovers and a path that climbs out.
  {
    const limits = { maxFiles: 500, maxBytes: 25 * 1024 * 1024 };
    const bytes = (s: string) => new TextEncoder().encode(s);
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    is(crc32(bytes("123456789")).toString(16), "cbf43926", "the zip CRC is the standard one");

    const ours = [
      { path: "main.py", data: bytes("print('x')\n".repeat(200)) },
      { path: "src/tiny.txt", data: bytes("hi") },
      { path: "naïve/café.md", data: bytes("# é\n") },
    ];
    const back = await readZip(await makeZip(ours), limits);
    is(back.map((e) => `${e.path}=${text(e.data).length}`).join(","), ours.map((e) => `${e.path}=${text(e.data).length}`).join(","), "a zip made here reads back the same, deflated and stored entries both");
    is(text(back[0]!.data), text(ours[0]!.data), "with the same bytes");

    const foreign = Uint8Array.from(atob("UEsDBBQAAAAAAAAAIQAAAAAAAAAAAAAAAAAKAAAAcHJvai1tYWluL1BLAwQUAAAACAAddERdEMg0FCEAAAAIAgAAEQAAAHByb2otbWFpbi9tYWluLnB5KyjKzCvRUM9IzcnJV0grys9VSFSoyixQ1+QqGJUZQTIAUEsDBBQAAAAIAB10RF1ltxlmFgAAABYAAAAVAAAAcHJvai1tYWluL3NyYy91dGlsLnB5S0lNU0jT0LTiUgCCotSS0qI8BUMuAFBLAwQUAAAICAAddERd0uxEiQgAAAAGAAAAFAAAAHByb2otbWFpbi9uYcOvdmUudHh0S05MO7ySCwBQSwMEFAAAAAgAHXREXWUe/38KAAAACAAAABIAAABwcm9qLW1haW4vbG9nby5wbmfrDPBzZ2BkYgYAUEsDBBQAAAAIAB10RF2DPXOlBgAAAAQAAAAcAAAAX19NQUNPU1gvcHJvai1tYWluLy5fbWFpbi5weWNgFWMHAFBLAwQUAAAACAAddERdTWIqawoAAAAIAAAAEwAAAHByb2otbWFpbi8uRFNfU3RvcmVjYGBgdCpNMQQAUEsDBBQAAAAIAB10RF1abPMNFAAAABIAAAAVAAAAcHJvai1tYWluLy4uL2V2aWwudHh0K87IL81JUchLLUstUshJzEvhAgBQSwECFAMUAAAAAAAAACEAAAAAAAAAAAAAAAAACgAAAAAAAAAAAAAAgAEAAAAAcHJvai1tYWluL1BLAQIUAxQAAAAIAB10RF0QyDQUIQAAAAgCAAARAAAAAAAAAAAAAACAASgAAABwcm9qLW1haW4vbWFpbi5weVBLAQIUAxQAAAAIAB10RF1ltxlmFgAAABYAAAAVAAAAAAAAAAAAAACAAXgAAABwcm9qLW1haW4vc3JjL3V0aWwucHlQSwECFAMUAAAICAAddERd0uxEiQgAAAAGAAAAFAAAAAAAAAAAAAAAgAHBAAAAcHJvai1tYWluL25hw692ZS50eHRQSwECFAMUAAAACAAddERdZR7/fwoAAAAIAAAAEgAAAAAAAAAAAAAAgAH7AAAAcHJvai1tYWluL2xvZ28ucG5nUEsBAhQDFAAAAAgAHXREXYM9c6UGAAAABAAAABwAAAAAAAAAAAAAAIABNQEAAF9fTUFDT1NYL3Byb2otbWFpbi8uX21haW4ucHlQSwECFAMUAAAACAAddERdTWIqawoAAAAIAAAAEwAAAAAAAAAAAAAAgAF1AQAAcHJvai1tYWluLy5EU19TdG9yZVBLAQIUAxQAAAAIAB10RF1abPMNFAAAABIAAAAVAAAAAAAAAAAAAACAAbABAABwcm9qLW1haW4vLi4vZXZpbC50eHRQSwUGAAAAAAgACAAKAgAA9wEAAAAA"), (c) => c.charCodeAt(0));
    const read = await readZip(new Blob([foreign]), limits);
    is(read.some((e) => e.path === "proj-main/naïve.txt" && text(e.data) === "café\n"), true, "a zip made by Python's zipfile reads, UTF-8 names and all");
    const prepared = prepareImport(read);
    is(prepared.root, "proj-main", "a zip wrapped in one folder is unwrapped");
    is(prepared.files.map((f) => f.path).sort().join(","), "logo.png,main.py,naïve.txt,src/util.py", "its files come in, binary ones too, and junk is left out");
    is(prepared.binary.join(","), "logo.png", "a binary file is named as one");
    const logo = prepared.files.find((f) => f.path === "logo.png");
    is(logo?.encoding === "base64" && [...fromBase64(logo.content).subarray(0, 4)].join() === "137,80,78,71", true, "and kept as its bytes, in base64");
    is(prepared.unsafe.join(","), "proj-main/../evil.txt", "a path that climbs out of the folder is refused");
    // Directory entries: most zips list every folder, and only an empty one
    // needs keeping — as its marker, an empty `.keep`.
    const dirsIn = prepareImport([
      { path: "a/", data: new Uint8Array() },
      { path: "a/b/", data: new Uint8Array() },
      { path: "a/b/c.txt", data: bytes("c") },
      { path: "empty/", data: new Uint8Array() },
      { path: "empty/inner/", data: new Uint8Array() },
    ]);
    is(dirsIn.files.map((f) => `${f.path}=${JSON.stringify(f.content)}`).sort().join(" "), 'a/b/c.txt="c" empty/inner/.keep=""', "a zip's empty folders come in kept by a marker, and full ones need none");
    // 200 characters, 600 bytes: the relay counts bytes.
    const long = prepareImport([{ path: `${"字".repeat(200)}.txt`, data: bytes("x") }, { path: "ok.txt", data: bytes("y") }]);
    is(long.unsafe.length === 1 && long.files.map((f) => f.path).join() === "ok.txt", true, "a path over the relay's 512 bytes is refused, however few characters");

    const refuses = async (blob: Blob, lim: typeof limits, m: string) => {
      try {
        await readZip(blob, lim);
        fail(`${m} — it was read`);
      } catch (e) {
        is(e instanceof ZipError, true, m);
      }
    };
    await refuses(new Blob([foreign]), { maxFiles: 3, maxBytes: limits.maxBytes }, "more files than a pad holds is refused before reading them");
    await refuses(new Blob([foreign]), { maxFiles: 500, maxBytes: 100 }, "more bytes than a pad holds is refused before inflating");
    // A zip that says an entry is small and inflates to much more: the bomb.
    const bomb = new Uint8Array(await (await makeZip([{ path: "z.txt", data: new Uint8Array(100_000).fill(48) }])).arrayBuffer());
    const cd = bomb.length - 22 - (46 + 5);
    new DataView(bomb.buffer).setUint32(cd + 24, 10, true);
    await refuses(new Blob([bomb]), { maxFiles: 500, maxBytes: 1000 }, "a zip that lies about its sizes is stopped while inflating");
    await refuses(new Blob([bytes("not a zip at all")]), limits, "something that is not a zip says so");
    await refuses(new Blob([foreign.slice(0, foreign.length - 40)]), limits, "a zip cut short says so");
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

  // Counted rather than asserted absent: a negative assertion on scrollback
  // this shell shares with every other check is one of the ways this suite has
  // fooled itself before.
  printed = "";
  await sh.run("find . -name '*.py' | grep -c '\\.ajar' | sed 's/^/AJARCOUNT=/'");
  is(printed.trim(), "AJARCOUNT=0", "find does not list the shims it is one of");

  printed = "";
  await sh.run("find .ajar -name 'box.py' | sed 's/^/NAMED=/'");
  is(printed.trim(), "NAMED=.ajar/box.py", "but naming the directory still reaches them");

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
  // Earlier checks left gzip and tar output in the sandbox: binary, carried
  // between runs like the text is.
  let bins = new Map<string, string>();
  const first = await diff(rt, known, bins);
  is(
    first.changes.some((c) => c.path === "from-shell.txt"),
    true,
    "a file the shell made shows up as a change",
  );
  known = first.next;
  bins = first.nextBinaries;

  const quiet = await diff(rt, known, bins);
  is(quiet.changes.length, 0, "running the diff again finds nothing to send");

  await sh.run("python -c \"open('note.txt','w').write('hello')\"");
  const added = await diff(rt, known, bins);
  is(
    added.changes.filter((c) => c.path === "note.txt").length,
    1,
    "a new file is one change",
  );
  known = added.next;

  // The case size alone cannot catch, and the reason this reads every file.
  await sh.run("python -c \"open('note.txt','w').write('HELLO')\"");
  const rewritten = await diff(rt, known, bins);
  is(
    rewritten.changes.find((c) => c.path === "note.txt")?.content,
    "HELLO",
    "a same-length rewrite is still detected",
  );
  known = rewritten.next;

  await sh.run("rm note.txt");
  const removed = await diff(rt, known, bins);
  is(
    removed.changes.find((c) => c.path === "note.txt")?.content,
    null,
    "a deleted file is sent as a removal",
  );
  known = removed.next;

  // A binary file a command makes goes as its bytes, base64. It used to be
  // read as text, which replaced what was not UTF-8, and everyone else got a
  // garbled copy.
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xfe];
  await sh.run(`printf '${PNG.map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("")}' > pic.png`);
  const madeBinary = await diff(rt, known, bins);
  const pic = madeBinary.changes.find((c) => c.path === "pic.png");
  is(pic?.encoding, "base64", "a binary file a command makes is sent as base64");
  is(pic?.content ? [...fromBase64(pic.content)].join() : "", PNG.join(), "with its bytes exactly");
  is(madeBinary.next.has("pic.png"), false, "and is not remembered as text");
  known = madeBinary.next;
  bins = madeBinary.nextBinaries;
  is((await diff(rt, known, bins)).changes.length, 0, "running the diff again finds nothing to send");
  // A file that changes kind is one change, not a removal and an addition.
  await sh.run("printf 'now text\\n' > pic.png");
  const toText = await diff(rt, known, bins);
  is(JSON.stringify(toText.changes.filter((c) => c.path === "pic.png")), JSON.stringify([{ path: "pic.png", content: "now text\n" }]), "a binary file rewritten as text is one text change");
  known = toText.next;
  bins = toText.nextBinaries;
  await sh.run("rm pic.png");
  const binaryGone = await diff(rt, known, bins);
  is(binaryGone.changes.find((c) => c.path === "pic.png")?.content, null, "and removing it is a removal");
  known = binaryGone.next;
  bins = binaryGone.nextBinaries;
  const all = Uint8Array.from({ length: 256 * 3 }, (_, i) => i % 256);
  is([...fromBase64(toBase64(all))].join() === [...all].join(), true, "base64 goes there and back, every byte value");
  is(textOf(new TextEncoder().encode("naïve ✓")), "naïve ✓", "UTF-8 text reads as text");
  is(textOf(Uint8Array.of(0x61, 0x00, 0x62)), null, "a NUL makes it binary");
  is(textOf(Uint8Array.of(0xff, 0xfe)), null, "and so do bytes that are not UTF-8");

  // Tool droppings stay out of the shared folder.
  await rt.write("__pycache__/x.pyc", "bytecode");
  const noise = await diff(rt, known, bins);
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

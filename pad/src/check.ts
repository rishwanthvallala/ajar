/**
 * What has to be true for any of this to work, asserted in a real browser.
 *
 * Node cannot run these — the python package fails wasm validation there — so
 * this page is driven by `scripts/browser-check.mjs` under headless Chromium.
 */
import { parsePadLink } from "./access";
import { interpreterFor, mirrorPackages, Runtime } from "./runtime";
import { DelimitedState, tokenizeLine } from "@ajar/workspace-ui/delimited-tokens";
import { carryOver, putBack } from "./carry";
import type * as Monaco from "monaco-editor";
import { asEditorHolds, cssString, DocSession, eolOf, participantId, utf8Of } from "./editing";
import { RuntimeNotices, Shell } from "./shell";
import { jsonBytes, mintName, pieces, plan, Store, StoreError, storedHash } from "./store";
import { DOC_UPDATE, MAX_DOC_MESSAGE, Peers } from "./peers";
import { commandsIn, neededBy, runnerFor, TOOLCHAINS } from "./toolchains";
import { decodeAnswer, decodeRequest, encodeAnswer, encodeRequest } from "./javac/protocol";
import { seedFiles } from "./seed";
import { nameProblem, pathFor } from "./files";
import { formatterFor, formatText, problemOf, usesTabs } from "./format";
import { starterFor } from "./starters";
import { answer, decodeRequest as decodeFetch, encodeAnswer as encodeFetched, headersFor, type LocalFetch, vet } from "./fetch-bridge";
import { diff, fromBase64, ignored, knownFrom, textOf, toBase64 } from "./sync";
import { crc32, makeZip, prepareImport, readZip, ZipError } from "./zip";
import { placesIn, problemsIn } from "./problems";

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

  // ---- where output points into the pad (problems.ts) ----
  // Real output of each, as it prints it here. Links come from `placesIn`,
  // squiggles from `problemsIn`; a frame outside the pad is neither.
  {
    const ours = (p: string) => {
      const q = p.replace(/^\/workspace\//, "").replace(/^\.\//, "");
      return q.startsWith("/") ? null : q;
    };
    const said = (out: string) => problemsIn(out, ours).map((p) => `${p.path}:${p.line}${p.column ? `:${p.column}` : ""} ${p.severity} ${p.message}`).join(" | ");
    is(
      said(['Traceback (most recent call last):', '  File "/workspace/main.py", line 5, in <module>', "    f()", '  File "/workspace/main.py", line 2, in f', "    return json.loads(x)", '  File "/usr/lib/python3.12/json/__init__.py", line 346, in loads', "    return _default_decoder.decode(s)", "json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)"].join("\n")),
      "main.py:2 error json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
      "a Python traceback is placed at the pad's innermost frame, not the library's",
    );
    is(said(['  File "/workspace/main.py", line 2', "    def f(in):", "          ^^", "SyntaxError: invalid syntax"].join("\n")), "main.py:2 error SyntaxError: invalid syntax", "and a SyntaxError, which has no Traceback line");
    is(
      said(["Traceback (most recent call last):", '  File \x1b[35m"/workspace/errs/boom.py"\x1b[0m, line \x1b[35m4\x1b[0m, in \x1b[35mf\x1b[0m', "    return \x1b[1;31mundefined_name\x1b[0m", "\x1b[1;35mNameError\x1b[0m: \x1b[35mname 'undefined_name' is not defined\x1b[0m"].join("\r\n")),
      "errs/boom.py:4 error NameError: name 'undefined_name' is not defined",
      "and one in Python 3.13's colours, which put escapes inside the frame",
    );
    is(said(['Traceback (most recent call last):', '  File "/workspace/app/run.py", line 9, in <module>', "    raise Boom('bad')", "Boom: bad"].join("\n")), "app/run.py:9 error Boom: bad", "and an exception of the program's own, whatever it is called");
    is(said(['Traceback (most recent call last):', '  File "/workspace/main.py", line 3, in <module>', "    while True: pass", "KeyboardInterrupt"].join("\n")), "", "but not Ctrl-C, which is not a fault in the code");
    is(
      said(["main.c:2:1: warning: return type of 'main' is not 'int' [-Wmain-return-type]", "main.c:4:5: error: use of undeclared identifier 'x'", "main.c:1:1: note: previous definition is here", "1 warning and 1 error generated."].join("\n")),
      "main.c:2:1 warning return type of 'main' is not 'int' [-Wmain-return-type] | main.c:4:5 error use of undeclared identifier 'x'",
      "clang's errors and warnings, not its notes",
    );
    is(said("./main.go:5:2: undefined: x"), "main.go:5:2 error undefined: x", "go build's");
    is(said(["panic: runtime error: index out of range [3] with length 1", "", "goroutine 1 [running]:", "main.main()", "\t/workspace/main.go:7 +0x1d", "exit status 2"].join("\n")), "main.go:7 error panic: runtime error: index out of range [3] with length 1", "a Go panic, at its first frame in the pad");
    is(said("Main.java:3: error: ';' expected"), "Main.java:3 error ';' expected", "javac's");
    is(said(['Exception in thread "main" java.lang.RuntimeException: boom', "\tat Main.main(Main.java:5)"].join("\n")), "Main.java:5 error java.lang.RuntimeException: boom", "a Java exception, at its frame");
    is(said(["/workspace/app.js:3", "console.log(x)", "            ^", "", "ReferenceError: x is not defined", "    at Object.<anonymous> (/workspace/app.js:3:13)"].join("\n")), "app.js:3 error ReferenceError: x is not defined", "a Node error, at the line it names first");
    is(said(["/workspace/app.js:1", 'throw new Error("boom")', "", "Error: boom"].join("\n")), "app.js:1 error Error: boom", "even one called just Error");
    is(said("PHP Parse error:  syntax error, unexpected end of file in /workspace/index.php on line 3"), "index.php:3 error syntax error, unexpected end of file", "PHP's");
    const links = (line: string) => placesIn(line).map((f) => `${f.path}:${f.line}${f.column ? `:${f.column}` : ""}@${f.start}-${f.end}`).join(" ");
    is(links('  File "/workspace/main.py", line 2, in f'), "/workspace/main.py:2@2-35", "a link over a Python frame");
    is(links("    at Object.<anonymous> (/workspace/app.js:3:13)"), "/workspace/app.js:3:13@27-49", "and a stack frame's place, inside its brackets");
    is(links("main.c:4:5: error: x and util/b.c:9"), "main.c:4:5@0-10 util/b.c:9@25-35", "and every place in a line");
    is(links(" * Running on http://127.0.0.1:5000 (Press CTRL+C to quit)"), "", "but not an address, which is not a file");
  }

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

  // What a page signed out under puts back once it is signed in again. It
  // wrote every file it had kept, as it held it, over what collaborators had
  // done meanwhile — and the files not on screen it held as they were when
  // last shown. Only what changed here goes back, onto the pad as it is.
  {
    const kept = new Map<string, { base: string | undefined; mine: string | null }>([
      ["untouched.py", { base: "a\n", mine: "a\n" }],
      ["mine.py", { base: "one\ntwo\n", mine: "one\ntwo\nmine\n" }],
      ["gone.py", { base: "x\n", mine: null }],
      ["new.py", { base: undefined, mine: "fresh\n" }],
    ]);
    const stored = new Map([
      ["untouched.py", "a\ntheirs\n"],
      ["mine.py", "theirs\none\ntwo\n"],
      ["gone.py", "x\n"],
    ]);
    const back = Object.fromEntries(putBack(kept, stored).map((c) => [c.path, c.content]));
    is("untouched.py" in back, false, "a file not changed here is not put back over somebody's newer one");
    is(back["mine.py"], "theirs\none\ntwo\nmine\n", "one changed here goes back onto the pad as it is now, theirs kept");
    is(back["gone.py"], null, "one deleted here is deleted");
    is(back["new.py"], "fresh\n", "and one the pad never had goes in whole");
  }

  // Emoji are two UTF-16 units, and two from one block share the first. Changed
  // one for the other, the difference began between the halves, and the
  // document, asked to cut a character there, put a replacement character in
  // each half.
  {
    const thumbs = "\ud83d\udc4d";
    const fire = "\ud83d\udd25";
    const e = carryOver(`a${thumbs}b`, `a${fire}b`, `a${thumbs}b`);
    is(e?.at, 1, "a change from one emoji to another starts at the character, not inside it");
    const doc = new DocSession(9, "e.txt", { id: 1, name: "t" }, () => {});
    doc.seed(`a${thumbs}b`);
    doc.replace(`a${fire}b`);
    is(doc.contents(), `a${fire}b`, "and a document changed that way holds the new emoji whole");
    // The same at the other end: two characters sharing their second half.
    const doc2 = new DocSession(10, "f.txt", { id: 1, name: "t" }, () => {});
    doc2.seed("x\ud83d\udc4dz");
    doc2.replace("x\ud83e\udc4dz");
    is(doc2.contents(), "x\ud83e\udc4dz", "and one that differs only in its first half too");
    doc.destroy();
    doc2.destroy();
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
    // A file's size as UTF-8, counted a line at a time: what decides whether it
    // can be edited together live, so it has to be the bytes, not a guess.
    {
      const texts = ["", "plain ascii\nlines\n", "café, naïve\r\nmore\r\n", "漢字かな\n😀 and 👍🏽\n", "end without a newline é", "\n\n\n"];
      const counted = texts.map((t) => {
        const model = monaco.editor.createModel(t, "plaintext");
        const ok = utf8Of(model) === new TextEncoder().encode(model.getValue()).length;
        model.dispose();
        return ok;
      });
      is(counted.every(Boolean), true, `a file's bytes counted a line at a time are its UTF-8 (${counted.join(",")})`);
    }

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
    // Far more than `head` reads: each is still writing when the pipe closes,
    // and says nothing about it, as a real tool says nothing.
    ["python -c 'print(*range(100000), sep=chr(10))' > many.txt && awk '{print $1}' many.txt | head -1", "0"],
    ["sort -n many.txt | head -1", "0"],
    ["tail -n 100000 many.txt | head -1", "0"],
  ] as const) {
    printed = "";
    const r = await sh.run(cmd);
    // The runtime's own word when `head` closes the pipe first — on a slow
    // machine, CI's Mac, the command is still writing and the runtime ends it
    // there and says so — is the shell's to leave out now (RuntimeNotices),
    // so it is not taken out here.
    const said = printed.trim();
    if (said === want) ok(cmd);
    else fail(`${cmd} — wanted ${JSON.stringify(want)}, got ${JSON.stringify(printed.trim())} (exit ${r.exitCode})`);
  }

  // Werkzeug's reloader watches on a thread, which cannot start: Flask's
  // debug mode runs without it, and says so. A stand-in for werkzeug.serving,
  // where the real one comes from pip.
  await rt.write("fake/werkzeug/__init__.py", "");
  await rt.write("fake/werkzeug/serving.py", "def run_simple(hostname, port, application, use_reloader=False, **kw):\n    print('RELOADER', use_reloader, kw.get('use_debugger'))\n");
  printed = "";
  await sh.run(`PYTHONPATH=fake:$PYTHONPATH python -c "from werkzeug.serving import run_simple; run_simple('127.0.0.1', 5000, None, use_reloader=True, use_debugger=True); run_simple('127.0.0.1', 5000, None, True)"`);
  is((printed.match(/RELOADER False True/g) ?? []).length === 1 && /RELOADER False None/.test(printed), true, "Flask's debug mode runs without the reloader, given as a keyword or in its place");
  is(/Reloader: off in the pad/.test(printed), true, "and says why, once a run");
  printed = "";
  await sh.run("alias flask; echo NOCACHE=$PIP_NO_CACHE_DIR");
  is(/python -m flask/.test(printed) && /NOCACHE=1/.test(printed), true, "`flask` is python -m flask, which works, and pip keeps no cache");
  await sh.run("rm -rf fake");

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
  // A `~` that was never expanded: pip kept its cache there, in the folder.
  await rt.write("~/.cache/pip/http-v2/a/b.body", "cached download");
  const home = await diff(rt, known, bins);
  is(home.changes.length, 0, "what a tool keeps in a home directory, written as `~/`, is not published");
  is(ignored("notes/~draft.txt") || ignored("a/~/b"), false, "only a `~` folder at the top is, not a name with a ~ in it");
  const stored = new Map(known);
  stored.set("~/.cache/pip/http-v2/old.body", "stored before the rule");
  const cleared = await diff(rt, stored, bins);
  is(cleared.changes.some((c) => c.path === "~/.cache/pip/http-v2/old.body" && c.content === null), true, "and what a pad stored there before is taken out at the next command");

  // ---- languages on first use ----
  // What a line runs decides what is fetched before it does.
  {
    is(commandsIn("FOO=1 time go build ./... && ./app | grep x; sudo node a.js").join(","), "go,app,grep,node", "the commands a line runs, past assignments and the words that run the next");
    is(commandsIn("echo $(php -v) `clang --version`").join(","), "echo,php,clang", "including inside $( ) and backticks");
    const none = new Set<string>();
    is(neededBy("go run m.go | node x.js && go vet", none).map((t) => t.name).join(","), "Go,Node.js", "a line needs each language it names, once, in order");
    is(neededBy("ls -la; python x.py && clangs", none).length, 0, "and none for commands already here, or ones only like a language's");
    const go = TOOLCHAINS.find((t) => t.name === "Go")!;
    is(neededBy("go version", new Set([go.pkg])).length, 0, "nor one already fetched");
    is(runnerFor("src/main.c")?.line, "clang 'src/main.c' -o /tmp/a.out && /tmp/a.out", "Run compiles a C file and runs it");
    is(runnerFor("it's.go")?.line, "go run 'it'\\''s.go'", "a name with a quote in it is quoted");
    is(runnerFor("app.js")?.toolchain.name, "Node.js", "a .js file runs with node");
    const cpp = runnerFor("hello.cpp")?.line ?? "";
    is(cpp.includes("clang++ 'hello.cpp'") && cpp.includes("<iostream>"), true, "a .cpp file compiles with clang++, saying first if it needs <iostream>");
    is(neededBy("gcc hi.c && ./a.out", none)[0]?.pkg, runnerFor("hi.c")?.toolchain.pkg, "and gcc is clang's, so typing it fetches C");
    is(runnerFor("notes.txt"), null, "and nothing runs what no language does");
    is(neededBy("javac Main.java && java Main", none).map((t) => t.name).join(","), "Java", "javac and java are one language, fetched once");
    is(runnerFor("src/Main.java")?.line, "java 'src/Main.java'", "and Run runs a .java file as a source file");
    // The fast javac's files: what the sandbox sends and gets back, intact.
    const bytes = Uint8Array.of(0xca, 0xfe, 0, 255);
    const request = decodeRequest(encodeRequest({ cwd: "/workspace/é", args: ["-d", "out dir", "A.java"], classPath: null, files: [{ path: "/workspace/A.java", modified: 1760000000123, data: bytes }] }));
    is(JSON.stringify([request.cwd, request.args, request.classPath, request.files[0]?.path, request.files[0]?.modified, [...(request.files[0]?.data ?? [])]]), JSON.stringify(["/workspace/é", ["-d", "out dir", "A.java"], null, "/workspace/A.java", 1760000000123, [0xca, 0xfe, 0, 255]]), "a javac request reads back as it was written");
    const answer = decodeAnswer(encodeAnswer({ exit: 1, stdout: "", stderr: "A.java:1: error: ';' expected\n", written: [{ path: "/workspace/out/A.class", data: bytes }] }));
    is(JSON.stringify([answer.exit, answer.stderr, answer.written.map((w) => [w.path, [...w.data]])]), JSON.stringify([1, "A.java:1: error: ';' expected\n", [["/workspace/out/A.class", [0xca, 0xfe, 0, 255]]]]), "and so does its answer");
    is(decodeAnswer(encodeAnswer({ exit: -1, stdout: "", stderr: "", written: [] })).exit, -1, "including the one that says to compile it in the sandbox");
  }

  // ---- a name typed into the tree ----
  {
    const taken = { files: new Set(["main.py", "src/util.py"]), folders: new Set(["src", "docs"]) };
    is(pathFor("notes.py", "src"), "src/notes.py", "a name is in the folder it is typed in");
    is(pathFor("/notes.py", "src"), "notes.py", "and from the top with a / in front");
    is(pathFor(" a/b.py/ ", ""), "a/b.py", "a slash within makes folders on the way; one at the end, and spaces around, go");
    is(nameProblem("src/util.py", taken), "there is already a file called src/util.py", "a file that is there is said, not replaced");
    is(nameProblem("docs", taken), "there is already a folder called docs", "and a folder");
    is(nameProblem("main.py/x.py", taken), "main.py is a file, not a folder", "a file cannot hold another");
    is(nameProblem("a/../b", taken), "a/../b is not a path a pad can hold", "nor a path that climbs");
    is(nameProblem("a\\b", taken) !== null && nameProblem("a /b", taken) !== null, true, "nor a backslash, nor spaces at the end of a folder's name");
    is(nameProblem("src/util.py", taken, { path: "src/util.py", folder: false }), null, "renamed to itself, it is no change rather than a clash");
    is(nameProblem("src/deep", taken, { path: "src", folder: true }), "a folder cannot go inside itself", "a folder cannot be renamed into itself");
    is(nameProblem("café/naïve 1.txt", taken), null, "any other name will do");
  }

  // ---- what an empty file can start as ----
  {
    is(starterFor("Hello.java", "    ")?.text.startsWith("public class Hello {\n    public static void main"), true, "a Java starter is a class named for its file, indented as set");
    is(starterFor("my-prog.java", "  ")?.text.startsWith("class Main {\n  public"), true, "and not public where the file's name cannot be a class's, so javac takes it too");
    is(starterFor("class.java", "  ")?.text.startsWith("class Main"), true, "nor where it is a keyword");
    is(starterFor("x/main.go", "  ")?.text.includes("\n\tname := "), true, "Go's is indented with a tab whatever the indent");
    const cpp = starterFor("a.cpp", "    ")?.text ?? "";
    is(cpp.includes("#include <cstdio>") && !cpp.includes("#include <iostream>"), true, "C++'s includes <cstdio>, which compiles here, and not <iostream>");
    is(starterFor("notes.txt", "    ") === null && starterFor("Makefile", "    ") === null && starterFor(".py", "    ") === null, true, "a kind with nothing to offer offers nothing");
    is(starterFor("a.YAML", "  ")?.text.includes("\n  - pad\n"), true, "an extension in capitals is the same kind");
  }

  // ---- formatting ----
  {
    is(formatterFor("a/b.py")?.name, "Ruff", "Python is formatted by Ruff");
    is(formatterFor("Main.java")?.name, "clang-format", "Java by clang-format");
    is(formatterFor("notes.txt"), null, "and a kind nothing formats has no Format");
    is(usesTabs("main.go") && usesTabs("Makefile") && !usesTabs("main.py"), true, "Go and Makefiles are tabs whatever the indent");
    is(await formatText("main.py", "def f(a,b):\n  return {'x':a}\n", 4), "def f(a, b):\n    return {\"x\": a}\n", "Python, with 4 spaces");
    is(await formatText("main.py", "def f():\n    return 1\n", 2), "def f():\n  return 1\n", "and with 2");
    is(await formatText("Main.java", "class Main{void f(){int x=1;}}", 4), "class Main {\n    void f() {\n        int x = 1;\n    }\n}", "Java");
    is(await formatText("a.json", '{"n":1.0,"big":12345678901234567890,"a":[1]}', 2), '{\n  "n": 1.0,\n  "big": 12345678901234567890,\n  "a": [\n    1\n  ]\n}', "JSON expanded, every number as it was written");
    is(await formatText("a.go", "package main\nfunc main(){\nprintln(1)}\n", 2), "package main\n\nfunc main() {\n\tprintln(1)\n}\n", "Go with gofmt's tabs");
    is(await formatText("a.ts", "const a:number=1", 4), "const a: number = 1;\n", "TypeScript");
    const bad = await formatText("bad.py", "x = 1\ndef f(:\n", 4).then(() => "", (e) => problemOf(e, "x = 1\ndef f(:\n"));
    is(/on line 2$/.test(bad), true, `a file that will not parse says where, by line (${bad})`);
  }

  // ---- http through the browser ----
  {
    const https = new URL("https://code.example/pad");
    const ours = ["https://preview.example"];
    const refusal = (raw: string, page = https) => { const v = vet(raw, page, ours); return "error" in v ? v.code : 0; };
    is(refusal("https://api.example/x?y=1"), 0, "an https site is fetched from an https page");
    is(refusal("http://api.example/x"), 1, "plain http is not, which the browser would refuse as mixed content");
    is(refusal("http://127.0.0.1:5299/x", new URL("http://127.0.0.1:5199/")), 0, "but it is from a page that is itself http, as the checks are");
    is(refusal("https://code.example/api/pads"), 7, "the pad's own site is never fetched from inside a pad");
    is(refusal("https://preview.example/"), 7, "nor the preview's");
    is(refusal("ftp://files.example/a"), 1, "nor anything that is not http");
    is(refusal("not a url"), 3, "and a URL that is not one says so");
    const vetted = vet("https://ada:s3cret@api.example/x", https, ours);
    is("url" in vetted && vetted.url.href === "https://api.example/x" && vetted.authorization === `Basic ${btoa("ada:s3cret")}`, true, "user:pass in a URL goes as a header, which fetch takes where it refuses the URL");
    const { headers, dropped } = headersFor([["Accept", "*/*"], ["X-Token", "t"], ["Host", "elsewhere"], ["Cookie", "a=b"], ["User-Agent", "curl"], ["Sec-Fetch-Mode", "x"]]);
    is(headers.get("x-token") === "t" && headers.get("accept") === "*/*" && !headers.has("host"), true, "a page's own headers go");
    is(JSON.stringify(dropped), JSON.stringify(["Host", "Cookie", "User-Agent", "Sec-Fetch-Mode"]), "and the browser's are named rather than dropped without a word");
    const asked = new TextEncoder().encode(`${JSON.stringify({ url: "https://api.example/", method: "POST", headers: [["A", "b"]], body: true, timeout: 5 })}\n\u0000\n{"x":1}`);
    const request = decodeFetch(asked);
    is(JSON.stringify([request.url, request.method, request.headers, [...(request.body ?? [])], request.timeout]), JSON.stringify(["https://api.example/", "POST", [["A", "b"]], [0, 10, 123, 34, 120, 34, 58, 49, 125], 5]), "a request reads back with its body's bytes as they were, newlines and all");
    is(decodeFetch(new TextEncoder().encode(`${JSON.stringify({ url: "https://a.example/", body: false })}\n`)).body, null, "and one with no body has none, not an empty one");
    const told = encodeFetched({ ok: true, status: 200, statusText: "", url: "https://a.example/", redirected: false, headers: [], dropped: [] }, new Uint8Array([1, 2, 10, 3]));
    const cut = told.indexOf(10);
    is(JSON.parse(new TextDecoder().decode(told.subarray(0, cut))).status === 200 && [...told.subarray(cut + 1)].join() === "1,2,10,3", true, "an answer is a line of JSON and the body's bytes after it");
    const refused = new TextDecoder().decode(await answer({ url: `${location.origin}/api/pad/x`, method: "GET", headers: [], body: null, timeout: null, follow: true }, new URL(location.href), []));
    is(JSON.parse(refused.split("\n")[0]!).code, 7, "a request for the page's own site is answered with a refusal, and never made");
    const withBody = new TextDecoder().decode(await answer({ url: "https://api.example/", method: "GET", headers: [], body: new Uint8Array([1]), timeout: null, follow: true }, https, []));
    is(/no body with GET/.test(withBody), true, "and a GET with a body says what to do instead");
    const asks: string[] = [];
    const local: LocalFetch = async (request, url) => {
      asks.push(`${request.method} ${url.host}${url.pathname}`);
      return { answer: { ok: true, status: 201, statusText: "Created", url: url.href, redirected: false, headers: [["set-cookie", "sid=1"]], dropped: [] }, body: new TextEncoder().encode("made") };
    };
    const toLocal = new TextDecoder().decode(await answer({ url: "http://localhost:5000/api", method: "POST", headers: [], body: new Uint8Array([1]), timeout: null, follow: true }, https, ours, local));
    const toLocalHead = JSON.parse(toLocal.split("\n")[0]!);
    is(JSON.stringify(asks) === JSON.stringify(["POST localhost:5000/api"]) && toLocalHead.status === 201 && toLocalHead.headers[0][1] === "sid=1" && toLocal.endsWith("\nmade"), true, "localhost is the folder's own servers: plain http from an https page, to the port asked, every header back");
    const noPreview = new TextDecoder().decode(await answer({ url: "http://127.0.0.1:5000/", method: "GET", headers: [], body: null, timeout: null, follow: true }, https, ours, null));
    is(JSON.parse(noPreview.split("\n")[0]!).code, 7, "and with no preview to reach them through, it says so rather than asking this computer");
    const ownLocal = new TextDecoder().decode(await answer({ url: "http://127.0.0.1:5199/api/pad/x", method: "GET", headers: [], body: null, timeout: null, follow: true }, new URL("http://127.0.0.1:5199/"), [], local));
    is(JSON.parse(ownLocal.split("\n")[0]!).code === 7 && asks.length === 1, true, "but a page served from localhost, as the checks are, still never asks its own address");
  }

  // ---- the runtime's word when a pipe's reader leaves ----
  // A real tool dies of SIGPIPE without a word; the runtime said so on the
  // terminal, and then aborted, on a slow machine. Those lines go, and only
  // those: an abort with no broken pipe before it is the program's own.
  {
    const PIPE = "Program recieved termination signal: Broken pipe";
    const ABORT = "Program recieved fatal signal: Aborted";
    const n = new RuntimeNotices();
    is(n.push(`alpha\r\n${PIPE}\r\n${ABORT}\r\n${ABORT}\r\n`), "alpha\r\n", "the broken pipe notice and the aborts after it are left out, the output kept");
    n.end();
    is(n.push(`${ABORT}\r\n`), `${ABORT}\r\n`, "an abort with no broken pipe before it, in its own command, is shown");
    n.end();
    is(n.push("Program rec"), "", "the start of a notice is held");
    is(n.push(`ieved termination signal: Broken pipe\r\n$ `), "$ ", "and dropped once its line is whole, with what follows shown");
    is(n.push("$ "), "$ ", "a prompt with no line end is shown at once");
    is(n.push("Progress 10%"), "Progress 10%", "and so is anything that cannot be a notice");
    is(n.push("Pro") + n.flush(), "Pro", "what was held is shown when let go");
    is(n.push(`say ${PIPE}\r\n`), `say ${PIPE}\r\n`, "a line that only mentions it is kept");
  }

  // ---- a document message too big for the relay ----
  // One over the relay's frame limit does not close the socket: the relay
  // stops reading it, and everything sent after goes nowhere. So it is never
  // sent, and the caller is told.
  {
    const peers = new Peers("ws://127.0.0.1:9/", "nowhere", { onMoved: () => {}, onPresence: () => {}, onDoc: () => {} });
    const before = peers.counts.docOut;
    is(peers.doc(1, DOC_UPDATE, new Uint8Array(MAX_DOC_MESSAGE)), false, "a document message over the relay's limit is not sent");
    is(peers.counts.docOut, before, "and is not counted as sent");
    is(peers.doc(1, DOC_UPDATE, new Uint8Array(1024)), true, "an ordinary one is");
    peers.close();
  }

  // ---- names ----
  is(/^[a-z]+-[a-z]+-\d{4}$/.test(mintName()), true, "a minted name fits the server's rule");
  is(mintName() !== mintName(), true, "two minted names differ");

  // ---- the store, over real http ----
  // A request the server never answers fails in time. It used to wait for
  // good, and every save and publish behind it in the page's queue with it.
  {
    const impatient = new Store("", () => null, 400);
    const began = performance.now();
    const err = await impatient.read("never-answers").then(() => null, (e: unknown) => e);
    is(
      err instanceof StoreError && /did not answer in time/.test(err.message) && performance.now() - began < 3000,
      true,
      `a store request the server never answers fails in time (${err instanceof Error ? err.message : String(err)})`,
    );
  }
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

  // A save of a large file as what changed in it, against the text the relay
  // holds, named by its hash. Anything else it holds by then, it refuses.
  {
    const big = `${"line of text\n".repeat(2000)}end\n`;
    await store.write(name, [{ path: "big.txt", content: big }]);
    is(store.editsWork, true, "the relay says it takes edits");
    const base = await storedHash(big);
    await store.write(name, [{ path: "big.txt", content: null, base, edits: [{ at: 0, remove: 4, insert: "LINE" }] }]);
    const after = (await store.read(name)).files["big.txt"];
    is(after?.content, `LINE${big.slice(4)}`, "an edit against the stored text changes it, and only where it says");
    is(after?.hash, await storedHash(`LINE${big.slice(4)}`), "and the relay's hash is the one a browser works out");
    let stale = false;
    try {
      await store.write(name, [{ path: "big.txt", content: null, base, edits: [{ at: 0, remove: 4, insert: "XXXX" }] }]);
    } catch (e) {
      stale = e instanceof StoreError && e.stale;
    }
    is(stale, true, "an edit against a version the relay no longer holds is refused as stale");
    is((await store.read(name)).files["big.txt"]?.content.startsWith("LINE"), true, "and changes nothing");
  }

  // ---- a write too big for one request ----
  // A pad holds 100 MiB and a request carries 24, so an upload, a copy or a
  // large file goes in parts. Sizes are counted as the bytes JSON.stringify
  // writes, which is what the relay's limit counts.
  {
    const samples = ["", "plain", 'quote " back \\ slash', "tab\tnl\nctl\u0001\u001f", "é漢😀", "lone \ud800 high", "lone \udc00 low", "😀".repeat(50)];
    is(
      samples.every((t) => jsonBytes(t) === new TextEncoder().encode(JSON.stringify(t)).length),
      true,
      "a string's size as JSON is counted as JSON.stringify writes it",
    );
    const text = "ab\"é漢😀\n".repeat(500);
    const cut = pieces(text, 200);
    is(cut.join(""), text, "pieces put back together are the text");
    is(cut.every((p) => jsonBytes(p) <= 200), true, "and none is over its size");
    is(cut.every((p) => !/^[\udc00-\udfff]/.test(p)), true, "and none starts inside a character");

    const steps = plan(
      [
        { path: "a.txt", content: "a".repeat(100) },
        { path: "b.txt", content: "b".repeat(100) },
        { path: "big.txt", content: "c".repeat(5000) },
        { path: "z.txt", content: "z" },
      ],
      2048,
    );
    is(steps[0]?.changes.map((c) => c.path).join(","), "a.txt,b.txt", "small changes go together");
    const parts = steps.filter((st) => st.changes[0]?.path === "big.txt");
    is(parts.length > 1 && parts.slice(1).every((st) => st.follows), true, "a large file goes as a first part and parts that follow it");
    is(
      parts.slice(1).map((st) => st.changes[0]?.edits?.[0]?.at).join(","),
      parts.slice(0, -1).reduce<number[]>((ats, st, i) => [...ats, (ats[i - 1] ?? 0) + (st.changes[0]?.content ?? st.changes[0]?.edits?.[0]?.insert ?? "").length], []).join(","),
      "each part goes at the end of the ones before it",
    );
    is(steps.at(-1)?.changes[0]?.path, "z.txt", "and what comes after it, after it");

    // Against the relay, with requests made small enough that it all splits.
    const small = new Store();
    small.requestBytes = 16 * 1024;
    const puts: number[] = [];
    const realFetch = window.fetch;
    window.fetch = (input, init) => {
      if (init?.method === "PUT") puts.push(String(init.body).length);
      return realFetch(input, init);
    };
    try {
      const pad = mintName();
      const huge = `${"line \"quoted\" é 漢 😀 \\ tab\t\n".repeat(6000)}end`;
      const many = Array.from({ length: 30 }, (_, i) => ({ path: `many/${i}.txt`, content: `${i}`.repeat(2000) }));
      const binary = btoa("\u0000\u00ff".repeat(20000));
      await small.write(pad, [...many, { path: "huge.txt", content: huge }, { path: "logo.bin", content: binary, encoding: "base64" }]);
      const got = (await small.read(pad)).files;
      is(got["huge.txt"]?.content, huge, `a file bigger than a request arrives whole (${puts.length} requests)`);
      is(got["huge.txt"]?.hash, await storedHash(huge), "and the relay's hash is the whole file's");
      is(got["logo.bin"]?.content === binary && got["logo.bin"]?.encoding === "base64", true, "a binary file too");
      is(many.every((m) => got[m.path]?.content === m.content), true, "and every small file beside them");
      is(puts.every((n) => n <= 16 * 1024), true, `no request was over its size (largest ${Math.max(...puts)})`);
      // A paste bigger than a request, into a file the relay already has.
      const pasted = "pasted 😀 text\n".repeat(4000);
      puts.length = 0;
      await small.write(pad, [
        { path: "huge.txt", content: null, base: await storedHash(huge), edits: [{ at: 4, remove: 1, insert: pasted }] },
      ]);
      const after = `${huge.slice(0, 4)}${pasted}${huge.slice(5)}`;
      is((await small.read(pad)).files["huge.txt"]?.content, after, `a paste bigger than a request lands where it was made (${puts.length} requests)`);
    } finally {
      window.fetch = realFetch;
    }
  }

  await sh.close();

  await rt.close();
  report("DONE");
}

main().catch((e) => {
  fail(`${e?.message ?? e} | ${e?.cause?.message ?? ""}`);
  report("DONE");
});

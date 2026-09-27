#!/usr/bin/env node
// The pad used the way a person uses it: code with mistakes in it, Run,
// input(), a loop that never ends, a file made with New file, ctrl-c, ctrl-d.
// Judged by what is on the screen, the way they would judge it.
//
// terminal-check.mjs is the keyboard; this is everything else. It exists
// because on 27 September a person pressed Run on `def encode(in):` and saw
// "exit 1" and nothing more — every error had gone nowhere since 12 September
// and no check had ever made a mistake on purpose. The same afternoon found:
// ctrl-c that stopped nothing, so a print loop filled the terminal for minutes
// after it; ctrl-c at input() that left a shell which never answered again;
// no way to stop a program without knowing ctrl-c; Run failing after a `cd`;
// output without a final newline erased by the next key; ctrl-d that did
// nothing; threads, and so `pip install requests`, freezing the page.
//
//   npx vite build && node scripts/user-check.mjs
//   PAD_ORIGIN=https://code.rishwanth.dev node scripts/user-check.mjs
//
// Locally it serves the build with a stub store. Against a deployment it is
// one first visit unless PROFILE names a warm one, and it also installs a
// package, which needs the deployment's network.

import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL("../../web/package.json", import.meta.url))("playwright");
const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = 5208;
const LIVE = process.env.PAD_ORIGIN ?? null;
const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json", ".map": "application/json",
  ".wasm": "application/wasm", ".webc": "application/webc", ".js": "text/javascript", ".mjs": "text/javascript",
};

const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  if (path.startsWith("/api/pad/")) {
    res.setHeader("Content-Type", "application/json");
    return res.end(req.method === "PUT" ? JSON.stringify({ seq: 1 }) : JSON.stringify({ exists: false, seq: 0, files: {} }));
  }
  if (path === "/sw.js") res.setHeader("Service-Worker-Allowed", "/");
  try {
    const file = join(ROOT, path);
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.setHeader("Content-Type", "text/html");
    res.end(await readFile(join(ROOT, "index.html")));
  }
});
if (!LIVE) await new Promise((r) => server.listen(PORT, r));
const ORIGIN = LIVE ?? `http://127.0.0.1:${PORT}`;

const profile = process.env.PROFILE ?? (await mkdtemp(join(tmpdir(), "pad-user-")));
const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 800 } });
const page = context.pages()[0] ?? (await context.newPage());
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
let answer = null;
page.on("dialog", (d) => (answer === null ? d.dismiss() : d.accept(answer)));

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m, detail) => { failures++; console.log(`  FAIL ${m}${detail ? `\n         ${detail}` : ""}`); };
const expect = (m, pass, detail) => (pass ? ok(m) : fail(m, detail));

const rows = async () => (await page.evaluate(() => document.querySelector("#terminal .xterm-rows")?.innerText ?? ""))
  .split("\n").map((l) => l.replace(/\u00a0/g, " ").replace(/\s+$/, ""));
const tail = async (n = 4) => (await rows()).filter(Boolean).slice(-n).join(" | ");
const shows = async (re, ms = 3000) => page
  .waitForFunction((src) => new RegExp(src).test(document.querySelector("#terminal .xterm-rows")?.innerText ?? ""), re.source, { timeout: ms })
  .then(() => true, () => false);
const idle = (ms = 60_000) => page
  .waitForFunction(() => window.__pad?.shellBusy() === false && !document.querySelector("#run")?.disabled, null, { timeout: ms })
  .then(() => true, () => false);
const wait = (ms) => page.waitForTimeout(ms);
const runLabel = async () => (await page.locator("#run").textContent()).trim();
const status = async () => (await page.locator("#status").textContent()) ?? "";
const focus = () => page.locator("#terminal .xterm-helper-textarea").focus();
async function type(command) {
  await focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}
async function typed(command, ms = 20_000) {
  await type(command);
  await wait(150);
  return idle(ms);
}
async function clear() {
  await typed("clear", 10_000);
  await wait(150);
}
/** Put `code` in the open file and press Run; resolve when it is over, unless told not to wait. */
async function run(code, { wait: waitFor = true, ms = 60_000 } = {}) {
  await page.evaluate((c) => window.monaco.editor.getEditors()[0].setValue(c), code);
  await wait(200);
  await page.click("#run");
  if (!waitFor) return true;
  await wait(300);
  return idle(ms);
}
async function newFile(name, content) {
  answer = name;
  await page.locator('#files button[aria-label="New file"]').click();
  answer = null;
  await wait(400);
  await page.evaluate((c) => window.monaco.editor.getEditors()[0].setValue(c), content);
  await wait(300);
}
const open = async (name) => { await page.locator("#files").getByText(name, { exact: true }).click(); await wait(300); };

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__pad && window.monaco, null, { timeout: 60_000 });
  await page.click("#terminal");
  // The runtime starts at load. A typed command answering is the only proof
  // that it has — the button and the prompt are both there before it is.
  await type("echo ready");
  await shows(/\nready/, 240_000);
  await idle();

  // ---- mistakes ----
  await clear();
  await run("x = 1\ndef f(in):\n    pass\n");
  expect("a syntax error says what and where", (await shows(/line 2/)) && (await shows(/SyntaxError: invalid syntax/)), await tail());
  await clear();
  await run("def f():\n    return undefined_name\n\nprint('before')\nf()\n");
  expect("a runtime error prints the output before it, then the traceback", (await shows(/before/)) && (await shows(/NameError: name 'undefined_name' is not defined/)), await tail());
  await clear();
  await run("import sys\nsys.exit(3)\n");
  expect("sys.exit(3) shows exit 3", (await shows(/exit 3/)) && (await status()) === "exited 3", `${await tail()} / ${await status()}`);
  await clear();
  await run("import threading\nthreading.Thread(target=print).start()\n", { ms: 15_000 });
  expect("starting a thread is an error that says why, not a hang", await shows(/threads cannot start in the pad/), await tail(2));

  // ---- input ----
  await clear();
  await run("name = input('Your name: ')\nprint(f'Hello, {name}!')\n", { wait: false });
  const prompted = await shows(/Your name:/, 20_000);
  await type("Asha");
  await idle(20_000);
  expect("input() prompts, and what is typed reaches it", prompted && (await shows(/Hello, Asha!/)), await tail());
  await clear();
  await run("input('say: ')\n", { wait: false });
  await shows(/say:/, 20_000);
  await focus(); await page.keyboard.press("Control+d");
  expect("ctrl-d at input() is an EOFError", (await idle(10_000)) && (await shows(/EOFError/)), await tail());
  expect("…and the next command runs", (await typed("echo after-eof")) && (await shows(/\nafter-eof/)), await tail());
  await clear();
  await type("cat > notes.txt");
  await wait(600);
  await page.keyboard.type("one"); await page.keyboard.press("Enter");
  await page.keyboard.type("two"); await page.keyboard.press("Enter");
  await page.keyboard.press("Control+d");
  await idle(10_000);
  await typed("wc -l < notes.txt");
  expect("cat > notes.txt ends with ctrl-d, and the file has what was typed", (await rows()).some((l) => l.trim() === "2"), await tail());

  // ---- stopping ----
  await typed("export KEPT=yes");
  await clear();
  await run("i = 0\nwhile True:\n    i += 1\n    print(i)\n", { wait: false });
  await wait(1500);
  await focus(); await page.keyboard.press("Control+c");
  const stopped = await idle(5000);
  const newest = async () => Math.max(-1, ...(await rows()).map((l) => (/^\d+$/.test(l.trim()) ? Number(l) : -1)));
  await wait(800); const soon = await newest();
  await wait(2500); const later = await newest();
  expect("ctrl-c stops a print loop, and nothing more is printed after", stopped && soon === later, `stopped=${stopped}, newest ${soon} then ${later}`);
  expect("…without an exit code for the ^C", !(await shows(/exit 27|exit 130/, 300)), await tail());
  expect("…and the shell is the same one", (await typed("echo kept=$KEPT")) && (await shows(/kept=yes/)), await tail());
  await clear();
  await run("x = input('stuck? ')\n", { wait: false });
  await shows(/stuck\?/, 20_000);
  await focus(); await page.keyboard.press("Control+c");
  await idle(5000);
  expect("ctrl-c at input() leaves a shell that answers", (await typed("echo still-here", 10_000)) && (await shows(/\nstill-here/)), await tail());
  await clear();
  await run("import time\nprint('sleeping', flush=True)\ntime.sleep(30)\n", { wait: false });
  await shows(/sleeping/, 20_000);
  await wait(600);
  const label = await runLabel();
  await page.click("#run");
  const byButton = await idle(5000);
  expect("Run becomes Stop while a program runs, and Stop stops it", label === "Stop" && byButton && (await runLabel()) === "Run" && (await status()) === "stopped", `label "${label}", stopped=${byButton}, status "${await status()}"`);
  await type("sleep 30");
  await wait(800);
  const typedLabel = await runLabel();
  await page.click("#run");
  expect("…a typed command too", typedLabel === "Stop" && (await idle(5000)), `label "${typedLabel}"`);
  await clear();
  await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue("import time\ntime.sleep(1)\nprint('once')\n"));
  await page.click("#run"); await wait(150); await page.click("#run").catch(() => {});
  await wait(400); await idle(20_000);
  expect("a double-click on Run runs it once, and does not stop it", (await rows()).filter((l) => l.trim() === "once").length === 1, await tail());
  await clear();
  await type("while true; do sleep 1; done");
  await wait(1200);
  await focus(); await page.keyboard.press("Control+c");
  expect("ctrl-c ends a loop in bash itself", (await idle(6000)) && (await typed("echo loop-over", 15_000)) && (await shows(/\nloop-over/)), await tail());
  await clear();
  await type("nano notes.txt");
  const editing = await page.waitForFunction(() => document.querySelector("#terminal .xterm-rows")?.innerText.includes("^X"), null, { timeout: 20_000 }).then(() => true, () => false);
  await focus(); await page.keyboard.press("Control+c"); await page.keyboard.press("Control+d"); await wait(2500);
  const survived = editing && (await shows(/\^X/, 500)) && (await page.evaluate(() => window.__pad.shellBusy()));
  await page.click("#run");
  const leftEditor = (await idle(8000)) && (await typed("echo out-of-nano", 15_000)) && (await shows(/\nout-of-nano/));
  expect("ctrl-c and ctrl-d are only keys in nano, and Stop gets out of it", survived && leftEditor, `editing=${editing} survived=${survived} left=${leftEditor}: ${await tail(2)}`);

  // ---- the screen ----
  await clear();
  await run("print('no newline here', end='')\n");
  await focus(); await page.keyboard.type("echo typing"); await wait(300);
  const kept = (await rows()).find((l) => l.includes("no newline here")) ?? "";
  expect("output without a final newline keeps its row, and survives typing", kept.trim() === "no newline here", JSON.stringify(kept));
  await page.keyboard.press("Control+c");
  await clear();
  await run("import sys\nprint('partial', end='')\nsys.exit(4)\n");
  expect("…and exit 4 goes on a row of its own", (await rows()).some((l) => l.trim() === "exit 4"), await tail());
  await clear();
  await run("import time\nfor i in range(0, 101, 10):\n    print(f'\\r{i}%', end='', flush=True)\n    time.sleep(0.03)\nprint()\n");
  expect("a \\r progress bar redraws one row", (await rows()).filter((l) => l.includes("%")).length === 1 && (await shows(/100%/)), await tail());
  await clear();
  const t0 = Date.now();
  await run("for i in range(20000):\n    print('line', i)\n", { ms: 120_000 });
  expect("20,000 lines in under 15 s", (await shows(/line 19999/)) && Date.now() - t0 < 15_000, `${Date.now() - t0} ms`);

  // ---- files ----
  await clear();
  await typed("mkdir -p elsewhere && cd elsewhere");
  await run("import os\nprint('cwd is', os.getcwd())\n");
  const fromRoot = await shows(/cwd is \/workspace\n/);
  await typed("pwd");
  expect("Run works after a cd, from the folder root, and the terminal stays put", fromRoot && (await shows(/\/workspace\/elsewhere\n/)), await tail());
  await typed("cd /workspace");
  await clear();
  await newFile("helper.py", "def greet(who):\n    return f'hi {who} from helper'\n");
  await open("main.py");
  await run("from helper import greet\nprint(greet('main'))\n");
  expect("a file made with New file can be imported", await shows(/hi main from helper/), await tail());
  await clear();
  await run("with open('out.txt', 'w') as f:\n    f.write('written by python\\n')\n");
  const inTree = await page.waitForFunction(() => [...document.querySelectorAll("#files *")].some((e) => e.textContent.trim() === "out.txt"), null, { timeout: 5000 }).then(() => true, () => false);
  expect("a file the program writes appears in the tree", inTree);

  // ---- keys ----
  await page.evaluate(() => {
    window.__saved = null;
    addEventListener("keydown", (e) => { if (e.key === "s") setTimeout(() => { window.__saved = e.defaultPrevented; }, 0); });
  });
  await page.locator(".monaco-editor textarea").first().focus();
  await page.keyboard.press("Control+s");
  await wait(200);
  expect("ctrl-s is not the browser's Save page dialog", (await page.evaluate(() => window.__saved)) === true, `status "${await status()}"`);

  // ---- the network (a deployment only) ----
  if (LIVE) {
    await clear();
    const t1 = Date.now();
    const installed = await typed("pip install requests", 150_000);
    const ms = Date.now() - t1;
    await typed(`python -c "import requests; print('requests', requests.__version__)"`);
    expect("pip install requests finishes, and it imports", installed && (await shows(/requests \d+\.\d+/)), `${ms} ms: ${await tail(3)}`);
  }

  // What the page itself threw, as opposed to what the programs printed.
  expect("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  fail("the run completed", String(e.message).split("\n")[0]);
} finally {
  await context.close();
  if (!process.env.PROFILE) await rm(profile, { recursive: true, force: true });
  server.close();
}

console.log(failures ? `\n  ${failures} failed` : "\n  the pad does what a person expects");
process.exit(failures ? 1 : 0);

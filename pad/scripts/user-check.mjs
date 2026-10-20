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
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const { chromium } = createRequire(new URL("../../web/package.json", import.meta.url))("playwright");
const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = 5208;
const LIVE = process.env.PAD_ORIGIN ?? null;
const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json", ".map": "application/json",
  ".wasm": "application/wasm", ".webc": "application/webc", ".js": "text/javascript", ".mjs": "text/javascript",
};

let lastRun = null;
// A pad as full as a pad gets, for "a pad of many files": 500 files, two of
// them text an editor model would have converted — a byte-order mark, and
// line endings of both kinds. What the page saves of it is kept to look at.
const MANY = "five-hundred-files";
const manyFiles = { "main.py": "print('five hundred')\n", "bom.csv": "\ufeffname,qty\n", "mixed.txt": "one\r\ntwo\nthree\r\n" };
for (let i = 0; i < 497; i++) manyFiles[`src/m${Math.floor(i / 50)}/f${i}.py`] = `def f${i}(x):\n    return x * ${i}\n`;
const manySaved = [];
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  // A run counted (usage.rs): taken and forgotten, as the relay would.
  if (path === "/api/usage/run") {
    for await (const _ of req);
    res.statusCode = 204;
    return res.end();
  }
  if (path === `/api/pad/${MANY}`) {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "PUT") {
      let body = "";
      for await (const chunk of req) body += chunk;
      manySaved.push(...JSON.parse(body).writes.map((w) => w.path));
      return res.end(JSON.stringify({ seq: 2 }));
    }
    const files = Object.fromEntries(Object.entries(manyFiles).map(([p, content]) => [p, { content, encoding: "utf8", seq: 1 }]));
    return res.end(JSON.stringify({ exists: true, seq: 1, files }));
  }
  if (path === `/api/pad/${MANY}/run`) {
    for await (const _ of req);
    res.statusCode = 204;
    return res.end();
  }
  // The pad's last run (the relay's last_runs): the last one kept, for the
  // page that opens next, as the relay would give it.
  if (/^\/api\/pad\/[^/]+\/run$/.test(path)) {
    if (req.method === "PUT") {
      let body = "";
      for await (const chunk of req) body += chunk;
      lastRun = { ...JSON.parse(body), at_ms: Date.now() };
      res.statusCode = 204;
      return res.end();
    }
    if (!lastRun) {
      res.statusCode = 204;
      return res.end();
    }
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(lastRun));
  }
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

// A site for curl through the page to ask. Locally, a small httpbin that lets
// web pages read it, and a path that does not; against a deployment, the
// real httpbin.org and example.com, which sends no CORS headers. Locally it
// is `bin.test`, which the browser is told is 127.0.0.1: since 16 October
// localhost in a pad is the folder's own servers, so 127.0.0.1 would have
// asked the sandbox instead.
const BIN_PORT = 5209;
const bin = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${BIN_PORT}`);
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  if (url.pathname === "/closed") return res.writeHead(200, { "Content-Type": "text/plain" }).end("no cors here\n");
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (url.pathname.startsWith("/status/")) return res.writeHead(Number(url.pathname.slice(8)), cors).end();
  if (url.pathname === "/redirect/1") return res.writeHead(302, { ...cors, Location: "/get" }).end();
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const data = Buffer.concat(chunks).toString("utf8");
    let json = null;
    try { json = JSON.parse(data); } catch { /* not JSON */ }
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(`${JSON.stringify({ args: Object.fromEntries(url.searchParams), data, headers: req.headers, json, method: req.method, url: url.href }, null, 2)}\n`);
  });
});
if (!LIVE) await new Promise((r) => bin.listen(BIN_PORT, r));
const BIN = LIVE ? "https://httpbin.org" : `http://bin.test:${BIN_PORT}`;
const CLOSED = LIVE ? "https://example.com/" : `http://bin.test:${BIN_PORT}/closed`;

const profile = process.env.PROFILE ?? (await mkdtemp(join(tmpdir(), "pad-user-")));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: ["--host-resolver-rules=MAP bin.test 127.0.0.1"],
});
const page = context.pages()[0] ?? (await context.newPage());
const pageErrors = [];
// Which part of the run a page error came from, and where in the page, so
// "Canceled" alone is never all there is to go on.
let section = "loading";
page.on("pageerror", (e) => pageErrors.push(`${section}: ${e.message} ${(e.stack ?? "").split("\n").slice(1, 4).map((l) => l.trim()).join(" < ")}`));
// The browser's own confirm, which deleting a file still asks with.
let answer = null;
page.on("dialog", (d) => (answer === null ? d.dismiss() : d.accept(answer)));
/** A name typed into the row the tree opens for it, as a person would, and Enter. */
async function nameInTree(name) {
  const input = page.locator("#files input.name-input");
  await input.waitFor({ timeout: 5000 });
  await input.fill(name);
  await input.press("Enter");
}
/** F2 on a row, and its new name. */
async function renameInTree(path, name) {
  await page.locator(`#files .row[data-path="${path}"]`).focus();
  await page.keyboard.press("F2");
  await nameInTree(name);
}

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m, detail) => { failures++; console.log(`  FAIL ${m}${detail ? `\n         ${detail}` : ""}`); };
const expect = (m, pass, detail) => (pass ? ok(m) : fail(m, detail));

const rows = async () => (await page.evaluate(() => document.querySelector("#terminal .xterm-rows")?.innerText ?? ""))
  .split("\n").map((l) => l.replace(/\u00a0/g, " ").replace(/\s+$/, ""));
const tail = async (n = 4) => (await rows()).filter(Boolean).slice(-n).join(" | ");
// Also across the terminal's wrapping: a word that lands on the last column
// is split over two rows, and a check that passed at one width failed at
// another — "C" on one row and "ORS" on the next.
const shows = async (re, ms = 3000) => page
  .waitForFunction((src) => {
    const text = document.querySelector("#terminal .xterm-rows")?.innerText ?? "";
    return new RegExp(src).test(text) || new RegExp(src).test(text.replace(/\n/g, ""));
  }, re.source, { timeout: ms })
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
/** A file at `name` from the top — wherever New file would put it — with `content` in it. */
async function newFile(name, content) {
  await page.locator('#files button[aria-label="New file"]').click();
  await nameInTree(`/${name}`);
  await wait(400);
  // Into the new file or nowhere. A name already taken is refused, the editor
  // stays where it was, and the content went into whatever file was open —
  // the Markdown section's README landed in the guide it linked to, because
  // an earlier section had made a notes.md.
  const opened = await page.waitForFunction((n) => window.__pad?.active() === n, name, { timeout: 10_000 }).then(() => true, () => false);
  if (!opened) throw new Error(`New file did not open ${name} (is the name taken?); ${await page.evaluate(() => window.__pad?.active())} is open`);
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
  section = "mistakes";
  await clear();
  await run("x = 1\ndef f(in):\n    pass\n");
  expect("a syntax error says what and where", (await shows(/line 2/)) && (await shows(/SyntaxError: invalid syntax/)), await tail());
  await clear();
  await run("def f():\n    return undefined_name\n\nprint('before')\nf()\n");
  expect("a runtime error prints the output before it, then the traceback", (await shows(/before/)) && (await shows(/NameError: name 'undefined_name' is not defined/)), await tail());
  await clear();
  await run("import sys\nsys.exit(3)\n");
  expect("sys.exit(3) shows exit 3", (await shows(/exit 3/)) && (await status()) === "exited 3", `${await tail()} / ${await status()}`);
  // And it stays. The save that follows an edit worked out what had changed
  // before the Run's own write had finished, saved the same text again after
  // it, and said "saved" over "exited 3" — flaky on CI's macOS runner on 2
  // October. Writes are slowed here so it lands every time.
  await context.route("**/api/pad/**", async (route) => {
    if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await clear();
  await run("import sys\nsys.exit(4)\n");
  await wait(2000);
  expect("a save after Run leaves its result on the status line", (await status()) === "exited 4", await status());
  await context.unroute("**/api/pad/**");
  await clear();
  await run("import threading\nthreading.Thread(target=print).start()\n", { ms: 15_000 });
  expect("starting a thread is an error that says why, not a hang", await shows(/threads cannot start in the pad/), await tail(2));

  // ---- input ----
  section = "input";
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
  expect("cat > notes.txt ends with ctrl-d, and the file has what was typed", await shows(/(^|\n)[ \u00a0]*2[ \u00a0]*(\n|$)/), await tail());

  // The prompt `python` gives on its own, which opened with a warning about a
  // missing terminfo database before it would take anything.
  await clear();
  await type("python");
  const prompted2 = await shows(/>>>/, 20_000);
  await page.keyboard.type("6 * 7"); await page.keyboard.press("Enter");
  const answered = await shows(/(^|\n)[  ]*42[  ]*(\n|$)/, 5000);
  await page.keyboard.type("exit()"); await page.keyboard.press("Enter");
  const left = await idle(10_000);
  expect("python on its own is a prompt that answers, with no warning first", prompted2 && answered && left && !(await shows(/pyrepl|terminfo/, 200)), await tail(3));

  // ---- stopping ----
  section = "stopping";
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
  // A program with a lock that could be shared between processes —
  // Flask's debugger makes one. Python started a process of its own to keep
  // track of those, and while that ran, ctrl-c went to it: the program served
  // on, holding its port, behind a prompt that looked as if it had stopped.
  await clear();
  await run("import multiprocessing, time\nshared = multiprocessing.Value('B')\nprint('holding a lock', flush=True)\ntime.sleep(30)\n", { wait: false });
  await shows(/holding a lock/, 20_000);
  await wait(600);
  await focus(); await page.keyboard.press("Control+c");
  const lockStopped = await idle(1400);
  await wait(300);
  const sameShell = (await typed("echo kept=$KEPT")) && (await shows(/kept=yes/));
  expect("ctrl-c stops a program holding a multiprocessing lock, in the same shell", lockStopped && sameShell, await tail(4));
  // One whose child is still running cannot be stopped from here at all: the
  // signal goes to the child. Ended with the shell, it is said so.
  await clear();
  await run("import subprocess, time\nchild = subprocess.Popen(['sleep', '60'])\nprint('with a child', flush=True)\ntime.sleep(30)\n", { wait: false });
  await shows(/with a child/, 20_000);
  await wait(600);
  await focus(); await page.keyboard.press("Control+c");
  await idle(5000);
  expect("a program ctrl-c cannot reach is ended with the shell, and that is said, port and all", await shows(/did not stop at ctrl-c.*holding its port/), await tail(3));
  await typed("export KEPT=yes");
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
  // ---- more than one terminal ----
  // A server in one, and the rest of the pad still usable in another: until
  // 16 October there was one terminal, and a server running in it was the end
  // of typing anything else.
  section = "terminals";
  await clear();
  const tmTerminals = () => page.evaluate(() => window.__pad.terminals());
  const tmRowsIn = (id) => page.evaluate((i) => document.querySelector(`#${i} .xterm-rows`)?.innerText ?? "", id);
  await run("import time\nfor i in range(60):\n    print('busy', i, flush=True)\n    time.sleep(0.5)\n", { wait: false });
  await shows(/busy 1/, 20_000);
  await page.click("#new-terminal");
  await page.locator("#terminal-2 .xterm-helper-textarea").focus();
  await page.keyboard.type("echo second-terminal; pwd");
  await page.keyboard.press("Enter");
  const tmAnswered = await page.waitForFunction(() => /second-terminal\n\/workspace/.test(document.querySelector("#terminal-2 .xterm-rows")?.innerText ?? ""), null, { timeout: 20_000 }).then(() => true, () => false);
  const tmBoth = await tmTerminals();
  expect("a second terminal answers while the first runs something, in the same folder",
    tmAnswered && tmBoth.length === 2 && tmBoth[0].busy && !tmBoth[1].busy && !/starting the runtime/.test(await tmRowsIn("terminal-2")), JSON.stringify(tmBoth));
  const tmTabs = await page.locator("#tabs .tab").count();
  const tmDots = await page.locator("#tabs .tab.running").count();
  const tmLabel2 = await runLabel();
  await page.locator("#tabs .tab", { hasText: "Terminal 1" }).click();
  const tmLabel1 = await runLabel();
  expect("each has a tab, the busy one marked, and Run is Stop for the one in front only", tmTabs === 2 && tmDots === 1 && tmLabel2 === "Run" && tmLabel1 === "Stop", `${tmTabs} tabs, ${tmDots} running, Run says "${tmLabel2}" then "${tmLabel1}"`);
  await page.click("#split");
  await wait(400);
  const tmShown = await page.evaluate(() => [...document.querySelectorAll(".terms > .terminal.shown")].map((e) => e.id));
  expect("Split shows two side by side", JSON.stringify(tmShown) === JSON.stringify(["terminal", "terminal-2"]), JSON.stringify(tmShown));
  await page.click("#split");
  // Closing the busy one stops what runs in it first.
  await page.locator("#tabs .tab-wrap", { hasText: "Terminal 1" }).hover();
  await page.locator('#tabs button[aria-label="Close terminal 1"]').click();
  const tmClosed = await page.waitForFunction(() => window.__pad.terminals().length === 1, null, { timeout: 10_000 }).then(() => true, () => false);
  const tmAfter = await tmTerminals();
  expect("closing a terminal stops what runs in it, and the other stays", tmClosed && tmAfter.length === 1 && tmAfter[0].number === 2 && !tmAfter[0].busy && (await page.locator("#tabs .tab").count()) === 0, JSON.stringify(tmAfter));
  // The rest of this check types into #terminal, the first: one like it again.
  await page.click("#new-terminal");
  await page.locator("#tabs .tab-wrap", { hasText: "Terminal 2" }).hover();
  await page.locator('#tabs button[aria-label="Close terminal 2"]').click();
  await page.waitForFunction(() => window.__pad.terminals().length === 1, null, { timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => {
    const host = document.querySelector(".terms > .terminal");
    if (host) host.id = "terminal";
  });

  section = "the screen";
  await clear();
  await run("print('no newline here', end='')\n");
  await focus(); await page.keyboard.type("echo typing"); await wait(300);
  const kept = (await rows()).find((l) => l.includes("no newline here")) ?? "";
  expect("output without a final newline keeps its row, and survives typing", kept.trim() === "no newline here", JSON.stringify(kept));
  await page.keyboard.press("Control+c");
  await clear();
  await run("import sys\nprint('partial', end='')\nsys.exit(4)\n");
  expect("…and exit 4 goes on a row of its own", await shows(/(^|\n)[ \u00a0]*exit 4[ \u00a0]*(\n|$)/), await tail());
  await clear();
  await run("import time\nfor i in range(0, 101, 10):\n    print(f'\\r{i}%', end='', flush=True)\n    time.sleep(0.03)\nprint()\n");
  expect("a \\r progress bar redraws one row", (await rows()).filter((l) => l.includes("%")).length === 1 && (await shows(/100%/)), await tail());
  await clear();
  const t0 = Date.now();
  await run("for i in range(20000):\n    print('line', i)\n", { ms: 120_000 });
  expect("20,000 lines in under 15 s", (await shows(/line 19999/)) && Date.now() - t0 < 15_000, `${Date.now() - t0} ms`);

  // ---- files ----
  section = "files";
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

  // ---- the editor ----
  section = "the editor";
  // Colour, which the pad had none of: every file was plain text, Python too.
  await open("main.py");
  await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue("def greet(who):\n    # say hello\n    return f'hi {who}' + str(42)\n"));
  const kinds = () => page.evaluate(() => new Set([...document.querySelectorAll(".monaco-editor .view-lines span[class^='mtk']")].map((s) => s.className)).size);
  // The tokenizer arrives a moment after the text, on its first use.
  await page.waitForFunction(
    () => new Set([...document.querySelectorAll(".monaco-editor .view-lines span[class^='mtk']")].map((s) => s.className)).size >= 4,
    null, { timeout: 10_000 },
  ).catch(() => {});
  const tokens = await kinds();
  expect("python is coloured, not plain text", tokens >= 4, `${tokens} kinds of token`);
  const language = async (name) => {
    await newFile(name, "x");
    const id = await page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getLanguageId());
    return id;
  };
  const langs = { "page.html": await language("page.html"), "data.json": await language("data.json"), "notes.md": await language("notes.md"), "run.sh": await language("run.sh") };
  expect("html, json, markdown and shell each get their colours", JSON.stringify(langs) === JSON.stringify({ "page.html": "html", "data.json": "javascript", "notes.md": "markdown", "run.sh": "shell" }), JSON.stringify(langs));
  await page.locator(".monaco-editor textarea").first().focus();
  await page.keyboard.press("ControlOrMeta+f");
  expect("ctrl-f opens find", await page.waitForSelector(".monaco-editor .find-widget.visible", { timeout: 5000 }).then(() => true, () => false));
  await page.keyboard.press("Escape");

  // New file in the folder clicked last: its name typed in a row there, as
  // in an editor's explorer, before anything is made.
  const shownText = () => page.evaluate(() => window.monaco.editor.getEditors()[0].getValue());
  await open("main.py");
  await page.locator('#files .row.dir[data-path="elsewhere"]').click();
  await page.locator('#files button[aria-label="New file"]').click();
  const placed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#files .file-row")];
    const at = rows.findIndex((r) => r.querySelector('.row.dir[data-path="elsewhere"]'));
    const naming = rows.findIndex((r) => r.classList.contains("naming"));
    const pad = (r) => parseFloat(r.querySelector(".row").style.paddingLeft);
    return naming === at + 1 && pad(rows[naming]) > pad(rows[at]);
  });
  await nameInTree("starter.py");
  const made = await page.waitForFunction(() => window.__pad.active() === "elsewhere/starter.py", null, { timeout: 5000 }).then(() => true, () => false);
  expect("New file opens a row for its name inside the folder clicked last, and makes it there", placed && made, `placed ${placed}, active ${await page.evaluate(() => window.__pad.active())}`);

  // Empty, it offers what it could start as; taken, that is one edit.
  const offered = await page.locator(".starter-hint button").textContent({ timeout: 5000 }).catch(() => "");
  await page.locator(".starter-hint button").click();
  const started = await shownText();
  await page.keyboard.press("ControlOrMeta+z");
  await wait(200);
  const undone = await shownText();
  const offeredAgain = await page.locator(".starter-hint button").isVisible().catch(() => false);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await wait(200);
  expect("an empty file offers a starter, and undo takes the starter out again",
    offered === "Insert a Python starter" && started.startsWith("def main():\n    name = ") && undone === "" && offeredAgain && (await shownText()) === started,
    `"${offered}", ${JSON.stringify(started.slice(0, 30))}, undone ${JSON.stringify(undone)}, offered again ${offeredAgain}`);
  await clear();
  await page.click("#run");
  await wait(300);
  await idle(60_000);
  expect("and the starter runs", (await shows(/Hello, world!/)) && (await shows(/3 squared is 9/)), await tail(4));

  // Format, with 4 spaces; Spaces makes it 2, and the key does it too.
  await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue("def f(a,b):\n  return {'x':a}\nprint(f(1,2))\n"));
  await page.locator("#format-file").click();
  const four = await page.waitForFunction(() => window.monaco.editor.getEditors()[0].getValue() === 'def f(a, b):\n    return {"x": a}\n\n\nprint(f(1, 2))\n', null, { timeout: 20_000 }).then(() => true, () => false);
  await page.locator("#indent").click();
  const indentLabel = await page.locator("#indent").textContent();
  await page.locator(".monaco-editor textarea").first().focus();
  await page.keyboard.press("Shift+Alt+KeyF");
  const two = await page.waitForFunction(() => window.monaco.editor.getEditors()[0].getValue() === 'def f(a, b):\n  return {"x": a}\n\n\nprint(f(1, 2))\n', null, { timeout: 10_000 }).then(() => true, () => false);
  await page.locator("#indent").click();
  expect("Format formats with 4 spaces, Spaces switches it to 2, and shift-alt-f formats too", four && indentLabel === "Spaces: 2" && two && (await page.locator("#indent").textContent()) === "Spaces: 4",
    `four ${four}, "${indentLabel}", two ${two}: ${JSON.stringify(await shownText())}`);
  await page.evaluate(() => window.monaco.editor.getEditors()[0].setValue("def f(:\n"));
  await page.locator("#format-file").click();
  const refused = await page.waitForFunction(() => /was not formatted: .* on line 1/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 10_000 }).then(() => true, () => false);
  expect("a file that will not parse is left as it is, and the status says where", refused && (await shownText()) === "def f(:\n", await page.locator("#status").textContent());
  const formatShown = async (name) => {
    await newFile(name, "");
    return page.locator("#format-file").isVisible();
  };
  expect("Format is there for a file something formats, and not for one nothing does", (await formatShown("fmt.json")) && !(await formatShown("fmt.txt")));

  // Typed the moment the file is made, before its document is ready: there
  // once. It was there twice until 15 October.
  await page.locator('#files button[aria-label="New file"]').click();
  await nameInTree("/typed-at-once.txt");
  await page.keyboard.type("abc");
  await wait(1500);
  expect("typing straight after New file is in the file once", (await shownText()) === "abc", JSON.stringify(await shownText()));

  // Where a file was left is where it opens again: scrolled to line 1000 of
  // 3000, away to another file, back. It opened at line 1 every time until 6
  // October, and at line 1 too after anything changed it meanwhile.
  await newFile("long.txt", Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const placeIn = () => page.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    return { top: ed.getVisibleRanges()[0]?.startLineNumber ?? 0, cursor: ed.getPosition()?.lineNumber ?? 0 };
  });
  await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.setPosition({ lineNumber: 1000, column: 1 });
    ed.revealLineInCenter(1000);
  });
  await wait(200);
  const leftAt = await placeIn();
  await open("main.py");
  await open("long.txt");
  const cameBack = await placeIn();
  expect("a file opens again where it was left — scrolled to and the cursor",
    cameBack.cursor === 1000 && cameBack.top === leftAt.top && leftAt.top > 900, `left ${JSON.stringify(leftAt)}, back ${JSON.stringify(cameBack)}`);
  await open("main.py");
  await clear();
  await typed("sed -i '2s/.*/line two, rewritten by a command/' long.txt");
  await page.waitForFunction(() => (window.__pad.text("long.txt") ?? "").includes("rewritten by a command"), null, { timeout: 15_000 }).catch(() => {});
  await open("long.txt");
  const afterCommand = await placeIn();
  const rewritten = (await page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getLineContent(2))) === "line two, rewritten by a command";
  expect("and after a command changed it meanwhile, it is still there — with the change",
    rewritten && afterCommand.cursor === 1000 && afterCommand.top === leftAt.top, `rewritten ${rewritten}, ${JSON.stringify(afterCommand)}`);
  // And a command changing it while it is on screen does not move the view.
  await page.click("#terminal");
  await typed("sed -i '3s/.*/line three, rewritten on screen/' long.txt");
  await page.waitForFunction(() => window.monaco.editor.getEditors()[0].getModel().getLineContent(3) === "line three, rewritten on screen", null, { timeout: 15_000 }).catch(() => {});
  const onScreen = await placeIn();
  const changedOnScreen = (await page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getLineContent(3))) === "line three, rewritten on screen";
  expect("a command changing the file on screen does not move the view", changedOnScreen && onScreen.top === leftAt.top, `changed ${changedOnScreen}, ${JSON.stringify(onScreen)}`);
  // Moved while open, the place goes with it.
  await renameInTree("long.txt", "long-moved.txt");
  await page.waitForFunction(() => window.__pad.active() === "long-moved.txt", null, { timeout: 10_000 }).catch(() => {});
  await wait(300);
  const afterMove = await placeIn();
  expect("and moving the open file keeps the place in it", afterMove.cursor === 1000 && afterMove.top === leftAt.top, JSON.stringify(afterMove));

  // ---- deleting from the tree ----
  section = "deleting from the tree";
  answer = "yes";
  await page.hover('#files .file-row:has(.row.file:text-is("run.sh"))');
  await page.click('#files .file-row:has(.row.file:text-is("run.sh")) .delete');
  answer = null;
  const deleted = await page.waitForFunction(() => ![...document.querySelectorAll("#files .file")].some((b) => b.textContent === "run.sh"), null, { timeout: 10_000 }).then(() => true, () => false);
  await typed("ls run.sh 2>&1 | tail -1");
  expect("the delete button removes a file from the tree and the folder", deleted && (await shows(/No such file/)), await tail(2));

  // ---- zips, in and out ----
  // Made and read by Python's zipfile, so the pad's own reader and writer are
  // held to someone else's idea of a zip, not only to each other.
  section = "zips";
  const zips = await mkdtemp(join(tmpdir(), "pad-zips-"));
  const zipOf = (file, entries) => {
    execFileSync("python3", ["-c", `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for name, body in json.loads(sys.argv[2]).items():
        z.writestr(name, bytes(body) if isinstance(body, list) else body)
`, join(zips, file), JSON.stringify(entries)]);
    return join(zips, file);
  };
  // Text as text; anything else as {"hex": …}, so a binary file can be compared byte for byte.
  const unzip = (file) => JSON.parse(execFileSync("python3", ["-c", `
import json, sys, zipfile
def show(b):
    try:
        return b.decode()
    except UnicodeDecodeError:
        return {"hex": b.hex()}
with zipfile.ZipFile(sys.argv[1]) as z:
    print(json.dumps({"bad": z.testzip(), "files": {n: show(z.read(n)) for n in z.namelist()}}))
`, file]).toString());
  const proj = zipOf("proj.zip", {
    "proj/": "",
    "proj/main.py": "print('from the zip')\n",
    "proj/src/util.py": "def f():\n    return 42\n",
    "proj/naïve.txt": "café\n",
    "proj/logo.png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13],
    "proj/.DS_Store": [0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31],
    "__MACOSX/proj/._main.py": [0, 5, 22, 7, 0],
  });
  const paths = () => page.evaluate(() => [...document.querySelectorAll("#files .row.file")].map((b) => b.dataset.path).sort());
  const editorText = (path) => page.evaluate((p) => window.__pad.text(p) ?? null, path);
  const upload = async (file) => {
    const chooser = page.waitForEvent("filechooser");
    await page.locator('#files button[aria-label="Upload a zip"]').click();
    await (await chooser).setFiles(file);
  };
  const confirmShown = () => page.waitForSelector("dialog.modal-confirm[open]", { timeout: 5000 }).then(() => true, () => false);
  await open("main.py");
  const before = await editorText("main.py");
  await upload(proj);
  const asked = await confirmShown();
  const title = asked ? await page.locator("dialog.modal-confirm[open] h2").textContent() : "";
  if (asked) await page.locator("dialog.modal-confirm[open]").getByRole("button", { name: "Cancel" }).click();
  await wait(500);
  expect("a zip that would replace a changed file asks first, and Cancel leaves everything as it was",
    asked && /Replace main\.py\?/.test(title) && (await editorText("main.py")) === before && !(await paths()).includes("src/util.py"),
    `asked ${asked} "${title}", ${JSON.stringify(await paths())}`);

  await upload(proj);
  if (await confirmShown()) await page.locator("dialog.modal-confirm[open]").getByRole("button", { name: "Replace" }).click();
  await page.waitForFunction(() => /added 4 files/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 10_000 }).catch(() => {});
  const after = await paths();
  expect("its files come in without the folder that wrapped them, the image too, and the junk left out",
    ["main.py", "naïve.txt", "src/util.py", "logo.png"].every((p) => after.includes(p)) && !after.some((p) => /proj|DS_Store|MACOSX/.test(p))
      && (await page.locator('#files .row.file[data-path="logo.png"]').getAttribute("class")).includes("binary"),
    JSON.stringify(after));
  expect("Replace replaces", (await editorText("main.py")) === "print('from the zip')\n", JSON.stringify(await editorText("main.py")));
  expect("the status says what came in", /added 4 files from proj\.zip$/.test(await status()), `"${await status()}"`);
  await clear();
  await typed("cat src/util.py naïve.txt");
  expect("they are in the terminal's folder too", (await shows(/return 42/)) && (await shows(/café/)), await tail());

  // Dropped on the file list, as from a file manager.
  const dropped = zipOf("more.zip", { "docs/readme.md": "# hi\n", "todo.txt": "later\n" });
  const bytes = [...(await readFile(dropped))];
  await page.evaluate((b) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(b)], "more.zip", { type: "application/zip" }));
    const files = document.querySelector("#files");
    files.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
    files.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, bytes);
  const landed = await page.waitForFunction(() => [...document.querySelectorAll("#files .row.file")].some((b) => b.dataset.path === "docs/readme.md"), null, { timeout: 10_000 }).then(() => true, () => false);
  expect("a zip dropped on the file list comes in, asking nothing when it replaces nothing", landed && !(await page.$("dialog.modal-confirm[open]")), JSON.stringify(await paths()));
  const notZip = await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "hello.txt", { type: "text/plain" }));
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data });
    document.querySelector("#files").dispatchEvent(drop);
    return drop.defaultPrevented;
  });
  expect("anything else dropped there is refused, not opened in place of the pad", notZip && /drop a \.zip/.test(await status()), `"${await status()}"`);

  await writeFile(join(zips, "fake.zip"), "not a zip at all");
  await upload(join(zips, "fake.zip"));
  await wait(500);
  expect("a file that is not a zip says so", /not a zip/.test(await status()), `"${await status()}"`);

  const got = async (click) => {
    const download = page.waitForEvent("download", { timeout: 10_000 });
    await click();
    const d = await download;
    const to = join(zips, `got-${d.suggestedFilename()}`);
    await d.saveAs(to);
    return { name: d.suggestedFilename(), to };
  };
  const padName = new URL(page.url()).pathname.slice(1);
  // An empty folder, so the round trip below has one to bring back.
  await page.locator('#files button[aria-label="New folder"]').click();
  await nameInTree("/kept-in-zip");
  // Stored, not only drawn: the zip is the stored pad, and against a
  // deployment the store takes a moment longer than the tree does.
  await page.waitForFunction(() => /made kept-in-zip/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 10_000 }).catch(() => {});
  await page.waitForSelector('#files .row.dir[data-path="kept-in-zip"]', { timeout: 5000 });
  const whole = await got(() => page.locator('#files button[aria-label="Download as zip"]').click());
  const all = unzip(whole.to);
  const inPad = (p) => all.files[`${padName}/${p}`];
  expect("Download as zip is the whole pad, in a folder named after it, and a zip anything can read",
    whole.name === `${padName}.zip` && all.bad === null && inPad("src/util.py") === "def f():\n    return 42\n" && inPad("naïve.txt") === "café\n" && inPad("docs/readme.md") === "# hi\n" && inPad("page.html") !== undefined && Object.keys(all.files).every((p) => p.startsWith(`${padName}/`)),
    `${whole.name}: ${JSON.stringify(Object.keys(all.files))}`);
  expect("and its image byte for byte", inPad("logo.png")?.hex === "89504e470d0a1a0a0000000d", JSON.stringify(inPad("logo.png")));
  expect("and an empty folder, as its marker", inPad("kept-in-zip/.keep") === "", JSON.stringify(Object.keys(all.files).filter((p) => p.includes("kept"))));
  await page.hover('#files .dir-row:has(.row.dir:text-is("src"))');
  const folder = await got(() => page.locator('#files button[aria-label="Download src as a zip"]').click());
  const one = unzip(folder.to);
  expect("a folder downloads as a zip of that folder", folder.name === "src.zip" && JSON.stringify(Object.keys(one.files)) === '["src/util.py"]', `${folder.name}: ${JSON.stringify(one)}`);
  await page.hover('#files .file-row:has(.row.file[data-path="naïve.txt"])');
  const single = await got(() => page.locator('#files button[aria-label="Download naïve.txt"]').click());
  expect("a file downloads as itself", single.name === "naïve.txt" && (await readFile(single.to, "utf8")) === "café\n", `${single.name}`);

  // A new pad's starter makes way for a zip, rather than sitting beside it.
  const fresh = await context.newPage();
  fresh.on("pageerror", (e) => pageErrors.push(`zips (a new pad): ${e.message}`));
  await fresh.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await fresh.waitForFunction(() => window.__pad && document.querySelector('#files .row.file[data-path="main.py"]'), null, { timeout: 60_000 });
  const freshChooser = fresh.waitForEvent("filechooser");
  await fresh.locator('#files button[aria-label="Upload a zip"]').click();
  await (await freshChooser).setFiles(dropped);
  const replaced = await fresh.waitForFunction(() => {
    const files = [...document.querySelectorAll("#files .row.file")].map((b) => b.dataset.path);
    return files.sort().join() === "docs/readme.md,todo.txt";
  }, null, { timeout: 10_000 }).then(() => true, () => false);
  expect("on a new pad the untouched starter goes, and nothing is asked",
    replaced && !(await fresh.$("dialog.modal-confirm[open]")),
    JSON.stringify(await fresh.evaluate(() => [...document.querySelectorAll("#files .row.file")].map((b) => b.dataset.path))));
  // What Download as zip made goes back in with every file where it was.
  const original = await paths();
  const againChooser = fresh.waitForEvent("filechooser");
  await fresh.locator('#files button[aria-label="Upload a zip"]').click();
  await (await againChooser).setFiles(whole.to);
  const roundTrip = await fresh.waitForFunction((want) => [...document.querySelectorAll("#files .row.file")].map((b) => b.dataset.path).sort().join() === want, original.join(), { timeout: 10_000 }).then(() => true, () => false);
  const freshDirs = await fresh.evaluate(() => [...document.querySelectorAll("#files .row.dir")].map((b) => b.dataset.path));
  expect("a pad's own zip, uploaded into another, puts each file back where it was, empty folders too",
    roundTrip && freshDirs.includes("kept-in-zip") && (await fresh.evaluate(() => window.__pad.text("src/util.py"))) === "def f():\n    return 42\n",
    JSON.stringify(await fresh.evaluate(() => [...document.querySelectorAll("#files .row.file")].map((b) => b.dataset.path).sort())));
  await fresh.close();
  await rm(zips, { recursive: true, force: true });

  // ---- a binary file a command makes ----
  // Read back as text until 5 October, which replaced what was not UTF-8: an
  // image or a zip made in the terminal reached the store, and everyone else,
  // garbled. Now it goes as its bytes, shows in the tree, and downloads whole.
  section = "binary output";
  const binPuts = [];
  const onBinPut = (r) => { if (r.method() === "PUT" && r.url().includes("/api/pad/")) binPuts.push(JSON.parse(r.postData() ?? "{}").writes ?? []); };
  page.on("request", onBinPut);
  await clear();
  await typed("printf 'text\\n' > t.txt; printf '\\x89PNG\\r\\n\\x1a\\n\\x00\\x00\\xff\\xfe' > b.png; zip z.zip t.txt");
  const binaryRows = await page.waitForFunction(() => ["b.png", "z.zip"].every((p) => document.querySelector(`#files .row.file.binary[data-path="${p}"]`)), null, { timeout: 15_000 }).then(() => true, () => false);
  const sentPng = binPuts.flat().find((c) => c.path === "b.png");
  const pngHex = sentPng?.encoding === "base64" ? Buffer.from(sentPng.content, "base64").toString("hex") : JSON.stringify(sentPng);
  expect("a binary file a command makes is in the tree as one, and sent as its bytes", binaryRows && pngHex === "89504e470d0a1a0a0000fffe", pngHex);
  await page.locator('#files .row.file[data-path="b.png"]').click();
  // An image by name, and not by its bytes: the viewer says so and leaves
  // the editor, rather than putting a broken picture or garbage on screen.
  const notShown = await page.waitForFunction(() => /b\.png is not (text|an image)/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 5000 }).then(() => true, () => false);
  expect("clicking it says it cannot be shown, rather than opening garbage", notShown && (await page.locator("#editor").isVisible()), `"${await status()}"`);
  await page.hover('#files .file-row:has(.row.file[data-path="b.png"])');
  const gotPng = await got(() => page.locator('#files button[aria-label="Download b.png"]').click());
  expect("and downloads byte for byte", (await readFile(gotPng.to)).toString("hex") === "89504e470d0a1a0a0000fffe", (await readFile(gotPng.to)).toString("hex"));
  await page.hover('#files .file-row:has(.row.file[data-path="z.zip"])');
  const gotZip = await got(() => page.locator('#files button[aria-label="Download z.zip"]').click());
  const madeZip = unzip(gotZip.to);
  expect("a zip made in the terminal downloads as a zip that opens", madeZip.bad === null && madeZip.files["t.txt"] === "text\n", JSON.stringify(madeZip));
  binPuts.length = 0;
  await page.locator('#files .row.file[data-path="z.zip"]').dragTo(page.locator('#files .row.dir[data-path="src"]'));
  const movedZip = await page.waitForFunction(() => document.querySelector('#files .row.file.binary[data-path="src/z.zip"]') && !document.querySelector('#files .row.file[data-path="z.zip"]'), null, { timeout: 10_000 }).then(() => true, () => false);
  const movedSent = binPuts.flat().find((c) => c.path === "src/z.zip");
  expect("and moves like any file, still as its bytes", movedZip && movedSent?.encoding === "base64" && Buffer.from(movedSent.content, "base64").subarray(0, 2).toString() === "PK", JSON.stringify(movedSent?.encoding));
  page.off("request", onBinPut);

  // ---- moving in the tree ----
  // Dragged as in an editor's file explorer, and by F2 for the keyboard. One
  // store write each: the new path and the old one's removal together.
  section = "moving in the tree";
  const puts = [];
  const onPut = (r) => { if (r.method() === "PUT" && r.url().includes("/api/pad/")) puts.push(JSON.parse(r.postData() ?? "{}").writes ?? []); };
  page.on("request", onPut);
  const row = (path, dir = false) => page.locator(`#files .row.${dir ? "dir" : "file"}[data-path="${path}"]`);
  const treeHas = (want, without = []) => page.waitForFunction(([w, wo]) => {
    const have = [...document.querySelectorAll("#files .row.file")].map((b) => b.dataset.path);
    return w.every((p) => have.includes(p)) && wo.every((p) => !have.includes(p));
  }, [want, without], { timeout: 10_000 }).then(() => true, () => false);

  puts.length = 0;
  await row("todo.txt").dragTo(row("src", true));
  const intoFolder = await treeHas(["src/todo.txt"], ["todo.txt"]);
  const oneWrite = puts.some((w) => w.some((c) => c.path === "src/todo.txt" && c.content === "later\n") && w.some((c) => c.path === "todo.txt" && c.content === null));
  await clear();
  await typed("cat src/todo.txt; ls todo.txt 2>&1 | tail -1");
  expect("a file dragged onto a folder moves into it — the store in one write, and the sandbox too",
    intoFolder && oneWrite && (await shows(/later/)) && (await shows(/No such file/)), `${JSON.stringify(puts)} | ${await tail(3)}`);

  await row("src/todo.txt").dragTo(row("main.py"));
  expect("dropped on a file, it goes beside that file — back at the top", await treeHas(["todo.txt"], ["src/todo.txt"]), JSON.stringify(await paths()));

  await open("util.py");
  await row("src", true).dragTo(row("docs", true));
  const folderMoved = await treeHas(["docs/src/util.py"], ["src/util.py"]);
  const followed = await page.evaluate(() => window.__pad.active());
  expect("a folder moves with everything in it, and the open file follows it",
    folderMoved && followed === "docs/src/util.py" && (await editorText("docs/src/util.py")) === "def f():\n    return 42\n", `${followed} ${JSON.stringify(await paths())}`);

  // A folder merged into the folder it is in: a path that leaves is one
  // another arrives at, and the deletion used to win (audit DC-02).
  await clear();
  await typed("mkdir -p mv/mv/mv && printf first > mv/mv/x.txt && printf second > mv/mv/mv/x.txt");
  await treeHas(["mv/mv/x.txt", "mv/mv/mv/x.txt"]);
  // Dragged beside a file at the top, as the audit did: F2 refuses a name a
  // folder has, and the drag merges into it.
  if (!((await row("mv", true).getAttribute("class")) ?? "").includes("open")) await row("mv", true).click();
  await row("mv/mv", true).dragTo(row("main.py"));
  const merged = await treeHas(["mv/x.txt", "mv/mv/x.txt"], ["mv/mv/mv/x.txt"]);
  await clear();
  await typed("cat mv/x.txt; echo; cat mv/mv/x.txt; echo");
  const mergedKept = merged && (await shows(/first\s*\n\s*second/)) && (await editorText("mv/mv/x.txt").catch(() => null)) !== null;
  const stored = puts.flat().filter((c) => c.path === "mv/mv/x.txt").map((c) => c.content);
  expect("a folder moved into the folder it is in keeps every file — none deleted after it arrived", mergedKept && !stored.includes(null), `${JSON.stringify(await paths())} | ${JSON.stringify(stored)} | ${await tail(3)}`);
  await typed("rm -r mv");

  const treeBefore = JSON.stringify(await paths());
  await row("docs", true).dragTo(row("docs/src/util.py"));
  await wait(500);
  expect("a folder cannot be dropped into itself", JSON.stringify(await paths()) === treeBefore, JSON.stringify(await paths()));

  await renameInTree("naïve.txt", "notes/renamed.txt");
  expect("F2 renames in place, and a / in the name moves it into a folder — the keyboard's way to do it", await treeHas(["notes/renamed.txt"], ["naïve.txt"]), JSON.stringify(await paths()));

  // A name that is taken is said under the name as it is typed, and Enter
  // does not take it; Escape leaves both as they were.
  await renameInTree("todo.txt", "docs/readme.md");
  const problem = await page.locator("#files .name-problem").textContent({ timeout: 3000 }).catch(() => "");
  const stillNaming = await page.locator("#files input.name-input").isVisible();
  await page.keyboard.press("Escape");
  await wait(300);
  expect("renamed to a name that is taken, it says so under the name, and Escape keeps both",
    problem === "there is already a file called docs/readme.md" && stillNaming && (await paths()).includes("todo.txt") && (await editorText("docs/readme.md")) === "# hi\n",
    `"${problem}", naming ${stillNaming}, ${JSON.stringify(await paths())}`);

  // A drag onto a folder with a file of that name asks instead. Dropped by
  // its events rather than the mouse: with this many rows the tree scrolls to
  // show the folder, and the mouse's drag then began on the row above.
  const dropOn = async (from, to) => {
    const carried = await page.evaluateHandle(() => new DataTransfer());
    await from.dispatchEvent("dragstart", { dataTransfer: carried });
    await to.dispatchEvent("dragover", { dataTransfer: carried });
    await to.dispatchEvent("drop", { dataTransfer: carried });
    await from.dispatchEvent("dragend", { dataTransfer: carried });
  };
  await renameInTree("todo.txt", "readme.md");
  await treeHas(["readme.md"], ["todo.txt"]);
  await page.waitForFunction(() => /moved todo\.txt/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 10_000 }).catch(() => {});
  const renamedStatus = await page.locator("#status").textContent();
  await dropOn(row("readme.md"), row("docs", true));
  const asksFirst = await confirmShown();
  const dragStatus = await page.locator("#status").textContent();
  if (asksFirst) await page.locator("dialog.modal-confirm[open]").getByRole("button", { name: "Cancel" }).click();
  await wait(400);
  const keptBoth = (await paths()).includes("readme.md") && (await editorText("docs/readme.md")) === "# hi\n";
  if (keptBoth) {
    await dropOn(row("readme.md"), row("docs", true));
    if (await confirmShown()) await page.locator("dialog.modal-confirm[open]").getByRole("button", { name: "Replace" }).click();
  }
  const replacedIt = (await treeHas(["docs/readme.md"], ["readme.md"])) && (await editorText("docs/readme.md")) === "later\n";
  expect("moving onto a file that is there asks first; Cancel keeps both, Replace replaces", asksFirst && keptBoth && replacedIt, `asked ${asksFirst}, kept ${keptBoth}, replaced ${replacedIt}; "${renamedStatus}", then "${dragStatus}"; ${JSON.stringify(await paths())}`);

  await open("helper.py");
  await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.focus();
    ed.setPosition(ed.getModel().getPositionAt(ed.getModel().getValueLength()));
  });
  await page.keyboard.type("# typed-just-before-moving");
  await row("helper.py").dragTo(row("docs", true));
  await treeHas(["docs/helper.py"], ["helper.py"]);
  expect("typing not yet saved goes with the file", (await editorText("docs/helper.py"))?.includes("# typed-just-before-moving"), JSON.stringify((await editorText("docs/helper.py"))?.slice(-60)));
  // And typing while the move is on its way to the store. The text was taken
  // before the write, and what came after went with the old file's document.
  const slowly = async (route) => {
    if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  };
  await page.route("**/api/pad/**", slowly);
  await wait(800);
  await renameInTree("docs/helper.py", "/helper.py");
  await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.focus();
    ed.setPosition(ed.getModel().getPositionAt(ed.getModel().getValueLength()));
  });
  await page.keyboard.type("# typed-while-moving");
  await treeHas(["helper.py"], ["docs/helper.py"]);
  await wait(400);
  await page.unroute("**/api/pad/**", slowly);
  expect("and so does typing while the move is being saved", (await editorText("helper.py"))?.includes("# typed-while-moving"), JSON.stringify((await editorText("helper.py"))?.slice(-60)));
  page.off("request", onPut);

  // ---- a language on first use ----
  // Fetched the first time a line names it, not on every visit, and run in a
  // fresh shell — a package installed into a running sandbox is not seen by
  // the shell already open. Common Lisp, because it is 4 MB; C, Go, Node and
  // PHP go the same way.
  section = "languages";
  await clear();
  await typed("mkdir -p lang && cd lang && export KEPT=kept");
  await clear();
  await typed('repl --version | head -1; pwd; echo "is $KEPT"', 240_000);
  expect("a language a line names is fetched first, and the terminal says so", await shows(/fetching Common Lisp \(clisp\) for this pad/), await tail(6));
  expect("and the line then runs with it", await shows(/GNU CLISP/), await tail(6));
  expect(
    "in a fresh shell, where the last one was and with what it exported",
    (await shows(/\/workspace\/lang/)) && (await shows(/is kept/)),
    await tail(6),
  );
  await clear();
  await typed("repl --version | head -1", 60_000);
  const again = await tail(6);
  expect("and the next time it is there already", (await shows(/GNU CLISP/)) && !again.includes("fetching"), again);
  await typed("cd /workspace");

  // Every language, through Run — opt in: several hundred MB on a first use,
  // too much for every CI run, and what a deploy is checked with.
  //   PAD_LANGUAGES=1 node pad/scripts/user-check.mjs
  if (process.env.PAD_LANGUAGES) {
    for (const [file, source, want] of [
      ["hello.c", '#include <stdio.h>\nint main(){ printf("c says %d\\n", 6*7); return 0; }\n', /c says 42/],
      ["hello.cpp", '#include <cstdio>\nint main(){ auto f = [](int a){ return a * 2; }; std::printf("cpp says %d\\n", f(21)); }\n', /cpp says 42/],
      ["hello.js", "console.log('js says', 6 * 7);\n", /js says 42/],
      ["hello.php", "<?php echo 'php says ' . (6 * 7) . PHP_EOL;\n", /php says 42/],
      ["hello.go", 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("go says", 6*7) }\n', /go says 42/],
      ["Hello.java", 'public class Hello {\n  public static void main(String[] args) {\n    System.out.println("java says " + 6 * 7);\n  }\n}\n', /java says 42/],
    ]) {
      await clear();
      await newFile(file, source);
      await page.click("#run");
      await wait(300);
      const done = await idle(600_000);
      expect(`Run on ${file} fetches its language the first time and runs it`, done && (await shows(want, 5000)), await tail(6));
    }
    // Each language's starter, as an empty file offers it, runs as it is.
    for (const file of ["starter.c", "starter.cpp", "starter.js", "starter.php", "starter.go", "Starter.java"]) {
      await clear();
      await newFile(file, "");
      await page.locator(".starter-hint button").click();
      await page.click("#run");
      await wait(300);
      const done = await idle(300_000);
      expect(`${file}'s starter runs as it is`, done && (await shows(/Hello, world!/, 5000)) && (await shows(/3 squared is 9/, 5000)), await tail(6));
    }
    await clear();
    await open("hello.go");
    await page.click("#run");
    await wait(300);
    expect("and runs it again, with nothing fetched", (await idle(120_000)) && (await shows(/go says 42/, 5000)) && !(await tail(6)).includes("fetching"), await tail(6));
    // Java from the terminal: javac, then the class, reading what it is given.
    await clear();
    await newFile("Ask.java", 'import java.util.Scanner;\n\npublic class Ask {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int n = in.nextInt();\n    System.out.println("twice " + n + " is " + 2 * n);\n  }\n}\n');
    // The page's javac answers it: tenths of a second where the sandbox's own
    // takes several (pad/src/javac/).
    const compiling = Date.now();
    await typed("javac Ask.java", 300_000);
    const compiled = Date.now() - compiling;
    expect("javac compiles quickly, with the page's compiler", compiled < 3000 && !(await tail(6)).includes("error"), `${compiled} ms: ${await tail(4)}`);
    await typed("printf '21\\n' | java Ask", 120_000);
    expect("and java runs the class, reading stdin", await shows(/twice 21 is 42/, 5000), await tail(6));
    // C++ with its standard library — ours, ajar/cxx: the registry's clang
    // ran out of stack on <vector> and <iostream> (review of 17 October, H3).
    // Reading stdin, and try and catch, which are WebAssembly's.
    await clear();
    await newFile("stl.cpp", [
      "#include <algorithm>", "#include <iostream>", "#include <map>", "#include <stdexcept>", "#include <string>", "#include <vector>",
      "int main() {",
      "  std::vector<int> v{5, 3, 9, 1};",
      "  std::sort(v.begin(), v.end());",
      '  std::map<std::string, int> m{{"a", 1}, {"b", 2}};',
      "  std::string name;",
      "  std::getline(std::cin, name);",
      '  std::cout << "hello " << name << ", smallest " << v.front() << ", b=" << m["b"] << std::endl;',
      '  try { v.at(10); } catch (const std::out_of_range &e) { std::cout << "caught " << e.what() << std::endl; }',
      '  if (name == "throw") throw std::runtime_error("boom");',
      "}", "",
    ].join("\n"));
    await typed("echo Rishi > in.txt", 30_000);
    await typed("g++ stl.cpp -o stl && ./stl < in.txt", 600_000);
    expect("C++'s standard library compiles and runs, reading stdin, and catch catches", (await shows(/hello Rishi, smallest 1, b=2/, 5000)) && (await shows(/caught vector/, 5000)), await tail(8));
    await typed("echo throw > in.txt; ./stl < in.txt", 60_000);
    expect("and an exception nothing catches is said, as a native program says it", (await shows(/terminate called after throwing an instance of 'std::runtime_error'/, 5000)) && (await shows(/what\(\): +boom/, 5000)), await tail(6));
    await typed("rm -f stl in.txt", 30_000);
    await open("main.py");
  }

  // ---- keys ----
  section = "keys";
  await page.evaluate(() => {
    window.__saved = null;
    addEventListener("keydown", (e) => { if (e.key === "s") setTimeout(() => { window.__saved = e.defaultPrevented; }, 0); });
  });
  await page.locator(".monaco-editor textarea").first().focus();
  await page.keyboard.press("Control+s");
  await wait(200);
  expect("ctrl-s is not the browser's Save page dialog", (await page.evaluate(() => window.__saved)) === true, `status "${await status()}"`);

  // ---- a pad of many files ----
  // A model per file, and Monaco called more than 200 of them a leak, thrown
  // as a page error — `pip install flask` makes 187. The page errors check at
  // the end is what catches it. Since 18 October a file has a model only
  // once the editor needs it (texts.ts), so files a command makes are text.
  section = "many files";
  await clear();
  const modelsBefore = await page.evaluate(() => window.monaco.editor.getModels().length);
  await typed("mkdir -p many && for i in $(seq 1 260); do echo \"x = $i\" > many/f$i.py; done; echo made", 60_000);
  const manyShown = await page.waitForSelector('#files .row.dir[data-path="many"]', { timeout: 15_000 }).then(() => true, () => false);
  await wait(1500);
  const modelsAfter = await page.evaluate(() => window.monaco.editor.getModels().length);
  await typed("rm -rf many", 30_000);
  expect("a pad of 260 more files comes in, as text and not 260 more editor models", manyShown && modelsAfter === modelsBefore, `${modelsBefore} models before, ${modelsAfter} after`);
  // And a pad that has 500 files as it opens, which made 500 models before
  // anything could be used, and warned of a leak past 200. Each unopened
  // file's text was its model's, which converts line endings and sets a
  // byte-order mark aside: the sandbox got that, and the first command
  // saved it for everyone. A stub's pad, so here only.
  if (!LIVE) {
    const big = await context.newPage();
    const leaks = [];
    big.on("console", (m) => { if (/listener LEAK/.test(m.text())) leaks.push(m.text()); });
    big.on("pageerror", (e) => pageErrors.push(`${section}, 500 files: ${e.message}`));
    const t0 = Date.now();
    await big.goto(`${ORIGIN}/${MANY}`);
    await big.waitForFunction(() => window.__pad && window.monaco?.editor.getEditors()[0]?.getModel(), null, { timeout: 60_000 });
    const opened = {
      ...(await big.evaluate(() => ({
        active: window.__pad.active(),
        models: window.monaco.editor.getModels().length,
        rows: document.querySelectorAll("#files .row.file").length,
      }))),
      ms: Date.now() - t0,
      leaks: leaks.length,
    };
    expect("a pad of 500 files opens with one editor model, the open file's, and no leak warning", opened.active === "main.py" && opened.models === 1 && opened.rows === 500 && opened.leaks === 0, JSON.stringify(opened));
    const deep = "src/m3/f170.py";
    await big.locator(`#files .row.file[data-path="${deep}"]`).click();
    const shown = await big.waitForFunction((p) => window.__pad.active() === p && window.monaco.editor.getEditors()[0].getValue(), deep, { timeout: 10_000 }).then((h) => h.jsonValue(), () => null);
    const models = await big.evaluate(() => window.monaco.editor.getModels().length);
    expect("…a file opened from the tree gets its model then, with its text", shown === manyFiles[deep] && models === 2, `${models} models, shows ${JSON.stringify(shown)}`);
    // Byte for byte in the sandbox, compared by python: the mark, both line
    // endings, and the file that was opened.
    await big.click("#terminal");
    const asPython = (text) => `'${text.replace(/\n/g, "\\n")}'`;
    await big.keyboard.type(`python3 -c "print('kept', open('bom.csv','rb').read() == b'\\xef\\xbb\\xbfname,qty\\n', open('mixed.txt','rb').read() == b'one\\r\\ntwo\\nthree\\r\\n', open('${deep}').read() == ${asPython(manyFiles[deep])})"`);
    await big.keyboard.press("Enter");
    const kept = await big
      .waitForFunction(() => /kept (True|False) (True|False) (True|False)/.exec((document.querySelector("#terminal .xterm-rows")?.innerText ?? "").replace(/\n/g, ""))?.[0] ?? null, null, { timeout: 240_000 })
      .then((h) => h.jsonValue(), () => null);
    await big.waitForFunction(() => window.__pad.shellBusy() === false, null, { timeout: 30_000 }).catch(() => {});
    await big.waitForTimeout(1500);
    const rewritten = manySaved.filter((p) => p in manyFiles);
    expect("…files nobody opened are in the sandbox as stored, mark and line endings and all, and the command saves none of them", kept === "kept True True True" && rewritten.length === 0, `${kept}; saved ${JSON.stringify(rewritten.slice(0, 5))}`);
    await big.close();
  }

  // ---- http through the browser ----
  // The sandbox's own sockets reach PyPI alone. curl, wget and python's
  // urllib hand their requests to the page, which makes them with fetch.
  section = "http through the browser";
  await clear();
  await typed(`curl -s "${BIN}/anything?x=1" | grep '"x"'`, 30_000);
  expect("curl fetches a site that lets web pages read it", await shows(/"x": "1"/), await tail(6));
  await clear();
  await typed(`curl -s -X POST -H "Content-Type: application/json" -d '{"a":1}' ${BIN}/anything | grep -E '"(method|a)"'`, 30_000);
  expect("and posts JSON to it, with its own headers", (await shows(/"method": "POST"/)) && (await shows(/"a": 1/)), await tail(4));
  await clear();
  await typed(`curl -s -o got.json ${BIN}/anything && grep -c method got.json`, 30_000);
  const gotInTree = await page.waitForSelector('#files .row.file[data-path="got.json"]', { timeout: 10_000 }).then(() => true, () => false);
  expect("-o writes what it fetched into the folder, where the tree shows it", gotInTree && (await shows(/(^|\n)1\s*(\n|$)/)), await tail(3));
  await clear();
  await typed(`curl -s -o /dev/null -w '%{http_code}\\n' ${BIN}/status/404; curl -sf ${BIN}/status/404; echo "exit $?"`, 30_000);
  expect("-w says the status, and -f exits 22 for one over 400", (await shows(/(^|\n)404\s*(\n|$)/)) && (await shows(/exit 22/)), await tail(3));
  await clear();
  await typed(`curl -sS ${CLOSED}; echo "exit $?"`, 30_000);
  expect("a site that does not let web pages read it is refused in words, not a hang", (await shows(/CORS/)) && (await shows(/exit 7/)), await tail(4));
  await clear();
  await typed(`curl -s ${BIN}/redirect/1 | grep '"url"'`, 30_000);
  expect("a redirect is followed", await shows(/\/get/), await tail(3));
  await clear();
  await typed(`python -c "import urllib.request, json; print('args', json.load(urllib.request.urlopen('${BIN}/anything?via=urllib'))['args'])"`, 30_000);
  expect("python's urllib goes through the page too", await shows(/args \{'via': 'urllib'\}/), await tail(3));
  await clear();
  await typed(`wget -q -O w.json "${BIN}/anything?w=1" && grep -c '"w"' w.json`, 30_000);
  expect("and so does wget", await shows(/(^|\n)1\s*(\n|$)/), await tail(3));

  // ---- requirements.txt, installed before Python runs ----
  // Live, a real install and an import of it. Here pip has no network, so the
  // failure: said, the program run anyway, and not tried again until the
  // file changes.
  section = "requirements.txt";
  await open("main.py");
  await clear();
  const wanted = LIVE ? "idna" : "no-such-package-for-the-pad";
  await typed(`printf '# what this needs\\n${wanted}\\n' > requirements.txt`);
  await clear();
  await run(LIVE ? "import idna\nprint('idna', idna.encode('pad').decode())\n" : "print('ran anyway')\n", { ms: 180_000 });
  // Offline, pip's retries can scroll the note off the screen; the line
  // after a failed install is said only by the same code, so it is the proof.
  const reqNoted = (await shows(/requirements\.txt is here: installing it first/)) || (!LIVE && (await shows(/pip could not install .* from requirements\.txt/)));
  const reqRan = LIVE ? await shows(/idna pad/) : (await shows(/pip could not install .* from requirements\.txt/)) && (await shows(/ran anyway/));
  expect(LIVE ? "requirements.txt is installed before Run, and the program imports what it named" : "requirements.txt is installed before Run, and one that cannot be is said, and the program runs anyway", reqNoted && reqRan, await tail(4));
  await clear();
  await run("print('second run')\n", { ms: 60_000 });
  expect("and it is not installed again until it changes", (await shows(/second run/)) && !(await shows(/installing it first/, 500)), await tail(3));
  await typed("rm requirements.txt");
  await clear();

  // ---- what a command makes that the pad cannot keep, and what it can ----
  // One file the store refuses is named and left out; it no longer takes
  // everything else, then and after, with it (review of 17 October, M11).
  section = "unsaved";
  await clear();
  const fileRow = (path) => page.locator(`#files .row.file[data-path="${path}"]`);
  const savedInTree = (path) => fileRow(path).waitFor({ timeout: 20_000 }).then(() => true, () => false);
  await typed("printf x > 'out\\file.txt'; printf kept > kept-beside.txt");
  const besideKept = await savedInTree("kept-beside.txt");
  const named = (await status()).startsWith("not saved: out\\file.txt");
  await typed("printf later > made-later.txt");
  const laterKept = await savedInTree("made-later.txt");
  await typed("rm 'out\\file.txt'");
  await wait(800);
  const cleared = !(await status()).startsWith("not saved");
  expect("a file the pad cannot keep is named and left out, and the rest — then and after — is saved", besideKept && named && laterKept && cleared, `beside ${besideKept}, named ${named}, later ${laterKept}, cleared ${cleared}: ${await status()}`);
  await typed("rm kept-beside.txt made-later.txt");

  // A typed pip install goes into requirements.txt, which the pad keeps where
  // it cannot keep the packages: a stand-in pip, as there is no network here.
  await clear();
  await typed('pip() { echo "pretending to install $*"; }');
  await typed("pip install pad-fake-pkg==1.0");
  const recorded = await page.waitForFunction(() => /^pad-fake-pkg==1\.0$/m.test(window.__pad?.text("requirements.txt") ?? ""), null, { timeout: 15_000 }).then(() => true, () => false);
  const said = await shows(/added pad-fake-pkg==1\.0 to requirements\.txt/);
  await typed("pip install pad-fake-pkg==1.0");
  await wait(800);
  const once = ((await page.evaluate(() => window.__pad?.text("requirements.txt") ?? "")).match(/pad-fake-pkg/g) ?? []).length === 1;
  expect("a typed pip install is added to requirements.txt, once, and said", recorded && said && once, `${recorded} ${said} ${once}: ${JSON.stringify(await page.evaluate(() => window.__pad?.text("requirements.txt")))}`);
  await typed("unset -f pip; rm requirements.txt");

  // A program cannot end its own command by printing what looks like the
  // shell's end-of-command marker (M8).
  await clear();
  await typed("printf '\\001130\\001'; sleep 1; echo after-the-fake-marker", 20_000);
  const notEnded = (await shows(/after-the-fake-marker/)) && !(await rows()).some((l) => /^exit 130$/.test(l.trim()));
  expect("output that looks like the end of a command does not end it", notEnded, await tail(3));

  // Run takes a file's name as it is: a `$` in it is not expanded (R2).
  await newFile("dollar$HOME.py", "print('the dollar file ran')\n");
  await clear();
  await page.click("#run");
  await idle();
  expect("Run runs a file whose name has a $ in it", await shows(/the dollar file ran/), await tail(3));
  await typed("rm 'dollar$HOME.py'");
  await open("main.py");
  await clear();

  // ---- images, shown in place of the editor ----
  // A plot is a PNG `plt.show()` saves and names with an escape the
  // terminal takes (tools/sitecustomize.py); this makes the PNG by hand and
  // prints the same escape, then opens it from the tree as a person would.
  section = "images";
  const MAKE_PNG = [
    "import struct, zlib",
    "def chunk(kind, data):",
    "    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)",
    "rows = b''.join(b'\\x00' + b'\\xff\\x00\\x00' * 4 for _ in range(3))",
    "png = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 4, 3, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')",
    "open('dot.png', 'wb').write(png)",
    "print('png written')",
  ].join("\n");
  await clear();
  await typed(`echo ${Buffer.from(MAKE_PNG).toString("base64")} | base64 -d > mkpng.py && python mkpng.py && rm mkpng.py`);
  await typed("printf '\\033]7777;pad-image=/workspace/dot.png\\007'; echo asked");
  const shownByEscape = await page.waitForFunction(() => {
    const img = document.querySelector("#image-pane:not([hidden]) img");
    return img && img.naturalWidth === 4 && document.querySelector("#editor")?.hidden;
  }, null, { timeout: 15_000 }).then(() => true, () => false);
  // Not on screen apart from the command that printed it.
  const escapeHidden = (await rows()).filter((l) => !l.startsWith("$")).every((l) => !/7777|pad-image/.test(l));
  await page.click("#back-to-editor");
  const editorBack = await page.locator("#editor").isVisible() && await page.locator("#image-pane").isHidden();
  expect("an image a program names with the pad's escape shows in place of the editor, the escape itself unprinted, and Back to editor returns", shownByEscape && escapeHidden && editorBack, `escape ${shownByEscape}, unprinted ${escapeHidden}, back ${editorBack}`);
  await page.waitForSelector('#files .row.file[data-path="dot.png"]', { timeout: 20_000 }).catch(() => {});
  await page.click('#files .row.file[data-path="dot.png"]');
  const shownByTree = await page.waitForFunction(() => document.querySelector("#image-pane:not([hidden]) img")?.naturalWidth === 4, null, { timeout: 10_000 }).then(() => true, () => false);
  await open("main.py");
  const leftForText = await page.locator("#image-pane").isHidden() && await page.locator("#editor").isVisible();
  expect("and an image file opened from the tree shows too, until a text file is opened", shownByTree && leftForText, `tree ${shownByTree}, text again ${leftForText}`);
  await typed("rm dot.png");
  await clear();

  // ---- errors that point into the pad, and the last run ----
  // A traceback's file and line is a link in the terminal that opens it
  // there; the run's error is a squiggle on that line until the next run;
  // and what Run printed is kept for whoever opens the pad next.
  section = "errors";
  await newFile("errs/other.py", "x = 1\n");
  await newFile("errs/boom.py", "print('before')\n\ndef f():\n    return undefined_name\n\nf()\n");
  await clear();
  await run("print('before')\n\ndef f():\n    return undefined_name\n\nf()\n");
  const errMarks = () => page.evaluate(() => {
    const errModel = window.monaco.editor.getModels().find((m) => m.getValue().includes("undefined_name") && m.getValue().startsWith("print('before')"));
    return window.monaco.editor.getModelMarkers({ owner: "pad-run" }).map((m) => `${m.resource.toString() === errModel?.uri.toString() ? "boom.py" : m.resource.toString()}:${m.startLineNumber} ${m.message}`);
  });
  const errMarked = await errMarks();
  expect("a run's error is marked on the line it happened, with what it said", errMarked.length === 1 && errMarked[0] === "boom.py:4 NameError: name 'undefined_name' is not defined", JSON.stringify(errMarked));
  // The link: the frame's row, clicked where the path is, from another file.
  await open("other.py");
  const errSpot = await page.evaluate(() => {
    for (const row of document.querySelectorAll("#terminal .xterm-rows > div")) {
      const errText = row.textContent ?? "";
      const errAt = errText.indexOf('File "/workspace/errs/boom.py", line 4');
      if (errAt < 0) continue;
      const errWalker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = errWalker.nextNode(); node; node = errWalker.nextNode()) {
        const errLen = node.textContent.length;
        if (seen + errLen > errAt + 8) {
          const errRange = document.createRange();
          errRange.setStart(node, errAt + 8 - seen);
          errRange.setEnd(node, errAt + 9 - seen);
          const errR = errRange.getBoundingClientRect();
          return { x: errR.left + errR.width / 2, y: errR.top + errR.height / 2 };
        }
        seen += errLen;
      }
    }
    return null;
  });
  if (errSpot) {
    await page.mouse.move(errSpot.x, errSpot.y);
    await wait(300);
    await page.mouse.click(errSpot.x, errSpot.y);
    await wait(500);
  }
  const errLanded = await page.evaluate(() => ({ active: window.__pad.active(), line: window.monaco.editor.getEditors()[0].getPosition()?.lineNumber }));
  expect("and the traceback's file and line is a link that opens the file there", errSpot !== null && errLanded.active === "errs/boom.py" && errLanded.line === 4, `${JSON.stringify(errSpot)} ${JSON.stringify(errLanded)}`);
  await typed("ls > /dev/null");
  const errStayed = (await errMarks()).length;
  // The relay's, against a deployment; this server's otherwise.
  const errPad = new URL(page.url()).pathname;
  const errKept = LIVE ? await fetch(`${ORIGIN}/api${errPad.replace(/^\//, "/pad/")}/run`).then((r) => r.json()).catch(() => null) : lastRun;
  expect("a command that is not a run leaves the marks, and Run's output is kept as the pad's last run", errStayed === 1 && errKept?.path === "errs/boom.py" && errKept?.exit === 1 && errKept?.output.includes("NameError") && errKept?.output.includes("before") && !/\x1b\][^\x07]*\x07/.test(errKept?.output ?? ""), `${errStayed} ${JSON.stringify(errKept)}`);
  // Whoever opens the pad next sees it before running anything.
  const errNext = await context.newPage();
  await errNext.goto(`${ORIGIN}${errPad}`, { waitUntil: "domcontentloaded" });
  const errOpened = await errNext.waitForFunction(() => /the last run, [^:]+: python .*boom\.py['"]? · exit 1/.test(document.querySelector("#terminal .xterm-rows")?.textContent ?? "") && (document.querySelector("#terminal .xterm-rows")?.textContent ?? "").includes("NameError"), null, { timeout: 60_000 }).then(() => true, () => false);
  await errNext.close();
  expect("and a page opening the pad shows that run in its terminal before anything runs", errOpened, "");
  await open("boom.py");
  await run("print('fixed')\n");
  expect("the next run that has no errors takes the marks away", (await errMarks()).length === 0, JSON.stringify(await errMarks()));
  await typed("rm -r errs");
  await clear();

  // ---- Run pressed while the pad is still opening ----
  // The button is there from the first paint; until 18 October a click before
  // the pad had opened was dropped without a word (review N1). The pad's
  // read is held back here, so the click lands while it says "opening…".
  section = "run while opening";
  {
    const early = await context.newPage();
    await early.route(/\/api\/pad\/[^/]+$/, async (route) => {
      if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 1500));
      await route.continue().catch(() => {});
    });
    await early.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await early.locator("#run").waitFor({ timeout: 30_000 });
    const opening = await early.evaluate(() => document.getElementById("status")?.textContent ?? "");
    await early.locator("#run").click();
    const told = await early.evaluate(() => document.getElementById("status")?.textContent ?? "");
    const ran = await early.waitForFunction(() => /wrote 10 rows to out\.csv/.test(document.querySelector("#terminal .xterm-rows")?.textContent ?? ""), null, { timeout: 180_000 }).then(() => true, () => false);
    expect("Run pressed while the pad is opening is said, and runs once it is open", /opening/.test(opening) && /Run starts/.test(told) && ran, JSON.stringify({ opening, told, ran }));
    await early.close();
  }

  // ---- Run pressed before the page has its service worker ----
  // A first visit draws the workspace and then waits for the service worker
  // to install before the app that answers the button exists; a press in
  // that wait was lost without a word (review of 18 October, N1's
  // first-paint window). A browser of its own, with sw.js held back, so the
  // press lands in it.
  section = "run before the service worker";
  {
    const cold = await chromium.launch();
    const first = await (await cold.newContext()).newPage();
    await first.route(/\/sw\.js$/, async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue().catch(() => {});
    });
    await first.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await first.locator("#run").waitFor({ timeout: 30_000 });
    const before = await first.evaluate(() => !!window.__pad);
    await first.locator("#run").click();
    const told = await first.evaluate(() => document.getElementById("status")?.textContent ?? "");
    const ran = await first.waitForFunction(() => /wrote 10 rows to out\.csv/.test(document.querySelector("#terminal .xterm-rows")?.textContent ?? ""), null, { timeout: 240_000 }).then(() => true, () => false);
    expect("Run pressed before the app is there, on a first visit, is said and runs once the pad is open", !before && /Run starts/.test(told) && ran, JSON.stringify({ before, told, ran }));
    await cold.close();
  }

  // ---- the guide, at /help ----
  // "help" is kept for the site, and the page said it was no pad's address:
  // the guide, with F6 in it, was on no page (review of 18 October).
  section = "help";
  {
    const help = await context.newPage();
    await help.goto(`${ORIGIN}/help`, { waitUntil: "domcontentloaded" });
    const shown = await help.waitForSelector(".md-body h1", { timeout: 30_000 }).then(() => true, () => false);
    const text = shown ? await help.evaluate(() => document.querySelector(".md-body")?.textContent ?? "") : "";
    expect("/help is the guide, and it says F6 leaves the terminal", shown && text.includes("F6") && text.includes("Ctrl-Enter"), text.slice(0, 120));
    await help.close();
  }

  // ---- Markdown, formatted ----
  // Preview beside the source or over it, as it will look: GitHub's
  // Markdown, the editor's colours in its code, the pad's own pictures — and
  // nothing a file's HTML says that would run, submit or pose as the pad.
  section = "markdown";
  await clear();
  await typed(`echo ${Buffer.from(MAKE_PNG).toString("base64")} | base64 -d > mkpng.py && python mkpng.py && rm mkpng.py`);
  await newFile("mdguide/guide.md", `# Guide\n\n${"Filler.\n\n".repeat(40)}## Install\n\npip install it\n\n${"More.\n\n".repeat(40)}`);
  const NOTES = [
    "# Notes", "",
    "Some **bold** and `code`; the [install steps](mdguide/guide.md#install).", "",
    "- [x] done", "- [ ] not yet", "",
    "| fruit | count |", "|---|---:|", "| apples | 3 |", "| pears | 5 |", "",
    "```python", "def greet(name):", "    return f'hello {name}'  # hi", "```", "",
    "![a dot](dot.png)", "",
    "<script>window.__mdPwned = 1</script>",
    "<img src=x onerror=\"window.__mdPwned = 2\">",
    "<div class=\"modal-backdrop\" style=\"position:fixed;inset:0\" id=\"run\">over the pad</div>",
    "<a href=\"javascript:window.__mdPwned = 3\">a script link</a>",
    "<form action=\"https://example.com/\"><input name=q><button>go</button></form>", "",
  ].join("\n");
  await newFile("formatted.md", NOTES);
  const previewOffered = await page.locator("#markdown-view").isVisible();
  await page.click("#markdown-view");
  const formatted = await page.waitForFunction(() => document.querySelector("#markdown-pane:not([hidden]) .md-body h1")?.textContent === "Notes", null, { timeout: 15_000 }).then(() => true, () => false);
  // Its picture comes from the pad's own file; it loads, so give it a moment.
  await page.waitForFunction(() => document.querySelector("#markdown-pane img")?.naturalWidth === 4, null, { timeout: 10_000 }).catch(() => {});
  const md = await page.evaluate(() => {
    const pane = document.querySelector("#markdown-pane");
    return {
      cells: pane.querySelectorAll("table td").length,
      coloured: pane.querySelectorAll("pre.md-coloured span[class^='mtk']").length,
      boxes: [...pane.querySelectorAll("input")].map((i) => `${i.type} ${i.checked} ${i.disabled}`).join(", "),
      picture: pane.querySelector("img")?.naturalWidth ?? 0,
      pwned: window.__mdPwned ?? null,
      ran: pane.querySelectorAll("script, form, button, [style], [onerror]").length,
      classes: [...pane.querySelectorAll("[class]")].map((e) => e.className).filter((c) => !/^(md-|language-|mtk)/.test(c)),
      runButtons: document.querySelectorAll("#run").length,
      prefixed: !!pane.querySelector("#user-content-run"),
      scriptLinks: [...pane.querySelectorAll("a")].filter((a) => /^\s*javascript:/i.test(a.getAttribute("href") ?? "")).length,
    };
  });
  expect("a Markdown file is offered Preview, and formatted: a table, ticked boxes that cannot be ticked, its code in the editor's colours, a picture from the pad", previewOffered && formatted && md.cells === 4 && md.boxes === "checkbox true true, checkbox false true" && md.coloured > 0 && md.picture === 4, `${previewOffered} ${formatted} ${JSON.stringify(md)}`);
  expect("and its HTML runs nothing, submits nothing, and cannot pose as the pad — no style, no class of the pad's, its ids prefixed", md.pwned === null && md.ran === 0 && md.classes.length === 0 && md.runButtons === 1 && md.prefixed && md.scriptLinks === 0, JSON.stringify(md));
  await page.evaluate((c) => window.monaco.editor.getEditors()[0].setValue(c), `${NOTES}\n## Typed later\n`);
  const live = await page.waitForFunction(() => [...document.querySelectorAll("#markdown-pane h2")].some((h) => h.textContent === "Typed later"), null, { timeout: 5000 }).then(() => true, () => false);
  await page.click("#markdown-pane a[href='mdguide/guide.md#install']");
  const atHeading = await page.waitForFunction(() => {
    const pane = document.querySelector("#markdown-pane");
    const heading = pane?.querySelector("#md-install");
    return window.__pad.active() === "mdguide/guide.md" && heading && Math.abs(heading.getBoundingClientRect().top - pane.getBoundingClientRect().top) < 60;
  }, null, { timeout: 10_000 }).then(() => true, () => false);
  expect("it follows typing, and a link to another file's heading opens that file formatted, at the heading", live && atHeading, `live ${live}, at the heading ${atHeading} in ${await page.evaluate(() => window.__pad.active())}`);
  await page.keyboard.press("ControlOrMeta+Shift+V");
  const sourceAgain = await page.locator("#markdown-pane").isHidden() && await page.locator("#editor").isVisible();
  await open("main.py");
  const notOffered = await page.locator("#markdown-view").isHidden();
  expect("⇧⌘V puts the text back, and a file that is not Markdown is not offered Preview", sourceAgain && notOffered, `text ${sourceAgain}, main.py ${notOffered}`);
  await typed("rm -r formatted.md mdguide dot.png");
  await clear();

  // ---- the network (a deployment only) ----
  section = "the network (a deployment only)";
  if (LIVE) {
    // Back to a file Run can run. `idle` waits for the Run button as well as
    // the shell, and the deletion above left a .json open, whose Run stays
    // off: pip finished in seconds and this waited out its whole 150.
    await open("main.py");
    await clear();
    const t1 = Date.now();
    const installed = await typed("pip install requests", 150_000);
    const ms = Date.now() - t1;
    await typed(`python -c "import requests; print('requests', requests.__version__)"`);
    expect("pip install requests finishes, and it imports", installed && (await shows(/requests \d+\.\d+/)), `${ms} ms: ${await tail(3)}`);
    // pip keeps the sandbox's sockets — it has its own copy of requests — and
    // the requests a program imports goes through the page.
    await clear();
    await typed(`python -c "import requests; r = requests.get('${BIN}/anything?via=requests'); print('via', r.status_code, r.json()['args'])"`, 60_000);
    expect("and requests goes through the page", await shows(/via 200 \{'via': 'requests'\}/), await tail(3));

    // Flask, as people write it: debug mode, whose reloader wants a thread,
    // and `flask run`, whose script pip puts where the shell does not look.
    await clear();
    const flaskIn = await typed("pip install flask", 150_000);
    const flaskApp = "from flask import Flask\napp = Flask(__name__)\n@app.route('/')\ndef home():\n    return 'hello from flask'\nif __name__ == '__main__':\n    app.run(debug=True, port=5050)\n";
    await typed(`echo ${Buffer.from(flaskApp).toString("base64")} | base64 -d > flaskapp.py`);
    await clear();
    await type("python flaskapp.py");
    const debugServes = await shows(/Running on http:\/\/127\.0\.0\.1:5050/, 60_000);
    const reloaderSaid = await shows(/Reloader: off in the pad/);
    const debugTail = await tail(5);
    await page.keyboard.press("Control+C");
    await idle(20_000);
    expect("pip install flask, and app.run(debug=True) serves, without the reloader and saying so", flaskIn && debugServes && reloaderSaid, debugTail);
    await clear();
    await type("flask --app flaskapp run --port 5051");
    const cliServes = await shows(/Running on http:\/\/127\.0\.0\.1:5051/, 60_000);
    const cliTail = await tail(4);
    await page.keyboard.press("Control+C");
    await idle(20_000);
    expect("and `flask run` works as typed", cliServes, cliTail);
    await clear();
    await typed("ls -a | grep -c '^~$'; echo listed");
    const noHome = (await shows(/(^|\n)0\s*(\n|$)/)) && !(await page.$('#files .row.dir[data-path="~"]'));
    expect("and pip leaves no `~` folder in the pad", noHome, await tail(3));

    // numpy, pandas and matplotlib, from Wasmer's index of packages built for
    // this runtime, and a plot shown over the editor by plt.show().
    await clear();
    const t2 = Date.now();
    const scienceIn = await typed("pip install numpy pandas matplotlib", 300_000);
    const scienceMs = Date.now() - t2;
    await clear();
    await run("import numpy as np\nimport pandas as pd\nimport matplotlib.pyplot as plt\nframe = pd.DataFrame({'x': np.arange(5), 'y': np.arange(5) ** 2})\nprint('sum', int(frame.y.sum()))\nplt.plot(frame.x, frame.y)\nplt.show()\n", { ms: 180_000 });
    const plotted = await page.waitForFunction(() => (document.querySelector("#image-pane:not([hidden]) img")?.naturalWidth ?? 0) > 100, null, { timeout: 30_000 }).then(() => true, () => false);
    expect("pip install numpy pandas matplotlib, and plt.show() puts the plot over the editor", scienceIn && (await shows(/sum 30/)) && plotted, `${scienceMs} ms: ${await tail(4)}`);
    await page.click("#back-to-editor").catch(() => {});
    await typed("rm -f figure-1.png");
  }

  // What the page itself threw, as opposed to what the programs printed.
  expect("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  fail("the run completed", String(e.message).split("\n")[0]);
} finally {
  await context.close();
  if (!process.env.PROFILE) await rm(profile, { recursive: true, force: true });
  server.close();
  bin.close();
}

console.log(failures ? `\n  ${failures} failed` : "\n  the pad does what a person expects");
process.exit(failures ? 1 : 0);

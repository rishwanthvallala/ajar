#!/usr/bin/env node
// The pad's terminal, used the way a person uses a terminal: real key presses
// into xterm, judged by what is on the screen afterwards.
//
// The pad's bash prints no prompt and echoes nothing, so the line editor in
// src/console.ts is the page's own — which is why this exists. Every key here
// was a promise the terminal broke on 25 September: Home typed `[H`, Tab did
// nothing, a two-line paste answered "a command is already running".
//
//   npx vite build && node scripts/terminal-check.mjs
//   PAD_ORIGIN=https://code.rishwanth.dev node scripts/terminal-check.mjs
//
// Locally it serves the build with a stub store — the terminal needs no relay.
// Against a deployment it is one first visit, unless PROFILE names a warm one.

import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL("../../web/package.json", import.meta.url))("playwright");
const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = 5207;
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

const profile = process.env.PROFILE ?? (await mkdtemp(join(tmpdir(), "pad-terminal-")));
const context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 800 } });
const page = context.pages()[0] ?? (await context.newPage());

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m, detail) => { failures++; console.log(`  FAIL ${m}${detail ? `\n         ${detail}` : ""}`); };
const expect = (m, pass, detail) => (pass ? ok(m) : fail(m, detail));

const rows = async () => (await page.evaluate(() => document.querySelector("#terminal .xterm-rows")?.innerText ?? ""))
  .split("\n").map((l) => l.replace(/ /g, " ").replace(/\s+$/, ""));
/** The line the prompt is on, as drawn: the last row starting with "$". */
const promptLine = async () => (await rows()).filter((l) => l.startsWith("$")).at(-1) ?? "";
const printed = async (text) => (await rows()).some((l) => l.trim() === text);
const idle = () => page.waitForFunction(() => window.__pad?.shellBusy() === false, null, { timeout: 60_000 });
const settle = (ms = 250) => page.waitForTimeout(ms);
const type = (text) => page.keyboard.type(text, { delay: 15 });
const press = (key) => page.keyboard.press(key);
async function run(command) {
  await type(command);
  await press("Enter");
  await settle(150);
  await idle();
  await settle(100);
}
async function paste(text) {
  await page.evaluate((t) => {
    const area = document.querySelector("#terminal .xterm-helper-textarea");
    const data = new DataTransfer();
    data.setData("text/plain", t);
    area.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}
/** Type `setup`, press `keys` (or `text:…` to type), compare the prompt line. */
async function keys(name, setup, sequence, want) {
  await type(setup);
  for (const k of sequence) await (k.startsWith("text:") ? type(k.slice(5)) : press(k));
  await settle();
  const got = await promptLine();
  expect(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  await press("Control+c");
  await settle();
}

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__pad, null, { timeout: 60_000 });
  await page.click("#terminal");
  // The runtime starts at load; the first command waits for it.
  await page.waitForFunction(() => window.__pad?.shellBusy() === false, null, { timeout: 240_000 });
  await run("echo ready");
  expect("a typed command runs", await printed("ready"));

  // ---- history ----
  await run("echo first");
  await run("echo second");
  await press("ArrowUp"); await settle();
  expect("↑ recalls the last command", (await promptLine()) === "$ echo second", await promptLine());
  await press("ArrowUp"); await settle();
  expect("↑↑ the one before", (await promptLine()) === "$ echo first", await promptLine());
  await press("ArrowDown"); await settle();
  expect("↓ forward again", (await promptLine()) === "$ echo second", await promptLine());
  await press("ArrowDown"); await settle();
  expect("↓ past the newest is an empty line again", (await promptLine()) === "$", await promptLine());
  await type("half-typed");
  await press("ArrowUp"); await press("ArrowDown"); await settle();
  expect("…and gives back what was being typed", (await promptLine()) === "$ half-typed", await promptLine());
  await press("Control+c"); await settle();
  await press("ArrowUp"); await settle();
  expect("ctrl-c starts history over from the newest", (await promptLine()) === "$ echo second", await promptLine());
  await press("ArrowLeft"); await press("ArrowLeft"); await type("X");
  await press("Enter"); await settle(150); await idle();
  expect("a recalled line edits and runs", await printed("secoXnd"), (await rows()).filter(Boolean).slice(-2).join(" | "));

  // ---- editing keys ----
  await keys("Home", "echo abc", ["Home", "text:X"], "$ Xecho abc");
  await keys("End", "echo abc", ["ArrowLeft", "ArrowLeft", "End", "text:Z"], "$ echo abcZ");
  await keys("Delete", "echo abc", ["ArrowLeft", "ArrowLeft", "Delete"], "$ echo ac");
  await keys("ctrl-a", "echo abc", ["Control+a", "text:X"], "$ Xecho abc");
  await keys("ctrl-e", "echo abc", ["Home", "Control+e", "text:Z"], "$ echo abcZ");
  await keys("ctrl-u", "echo abc", ["Control+u"], "$");
  await keys("ctrl-k", "echo abc", ["ArrowLeft", "ArrowLeft", "ArrowLeft", "Control+k"], "$ echo");
  await keys("ctrl-w", "echo abc def", ["Control+w"], "$ echo abc");
  await keys("ctrl-y puts back what was cut", "echo abc def", ["Control+w", "Control+a", "Control+y"], "$ defecho abc");
  await keys("ctrl-←", "echo abc def", ["Control+ArrowLeft", "text:X"], "$ echo abc Xdef");
  await keys("ctrl-→", "echo abc def", ["Home", "Control+ArrowRight", "text:X"], "$ echoX abc def");
  await keys("alt-b", "echo abc def", ["Alt+b", "text:X"], "$ echo abc Xdef");
  await keys("backspace mid-line", "echo abcd", ["ArrowLeft", "Backspace"], "$ echo abd");
  await keys("ctrl-d deletes forward", "echo abc", ["Home", "Control+d"], "$ cho abc");
  await keys("an unknown key types nothing", "echo abc", ["F5", "PageUp", "Insert"], "$ echo abc");

  // ---- completion ----
  await run("mkdir -p sub/deeper && touch completion-target.txt sub/inner-file.txt");
  await keys("Tab completes a file", "cat completion-t", ["Tab"], "$ cat completion-target.txt");
  await keys("Tab completes a directory with a slash", "ls su", ["Tab"], "$ ls sub/");
  await keys("Tab completes inside one", "cat sub/inn", ["Tab"], "$ cat sub/inner-file.txt");
  await keys("Tab completes a command", "pytho", ["Tab"], "$ python");
  await type("python");
  await press("Tab"); await settle(300); await press("Tab"); await settle(500);
  const listed = (await rows()).join("\n");
  expect("a second Tab lists the choices", /python3/.test(listed) && /python3\.\d+/.test(listed), (await rows()).filter(Boolean).slice(-3).join(" | "));
  expect("…and leaves the line as it was", (await promptLine()) === "$ python", await promptLine());
  await press("Control+c"); await settle();
  await run("cd sub");
  await keys("completion follows cd", "cat inn", ["Tab"], "$ cat inner-file.txt");
  await run("cd ..");

  // ---- search ----
  await run("echo needle-in-history");
  await run("echo something-else");
  await press("Control+r"); await type("needle"); await settle();
  const searching = (await rows()).filter(Boolean).at(-1) ?? "";
  expect("ctrl-r finds a past command", /reverse-i-search\)`needle': echo needle-in-history/.test(searching), searching);
  await press("Enter"); await settle(150); await idle();
  expect("…and Enter runs it", (await rows()).filter((l) => l.trim() === "needle-in-history").length >= 2, (await rows()).filter(Boolean).slice(-2).join(" | "));
  await press("Control+r"); await type("needle"); await press("Control+g"); await settle();
  expect("ctrl-g leaves the line as it was", (await promptLine()) === "$", await promptLine());

  // ---- clearing ----
  await run("echo before-clear");
  await press("Control+l"); await settle(300);
  expect("ctrl-l clears the screen", !(await printed("before-clear")), (await rows()).filter(Boolean).slice(0, 2).join(" | "));
  await run("echo before-clear-again");
  await run("clear"); await settle(300);
  expect("`clear` clears the screen", !(await printed("before-clear-again")), (await rows()).filter(Boolean).slice(0, 2).join(" | "));

  // ---- paste ----
  await paste("echo paste-one\necho paste-two\n");
  await page.waitForFunction(() => (document.querySelector("#terminal .xterm-rows")?.innerText ?? "").includes("paste-two\n"), null, { timeout: 20_000 }).catch(() => {});
  await idle(); await settle(300);
  expect("a two-line paste runs both, in order", (await printed("paste-one")) && (await printed("paste-two")), (await rows()).filter(Boolean).slice(-5).join(" | "));
  expect("…without \"already running\"", !(await rows()).some((l) => l.includes("already running")));
  await paste("echo no-newline");
  await settle();
  expect("a paste without a newline waits for Enter", (await promptLine()) === "$ echo no-newline", await promptLine());
  await press("Control+c"); await settle();

  // ---- long lines ----
  await run("clear");
  await type(`printf %s ${"w".repeat(170)}`);
  await press("Home"); await press("End");
  for (let i = 0; i < 5; i++) await press("Backspace");
  await type(" | wc -c");
  await press("Enter"); await settle(150); await idle();
  expect("a line longer than the terminal edits and runs", await printed("165"), (await rows()).filter(Boolean).slice(-2).join(" | "));
  expect("…and leaves no copies of itself up the screen", (await rows()).filter((l) => l.startsWith("$ printf")).length === 1, `${(await rows()).filter((l) => l.startsWith("$ printf")).length} copies`);

  // ---- ctrl-c ----
  await type("sleep 30"); await press("Enter"); await settle(1200);
  await press("Control+c");
  expect("ctrl-c stops a running command", await idle().then(() => true, () => false));
  await run("echo after-interrupt");
  expect("…and the shell carries on", await printed("after-interrupt"));

  // ---- Run joins history ----
  // Waits for the command Run announces, not for its output: locally the
  // stub store has no relay behind it, and the starter file is not what is
  // being checked here.
  await page.click("#run");
  await page.waitForFunction(() => /\$ python3? "?main\.py"?/.test(document.getElementById("terminal")?.textContent ?? ""), null, { timeout: 60_000 });
  await idle(); await page.click("#terminal"); await settle();
  await press("ArrowUp"); await settle();
  expect("↑ after Run recalls what Run ran", /^\$ python3? "?main\.py"?$/.test(await promptLine()), await promptLine());
  await press("Control+c");
} catch (e) {
  fail("the run completed", String(e.message).split("\n")[0]);
} finally {
  await context.close();
  if (!process.env.PROFILE) await rm(profile, { recursive: true, force: true });
  server.close();
}

console.log(failures ? `\n  ${failures} failed` : "\n  the terminal behaves like one");
process.exit(failures ? 1 : 0);

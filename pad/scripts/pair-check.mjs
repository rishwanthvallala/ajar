#!/usr/bin/env node
// Two places in one pad, one file open in both, and the text in each — what
// the editor shows and what the shared document holds — compared after each
// thing a person does.
//
// Written on 9 October for two ways the text went wrong that no other check
// saw, because every other check edits from one place at a time:
//
// - A file with mixed line endings, as a CSV a script wrote part of: the
//   editor converts them, and every edit after a converted one landed a
//   character off in the document. A value pasted into a cell showed right
//   where it was pasted, and with part of the old value beside it elsewhere.
// - A command run in one place while somebody typed in the other: the page
//   took the sandbox's copy of the open file back as the command's work, and
//   put that older text over the newest typing — a character at a time.
//
//   npm run build:pad && cargo build && node pad/scripts/pair-check.mjs

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const PORT = 5214;
const RELAY_PORT = 8866;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const dir = await mkdtemp(join(tmpdir(), "pad-pair-check-"));
const relay = spawn(join(REPO, "target/debug/ajar-relay"), ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", join(dir, "pads"), "--accounts-db", join(dir, "a.db")], { stdio: "ignore", env: { ...process.env, AJAR_PUBLIC_ORIGIN: ORIGIN } });
process.on("exit", () => relay.kill());
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
const TYPES = { ".html": "text/html", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript" };
const IMPORTMAP_SHA = createHash("sha256").update(/<script type="importmap">(.*?)<\/script>/s.exec(await readFile(join(ROOT, "index.html"), "utf8"))[1].replace(/\r\n?/g, "\n")).digest("base64");
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'unsafe-eval' blob: 'sha256-${IMPORTMAP_SHA}'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss: https://registry.wasmer.io https://cdn.wasmer.io; frame-ancestors 'none'; base-uri 'none'`);
  const urlPath = new URL(req.url, "http://x").pathname;
  if (urlPath.startsWith("/api/") || urlPath.startsWith("/auth/")) {
    const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => res.writeHead(502).end());
    return req.pipe(up);
  }
  const rel = urlPath.split("/").filter((p) => p && p !== "." && p !== "..").join("/");
  const file = join(ROOT, rel || "index.html");
  try { const body = await readFile(file); res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream"); res.end(body); }
  catch { res.setHeader("Content-Type", "text/html"); res.end(await readFile(join(ROOT, "index.html"))); }
});
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers });
  up.on("upgrade", (res, upSocket, upHead) => {
    upSocket.on("error", () => upSocket.destroy());
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  up.on("error", () => socket.destroy());
  if (head?.length) up.write(head);
  up.end();
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const results = [];
const ok = (m) => results.push(`ok   ${m}`);
const fail = (m) => results.push(`FAIL ${m}`);
const errors = [];

async function place(name, label) {
  const page = await (await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] })).newPage();
  page.on("pageerror", (e) => { if (!/Canceled/.test(e.message)) errors.push(`${label}: ${e.message.slice(0, 160)}`); });
  await page.goto(`${ORIGIN}/${name}`);
  await page.waitForFunction(() => window.__pad && window.monaco?.editor.getEditors()[0]?.getModel(), null, { timeout: 60_000 });
  return page;
}
const state = (page) => page.evaluate(() => {
  const ed = window.monaco.editor.getEditors()[0];
  const path = window.__pad.active();
  return { path, screen: ed.getValue(), doc: window.__pad.text(path) };
});
const wait = (page, ms) => page.waitForTimeout(ms);
async function pair(name) {
  const a = await place(name, "A");
  await wait(a, 1500);
  const b = await place(name, "B");
  for (let i = 0; i < 60; i++) {
    const [sa, sb] = [await state(a), await state(b)];
    if (sa.path === sb.path && sb.doc !== undefined && sa.doc === sb.doc) break;
    await wait(a, 250);
  }
  return [a, b];
}
const caretAt = (page, line, col, toLine = line, toCol = col) => page.evaluate(([l, c, l2, c2]) => {
  const ed = window.monaco.editor.getEditors()[0];
  ed.focus();
  ed.setSelection({ startLineNumber: l, startColumn: c, endLineNumber: l2, endColumn: c2 });
}, [line, col, toLine, toCol]);
const setAll = (page, text) => page.evaluate((t) => window.monaco.editor.getEditors()[0].setValue(t), text);
/** A real paste: the clipboard, then the key. */
async function paste(page, text) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
}
/** Both places agree, each shows what it holds, and that is `want`. */
async function agree(a, b, want, label) {
  const [sa, sb] = [await state(a), await state(b)];
  const fine = sa.doc === want && sb.doc === want && sa.screen === sa.doc && sb.screen === sb.doc;
  if (fine) ok(label);
  else fail(`${label} — ${JSON.stringify({ want, A: sa.doc, B: sb.doc, A_shows: sa.screen, B_shows: sb.screen })}`);
}

try {
  // ---- a sheet with mixed line endings -------------------------------------
  {
    const name = `pair-sheet-${Date.now().toString(36)}`;
    await fetch(`${ORIGIN}/api/pad/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ writes: [{ path: "sheet.csv", content: "name,qty\r\nalpha,1\nbeta,2\r\n" }] }),
    });
    const [a, b] = await pair(name);
    await caretAt(a, 3, 6, 3, 7);
    await paste(a, "1233132");
    await wait(a, 800);
    await agree(a, b, "name,qty\r\nalpha,1\r\nbeta,1233132\r\n", "a value pasted over in a sheet with mixed line endings is the same in both places, in one line ending");
    await caretAt(b, 2, 3);
    await b.keyboard.type("XY");
    await wait(a, 800);
    await agree(a, b, "name,qty\r\nalXYpha,1\r\nbeta,1233132\r\n", "and typing in the other place lands where it was typed");
    await a.context().close();
    await b.context().close();
  }

  // ---- commands in one place, typing in the other --------------------------
  {
    const [a, b] = await pair(`pair-run-${Date.now().toString(36)}`);
    const term = async (command) => {
      await b.locator("#terminal .xterm-helper-textarea").focus();
      await b.keyboard.type(command);
      await b.keyboard.press("Enter");
    };
    const idle = (ms = 30_000) => b.waitForFunction(() => window.__pad?.shellBusy() === false, null, { timeout: ms }).then(() => true, () => false);
    await b.click("#terminal");
    await term("echo ready");
    await b.waitForFunction(() => /\nready/.test(document.querySelector("#terminal .xterm-rows")?.innerText ?? ""), null, { timeout: 240_000 });
    await idle();

    for (const [label, command, rounds] of [
      ["quick commands in one place lose none of the typing in the other", "echo hi", 12],
      ["nor does one that takes a moment", "sleep 1", 4],
    ]) {
      await setAll(a, "x = 1\n");
      await wait(a, 1200);
      await caretAt(a, 1, 6);
      const typed = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(2);
      await Promise.all([
        a.keyboard.type(typed, { delay: 45 }),
        (async () => { for (let i = 0; i < rounds; i++) { await term(command); await wait(b, 150); await idle(); } })(),
      ]);
      await wait(a, 2500);
      await agree(a, b, `x = 1${typed}\n`, label);
    }

    // A command that changes the open file: its change and the typing both.
    await setAll(a, "x = 1\ny = 2\n");
    await wait(a, 1200);
    await caretAt(a, 2, 6);
    await Promise.all([
      a.keyboard.type("abcdefghijklmnop", { delay: 60 }),
      (async () => { await wait(b, 300); await term("sed -i 's/x = 1/x = 42/' main.py"); await wait(b, 150); await idle(); })(),
    ]);
    await wait(a, 2500);
    await agree(a, b, "x = 42\ny = 2abcdefghijklmnop\n", "a command that changes the open file keeps its change and the other place's typing");

    // A byte-order mark is part of a file — Excel's "CSV UTF-8" starts with
    // one — and a command run while the file is open leaves it there. Made in
    // the terminal: the editor's setValue would set the mark aside.
    await term("printf '\\xef\\xbb\\xbfname,qty\\n' > bom.csv");
    await wait(b, 150);
    await idle();
    for (const page of [a, b]) {
      const row = page.locator("#files").getByText("bom.csv", { exact: true });
      await row.waitFor({ timeout: 15_000 });
      await row.click();
    }
    await a.waitForFunction(() => window.__pad.active() === "bom.csv" && window.__pad.text("bom.csv") !== undefined, null, { timeout: 15_000 });
    await wait(a, 1500);
    await term("true");
    await wait(b, 150);
    await idle();
    await wait(a, 1500);
    await agree(a, b, "\ufeffname,qty\n", "a command run beside a file with a byte-order mark leaves the mark");
  }
} catch (e) {
  fail(e.stack ?? String(e));
} finally {
  await browser.close();
  server.close();
  relay.kill();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
for (const e of errors) fail(`page error: ${e}`);
for (const line of results) console.log(`  ${line}`);
const failed = results.filter((l) => l.startsWith("FAIL"));
if (failed.length) {
  console.log(`\n  ${failed.length} failed`);
  process.exit(1);
}
console.log("\n  two places in one pad hold the same text");
process.exit(0);

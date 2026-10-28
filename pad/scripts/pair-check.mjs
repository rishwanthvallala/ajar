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
  res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'unsafe-eval' blob: 'sha256-${IMPORTMAP_SHA}'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss: https:; frame-ancestors 'none'; base-uri 'none'`);
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
  // A connection that can be cut the way a sleeping laptop's is: closed, and
  // no way back until let. (Playwright's offline mode holds frames back and
  // releases them later, which no network does.)
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sockets = [];
    window.__cut = false;
    const Cuttable = function (url, protocols) {
      const ws = window.__cut ? new Real("ws://127.0.0.1:9/") : new Real(url, protocols);
      window.__sockets.push(ws);
      // Silenced, a socket stays OPEN and hears nothing, as a half-open one
      // does after a laptop sleeps.
      let handler = null;
      Object.defineProperty(ws, "onmessage", {
        get: () => handler,
        set: (h) => {
          handler = h;
          Real.prototype.__lookupSetter__("onmessage").call(ws, h ? (e) => { if (!ws.__silent) h(e); } : null);
        },
      });
      return ws;
    };
    Cuttable.prototype = Real.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Cuttable[k] = Real[k];
    window.WebSocket = Cuttable;
  });
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
  return fine;
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

  // ---- a large file, saved as what changed in it ---------------------------
  // A keystroke in a large file sent the whole file to the relay, and the
  // relay wrote the whole pad back. Now the save is the edit, against the
  // version the relay holds, and the result is the same everywhere.
  {
    const name = `pair-big-${Date.now().toString(36)}`;
    const big = `${"0123456789 the quick brown fox\n".repeat(10_000)}end\n`;
    await fetch(`${ORIGIN}/api/pad/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ writes: [{ path: "big.txt", content: big }] }),
    });
    const [a, b] = await pair(name);
    const puts = [];
    a.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/api/pad/")) puts.push(r.postData() ?? "");
    });
    await caretAt(a, 1, 1);
    await a.keyboard.type("ABC", { delay: 400 });
    await wait(a, 1500);
    const want = `ABC${big}`;
    await agree(a, b, want, "typing at the start of a 300 KB file is the same in both places");
    const stored = (await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files["big.txt"].content;
    const biggest = Math.max(0, ...puts.map((p) => p.length));
    if (stored === want && puts.length > 0 && biggest < 4096 && puts.some((p) => p.includes('"edits"'))) {
      ok(`and its saves went as edits — ${puts.length}, the largest ${biggest} bytes, not ${big.length}`);
    } else {
      fail(`and its saves went as edits — ${puts.length} saves, the largest ${biggest} bytes; stored ${stored === want ? "right" : "WRONG"}`);
    }
    await a.context().close();
    await b.context().close();
  }

  // ---- a place that drops out while another opens the file ----------------
  // Nobody answers the newcomer, so it seeds from the stored copy; the place
  // that dropped comes back with its own document of the file, and the two
  // share no history. Merged, a CRDT kept both, and the file doubled for
  // everyone. Each side's work in the gap is kept, once.
  {
    const name = `pair-drop-${Date.now().toString(36)}`;
    await fetch(`${ORIGIN}/api/pad/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ writes: [{ path: "main.py", content: "one\n" }] }),
    });
    const a = await place(name, "A");
    await wait(a, 1500);
    await caretAt(a, 2, 1);
    await a.keyboard.type("two\n");
    await wait(a, 2000);
    await a.evaluate(() => {
      window.__cut = true;
      for (const ws of window.__sockets) ws.close();
    });
    await wait(a, 2000);
    await caretAt(a, 3, 1);
    await a.keyboard.type("three\n");
    const b = await place(name, "B");
    await b.waitForFunction(() => window.__pad.text("main.py") === "one\ntwo\n", null, { timeout: 15_000 });
    await caretAt(b, 1, 1);
    await b.keyboard.type("B");
    await wait(b, 1500);
    await a.evaluate(() => {
      window.__cut = false;
    });
    await wait(a, 12_000);
    await agree(a, b, "Bone\ntwo\nthree\n", "a place back from a dropout, and one that opened the file meanwhile, end with one file and both their work");
    await a.context().close();
    await b.context().close();
  }

  // The same, with one history: both in the room before A's dropped. B adds
  // a line and saves; A types and saves, is refused as stale, and merges B's
  // line into its document; back in the room, the state exchange carried B's
  // line once from B and once as A's merge, twice in both documents and the
  // store (review of 28 October, dup-both, for a file of any size).
  {
    const name = `pair-dropmerge-${Date.now().toString(36)}`;
    const LINES = Array.from({ length: 20 }, (_, i) => `line_${i} = ${i}\n`).join("");
    await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: "main.py", content: LINES }] }) });
    const [a, b] = await pair(name);
    const putAt = (page, line, text) => page.evaluate(([l, t]) => {
      const ed = window.monaco.editor.getEditors()[0];
      ed.executeEdits("typing", [{ range: { startLineNumber: l, startColumn: 1, endLineNumber: l, endColumn: 1 }, text: t }]);
    }, [line, text]);
    await a.evaluate(() => {
      window.__cut = true;
      for (const ws of window.__sockets) ws.close();
    });
    await wait(a, 1500);
    await putAt(b, 21, "# typed by B while A was away\n");
    await wait(b, 3000);
    await putAt(a, 1, "## typed by A while away\n");
    await wait(a, 3000);
    await a.evaluate(() => {
      window.__cut = false;
    });
    await wait(a, 15_000);
    const count = (s, n) => (s ?? "").split(n).length - 1;
    const stored = ((await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files["main.py"] ?? {}).content;
    const want = `## typed by A while away\n${LINES}# typed by B while A was away\n`;
    if (count(stored, "# typed by B") === 1 && count(stored, "## typed by A") === 1) await agree(a, b, want, "a place back from a dropout, having merged the other's save meanwhile, has their line once — and so do they, and the store");
    else fail(`a dropout with a merge meanwhile — ${JSON.stringify({ stored, A: await a.evaluate(() => window.__pad.text("main.py")), B: await b.evaluate(() => window.__pad.text("main.py")) })}`);
    await a.context().close();
    await b.context().close();
  }

  // ---- a file too large to edit together live ------------------------------
  // A live document reaches somebody arriving as one message, and the relay
  // takes 32 MB of those. A 40 MB file open in two places: the second never
  // saw a keystroke, and nothing said so — every later message from the
  // first place, for any file, went nowhere. Since 11 October a file past
  // 24 MiB opens read-only and is changed from the terminal, and the store
  // carries its changes, as it does a binary file's.
  {
    const name = `pair-huge-${Date.now().toString(36)}`;
    const huge = "0123456789 the quick brown fox\n".repeat(850_000);
    for (const writes of [[{ path: "main.py", content: "x = 1\n" }], [{ path: "huge.txt", content: huge }]]) {
      const r = await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes }) });
      if (!r.ok) throw new Error(`could not store the large file: ${r.status} ${await r.text()}`);
    }
    const [a, b] = await pair(name);
    const opened = async (page) => {
      await page.locator("#files").getByText("huge.txt", { exact: true }).click();
      await page.waitForFunction(() => window.__pad.active() === "huge.txt", null, { timeout: 30_000 });
      await wait(page, 1000);
      return page.evaluate(() => {
        const ed = window.monaco.editor.getEditors()[0];
        return {
          readOnly: ed.getOption(window.monaco.editor.EditorOption.readOnly),
          live: window.__pad.docs().includes("huge.txt"),
          length: ed.getModel().getValueLength(),
          status: document.querySelector("#status")?.textContent ?? "",
        };
      });
    };
    const [oa, ob] = [await opened(a), await opened(b)];
    if (oa.readOnly && ob.readOnly && !oa.live && !ob.live && oa.length === huge.length && ob.length === huge.length) {
      ok(`a ${(huge.length / 1048576).toFixed(0)} MB file opens read-only in both places, with no live document`);
    } else {
      fail(`a ${(huge.length / 1048576).toFixed(0)} MB file opens read-only in both places, with no live document — ${JSON.stringify({ A: oa, B: ob })}`);
    }
    // Changed by a command in one place, it reaches the other through the store.
    await a.click("#terminal");
    await a.locator("#terminal .xterm-helper-textarea").focus();
    await a.keyboard.type("echo ready");
    await a.keyboard.press("Enter");
    await a.waitForFunction(() => /\nready/.test(document.querySelector("#terminal .xterm-rows")?.innerText ?? ""), null, { timeout: 240_000 });
    await a.waitForFunction(() => window.__pad?.shellBusy() === false, null, { timeout: 30_000 });
    await a.keyboard.type("echo added-by-a-command >> huge.txt");
    await a.keyboard.press("Enter");
    const want = huge.length + "added-by-a-command\n".length;
    const reached = await b
      .waitForFunction((n) => {
        const ed = window.monaco.editor.getEditors()[0];
        const model = ed.getModel();
        return model.getValueLength() === n && model.getLineContent(model.getLineCount() - 1) === "added-by-a-command";
      }, want, { timeout: 120_000, polling: 500 })
      .then(() => true, () => false);
    if (reached) ok("and a command changing it in one place reaches the other, through the store");
    else fail(`and a command changing it in one place reaches the other, through the store — B holds ${await b.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getValueLength())} of ${want}`);
    // The room is still a room: typing in another file reaches the other place.
    for (const p of [a, b]) await p.locator("#files").getByText("main.py", { exact: true }).click();
    await wait(a, 2000);
    await caretAt(a, 1, 6);
    await a.keyboard.type("23");
    await wait(a, 1500);
    await agree(a, b, "x = 123\n", "and typing in another file still reaches the other place");
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
    // Where the caret went, and what moved it: on CI on 21 October the
    // typing was split by the line's end, once in a few runs, the same in
    // both places — the caret one place past where the change left it.
    await a.evaluate(() => {
      const ed = window.monaco.editor.getEditors()[0];
      window.__caret = [];
      const t0 = performance.now();
      ed.onDidChangeCursorPosition((e) => window.__caret.push(`${Math.round(performance.now() - t0)}ms ${e.position.lineNumber}:${e.position.column} reason=${e.reason} ${e.source}`));
    });
    await Promise.all([
      a.keyboard.type("abcdefghijklmnop", { delay: 60 }),
      (async () => { await wait(b, 300); await term("sed -i 's/x = 1/x = 42/' main.py"); await wait(b, 150); await idle(); })(),
    ]);
    await wait(a, 2500);
    if (!(await agree(a, b, "x = 42\ny = 2abcdefghijklmnop\n", "a command that changes the open file keeps its change and the other place's typing"))) {
      // Typing moves it one column at a time; anything else is the change.
      const moves = await a.evaluate(() => window.__caret.filter((m) => !/ reason=0 keyboard$/.test(m)));
      console.log(`         A's caret, other than typing: ${moves.join(" · ").slice(0, 900)}`);
    }

    // The same, with the command still running when the typing arrives: the
    // other place's keystrokes were written into this sandbox as they came,
    // over the command's change, which then read as untouched and was lost
    // for everyone. Narrow above — macOS CI hit it on 15 October — and
    // certain here, where the command waits after its change.
    await setAll(a, "x = 1\ny = 2\n");
    await wait(a, 1200);
    await caretAt(a, 2, 6);
    await Promise.all([
      (async () => { await wait(a, 1200); await a.keyboard.type("qrstuvwx", { delay: 80 }); })(),
      (async () => { await term("sed -i 's/x = 1/x = 7/' main.py && sleep 3"); await wait(b, 150); await idle(); })(),
    ]);
    await wait(a, 2500);
    await agree(a, b, "x = 7\ny = 2qrstuvwx\n", "a command that changes the open file, then takes a while, keeps its change and the typing that came meanwhile");
    await term("cat main.py | tr '\\n' '|'; echo");
    await wait(b, 150);
    await idle();
    const sandboxHas = await b.evaluate(() => document.querySelector("#terminal .xterm-rows")?.innerText.includes("x = 7|y = 2qrstuvwx|") ?? false);
    if (sandboxHas) ok("and the sandbox there has both, for the next command");
    else fail(`and the sandbox there has both, for the next command — ${JSON.stringify((await b.evaluate(() => document.querySelector("#terminal .xterm-rows")?.innerText ?? "")).slice(-200))}`);

    // And a command that read the file before the typing came, and writes
    // its change to what it read: its work is that change, not the typing's
    // removal. Measured from the page's last write it was both, and the
    // typing went — a character of it on CI on 16 October, where the read and
    // the write were a moment apart, all of it here.
    await setAll(a, "x = 1\ny = 2\n");
    await wait(a, 1200);
    await caretAt(a, 2, 6);
    await Promise.all([
      (async () => { await wait(a, 1500); await a.keyboard.type("zyxw", { delay: 80 }); })(),
      (async () => { await term("cp main.py /tmp/read && sleep 3 && sed 's/x = 1/x = 5/' /tmp/read > main.py"); await wait(b, 150); await idle(); })(),
    ]);
    await wait(a, 2500);
    await agree(a, b, "x = 5\ny = 2zyxw\n", "a command that read the file before the typing came keeps its change and the typing both");

    // Typing not yet saved, then a command in the same place that changes
    // another line of that file. Before reading back what the command did,
    // the page wrote its unsaved files into the sandbox — over the command's
    // change, which was then never seen.
    await b.locator("#files").getByText("main.py", { exact: true }).click();
    await setAll(b, "one\ntwo\n");
    await wait(b, 1500);
    await caretAt(b, 1, 4);
    await b.keyboard.type("X");
    await term("sed -i 's/two/two-by-sed/' main.py");
    await wait(b, 150);
    await idle();
    await wait(b, 2000);
    await agree(a, b, "oneX\ntwo-by-sed\n", "typing not yet saved, and a command in the same place changing the file, are both kept");

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

    // A file only the other place has open, rewritten by a command here.
    // It used to reach the store and nobody's editor: theirs kept the old
    // text, and their next keystroke saved it back over the command's work.
    await term("echo old > zz.csv");
    await wait(b, 150);
    await idle();
    const row = a.locator("#files").getByText("zz.csv", { exact: true });
    await row.waitFor({ timeout: 15_000 });
    await row.click();
    await a.waitForFunction(() => window.__pad.active() === "zz.csv" && window.__pad.text("zz.csv") === "old\n", null, { timeout: 15_000 });
    await b.locator("#files").getByText("main.py", { exact: true }).click();
    await term("echo new > zz.csv");
    await wait(b, 150);
    await idle();
    const shows = await a.waitForFunction(() => window.monaco.editor.getEditors()[0].getValue() === "new\n", null, { timeout: 10_000 }).then(() => true, () => false);
    if (shows) ok("a command here that rewrites a file open only in the other place shows there");
    else fail(`a command here that rewrites a file open only in the other place shows there — it shows ${JSON.stringify((await state(a)).screen)}`);

    // A new file, opened while empty, then written by a command.
    await b.locator('#files button[aria-label="New file"]').click();
    await b.locator("#files input.name-input").fill("/out.csv");
    await b.locator("#files input.name-input").press("Enter");
    await wait(b, 1500);
    await b.locator("#files").getByText("main.py", { exact: true }).click();
    await term("printf 'a,b\\n1,2\\n' > out.csv");
    await wait(b, 150);
    await idle();
    await wait(b, 1500);
    await b.locator("#files").getByText("out.csv", { exact: true }).click();
    const filled = await b.waitForFunction(() => window.monaco.editor.getEditors()[0].getValue() === "a,b\n1,2\n", null, { timeout: 10_000 }).then(() => true, () => false);
    if (filled) ok("a file opened while empty, then written by a command, opens with what the command wrote");
    else fail(`a file opened while empty, then written by a command, opens with what the command wrote — it shows ${JSON.stringify((await state(b)).screen)}`);
  }

  // ---- history: an earlier version, gone back to from one place -----------
  // Restored the way a command's change is published, so the other place's
  // open document takes it, and the store holds it, and what was there is
  // kept as a version of its own first.
  {
    const name = `pair-history-${Date.now().toString(36)}`;
    const put = (writes) => fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes }) });
    await put([{ path: "main.py", content: "print('first')\n" }, { path: "notes.txt", content: "kept\n" }]);
    await fetch(`${ORIGIN}/api/pad/${name}/history`, { method: "POST" });
    await put([{ path: "extra.py", content: "x = 1\n" }]);
    const [a, b] = await pair(name);
    if ((await state(a)).path !== "main.py") await a.locator("#files").getByText("main.py", { exact: true }).click();
    if ((await state(b)).path !== "main.py") await b.locator("#files").getByText("main.py", { exact: true }).click();
    await setAll(a, "print('changed')\n");
    await wait(a, 1500);
    await a.click('#files button[aria-label^="History"]');
    const dialog = a.locator("dialog.history-dialog");
    await dialog.locator(".history-file").first().waitFor({ timeout: 15_000 });
    const marks = await dialog.locator(".history-file").allInnerTexts();
    const marked = marks.some((m) => /main\.py\s+changed since/.test(m)) && marks.some((m) => /extra\.py\s+added since/.test(m)) && marks.some((m) => /notes\.txt\s+the same/.test(m));
    if (marked) ok("History shows a version against the pad as it is, file by file");
    else fail(`History shows a version against the pad as it is — ${JSON.stringify(marks)}`);
    await dialog.getByRole("button", { name: "Restore this version" }).click();
    await a.locator("dialog.modal-confirm").getByRole("button", { name: "Restore it" }).click();
    const back = await b.waitForFunction(() => window.__pad?.text("main.py") === "print('first')\n", null, { timeout: 60_000 }).then(() => true, () => false);
    await agree(a, b, "print('first')\n", "a restore from one place reaches the other's open document");
    const stored = (await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files;
    const storedRight = stored["main.py"]?.content === "print('first')\n" && !stored["extra.py"] && stored["notes.txt"]?.content === "kept\n";
    const history = await (await fetch(`${ORIGIN}/api/pad/${name}/history`)).json();
    const keptFirst = history.length === 2 && (await (await fetch(`${ORIGIN}/api/pad/${name}/history/${history[0].id}`)).json()).files["main.py"]?.content === "print('changed')\n";
    if (back && storedRight && keptFirst) ok("and the store holds it — a file added since gone — with what it replaced kept as a version");
    else fail(`a restore is stored, with what it replaced kept — ${JSON.stringify({ back, stored: Object.keys(stored), main: stored["main.py"]?.content, versions: history.length, keptFirst })}`);
    await a.context().close();
    await b.context().close();
  }

  // ---- a rename in one place while the other is typing in the file -------
  // The other place follows the file to its new name, and what was typed
  // there before the rename reached it is kept (review of 17 October, M1:
  // it was sent to main.py, its last half-second gone).
  {
    const name = `pair-move-${Date.now().toString(36)}`;
    await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: "main.py", content: "print(1)\n" }, { path: "fa.txt", content: "start\n" }] }) });
    const [a, b] = await pair(name);
    await a.locator("#files").getByText("fa.txt", { exact: true }).click();
    await a.waitForFunction(() => window.__pad?.active() === "fa.txt" && window.__pad?.docs().includes("fa.txt"), null, { timeout: 30_000 });
    await caretAt(a, 1, 1);
    await a.keyboard.type("FAST-");
    await b.locator('#files .row[data-path="fa.txt"]').focus();
    await b.keyboard.press("F2");
    const input = b.locator("#files input.name-input");
    await input.waitFor({ timeout: 5000 });
    await input.fill("fb.txt");
    await input.press("Enter");
    const followed = await a.waitForFunction(() => window.__pad?.active() === "fb.txt", null, { timeout: 20_000 }).then(() => true, () => false);
    let stored = {};
    for (let i = 0; i < 40; i++) {
      stored = (await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files;
      if (stored["fb.txt"]?.content?.includes("FAST-") && !stored["fa.txt"]) break;
      await wait(a, 250);
    }
    const kept = stored["fb.txt"]?.content?.includes("FAST-") && !stored["fa.txt"];
    if (followed && kept) ok("a rename in one place takes the other along to the new name, with its typing");
    else fail(`a rename while typing — ${JSON.stringify({ followed, aActive: await a.evaluate(() => window.__pad?.active()), stored: Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, v.content])) })}`);
    await a.context().close();
    await b.context().close();
  }

  // ---- another place's command moves and changes files; this one is open ---
  // Review of 19 October, against production: a page merely open reverted a
  // `mv` and a `sed` made in another place, taking its own copy of the moved
  // file for typing (C3); a file deleted and another of its name made
  // elsewhere was taken for a move, and the old text went into the new file
  // (C5); and a page whose room was out of reach saved its copy over a newer
  // one, and said "saved" (C6).
  {
    const name = `pair-moves-${Date.now().toString(36)}`;
    const [a, b] = await pair(name);
    const term = async (command) => {
      await b.locator("#terminal .xterm-helper-textarea").focus();
      await b.keyboard.type(command);
      await b.keyboard.press("Enter");
      await wait(b, 300);
      await b.waitForFunction(() => window.__pad?.shellBusy() === false, null, { timeout: 120_000 }).catch(() => {});
    };
    const knows = (page, path) => page.waitForFunction((p) => window.__pad.known().includes(p), path, { timeout: 30_000 }).then(() => true, () => false);
    const storedText = async (path) => ((await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files[path] ?? {}).content;
    await b.click("#terminal");
    await term("printf 'DEBUG = True\\n' > app.py");
    const aHas = await knows(a, "app.py");
    await wait(a, 1500);
    await term("mkdir -p src && mv app.py src/app.py && sed -i 's/True/False/' src/app.py");
    await wait(a, 6000);
    const c3 = [await storedText("src/app.py"), await a.evaluate(() => window.__pad.text("src/app.py"))];
    if (aHas && c3[0] === "DEBUG = False\n" && c3[1] === "DEBUG = False\n") ok("a file another place moved and changed stays as they left it, with this page merely open");
    else fail(`a moved and changed file — ${JSON.stringify({ aHas, stored: c3[0], a: c3[1] })}`);

    await term("mkdir -p old_pkg && printf 'from .core import run\\n' > old_pkg/__init__.py");
    await knows(a, "old_pkg/__init__.py");
    await wait(a, 1500);
    await term("rm old_pkg/__init__.py && mkdir -p new_pkg && printf 'VERSION = 2\\n' > new_pkg/__init__.py");
    await wait(a, 6000);
    const c5 = await storedText("new_pkg/__init__.py");
    if (c5 === "VERSION = 2\n") ok("and a file deleted while another of its name is made elsewhere is not taken for a move");
    else fail(`a deleted file and a new one of its name — ${JSON.stringify(c5)}`);

    // A third place whose room is out of reach from the start.
    await term("printf 'x = 1\\n' > notes.py");
    await wait(b, 1500);
    const wPage = await (await browser.newContext()).newPage();
    await wPage.addInitScript(() => {
      const Real = window.WebSocket;
      const Blocked = function () { return new Real("ws://127.0.0.1:9/"); };
      Blocked.prototype = Real.prototype;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Blocked[k] = Real[k];
      window.WebSocket = Blocked;
    });
    await wPage.goto(`${ORIGIN}/${name}`);
    await wPage.waitForFunction(() => window.__pad && window.monaco?.editor.getEditors()[0]?.getModel(), null, { timeout: 60_000 });
    const openIn = async (page, path) => {
      await page.locator(`#files .row.file[data-path="${path}"]`).click();
      await page.waitForFunction((p) => window.__pad.active() === p, path, { timeout: 10_000 });
      await wait(page, 500);
    };
    const typeAt = async (page, line, text) => {
      await page.evaluate((l) => { const ed = window.monaco.editor.getEditors()[0]; ed.focus(); ed.setPosition({ lineNumber: l, column: 1 }); }, line);
      await page.keyboard.type(text, { delay: 15 });
    };
    await openIn(wPage, "notes.py");
    await typeAt(wPage, 1, "# opened by W\n");
    await wait(wPage, 3500);
    await openIn(b, "notes.py");
    await typeAt(b, 2, "def from_b():\n    return 42\n");
    await wait(b, 3500);
    await typeAt(wPage, 1, "#");
    await wait(wPage, 5000);
    const c6 = await storedText("notes.py");
    if (c6?.includes("from_b") && c6?.includes("# opened by W")) ok("and a page whose room is out of reach merges its save with a newer one, rather than writing over it");
    else fail(`a save from a page with no room — ${JSON.stringify(c6)}`);
    await wPage.context().close();
    await a.context().close();
    await b.context().close();
  }

  // ---- a socket that goes quiet --------------------------------------------
  // Review of 28 October, liveness: a half-open socket — a laptop that slept,
  // a NAT that forgot it — stays OPEN in the browser while nothing comes,
  // and the page said "2 here" and saw nobody's typing for minutes. The
  // relay sends a page a beat with each ping; a page that hears nothing for
  // longer than two of them takes the socket for gone and dials again.
  {
    const name = `pair-quiet-${Date.now().toString(36)}`;
    await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: "main.py", content: "one\n" }] }) });
    const [a, b] = await pair(name);
    // A beat heard first, so A knows this relay sends them.
    await wait(a, 22_000);
    const before = await a.evaluate(() => window.__sockets.length);
    await a.evaluate(() => { for (const ws of window.__sockets) ws.__silent = true; });
    await caretAt(b, 2, 1);
    await b.keyboard.type("typed while A heard nothing\n");
    const back = await a.waitForFunction((n) => window.__sockets.length > n && /typed while A heard nothing/.test(window.__pad.text("main.py") ?? ""), before, { timeout: 90_000 }).then(() => true, () => false);
    if (back) await agree(a, b, "one\ntyped while A heard nothing\n", "a page whose socket went quiet dials again, and has what was typed meanwhile");
    else fail(`a socket gone quiet — ${JSON.stringify({ sockets: await a.evaluate(() => window.__sockets.length), before, A: await a.evaluate(() => window.__pad.text("main.py")) })}`);
    await a.context().close();
    await b.context().close();
  }

  // ---- a save refused as stale, in a room with somebody else ---------------
  // Review of 28 October, N1, against production: B pressed Run on a 12 s
  // program — a running page puts off reading the pad again — and typed a
  // comment while A typed at the top. B's saves went over an old version, were
  // refused and merged, and the merge put the comment in twice, the second
  // time as the part A's page had saved: `    # other note\n    # oth    x = 1`,
  // in both editors and the store, 2 runs of 2.
  {
    const name = `pair-stale-${Date.now().toString(36)}`;
    const BASE = "import time\n\ndef main():\n    x = 1\n    y = 2\n    return x + y\n\ntime.sleep(12)\nprint(main())\n";
    await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: "main.py", content: BASE }] }) });
    const [a, b] = await pair(name);
    // Each page's runtime up first: a page's saves after its first wait for it.
    for (const page of [a, b]) {
      await page.locator("#terminal .xterm-helper-textarea").focus();
      await page.keyboard.type("true");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__pad?.shellBusy() === false && /\$ true/.test(document.querySelector("#terminal .xterm-rows")?.innerText ?? ""), null, { timeout: 240_000 }).catch(() => {});
    }
    await wait(a, 1500);
    await b.click("#run");
    await wait(b, 1500);
    await Promise.all([
      (async () => {
        for (const ch of "    # other note\n") {
          await b.evaluate((c) => {
            const ed = window.monaco.editor.getEditors()[0];
            const m = ed.getModel();
            const at = m.getPositionAt(m.getValue().indexOf("    x = 1"));
            ed.executeEdits("typing", [{ range: { startLineNumber: at.lineNumber, startColumn: at.column, endLineNumber: at.lineNumber, endColumn: at.column }, text: c }]);
          }, ch);
          await wait(b, 120);
        }
      })(),
      (async () => {
        await wait(a, 700);
        await caretAt(a, 1, 1);
        await a.keyboard.type("abc", { delay: 20 });
      })(),
    ]);
    await wait(a, 20_000);
    const stored = ((await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files["main.py"] ?? {}).content ?? "";
    const want = BASE.replace("    x = 1", "    # other note\n    x = 1").replace("import", "abcimport");
    const count = (s, n) => s.split(n).length - 1;
    if (stored === want && count(stored, "    # o") === 1) await agree(a, b, want, "a save refused as stale while a program runs, in a room with somebody else, puts nothing in twice");
    else fail(`a save refused as stale in a live room — ${JSON.stringify({ stored, want })}`);
    await a.context().close();
    await b.context().close();
  }

  // ---- a page with no room, after it reads the pad again -------------------
  // Review of 28 October, C6 again: a page whose room is out of reach read the
  // pad again after a save of its own showed it was behind, took a teammate's
  // newer version as known without putting it into its document, and its next
  // save went over that version with the right base and said "saved".
  {
    const name = `pair-roomless-${Date.now().toString(36)}`;
    await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: "notes.py", content: "x = 1\n" }, { path: "other.py", content: "y = 2\n" }] }) });
    const b = await place(name, "B");
    const w = await (await browser.newContext()).newPage();
    await w.addInitScript(() => {
      const Real = window.WebSocket;
      const Blocked = function () { return new Real("ws://127.0.0.1:9/"); };
      Blocked.prototype = Real.prototype;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Blocked[k] = Real[k];
      window.WebSocket = Blocked;
    });
    await w.goto(`${ORIGIN}/${name}`);
    await w.waitForFunction(() => window.__pad && window.monaco?.editor.getEditors()[0]?.getModel(), null, { timeout: 60_000 });
    // Said, rather than nothing (review of 28 October, liveness).
    const offline = await w.waitForFunction(() => /Offline/.test(document.getElementById("presence")?.textContent ?? ""), null, { timeout: 15_000 }).then(() => true, () => false);
    if (offline) ok("a page whose room is out of reach says it is offline");
    else fail(`a page with no room — presence ${JSON.stringify(await w.evaluate(() => document.getElementById("presence")?.textContent))}`);
    const openIn = async (page, path) => {
      await page.locator(`#files .row.file[data-path="${path}"]`).click();
      await page.waitForFunction((p) => window.__pad.active() === p, path, { timeout: 10_000 });
      await wait(page, 500);
    };
    const typeAt = async (page, line, text) => {
      await page.evaluate((l) => { const ed = window.monaco.editor.getEditors()[0]; ed.focus(); ed.setPosition({ lineNumber: l, column: 1 }); }, line);
      await page.keyboard.type(text, { delay: 15 });
    };
    const storedText = async (path) => ((await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files[path] ?? {}).content;
    await openIn(w, "notes.py");
    await typeAt(w, 1, "## opened\n");
    await wait(w, 3000);
    await openIn(b, "notes.py");
    // Put in as it stands: typed, the editor's own indenting adds to it.
    await b.evaluate(() => {
      const ed = window.monaco.editor.getEditors()[0];
      const end = ed.getModel().getLineCount();
      ed.executeEdits("typing", [{ range: { startLineNumber: end, startColumn: 1, endLineNumber: end, endColumn: 1 }, text: "def from_b():\n    return 42\n" }]);
    });
    await wait(b, 3000);
    // A save of another file in between: its number shows W it is behind,
    // and W reads the pad again.
    await openIn(w, "other.py");
    await typeAt(w, 1, "# w\n");
    await wait(w, 3000);
    await openIn(w, "notes.py");
    await typeAt(w, 1, "#");
    await wait(w, 4000);
    const stored = await storedText("notes.py");
    const shows = await w.evaluate(() => window.__pad.text("notes.py"));
    if (stored?.includes("def from_b():\n    return 42\n") && stored?.includes("## opened") && shows === stored) ok("a page with no room that reads the pad again keeps a teammate's newer save, and shows it");
    else fail(`a page with no room, after reading the pad again — ${JSON.stringify({ stored, shows })}`);
    await w.context().close();
    await b.context().close();
  }

  // ---- command output, a rename and New file, over a save not yet read -----
  // Review of 28 October: W's room is out of reach, so A hears of none of W's
  // saves. A's command output, rename and New file went whole with no
  // version, and wrote over W's: a line appended by A's command left W's
  // line out, a rename put A's older copy under the new name, and New file
  // wrote nothing over the todo.md W had made and typed in.
  {
    const name = `pair-writers-${Date.now().toString(36)}`;
    await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: "notes.py", content: "x = 1\n" }, { path: "app.py", content: "DEBUG = True\n" }] }) });
    const a = await place(name, "A");
    const w = await (await browser.newContext()).newPage();
    await w.addInitScript(() => {
      const Real = window.WebSocket;
      const Blocked = function () { return new Real("ws://127.0.0.1:9/"); };
      Blocked.prototype = Real.prototype;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Blocked[k] = Real[k];
      window.WebSocket = Blocked;
    });
    await w.goto(`${ORIGIN}/${name}`);
    await w.waitForFunction(() => window.__pad && window.monaco?.editor.getEditors()[0]?.getModel(), null, { timeout: 60_000 });
    const openIn = async (page, path) => {
      await page.locator(`#files .row.file[data-path="${path}"]`).click();
      await page.waitForFunction((p) => window.__pad.active() === p, path, { timeout: 10_000 });
      await wait(page, 500);
    };
    const putAtEnd = (page, text) => page.evaluate((t) => {
      const ed = window.monaco.editor.getEditors()[0];
      const end = ed.getModel().getLineCount();
      ed.executeEdits("typing", [{ range: { startLineNumber: end, startColumn: 1, endLineNumber: end, endColumn: 1 }, text: t }]);
    }, text);
    const stored = async () => (await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files;
    const textOf = (files, path) => files[path]?.content;
    // A's runtime up, so its command runs at once.
    await a.locator("#terminal .xterm-helper-textarea").focus();
    await a.keyboard.type("true");
    await a.keyboard.press("Enter");
    await a.waitForFunction(() => window.__pad?.shellBusy() === false && /\$ true/.test(document.querySelector("#terminal .xterm-rows")?.innerText ?? ""), null, { timeout: 240_000 }).catch(() => {});

    await openIn(w, "notes.py");
    await putAtEnd(w, "# from W\n");
    await wait(w, 3000);
    await a.locator("#terminal .xterm-helper-textarea").focus();
    await a.keyboard.type("printf '# appended by A\\n' >> notes.py");
    await a.keyboard.press("Enter");
    await wait(a, 300);
    await a.waitForFunction(() => window.__pad?.shellBusy() === false, null, { timeout: 60_000 }).catch(() => {});
    await wait(a, 4000);
    const notes = textOf(await stored(), "notes.py") ?? "";
    if (notes.includes("# from W") && notes.includes("# appended by A")) ok("a command's output in a file somebody saved since keeps their save");
    else fail(`a command's output over a save not yet read — ${JSON.stringify(notes)}`);

    await openIn(w, "app.py");
    await putAtEnd(w, "PORT = 8000\n");
    await wait(w, 3000);
    await a.hover('#files .file-row:has(.row.file[data-path="app.py"])');
    await a.locator('#files button[aria-label="Rename app.py"]').click();
    await a.locator("#files input.name-input").fill("/src/app.py");
    await a.locator("#files input.name-input").press("Enter");
    await wait(a, 5000);
    const afterMove = await stored();
    if (textOf(afterMove, "src/app.py")?.includes("PORT = 8000") && !("app.py" in afterMove)) ok("and a rename of a file somebody saved since takes their save with it");
    else fail(`a rename over a save not yet read — ${JSON.stringify({ moved: textOf(afterMove, "src/app.py"), left: textOf(afterMove, "app.py") })}`);

    await w.locator('#files button[aria-label="New file"]').click();
    await w.locator("#files input.name-input").fill("/todo.md");
    await w.locator("#files input.name-input").press("Enter");
    await w.waitForFunction(() => window.__pad.active() === "todo.md", null, { timeout: 10_000 });
    await putAtEnd(w, "- [ ] ship it\n");
    await wait(w, 3000);
    await a.locator('#files button[aria-label="New file"]').click();
    await a.locator("#files input.name-input").fill("/todo.md");
    await a.locator("#files input.name-input").press("Enter");
    await wait(a, 5000);
    const todo = textOf(await stored(), "todo.md");
    const aShows = await a.evaluate(() => window.__pad.text("todo.md"));
    if (todo === "- [ ] ship it\n" && aShows === todo) ok("and New file of a name somebody else made and typed in keeps theirs, and shows it");
    else fail(`New file over a file not yet read — ${JSON.stringify({ todo, aShows })}`);
    await w.context().close();
    await a.context().close();
  }

  // ---- what saving could not deliver, kept per tab, and given up when undone ---
  // Review of 19 October, item 7, and of 28 October: one browser kept one
  // journal per pad for all its tabs, so of two tabs offline typing in one
  // file, the second's journal took the place of the first's; and an undo
  // after Replace, before it saved, left the replacement in the journal, to
  // come back over the undo at the next visit.
  {
    const name = `pair-journal-${Date.now().toString(36)}`;
    const NOTES = "x = 1\ny = 2\n";
    await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: "notes.py", content: NOTES }] }) });
    const context = await browser.newContext();
    // No room, and no saves: each tab on its own, with only its journal.
    await context.addInitScript(() => {
      const Real = window.WebSocket;
      const Blocked = function () { return new Real("ws://127.0.0.1:9/"); };
      Blocked.prototype = Real.prototype;
      for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Blocked[k] = Real[k];
      window.WebSocket = Blocked;
    });
    const offline = (route) => (route.request().method() === "PUT" ? route.abort() : route.continue());
    await context.route(`**/api/pad/${name}`, offline);
    const tab = async () => {
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/${name}`);
      await page.waitForFunction(() => window.__pad && window.monaco?.editor.getEditors()[0]?.getModel(), null, { timeout: 60_000 });
      await page.waitForFunction(() => window.__pad.active() === "notes.py", null, { timeout: 10_000 });
      return page;
    };
    const put = (page, line, text) => page.evaluate(([l, t]) => {
      const ed = window.monaco.editor.getEditors()[0];
      ed.executeEdits("typing", [{ range: { startLineNumber: l, startColumn: 1, endLineNumber: l, endColumn: 1 }, text: t }]);
    }, [line, text]);
    const one = await tab();
    const two = await tab();
    await put(one, 1, "# one\n");
    await wait(one, 2500);
    await put(two, 3, "# two\n");
    await wait(two, 2500);
    await one.close();
    await two.close();
    await context.unroute(`**/api/pad/${name}`, offline);
    const back = await tab();
    const both = await back.waitForFunction(() => /# one/.test(window.__pad.text("notes.py") ?? "") && /# two/.test(window.__pad.text("notes.py") ?? ""), null, { timeout: 15_000 }).then(() => true, () => false);
    await wait(back, 2500);
    const stored = ((await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files["notes.py"] ?? {}).content;
    if (both && stored === "# one\nx = 1\ny = 2\n# two\n") ok("two tabs' typing that could not be saved comes back, both, in the next tab");
    else fail(`two tabs' unsaved typing — ${JSON.stringify({ both, stored, shows: await back.evaluate(() => window.__pad.text("notes.py")) })}`);
    await back.close();

    // Replace, then undo before it saves, then reload.
    await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: "notes.py", content: "name = 'alpha'\nprint(name)\n" }] }) });
    const r = await tab();
    await r.waitForFunction(() => window.__pad.text("notes.py") === "name = 'alpha'\nprint(name)\n", null, { timeout: 15_000 });
    await r.locator(".search-toggle:visible").first().click();
    await r.getByRole("searchbox", { name: "Search query" }).fill("alpha");
    await r.waitForFunction(() => /match/.test(document.querySelector(".search-status")?.textContent ?? ""), null, { timeout: 15_000 });
    await r.locator(".search-replace summary").click();
    await r.getByRole("textbox", { name: "Replacement text" }).fill("beta");
    await r.getByRole("button", { name: "Preview replacements", exact: true }).click();
    await r.getByRole("button", { name: "Apply replacements", exact: true }).click();
    // Once it is applied — and the replacement kept in case it cannot be
    // saved — and before its save, half a second later.
    await r.waitForFunction(() => /Applied/.test(document.querySelector("dialog[open] [role=status]")?.textContent ?? ""), null, { timeout: 10_000 });
    await r.evaluate(() => {
      document.querySelector("dialog[open]")?.close();
      const ed = window.monaco.editor.getEditors()[0];
      ed.focus();
      ed.trigger("check", "undo", null);
    });
    await wait(r, 3000);
    await r.reload();
    await r.waitForFunction(() => window.__pad && window.__pad.text("notes.py") !== undefined, null, { timeout: 60_000 });
    await wait(r, 2500);
    const undone = await r.evaluate(() => window.__pad.text("notes.py"));
    const storedNow = ((await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files["notes.py"] ?? {}).content;
    if (undone === "name = 'alpha'\nprint(name)\n" && storedNow === undone) ok("and a Replace undone before it saved stays undone after a reload");
    else fail(`a Replace undone, then a reload — ${JSON.stringify({ undone, storedNow })}`);
    await context.close();
  }

  // ---- a write somebody else made just before this page's own --------------
  // Each write moves a pad on by one. A page took its save's number as how far
  // it had read, so a write that went in just before its own — whose nudge
  // then asked for nothing newer — stayed unseen there until something else
  // changed (18 October). Here that write has no nudge at all: it goes straight
  // to the API while the page's own request is on its way. And a page that has
  // the pad is told so when it reads it again, rather than sent it whole.
  {
    const name = `pair-between-${Date.now().toString(36)}`;
    const put = (writes) => fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes }) });
    await put([{ path: "main.py", content: "print(1)\n" }, { path: "other.txt", content: "before\n" }]);
    const a = await place(name, "A");
    await a.waitForFunction(() => window.__pad.active() === "main.py", null, { timeout: 15_000 });
    let slipped = false;
    await a.route(`**/api/pad/${name}`, async (route) => {
      if (route.request().method() === "PUT" && !slipped) {
        slipped = true;
        await put([{ path: "other.txt", content: "from elsewhere\n" }]);
      }
      await route.continue();
    });
    await caretAt(a, 1, 1);
    await a.keyboard.type("# A\n");
    const seen = await a.waitForFunction(() => window.__pad.text("other.txt") === "from elsewhere\n", null, { timeout: 15_000 }).then(() => true, () => false);
    if (slipped && seen) ok("a write made just before this page's own save is read there, not taken as seen");
    else fail(`a write made just before this page's own save — ${JSON.stringify({ slipped, other: await a.evaluate(() => window.__pad.text("other.txt")) })}`);
    await a.unroute(`**/api/pad/${name}`);

    // Somebody joining: the page reads the pad again, and is told it has it.
    const reads = [];
    a.on("response", (r) => {
      if (r.request().method() === "GET" && new URL(r.url()).pathname === `/api/pad/${name}`) reads.push(r.text().catch(() => ""));
    });
    await wait(a, 2000);
    const b = await place(name, "B");
    await wait(a, 3000);
    const bodies = await Promise.all(reads);
    const short = bodies.filter((body) => body.includes('"unchanged":true') && !body.includes("from elsewhere"));
    if (short.length > 0 && short.length === bodies.length) ok(`and when somebody joins, it is told it has the pad rather than sent it again (${bodies.length} read, ${short[0].length} bytes)`);
    else fail(`a read again when somebody joins — ${JSON.stringify(bodies.map((body) => body.slice(0, 120)))}`);
    await a.context().close();
    await b.context().close();
  }

  // ---- two files whose paths share a stream --------------------------------
  // A document's frames carry 32 bits to say which file, a hash of the path,
  // and these two names hash alike. The second opened took the first's place,
  // so typing in one went into the other everywhere it was open (audit of 17
  // October, DC-09). Each message names its file now.
  {
    const name = `pair-collide-${Date.now().toString(36)}`;
    const one = "file-1ezsubx.txt";
    const other = "file-6yp6oj.txt";
    await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: one, content: "first\n" }, { path: other, content: "second\n" }] }) });
    const [a, b] = await pair(name);
    const both = async (page) => {
      for (const path of [one, other]) {
        await page.locator("#files").getByText(path, { exact: true }).click();
        await page.waitForFunction((p) => window.__pad.active() === p && window.__pad.docs().includes(p), path, { timeout: 30_000 });
      }
    };
    await both(a);
    await both(b);
    await wait(a, 1500);
    const texts = (page) => page.evaluate(([x, y]) => [window.__pad.text(x), window.__pad.text(y)], [one, other]);
    const settled = async (want) => {
      for (let i = 0; i < 40; i++) {
        const [ta, tb] = [await texts(a), await texts(b)];
        if (ta.join("|") === want.join("|") && tb.join("|") === want.join("|")) return true;
        await wait(a, 250);
      }
      return false;
    };
    await caretAt(a, 1, 1);
    await a.keyboard.type("B-");
    const first = await settled(["first\n", "B-second\n"]);
    await a.locator("#files").getByText(one, { exact: true }).click();
    await a.waitForFunction((p) => window.__pad.active() === p, one, { timeout: 10_000 });
    await wait(a, 500);
    await caretAt(a, 1, 1);
    await a.keyboard.type("A-");
    const second = await settled(["A-first\n", "B-second\n"]);
    let stored = {};
    for (let i = 0; i < 40; i++) {
      stored = (await (await fetch(`${ORIGIN}/api/pad/${name}`)).json()).files;
      if (stored[one]?.content === "A-first\n" && stored[other]?.content === "B-second\n") break;
      await wait(a, 250);
    }
    const storedRight = stored[one]?.content === "A-first\n" && stored[other]?.content === "B-second\n";
    if (first && second && storedRight) ok("two files whose paths share a stream, open in both places, each take only their own typing, there and in the store");
    else fail(`two files whose paths share a stream — ${JSON.stringify({ first, second, A: await texts(a), B: await texts(b), stored: [stored[one]?.content, stored[other]?.content], streams: await b.evaluate(() => window.__pad.streams()) })}`);
    await a.context().close();
    await b.context().close();
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

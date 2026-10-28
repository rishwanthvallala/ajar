#!/usr/bin/env node
// Focused, portable search acceptance checks. No runtime downloads or Unix commands.
// npm run build:pad && node pad/scripts/search-check.mjs
// SEARCH_BROWSER=firefox|webkit selects the engine; SEARCH_RELAY=<url> uses a real relay.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import { WebSocketServer } from "ws";
import { inFolder, matchesIn, replaced, searchFile } from "../src/search-match.ts";
import { searchShortcut, shortcutLabel } from "../src/search-keys.ts";

const options = { query: "cat", mode: "contents", folder: "", matchCase: false, wholeWord: false };
assert.equal(inFolder("src/a.py", "src"), true);
assert.equal(inFolder("src-other/a.py", "src"), false);
assert.deepEqual(matchesIn("cat CAT concatenate cat", { ...options, wholeWord: true }).map((m) => m.start), [0, 4, 20]);
assert.equal(matchesIn("CAT cat", { ...options, matchCase: true }).length, 1);
assert.equal(matchesIn("猫cat cat猫 cat", { ...options, wholeWord: true }).length, 1);
for (const [text, query] of [["की", "क"], ["cafe\u0301", "cafe"], ["\u0301cafe", "cafe"], ["x\u20dd", "x"], ["x\u{1d165}", "x"]]) {
  assert.equal(matchesIn(text, { ...options, query, wholeWord: true }).length, 0, `combining marks stay inside words: ${text}`);
  assert.equal(matchesIn(text, { ...options, query, wholeWord: false }).length, 1);
}
const accented = "cafe\u0301 cafe";
assert.equal(replaced(accented, matchesIn(accented, { ...options, query: "cafe", wholeWord: true }), "tea"), "cafe\u0301 tea");
assert.equal(replaced("की क", matchesIn("की क", { ...options, query: "क", wholeWord: true }), "x"), "की x");
assert.equal(matchesIn("cafe\u0301", { ...options, query: "cafe\u0301", wholeWord: true }).length, 1);
assert.equal(matchesIn("😀\r\ncat", options)[0].start, 4);
assert.equal(matchesIn("😀\r\ncat", options)[0].line, 2);
assert.equal(matchesIn("one\rcat", options)[0].line, 2);
assert.equal(matchesIn("one\rcat", options)[0].column, 1);
assert.equal(matchesIn("😀 cat", options)[0].column, 4);
assert.equal(matchesIn("[a].*", { ...options, query: "[a].*" }).length, 1);
assert.equal(matchesIn("aaaa", { ...options, query: "aa" }).length, 2);
assert.equal(matchesIn("abc", { ...options, query: "" }).length, 0);
assert.equal(matchesIn("a\nb", { ...options, query: "a\nb" }).length, 0);
assert.equal(matchesIn("cat ".repeat(6000), options).length, 5001);
assert.equal(matchesIn("cat ".repeat(6000) + "x".repeat(1024 * 1024), options).length, 5001);
// Bound actual newline lookup work rather than wall-clock time on a particular CI runner.
// An absent delimiter must not cause a full tail scan for each matching line.
for (const [separator, rows] of [["\n", 3 * 1024 * 1024], ["\r", 10_000], ["\r\n", 10_000]]) {
  const text = `alpha${separator}`.repeat(rows);
  const original = String.prototype.indexOf;
  let examined = 0;
  let matches;
  try {
    String.prototype.indexOf = function (needle, from = 0) {
      const at = original.call(this, needle, from);
      if (this === text && (needle === "\n" || needle === "\r")) examined += (at < 0 ? text.length : at + 1) - from;
      return at;
    };
    matches = matchesIn(text, { ...options, query: "alpha" });
  } finally { String.prototype.indexOf = original; }
  assert.equal(matches.length, 5001);
  assert.deepEqual([matches.at(-1).line, matches.at(-1).column], [5001, 1]);
  assert.ok(examined <= 3 * text.length, `newline lookup must stay linear for ${JSON.stringify(separator)}: ${examined} characters examined`);
}
assert.equal(searchFile({ path: "cat.png", revision: 1 }, options, 10), null);
assert.ok(searchFile({ path: "Cat.png", revision: 1 }, { ...options, mode: "names", matchCase: true }, 10));
assert.equal(replaced("cat\r\ncat", matchesIn("cat\r\ncat", options), "$&"), "$&\r\n$&");
assert.equal(replaced("cat cat", matchesIn("cat cat", options), ""), " ");
assert.equal(matchesIn("İ cat", options)[0].start, 2);
assert.equal(shortcutLabel("names", true), "⌘P");
for (const apple of [false, true]) {
  const event = (extra = {}) => ({ key: "f", code: "KeyF", shiftKey: true, ctrlKey: !apple, metaKey: apple, getModifierState: () => false, ...extra });
  assert.equal(searchShortcut(event(), apple), "contents");
  for (const extra of [{ isComposing: true }, { repeat: true }, { altKey: true }, { keyCode: 229 }, { getModifierState: () => true }]) assert.equal(searchShortcut(event(extra), apple), null);
  assert.equal(searchShortcut(event({ key: "ф", code: "KeyP", shiftKey: false }), apple), "names");
}
console.log("ok   literal matching, Unicode, offsets, scopes, replacement, shortcut modifiers");

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const relay = process.env.SEARCH_RELAY;
const fixtures = new Map();
const saves = [];
const roles = new Map();
let failWrites = false;
let viewer = false;
const initial = () => ({
  "main.py": { content: "print('alpha')\n", encoding: "utf8", seq: 1 },
  "src/one.py": { content: "alpha ALPHA alphabet\r\nprint('two')\r\n", encoding: "utf8", seq: 1 },
  "src/nested/two.txt": { content: "alpha\n", encoding: "utf8", seq: 1 },
  "src-other/out.txt": { content: "alpha\n", encoding: "utf8", seq: 1 },
  "icon-alpha.png": { content: "AA==", encoding: "base64", seq: 1 },
});
function fixture(name) {
  if (!fixtures.has(name)) fixtures.set(name, { exists: true, seq: 1, files: initial() });
  return fixtures.get(name);
}
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const html = await readFile(join(root, "index.html"), "utf8");
const mapHash = createHash("sha256").update(/<script type="importmap">(.*?)<\/script>/s.exec(html)[1].replace(/\r\n?/g, "\n")).digest("base64");
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'unsafe-eval' blob: 'sha256-${mapHash}'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws:; frame-ancestors 'none'; base-uri 'none'`);
  const path = new URL(req.url, "http://localhost").pathname;
  if (relay && (path.startsWith("/api/") || path.startsWith("/auth/"))) {
    const up = request(new URL(req.url, relay), { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => res.writeHead(502).end()); req.pipe(up); return;
  }
  if (path === "/api/me") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ user: null, providers: [] }));
  if (/^\/api\/pad\/[^/]+\/run$/.test(path)) return res.writeHead(204).end();
  const pad = /^\/api\/pad\/([^/]+)$/.exec(path);
  if (pad) {
    const state = fixture(pad[1]);
    if (req.method === "PUT") {
      if (failWrites) return res.writeHead(503).end("Save unavailable");
      let body = ""; for await (const chunk of req) body += chunk;
      for (const change of JSON.parse(body).writes) {
        saves.push(change.path);
        if (change.content === null) delete state.files[change.path];
        else state.files[change.path] = { content: change.content, encoding: change.encoding ?? "utf8", seq: ++state.seq };
      }
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ seq: state.seq }));
    }
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...state, access: { role: roles.get(pad[1]) ?? (viewer ? "viewer" : "editor"), account: false } }));
  }
  // Fail runtime startup before its first package download. Search must not depend on it.
  if (/^\/vendor\/wasmer\/[^/]+\/dist\/index\.js$/.test(path)) {
    return res.writeHead(200, { "content-type": "text/javascript" }).end('export class Wasmer { constructor() { throw new Error("search-fixture-runtime-unavailable"); } }');
  }
  if (path.startsWith("/packages/") || path.startsWith("/vendor/")) return res.writeHead(404).end();
  try {
    const file = join(root, path.split("/").filter((p) => p && p !== ".." && p !== ".").join("/"));
    res.setHeader("content-type", mime[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.setHeader("content-type", "text/html"); res.end(html); }
});
const wss = new WebSocketServer({ noServer: true });
const upgraded = new Set();
const clients = new Map(); let nextId = 1;
function nudge(name) {
  const state = fixture(name); state.seq++;
  const header = Buffer.alloc(9); header[0] = 3;
  for (const [socket, client] of clients) if (client.room === name) socket.send(Buffer.concat([header, Buffer.from(JSON.stringify({ t: "moved", seq: state.seq }))]));
}
const control = (socket, value) => {
  const header = Buffer.alloc(9); header[0] = 1;
  socket.send(Buffer.concat([header, Buffer.from(JSON.stringify(value))]));
};
server.on("upgrade", (req, socket, head) => {
  upgraded.add(socket); socket.on("close", () => upgraded.delete(socket));
  if (relay) {
    const up = request(new URL(req.url, relay), { headers: req.headers });
    up.on("upgrade", (r, target, extra) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
      if (extra.length) socket.write(extra);
      target.pipe(socket).pipe(target);
      target.on("error", () => socket.destroy()); socket.on("error", () => target.destroy());
    });
    up.on("error", () => socket.destroy()); if (head.length) up.write(head); up.end(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (data) => {
      const bytes = Buffer.from(data);
      if (bytes[0] === 1) {
        const hello = JSON.parse(bytes.subarray(9));
        if (hello.t !== "hello") return;
        const id = nextId++; const room = hello.session;
        const peers = [...clients].filter(([, c]) => c.room === room);
        clients.set(ws, { id, room });
        control(ws, { t: "welcome", participant_id: id, participants: [...peers.map(([, c]) => ({ id: c.id })), { id }] });
        for (const [peer] of peers) control(peer, { t: "joined", participant: { id } });
      } else {
        const sender = clients.get(ws);
        for (const [peer, c] of clients) if (peer !== ws && c.room === sender?.room && peer.readyState === 1) peer.send(bytes);
      }
    });
    ws.on("close", () => {
      const old = clients.get(ws); clients.delete(ws);
      for (const [peer, c] of clients) if (old && old.room === c.room) control(peer, { t: "left", participant_id: old.id });
    });
  });
});
await new Promise((resolve) => server.listen(Number(process.env.SEARCH_PORT ?? 0), "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browserType = { chromium, firefox, webkit }[process.env.SEARCH_BROWSER ?? "chromium"];
const browser = await browserType.launch({ channel: process.env.PAD_BROWSER_CHANNEL || undefined });
const errors = [];
const modifier = process.platform === "darwin" ? "Meta" : "Control";
const name = `search-${Date.now().toString(36)}`;
if (relay) {
  const response = await fetch(`${relay}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: Object.entries(initial()).map(([path, f]) => ({ path, ...f })) }) });
  assert.ok(response.ok);
}
async function open(padName = name, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 768 });
  const page = await context.newPage();
  page.on("pageerror", (e) => { if (!/Canceled|^search-fixture-runtime-unavailable$/.test(e.message)) errors.push(e.message); });
  await page.goto(`${origin}/${padName}`);
  await page.waitForFunction(() => window.__pad && window.monaco?.editor.getEditors()[0]?.getModel(), null, { timeout: 30_000 });
  return page;
}
async function search(page, query) {
  await page.keyboard.press(`${modifier}+Shift+F`);
  await page.getByRole("searchbox", { name: "Search query" }).fill(query);
  await page.waitForFunction(() => document.querySelector(".search-results")?.getAttribute("aria-busy") === "false");
}
async function preview(page, value) {
  await page.locator(".search-replace summary").click();
  await page.getByRole("textbox", { name: "Replacement text" }).fill(value);
  await page.getByRole("button", { name: "Preview replacements", exact: true }).click();
  await page.getByRole("dialog", { name: "Preview replacements" }).waitFor();
}
const edit = (page, path, value) => page.evaluate(({ path, value }) => {
  const editor = window.monaco.editor.getEditors()[0];
  if (window.__pad.active() !== path) throw new Error("Wrong file in test");
  editor.executeEdits("search-test", [{ range: editor.getModel().getFullModelRange(), text: value }]);
}, { path, value });
try {
  if (!relay) {
    const bom = fixture("bom-search");
    bom.files = {
      "main.py": { content: "print('start')\n", encoding: "utf8", seq: 1 },
      "bom.txt": { content: "\uFEFFalpha\n", encoding: "utf8", seq: 1 },
      "bom-crlf.txt": { content: "\uFEFFbefore\r\nalpha\r\n", encoding: "utf8", seq: 1 },
    };
    const page = await open("bom-search");
    for (const [path, title, replacement, want] of [
      ["bom.txt", "bom.txt:1:2", "beta", "\uFEFFbeta\n"],
      ["bom-crlf.txt", "bom-crlf.txt:2:1", "gamma", "\uFEFFbefore\r\ngamma\r\n"],
    ]) {
      await search(page, "alpha");
      await page.locator(`.search-hit[title="${title}"]`).click();
      // Binding puts the live document's BOM into the model's text. Check after that transition.
      await page.waitForFunction((path) => window.__pad.active() === path && window.monaco.editor.getEditors()[0].getValue().startsWith("\uFEFF"), path);
      assert.equal(await page.evaluate(() => {
        const editor = window.monaco.editor.getEditors()[0];
        return editor.getModel().getValueInRange(editor.getSelection());
      }), "alpha", `${path}: the bound model selects the complete search match`);
      const saved = page.waitForResponse((response) => response.url() === `${origin}/api/pad/bom-search`
        && response.request().method() === "PUT" && response.ok()
        && response.request().postDataJSON().writes.some((write) => write.path === path && write.content === want));
      await page.keyboard.type(replacement);
      await page.waitForFunction(({ path, want }) => window.__pad.text(path) === want && window.monaco.editor.getEditors()[0].getValue() === want, { path, want });
      await saved;
      assert.equal(fixture("bom-search").files[path].content, want);
    }
    await page.context().close();
    console.log("ok   search selection after BOM binding, typed replacement, saved BOM and CRLF");
  }
  const page = await open();
  assert.ok(await page.locator(".side-head strong + .search-toggle svg").isVisible());
  await page.locator(".side-head .search-toggle").click();
  await page.getByRole("searchbox").fill("alpha");
  await page.waitForFunction(() => document.querySelectorAll(".search-hit").length === 6);
  assert.equal(await page.evaluate(() => window.monaco.editor.getModels().length), 1);
  await page.getByLabel("In folder", { exact: true }).selectOption("src");
  await page.waitForFunction(() => document.querySelectorAll(".search-hit").length === 4);
  await page.getByText("Whole word", { exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".search-hit").length === 3);
  await page.getByText("Match case", { exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".search-hit").length === 2);
  console.log("ok   magnifier, worker results, folder boundaries, case/word controls, lazy models");
  await page.getByRole("searchbox").focus();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__pad.active() === "src/nested/two.txt");
  assert.equal(await page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getValueInRange(window.monaco.editor.getEditors()[0].getSelection())), "alpha");
  await page.keyboard.press(`${modifier}+P`);
  await page.getByLabel("In folder", { exact: true }).selectOption("");
  await page.getByRole("searchbox").fill("icon-alpha");
  await page.waitForFunction(() => document.querySelectorAll(".search-hit").length === 1);
  assert.ok((await page.locator(".search-hit").innerText()).includes("icon-alpha.png"));
  await page.getByRole("button", { name: "Back to files" }).click();
  console.log("ok   native OS shortcuts, result navigation and binary filename search");

  // Off a Mac the shortcuts are Ctrl ones, and in the terminal Ctrl-P is the
  // shell's previous command: there they stay the terminal's (review of 28
  // October). The platform is set, so this holds on any runner.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" }));
    const linux = await context.newPage();
    linux.on("pageerror", (e) => { if (!/Canceled|^search-fixture-runtime-unavailable$/.test(e.message)) errors.push(e.message); });
    await linux.goto(`${origin}/${name}`);
    await linux.waitForFunction(() => window.__pad && window.monaco?.editor.getEditors()[0]?.getModel(), null, { timeout: 30_000 });
    const query = linux.getByRole("searchbox", { name: "Search query" });
    await linux.locator("#terminal .xterm-helper-textarea").focus();
    await linux.keyboard.press("Control+P");
    await linux.keyboard.press("Control+Shift+F");
    await linux.waitForTimeout(300);
    assert.equal(await query.isVisible(), false, "Ctrl-P and Ctrl-Shift-F in the terminal stay the terminal's");
    await linux.evaluate(() => window.monaco.editor.getEditors()[0].focus());
    await linux.keyboard.press("Control+P");
    await query.waitFor({ state: "visible", timeout: 5000 });
    await context.close();
    console.log("ok   off a Mac, Ctrl-P and Ctrl-Shift-F in the terminal are left to it, and open Search elsewhere");
  }

  // Another participant keeps main.py live while replacement edits it off screen here.
  const other = await open();
  await other.waitForFunction(() => window.__pad.docs().includes("main.py"));
  await search(page, "alpha");
  await page.getByLabel("In folder", { exact: true }).selectOption("");
  await page.getByText("Match case", { exact: true }).click();
  await page.getByText("Whole word", { exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".search-hit").length === 6);
  await preview(page, "$&");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await other.evaluate(() => window.__pad.text("main.py")), "print('alpha')\n");
  // The second preview deliberately becomes stale for main.py.
  await page.getByRole("button", { name: "Preview replacements", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await edit(other, "main.py", "print('alpha from collaborator')\n");
  await page.waitForFunction(() => window.__pad.text("main.py").includes("collaborator"));
  await page.getByRole("button", { name: "Apply replacements", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).waitFor();
  assert.ok((await page.getByRole("dialog").innerText()).includes("Skipped: main.py"));
  assert.equal(await other.evaluate(() => window.__pad.text("main.py")), "print('alpha from collaborator')\n");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForFunction(() => window.__pad.text("src/one.py") === "$& $& $&bet\r\nprint('two')\r\n");
  console.log("ok   cancel, literal replacement, unopened files, CRLF and concurrent-edit protection");
  // Finish that scenario's saves/nudges before the next independent preview;
  // otherwise its button can be invalidated halfway through the click.
  await Promise.all([page, other].map((place) => place.waitForFunction(() => document.querySelector("#status")?.textContent === "saved")));
  await search(page, "alpha");
  await page.waitForFunction(() => document.querySelectorAll(".search-hit").length === 1);
  await page.getByRole("textbox", { name: "Replacement text" }).fill("shared");
  await page.getByRole("button", { name: "Preview replacements", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Apply replacements", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).waitFor();
  await other.waitForFunction(() => window.monaco.editor.getEditors()[0].getValue() === "print('shared from collaborator')\n");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  if (!relay) {
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "saved", null, { timeout: 10_000 });
    assert.ok(saves.includes("src/one.py"));
  }
  await page.reload();
  await page.waitForFunction(() => window.__pad?.text("main.py") === "print('shared from collaborator')\n");
  console.log("ok   replacement reaches the other browser and survives reload");

  if (!relay) {
    const many = fixture("many-search"); many.files = {};
    for (let i = 0; i < 500; i++) many.files[`src/f${String(i).padStart(3, "0")}.txt`] = { content: "needle ".repeat(11), encoding: "utf8", seq: 1 };
    const full = await open("many-search");
    await search(full, "needle");
    assert.equal(await full.locator(".search-hit").count(), 5000);
    assert.ok((await full.locator(".search-status").innerText()).includes("limited"));
    assert.equal(await full.locator(".search-replace button").isDisabled(), true);
    assert.equal(await full.evaluate(() => window.monaco.editor.getModels().length), 1);
    await full.context().close();

    const large = fixture("large-search");
    large.files = { "main.py": initial()["main.py"], "large.txt": { content: `alpha${"x".repeat(24 * 1024 * 1024)}`, encoding: "utf8", seq: 1 } };
    const big = await open("large-search");
    await search(big, "alpha");
    assert.equal(await big.locator(".search-hit").count(), 2);
    await big.locator(".search-group").filter({ hasText: "large.txt" }).getByRole("button", { name: "Replace…", exact: true }).click();
    await big.getByRole("dialog").waitFor();
    assert.equal(await big.getByRole("button", { name: "Apply replacements", exact: true }).isDisabled(), true);
    assert.equal(await big.evaluate(() => window.monaco.editor.getModels().length), 1);
    await big.context().close();

    const scope = await open("scope-search");
    await search(scope, "alpha");
    await scope.getByLabel("In folder", { exact: true }).selectOption("src");
    await scope.waitForFunction(() => document.querySelectorAll(".search-hit").length === 4);
    delete fixture("scope-search").files["src/one.py"];
    delete fixture("scope-search").files["src/nested/two.txt"];
    nudge("scope-search");
    await scope.waitForFunction(() => document.querySelector(".search-status").textContent.includes("no longer available"));
    await scope.context().close();

    const revoked = await open("revoked-search");
    await search(revoked, "alpha"); await preview(revoked, "forbidden");
    roles.set("revoked-search", "viewer"); nudge("revoked-search");
    await revoked.waitForFunction(() => window.__pad.role() === "viewer");
    await revoked.getByRole("button", { name: "Apply replacements", exact: true }).click();
    await revoked.waitForFunction(() => document.querySelector("dialog").textContent.includes("Replacement stopped"));
    assert.equal(await revoked.evaluate(() => window.__pad.text("main.py")), "print('alpha')\n");
    await revoked.context().close();

    const single = await open("single-search");
    await search(single, "alpha");
    await single.locator(".search-replace summary").click();
    await single.getByRole("textbox", { name: "Replacement text" }).fill("single");
    await single.locator(".search-group").filter({ has: single.locator("strong", { hasText: "main.py" }) }).getByRole("button", { name: "Replace…", exact: true }).click();
    await single.getByRole("button", { name: "Apply replacements", exact: true }).click();
    await single.getByRole("button", { name: "Done", exact: true }).waitFor();
    assert.equal(await single.evaluate(() => window.__pad.text("main.py")), "print('single')\n");
    assert.equal(await single.evaluate(() => window.__pad.text("src/nested/two.txt")), "alpha\n");
    await single.getByRole("button", { name: "Done", exact: true }).click();
    await single.getByRole("searchbox").fill("alpha");
    await single.getByRole("searchbox").fill("no-such-match");
    await single.waitForFunction(() => document.querySelector(".search-status").textContent === "No results.");
    await single.waitForTimeout(200);
    assert.equal(await single.locator(".search-hit").count(), 0);
    await single.context().close();
    console.log("ok   read-only file search, removed scopes, revoked access, one-file replacement, stale responses");

    viewer = true;
    const read = await open("viewer-search");
    await search(read, "alpha");
    assert.equal(await read.locator(".search-replace").isVisible(), false);
    assert.ok(await read.locator(".search-hit").count());
    await read.context().close(); viewer = false;

    const failed = await open("failed-save");
    await search(failed, "alpha"); await preview(failed, "");
    failWrites = true;
    await failed.getByRole("button", { name: "Apply replacements", exact: true }).click();
    await failed.getByRole("button", { name: "Done", exact: true }).waitFor();
    await failed.waitForFunction(() => document.querySelector("#status")?.dataset.status === "error");
    assert.ok(await failed.evaluate(() => Object.keys(localStorage).some((k) => k.includes(location.pathname.slice(1)) && localStorage.getItem(k).includes("main.py"))));
    failWrites = false;
    await failed.context().close();
    console.log("ok   500-file cap, viewer search, editor-only replace and save failure");
  }

  const mobile = await open(name, { width: 390, height: 844 });
  await mobile.locator(".search-mobile").click();
  assert.equal(await mobile.getByRole("searchbox").evaluate((node) => node === document.activeElement), true);
  const touchTarget = await mobile.locator(".side-head .search-toggle").boundingBox();
  assert.ok(touchTarget.width >= 44 && touchTarget.height >= 44);
  await mobile.getByRole("searchbox").fill("shared");
  await mobile.waitForFunction(() => document.querySelectorAll(".search-hit").length > 0);
  await mobile.locator("#drawer-close").focus();
  // Last focusable control wraps back into the drawer, including the query input.
  await mobile.getByRole("searchbox").focus(); await mobile.keyboard.press("Shift+Tab");
  assert.ok(await mobile.evaluate(() => document.querySelector("#sidebar").contains(document.activeElement)));
  await mobile.keyboard.press("Escape");
  assert.equal(await mobile.locator("#sidebar").isVisible(), false);
  await mobile.locator(".search-mobile").click();
  await mobile.locator(".search-hit").first().click();
  assert.equal(await mobile.locator("#sidebar").isVisible(), false);
  await mobile.locator(".search-mobile").click();
  await mobile.screenshot({ path: join(process.env.TMPDIR ?? process.env.TEMP ?? "/tmp", "ajar-search-mobile.png") });
  await search(page, "shared");
  await page.screenshot({ path: join(process.env.TMPDIR ?? process.env.TEMP ?? "/tmp", "ajar-search-desktop.png") });
  console.log(`ok   mobile entry point, focus and drawer navigation (${browserType.name()}, ${process.platform})`);
  assert.deepEqual(errors, []);
} catch (e) {
  console.error("Page errors:", errors);
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error(await page.locator(".search-status, #status, dialog[open]").allTextContents());
  }
  throw e;
} finally {
  await browser.close();
  for (const socket of wss.clients) socket.terminate();
  for (const socket of upgraded) socket.destroy();
  wss.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}

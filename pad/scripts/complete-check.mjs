#!/usr/bin/env node
// Suggestions in the pad, as a person meets them.
//
//   npm run build:pad && node pad/scripts/complete-check.mjs
//
// Needs the model in pad/public/packages (packages/complete/scripts/
// install-model.mjs) and skips without it, as a deploy without it has no
// Suggest switch. What it holds the pad to:
//
// - Nothing of the model is fetched until the first key typed in the editor.
// - Then it arrives compressed, the switch counts it in, and grey text shows
//   while typing; Tab takes it into the file, which saves as typing does.
// - Grey text is this browser's alone: a second browser on the link sees the
//   file change only when the suggestion is taken.
// - A reload starts it with the editor, from Cache Storage: no model fetched.
// - Switched off, it stays off, across a reload.
//
// Served as the deploy serves it: the production headers and policy, and
// `.zst` copies in place of files, as Caddy's `precompressed` does.
import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = 5203;
const RELAY_PORT = 8846;
if (!existsSync(join(ROOT, "packages/ajar-complete.json"))) {
  console.log("skipped: no model in the build — packages/complete/scripts/install-model.mjs, then npm run build:pad");
  process.exit(0);
}
const IMPORTMAP_SHA = createHash("sha256")
  .update(/<script type="importmap">(.*?)<\/script>/s.exec(await readFile(join(ROOT, "index.html"), "utf8"))[1].replace(/\r\n?/g, "\n"))
  .digest("base64");
const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".js": "text/javascript", ".mjs": "text/javascript", ".ttf": "font/ttf",
};

const padDir = await mkdtemp(join(tmpdir(), "ajar-pad-complete-"));
const relay = spawn(fileURLToPath(new URL("../../target/debug/ajar-relay", import.meta.url)), ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", padDir], { stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}

/** Bytes sent per path, as they went on the wire. */
const sent = new Map();
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'", `script-src 'self' 'unsafe-eval' blob: 'sha256-${IMPORTMAP_SHA}'`, "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self' data:", "connect-src 'self' ws: wss: https:",
    "frame-ancestors 'none'", "base-uri 'none'",
  ].join("; "));
  const path = new URL(req.url, "http://x").pathname;
  if (path.startsWith("/api/")) {
    const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    return req.pipe(up);
  }
  const relative = path.split("/").filter((p) => p && p !== "." && p !== "..").join("/");
  let file = join(ROOT, relative || "index.html");
  if (!existsSync(file) || !extname(file)) file = join(ROOT, "index.html");
  res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
  res.setHeader("Cache-Control", /^\/(assets|packages)\//.test(path) && !path.endsWith(".json") ? "public, max-age=31536000, immutable" : "no-cache");
  let body = file;
  if (String(req.headers["accept-encoding"] ?? "").includes("zstd") && existsSync(`${file}.zst`)) {
    res.setHeader("Content-Encoding", "zstd");
    body = `${file}.zst`;
  }
  const data = await readFile(body);
  sent.set(path, (sent.get(path) ?? 0) + data.length);
  res.end(data);
});
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers });
  up.on("upgrade", (r, upSocket, upHead) => {
    upSocket.on("error", () => upSocket.destroy());
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  up.on("error", () => socket.destroy());
  if (head?.length) up.write(head);
  up.end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${PORT}`;

const results = [];
const ok = (m) => results.push(`ok   ${m}`);
const fail = (m) => results.push(`FAIL ${m}`);
const is = (a, b, m) => (a === b ? ok(m) : fail(`${m} — got ${JSON.stringify(a)}`));
const modelFile = JSON.parse(await readFile(join(ROOT, "packages/ajar-complete.json"), "utf8")).model.file;
const modelFetches = () => sent.get(`/packages/${modelFile}`) ?? 0;

const browser = await chromium.launch({
  channel: process.env.PAD_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
});
const context = await browser.newContext();
const page = await context.newPage();
page.on("pageerror", (e) => fail(`page error: ${e.message.slice(0, 160)}`));
page.on("console", (m) => {
  if (/Content Security Policy|Refused to/i.test(m.text())) fail(`CSP blocked: ${m.text().slice(0, 200)}`);
});
const ghost = (p) => p.evaluate(() => document.querySelector("#editor .ghost-text-decoration")?.textContent ?? "");
const editorText = (p) => p.evaluate(() => window.monaco.editor.getEditors()[0]?.getModel()?.getValue() ?? "");

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => location.pathname.length > 1, null, { timeout: 15_000 });
  const name = await page.evaluate(() => location.pathname.slice(1));
  await page.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await page.waitForSelector("#suggest", { state: "visible", timeout: 30_000 });
  await page.waitForTimeout(2000);
  is(modelFetches(), 0, "nothing of the model is fetched before a key is typed");
  is(await page.getAttribute("#suggest", "aria-pressed"), "true", "the Suggest switch is there, on");

  // The end of the starter file, and a function to write there.
  await page.click("#editor .view-lines");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("suggest")?.title.startsWith("Suggestions on: Tab"), null, { timeout: 120_000 })
    .then(() => ok(`the model arrives after the first key — ${(modelFetches() / 1e6).toFixed(2)} MB on the wire`))
    .catch(async () => fail(`the model never became ready: ${await page.getAttribute("#suggest", "title")}`));
  is(modelFetches() > 0 && modelFetches() < 18e6, true, "the model is sent compressed");

  const lines = ["def mean(values):", "return sum(values) / len(values)", "", "", "def median(values):", "ordered = sorted(values)", "middle = len(ordered) // 2", "return ordered[middle]"];
  let shown = 0;
  let taken = "";
  const peer = await browser.newContext().then((c) => c.newPage());
  await peer.goto(`${ORIGIN}/${name}`, { waitUntil: "domcontentloaded" });
  await peer.waitForSelector(".monaco-editor", { timeout: 30_000 });
  for (const line of lines) {
    let i = 0;
    // Monaco indents a new line itself.
    const auto = await page.evaluate(() => { const e = window.monaco.editor.getEditors()[0]; return e.getModel().getLineContent(e.getPosition().lineNumber).length; });
    i = line.length - line.trimStart().length;
    if (auto > i) for (let k = i; k < auto; k++) await page.keyboard.press("Backspace");
    while (i < line.length) {
      await page.waitForTimeout(120);
      const g = await ghost(page);
      if (g) shown++;
      if (g && line.slice(i).startsWith(g) && !taken) {
        // Grey text is not in the file, here or for the other browser.
        const before = await editorText(page);
        is(before.includes(line.slice(0, i) + g), false, "grey text is not in the document before Tab");
        await page.keyboard.press("Tab");
        taken = g;
        i += g.length;
        await page.waitForTimeout(150);
        const after = await editorText(page);
        is(after.includes(line.slice(0, i)), true, `Tab takes the suggestion into the file ("${g}")`);
        continue;
      }
      await page.keyboard.type(line[i]);
      i++;
    }
    await page.keyboard.press("Enter");
  }
  is(shown > 0, true, `grey text shows while typing (${shown} times over ${lines.join("").length} characters)`);
  is(taken !== "", true, "at least one suggestion matched what was being typed, and was taken");
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "done", null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const stored = await fetch(`${ORIGIN}/api/pad/${name}`).then((r) => r.json());
  const mainFile = Object.values(stored.files ?? {}).find((f) => (f.content ?? "").includes("def median"));
  is(!!mainFile && mainFile.content.includes("return ordered[middle]"), true, "what was typed and taken is saved");
  const synced = await peer.waitForFunction(() => window.monaco.editor.getEditors()[0]?.getModel()?.getValue().includes("return ordered[middle]"), null, { timeout: 20_000 })
    .then(() => true, () => false);
  is(synced, true, "the other browser has the file as typed, suggestion taken included");
  is(await ghost(peer), "", "and no grey text of the first browser's");

  // A reload: the model from Cache Storage, with the editor, before any key.
  const fetched = modelFetches();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await page.waitForFunction(() => document.getElementById("suggest")?.title.startsWith("Suggestions on: Tab"), null, { timeout: 30_000 })
    .then(() => ok("after a reload it is ready before any key is typed"))
    .catch(() => fail("after a reload it did not start with the editor"));
  is(modelFetches(), fetched, "and the model was not fetched again");

  // Off, and off it stays.
  await page.click("#suggest");
  is(await page.getAttribute("#suggest", "aria-pressed"), "false", "the switch turns suggestions off");
  await page.click("#editor .view-lines");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("def mode(values):\n");
  await page.keyboard.type("return max(set(values), key=values.co", { delay: 80 });
  await page.waitForTimeout(500);
  is(await ghost(page), "", "switched off, no grey text while typing");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#suggest", { state: "visible", timeout: 30_000 });
  is(await page.getAttribute("#suggest", "aria-pressed"), "false", "and it is still off after a reload");
} catch (e) {
  fail(`threw: ${e.message}`);
} finally {
  await browser.close();
  server.close();
  relay.kill();
  await rm(padDir, { recursive: true, force: true });
}
for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);

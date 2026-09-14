#!/usr/bin/env node
// The preview, driven the way a person would: start a server in the terminal,
// press Preview, and read what the iframe shows.
//
//   VITE_PREVIEW_ORIGIN=http://127.0.0.1:5251 npx vite build
//   node scripts/preview-check.mjs
//
// Two origins, because the SDK requires it and because a page serving whatever
// someone ran in their folder must not be able to script the pad.

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = new URL("../dist/", import.meta.url).pathname;
const VENDOR = join(ROOT, "vendor/wasmer/dist");
const PORT = 5250, HOST_PORT = 5251, RELAY_PORT = 8844;
const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".wasm": "application/wasm", ".webc": "application/webc",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
};

const padDir = await mkdtemp(join(tmpdir(), "ajar-preview-"));
const relay = spawn("../target/debug/ajar-relay",
  ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", padDir],
  { stdio: "ignore" });
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 100));
}

const pad = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (req.url.startsWith("/api/") || req.url === "/ws") {
    const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    return req.pipe(up);
  }
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = join(ROOT, path === "/" ? "index.html" : path);
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.setHeader("Content-Type", "text/html");
    res.end(await readFile(join(ROOT, "index.html")));
  }
});
await new Promise((r) => pad.listen(PORT, r));

const host = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  try {
    if (path === "/.wasmer/host.html") {
      res.setHeader("Content-Type", "text/html");
      return res.end('<!doctype html><meta charset="utf-8"><script type="module" src="/wasmer-host.js"></script>');
    }
    if (path === "/wasmer-host.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(await readFile(join(VENDOR, "service-worker-host.js")));
    }
    if (path === "/wasmer-service-worker.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.setHeader("Service-Worker-Allowed", "/");
      return res.end(await readFile(join(VENDOR, "service-worker.js")));
    }
    res.statusCode = 404; res.end("no preview is running");
  } catch (e) { res.statusCode = 500; res.end(String(e)); }
});
await new Promise((r) => host.listen(HOST_PORT, r));

const results = [];
const ok = (m) => { results.push(true); console.log(`  ok    ${m}`); };
const fail = (m) => { results.push(false); console.log(`  FAIL  ${m}`); };

const SERVER = [
  "import socket",
  "s = socket.socket()",
  "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
  "s.bind(('127.0.0.1', 8000))",
  "s.listen(8)",
  "print('serving on 8000', flush=True)",
  "while True:",
  "    c, _ = s.accept()",
  "    c.recv(65536)",
  "    body = b'<h1>hello from my folder</h1>'",
  "    c.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Type: text/html\\r\\nContent-Length: %d\\r\\nConnection: close\\r\\n\\r\\n' % len(body) + body)",
  "    c.close()",
].join("\n");

const name = `preview-${Date.now()}`;
await fetch(`http://127.0.0.1:${RELAY_PORT}/api/pad/${name}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ writes: [{ path: "serve.py", content: SERVER }] }),
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log(`      pageerror: ${e.message.slice(0, 160)}`));
page.on("console", (m) => m.type() === "error" && console.log(`      console: ${m.text().slice(0, 160)}`));
await page.goto(`http://127.0.0.1:${PORT}/${name}`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.locator(".xterm").first().click();

await page.keyboard.type("echo warm\n");
await page.waitForFunction(() => (document.querySelector(".xterm-screen")?.innerText ?? "").includes("warm"),
  { timeout: 300_000 });
await page.waitForTimeout(5000);

(await page.locator("#preview").isHidden())
  ? ok("the Preview button is hidden while nothing is listening")
  : fail("the Preview button showed before anything listened");

// Typed through the shell the first time, which mangled it: the script goes
// through a JS string, then printf, then bash. Seeded through the API instead,
// so the only thing the terminal does is run it.
// Written through base64 rather than typed or seeded. Typing it put the
// script through a JS string, printf and bash and mangled it; seeding it
// through the store leaves the file present but empty in the sandbox, which
// is a real bug recorded in docs/open-points.md and not this check's subject.
// base64 has no characters any of those layers care about.
const encoded = Buffer.from(SERVER, "utf8").toString("base64");
await page.keyboard.type(`echo ${encoded} | base64 -d > serve.py\n`);
await page.waitForTimeout(5000);
await page.keyboard.type("python3 serve.py\n");

try {
  await page.waitForSelector("#preview:not([hidden])", { timeout: 60_000 });
  ok("the Preview button appears when something starts listening");
} catch {
  fail("the Preview button never appeared");
  const screen = await page.evaluate(() => document.querySelector(".xterm-screen")?.innerText ?? "");
  console.log("\n  --- terminal ---");
  console.log(screen.split("\n").filter((l) => l.trim()).slice(-12).map((l) => "      " + l).join("\n"));
  const errs = await page.evaluate(() => (window.__padErrors ?? []));
  if (errs.length) console.log(`  page errors: ${JSON.stringify(errs.slice(0, 3))}`);
  await browser.close(); pad.close(); host.close(); relay.kill();
  await rm(padDir, { recursive: true, force: true });
  process.exit(1);
}

await page.click("#preview");
await page.waitForTimeout(12_000);
const frames = page.frames().filter((f) => f !== page.mainFrame() && !f.url().includes("/.wasmer/"));
let body = "";
for (const f of frames) body ||= await f.evaluate(() => document.body?.innerText ?? "").catch(() => "");
body.includes("hello from my folder")
  ? ok("the preview shows what the folder's own server returned")
  : fail(`the preview showed ${JSON.stringify(body.slice(0, 120))}`);

(await page.locator("#editor").isHidden())
  ? ok("the editor gives up its space while previewing")
  : fail("the editor stayed visible behind the preview");

await page.click("#preview");
await page.waitForTimeout(1500);
(await page.locator("#editor").isVisible())
  ? ok("pressing it again returns to the editor")
  : fail("the editor did not come back");

await browser.close(); pad.close(); host.close(); relay.kill();
await rm(padDir, { recursive: true, force: true });
const bad = results.filter((r) => !r).length;
console.log(bad ? `\n  ${bad} failed` : "\n  the preview works");
process.exitCode = bad ? 1 : 0;

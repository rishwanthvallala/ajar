#!/usr/bin/env node
// The preview, driven the way a person would: start a server in the terminal,
// press Preview, and read what the iframe shows.
//
//   VITE_PREVIEW_ORIGIN=http://127.0.0.1:5251 npx vite build
//   node scripts/preview-check.mjs
//
// Against the deployed site instead, where the two origins are already there
// and the build being driven is the one users get:
//
//   PAD_ORIGIN=https://code.rishwanth.dev node scripts/preview-check.mjs
//
// Two origins, because the SDK requires it and because a page serving whatever
// someone ran in their folder must not be able to script the pad.

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

// Against the deployed site nothing local is involved: no relay to spawn, no
// dist to serve, and the preview origin is already a real host. Without this
// the check quietly served the local build whatever PAD_ORIGIN said, so asking
// it about production told you about your working copy.
const LIVE = process.env.PAD_ORIGIN ?? null;

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const VENDOR = join(ROOT, "vendor/wasmer/dist");
const PORT = 5250, HOST_PORT = 5251, RELAY_PORT = 8844;
// The build has the preview origin compiled into it, so a dist built for
// somewhere else fails here as a bare CSP violation in the console — the
// production build refuses to be framed by 127.0.0.1, and correctly so. That
// reads as a broken preview rather than the wrong bundle, and cost a round of
// chasing after a deploy left a production dist on disk. Checked up front.
if (!LIVE) {
  const { readdir } = await import("node:fs/promises");
  const assets = join(ROOT, "assets");
  const names = await readdir(assets).catch(() => []);
  let found = false;
  for (const f of names.filter((f) => f.endsWith(".js"))) {
    if ((await readFile(join(assets, f), "utf8")).includes(`127.0.0.1:${HOST_PORT}`)) {
      found = true;
      break;
    }
  }
  if (!found) {
    console.error(
      `\n  the build in dist/ is not the one this check drives.\n` +
      `  it has to know the preview origin, which is compiled in:\n\n` +
      `      VITE_PREVIEW_ORIGIN=http://127.0.0.1:${HOST_PORT} npx vite build\n`,
    );
    process.exit(2);
  }
}

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".wasm": "application/wasm", ".webc": "application/webc",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
};

const padDir = await mkdtemp(join(tmpdir(), "ajar-preview-"));
const relay = LIVE ? null : spawn("../target/debug/ajar-relay",
  ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", padDir],
  { stdio: "ignore" });
if (!LIVE) {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
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
if (!LIVE) await new Promise((r) => pad.listen(PORT, r));
const ORIGIN = LIVE ?? `http://127.0.0.1:${PORT}`;

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
if (!LIVE) await new Promise((r) => host.listen(HOST_PORT, r));

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
await fetch(`${ORIGIN}/api/pad/${name}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ writes: [{ path: "serve.py", content: SERVER }] }),
});

const browser = await chromium.launch({
  channel: process.env.PAD_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log(`      pageerror: ${e.message.slice(0, 160)}`));
page.on("console", (m) => m.type() === "error" && console.log(`      console: ${m.text().slice(0, 160)}`));
await page.goto(`${ORIGIN}/${name}`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.locator(".xterm").first().click();

await page.keyboard.type("echo warm\n");
await page.waitForFunction(() => (document.querySelector(".xterm-screen")?.innerText ?? "").includes("warm"),
  { timeout: 300_000 });
await page.waitForTimeout(5000);

(await page.locator("#preview").isHidden())
  ? ok("the Preview button is hidden while nothing is listening")
  : fail("the Preview button showed before anything listened");

// Written through base64 rather than typed. Typing put the script through a
// JS string, then printf, then bash, and each one had an opinion about the
// quotes and backslashes in it. base64 has no characters any of those layers
// care about, so what reaches the file is what was meant.
//
// It used to be seeded through the store instead, until that turned out to
// leave the file empty in the sandbox — the seeding bug fixed on 15 September.
// Writing it here keeps this check about the preview rather than about that.
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
  await browser.close(); pad.close(); host.close(); relay?.kill();
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

await browser.close(); pad.close(); host.close(); relay?.kill();
await rm(padDir, { recursive: true, force: true });
const bad = results.filter((r) => !r).length;
console.log(bad ? `\n  ${bad} failed` : "\n  the preview works");
process.exitCode = bad ? 1 : 0;

#!/usr/bin/env node
// Prove a process inside the sandbox can serve HTTP to the page.
//
//   npx vite build && node scripts/ingress-check.mjs        # a working server
//   node scripts/ingress-check.mjs http                     # python's http.server, which faults
//
// Two origins, because `ports.expose()` requires it: the pad, and a standalone
// HTTP host serving `/.wasmer/host.html` and `/wasmer-service-worker.js`. The
// host must send Cross-Origin-Embedder-Policy on its own documents — the pad
// is require-corp, so an embedded document without it is refused and the SDK
// reports only "did not become ready".
//
// See docs/dev/networking.md.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = new URL("../dist/", import.meta.url).pathname;
const VENDOR = join(ROOT, "vendor/wasmer/dist");
const PORT = 5240;
const HOST_PORT = 5241;
const WHICH = process.argv[2] ?? "raw";
const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".wasm": "application/wasm", ".webc": "application/webc",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
};

const pad = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = join(ROOT, path === "/" ? "index.html" : path);
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((r) => pad.listen(PORT, r));

const host = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (path === "/.wasmer/host.html") {
      res.setHeader("Content-Type", "text/html");
      return res.end('<!doctype html><meta charset="utf-8"><script type="module" src="/host.js"></script>');
    }
    if (path === "/host.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(await readFile(join(VENDOR, "service-worker-host.js")));
    }
    if (path === "/wasmer-service-worker.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.setHeader("Service-Worker-Allowed", "/");
      return res.end(await readFile(join(VENDOR, "service-worker.js")));
    }
    res.statusCode = 404;
    res.end("not the host's file");
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});
await new Promise((r) => host.listen(HOST_PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage();
const noise = [];
page.on("console", (m) => m.type() === "error" && noise.push(m.text().slice(0, 160)));
page.on("pageerror", (e) => noise.push(`pageerror: ${e.message.slice(0, 160)}`));

console.log(`  serving with: ${WHICH}\n`);
await page.goto(
  `http://127.0.0.1:${PORT}/net.html?server=${WHICH}&host=${encodeURIComponent(`http://127.0.0.1:${HOST_PORT}`)}`,
  { waitUntil: "domcontentloaded" },
);
await page.waitForFunction(() => window.__done === true, null, { timeout: 180_000 }).catch(() => {});
for (const s of await page.evaluate(() => window.__steps ?? [])) {
  console.log(`  ${s.stage.padEnd(9)} ${s.detail}`);
}

// Read the iframe, not a separate page: `activeRoute` is module state in the
// service worker and an idle worker is killed, so a second tab finds no route
// and falls through to the origin server — which reads as a 404 from nowhere.
const frames = page.frames().filter((f) => f !== page.mainFrame() && !f.url().includes("/.wasmer/"));
let served = null;
for (const f of frames) {
  served = await f.evaluate(() => document.body?.innerText ?? "").catch((e) => `unreadable: ${e}`);
  console.log(`\n  route    ${f.url()}`);
  console.log(`  body     ${JSON.stringify((served ?? "").slice(0, 200))}`);
}
if (noise.length) {
  console.log("\n  page errors:");
  for (const n of [...new Set(noise)].slice(0, 4)) console.log(`    ${n}`);
}

const ok = served?.includes("served from the sandbox");
console.log(ok ? "\n  the sandbox served the page" : "\n  the sandbox did not serve");
await browser.close();
pad.close();
host.close();
process.exitCode = ok ? 0 : 1;

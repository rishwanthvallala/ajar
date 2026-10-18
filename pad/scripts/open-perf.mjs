#!/usr/bin/env node
// A pad of 500 files opened through a real relay, and timed: to the editor
// showing its first file, to the page being ready, and to a typed command in
// the sandbox answering — with how many editor models it made, its long
// tasks, its heap, and what it read. A measurement, not a check;
// docs/dev/pad.md has the numbers it gave.
//
//   cargo build && npx vite build && node scripts/open-perf.mjs [small|big] [fast|slow]
//
// small is 500 files of 2.4 KB, big 500 of 165 KB (78 MB). slow is Chromium's
// own throttles — the network at 20 Mbit/s with 80 ms of latency, the CPU four
// times slower — with the pad's reads gzipped, as Caddy sends them. Each run
// is a return visit: the pad is opened once first, unthrottled and as far as
// the sandbox, so the page and the runtime are cached as a returning
// visitor's are. DIST points at another build.
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const { chromium } = createRequire(`${REPO}web/package.json`)("playwright");
const ROOT = process.env.DIST ?? `${REPO}pad/dist/`;
const PORT = 5262, RELAY_PORT = 8893;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SIZE = process.argv[2] ?? "small";
const SLOW = process.argv[3] === "slow";

const dir = await mkdtemp(join(tmpdir(), "pad-open-perf-"));
const relay = spawn(`${REPO}target/debug/ajar-relay`, ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", join(dir, "pads"), "--accounts-db", join(dir, "a.db")], { stdio: "ignore", env: { ...process.env, AJAR_PUBLIC_ORIGIN: ORIGIN } });
process.on("exit", () => relay.kill());
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
const TYPES = { ".html": "text/html", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".webc": "application/webc", ".ttf": "font/ttf" };
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const urlPath = new URL(req.url, "http://x").pathname;
  if (urlPath.startsWith("/api/")) {
    const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
      if (SLOW && req.method === "GET" && /json/.test(r.headers["content-type"] ?? "")) {
        const headers = { ...r.headers, "content-encoding": "gzip" };
        delete headers["content-length"];
        res.writeHead(r.statusCode ?? 502, headers);
        return r.pipe(createGzip({ level: 4 })).pipe(res);
      }
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    return req.pipe(up);
  }
  if (urlPath === "/sw.js") res.setHeader("Service-Worker-Allowed", "/");
  // Hashed, so kept, as Caddy serves them.
  if (urlPath.startsWith("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  const rel = urlPath.split("/").filter((p) => p && p !== "." && p !== "..").join("/");
  const file = join(ROOT, rel || "index.html");
  try { const body = await readFile(file); res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream"); res.end(body); }
  catch { res.setHeader("Content-Type", "text/html"); res.end(await readFile(join(ROOT, "index.html"))); }
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
await new Promise((r) => server.listen(PORT, r));

// A project's worth of files in folders, of the kinds a pad holds.
const name = `open-${SIZE}`;
const LINES = SIZE === "big" ? 4000 : 60;
const kinds = ["py", "py", "py", "js", "ts", "md", "json", "html", "css", "txt"];
const writes = [];
for (let i = 0; i < 500; i++) {
  const ext = kinds[i % kinds.length];
  const path = `${i === 0 ? "" : `pkg${Math.floor(i / 40)}/sub${Math.floor(i / 10) % 4}/`}file${i}.${ext}`;
  const lines = [];
  for (let l = 0; l < LINES; l++) {
    if (ext === "py") lines.push(l % 6 === 0 ? `def f${i}_${l}(x, y=${l}):` : `    return x * y + ${l}  # line ${l} of ${i}`);
    else if (ext === "js" || ext === "ts") lines.push(`export function f${i}_${l}(x) { return x * ${l}; } // ${i}`);
    else if (ext === "md") lines.push(l % 10 === 0 ? `## Section ${l}` : `Some *text* on line ${l} of file ${i}, with \`code\`.`);
    else if (ext === "json") lines.push(`  "k${l}": ${l},`);
    else if (ext === "html") lines.push(`<div class="c${l}"><p>line ${l} of ${i}</p></div>`);
    else if (ext === "css") lines.push(`.c${l} { margin: ${l}px; }`);
    else lines.push(`plain line ${l} of ${i}`);
  }
  const body = `${lines.join("\n")}\n`;
  writes.push({ path, content: ext === "json" ? `{\n${body}  "end": true\n}\n` : body });
}
// In parts: one request carries at most what the relay takes in one.
for (let i = 0; i < writes.length; i += 25) {
  const put = await fetch(`http://127.0.0.1:${RELAY_PORT}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: writes.slice(i, i + 25) }) });
  if (!put.ok) throw new Error(`the pad was not made: ${put.status} ${await put.text()}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
let leaks = 0;
page.on("console", (m) => { if (/listener LEAK/.test(m.text())) leaks++; });
page.on("pageerror", (e) => console.error(`page error: ${e.message.slice(0, 200)}`));
await page.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true });
  window.__marks = {};
  const watch = () => {
    const now = Math.round(performance.now());
    if (!window.__marks.editor && window.monaco?.editor.getEditors()[0]?.getModel()?.getValueLength() > 0) window.__marks.editor = now;
    if (!window.__marks.ready && window.__pad) window.__marks.ready = now;
    if (!(window.__marks.editor && window.__marks.ready)) requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
});
const opened = () => page.waitForFunction(() => window.__pad && window.monaco?.editor.getEditors()[0]?.getModel(), null, { timeout: 300_000 });
const counted = async () => {
  await page.click("#terminal");
  await page.keyboard.type("find . -name 'file*' | wc -l");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /\n\s*500\s*\n/.test(document.querySelector("#terminal .xterm-rows")?.innerText ?? ""), null, { timeout: 300_000 });
};
// The first visit, unthrottled and as far as the sandbox, so the one
// measured finds the page and the runtime cached.
await page.goto(`${ORIGIN}/${name}`);
await opened();
await counted();
await page.goto("about:blank");
leaks = 0;
const cdp = await context.newCDPSession(page);
if (SLOW) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 20e6 / 8, uploadThroughput: 10e6 / 8 });
}

const t0 = Date.now();
await page.goto(`${ORIGIN}/${name}`);
await opened();
await cdp.send("HeapProfiler.collectGarbage");
const heap = Math.round((await cdp.send("Runtime.getHeapUsage")).usedSize / 1048576);
await counted();
const terminal = Date.now() - t0;
const seen = await page.evaluate(() => ({
  marks: window.__marks,
  models: window.monaco.editor.getModels().length,
  long: window.__long,
  reads: performance.getEntriesByType("resource").filter((e) => /\/api\/pad\/[^/]+$/.test(e.name)).map((e) => `${Math.round(e.startTime)}–${Math.round(e.responseEnd)} ms, ${(e.encodedBodySize / 1048576).toFixed(1)} MB`),
}));
console.log(JSON.stringify({
  size: SIZE,
  slow: SLOW,
  editorMs: seen.marks.editor,
  readyMs: seen.marks.ready,
  terminalMs: terminal,
  models: seen.models,
  leakWarnings: leaks,
  heapMB: heap,
  longTasks: seen.long.length,
  longestTaskMs: Math.max(0, ...seen.long),
  padReads: seen.reads,
}));
await browser.close();
server.close();
relay.kill();
process.exit(0);

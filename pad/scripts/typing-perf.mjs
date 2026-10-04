#!/usr/bin/env node
// Two browsers on one pad, a real relay between them: one types in a long
// file, and both pages are watched for stalls — long tasks, and how late a
// 50 ms timer fires. A measurement, not a check; docs/dev/pad.md has the
// numbers it gave.
//
//   cargo build && npx vite build && node scripts/typing-perf.mjs [lines] [steady|bursts]
//
// steady types 200 characters at 20 a second; bursts types 10 at a time with
// a 0.7 s pause after each, which is when saves happen.
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { createRequire } from "node:module";

import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const { chromium } = createRequire(`${REPO}web/package.json`)("playwright");
const ROOT = `${REPO}pad/dist/`;
const PORT = 5240, RELAY_PORT = 8890;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const LINES = Number(process.argv[2] ?? 100000);
const MODE = process.argv[3] ?? "steady";

const dir = await mkdtemp(join(tmpdir(), "pad-perf-"));
const relay = spawn(`${REPO}target/debug/ajar-relay`, ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", join(dir, "pads"), "--accounts-db", join(dir, "a.db")], { stdio: "ignore", env: { ...process.env, AJAR_PUBLIC_ORIGIN: ORIGIN } });
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
const TYPES = { ".html": "text/html", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".webc": "application/webc" };
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const urlPath = new URL(req.url, "http://x").pathname;
  if (urlPath.startsWith("/api/")) {
    const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => res.writeHead(502).end());
    return req.pipe(up);
  }
  if (urlPath === "/sw.js") res.setHeader("Service-Worker-Allowed", "/");
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

const name = `perf-${LINES}-${MODE}`;
const big = Array.from({ length: LINES }, (_, i) => `def f${i}(x):\n    return x * ${i}  # line ${i}\n`).join("").slice(0, LINES * 40);
await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: "big.py", content: big }, { path: "main.py", content: "print(1)\n" }] }) });

const browser = await chromium.launch();
async function open(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`${label} page error: ${e.message}`));
  await page.goto(`${ORIGIN}/${name}`);
  await page.waitForFunction(() => window.__pad && window.monaco, null, { timeout: 60_000 });
  await page.click('#files .row.file[data-path="big.py"]');
  await page.waitForFunction(() => window.__pad.active() === "big.py" && window.__pad.docs().includes("big.py"), null, { timeout: 60_000 });
  // The runtime up, so its writes are part of what is measured.
  await page.click("#terminal");
  await page.keyboard.type("echo ready");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /\nready/.test(document.querySelector("#terminal .xterm-rows")?.innerText ?? ""), null, { timeout: 240_000 });
  return page;
}
const a = await open("A");
const b = await open("B");
await b.waitForTimeout(1500);

const probe = () => {
  window.__long = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ["longtask"] });
  window.__lag = [];
  window.__probing = true;
  const tick = () => {
    const due = performance.now() + 50;
    setTimeout(() => { window.__lag.push(performance.now() - due); if (window.__probing) tick(); }, 50);
  };
  tick();
};
await b.evaluate(probe);
await a.evaluate(probe);
await a.evaluate(() => {
  const ed = window.monaco.editor.getEditors()[0];
  const model = ed.getModel();
  ed.focus();
  ed.setPosition(model.getPositionAt(Math.floor(model.getValueLength() / 2)));
});
const t0 = Date.now();
const CHARS = 200;
if (MODE === "steady") {
  await a.keyboard.type("x".repeat(CHARS), { delay: 50 });
} else {
  for (let i = 0; i < CHARS / 10; i++) { await a.keyboard.type("y".repeat(10), { delay: 30 }); await a.waitForTimeout(700); }
}
const typed = Date.now() - t0;
const want = await a.evaluate(() => window.__pad.text("big.py"));
await b.waitForFunction((n) => window.__pad.text("big.py").length === n, want.length, { timeout: 60_000 }).catch(() => console.log("B did not converge"));
const ms = Date.now() - t0;
const stop = () => { window.__probing = false; return { long: window.__long, lag: window.__lag }; };
const sum = (r) => {
  const sorted = [...r.lag].sort((x, y) => x - y);
  const q = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
  return { longTasks: r.long.length, longTaskMs: Math.round(r.long.reduce((s, d) => s + d, 0)), lagP50: q(0.5), lagP95: q(0.95), lagMax: Math.round(sorted.at(-1) ?? 0) };
};
const rb = await b.evaluate(stop), ra = await a.evaluate(stop);
// And the stored copy catches up once typing stops.
let storedOk = false;
for (let i = 0; i < 40 && !storedOk; i++) {
  const pad = await (await fetch(`${ORIGIN}/api/pad/${name}`)).json();
  storedOk = pad.files["big.py"]?.content === want;
  if (!storedOk) await new Promise((r) => setTimeout(r, 250));
}
console.log(JSON.stringify({ lines: LINES, mb: +(big.length / 1048576).toFixed(1), mode: MODE, typingS: +(typed / 1000).toFixed(1), convergedS: +(ms / 1000).toFixed(1), typist: sum(ra), watcher: sum(rb), storedOk }));
await browser.close();
server.close();
relay.kill();

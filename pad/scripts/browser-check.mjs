#!/usr/bin/env node
// Runs src/check.ts in a real browser and reports what it found.
//
// This cannot be a node test. The python package fails wasm validation under
// node — `Validate("Unknown validation error")` — and cross-origin isolation,
// which the runtime needs for SharedArrayBuffer, only exists in a browser.
//
//   npx vite build && node scripts/browser-check.mjs

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = 5199;

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".wasm": "application/wasm", ".webc": "application/webc",
  // Every flavour of module script. A browser refuses to execute one served as
  // octet-stream, and reports it as a load failure several frames away from the
  // file that was actually mistyped — which is a long way to travel for a
  // missing table entry.
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
};

// A real relay, with a pad directory of its own. The store checks talk to
// this over HTTP rather than to a stub, because the parts most likely to be
// wrong — reserved names, status codes, the sequence number — live in it.
const RELAY_PORT = 8841;
const padDir = await mkdtemp(join(tmpdir(), "ajar-pad-check-"));
const relay = spawn(
  new URL("../../target/debug/ajar-relay", import.meta.url).pathname,
  ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", padDir],
  { stdio: "ignore" },
);
for (let i = 0; i < 60; i++) {
  const up = await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false);
  if (up) break;
  await new Promise((r) => setTimeout(r, 250));
}

/** Hand `/api/*` to the relay so the page sees one origin. */
function proxy(req, res) {
  const up = httpRequest(
    { host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", () => {
    res.statusCode = 502;
    res.end("relay unreachable");
  });
  req.pipe(up);
}

const server = createServer(async (req, res) => {
  // The same three Caddy sets in production. Without the first two the runtime
  // fails where it is constructed rather than where it is used.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  if (path.startsWith("/api/")) return proxy(req, res);
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

await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  channel: process.env.PAD_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
});
const page = await browser.newPage();
const noise = [];
page.on("pageerror", (e) => noise.push(`pageerror: ${e.message.slice(0, 200)}`));
page.on("requestfailed", (r) => noise.push(`request failed: ${r.url().slice(-60)}`));

let timedOut = false;
await page.goto(`http://127.0.0.1:${PORT}/check.html`, { waitUntil: "domcontentloaded" });
await page
  .waitForFunction(() => (window.__results ?? []).includes("DONE"), { timeout: 180_000 })
  .catch(() => { timedOut = true; });

const results = await page.evaluate(() => window.__results ?? []);
await browser.close();
server.close();
relay.kill();
await rm(padDir, { recursive: true, force: true });

for (const line of results.filter((l) => l !== "DONE")) console.log(`  ${line}`);
for (const n of noise) console.log(`  note: ${n}`);

const failed = results.filter((l) => l.startsWith("FAIL"));
if (timedOut) {
  console.log("\n  the page never finished — see the notes above\n");
  process.exit(1);
}
if (failed.length) {
  console.log(`\n  ${failed.length} check${failed.length === 1 ? "" : "s"} failed\n`);
  process.exit(1);
}
console.log("\n  the runtime holds\n");

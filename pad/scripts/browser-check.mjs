#!/usr/bin/env node
// Runs src/check.ts in a real browser and reports what it found.
//
// This cannot be a node test. The python package fails wasm validation under
// node — `Validate("Unknown validation error")` — and cross-origin isolation,
// which the runtime needs for SharedArrayBuffer, only exists in a browser.
//
//   npx vite build && node scripts/browser-check.mjs

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("../dist/", import.meta.url).pathname;
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

const server = createServer(async (req, res) => {
  // The same three Caddy sets in production. Without the first two the runtime
  // fails where it is constructed rather than where it is used.
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

await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage();
const noise = [];
page.on("pageerror", (e) => noise.push(`pageerror: ${e.message.slice(0, 200)}`));
page.on("requestfailed", (r) => noise.push(`request failed: ${r.url().slice(-60)}`));

let timedOut = false;
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
await page
  .waitForFunction(() => (window.__results ?? []).includes("DONE"), { timeout: 180_000 })
  .catch(() => { timedOut = true; });

const results = await page.evaluate(() => window.__results ?? []);
await browser.close();
server.close();

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

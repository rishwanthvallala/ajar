#!/usr/bin/env node
// The completion lab, driven: load each model asked for, run the test cases,
// and print what each cost to download, how often it was right, and how fast.
//
//   node pad/scripts/fetch-lab.mjs && pad/lab/build-models.sh   # once
//   npx vite build && node scripts/lab-check.mjs [model keys…]   # from pad/
//
// With no keys, the CodeT5 builds. `starcoder` adds the yardstick, which is
// some 320 MB from Hugging Face. PAD_ORIGIN drives the deployed page instead.
//
// Served here as Caddy serves it: cross-origin isolated, the pad's CSP, and
// each file's .zst sent as it is when the browser takes zstd, so the sizes it
// reports are what a visitor downloads. Not in the gate: the runtime and the
// models are fetched and built by hand.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const LIVE = process.env.PAD_ORIGIN ?? null;
const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = 5260;
const KEYS = process.argv.slice(2).length ? process.argv.slice(2) : ["t5-q4e4", "t5-q4", "t5-q8"];
const CSP = "default-src 'self'; script-src 'self' 'unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".json": "application/json", ".js": "text/javascript",
  ".mjs": "text/javascript", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".txt": "text/plain",
};

const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Content-Security-Policy", CSP);
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(ROOT, path === "/" ? "index.html" : path);
  if (!(await stat(file).then((s) => s.isFile()).catch(() => false))) file = join(ROOT, "index.html");
  res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
  const accepts = String(req.headers["accept-encoding"] ?? "");
  for (const [encoding, ext] of [["zstd", ".zst"], ["gzip", ".gz"]]) {
    if (accepts.includes(encoding) && (await stat(file + ext).then(() => true).catch(() => false))) {
      res.setHeader("Content-Encoding", encoding);
      return res.end(await readFile(file + ext));
    }
  }
  res.end(await readFile(file));
});
if (!LIVE) await new Promise((r) => server.listen(PORT, r));
const ORIGIN = LIVE ?? `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("pageerror", (e) => console.log(`  pageerror: ${e.message.slice(0, 200)}`));
page.on("console", (m) => m.type() === "error" && console.log(`  console: ${m.text().slice(0, 200)}`));
await page.goto(`${ORIGIN}/lab.html`, { waitUntil: "load" });
await page.waitForFunction(() => window.__lab, null, { timeout: 30_000 });
console.log(`  ${await page.locator("#env").innerText()}`);

const mb = (n) => (n == null ? "?" : `${(n / 1e6).toFixed(1)} MB`);
for (const key of KEYS) {
  const before = await page.evaluate((k) => window.__lab.status()[k], key);
  if (before?.state === "absent") {
    console.log(`  ${key}: not built here`);
    continue;
  }
  await page.evaluate((k) => window.__lab.load(k), key);
  await page.waitForFunction((k) => ["ready", "failed"].includes(window.__lab.status()[k].state), key, { timeout: 15 * 60_000 });
  const s = await page.evaluate((k) => window.__lab.status()[k], key);
  console.log(s.state === "ready"
    ? `  ${key}: ${mb(s.wire)} on the wire, ${mb(s.size)} unpacked, ready in ${(s.ms / 1000).toFixed(1)} s`
    : `  ${key}: failed to load: ${s.error}`);
}
const runtime = await page.evaluate(() => window.__lab.runtime());
if (runtime.length) {
  const wire = runtime.reduce((n, f) => n + f.transfer, 0);
  const size = runtime.reduce((n, f) => n + f.size, 0);
  console.log(`  the runtime: ${mb(wire)} on the wire, ${mb(size)} unpacked: ${runtime.map((f) => f.name.split("/").pop()).join(", ")}`);
}

const loaded = await page.evaluate(() => Object.entries(window.__lab.status()).filter(([, s]) => s.state === "ready").map(([k]) => k));
if (loaded.length) {
  await page.evaluate(() => window.__lab.run());
  const summary = await page.locator("#results tfoot").innerText();
  const heads = await page.locator("#results thead th").allInnerTexts();
  console.log(`\n  ${heads.slice(2).map((h, i) => `${h}: ${summary.split("\t").slice(1)[i] ?? ""}`).join("\n  ")}`);
  const results = await page.evaluate(() => window.__lab.results());
  for (const [key, cases] of Object.entries(results)) {
    console.log(`\n  ${key}`);
    for (const [name, r] of Object.entries(cases)) console.log(`    ${name.padEnd(18)} ${JSON.stringify(r.text).padEnd(34)} ${r.ms} ms${r.error ? ` (${r.error})` : ""}`);
  }
  await page.screenshot({ path: process.env.LAB_SHOT ?? join(process.env.TMPDIR ?? "/tmp", "lab.png"), fullPage: true });
}

await browser.close();
server.close();

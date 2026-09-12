#!/usr/bin/env node
// Mirror the wasm packages this app actually downloads.
//
// Wasmer's CDN serves `.webc` with no content encoding at all, so python alone
// is 58.9 MB on the wire. The same file from our origin behind zstd is roughly
// a quarter of that, and immutable caching makes a later visit free.
//
// The URLs are *observed*, not derived. An earlier version asked the registry
// for each package's `downloadUrl` and got, for coreutils, a `.tar.gz` the
// runtime never requests — plus it had no way to know about the dependencies a
// package pulls in on its own. Running the app once and recording what it asks
// for cannot be wrong about either.
//
//   npx vite build && node scripts/fetch-packages.mjs

import { createServer } from "node:http";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const OUT = new URL("../public/packages/", import.meta.url);
const ROOT = new URL("../dist/", import.meta.url).pathname;
const PORT = 5201;

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript",
};

// Served without the service worker's mirror, so the run reaches the CDN and
// every URL it wants is visible.
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  if (path === "/sw.js" || path.startsWith("/packages/")) {
    res.statusCode = 404;
    return res.end("not while recording");
  }
  // Just enough store to let the page open. No relay here — this run exists
  // only to watch which packages the runtime reaches for.
  if (path.startsWith("/api/pad/")) {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      req.method === "PUT"
        ? JSON.stringify({ seq: 1 })
        : JSON.stringify({ exists: false, seq: 0, files: {} }),
    );
  }
  const file = join(ROOT, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.setHeader("Content-Type", "text/html");
    res.end(await readFile(join(ROOT, "index.html")));
  }
});
await new Promise((r) => server.listen(PORT, r));

console.log("  recording what the runtime asks for…");
const browser = await chromium.launch();
const page = await browser.newPage();
const wanted = new Set();
page.on("request", (r) => {
  if (r.url().startsWith("https://cdn.wasmer.io/")) wanted.add(r.url());
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".monaco-editor", { timeout: 60_000 });
await page.click("#run");
await page
  .waitForFunction(() => document.getElementById("status")?.textContent === "done", {
    timeout: 300_000,
  })
  .catch(() => console.log("  (the run did not finish; recording what was asked for anyway)"));
await browser.close();
server.close();

await mkdir(OUT, { recursive: true });
const manifest = {};
let total = 0;

for (const url of [...wanted].sort()) {
  // Named by the content hash the CDN already uses, so a changed package is a
  // different file and the immutable cache header is safe.
  const file = `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.webc`;
  const target = new URL(file, OUT);
  manifest[url] = `/packages/${file}`;

  const already = await stat(target).catch(() => null);
  if (already) {
    total += already.size;
    console.log(`  ${(already.size / 1048576).toFixed(1).padStart(6)} MB  ${file} (have it)`);
    continue;
  }
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  await writeFile(target, bytes);
  total += bytes.length;
  console.log(`  ${(bytes.length / 1048576).toFixed(1).padStart(6)} MB  ${file}`);
}

await writeFile(new URL("manifest.json", OUT), JSON.stringify(manifest, null, 2));
console.log(`  ${Object.keys(manifest).length} packages, ${(total / 1048576).toFixed(1)} MB mirrored`);

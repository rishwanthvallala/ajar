#!/usr/bin/env node
// Install every candidate package in a real browser and report what works.
//
// The catalogue lives in src/packages/catalogue.ts — adding a binary is one
// entry there, not a change here.
//
//   npx vite build && node scripts/probe-packages.mjs          # the light set
//   node scripts/probe-packages.mjs --all                      # heavy ones too
//   node scripts/probe-packages.mjs --only kilyanni/git
//
// Unlike browser-check.mjs this deliberately does NOT use the mirror: a
// candidate we have never shipped is not in public/packages, so it has to come
// from the registry. Expect it to be slow the first time and to move real
// bytes — that is the number we are here to learn.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("../dist/", import.meta.url).pathname;
const PORT = 5201;
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".webc": "application/octet-stream",
};

const args = process.argv.slice(2);
const all = args.includes("--all");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

const server = createServer(async (req, res) => {
  // Cross-origin isolation: the runtime needs SharedArrayBuffer and a browser
  // only hands that to a document that has opted out of sharing a process.
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
page.on("pageerror", (e) => noise.push(String(e.message)));
page.on("console", (m) => m.type() === "error" && noise.push(m.text()));

// Every byte a candidate pulls, attributed to the request that pulled it.
const bytes = new Map();
page.on("response", async (r) => {
  const len = Number(r.headers()["content-length"] || 0);
  if (len) bytes.set(r.url(), len);
});

const query = only ? `?only=${encodeURIComponent(only)}` : all ? "?all=1" : "";
await page.goto(`http://127.0.0.1:${PORT}/probe.html${query}`, { waitUntil: "domcontentloaded" });

// Packages are large and some are very large; this waits on completion rather
// than on a fixed deadline, and reports progress so a long run is legible.
let last = -1;
const began = Date.now();
for (;;) {
  const { done, progress } = await page.evaluate(() => ({
    done: window.__done ?? false,
    progress: window.__progress ?? 0,
  }));
  if (progress !== last) {
    last = progress;
    process.stderr.write(`  … ${progress} probed (${Math.round((Date.now() - began) / 1000)}s)\n`);
  }
  if (done) break;
  if (Date.now() - began > 45 * 60_000) {
    console.error("probe did not finish within 45 minutes");
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}

const results = await page.evaluate(() => window.__results ?? []);
await browser.close();
server.close();

const downloaded = [...bytes.values()].reduce((a, b) => a + b, 0);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

console.log("");
let broken = 0;
const summary = [];
for (const r of results) {
  const req = r.checks.filter((c) => !c.optional);
  const pass = req.filter((c) => c.ok).length;
  const verdict = !r.loaded ? "WOULD NOT LOAD" : pass === req.length ? "works" : `${pass}/${req.length}`;
  const tag = [r.shipped ? "shipped" : null, r.heavy ? "heavy" : null].filter(Boolean).join(",");
  summary.push(
    `  ${r.name.padEnd(22)} ${String(verdict).padEnd(15)} ${(r.loaded ? `${(r.loadMs / 1000).toFixed(1)}s` : "").padStart(6)}  ${tag.padEnd(13)} ${r.gives}`,
  );
  console.log(summary[summary.length - 1]);
  if (r.error) console.log(`      would not install: ${r.error.split("\n")[0]}`);

  // Name what broke, not how many. A package that half-works fails later and
  // somewhere else, so the capability is the thing worth reading.
  const bad = r.checks.filter((c) => !c.ok);
  if (bad.length) {
    const need = bad.filter((c) => !c.optional).map((c) => c.covers);
    const soft = bad.filter((c) => c.optional).map((c) => c.covers);
    if (need.length) {
      broken += need.length;
      console.log(`      broken: ${need.join(", ")}`);
    }
    if (soft.length) console.log(`      known:  ${soft.join(", ")}`);
  }
}

if (process.env.PROBE_VERBOSE) {
  console.log("\n  --- detail ---");
  for (const r of results) {
    for (const c of r.checks.filter((x) => !x.ok)) {
      console.log(`  ${r.name} · ${c.covers}${c.optional ? " (known)" : ""}`);
      console.log(`      ${c.run}`);
      console.log(`      want ${JSON.stringify(c.want)}  got ${JSON.stringify((c.got ?? "").slice(0, 160))}${c.exit !== undefined ? ` exit ${c.exit}` : ""}`);
      if (c.why) console.log(`      (${c.why})`);
    }
  }
}

console.log(`\n  ${results.length} packages probed, ${downloaded ? mb(downloaded) : "?"} moved over the wire`);
const total = results.reduce((n, r) => n + r.checks.filter((c) => !c.optional).length, 0);
console.log(
  broken
    ? `  ${total - broken}/${total} capabilities working — PROBE_VERBOSE=1 for the detail`
    : `  all ${total} capabilities working`,
);
process.exitCode = 0; // a failing candidate is a finding, not a broken build

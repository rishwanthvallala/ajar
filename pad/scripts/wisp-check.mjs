#!/usr/bin/env node
// Egress through our own WISP endpoint, measured from inside the sandbox.
//
//   node deploy/wisp-server.mjs &
//   npx vite build && node pad/scripts/wisp-check.mjs
//
// WISP_URL points it somewhere else — wss://code.rishwanth.dev/wisp for the
// deployed endpoint.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const ROOT = new URL("../dist/", import.meta.url).pathname;
const PORT = 5211;
const WISP = process.env.WISP_URL ?? "ws://127.0.0.1:8788";
const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".wasm": "application/wasm", ".webc": "application/webc",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
};

const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = join(ROOT, path === "/" ? "index.html" : path);
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    // The worker has to be allowed to control the whole origin, or it never
    // sees the package downloads it exists to serve.
    if (path.endsWith("/sw.js")) res.setHeader("Service-Worker-Allowed", "/");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log(`      pageerror: ${e.message.slice(0, 200)}`));
page.on("console", (m) => {
  const t = m.text();
  if (/wisp|websocket|refus|fail|error|denied/i.test(t)) console.log(`      console: ${t.slice(0, 200)}`);
});
page.on("websocket", (ws) => {
  console.log(`      ws open: ${ws.url()}`);
  ws.on("socketerror", (e) => console.log(`      ws error: ${e}`));
  ws.on("close", () => console.log(`      ws closed: ${ws.url()}`));
});
await page.goto(`http://127.0.0.1:${PORT}/wisp.html?wisp=${encodeURIComponent(WISP)}`,
  { waitUntil: "domcontentloaded" });

try {
  await page.waitForFunction(() => window.__done === true, { timeout: 600_000 });
} catch {
  console.log("  the probe never finished");
}
const steps = await page.evaluate(() => window.__steps ?? []);
console.log(`\n  against ${WISP}\n`);
for (const s of steps) console.log(`  ${s.stage.padEnd(16)} ${s.detail}`);

const find = (name) => steps.find((s) => s.stage === name)?.detail ?? "";

// A refusal only means something if the allowed path works. With the endpoint
// down every destination is refused and the allowlist assertions pass without
// an allowlist doing anything — which is exactly how they passed once already.
const reaches = find("allowed host still reaches").includes("REACHED IT");
const refused = (stage) => reaches && !find(stage).includes("REACHED IT");

const checks = [
  ["dns resolves pypi.org", /^\d+\.\d+\.\d+\.\d+$/.test(find("dns"))],
  ["a tcp connection opens", find("connect").includes("connected")],
  ["tls completes end to end", find("tls blocking").startsWith("tls TLS") || find("tls timeout").startsWith("tls TLS")],
  ["a host off the allowlist is refused (while pypi.org works)", refused("blocked host")],
  ["a port off the allowlist is refused (while 443 works)", refused("blocked port")],
  ["pip install succeeds", /Successfully installed six/.test(find("pip install six"))],
  ["the installed package imports", find("import six").startsWith("six ")],
];
let bad = 0;
console.log("");
for (const [label, passed] of checks) {
  if (!passed) bad++;
  console.log(`  ${passed ? "ok  " : "FAIL"} ${label}`);
}
await browser.close();
server.close();
console.log(bad ? `\n  ${bad} failed\n` : "\n  egress works, and only where it is allowed to\n");
process.exit(bad ? 1 : 0);

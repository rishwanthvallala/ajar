#!/usr/bin/env node
// The v0 loop, driven the way a person would: open the page, press Run, see
// output, reload, find the work still there.
//
// Separate from browser-check.mjs, which tests the pieces. This one only asks
// whether the thing works.
//
//   npx vite build && node scripts/app-check.mjs

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("../dist/", import.meta.url).pathname;
const PORT = 5200;
const RELAY_PORT = 8842;

// `PAD_ORIGIN=https://code.rishwanth.dev node scripts/app-check.mjs` runs the
// same checks against the deployed site instead of a local build. Worth having
// as one script rather than two: a check that only ever runs locally cannot
// catch a service worker that registers over http and not https, or a relay
// that behaves differently behind a proxy.
const LIVE = process.env.PAD_ORIGIN ?? null;

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".wasm": "application/wasm", ".ttf": "font/ttf",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
};

const padDir = LIVE ? null : await mkdtemp(join(tmpdir(), "ajar-pad-app-"));
const relay = LIVE ? null : spawn(
  new URL("../../target/debug/ajar-relay", import.meta.url).pathname,
  ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", padDir],
  { stdio: "ignore" },
);
if (!LIVE) {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  // The policy the deploy will carry. Applied here so a CSP that breaks the
  // runtime is found by a check rather than by a user on a live origin.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // `unsafe-eval`, not merely `wasm-unsafe-eval`: the SDK's worker
      // evaluates a string as JavaScript, and without this the runtime fails
      // inside the worker where the error is easy to mistake for a hang.
      // Measured, not assumed — the tighter policy was tried first.
      "script-src 'self' 'unsafe-eval' blob:",
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss: https://registry.wasmer.io https://cdn.wasmer.io",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),
  );
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  if (path.startsWith("/api/")) {
    const up = httpRequest(
      { host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
    );
    up.on("error", () => { res.statusCode = 502; res.end("relay unreachable"); });
    return req.pipe(up);
  }
  // The type comes from the file actually served, not from the request path —
  // `/` has no extension, and octet-stream makes a browser download the page
  // instead of rendering it.
  const file = join(ROOT, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    // Any other path is a pad name, and the app reads it off the URL.
    res.setHeader("Content-Type", "text/html");
    res.end(await readFile(join(ROOT, "index.html")));
  }
});
// WebSocket upgrades go to the relay untouched. Without this the page is on
// one origin and the peer connection on another, which is not how it is
// deployed and would hide exactly the bugs this check is for.
server.on("upgrade", (req, socket, head) => {
  // A browser closing its tab resets this socket. Unhandled, that error is
  // thrown at the top level and takes the whole run down with it, turning
  // every real failure into an unreadable stack.
  socket.on("error", () => socket.destroy());
  const up = httpRequest({
    host: "127.0.0.1",
    port: RELAY_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  });
  up.on("upgrade", (res, upSocket, upHead) => {
    upSocket.on("error", () => upSocket.destroy());
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(res.headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("") +
        `\r\n`,
    );
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  up.on("error", () => socket.destroy());
  if (head?.length) up.write(head);
  up.end();
});

if (!LIVE) await new Promise((r) => server.listen(PORT, r));
const ORIGIN = LIVE ?? `http://127.0.0.1:${PORT}`;

const results = [];
const ok = (m) => results.push(`ok   ${m}`);
const fail = (m) => results.push(`FAIL ${m}`);
const is = (a, b, m) => (a === b ? ok(m) : fail(`${m} — got ${JSON.stringify(a)}`));

const browser = await chromium.launch();
const page = await browser.newPage();

// Where the bulk actually came from. The mirror is the whole point of the
// service worker, and "it still works" would pass just as well without it.
const bytesFrom = { cdn: 0, mirror: 0 };
page.on("response", (r) => {
  const len = Number(r.headers()["content-length"] ?? 0);
  if (r.url().startsWith("https://cdn.wasmer.io/")) {
    bytesFrom.cdn += len;
    if (len > 1048576) results.push(`note: CDN ${(len / 1048576).toFixed(1)} MB ${r.url()}`);
  }
  else if (r.url().includes("/packages/")) bytesFrom.mirror += len;
});
page.on("pageerror", (e) => fail(`page error: ${e.message.slice(0, 160)}`));
page.on("console", (m) => {
  const t = m.text();
  if (/Content Security Policy|Refused to/i.test(t)) fail(`CSP blocked: ${t.slice(0, 200)}`);
});

try {
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  {
    const sw = await page.evaluate(async () => {
      const seen = [];
      for (let i = 0; i < 20; i++) {
        const regs = await navigator.serviceWorker.getRegistrations();
        const r = regs[0];
        seen.push(
          `${i * 250}ms installing=${r?.installing?.state ?? "-"} waiting=${r?.waiting?.state ?? "-"} active=${r?.active?.state ?? "-"} ctrl=${navigator.serviceWorker.controller ? "y" : "n"}`,
        );
        if (navigator.serviceWorker.controller) break;
        await new Promise((x) => setTimeout(x, 250));
      }
      return seen;
    });
    results.push(`note: sw ${sw[0]}`);
    results.push(`note: sw ${sw[sw.length - 1]}`);
  }

  // Landing on the bare site puts you in a folder without asking.
  await page.waitForFunction(() => location.pathname.length > 1, { timeout: 15_000 });
  const name = await page.evaluate(() => location.pathname.slice(1));
  is(/^[a-z]+-[a-z]+-\d{4}$/.test(name), true, `a bare visit mints a name (${name})`);

  // The editor is usable before any runtime exists.
  await page.waitForSelector(".monaco-editor", { timeout: 30_000 });
  ok("the editor is on screen");
  const starter = await page.evaluate(() => document.querySelector(".monaco-editor")?.textContent ?? "");
  is(starter.includes("csv"), true, "it opens with something runnable in it");
  is(await page.locator("#files .file").count(), 1, "the folder lists its one file");

  // Run. Everything after this is the runtime arriving for the first time.
  await page.click("#run");
  await page.waitForFunction(
    () => document.getElementById("terminal")?.textContent?.includes("wrote 10 rows"),
    { timeout: 180_000 },
  );
  ok("pressing Run prints the script's output");

  // The file the script made joins the folder, on screen and on the server.
  await page.waitForFunction(
    () => [...document.querySelectorAll("#files .file")].some((b) => b.textContent === "out.csv"),
    { timeout: 30_000 },
  );
  ok("a file the script wrote appears in the folder");

  await page.waitForFunction(
    () => document.getElementById("status")?.textContent === "done",
    { timeout: 30_000 },
  );
  const stored = await fetch(`${ORIGIN}/api/pad/${name}`).then((r) => r.json());
  is(stored.exists, true, "the folder was saved to the server");
  is(
    (stored.files["out.csv"]?.content ?? "").startsWith("n,square"),
    true,
    "and the generated file was saved with it",
  );

  // The whole point of a link: someone else opens it and the work is there.
  const second = await browser.newPage();
  await second.goto(`${ORIGIN}/${name}`, { waitUntil: "domcontentloaded" });
  await second.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await second.waitForFunction(
    () => [...document.querySelectorAll("#files .file")].some((b) => b.textContent === "out.csv"),
    { timeout: 20_000 },
  );
  ok("opening the link again finds the work, generated files and all");

  // ---- two browsers on one link ----
  await second.waitForFunction(
    () => document.getElementById("presence")?.textContent?.includes("2 here"),
    { timeout: 20_000 },
  );
  ok("each browser is told how many others are here");

  // The second browser writes a file only it could have produced. Checking for
  // out.csv here would prove nothing — the first page made one itself a moment
  // ago, so the check would pass with the relay unplugged.
  await second.evaluate(() => {
    const w = window;
    const model = w.monaco?.editor?.getModels?.()[0];
    model?.setValue("open('only-from-the-second.txt','w').write('hi')\nprint('done')\n");
  });
  await second.click("#run");
  await second.waitForFunction(
    () => document.getElementById("status")?.textContent === "done",
    { timeout: 180_000 },
  );

  // A nudge crossed the relay and the first page re-read the folder.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#files .file")].some(
        (b) => b.textContent === "only-from-the-second.txt",
      ),
    { timeout: 30_000 },
  );
  ok("a change made in one browser reaches the other");

  await second.close();
  await page.waitForFunction(
    () => !document.getElementById("presence")?.textContent?.includes("2 here"),
    { timeout: 20_000 },
  );
  ok("and leaving is noticed too");

  // ---- the mirror ----
  //
  // The service worker's own counters, not the network log. A worker response
  // keeps the original request URL, so playwright attributes a mirrored
  // download to cdn.wasmer.io and the network view says the opposite of the
  // truth — which is exactly what it said while this was working.
  const swStats = await page.evaluate(async () => {
    const sw = navigator.serviceWorker.controller;
    if (!sw) return null;
    return await new Promise((resolve) => {
      const done = (e) => {
        navigator.serviceWorker.removeEventListener("message", done);
        resolve(e.data);
      };
      navigator.serviceWorker.addEventListener("message", done);
      sw.postMessage("stats");
      setTimeout(() => resolve(null), 3000);
    });
  });
  if (!swStats) {
    fail("the service worker never took control");
  } else {
    results.push(`note: intercepted ${swStats.intercepted}, served from here ${swStats.mirrored}`);
    is(swStats.intercepted > 0, true, "the service worker sees the package downloads");
    is(
      swStats.mirrored,
      swStats.intercepted,
      "and every one of them is served from this origin",
    );
  }

} catch (e) {
  fail(`${e.message.split("\n")[0]}`);
  // What the page was showing when it gave up. A bare timeout says only that
  // something did not happen, never what the user would have been looking at.
  try {
    const seen = await page.evaluate(() => ({
      status: document.getElementById("status")?.textContent,
      terminal: (document.getElementById("terminal")?.textContent ?? "").slice(-300),
      files: [...document.querySelectorAll("#files .file")].map((b) => b.textContent),
    }));
    results.push(`note: status=${JSON.stringify(seen.status)} files=${JSON.stringify(seen.files)}`);
    results.push(`note: terminal=${JSON.stringify(seen.terminal)}`);
  } catch {}
}

await browser.close();
if (!LIVE) {
  server.close();
  relay.kill();
  await rm(padDir, { recursive: true, force: true });
}

for (const line of results) console.log(`  ${line}`);
const failed = results.filter((l) => l.startsWith("FAIL"));
console.log(failed.length ? `\n  ${failed.length} failed\n` : "\n  the loop works\n");
process.exit(failed.length ? 1 : 0);

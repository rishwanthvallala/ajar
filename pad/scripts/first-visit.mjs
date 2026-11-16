#!/usr/bin/env node
// A first visit, timed: one fresh browser with nothing cached opens the pad,
// presses Run on the starter at once, and this says when each stage came and
// what crossed the wire for it, by kind — the page's scripts, the SDK, the
// runtime's packages (fetched by the service worker), and any big file sent
// uncompressed. The number a newcomer's impression is made of.
//
//   PAD_ORIGIN=https://code.rishwanth.dev node pad/scripts/first-visit.mjs
//   RUN=0 …                     # somebody who only edits: no Run, and what
//                               # came before the runtime's bytes did, unasked
//
// Against production it is a live check: run it once, not in a loop (it
// spends the per-file allowance, AGENTS.md), and it is marked as a check so
// it is not counted as use (check-mark.mjs).
import { marked } from "./check-mark.mjs";
// The packages come through the service worker, whose requests Playwright
// reports only with this set before it loads.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";
const { chromium } = await import("playwright");
const ORIGIN = process.env.PAD_ORIGIN ?? "https://code.rishwanth.dev";
const browser = await marked(await chromium.launch(), ORIGIN);
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
const t0 = Date.now();
const at = () => (Date.now() - t0) / 1000;
const reqs = new Map();
cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, { url: e.request.url, start: at() }));
cdp.on("Network.responseReceived", (e) => { const r = reqs.get(e.requestId); if (r) { r.type = e.type; r.mime = e.response.mimeType; r.enc = e.response.headers["content-encoding"] ?? e.response.headers["Content-Encoding"] ?? "-"; r.status = e.response.status; r.sw = e.response.fromServiceWorker; r.timing = e.response.timing; } });
cdp.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (r) { r.wire = e.encodedDataLength; r.end = at(); } });
const marks = {};
// Everything the context fetched, the service worker's included (it fetches
// the packages): each with when it began and ended, and its bytes.
const seen = [];
context.on("requestfinished", async (req) => {
  try {
    const sizes = await req.sizes();
    const res = await req.response();
    seen.push({ url: req.url(), end: at(), start: at() - (req.timing().responseEnd > 0 ? (req.timing().responseEnd - req.timing().startTime) / 1000 : 0), body: sizes.responseBodySize, enc: (await res?.allHeaders())?.["content-encoding"] ?? "-", sw: !!req.serviceWorker() });
  } catch {}
});
await page.goto(`${ORIGIN}/`, { waitUntil: "commit" });
marks.firstByte = at();
await page.waitForLoadState("domcontentloaded"); marks.domContentLoaded = at();
await page.waitForSelector(".monaco-editor", { timeout: 120_000 }); marks.editor = at();
await page.waitForFunction(() => (document.querySelector(".monaco-editor")?.textContent ?? "").includes("csv"), null, { timeout: 120_000 }); marks.starterShown = at();
if (process.env.RUN === "0") {
  // Somebody who only edits: nothing pressed, and the page left to settle —
  // its runtime's bytes coming by themselves, on a link that spares them.
  await page.waitForFunction(() => ["fetched", "failed", "skipped"].includes(window.__pad?.runtime?.().bytes), null, { timeout: 120_000 }).catch(() => {});
  marks.settled = at();
  marks.runtime = await page.evaluate(() => window.__pad?.runtime?.());
} else {
  // What somebody new does first: press Run on the starter.
  await page.click("#run");
  await page.waitForFunction(() => document.getElementById("terminal")?.textContent?.includes("wrote 10 rows"), null, { timeout: 240_000 }); marks.firstRunOutput = at();
}
const nav = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return { dns: n.domainLookupEnd - n.domainLookupStart, connect: n.connectEnd - n.connectStart, tls: n.secureConnectionStart ? n.connectEnd - n.secureConnectionStart : 0, ttfb: n.responseStart - n.requestStart }; });
await new Promise((r) => setTimeout(r, 1500));
const all = [...reqs.values()].filter((r) => r.wire !== undefined && !r.url.startsWith("data:"));
const kind = (r) => { const p = new URL(r.url).pathname; if (p.startsWith("/packages/")) return "packages"; if (p.startsWith("/vendor/")) return p.endsWith(".wasm") ? "sdk wasm" : "sdk js"; if (p.startsWith("/assets/")) return /\.(js|mjs)$/.test(p) ? "page js" : /\.css$/.test(p) ? "css" : /\.wasm$/.test(p) ? "page wasm" : "other assets"; if (p.startsWith("/api/") || p === "/ws") return "api"; return p === "/" || !p.includes(".") ? "html" : "other"; };
const by = {};
for (const r of all) { const k = kind(r); by[k] ??= { n: 0, wire: 0, raw: [] }; by[k].n++; by[k].wire += r.wire; if (r.enc === "-" && r.wire > 50_000) by[k].raw.push(`${new URL(r.url).pathname.split("/").pop()} ${(r.wire / 1048576).toFixed(2)} MB`); }
const total = all.reduce((s, r) => s + r.wire, 0);
console.log(JSON.stringify({ marks, nav, totalMB: +(total / 1048576).toFixed(2), requests: all.length }, null, 1));
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].wire - a[1].wire)) console.log(`${k.padEnd(14)} ${String(v.n).padStart(3)} requests ${(v.wire / 1048576).toFixed(2).padStart(7)} MB${v.raw.length ? "   uncompressed: " + v.raw.join(", ") : ""}`);
const before = all.filter((r) => r.end <= marks.editor).reduce((s, r) => s + r.wire, 0);
console.log(`before the editor: ${(before / 1048576).toFixed(2)} MB${marks.firstRunOutput ? `; before the first run's output: ${(all.filter((r) => r.end <= marks.firstRunOutput).reduce((s, r) => s + r.wire, 0) / 1048576).toFixed(2)} MB` : ""}`);
console.log("--- big files, from the context's view (service worker's too):");
for (const r of seen.filter((r) => r.body > 100_000).sort((x, y) => x.end - y.end)) console.log(`${r.end.toFixed(2).padStart(6)}s ${(r.body / 1048576).toFixed(2).padStart(6)} MB ${r.enc.padEnd(4)} ${r.sw ? "sw " : "   "} ${new URL(r.url).pathname.slice(0, 70)}`);
const ctxTotal = seen.reduce((s, r) => s + r.body, 0);
const runtimeFile = (r) => /\.webc$|wasmer_sdk_js_bg\.wasm$/.test(new URL(r.url).pathname);
const firstRuntime = Math.min(...seen.filter(runtimeFile).map((r) => r.start), Infinity);
console.log(`before any of the runtime came: ${(seen.filter((r) => r.end <= firstRuntime && !runtimeFile(r)).reduce((s, r) => s + r.body, 0) / 1048576).toFixed(2)} MB${Number.isFinite(firstRuntime) ? `, its first file asked for at ${firstRuntime.toFixed(1)} s` : ", and none of it came"}`);
console.log(`context total: ${(ctxTotal / 1048576).toFixed(2)} MB in ${seen.length} requests; packages ${(seen.filter((r) => r.url.includes("/packages/")).reduce((s, r) => s + r.body, 0) / 1048576).toFixed(2)} MB`);
await browser.close();

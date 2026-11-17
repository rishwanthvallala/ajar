#!/usr/bin/env node
// The browser's half of the perf scorecard (run.mjs, docs/dev/performance.md):
// a newcomer's first open, cold — a fresh browser, nothing cached, no service
// worker — in each way that matters, a returning visitor's, and what typing,
// saving, running and working together feel like. One JSON line per
// scenario run, on stdout.
//
//   node scripts/perf/browser.mjs <origin> [scenario,...] [runs]
//   LAB=1 node scripts/perf/browser.mjs https://code.rishwanth.dev:18443   # the perf lab (lab.sh)
//
// Every browser is marked as a check's, so a live run is not counted as use
// (check-mark.mjs). Against production it is a live check: once.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "../../pad/scripts/check-mark.mjs";

// The packages come through the service worker, whose requests Playwright
// reports only with this set before it loads.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";
const { chromium } = await import("playwright");

const ORIGIN = process.argv[2] ?? "https://code.rishwanth.dev";
const ALL = ["edit", "run-now", "run-settled", "return", "collab"];
const SCENARIOS = (process.argv[3] ?? ALL.join(",")).split(",");
const RUNS = Number(process.argv[4] ?? 1);
const LAB = process.env.LAB === "1";
const OUTPUT = "wrote 10 rows";
const RUNTIME_FILE = /\.webc$|wasmer_sdk_js_bg\.wasm$/;
/**
 * The page's main thread slowed this many times (CPU_SLOWDOWN), as a cheap
 * laptop's or a phone's: Lighthouse's mobile run is 4. Chrome slows the
 * page's own thread only — the editor's parse and the page's drawing, not
 * the runtime's workers, so Python's compile is not slowed.
 */
const SLOWDOWN = Number(process.env.CPU_SLOWDOWN ?? 1);
async function tab(context) {
  const page = await context.newPage();
  if (SLOWDOWN > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: SLOWDOWN });
  return page;
}

/** Kept in the page from its first script: paints, long tasks, and when the editor, its focus and the terminal came. */
function recorder() {
  const perf = (window.__perf = { marks: {}, longTasks: [], lcp: 0, cls: 0 });
  const mark = (k) => {
    if (!(k in perf.marks)) perf.marks[k] = performance.now();
  };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) perf.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) perf.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) perf.cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    // A browser without these observers: those marks stay empty.
  }
  const look = () => {
    if (document.querySelector(".monaco-editor .view-lines")) mark("editor");
    if (document.querySelector("#terminal .xterm")) mark("terminal");
    if (document.activeElement?.closest?.(".monaco-editor")) mark("typeable");
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true });
  document.addEventListener("focusin", look, true);
}

/**
 * A browser as a newcomer's: its own profile, made empty — a real one, with a
 * disk cache, as a visitor's has. Playwright's throwaway contexts keep almost
 * nothing, and every visit in them was a first one. Closing it removes it.
 */
async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "perf-profile-"));
  const args = LAB
    ? [
        // The lab's names mapped here; its key trusted, which a certificate
        // whose errors are only ignored is not — Chrome caches nothing from
        // that; and no proxy, which resolves names itself and asks production.
        "--host-resolver-rules=MAP *.rishwanth.dev 127.0.0.1",
        `--ignore-certificate-errors-spki-list=${readFileSync(new URL("../../target/perf/lab.spki", import.meta.url), "utf8").trim()}`,
        "--no-proxy-server",
      ]
    : [];
  const context = await marked(await chromium.launchPersistentContext(dir, { args }), ORIGIN);
  const browser = {
    close: async () => {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  await context.addInitScript(recorder);
  const ledger = [];
  context.on("requestfinished", async (req) => {
    try {
      // What the service worker answered crossed no wire: its bytes are those
      // of its own fetch, counted where it made it. Playwright gives such an
      // answer a size all the same — a whole package's, or below zero.
      if ((await req.response())?.fromServiceWorker()) return;
      const sizes = await req.sizes();
      ledger.push({ url: req.url(), at: Date.now(), bytes: sizes.responseBodySize + sizes.responseHeadersSize });
    } catch {
      // A request whose sizes went with its page.
    }
  });
  return { browser, context, ledger };
}

/** Milliseconds since `page`'s navigation began, for an epoch time. */
const since = async (page) => {
  const origin = await page.evaluate(() => performance.timeOrigin);
  return (epoch) => Math.round(epoch - origin);
};
const sum = (rows) => rows.reduce((s, r) => s + r.bytes, 0);
const outputs = (page) => page.evaluate((o) => ((document.querySelector("#terminal .xterm-rows")?.innerText ?? "").split(o).length - 1), OUTPUT);
const waitOutputs = (page, n, timeout = 300_000) =>
  page.waitForFunction(([o, k]) => ((document.querySelector("#terminal .xterm-rows")?.innerText ?? "").split(o).length - 1) > k, [OUTPUT, n], { timeout });

async function opened(page, path = "/") {
  await page.goto(`${ORIGIN}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__perf?.marks.typeable !== undefined && window.__pad, null, { timeout: 120_000 });
}

/** What a page's first open came to, from what it recorded and the ledger. */
async function firstOpen(page, ledger) {
  const at = await since(page);
  const { nav, fcp, perf } = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return {
      nav: { ttfb: n.responseStart, dns: n.domainLookupEnd - n.domainLookupStart, connect: n.connectEnd - n.connectStart, tls: n.secureConnectionStart ? n.connectEnd - n.secureConnectionStart : 0 },
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
      perf: window.__perf,
    };
  });
  const before = (ms) => sum(ledger.filter((r) => at(r.at) <= ms));
  const typeable = perf.marks.typeable;
  return {
    ttfb_ms: Math.round(nav.ttfb),
    dns_ms: Math.round(nav.dns),
    connect_ms: Math.round(nav.connect),
    tls_ms: Math.round(nav.tls),
    fcp_ms: fcp === null ? null : Math.round(fcp),
    lcp_ms: Math.round(perf.lcp),
    editor_ms: Math.round(perf.marks.editor),
    typeable_ms: Math.round(typeable),
    terminal_ms: perf.marks.terminal === undefined ? null : Math.round(perf.marks.terminal),
    long_tasks_before_typeable_ms: Math.round(perf.longTasks.filter(([s]) => s < typeable).reduce((t, [, d]) => t + d, 0)),
    layout_shift: +perf.cls.toFixed(3),
    bytes_before_editor: before(perf.marks.editor),
  };
}

async function heap(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Math.round((metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1048576);
}

// ------------------------------------------------------------------ scenarios

/** A newcomer who only edits: nothing pressed, and the page left to settle. */
async function edit() {
  const { browser, context, ledger } = await fresh();
  const page = await tab(context);
  await opened(page);
  await page.waitForLoadState("load");
  const loadedAt = Date.now();
  const final = () => ["fetched", "failed", "skipped"].includes(window.__pad.runtime().bytes);
  await page.waitForFunction(final, null, { timeout: 300_000 }).catch(() => {});
  const at = await since(page);
  const runtimeRows = ledger.filter((r) => RUNTIME_FILE.test(new URL(r.url).pathname));
  const firstRuntime = runtimeRows.length ? Math.min(...runtimeRows.map((r) => r.at)) : null;
  const state = await page.evaluate(() => window.__pad.runtime());
  const result = {
    ...(await firstOpen(page, ledger)),
    load_ms: at(loadedAt),
    bytes_at_load: sum(ledger.filter((r) => r.at <= loadedAt)),
    // What an edit-only visit costs when nothing of the runtime comes: all of
    // it on a slow link or with data saver.
    bytes_without_runtime: sum(ledger.filter((r) => !RUNTIME_FILE.test(new URL(r.url).pathname))),
    runtime_bytes_unasked: sum(runtimeRows),
    runtime_first_asked_ms: firstRuntime === null ? null : at(firstRuntime),
    runtime_started: state.started,
    runtime_prefetch: state.bytes,
    heap_mb: await heap(context, page),
  };
  await browser.close();
  return result;
}

/** A newcomer who presses Run as soon as the editor takes keys. */
async function runNow() {
  const { browser, context, ledger } = await fresh();
  const page = await tab(context);
  await opened(page);
  const already = await outputs(page);
  const pressed = Date.now();
  await page.click("#run");
  await waitOutputs(page, already);
  const done = Date.now();
  const at = await since(page);
  const result = {
    ...(await firstOpen(page, ledger)),
    run_output_ms: at(done),
    run_click_to_output_ms: done - pressed,
    bytes_total: sum(ledger),
    heap_mb: await heap(context, page),
  };
  return { result, browser, context };
}

/** A newcomer who reads a while first: Run pressed once the page has settled. */
async function runSettled() {
  const { browser, context } = await fresh();
  const page = await tab(context);
  await opened(page);
  await page.waitForFunction(() => ["fetched", "failed", "skipped"].includes(window.__pad.runtime().bytes), null, { timeout: 300_000 }).catch(() => {});
  const prefetch = await page.evaluate(() => window.__pad.runtime().bytes);
  const already = await outputs(page);
  const pressed = Date.now();
  await page.click("#run");
  await waitOutputs(page, already);
  const result = { run_click_to_output_ms: Date.now() - pressed, runtime_prefetch: prefetch };
  await browser.close();
  return result;
}

/** Back the next day: the same browser, its cache and service worker warm — and then typing, saving, running again, a command. */
async function returning(context) {
  // Back later, not the same second: what the first visit fetched written to
  // the cache first. Straight after it, on the unshaped link, the return
  // visit downloaded the 17 MB again.
  await new Promise((r) => setTimeout(r, 2000));
  const page = await tab(context);
  const ledger = [];
  page.on("requestfinished", async (req) => {
    try {
      if ((await req.response())?.fromServiceWorker()) return;
      const s = await req.sizes();
      ledger.push({ url: req.url(), at: Date.now(), bytes: s.responseBodySize + s.responseHeadersSize });
    } catch {}
  });
  await opened(page);
  const first = await firstOpen(page, ledger);
  let already = await outputs(page);
  let pressed = Date.now();
  await page.click("#run");
  await waitOutputs(page, already);
  const runReturn = Date.now() - pressed;
  // What coming back cost, to the first Run's output: before any typing,
  // which fetches the suggestion model (counted on its own, below).
  const returnBytes = sum(ledger);

  // Typing: from each key down to the frame after the editor has it.
  await page.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    window.__keys = [];
    let down = 0;
    document.addEventListener("keydown", () => (down = performance.now()), true);
    ed.onDidChangeModelContent(() => requestAnimationFrame(() => window.__keys.push(performance.now() - down)));
    ed.focus();
    ed.setPosition(ed.getModel().getPositionAt(ed.getModel().getValueLength()));
  });
  await page.keyboard.type("\n# typed while measuring the keys of this pad\n", { delay: 40 });
  const lastKey = Date.now();
  const keys = (await page.evaluate(() => window.__keys)).sort((a, b) => a - b);
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "saved", null, { timeout: 30_000 }).catch(() => {});
  const saved = Date.now() - lastKey;

  // Run again, the runtime warm.
  already = await outputs(page);
  pressed = Date.now();
  await page.click("#run");
  await waitOutputs(page, already);
  const runWarm = Date.now() - pressed;

  // A command in the terminal.
  await page.click("#terminal");
  const typed = Date.now();
  await page.keyboard.type("echo PERF$((40+2))\n");
  await page.waitForFunction(() => /PERF42/.test(document.querySelector("#terminal .xterm-rows")?.innerText ?? ""), null, { timeout: 60_000 });
  const command = Date.now() - typed;

  return {
    editor_ms: first.editor_ms,
    typeable_ms: first.typeable_ms,
    bytes_before_editor: first.bytes_before_editor,
    bytes_to_run_output: returnBytes,
    // The suggestion model, which typing code fetches the first time (its 17
    // MB, complete.ts): what came after the Run, by the scenario's end — all
    // of it on a fast link, part on a slower one.
    bytes_after_typing_code: sum(ledger) - returnBytes,
    run_click_to_output_ms: runReturn,
    key_to_frame_p50_ms: +keys[Math.floor(keys.length * 0.5)].toFixed(1),
    key_to_frame_p95_ms: +keys[Math.floor(keys.length * 0.95)].toFixed(1),
    last_key_to_saved_ms: saved,
    run_warm_click_to_output_ms: runWarm,
    command_to_output_ms: command,
  };
}

/** Two people in one pad: how long each key typed in one takes to show in the other. */
async function collab() {
  const a = await fresh();
  const b = await fresh();
  // Suggestions off in both: the first code typed fetches the model's 17 MB,
  // and in the lab the two browsers share one link — B's keys waited behind
  // A's download, p50 138 ms on `cable`, which two people on links of their
  // own never meet. This is the room alone.
  for (const { context } of [a, b]) await context.addInitScript(() => localStorage.setItem("pad.suggest", "off"));
  const pa = await tab(a.context);
  await opened(pa);
  const name = await pa.evaluate(() => location.pathname);
  const pb = await tab(b.context);
  await opened(pb, name);
  // Both in the room, and B with the file's live document — and both done
  // fetching the runtime's bytes, which a newcomer's page does by itself a
  // moment after it loads, so the room is measured as it is once that is
  // over.
  await pa.waitForFunction(() => /2 here/.test(document.getElementById("presence")?.textContent ?? ""), null, { timeout: 30_000 });
  const settled = () => ["fetched", "failed", "skipped"].includes(window.__pad.runtime().bytes);
  await Promise.all([pa, pb].map((p) => p.waitForFunction(settled, null, { timeout: 300_000 }).catch(() => {})));
  await pb.waitForTimeout(500);
  await pb.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    window.__seen = [];
    ed.onDidChangeModelContent(() => window.__seen.push(Date.now()));
  });
  await pa.evaluate(() => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.focus();
    ed.setPosition(ed.getModel().getPositionAt(ed.getModel().getValueLength()));
  });
  const sent = [];
  // Thirty keys: with eleven, the 95th percentile was the slowest one, and
  // moved by half from run to run.
  for (const ch of "\n# typed together, thirty keys") {
    sent.push(Date.now());
    await pa.keyboard.type(ch);
    await pa.waitForTimeout(150);
  }
  await pb.waitForTimeout(2000);
  const seen = await pb.evaluate(() => window.__seen);
  // Each key, to the first change B saw after it was sent.
  const lags = sent.map((t) => (seen.find((s) => s >= t) ?? NaN) - t).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  await a.browser.close();
  await b.browser.close();
  return {
    keys_seen: `${lags.length}/${sent.length}`,
    key_to_other_p50_ms: lags[Math.floor(lags.length * 0.5)] ?? null,
    key_to_other_p95_ms: lags[Math.floor(lags.length * 0.95)] ?? null,
  };
}

// ------------------------------------------------------------------ main

const emit = (scenario, run, result) => console.log(JSON.stringify({ scenario, run, ...result }));
// Each scenario on a link with nothing queued for the one before (lab.sh).
const reset = () => {
  if (LAB) execFileSync(fileURLToPath(new URL("./lab.sh", import.meta.url)), ["reset"], { stdio: "inherit" });
};
for (let run = 1; run <= RUNS; run++) {
  if (SCENARIOS.includes("edit")) {
    reset();
    emit("edit", run, await edit());
  }
  if (SCENARIOS.includes("run-now") || SCENARIOS.includes("return")) {
    reset();
    const { result, browser, context } = await runNow();
    if (SCENARIOS.includes("run-now")) emit("run-now", run, result);
    if (SCENARIOS.includes("return")) emit("return", run, await returning(context));
    await browser.close();
  }
  if (SCENARIOS.includes("run-settled")) {
    reset();
    emit("run-settled", run, await runSettled());
  }
  if (SCENARIOS.includes("collab")) {
    reset();
    emit("collab", run, await collab());
  }
}

#!/usr/bin/env node
// The completer in a real browser, built and served the way the pad is.
//
//   node packages/complete/test/browser.mjs            (needs the model installed: scripts/install-model.mjs)
//
// The page (test/page) is built with Vite, as the pad is, and served with the
// pad's production headers — cross-origin isolation and its Content Security
// Policy — and with `.zst` copies in place of files, as Caddy's
// `precompressed` does. Then, in headless Chromium:
//
//   load       the model from the network, then from Cache Storage after a reload
//   parity     EVAL_ITEMS (a JSONL of {prefix, suffix}) through the page's worker,
//              against EVAL_ROWS (test/node-eval.mjs's rows for the same items), if given
//   typing     a file typed into Monaco key by key: when grey text appears, and how
//              long after the key; Tab takes it
//   fallbacks  without cross-origin isolation (one thread, no SharedArrayBuffer),
//              and the plain SIMD128 engine
import { createServer } from "node:http";
import { readFile, stat, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium } from "playwright";

// What the typing check types, when TYPE_FILE names no file of your own.
const SAMPLE = `import json
import os
from dataclasses import dataclass


@dataclass
class Item:
    name: str
    price: float
    quantity: int = 0

    def total(self) -> float:
        return self.price * self.quantity


def load_items(path: str) -> list[Item]:
    with open(path) as f:
        data = json.load(f)
    return [Item(**row) for row in data]


def save_items(path: str, items: list[Item]) -> None:
    with open(path, "w") as f:
        json.dump([item.__dict__ for item in items], f, indent=2)


def main() -> None:
    path = os.environ.get("ITEMS", "items.json")
    items = load_items(path)
    for item in items:
        print(f"{item.name}: {item.total():.2f}")
    save_items(path, items)


if __name__ == "__main__":
    main()
`;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGES = fileURLToPath(new URL("../../../pad/public/packages/", import.meta.url));
if (!existsSync(join(PACKAGES, "ajar-complete.json"))) {
  console.log("skipped: no model in pad/public/packages — node packages/complete/scripts/install-model.mjs <model.bin> <tokenizer.json>");
  process.exit(0);
}
const OUT = await mkdtemp(join(tmpdir(), "complete-check-"));
await build({ root: join(HERE, "page"), base: "/", logLevel: "warn", build: { outDir: OUT, emptyOutDir: true, target: "es2022", sourcemap: false } });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".ttf": "font/ttf" };
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-eval' blob:", "worker-src 'self' blob:", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "font-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");
const sent = new Map();
function serve(isolated) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/favicon.ico") return res.writeHead(204).end();
    if (isolated) {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    }
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    const file = path.startsWith("/packages/") ? join(PACKAGES, path.slice(10)) : join(OUT, path === "/" ? "index.html" : path);
    if (!file.startsWith(PACKAGES) && !file.startsWith(OUT)) return res.writeHead(403).end();
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) return res.writeHead(404).end();
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    // As the Caddyfile: content-named files for good, the lists beside them revalidated.
    res.setHeader("Cache-Control", path.startsWith("/packages/") && path.endsWith(".json") ? "no-cache" : path.startsWith("/assets/") || path.startsWith("/packages/") ? "public, max-age=31536000, immutable" : "no-cache");
    let body = file;
    const accept = String(req.headers["accept-encoding"] ?? "");
    for (const [enc, ext] of [["zstd", ".zst"], ["gzip", ".gz"]]) {
      if (accept.includes(enc) && existsSync(file + ext)) {
        res.setHeader("Content-Encoding", enc);
        body = file + ext;
        break;
      }
    }
    const data = await readFile(body);
    sent.set(path, (sent.get(path) ?? 0) + data.length);
    res.end(data);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}
const isolated = await serve(true);
const plain = await serve(false);
const origin = (s) => `http://127.0.0.1:${s.address().port}`;

const browser = await chromium.launch({
  channel: process.env.PAD_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
});
const results = {};
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

try {
  // ------------------------------------------------------------------ load
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${origin(isolated)}/`);
  const first = await page.evaluate(() => window.completer.ready);
  check("loads", !!first.build, `${first.model} ${first.build} ×${first.threads}, kv8 ${first.kv8}, ${Math.round(first.ms)} ms`);
  check("cross-origin isolated, threaded, int8 attention", first.build === "relaxed-mt" && first.threads > 1 && first.kv8, `isolated ${await page.evaluate(() => window.isolated)}`);
  const modelFile = JSON.parse(await readFile(join(PACKAGES, "ajar-complete.json"), "utf8")).model.file;
  check("model sent compressed", (sent.get(`/packages/${modelFile}`) ?? 0) < 18e6, `${((sent.get(`/packages/${modelFile}`) ?? 0) / 1e6).toFixed(2)} MB on the wire`);
  await page.reload();
  const second = await page.evaluate(() => window.completer.ready);
  check("second load from Cache Storage", second.cached, `${Math.round(second.ms)} ms`);
  results.load = { first, second };

  // ---------------------------------------------------------------- parity
  if (process.env.EVAL_ITEMS) {
    const items = (await readFile(process.env.EVAL_ITEMS, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(0, Number(process.env.EVAL_N ?? 300));
    const rows = await page.evaluate(async (items) => {
      const out = [];
      for (const it of items) {
        const t0 = performance.now();
        const c = await window.completer.completeAsEvaluated({ key: "eval", line: -1, prefix: it.prefix, suffix: it.suffix });
        out.push({ text: c?.text ?? null, confidence: c?.confidence, ms: performance.now() - t0, prefilled: c?.prefilled });
      }
      return out;
    }, items);
    results.parity = { n: rows.length, ms_median: pct(rows.map((r) => r.ms), 0.5), ms_p90: pct(rows.map((r) => r.ms), 0.9) };
    if (process.env.EVAL_ROWS) {
      const ref = (await readFile(process.env.EVAL_ROWS, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const same = rows.filter((r, i) => r.text === ref[i]?.text).length;
      results.parity.identical = same;
      check("browser = Node, item by item", same === rows.length, `${same}/${rows.length} identical; ${results.parity.ms_median.toFixed(0)} ms median whole prompt`);
    } else check("parity items run", rows.every((r) => r.text !== null), `${rows.length} items`);
  }

  // ---------------------------------------------------------------- typing
  results.typing = await typing(page);
  const t = results.typing;
  check("ghost text appears while typing", t.shown > 0, `${t.shown} suggestions over ${t.keys} keys, ${t.accepted} taken with Tab`);
  check("keystroke to ghost text, median under 50 ms", t.key_to_ghost_median < 50, `median ${t.key_to_ghost_median.toFixed(1)} ms, p90 ${t.key_to_ghost_p90.toFixed(1)} ms; worker ${t.worker_median.toFixed(1)} ms median`);
  check("no long tasks on the page while typing", t.long_tasks === 0, `${t.long_tasks} over 50 ms`);
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  // ---------------------------------------------------------------- brackets
  // A stand-in completer with fixed answers, so what Tab leaves is known:
  // brackets already after the cursor are neither doubled nor lost.
  for (const [said, want] of [["baz)", "foo(barbaz)"], ["):", "foo(bar):"], ["baz", "foo(barbaz)"]]) {
    const line = await page.evaluate(async (said) => {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:600px;height:200px";
      document.body.append(host);
      const ed = window.monaco.editor.create(host, { value: "foo(bar)", language: "python" });
      const stub = { complete: async () => ({ text: said, confidence: 0, prefilled: 0, generated: 1, ms: 0 }), shows: () => true, prepare() {} };
      const off = window.attachCompleter(window.monaco, ed, stub, { enabled: (m) => m === ed.getModel() });
      ed.setPosition({ lineNumber: 1, column: 8 });
      ed.focus();
      for (let i = 0; i < 150 && !host.querySelector(".ghost-text-decoration, .ghost-text"); i++) {
        if (i % 25 === 0) ed.trigger("check", "editor.action.inlineSuggest.trigger", {});
        await new Promise((r) => setTimeout(r, 20));
      }
      ed.trigger("check", "editor.action.inlineSuggest.commit", {});
      const text = ed.getModel().getValue();
      off.dispose();
      ed.dispose();
      host.remove();
      return text;
    }, said);
    check(`"${said}" before ")" leaves ${want}`, line === want, `got ${line}`);
  }
  await ctx.close();

  // ------------------------------------------------------------- fallbacks
  for (const [name, url, want] of [
    ["not isolated: one thread, no SharedArrayBuffer", `${origin(plain)}/`, (i) => i.build === "relaxed" && i.threads === 1],
    ["plain SIMD128 engine", `${origin(isolated)}/?relaxed=0`, (i) => i.build === "simd-mt" && !i.kv8],
  ]) {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.goto(url);
    const info = await p.evaluate(() => window.completer.ready);
    const r = await p.evaluate(() => window.completer.complete({ key: "x", line: 1, prefix: "def add(a, b):\n    return a", suffix: "\n" }));
    check(name, want(info) && r && r.text.length > 0, `${info.build} ×${info.threads}: "${r?.text}" in ${r?.ms.toFixed(0)} ms`);
    results[name] = { info, text: r?.text, ms: r?.ms };
    await c.close();
  }
} finally {
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  isolated.close();
  plain.close();
  await rm(OUT, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

/**
 * Types code into the editor as a person would, a key at a time, and records
 * when ghost text shows after each key. Where the suggestion is what the
 * file goes on to say, takes it with Tab instead of typing it.
 */
async function typing(page) {
  const src = process.env.TYPE_FILE ? await readFile(process.env.TYPE_FILE, "utf8") : SAMPLE;
  const lines = src.split("\n");
  const keep = Math.floor(lines.length / 2);
  await page.evaluate(([head, tail]) => {
    const model = window.editor.getModel();
    window.monaco.editor.setModelLanguage(model, "python");
    model.setValue(head + "\n\n" + tail);
    const line = head.split("\n").length + 1;
    window.editor.setPosition({ lineNumber: line, column: 1 });
    window.editor.focus();
    window.ghosts = [];
    window.keys = [];
    // From here on: loading Monaco and the model is not typing.
    window.long.length = 0;
    const root = document.getElementById("editor");
    new MutationObserver(() => {
      const g = root.querySelector(".ghost-text-decoration, .ghost-text");
      const text = g ? g.textContent : "";
      if (text && window.ghosts.at(-1)?.text !== text) window.ghosts.push({ text, at: performance.now() });
    }).observe(root, { subtree: true, childList: true, characterData: true });
    root.addEventListener("keydown", () => window.keys.push(performance.now()), true);
  }, [lines.slice(0, keep).join("\n"), lines.slice(keep + 6).join("\n")]);
  // Let the prepared prompt settle, as a person reading would.
  await page.waitForTimeout(800);
  const typed = lines.slice(keep, keep + 6);
  let accepted = 0;
  let keys = 0;
  for (const [n, line] of typed.entries()) {
    const indent = line.length - line.trimStart().length;
    // Monaco indents a new line itself; type only what is past that.
    const auto = await page.evaluate(() => window.editor.getModel().getLineContent(window.editor.getPosition().lineNumber).length);
    let i = Math.min(indent, auto);
    if (auto > indent) {
      for (let k = indent; k < auto; k++) await page.keyboard.press("Backspace");
    }
    while (i < line.length) {
      await page.waitForTimeout(90);
      const ghost = await page.evaluate(() => document.querySelector("#editor .ghost-text-decoration, #editor .ghost-text")?.textContent ?? "");
      const rest = line.slice(i);
      if (ghost && rest.startsWith(ghost)) {
        await page.keyboard.press("Tab");
        accepted++;
        i += ghost.length;
        continue;
      }
      await page.keyboard.type(line[i]);
      keys++;
      i++;
    }
    if (n < typed.length - 1) {
      await page.keyboard.press("Enter");
      keys++;
    }
  }
  await page.waitForTimeout(300);
  return page.evaluate(([keysTyped, accepted]) => {
    const lat = [];
    for (const g of window.ghosts) {
      const k = window.keys.filter((t) => t <= g.at).at(-1);
      if (k !== undefined) lat.push(g.at - k);
    }
    const sorted = (a) => [...a].sort((x, y) => x - y);
    const q = (a, p) => (a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN);
    const w = window.log.map((l) => l.c.ms);
    return {
      keys: keysTyped,
      accepted,
      completions: window.log.length,
      shown: window.log.filter((l) => l.shown).length,
      ghosts: window.ghosts.length,
      key_to_ghost_median: q(lat, 0.5),
      key_to_ghost_p90: q(lat, 0.9),
      worker_median: q(w, 0.5),
      worker_p90: q(w, 0.9),
      prefilled_median: q(window.log.map((l) => l.c.prefilled), 0.5),
      long_tasks: window.long.filter((d) => d > 50).length,
      text: window.editor.getModel().getValue().length,
    };
  }, [keys, accepted]);
}

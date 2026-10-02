#!/usr/bin/env node
// The v0 loop, driven the way a person would: open the page, press Run, see
// output, reload, find the work still there.
//
// Separate from browser-check.mjs, which tests the pieces. This one only asks
// whether the thing works.
//
//   npx vite build && node scripts/app-check.mjs

import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = 5200;
const RELAY_PORT = 8842;
const LIVE = process.env.PAD_ORIGIN ?? null;

// `PAD_ORIGIN=https://code.rishwanth.dev node scripts/app-check.mjs` runs the
// same checks against the deployed site instead of a local build. Worth having
// as one script rather than two: a check that only ever runs locally cannot
// catch a service worker that registers over http and not https, or a relay
// that behaves differently behind a proxy.
// The import map is an inline script, and the policy below has no
// 'unsafe-inline' — so it needs a hash, and a hash pinned by hand rots the
// moment anyone edits the map: the map is blocked, WISP stops resolving, and
// nothing else changes, so it fails silently and much later. Computed from the
// page here, and asserted against the deployed policy further down.
const IMPORTMAP_SHA = createHash("sha256")
  .update(
    /<script type="importmap">(.*?)<\/script>/s.exec(
      await readFile(LIVE ? new URL("../index.html", import.meta.url) : join(ROOT, "index.html"), "utf8"),
    )[1].replace(/\r\n?/g, "\n"),
  )
  .digest("base64");

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".wasm": "application/wasm", ".ttf": "font/ttf",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
};

const padDir = LIVE ? null : await mkdtemp(join(tmpdir(), "ajar-pad-app-"));
const relay = LIVE ? null : spawn(
  fileURLToPath(new URL(`../../target/debug/ajar-relay${process.platform === "win32" ? ".exe" : ""}`, import.meta.url)),
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
      `script-src 'self' 'unsafe-eval' blob: 'sha256-${IMPORTMAP_SHA}'`,
      "worker-src 'self' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss: https://registry.wasmer.io https://cdn.wasmer.io",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),
  );
  const urlPath = new URL(req.url, "http://x").pathname;
  if (urlPath.startsWith("/api/")) {
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
  const relative = urlPath.split("/").filter((part) => part && part !== "." && part !== "..").join("/");
  const file = join(ROOT, relative || "index.html");
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

const browser = await chromium.launch({
  channel: process.env.PAD_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
});
const page = await browser.newPage();

// The live site limits each file to 100 fetches an hour per address, and every
// browser here is a first visit. A refused file surfaces as a module that
// would not load or a runtime that never starts, far from the cause — on
// 2 October an hour of runs against production went on reading those as bugs.
let limited = 0;
// Every other browser this opens, by name, so a failure can say what each one
// was showing — the first page's screen alone said nothing about why the
// second's Run never finished.
const tabs = new Map();
const watchLimits = (tab, name) => {
  tab.context().on("response", (r) => { if (r.status() === 429) limited += 1; });
  if (name) tabs.set(name, tab);
};
watchLimits(page);

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
  await page.waitForFunction(() => location.pathname.length > 1, null, { timeout: 15_000 });
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
    null, { timeout: 180_000 },
  );
  ok("pressing Run prints the script's output");

  // The file the script made joins the folder, on screen and on the server.
  await page.waitForFunction(
    () => [...document.querySelectorAll("#files .file")].some((b) => b.textContent === "out.csv"),
    null, { timeout: 30_000 },
  );
  ok("a file the script wrote appears in the folder");

  await page.waitForFunction(
    () => document.getElementById("status")?.textContent === "done",
    null, { timeout: 30_000 },
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
  watchLimits(second, "second");
  await second.goto(`${ORIGIN}/${name}`, { waitUntil: "domcontentloaded" });
  await second.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await second.waitForFunction(
    () => [...document.querySelectorAll("#files .file")].some((b) => b.textContent === "out.csv"),
    null, { timeout: 20_000 },
  );
  ok("opening the link again finds the work, generated files and all");

  // ---- two browsers on one link ----
  await second.waitForFunction(
    () => document.getElementById("presence")?.textContent?.includes("2 here"),
    null, { timeout: 20_000 },
  );
  ok("each browser is told how many others are here");
  const dots = await second.evaluate(() => ({
    all: document.querySelectorAll("#presence .person-dot").length,
    you: document.querySelectorAll("#presence .person-dot.you").length,
    colours: new Set([...document.querySelectorAll("#presence .person-dot")].map((d) => getComputedStyle(d).backgroundColor)).size,
  }));
  is(JSON.stringify(dots), JSON.stringify({ all: 2, you: 1, colours: 2 }), "each person is a dot in their own colour, yours marked");

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
    null, { timeout: 180_000 },
  );

  // A nudge crossed the relay and the first page re-read the folder.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#files .file")].some(
        (b) => b.textContent === "only-from-the-second.txt",
      ),
    null, { timeout: 30_000 },
  );
  ok("a change made in one browser reaches the other");

  await second.close();
  await page.waitForFunction(
    () => !document.getElementById("presence")?.textContent?.includes("2 here"),
    null, { timeout: 20_000 },
  );
  ok("and leaving is noticed too");

  // ---- editing, which is the other half of "they can continue my work" ----
  //
  // Nothing here presses Run. Typing on its own has to reach the other
  // browser, and for a long time it did not: the only thing that published
  // was a command, so two people could sit in one folder editing the same
  // file and never see a word of each other's work.
  const third = await browser.newPage();
  watchLimits(third, "third");
  await third.goto(`${ORIGIN}/${name}`, { waitUntil: "domcontentloaded" });
  await third.waitForSelector(".monaco-editor", { timeout: 30_000 });

  // Typed into the editor the way a person does, not poked into a model:
  // the first version of this listened on the editor rather than on each
  // model, so a programmatic change to a background file proved nothing.
  const TYPED = "edited-and-never-run";
  await page.click('#files .row.file:has-text("main.py")');
  await page.click(".monaco-editor .view-lines");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(`# ${TYPED}\nprint('hi')\n`);

  try {
    await third.waitForFunction(
      (text) => window.monaco?.editor?.getModels?.().some((m) => m.getValue().includes(text)),
      TYPED,
      { timeout: 20_000 },
    );
    ok("an edit reaches the other browser without anybody pressing Run");
  } catch {
    for (const [who, tab] of [["first", page], ["third", third]]) {
      const d = await tab.evaluate(() => ({
        active: window.__pad?.active(),
        docs: window.__pad?.docs(),
        streams: window.__pad?.streams(),
        text: (window.__pad?.text(window.__pad?.active()) ?? "").slice(0, 30),
        counts: window.__pad?.counts(),
      }));
      results.push(`note: ${who} ${JSON.stringify(d)}`);
    }
    fail("an edit did not reach the other browser");
  }

  // And it has to have reached the server too, or a reload loses it. Saving is
  // debounced, so this waits for the page to say it happened rather than
  // racing it.
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent === "saved",
    null, { timeout: 20_000 },
  );
  const savedPad = await fetch(`${ORIGIN}/api/pad/${name}`).then((r) => r.json());
  is(
    Object.values(savedPad.files).some((f) => f.content.includes(TYPED)),
    true,
    "and the edit was saved, so a reload keeps it",
  );
  // ---- two people in one file at once ----
  //
  // Two things to prove, and they are different. Taking turns, neither
  // person's work may be lost — which is exactly what file-level last-write-
  // wins destroys. Typing at the same instant, both browsers must at least
  // agree, because a CRDT promises convergence and not that two people
  // inserting at the same spot stay tidy: they interleave, in any editor
  // built this way, and asserting otherwise is asserting the wrong thing.
  // `__pad` appears only once the page's terminal has loaded, which can trail
  // the editor on the live site. Read unguarded, a wait threw on its first try
  // instead of waiting — one run in two against production on 2 October.
  const textOf = (tab) =>
    tab.evaluate(() => window.__pad?.text(window.__pad.active()) ?? "");

  // Taking turns.
  await page.click(".monaco-editor .view-lines");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("FIRST-LINE\n");
  await third.waitForFunction(
    () => (window.__pad?.text(window.__pad.active()) ?? "").includes("FIRST-LINE"),
    null, { timeout: 20_000 },
  );

  await third.click(".monaco-editor .view-lines");
  await third.keyboard.press("ControlOrMeta+End");
  await third.keyboard.type("SECOND-LINE\n");
  await page.waitForFunction(
    () => (window.__pad?.text(window.__pad.active()) ?? "").includes("SECOND-LINE"),
    null, { timeout: 20_000 },
  );

  // The other person's cursor: their colour, and no name — the label used to
  // read "guest 3". The colour has to be the one their dot in the header has,
  // or nothing on screen says whose cursor it is.
  await page.waitForSelector(".monaco-editor .remote-caret", { timeout: 20_000 }).catch(() => {});
  const cursor = await page.evaluate(() => {
    const caret = document.querySelector(".monaco-editor .remote-caret");
    const label = document.querySelector(".monaco-editor .remote-label");
    return {
      seen: Boolean(caret),
      carets: document.querySelectorAll(".monaco-editor .remote-caret").length,
      text: label ? getComputedStyle(label, "::after").content : null,
      colour: caret ? getComputedStyle(caret).borderLeftColor : null,
      dots: [...document.querySelectorAll("#presence .person-dot:not(.you)")].map((d) => getComputedStyle(d).backgroundColor),
    };
  });
  is(cursor.seen, true, "the other person's cursor shows");
  // The browser that left a minute ago had this file open too. Its cursor
  // stayed for thirty seconds after it went, until the relay's word counted.
  is(cursor.carets, 1, "and only theirs: nobody who has left still has a cursor");
  is(cursor.text === "none" || cursor.text === '""', true, `and it carries no name (content ${cursor.text})`);
  is(cursor.dots.includes(cursor.colour), true, `and its colour is their dot's (${cursor.colour} in ${cursor.dots})`);

  const afterTurns = await Promise.all([textOf(page), textOf(third)]);
  if (afterTurns.every((t) => t.includes("FIRST-LINE") && t.includes("SECOND-LINE"))) {
    ok("taking turns, both people's work survives in both browsers");
  } else {
    fail(`taking turns lost something: ${JSON.stringify(afterTurns)}`);
  }

  // At the same instant.
  await Promise.all([
    page.keyboard.type("aaaaaaaa"),
    third.keyboard.type("bbbbbbbb"),
  ]);
  await new Promise((r) => setTimeout(r, 3000));
  const [one, two] = await Promise.all([textOf(page), textOf(third)]);
  if (one === two && one.includes("a") && one.includes("b")) {
    ok("typing at once, both browsers converge on the same text");
  } else {
    fail(`typing at once diverged:\n       ${JSON.stringify(one)}\n       ${JSON.stringify(two)}`);
  }

  // ---- typing the moment a file opens ----
  // The editor shows the stored copy straight away, and the shared document
  // binds once the relay has said who is here and somebody has sent it. Until
  // 2 October the folder's first file was bound twice, the second time to the
  // document while it was still empty, and any update about the file ended
  // the wait — so the file went blank while it waited, and what was typed
  // then was merged in wherever the merge put it.
  // The relay's answers are slowed here so the wait is long enough to type
  // into every time rather than by luck — by 400 ms, inside the 600 ms the pad
  // gives somebody to answer; slower than that is a different problem.
  const late = await browser.newPage();
  watchLimits(late, "late");
  await late.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => setTimeout(() => ws.send(m), 400));
  });
  await late.goto(`${ORIGIN}/${name}`, { waitUntil: "domcontentloaded" });
  await late.waitForSelector(".monaco-editor", { timeout: 30_000 });
  const EARLY = "typed-before-the-room-answered";
  await late.click(".monaco-editor .view-lines");
  await late.keyboard.press("ControlOrMeta+End");
  await late.keyboard.type(`\n# ${EARLY}\n`);
  // While the document is on its way, the file stays on screen.
  const blank = [];
  for (let i = 0; i < 10; i++) {
    const text = await late.evaluate(() => window.monaco.editor.getEditors()[0].getValue());
    if (!text.includes("SECOND-LINE")) blank.push(JSON.stringify(text.slice(0, 40)));
    await new Promise((r) => setTimeout(r, 150));
  }
  is(blank.length, 0, `the file stays on screen while its document is on its way${blank.length ? ` — showed ${blank[0]}` : ""}`);
  // Two slowed answers — who is here, then the document — and room to spare.
  await new Promise((r) => setTimeout(r, 6000));
  const keptHere = await textOf(late);
  is(
    keptHere.includes(EARLY) && keptHere.indexOf(EARLY) > keptHere.lastIndexOf("SECOND-LINE"),
    true,
    `typing the moment a file opens is kept, where it was typed${keptHere.includes(EARLY) ? "" : " — it was lost"}`,
  );
  const keptThere = await page
    .waitForFunction((t) => (window.__pad?.text(window.__pad.active()) ?? "").includes(t), EARLY, { timeout: 20_000 })
    .then(() => true, () => false);
  is(keptThere, true, "and reaches the other browser");
  await late.close();

  // ---- a room that answers slowly ----
  // Slower than the 600 ms the pad used to give it, the newcomer stopped
  // waiting and seeded the stored copy. Seeding is safe only when the room's
  // document is that same text; a file the room seeded and then added to and
  // saved is not, and the two documents went on ignoring each other. It waits
  // for an answer now, and seeds only once everyone present has said they do
  // not have the file. (main.py cannot show this: it was replaced wholesale
  // above, so nothing of the room's seed is left to disagree with.)
  await page.click("#terminal");
  await page.keyboard.type("echo seeded-by-the-room > notes.txt\n");
  await page.waitForFunction(() => [...document.querySelectorAll("#files .file")].some((b) => b.textContent === "notes.txt"), null, { timeout: 30_000 });
  await page.click('#files .row.file:text-is("notes.txt")');
  await page.waitForFunction(() => window.__pad?.active() === "notes.txt", null, { timeout: 10_000 });
  await new Promise((r) => setTimeout(r, 1500));
  await page.click(".monaco-editor .view-lines");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("added-by-the-room\n");
  // On the server, not just "saved" on screen — that can be an earlier save,
  // and a stored copy without the added line is the room's own seed, which is
  // exactly the case where seeding happens to be safe.
  for (let i = 0; i < 40; i++) {
    const stored = await fetch(`${ORIGIN}/api/pad/${name}`).then((r) => r.json());
    if (stored.files["notes.txt"]?.content.includes("added-by-the-room")) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const slow = await browser.newPage();
  watchLimits(slow, "slow");
  await slow.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => setTimeout(() => ws.send(m), 1500));
  });
  await slow.goto(`${ORIGIN}/${name}`, { waitUntil: "domcontentloaded" });
  await slow.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await slow.click('#files .row.file:text-is("notes.txt")');
  // Who is here, then the document, each 1.5 s late — and room to spare.
  await new Promise((r) => setTimeout(r, 7000));
  await slow.click(".monaco-editor .view-lines");
  await slow.keyboard.press("ControlOrMeta+End");
  await slow.keyboard.type("from-the-slow-one\n");
  await page.click(".monaco-editor .view-lines");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("to-the-slow-one\n");
  const reaches = (tab, t) => tab
    .waitForFunction((t) => (window.__pad?.text("notes.txt") ?? "").includes(t), t, { timeout: 20_000 })
    .then(() => true, () => false);
  const [there, here] = await Promise.all([reaches(page, "from-the-slow-one"), reaches(slow, "to-the-slow-one")]);
  // The same text on both sides, not only each other's lines.
  await new Promise((r) => setTimeout(r, 1500));
  const textIn = (tab) => tab.evaluate(() => window.__pad?.text("notes.txt") ?? "");
  const [roomText, newcomerText] = await Promise.all([textIn(page), textIn(slow)]);
  const converged = there && here && roomText === newcomerText;
  if (!converged) results.push(`note: room ${JSON.stringify(roomText.slice(0, 120))} newcomer ${JSON.stringify(newcomerText.slice(0, 120))}`);
  is(converged, true, `a room that answers slowly still ends up with one document${there ? "" : " — the room never got the newcomer's line"}${here ? "" : " — the newcomer never got the room's"}`);
  await slow.close();
  // Back to the file the rest of this check works in.
  await page.click('#files .row.file:text-is("main.py")');

  // ---- deleting a file from the tree ----
  // For everyone: gone from the other browser's tree and from the server.
  //
  // Including a browser whose runtime is still downloading, which is every
  // first visit for a while. Its tree used to wait for the runtime before
  // taking anyone else's change; on 2 October that was one slow package from
  // the CDN, and this check failed for it. Held back here on purpose: 25 s,
  // so the delete lands while it waits and the old code — which showed it
  // only once the runtime came — misses the 15 s allowed below. Not much
  // longer: held 40 s, the SDK gave up on the packages and never started.
  const loading = await browser.newPage();
  watchLimits(loading, "loading");
  await loading.context().route(/\/packages\/.*\.webc/, async (route) => {
    await new Promise((r) => setTimeout(r, 25_000));
    await route.continue().catch(() => {});
  });
  await loading.goto(`${ORIGIN}/${name}`, { waitUntil: "domcontentloaded" });
  await loading.waitForFunction(() => [...document.querySelectorAll("#files .file")].some((b) => b.textContent === "out.csv"), null, { timeout: 30_000 });
  const gone = (tab, timeout) => tab
    .waitForFunction(() => ![...document.querySelectorAll("#files .file")].some((b) => b.textContent === "out.csv"), null, { timeout })
    .then(() => true, () => false);
  page.once("dialog", (d) => d.accept());
  await page.hover('#files .file-row:has(.row.file:text-is("out.csv"))');
  await page.click('#files .file-row:has(.row.file:text-is("out.csv")) .delete');
  const [goneThere, goneWhileLoading] = await Promise.all([gone(third, 20_000), gone(loading, 15_000)]);
  is(goneThere, true, "a file deleted in one browser leaves the other's tree");
  is(goneWhileLoading, true, "and the tree of one whose runtime is still downloading");
  // Its sandbox was seeded before the delete. When the runtime arrives, the
  // file has to be gone from there too, or its next run brings it back.
  await loading.click("#terminal");
  await loading.keyboard.type("ls\n");
  const listed = await loading
    .waitForFunction(() => /main\.py/.test(document.getElementById("terminal")?.textContent ?? ""), null, { timeout: 120_000 })
    .then(() => loading.evaluate(() => document.getElementById("terminal")?.textContent ?? ""), () => null);
  if (listed === null || listed.includes("out.csv")) results.push(`note: its terminal ${JSON.stringify(listed?.slice(-300) ?? "never listed")}`);
  is(listed !== null && !listed.includes("out.csv"), true, "and its sandbox, once that runtime arrives");
  const afterDelete = await fetch(`${ORIGIN}/api/pad/${name}`).then((r) => r.json());
  is("out.csv" in afterDelete.files, false, "and the server's copy of the folder");

  await loading.close();
  await third.close();

  // ---- typing into the shell, which is the thing it is for ----
  await page.click("#terminal");
  await page.keyboard.type("echo typed-by-hand > hand.txt\n");
  await page.waitForFunction(
    () => (document.getElementById("terminal")?.textContent ?? "").includes("typed-by-hand"),
    null, { timeout: 30_000 },
  );
  ok("what you type appears on screen — the page echoes it, bash will not");

  await page.waitForFunction(
    () => [...document.querySelectorAll("#files .file")].some((b) => b.textContent === "hand.txt"),
    null, { timeout: 30_000 },
  );
  ok("a file made by a typed command joins the folder");

  await page.keyboard.type("cat hand.txt\n");
  await page.waitForFunction(
    () => ((document.getElementById("terminal")?.textContent ?? "").match(/typed-by-hand/g) ?? []).length >= 2,
    null, { timeout: 30_000 },
  );
  ok("cat works, and so does everything else bash can reach");

  // ---- a command that reads stdin ----
  //
  // `cat` with no arguments hung the terminal: the sentinel was sent as a
  // second line, `cat` read it as input, printed it, and waited forever with
  // nothing left to signal the end. And nothing typed afterwards reached it,
  // because the line editor was swallowing input while a command ran.
  await page.click("#terminal");
  await page.keyboard.type("cat\n");
  await new Promise((r) => setTimeout(r, 1500));
  const leaked = await page.evaluate(
    () => (document.getElementById("terminal")?.textContent ?? "").includes("001%s"),
  );
  is(leaked, false, "a command that reads stdin does not swallow the sentinel");

  // Twice: once because the terminal echoed it, once because `cat` printed it
  // back. Either alone would mean half of this is broken.
  await page.keyboard.type("typed-into-cat\n");
  await page.waitForFunction(
    () =>
      ((document.getElementById("terminal")?.textContent ?? "").match(/typed-into-cat/g) ?? [])
        .length >= 2,
    null, { timeout: 20_000 },
  );
  ok("what you type reaches a running command, and it answers");

  // ctrl-c stops it. ctrl-d does not — this pty has no canonical mode, so
  // there is no EOF to send.
  //
  // Asserted on the console's own state and then on a command that leaves a
  // *file* behind. The first version watched for the command's text in the
  // terminal, which `cat` was echoing back anyway, so it passed while `cat`
  // was still running and everything typed after it was going nowhere.
  await page.keyboard.press("Control+c");
  await page.waitForFunction(() => window.__pad?.shellBusy() === false, null, { timeout: 20_000 });
  ok("ctrl-c stops a command that is waiting for input");

  await page.keyboard.type("echo still-works > after-cat.txt\n");
  await page.waitForFunction(
    () => [...document.querySelectorAll("#files .row.file")].some((r) => r.textContent?.includes("after-cat.txt")),
    null, { timeout: 30_000 },
  );
  ok("and the shell runs commands again afterwards");

  // ---- making a file from the page ----
  page.once("dialog", (d) => d.accept("notes.py"));
  await page.click('#files button[aria-label="New file"]');
  await page.waitForFunction(
    () => [...document.querySelectorAll("#files .file")].some((b) => b.textContent === "notes.py"),
    null, { timeout: 15_000 },
  );
  ok("you can make a new file");

  // Folders come from the paths under them, so one made in the shell has to
  // show up as a folder rather than as a file with a slash in its name.
  await page.click("#terminal");
  await page.keyboard.type("mkdir -p data && echo 1,2 > data/rows.csv\n");
  await page.waitForFunction(
    () => [...document.querySelectorAll("#files .row.dir")].some((r) => r.textContent?.includes("data")),
    null, { timeout: 30_000 },
  );
  ok("a folder made in the shell appears as a folder");
  await page.waitForFunction(
    () => [...document.querySelectorAll("#files .row.file")].some((r) => r.textContent?.includes("rows.csv")),
    null, { timeout: 15_000 },
  );
  ok("and the file inside it is nested under it");

  // The deployed policy has to carry the same hash as the page, or the import
  // map is blocked in production only — where nobody would see it until WISP
  // was switched on and did not work.
  {
    const caddy = await readFile(new URL("../../deploy/Caddyfile", import.meta.url), "utf8");
    caddy.includes(`'sha256-${IMPORTMAP_SHA}'`)
      ? ok("the deployed CSP allows the import map this page actually ships")
      : fail(`deploy/Caddyfile does not carry 'sha256-${IMPORTMAP_SHA}' — the import map will be blocked in production`);
  }

  // ---- the editor ----
  //
  // A full-screen program was supposed to be impossible here — `console.ts`
  // says so, and curses cannot initialise for want of a terminfo database.
  // What is actually true is narrower: raw mode, single-byte reads, cursor
  // escapes and a real terminal size all work, so an editor written straight
  // against ANSI works too.
  //
  // The last three are the ones that matter. An editor that leaves the
  // terminal in the alternate buffer, or takes the shell with it on the way
  // out, is worse than having no editor.
  await page.keyboard.type("printf 'first\\nsecond\\n' > note.txt\n");
  await page.waitForTimeout(6000);
  await page.keyboard.type("nano note.txt\n");
  await page.waitForTimeout(10_000);
  const editor = await page.evaluate(() => document.querySelector(".xterm-screen")?.innerText ?? "");
  is(
    editor.includes("note.txt") && (editor.includes("^O Save") || editor.includes("^X Exit")),
    true,
    "the editor opens on a file, with its key bar",
  );
  is(editor.includes("first") && editor.includes("second"), true, "and shows what is in it");

  await page.keyboard.press("End");
  await page.waitForTimeout(800);
  await page.keyboard.type("-EDITED");
  await page.waitForTimeout(1500);
  is(
    (await page.evaluate(() => document.querySelector(".xterm-screen")?.innerText ?? "")).includes("first-EDITED"),
    true,
    "typing reaches it and the screen redraws",
  );

  await page.keyboard.press("Control+o");
  await page.waitForTimeout(3000);
  is(
    /Wrote \d+ line/.test(await page.evaluate(() => document.querySelector(".xterm-screen")?.innerText ?? "")),
    true,
    "ctrl-o writes the file",
  );

  await page.keyboard.press("Control+x");
  await page.waitForTimeout(4000);
  await page.keyboard.type("cat note.txt\n");
  await page.waitForTimeout(8000);
  const back = await page.evaluate(() => document.querySelector(".xterm-screen")?.innerText ?? "");
  is(back.includes("first-EDITED"), true, "the edit is on disk after leaving");
  is(back.includes("^O Save"), false, "the terminal was restored rather than left in it");

  // Proven by the shell doing something, not by the absence of a string. An
  // earlier check here interrupts `cat` on purpose, so "shell restarted" is
  // still on screen from that — a negative assertion on shared scrollback
  // reports the previous test's work as this one's failure.
  await page.keyboard.type("echo after-editor\n");
  await page.waitForFunction(
    () => (document.getElementById("terminal")?.textContent ?? "").includes("after-editor"),
    null, { timeout: 20_000 },
  );
  ok("the same shell still runs commands afterwards");

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
    // The pin works by rewriting a registry answer whose shape the SDK
    // chooses. If that shape changes, the pin quietly stops applying and the
    // dependency floats again; this is what notices.
    is(swStats.pinned > 0, true, "bash's coreutils resolved through the pin in sw.js");
  }

} catch (e) {
  fail(`${e.message.split("\n")[0]}`);
  await page.screenshot({ path: fileURLToPath(new URL("../failed.png", import.meta.url)) });
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
  for (const [who, tab] of tabs) {
    if (tab.isClosed()) continue;
    const other = await tab.evaluate(() => ({
      status: document.getElementById("status")?.textContent,
      terminal: (document.getElementById("terminal")?.textContent ?? "").slice(-200),
    })).catch(() => null);
    if (other) results.push(`note: ${who}: status=${JSON.stringify(other.status)} terminal=${JSON.stringify(other.terminal)}`);
  }
}

{
  const dom = await page.evaluate(() => ({
    rows: document.querySelectorAll("#files .row").length,
    bar: document.querySelectorAll("#files .tree-bar button").length,
    filesHTML: (document.getElementById("files")?.innerHTML ?? "").length,
    editors: document.querySelectorAll(".monaco-editor").length,
    editorBox: document.getElementById("editor")?.getBoundingClientRect().height,
    filesBox: document.getElementById("files")?.getBoundingClientRect(),
  }));
  results.push(`note: dom ${JSON.stringify(dom)}`);
}
// One look at the finished page, so the layout is reviewed rather than assumed.
await page.screenshot({ path: fileURLToPath(new URL("../shot.png", import.meta.url)) });
await browser.close();
if (!LIVE) {
  server.close();
  relay.kill();
  await rm(padDir, { recursive: true, force: true });
}

if (limited > 0) {
  results.push(`note: ${limited} requests refused with 429 — this address has used its hourly allowance on the live site; wait an hour and run it again`);
}
for (const line of results) console.log(`  ${line}`);
const failed = results.filter((l) => l.startsWith("FAIL"));
console.log(failed.length ? `\n  ${failed.length} failed\n` : "\n  the loop works\n");
process.exit(failed.length ? 1 : 0);

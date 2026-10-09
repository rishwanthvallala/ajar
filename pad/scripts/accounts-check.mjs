#!/usr/bin/env node
// Accounts in the browser: signing in, a pad of your own, its links, and what
// a viewer can and cannot do — driven the way people would, three of them at
// once: the owner, someone with the edit link, and someone with the bare name.
//
// scripts/smoke-accounts.mjs proves the relay enforces all of this; this one
// proves the pages make sense of it.
//
//   npx vite build && node scripts/accounts-check.mjs

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CH_CONTROL, encode, Guest } from "../../scripts/lib/wire.mjs";

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = 5210;
const RELAY_PORT = 8862;
const PROVIDER_PORT = 8863;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PROVIDER = `http://127.0.0.1:${PROVIDER_PORT}`;

const results = [];
const ok = (m) => results.push(`ok   ${m}`);
const fail = (m) => results.push(`FAIL ${m}`);
const is = (a, b, m) => (a === b ? ok(m) : fail(`${m} — got ${JSON.stringify(a)}`));

// ------------------------------------------------- a stand-in for GitHub

const issued = new Map();
const provider = createServer(async (req, res) => {
  const url = new URL(req.url, PROVIDER);
  if (url.pathname === "/authorize") {
    const code = `c${Math.random().toString(36).slice(2)}`;
    issued.set(code, url.searchParams.get("code_challenge"));
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    return res.writeHead(302, { location: back.toString() }).end();
  }
  if (url.pathname === "/token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (issued.get(form.get("code")) !== challenge) return res.writeHead(400).end('{"error":"pkce"}');
    issued.delete(form.get("code"));
    return res.writeHead(200, { "content-type": "application/json" }).end('{"access_token":"t-ana"}');
  }
  if (url.pathname === "/user") {
    if (req.headers.authorization !== "Bearer t-ana") return res.writeHead(401).end();
    return res.writeHead(200, { "content-type": "application/json" }).end('{"id":7,"login":"ana"}');
  }
  res.writeHead(404).end();
});
await new Promise((r) => provider.listen(PROVIDER_PORT, "127.0.0.1", r));

// ------------------------------------------------------ relay and page

const dir = await mkdtemp(join(tmpdir(), "ajar-accounts-check-"));
const relay = spawn(
  fileURLToPath(new URL("../../target/debug/ajar-relay", import.meta.url)),
  ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", join(dir, "pads"), "--accounts-db", join(dir, "accounts.db")],
  {
    stdio: "ignore",
    env: {
      ...process.env,
      AJAR_PUBLIC_ORIGIN: ORIGIN,
      AJAR_ADMINS: "github:7",
      AJAR_GITHUB_CLIENT_ID: "id",
      AJAR_GITHUB_CLIENT_SECRET: "secret",
      AJAR_GITHUB_AUTHORIZE_URL: `${PROVIDER}/authorize`,
      AJAR_GITHUB_TOKEN_URL: `${PROVIDER}/token`,
      AJAR_GITHUB_USERINFO_URL: `${PROVIDER}/user`,
    },
  },
);
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}

const TYPES = { ".html": "text/html", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript" };
const IMPORTMAP_SHA = createHash("sha256")
  .update(/<script type="importmap">(.*?)<\/script>/s.exec(await readFile(join(ROOT, "index.html"), "utf8"))[1].replace(/\r\n?/g, "\n"))
  .digest("base64");

const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  // The deployed policy, so nothing here works only because it is looser.
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'unsafe-eval' blob: 'sha256-${IMPORTMAP_SHA}'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss: https://registry.wasmer.io https://cdn.wasmer.io; frame-ancestors 'none'; base-uri 'none'`,
  );
  const urlPath = new URL(req.url, "http://x").pathname;
  // What Caddy sends to the relay: the store, and signing in.
  if (urlPath.startsWith("/api/") || urlPath.startsWith("/auth/")) {
    const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end("relay unreachable"));
    return req.pipe(up);
  }
  const relative = urlPath.split("/").filter((p) => p && p !== "." && p !== "..").join("/");
  const file = join(ROOT, relative || "index.html");
  try {
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.setHeader("Content-Type", "text/html");
    res.end(await readFile(join(ROOT, "index.html")));
  }
});
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers });
  up.on("upgrade", (res, upSocket, upHead) => {
    upSocket.on("error", () => upSocket.destroy());
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket).pipe(upSocket);
  });
  up.on("error", () => socket.destroy());
  if (head?.length) up.write(head);
  up.end();
});
await new Promise((r) => server.listen(PORT, r));

// ------------------------------------------------------------- helpers

const browser = await chromium.launch({ channel: process.env.PAD_BROWSER_CHANNEL || undefined });
/** A second browser with the back-forward cache left on — see "Back, into a page the browser kept". */
let cacheBrowser = null;
const pages = new Map();
async function person(label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => fail(`${label}: page error: ${e.message.slice(0, 160)}`));
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) fail(`${label}: CSP: ${m.text().slice(0, 160)}`);
  });
  // Confirms are answered yes, prompts with what they suggest, and leaving
  // with local changes is let through.
  page.on("dialog", (d) => void (d.type() === "prompt" ? d.accept(d.defaultValue()) : d.accept()));
  pages.set(label, page);
  return page;
}
const until = (page, fn, arg, timeout = 20_000) => page.waitForFunction(fn, arg, { timeout });
const role = (page) => page.evaluate(() => window.__pad?.role());
const text = (page, path) => page.evaluate((p) => window.__pad?.text(p) ?? "", path);
async function typeAtEnd(page, path, words) {
  await page.click(`#files .row.file[data-path="${path}"]`);
  await until(page, (p) => window.__pad?.active() === p, path);
  // The end through Monaco, not Cmd+End, which is no binding on a Mac: the
  // cursor stays wherever the click put it.
  await page.evaluate(() => {
    const editor = window.monaco.editor.getEditors()[0];
    const model = editor.getModel();
    editor.focus();
    editor.setPosition(model.getPositionAt(model.getValueLength()));
  });
  await page.keyboard.type(words);
}
let ownerCookie = "";
async function stored(name) {
  const res = await fetch(`${ORIGIN}/api/pad/${name}`, { headers: { cookie: ownerCookie } });
  return res.ok ? (await res.json()).files : null;
}
async function storedHas(name, path, needle, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await stored(name))?.[path]?.content.includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- checks

try {
  // ---- signing in ----
  const owner = await person("owner");
  await owner.goto(`${ORIGIN}/dashboard`);
  await owner.waitForSelector("text=Pads you control");
  is(await owner.locator("a.provider", { hasText: "Continue with GitHub" }).count(), 1, "signed out, the dashboard offers GitHub");
  await owner.click("text=Continue with GitHub");
  await owner.waitForSelector("text=Your pads", { timeout: 15_000 });
  is(new URL(owner.url()).pathname, "/dashboard", "signing in comes back to the dashboard");
  ownerCookie = (await owner.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  is((await owner.context().cookies()).find((c) => c.name === "ajar")?.httpOnly, true, "the session cookie is HttpOnly");
  is(await owner.locator(".account-name").textContent(), "ana", "it says who is signed in");
  await owner.click(".account-button");
  is((await owner.locator(".menu-who").textContent()).includes("GitHub"), true, "and with what, in the account menu");
  await owner.keyboard.press("Escape");

  // ---- a pad of one's own ----
  // An empty dashboard has one way to make a pad: the empty state's own.
  is(await owner.locator("#new-pad").isVisible(), false, "an empty dashboard does not show two New pad buttons");
  await owner.getByRole("button", { name: "Make your first pad" }).click();
  await owner.waitForURL(/\/[a-z]+-[a-z]+-[a-z]+$/, { timeout: 15_000 });
  const name = new URL(owner.url()).pathname.slice(1);
  ok(`New pad opens a three-word pad (${name})`);
  await owner.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(owner, () => window.__pad?.role() === "owner");
  is(await owner.locator("#readonly").isVisible(), false, "the owner sees no view-only badge");
  is(await owner.locator("#away").isVisible(), false, "and no viewer's banner");
  await typeAtEnd(owner, "main.py", "# by-the-owner\n");
  is(await storedHas(name, "main.py", "by-the-owner"), true, "the owner's typing is saved");
  // Typing in a tab closed inside its save delay. The owner's first tab is in
  // the room and has the text too, but only the typist saves.
  const brief = await owner.context().newPage();
  await brief.goto(`${ORIGIN}/${name}`);
  await until(brief, () => window.__pad?.role() === "owner" && window.__pad?.docs().includes("main.py"), undefined, 30_000);
  await typeAtEnd(brief, "main.py", "# closed-at-once\n");
  await brief.close({ runBeforeUnload: true });
  is(await storedHas(name, "main.py", "closed-at-once", 5000), true, "typing in a tab closed before its save comes is saved as the tab goes");

  // ---- the share dialog ----
  await owner.click("#share");
  await owner.waitForSelector(".share-dialog .share-url");
  const urls = await owner.$$eval(".share-dialog .share-url", (inputs) => inputs.map((i) => i.dataset.url));
  const viewUrl = urls.find((u) => !u.includes("#"));
  const editUrl = urls.find((u) => u.includes("#"));
  is(viewUrl, `${ORIGIN}/${name}`, "the view link is the plain address while anyone with it can view");
  is(!!editUrl && /#[A-Za-z0-9_-]{22}$/.test(editUrl), true, "the edit link carries a code after the #");
  is(await owner.locator(".share-dialog select").count(), 2, "the owner can set who views and who edits");
  await owner.keyboard.press("Escape");

  // ---- an editor, from the edit link ----
  const editor = await person("editor");
  await editor.goto(editUrl);
  await editor.waitForSelector(".monaco-editor", { timeout: 30_000 });
  is(await editor.evaluate(() => location.hash), "", "the code is taken out of the address bar");
  is(await editor.evaluate((n) => localStorage.getItem(`pad.code.${n}`), name), editUrl.split("#")[1], "and kept for this pad");
  await until(editor, () => window.__pad?.role() === "editor");
  ok("the edit link opens it to edit");
  await until(editor, () => window.__pad?.text("main.py")?.includes("by-the-owner"));
  await typeAtEnd(editor, "main.py", "# by-the-editor\n");
  await until(owner, () => window.__pad?.text("main.py")?.includes("by-the-editor"));
  ok("the editor's typing reaches the owner live");
  // Not about accounts, but it takes two people and a Run: a file somebody
  // else types in while you look at another keeps an old copy in your editor,
  // and Run used to write that copy into the sandbox and save it over theirs.
  await editor.click('#files button[aria-label="New file"]');
  await until(editor, () => window.__pad?.active() === "untitled.py");
  await typeAtEnd(owner, "main.py", "# while-you-were-away\n");
  await until(editor, () => window.__pad?.text("main.py")?.includes("while-you-were-away"));
  is(await storedHas(name, "main.py", "while-you-were-away"), true, "the owner's line is saved");
  await sleep(1000);
  await typeAtEnd(editor, "untitled.py", "print('ran')\n");
  await editor.click("#run");
  await until(editor, () => document.getElementById("status")?.textContent === "done", undefined, 180_000);
  await sleep(1000);
  is((await stored(name))["main.py"]?.content.includes("while-you-were-away"), true, "Run in another file leaves the owner's newer line saved");

  await editor.click("#share");
  await editor.waitForSelector(".share-dialog .share-url");
  const editorUrls = await editor.$$eval(".share-dialog .share-url", (inputs) => inputs.map((i) => i.dataset.url));
  is(editorUrls.includes(editUrl) && editorUrls.includes(viewUrl), true, "an editor can pass on editing, and viewing while it is open");
  await editor.keyboard.press("Escape");

  // ---- where a file was left, while someone else edits it ----
  {
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await fetch(`${ORIGIN}/api/pad/${name}`, { method: "PUT", headers: { cookie: ownerCookie, "content-type": "application/json" }, body: JSON.stringify({ writes: [{ path: "long.txt", content: long }] }) });
    await owner.reload();
    await owner.waitForSelector('#files .row.file[data-path="long.txt"]', { timeout: 30_000 });
    await until(owner, () => window.__pad?.role() === "owner");
    const openIn = async (tab, path) => {
      await tab.click(`#files .row.file[data-path="${path}"]`);
      await until(tab, (p) => window.__pad?.active() === p && window.__pad?.docs().includes(p), path);
      await tab.waitForTimeout(400);
    };
    const placeOf = (tab) => tab.evaluate(() => {
      const ed = window.monaco.editor.getEditors()[0];
      return { top: ed.getVisibleRanges()[0]?.startLineNumber ?? 0, cursor: ed.getPosition()?.lineNumber ?? 0 };
    });
    await openIn(owner, "long.txt");
    await owner.evaluate(() => {
      const ed = window.monaco.editor.getEditors()[0];
      ed.setPosition({ lineNumber: 1000, column: 1 });
      ed.revealLineInCenter(1000);
    });
    await owner.waitForTimeout(200);
    const leftAt = await placeOf(owner);
    await openIn(owner, "main.py");
    // The editor types near the top while the owner is in another file.
    await editor.waitForSelector('#files .row.file[data-path="long.txt"]', { timeout: 15_000 });
    await openIn(editor, "long.txt");
    await editor.evaluate(() => {
      const ed = window.monaco.editor.getEditors()[0];
      ed.setPosition({ lineNumber: 5, column: 1 });
      ed.focus();
    });
    await editor.keyboard.type("// edited meanwhile ");
    await until(owner, () => (window.__pad?.text("long.txt") ?? "").includes("edited meanwhile"), undefined, 15_000);
    await openIn(owner, "long.txt");
    const back = await placeOf(owner);
    const hasEdit = (await owner.evaluate(() => window.monaco.editor.getEditors()[0].getModel().getLineContent(5))).includes("edited meanwhile");
    is(hasEdit && back.cursor === 1000 && back.top === leftAt.top, true, `a file someone else edited while the owner was in another opens again where the owner left it, with their edit (left ${JSON.stringify(leftAt)}, back ${JSON.stringify(back)}, edit ${hasEdit})`);
    await openIn(editor, "main.py");
    await openIn(owner, "main.py");
  }

  // ---- moving a file, seen by everyone ----
  // The owner drags a file into a folder; the editor's tree follows on its
  // next read, and the store holds it at the new path alone.
  await fetch(`${ORIGIN}/api/pad/${name}`, {
    method: "PUT",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ writes: [{ path: "lib/keep.txt", content: "keep\n" }, { path: "move-me.txt", content: "moving\n" }] }),
  });
  await owner.reload();
  await owner.waitForSelector('#files .row.file[data-path="move-me.txt"]', { timeout: 30_000 });
  await until(owner, () => window.__pad?.role() === "owner");
  await owner.locator('#files .row.file[data-path="move-me.txt"]').dragTo(owner.locator('#files .row.dir[data-path="lib"]'));
  const seenThere = await until(editor, () => {
    const have = [...document.querySelectorAll("#files .row.file")].map((b) => b.dataset.path);
    return have.includes("lib/move-me.txt") && !have.includes("move-me.txt");
  }, undefined, 15_000).then(() => true, () => false);
  const afterMove = await stored(name);
  is(seenThere && afterMove?.["lib/move-me.txt"]?.content === "moving\n" && !("move-me.txt" in (afterMove ?? {})), true, "a file the owner drags into a folder moves there for the editor too, and in the store");

  // ---- Back, into a page the browser kept ----
  // Browsers keep a page they leave in a back-forward cache and show it again,
  // frozen as it was, on Back. Playwright switches that cache off, so every
  // check passed while a pad came back from Your pads empty and dead: it tore
  // itself down on the way out. Here with the cache on, as a person has it.
  cacheBrowser = await chromium.launch({ channel: "chromium", ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  const cached = await cacheBrowser.newContext({ storageState: await owner.context().storageState() });
  const tab = await cached.newPage();
  pages.set("cached owner", tab);
  tab.on("pageerror", (e) => fail(`cached owner: page error: ${e.message.slice(0, 160)}`));
  await tab.addInitScript(() => {
    window.__restored = 0;
    addEventListener("pageshow", (e) => {
      if (e.persisted) window.__restored += 1;
    });
    // Every socket the page opens, so the check can play a browser that does
    // not say a cached page's socket closed.
    const Real = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Real {
      constructor(...args) {
        super(...args);
        window.__sockets.push(this);
      }
    };
  });
  // Back, and whether the page came out of the cache rather than loading
  // again. A browser may decline to keep a page — under load, CI's did, now
  // and then — so a miss is tried once more, forward and back again; still
  // missed, the browser's reasons are noted. Every check below holds on
  // either path; the first must have come from the cache, or none of this
  // tested what it is for.
  const backFromCache = async (page, label) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) {
        await page.goForward({ waitUntil: "commit" });
        await page.waitForTimeout(1500);
      }
      const before = await page.evaluate(() => window.__restored).catch(() => 0);
      await page.goBack({ waitUntil: "commit" });
      if (await page.waitForFunction((n) => window.__restored > n, before, { timeout: 10_000 }).then(() => true, () => false)) return true;
    }
    results.push(`note: ${label}: Back was a fresh load, not the cached page: ${await page.evaluate(() => JSON.stringify(performance.getEntriesByType("navigation")[0]?.notRestoredReasons ?? null)).catch((e) => e.message)}`);
    return false;
  };
  await tab.goto(`${ORIGIN}/${name}`);
  await until(tab, () => window.__pad?.role() === "owner" && window.__pad?.docs().length > 0, undefined, 30_000);
  // Chrome closes the socket of a page it caches and says so on the way back,
  // which the ordinary reconnect answers. A browser that closes it without
  // saying would leave the room dead; the page dials again on its own.
  await tab.evaluate(() => {
    for (const s of window.__sockets) s.onclose = null;
  });
  await tab.click("#your-pads");
  await tab.waitForSelector("text=Your pads", { timeout: 15_000 });
  const fromCacheA = await backFromCache(tab, "Back to the pad");
  await tab.waitForSelector(".monaco-editor .view-lines", { timeout: 30_000 }).catch(() => {});
  const editorBack = await tab.evaluate(() => !!window.monaco?.editor.getEditors()[0]?.getModel() && !!document.querySelector(".monaco-editor .view-lines"));
  is(fromCacheA, true, "Back from Your pads comes out of the back-forward cache here, so the checks below test the page people get");
  is(editorBack, true, `and the pad is still there (cached ${fromCacheA})`);
  await typeAtEnd(tab, "main.py", "# typed-after-back\n");
  is(await storedHas(name, "main.py", "typed-after-back"), true, "and typing in it is saved");
  await typeAtEnd(editor, "main.py", "# live-after-back\n");
  is(await until(tab, () => window.__pad?.text("main.py").includes("live-after-back"), undefined, 15_000).then(() => true, () => false), true, "and its room is back: someone else's typing arrives live");

  // The dashboard the same way: New pad navigates away with its button busy.
  await tab.goto(`${ORIGIN}/dashboard`);
  await tab.waitForSelector(".pad-card", { timeout: 15_000 });
  const padsBefore = await tab.locator(".pad-card").count();
  await tab.locator("#new-pad").click();
  await tab.waitForURL(/\/[a-z]+-[a-z]+-[a-z]+$/, { timeout: 15_000 });
  const madeHere = new URL(tab.url()).pathname.slice(1);
  await tab.waitForSelector(".monaco-editor", { timeout: 30_000 });
  const fromCacheB = await backFromCache(tab, "Back to the dashboard");
  await tab.waitForSelector("#new-pad", { timeout: 15_000 }).catch(() => {});
  const newPadFree = await tab.locator("#new-pad").getAttribute("aria-busy");
  const listed = await tab.waitForFunction((n) => document.querySelectorAll(".pad-card").length > n, padsBefore, { timeout: 15_000 }).then(() => true, () => false);
  is(newPadFree === null && listed, true, `Back to the dashboard, New pad works again and the new pad is listed (cached ${fromCacheB}, busy ${newPadFree}, listed ${listed})`);
  // Copy a pad leaves from inside its dialog, which the dashboard's own
  // return check waits out: the dialog closes, and the list is read again.
  const padsNow = await tab.locator(".pad-card").count();
  await tab.getByRole("button", { name: "Copy a pad" }).click();
  await tab.locator("dialog.copy-dialog").getByLabel("Link to a pad").fill(`${ORIGIN}/${name}`);
  await tab.locator("dialog.copy-dialog").getByRole("button", { name: "Make a copy" }).click();
  await tab.waitForURL((u) => /^\/[a-z]+-[a-z]+-[a-z]+$/.test(u.pathname) && u.pathname !== `/${name}`, { timeout: 15_000 });
  const copiedHere = new URL(tab.url()).pathname.slice(1);
  await tab.waitForSelector(".monaco-editor", { timeout: 30_000 });
  const fromCacheD = await backFromCache(tab, "Back from a copy to the dashboard");
  await tab.waitForSelector(".pad-card", { timeout: 15_000 }).catch(() => {});
  const dialogGone = await tab.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 5000 }).then(() => true, () => false);
  const copyListed = await tab.waitForFunction((n) => document.querySelectorAll(".pad-card").length > n, padsNow, { timeout: 15_000 }).then(() => true, () => false);
  is(dialogGone && copyListed, true, `and back from a copy, its dialog is closed and the copy is listed (cached ${fromCacheD}, closed ${dialogGone}, listed ${copyListed})`);
  for (const n of [madeHere, copiedHere]) await fetch(`${ORIGIN}/api/my/pads/${n}`, { method: "DELETE", headers: { cookie: ownerCookie, "x-ajar": "1" } });

  // And a viewer's Save as my copy, which also leaves the page as it goes.
  const strangerCtx = await cacheBrowser.newContext();
  const looking = await strangerCtx.newPage();
  pages.set("cached viewer", looking);
  looking.on("dialog", (d) => void d.accept());
  await looking.addInitScript(() => {
    window.__restored = 0;
    addEventListener("pageshow", (e) => {
      if (e.persisted) window.__restored += 1;
    });
  });
  await looking.goto(viewUrl);
  await until(looking, () => window.__pad?.role() === "viewer", undefined, 30_000);
  await looking.click("#away button:has-text('Save as my copy')");
  await looking.locator("dialog.modal-confirm").getByRole("button", { name: "Make an open pad" }).click();
  await looking.waitForURL((u) => !u.pathname.endsWith(name), { timeout: 15_000 });
  const fromCacheC = await backFromCache(looking, "Back from a viewer's copy");
  await looking.waitForSelector("#away button:has-text('Save as my copy')", { timeout: 30_000 }).catch(() => {});
  await looking.click("#away button:has-text('Save as my copy')");
  const asksAgain = await looking.locator("dialog.modal-confirm").waitFor({ timeout: 5000 }).then(() => true, () => false);
  is(asksAgain, true, `Back from a copy, Save as my copy answers again (cached ${fromCacheC}, asked ${asksAgain})`);
  await looking.keyboard.press("Escape");
  await cached.close();
  await strangerCtx.close();
  // Not left idling to the end: one more browser is load the runner can do without.
  await cacheBrowser.close();
  cacheBrowser = null;

  // ---- a viewer, from the bare name ----
  const viewer = await person("viewer");
  await viewer.goto(viewUrl);
  await viewer.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(viewer, () => window.__pad?.role() === "viewer");
  ok("the bare name opens it to view");
  is(await viewer.locator("#away .viewing-pill").textContent(), "Viewing", "the banner says Viewing");
  is(await viewer.locator("#away .viewing-text").isVisible(), true, "a banner says changes stay in the tab");
  await until(viewer, () => window.__pad?.text("main.py")?.includes("by-the-editor"));
  await typeAtEnd(owner, "main.py", "# live-one\n");
  await until(viewer, () => window.__pad?.text("main.py")?.includes("live-one"));
  ok("a viewer watches typing live");
  is(await viewer.evaluate(() => [...document.querySelectorAll("#files .row")].every((r) => !r.draggable)), true, "a viewer cannot drag anything in the tree");

  await typeAtEnd(viewer, "main.py", "# the-viewers-own\n");
  await until(viewer, () => window.__pad?.local().includes("main.py"));
  is(await viewer.locator('#files .row.file[data-path="main.py"]').getAttribute("class").then((c) => c.includes("local")), true, "the file is marked local in the tree");
  is((await viewer.locator("#away .viewing-text").textContent()).includes("your own copy of main.py"), true, "the banner says it is their own copy");
  await sleep(1500);
  is((await stored(name))["main.py"].content.includes("the-viewers-own"), false, "a viewer's typing is not saved to the pad");
  is((await text(owner, "main.py")).includes("the-viewers-own"), false, "nor does it reach the owner");
  await typeAtEnd(owner, "main.py", "# live-two\n");
  await storedHas(name, "main.py", "live-two");
  await sleep(1000);
  is((await text(viewer, "main.py")).includes("live-two"), false, "the pad's changes no longer arrive in the viewer's copy");
  is((await text(viewer, "main.py")).includes("the-viewers-own"), true, "which keeps what they typed");

  // A command in the viewer's terminal.
  await viewer.click("#terminal");
  await viewer.keyboard.type("echo scratch > scratch.txt\n");
  await until(viewer, () => document.querySelector('#files .row.file[data-path="scratch.txt"]')?.classList.contains("local"), undefined, 180_000);
  ok("a file a viewer's command makes appears, marked local");
  await sleep(1000);
  is((await stored(name))["scratch.txt"], undefined, "and is not saved to the pad");

  // Discard goes back to the pad's file, live again.
  await viewer.click('#files .row.file[data-path="main.py"]');
  await viewer.click("#away button:has-text('Discard my changes')");
  await until(viewer, () => !window.__pad?.local().includes("main.py"));
  await until(viewer, () => window.__pad?.text("main.py")?.includes("live-two") && !window.__pad?.text("main.py")?.includes("the-viewers-own"));
  ok("Discard my changes brings back the pad's file");
  // Live again means the room's document, keystroke by keystroke — not the
  // stored copy, which would also arrive, a save later and with no cursors.
  await until(viewer, () => window.__pad?.docs().includes("main.py"));
  ok("and joins the room's live document for it");
  await typeAtEnd(owner, "main.py", "# live-three\n");
  await until(viewer, () => window.__pad?.text("main.py")?.includes("live-three"));
  ok("and it follows the pad live again");

  // Save as my copy: not signed in, so an open pad.
  await typeAtEnd(viewer, "main.py", "# kept-in-my-copy\n");
  await until(viewer, () => window.__pad?.local().includes("main.py"));
  // On a phone the banner's buttons — the way out of a copy — are all there:
  // the shell's bar clipped them to a sliver once.
  await viewer.setViewportSize({ width: 390, height: 844 });
  const clipped = await viewer.evaluate(() => {
    const bar = document.getElementById("away");
    const save = [...bar.querySelectorAll("button")].find((b) => b.textContent === "Save as my copy");
    const r = save.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { overflow: bar.scrollHeight > bar.clientHeight + 1, covered: !save.contains(hit) };
  });
  is(JSON.stringify(clipped), JSON.stringify({ overflow: false, covered: false }), "on a phone the banner shows its buttons whole");
  await viewer.setViewportSize({ width: 1280, height: 720 });
  await viewer.click("#away button:has-text('Save as my copy')");
  // Copying a pad that is not open into one that is, signed out: asked first.
  await viewer.locator("dialog.modal-confirm").getByRole("button", { name: "Make an open pad" }).click();
  await viewer.waitForURL((u) => !u.pathname.endsWith(name), { timeout: 15_000 });
  const copy = new URL(viewer.url()).pathname.slice(1);
  is(/^[a-z]+-[a-z]+-\d{4}$/.test(copy), true, `Save as my copy makes an open pad (${copy})`);
  await viewer.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(viewer, () => window.__pad?.role() === "editor");
  const copied = await (await fetch(`${ORIGIN}/api/pad/${copy}`)).json();
  is(copied.files["main.py"]?.content.includes("kept-in-my-copy") && copied.files["main.py"]?.content.includes("live-three"), true, "with the pad's text and the viewer's change");
  is(copied.files["scratch.txt"]?.content, "scratch\n", "and the file their command made");
  await viewer.waitForSelector(".toast:has-text('This is your copy')", { timeout: 10_000 });
  is(new URL(viewer.url()).search, "", "the new pad says it is your copy, and the address is clean");

  // A link pasted into a tab already on the pad takes effect: the browser
  // does not reload for a change after the #.
  const paster = await person("paster");
  await paster.goto(viewUrl);
  await paster.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(paster, () => window.__pad?.role() === "viewer");
  await paster.evaluate((code) => { location.hash = code; }, editUrl.split("#")[1]);
  await until(paster, () => window.__pad?.role() === "editor", undefined, 30_000);
  is(await paster.evaluate(() => location.hash), "", "an edit link pasted into a viewer's tab makes it an editor, and leaves no code in the address bar");
  // An anchor with a code's shape — 22 characters — must not cost the tab
  // its working edit code.
  await paster.goto(`${ORIGIN}/${name}#installation-and-setup`);
  await paster.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(paster, () => window.__pad?.role() === "editor", undefined, 30_000);
  is(await paster.evaluate((n) => localStorage.getItem(`pad.code.${n}`), name), editUrl.split("#")[1], "a code-shaped anchor does not replace a working edit code");
  await paster.close();

  // ---- the owner changes who may do what ----
  const watcher = await person("watcher");
  await watcher.goto(viewUrl);
  await watcher.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(watcher, () => window.__pad?.role() === "viewer");

  // Someone with local work of their own, on the bare name.
  const keeper = await person("keeper");
  await keeper.goto(viewUrl);
  await keeper.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(keeper, () => window.__pad?.role() === "viewer");
  await typeAtEnd(keeper, "main.py", "# the-keepers-own\n");
  await until(keeper, () => window.__pad?.local().includes("main.py"));

  await owner.click("#share");
  await owner.waitForSelector(".share-dialog select");
  // The editor types and, before that can be saved, loses editing: what
  // they typed exists nowhere else, and is kept as their own copy. The race
  // made certain rather than left to the runner's speed: the editor's save
  // is held until the lock has reached it, so the demotion finds nothing
  // unsaved — the save in flight has it — and the save is then refused.
  // Left to chance, macOS CI lost that typing on 5 October.
  let saveSeen;
  const saveStarted = new Promise((r) => (saveSeen = r));
  let releaseSave;
  const saveHeld = new Promise((r) => (releaseSave = r));
  await editor.route("**/api/pad/*", async (r) => {
    if (r.request().method() === "PUT") {
      saveSeen();
      await saveHeld;
    }
    await r.continue().catch(() => {});
  });
  await editor.click('#files .row.file[data-path="main.py"]');
  await editor.evaluate(() => {
    const e = window.monaco.editor.getEditors()[0];
    const m = e.getModel();
    e.focus();
    e.setPosition(m.getPositionAt(m.getValueLength()));
    e.trigger("keyboard", "type", { text: "# typed-as-editing-ended\n" });
  });
  await saveStarted;
  await owner.getByRole("dialog").getByLabel("Who can edit").selectOption("owner");
  await until(editor, () => window.__pad?.role() === "viewer", undefined, 15_000);
  releaseSave();
  await until(editor, () => window.__pad?.local().includes("main.py") && window.__pad?.text("main.py").includes("typed-as-editing-ended"), undefined, 15_000);
  await editor.unroute("**/api/pad/*");
  is((await stored(name))["main.py"].content.includes("typed-as-editing-ended"), false, "typing that lost the race with a lock is not saved to the pad");
  ok("but it is kept as the editor's own copy, not dropped");
  is(await editor.locator("#away .viewing-text").isVisible(), true, "locking editing turns an editor into a viewer, without a reload");
  await owner.waitForSelector(".share-dialog .share-link.off");
  is(await owner.locator(".share-dialog .share-url").count(), 1, "and the dialog stops offering an edit link");

  await owner.getByRole("dialog").getByLabel("Who can view").selectOption("code");
  await watcher.waitForSelector("text=This pad is private", { timeout: 15_000 });
  ok("closing viewing to links turns someone on the bare name away, there and then");
  // …unless they have work here that exists nowhere else.
  await until(keeper, () => document.querySelector("#away .viewing-pill")?.textContent === "No access", undefined, 15_000);
  is((await text(keeper, "main.py")).includes("the-keepers-own"), true, "someone turned away with local work keeps the page and the work");
  await keeper.click("#away button:has-text('Save as my copy')");
  await keeper.locator("dialog.modal-confirm").getByRole("button", { name: "Make an open pad" }).click();
  await keeper.waitForURL((u) => !u.pathname.endsWith(name), { timeout: 15_000 });
  const kept = new URL(keeper.url()).pathname.slice(1);
  is((await (await fetch(`${ORIGIN}/api/pad/${kept}`)).json()).files["main.py"]?.content.includes("the-keepers-own"), true, "and can still save it as their own copy");
  await owner.keyboard.press("Escape");
  is(await owner.evaluate(() => window.__pad?.role()), "owner", "the owner stays");

  const stranger = await person("stranger");
  await stranger.goto(viewUrl);
  await stranger.waitForSelector("text=This pad is private", { timeout: 15_000 });
  is(await stranger.locator("a.provider", { hasText: "Continue with GitHub" }).count(), 1, "a stranger is told it is private, and offered sign-in");
  await stranger.goto(`${ORIGIN}/no_such.pad`);
  await stranger.waitForSelector("text=That isn't a pad address", { timeout: 15_000 });
  await stranger.goto(`${ORIGIN}/admin`);
  await stranger.waitForSelector("text=That isn't a pad address", { timeout: 30_000 });
  ok("a name no pad can have is said to be one, not shown as a broken editor");
  await stranger.goto(`${ORIGIN}/${name.toUpperCase()}`);
  await stranger.waitForURL((u) => u.pathname === `/${name}`, { timeout: 15_000 });
  ok("a pad address typed in capitals goes to the pad");
  await stranger.goto(`${ORIGIN}/login`);
  await stranger.waitForSelector("text=Pads you control", { timeout: 15_000 });
  is(new URL(stranger.url()).pathname, "/dashboard", "/login goes to the sign-in page");

  // ---- the operator's view ----
  await stranger.goto(`${ORIGIN}/admin`);
  await stranger.waitForSelector("text=That isn't a pad address", { timeout: 15_000 });
  ok("/admin to anyone else is what it always was");
  await owner.goto(`${ORIGIN}/dashboard`);
  await owner.click(".account-button");
  await owner.getByRole("link", { name: "Admin" }).click();
  await owner.waitForSelector(".stat", { timeout: 15_000 });
  const figures = await owner.evaluate(() => Object.fromEntries([...document.querySelectorAll(".stat")].map((s) => [s.querySelector(".stat-label").textContent, s.querySelector(".stat-value").textContent])));
  is(figures.Accounts, "1", "the operator's view counts the accounts");
  is(Number(figures["In pads"]) >= 1, true, "and who is in a pad right now");
  is(await owner.locator(".chart-svg[role=img]").count(), 2, "with charts that say what they show");

  // ---- the dashboard ----
  await owner.goto(`${ORIGIN}/dashboard`);
  const card = () => owner.locator(`.pad-card[data-name="${name}"]`);
  await card().waitFor();
  is(await card().locator(".chip-view").textContent(), "Who can view: View link", "the dashboard shows the settings at a glance");
  is(/1 of 20 pads/.test(await owner.locator(".page-usage").textContent()), true, "and how much of the account is used");

  // Share from the dashboard is the pad's own dialog.
  const dialog = () => owner.locator("dialog.share-dialog");
  // On CI's Ubuntu, 9 October, this found the pad's card twice, a moment
  // after the check above found it once. Said with what was there, if again.
  const cards = await owner.locator(".pad-card").evaluateAll((els) => els.map((e) => `${e.dataset.name} in ${e.parentElement?.className} ${e.isConnected}`));
  if (cards.filter((c) => c.startsWith(`${name} `)).length !== 1) fail(`the dashboard shows each pad once — ${JSON.stringify(cards)}`);
  await card().first().getByRole("button", { name: "Share" }).click();
  await dialog().waitFor();
  is(await dialog().getByLabel("Who can view").inputValue(), "code", "and in full, in the same dialog as the pad's");

  // Editing back on, then Reset on its link. The edit row's own field:
  // viewing needs a link by now, so the view link has a code after the # too.
  const editRow = () => dialog().locator(".share-link", { hasText: "Edit link" });
  const editLinkShown = () => editRow().locator(".share-url").getAttribute("data-url");
  await dialog().getByLabel("Who can edit").selectOption("code");
  await editRow().locator(".share-url").waitFor();
  const before = await editLinkShown();
  is(before, editUrl, "turning editing back on brings the same edit link back");
  await until(owner, (n) => document.querySelector(`.pad-card[data-name="${n}"] .chip-edit.chip-open`), name);
  ok("and the list behind the dialog shows it");
  await editRow().getByRole("button", { name: "Reset" }).click();
  // Asked first, in a dialog of its own; Cancel is what has focus.
  await owner.locator("dialog.modal-confirm").getByRole("button", { name: "Reset link" }).click();
  await until(owner, (old) => {
    const row = [...document.querySelectorAll("dialog.share-dialog .share-link")].find((r) => r.textContent.includes("Edit link"));
    const now = row?.querySelector(".share-url")?.dataset.url;
    return !!now && now !== old;
  }, before);
  const after = await editLinkShown();
  const roleWith = async (url) => {
    const res = await fetch(`${ORIGIN}/api/pad/${name}`, { headers: { "x-pad-code": url.split("#")[1] } });
    return res.ok ? (await res.json()).access.role : res.status;
  };
  is(await roleWith(before), 403, "Reset stops the old edit link");
  is(await roleWith(after), "editor", "and the new one edits");
  await owner.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached" });

  // The pad still open in another of the owner's tabs.
  const ownerTab = await owner.context().newPage();
  await ownerTab.goto(`${ORIGIN}/${name}`);
  await ownerTab.waitForSelector(".monaco-editor", { timeout: 30_000 });

  // Delete asks, and Cancel keeps it.
  await card().getByRole("button", { name: `Delete ${name}` }).click();
  await owner.locator("dialog.modal-confirm").getByRole("button", { name: "Cancel" }).click();
  is(await (await fetch(`${ORIGIN}/api/pad/${name}`, { headers: { cookie: ownerCookie } })).status, 200, "cancelling a delete keeps the pad");
  await card().getByRole("button", { name: `Delete ${name}` }).click();
  await owner.locator("dialog.modal-confirm").getByRole("button", { name: "Delete pad" }).click();
  await owner.waitForSelector("text=No pads yet");
  is(await (await fetch(`${ORIGIN}/api/pad/${name}`, { headers: { cookie: ownerCookie } })).status, 410, "deleting it from the dashboard deletes it");
  await ownerTab.waitForSelector("text=This pad was deleted", { timeout: 15_000 });
  ok("the owner's other tab says the pad was deleted — not that it is private");
  // A link drawn as a primary button reads on its own colour: page-link
  // colouring once won over it and left the label at 2.4:1.
  const ratio = await ownerTab.evaluate(() => {
    const a = document.querySelector("a.btn-primary");
    const rgb = (v) => v.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
      const c = [r, g, b].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const style = getComputedStyle(a);
    const [l1, l2] = [lum(rgb(style.color)), lum(rgb(style.backgroundColor))].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  });
  is(ratio >= 4.5, true, `a primary link-button's label is readable (${ratio.toFixed(2)}:1)`);
  await ownerTab.close();

  // ---- a pad made from a zip ----
  // From the empty dashboard's own button. Zipped by Python, as a folder.
  const zipDir = await mkdtemp(join(tmpdir(), "pad-acct-zip-"));
  const zipPath = join(zipDir, "site.zip");
  execFileSync("python3", ["-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("site/app.js", "console.log('zipped')\\n")
    z.writestr("site/lib/a.py", "A = 1\\n")
    z.writestr("site/img.png", bytes([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]))
`, zipPath]);
  const chooser = owner.waitForEvent("filechooser");
  await owner.getByRole("button", { name: "Start from a zip" }).click();
  await (await chooser).setFiles(zipPath);
  await owner.waitForURL(/\/[a-z]+-[a-z]+-[a-z]+(\?.*)?$/, { timeout: 15_000 });
  const zipped = new URL(owner.url()).pathname.slice(1);
  await owner.waitForSelector(".monaco-editor", { timeout: 30_000 });
  const told = await owner.waitForSelector(".toast:has-text('Made from your zip')", { timeout: 10_000 }).then((t) => t.textContent(), () => "");
  is(/Made from your zip: 3 files\.$/.test(told.trim()), true, `Start from a zip makes a pad and says what came in (${zipped}: "${told}")`);
  is(new URL(owner.url()).search, "", "and the address is the pad's own, without the count");
  const zippedFiles = await stored(zipped);
  is(JSON.stringify(Object.keys(zippedFiles ?? {}).sort()), '["app.js","img.png","lib/a.py"]', "the pad holds the zip's files, out of their folder, and no starter");
  is(zippedFiles?.["img.png"]?.encoding === "base64" && Buffer.from(zippedFiles["img.png"].content, "base64").toString("hex") === "89504e470000000d", true, "the image as its bytes");
  is(zippedFiles?.["lib/a.py"]?.content, "A = 1\n", "as they were in the zip");
  is(await owner.evaluate(() => [...document.querySelectorAll("#files .row.file")].map((b) => b.dataset.path).sort().join()), "app.js,img.png,lib/a.py", "and the page shows them");
  is(await role(owner), "owner", "a pad of the account's, like New pad's");
  await fetch(`${ORIGIN}/api/my/pads/${zipped}`, { method: "DELETE", headers: { cookie: ownerCookie, "x-ajar": "1" } });
  await rm(zipDir, { recursive: true, force: true });
  await owner.goto(`${ORIGIN}/dashboard`);
  await owner.waitForSelector("text=No pads yet");

  // ---- a pad copied from a link ----
  // Anyone's pad this person can open becomes a new pad of theirs. Sources: an
  // open pad, one of their own read through its edit link's code, and one
  // that was deleted; refusals are faked at the store for the two answers a
  // single account cannot produce here (someone else's private pad).
  const api = (path, init = {}) => fetch(`${ORIGIN}${path}`, { ...init, headers: { cookie: ownerCookie, "x-ajar": "1", "content-type": "application/json", ...init.headers } });
  const SOURCE = { "main.py": "print('from the source')\n", "lib/util.py": "X = 1\n" };
  await fetch(`${ORIGIN}/api/pad/open-source-pad`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ writes: Object.entries(SOURCE).map(([path, content]) => ({ path, content })) }) });
  const coded = await (await api("/api/my/pads", { method: "POST" })).json();
  await api(`/api/pad/${coded.name}`, { method: "PUT", body: JSON.stringify({ writes: [{ path: "only.txt", content: "coded\n" }] }) });
  const codedEdit = coded.links.find((l) => l.role === "editor").code;
  const gone = (await (await api("/api/my/pads", { method: "POST" })).json()).name;
  await api(`/api/pad/${gone}`, { method: "PUT", body: JSON.stringify({ writes: [{ path: "x.txt", content: "x" }] }) });
  await api(`/api/my/pads/${gone}`, { method: "DELETE" });
  await owner.reload();
  await owner.waitForSelector(".pad-card");
  const madeBefore = (await (await api("/api/my/pads")).json()).length;

  const copyDialog = () => owner.locator("dialog.copy-dialog");
  const tryLink = async (text) => {
    await copyDialog().getByLabel("Link to a pad").fill(text);
    await copyDialog().getByRole("button", { name: "Make a copy" }).click();
    return copyDialog().locator(".field-problem").waitFor({ state: "visible", timeout: 10_000 }).then(() => copyDialog().locator(".field-problem").textContent(), () => null);
  };
  await owner.getByRole("button", { name: "Copy a pad" }).click();
  await copyDialog().waitFor();
  is(await owner.evaluate(() => document.activeElement?.getAttribute("aria-describedby")?.startsWith("pad-link-hint")), true, "Copy a pad opens on its link field");
  is(/not to a pad here/.test(await tryLink("https://elsewhere.example/amber-falcon-river") ?? ""), true, "a link to another site is refused in words");
  // The dialog's own sentence: the store's refusal says "deleted by its owner" too.
  is(await tryLink(`${ORIGIN}/${gone}`), `${gone} was deleted by its owner.`, "so is a deleted pad");
  is(/no pad at nothing-saved-here yet/.test(await tryLink("nothing-saved-here") ?? ""), true, "and a name nobody has saved anything at");
  await owner.route("**/api/pad/someone-elses-pad", (r) => r.fulfill({ status: 403, body: "this pad is private" }));
  is(/is private\. Paste the link its owner shared/.test(await tryLink("someone-elses-pad") ?? ""), true, "a private pad asks for the link its owner shared");
  await owner.route("**/api/pad/reset-link-pad", (r) => r.fulfill({ status: 403, body: "the link you opened no longer works" }));
  is(/no longer works/.test(await tryLink(`reset-link-pad#${"A".repeat(22)}`) ?? ""), true, "and a reset link says it no longer works");
  // A copy whose write is refused takes the pad it made with it.
  await owner.route("**/api/pad/*", (r) => (r.request().method() === "PUT" ? r.fulfill({ status: 507, body: "an account holds at most 100 MB" }) : r.fallback()));
  is(await tryLink(`${ORIGIN}/open-source-pad`), "an account holds at most 100 MB", "a copy that cannot be written says why");
  await owner.unroute("**/api/pad/*");
  is((await (await api("/api/my/pads")).json()).length, madeBefore, "none of those made a pad — the refused copy's pad went too");

  // Its own pad by its edit link: the code goes with the read, and is not kept.
  const sentCode = [];
  owner.on("request", (r) => { if (r.url().endsWith(`/api/pad/${coded.name}`) && r.method() === "GET") sentCode.push(r.headers()["x-pad-code"] ?? null); });
  await copyDialog().getByLabel("Link to a pad").fill(`${ORIGIN}/${coded.name}#${codedEdit}`);
  await copyDialog().getByRole("button", { name: "Make a copy" }).click();
  await owner.waitForURL((u) => /^\/[a-z]+-[a-z]+-[a-z]+$/.test(u.pathname) && u.pathname !== `/${coded.name}`, { timeout: 15_000 });
  const fromCoded = new URL(owner.url()).pathname.slice(1);
  is(sentCode.includes(codedEdit), true, "a pasted link's code goes with the read");
  is(await owner.evaluate((n) => localStorage.getItem(`pad.code.${n}`), coded.name), null, "and is not kept as this browser's");
  is(JSON.stringify(Object.keys((await stored(fromCoded)) ?? {})), '["only.txt"]', "the copy has the source's files");

  // An open pad, by its whole address.
  await owner.goto(`${ORIGIN}/dashboard`);
  await owner.getByRole("button", { name: "Copy a pad" }).click();
  await copyDialog().getByLabel("Link to a pad").fill(`${ORIGIN}/open-source-pad`);
  await copyDialog().getByRole("button", { name: "Make a copy" }).click();
  await owner.waitForURL((u) => /^\/[a-z]+-[a-z]+-[a-z]+$/.test(u.pathname), { timeout: 15_000 });
  const copyName = new URL(owner.url()).pathname.slice(1);
  await owner.waitForSelector(".monaco-editor", { timeout: 30_000 });
  const copyToast = await owner.waitForSelector(".toast:has-text('Copied from open-source-pad')", { timeout: 10_000 }).then((t) => t.textContent(), () => "");
  is(/2 files, as last saved\. open-source-pad itself is unchanged/.test(copyToast), true, `Copy a pad makes a pad of yours and says where it came from (${copyName})`);
  is(new URL(owner.url()).search, "", "and the address is the pad's own");
  const copiedFiles = await stored(copyName);
  is(JSON.stringify(Object.fromEntries(Object.entries(copiedFiles ?? {}).map(([p, f]) => [p, f.content]))), JSON.stringify(Object.fromEntries(Object.entries(SOURCE).sort())), "with the source's files, as saved");
  is(await role(owner), "owner", "owned like any other pad of theirs");
  const original = await (await fetch(`${ORIGIN}/api/pad/open-source-pad`)).json();
  is(original.access?.role === "editor" && Object.keys(original.files).length === 2, true, "and the original is untouched — still open, still its own files");
  for (const n of [copyName, fromCoded, coded.name]) await api(`/api/my/pads/${n}`, { method: "DELETE" });
  await owner.goto(`${ORIGIN}/dashboard`);
  await owner.waitForSelector("text=No pads yet");

  // ---- a viewer's document outliving its editors ----
  //
  // A pad nobody but a viewer has open, so nothing else can answer for it.
  const made = await (await fetch(`${ORIGIN}/api/my/pads`, { method: "POST", headers: { cookie: ownerCookie, "x-ajar": "1" } })).json();
  const quiet = made.name;
  const quietCode = made.links.find((l) => l.role === "editor").code;
  const ORIGINAL = "# the first version of this file, long enough to matter\nprint('one')\nprint('two')\n";
  await fetch(`${ORIGIN}/api/pad/${quiet}`, {
    method: "PUT",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ writes: [{ path: "main.py", content: ORIGINAL }] }),
  });
  const lone = await person("lone viewer");
  await lone.goto(`${ORIGIN}/${quiet}`);
  await lone.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(lone, (t) => window.__pad?.role() === "viewer" && window.__pad?.text("main.py") === t, ORIGINAL);

  const first = await person("first editor");
  await first.goto(`${ORIGIN}/${quiet}#${quietCode}`);
  await until(first, () => window.__pad?.docs().includes("main.py"), undefined, 30_000);
  const asked = Date.now();
  await until(first, (t) => window.__pad?.text("main.py") === t, ORIGINAL);
  const waited = Date.now() - asked;
  is(waited < 3000, true, `an editor arriving where only a viewer has the file is answered at once (${waited} ms, not the 5 s deadline)`);
  await first.click(".monaco-editor .view-lines");
  await first.keyboard.press("ControlOrMeta+a");
  await first.keyboard.type("short\n");
  await until(lone, () => window.__pad?.text("main.py") === "short\n");
  is(await storedHas(quiet, "main.py", "short"), true, "the viewer follows an edit that rewrites the file");
  await first.close();

  // The next editor finds nobody who can give it the document, so starts it
  // again from the stored copy — while the viewer still holds the old one.
  const second = await person("second editor");
  await second.goto(`${ORIGIN}/${quiet}#${quietCode}`);
  await second.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(second, () => window.__pad?.text("main.py") === "short\n");
  // Inside the seeded text, after its first character: the new text hangs
  // off a seeded character, and with colliding seeds the viewer's character
  // of that id is somewhere else. At either end it hangs off nothing seeded
  // — at the end the garble landed in the right place, at the start a tie
  // broken by random client ids did, sometimes — and both passed with the
  // seeds colliding.
  //
  // Put there through Monaco, not with keys: Cmd+Home is not a binding on a
  // Mac, the cursor stayed at the end, and this passed with the seeds
  // colliding while appearing to type at the start.
  await second.evaluate(() => {
    const editor = window.monaco.editor.getEditors()[0];
    editor.focus();
    editor.setPosition({ lineNumber: 1, column: 2 });
  });
  await second.keyboard.type("[second]");
  await until(second, () => window.__pad?.text("main.py") === "s[second]hort\n");
  const theirs = await text(second, "main.py");
  try {
    await until(lone, (t) => window.__pad?.text("main.py") === t, theirs, 15_000);
    ok("a viewer whose editors left converges on the next editor's document");
  } catch {
    fail(`the viewer kept a different document: ${JSON.stringify(await text(lone, "main.py"))} against ${JSON.stringify(theirs)}`);
  }
  await fetch(`${ORIGIN}/api/my/pads/${quiet}`, { method: "DELETE", headers: { cookie: ownerCookie, "x-ajar": "1" } });

  // ---- a name an ajar session holds ----
  // A pad cannot share a room with an agent's session. The page used to keep
  // knocking in silence; now it says it is not live, and goes live once the
  // session ends.
  const agent = new Guest(`ws://127.0.0.1:${RELAY_PORT}/ws`, "held-by-an-agent", "agent", null);
  agent.role = "host";
  await agent.connect();
  const passer = await person("passer-by");
  await passer.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sockets = 0;
    window.WebSocket = class extends Real {
      constructor(...args) {
        super(...args);
        window.__sockets += 1;
      }
    };
  });
  await passer.goto(`${ORIGIN}/held-by-an-agent`);
  await passer.waitForSelector(".monaco-editor", { timeout: 30_000 });
  const shutOut = await passer.waitForSelector("#presence .not-live", { timeout: 10_000 }).then(() => true, () => false);
  const shutSaid = await passer.waitForSelector(".toast:has-text('Not live')", { timeout: 5_000 }).then((t) => t.textContent(), () => "");
  is(shutOut && /ajar session is using this name/.test(shutSaid), true, `a pad whose name an ajar session holds says it is not live, and why (marker ${shutOut}, "${shutSaid}")`);
  // Refused, it backs off rather than knocking four times a second.
  const triedBefore = await passer.evaluate(() => window.__sockets);
  await sleep(4000);
  const knocks = (await passer.evaluate(() => window.__sockets)) - triedBefore;
  is(knocks <= 5, true, `refused, it backs off (${knocks} tries in 4 s)`);
  agent.ws.send(encode({ channel: CH_CONTROL, payload: new TextEncoder().encode(JSON.stringify({ t: "close" })) }));
  // Backed off to at most 8 s between tries, so well inside 20.
  const live = await passer.waitForSelector("#presence .not-live", { state: "detached", timeout: 20_000 }).then(() => true, () => false);
  const liveSaid = await passer.waitForSelector(".toast:has-text('Live again')", { timeout: 5_000 }).then(() => true, () => false);
  is(live && liveSaid, true, "and goes live once the session ends, and says so");
  await passer.close();

  // A pad of theirs open in another tab, as owner, when they sign out here.
  const still = (await (await fetch(`${ORIGIN}/api/my/pads`, { method: "POST", headers: { cookie: ownerCookie, "x-ajar": "1" } })).json()).name;
  await fetch(`${ORIGIN}/api/pad/${still}`, {
    method: "PUT",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ writes: [{ path: "main.py", content: "print('still')\n" }] }),
  });
  const stillTab = await owner.context().newPage();
  pages.set("owner's other tab", stillTab);
  await stillTab.goto(`${ORIGIN}/${still}`);
  // In the room: its document for the open file is there only once it is.
  await until(stillTab, () => window.__pad?.role() === "owner" && window.__pad?.docs().includes("main.py"), undefined, 30_000);

  await owner.click(".account-button");
  await owner.getByRole("button", { name: "Sign out" }).click();
  await owner.waitForSelector("text=Pads you control");
  ok("signing out returns to the signed-out dashboard");
  // Its room was told, so the other tab is not owner a moment longer.
  const demoted = await until(stillTab, () => window.__pad?.role() === "viewer", undefined, 10_000).then(() => true, () => false);
  is(demoted, true, "a pad open as owner in another tab drops to what it holds signed out, without a reload");

  // ---- deleting the account ----
  await owner.click("text=Continue with GitHub");
  await owner.waitForSelector("text=Your pads", { timeout: 15_000 });
  const doomed = (await (await fetch(`${ORIGIN}/api/my/pads`, { method: "POST", headers: { cookie: (await owner.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; "), "x-ajar": "1" } })).json()).name;
  const lastCookie = (await owner.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  await stillTab.goto(`${ORIGIN}/${doomed}`);
  await until(stillTab, () => window.__pad?.role() === "owner", undefined, 30_000);
  await owner.reload();
  await owner.getByRole("button", { name: "Delete account" }).click();
  const sure = owner.locator("dialog.modal-confirm");
  await sure.waitFor();
  const yes = sure.getByRole("button", { name: "Delete account" });
  is(await yes.isDisabled(), true, "Delete account is off until the word is typed");
  await sure.getByLabel("Type delete to confirm").fill("delet");
  is(await yes.isDisabled(), true, "and stays off for anything else");
  const warned = await sure.textContent();
  is(/Your 2 pads are deleted for everyone/.test(warned), true, `the dialog says what goes with it (${warned.slice(0, 120)})`);
  await sure.getByLabel("Type delete to confirm").fill("delete");
  await yes.click();
  await owner.waitForSelector("text=Pads you control", { timeout: 15_000 });
  await owner.waitForSelector(".toast:has-text('Your account and its pads were deleted')", { timeout: 5_000 });
  ok("deleting the account signs out and says so");
  const meAfter = await (await fetch(`${ORIGIN}/api/me`, { headers: { cookie: lastCookie } })).json();
  is(meAfter.user, null, "the account's sign-in no longer works");
  is((await fetch(`${ORIGIN}/api/pad/${doomed}`)).status, 410, "its pads are deleted");
  await stillTab.waitForSelector("text=This pad was deleted", { timeout: 15_000 });
  ok("and a tab that had one open says it was deleted");
} catch (e) {
  fail(e.message.split("\n")[0]);
  for (const [label, page] of pages) {
    if (page.isClosed()) continue;
    await page.screenshot({ path: fileURLToPath(new URL(`../failed-${label}.png`, import.meta.url)) }).catch(() => {});
    const seen = await page.evaluate(() => ({
      url: location.pathname,
      role: window.__pad?.role?.(),
      local: window.__pad?.local?.(),
      status: document.getElementById("status")?.textContent,
      banner: document.getElementById("away")?.textContent,
      room: window.__pad?.room?.(),
    })).catch(() => null);
    results.push(`note: ${label} ${JSON.stringify(seen)}`);
  }
}

await cacheBrowser?.close();
await browser.close();
server.close();
provider.close();
relay.kill();
await rm(dir, { recursive: true, force: true });

for (const line of results) console.log(`  ${line}`);
const failed = results.filter((l) => l.startsWith("FAIL"));
// Again, last: CI keeps only the end of a step's output in its summary, and
// the list above is long enough that a failure in its middle was cut off.
if (failed.length) console.log(`\n  failed:\n${failed.map((l) => `    ${l}`).join("\n")}`);
console.log(failed.length ? `\n  ${failed.length} failed\n` : "\n  accounts work in the browser\n");
process.exit(failed.length ? 1 : 0);

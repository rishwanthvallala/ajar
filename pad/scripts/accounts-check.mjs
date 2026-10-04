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
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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
  await owner.click("#new-pad");
  await owner.waitForURL(/\/[a-z]+-[a-z]+-[a-z]+$/, { timeout: 15_000 });
  const name = new URL(owner.url()).pathname.slice(1);
  ok(`New pad opens a three-word pad (${name})`);
  await owner.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(owner, () => window.__pad?.role() === "owner");
  is(await owner.locator("#readonly").isVisible(), false, "the owner sees no view-only badge");
  is(await owner.locator("#away").isVisible(), false, "and no viewer's banner");
  await typeAtEnd(owner, "main.py", "# by-the-owner\n");
  is(await storedHas(name, "main.py", "by-the-owner"), true, "the owner's typing is saved");

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

  // ---- a viewer, from the bare name ----
  const viewer = await person("viewer");
  await viewer.goto(viewUrl);
  await viewer.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(viewer, () => window.__pad?.role() === "viewer");
  ok("the bare name opens it to view");
  is(await viewer.locator("#readonly").textContent(), "view only", "the header says view only");
  is(await viewer.locator("#away .viewing-text").isVisible(), true, "a banner says changes stay in the tab");
  await until(viewer, () => window.__pad?.text("main.py")?.includes("by-the-editor"));
  await typeAtEnd(owner, "main.py", "# live-one\n");
  await until(viewer, () => window.__pad?.text("main.py")?.includes("live-one"));
  ok("a viewer watches typing live");

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
  await viewer.click("#away button:has-text('Save as my copy')");
  await viewer.waitForURL((u) => !u.pathname.endsWith(name), { timeout: 15_000 });
  const copy = new URL(viewer.url()).pathname.slice(1);
  is(/^[a-z]+-[a-z]+-\d{4}$/.test(copy), true, `Save as my copy makes an open pad (${copy})`);
  await viewer.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(viewer, () => window.__pad?.role() === "editor");
  const copied = await (await fetch(`${ORIGIN}/api/pad/${copy}`)).json();
  is(copied.files["main.py"]?.content.includes("kept-in-my-copy") && copied.files["main.py"]?.content.includes("live-three"), true, "with the pad's text and the viewer's change");
  is(copied.files["scratch.txt"]?.content, "scratch\n", "and the file their command made");

  // ---- the owner changes who may do what ----
  const watcher = await person("watcher");
  await watcher.goto(viewUrl);
  await watcher.waitForSelector(".monaco-editor", { timeout: 30_000 });
  await until(watcher, () => window.__pad?.role() === "viewer");

  await owner.click("#share");
  await owner.waitForSelector(".share-dialog select");
  await owner.getByRole("dialog").getByLabel("Who can edit").selectOption("owner");
  await until(editor, () => window.__pad?.role() === "viewer", undefined, 15_000);
  is(await editor.locator("#away .viewing-text").isVisible(), true, "locking editing turns an editor into a viewer, without a reload");
  await owner.waitForSelector(".share-dialog .share-link.off");
  is(await owner.locator(".share-dialog .share-url").count(), 1, "and the dialog stops offering an edit link");

  await owner.getByRole("dialog").getByLabel("Who can view").selectOption("code");
  await watcher.waitForSelector("text=This pad is private", { timeout: 15_000 });
  ok("closing viewing to links turns someone on the bare name away, there and then");
  await owner.keyboard.press("Escape");
  is(await owner.evaluate(() => window.__pad?.role()), "owner", "the owner stays");

  const stranger = await person("stranger");
  await stranger.goto(viewUrl);
  await stranger.waitForSelector("text=This pad is private", { timeout: 15_000 });
  is(await stranger.locator("a.provider", { hasText: "Continue with GitHub" }).count(), 1, "a stranger is told it is private, and offered sign-in");

  // ---- the dashboard ----
  await owner.goto(`${ORIGIN}/dashboard`);
  const card = () => owner.locator(`.pad-card[data-name="${name}"]`);
  await card().waitFor();
  is(await card().locator(".chip-view-code").textContent(), "View link only", "the dashboard shows the settings at a glance");
  is(/1 of 20 pads/.test(await owner.locator(".page-usage").textContent()), true, "and how much of the account is used");

  // Share from the dashboard is the pad's own dialog.
  const dialog = () => owner.locator("dialog.share-dialog");
  await card().getByRole("button", { name: "Share" }).click();
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
  await until(owner, (n) => document.querySelector(`.pad-card[data-name="${n}"] .chip-edit-code`), name);
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

  // Delete asks, and Cancel keeps it.
  await card().getByRole("button", { name: `Delete ${name}` }).click();
  await owner.locator("dialog.modal-confirm").getByRole("button", { name: "Cancel" }).click();
  is(await (await fetch(`${ORIGIN}/api/pad/${name}`, { headers: { cookie: ownerCookie } })).status, 200, "cancelling a delete keeps the pad");
  await card().getByRole("button", { name: `Delete ${name}` }).click();
  await owner.locator("dialog.modal-confirm").getByRole("button", { name: "Delete pad" }).click();
  await owner.waitForSelector("text=No pads yet");
  is(await (await fetch(`${ORIGIN}/api/pad/${name}`, { headers: { cookie: ownerCookie } })).status, 403, "deleting it from the dashboard deletes it");

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

  await owner.click(".account-button");
  await owner.getByRole("menuitem", { name: "Sign out" }).click();
  await owner.waitForSelector("text=Pads you control");
  ok("signing out returns to the signed-out dashboard");
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
    })).catch(() => null);
    results.push(`note: ${label} ${JSON.stringify(seen)}`);
  }
}

await browser.close();
server.close();
provider.close();
relay.kill();
await rm(dir, { recursive: true, force: true });

for (const line of results) console.log(`  ${line}`);
const failed = results.filter((l) => l.startsWith("FAIL"));
console.log(failed.length ? `\n  ${failed.length} failed\n` : "\n  accounts work in the browser\n");
process.exit(failed.length ? 1 : 0);

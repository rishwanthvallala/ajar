#!/usr/bin/env node
// What a guest's page has that the pad's has, since 19 November
// (docs/dev/ajar-parity.md), in a real browser against a real agent and
// relay: the tree's buttons — make, rename, move, delete, upload — search
// by name and by contents with Replace, the editor's tools — Format, the
// indent, a starter, a Markdown file formatted, an image — and a terminal's
// links, keys, screen reader switch and the cross on its tab. And that the
// host's read-only takes every one of the changes away.
//
// What the folder is after each step is read off the host's disk: the page
// saying so is not the file being there.
//
// Every page here is served through a stand-in for production's front,
// which sends the Content-Security-Policy production does
// (deploy/nginx/ajar-headers.conf) — the relay alone sends none: a
// formatter's WebAssembly, a picture as a `data:` URL, the search's worker and
// the suggestion model's are each something a policy can refuse, and a check
// without it would pass while the site did not work.
//
// Needs `npm run build:ajar` and `cargo build` first. Suggestions are checked
// only with the model in pad/public/packages, which the front serves on
// ajar's site and this stands in for.
//
//   node scripts/check-guest-tools.mjs

import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { fail, finish, linkOf, ok, Procs, sleep, startAgentInPanel, waitForHealth } from "./lib/wire.mjs";

const { chromium } = createRequire(new URL("../web/package.json", import.meta.url))("playwright");

const PORT = 8857;
const FRONT_PORT = 8858;
const RELAY = `http://127.0.0.1:${PORT}`;
/** Where the pages are opened: the stand-in for production's front, before the relay. */
const SITE = `http://127.0.0.1:${FRONT_PORT}`;
const MOD = process.platform === "darwin" ? "Meta" : "Control";
/** The end of the file in the editor: off a Mac, Ctrl+↓ only scrolls. */
const END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

/** Production's Content-Security-Policy for the page, with this relay's socket in place of production's. */
const POLICY = (() => {
  const sent = readFileSync("deploy/nginx/ajar-headers.conf", "utf8").match(/add_header Content-Security-Policy "([^"]+)"/);
  if (!sent) throw new Error("deploy/nginx/ajar-headers.conf sends no Content-Security-Policy");
  return sent[1].replace("wss://ajar.rishwanth.dev", `ws://127.0.0.1:${FRONT_PORT}`);
})();
/** The suggestion model, where the pad's mirror has it: its list, and where the files it names are. */
const MODEL_DIR = "pad/public/packages";
const MODEL = existsSync(join(MODEL_DIR, "ajar-complete.json")) ? JSON.parse(readFileSync(join(MODEL_DIR, "ajar-complete.json"), "utf8")) : null;

const procs = new Procs();
let workdir;

async function until(fn, timeoutMs = 10_000, every = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return last;
}

function check(cond, msg, detail = "") {
  if (cond) ok(msg);
  else fail(`${msg}${detail ? ` — ${detail}` : ""}`);
  return cond;
}

const exists = (rel) => existsSync(join(workdir, rel));
const disk = (rel) => readFile(join(workdir, rel), "utf8").catch(() => null);
/** What the file is on the host's disk, once it is what is waited for. */
async function onDisk(rel, test, timeoutMs = 10_000) {
  let text = null;
  await until(async () => {
    text = await disk(rel);
    return text !== null && test(text);
  }, timeoutMs);
  return text;
}

const row = (page, path) => page.locator(`.tree-row[data-path="${path}"]`);
const editing = (page, path, timeout = 15_000) =>
  page.waitForFunction((p) => document.getElementById("viewer")?.dataset.editing === p, path, { timeout }).then(() => true, () => false);
const toasts = (page) => page.locator(".toasts .toast").allTextContents();
const said = (page, pattern, timeoutMs = 8000) => until(async () => (await toasts(page)).find((t) => pattern.test(t)) ?? null, timeoutMs);

/**
 * Production's front, as far as a page can tell: every answer of the relay's
 * with the site's policy on it, the socket passed through, and the suggestion
 * model served beside the page from the pad's copy, where there is one. Not
 * done by intercepting requests in the browser: a document answered that way
 * is one Chromium no longer takes to be local, and it then refuses the page
 * its own loopback socket.
 */
function front() {
  const server = createServer((req, res) => {
    const path = new URL(req.url, SITE).pathname;
    const model = MODEL && /^\/packages\/ajar-complete[-.][\w.-]+$/.test(path) ? join(MODEL_DIR, path.slice("/packages/".length)) : null;
    if (model && existsSync(model)) {
      res.writeHead(200, { "content-type": path.endsWith(".json") ? "application/json" : "application/octet-stream", "content-security-policy": POLICY });
      return res.end(readFileSync(model));
    }
    const up = httpRequest({ host: "127.0.0.1", port: PORT, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, { ...answer.headers, "content-security-policy": POLICY });
      answer.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  server.on("upgrade", (req, socket, head) => {
    const up = connect(PORT, "127.0.0.1", () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${req.rawHeaders.reduce((all, v, i) => (i % 2 ? `${all}: ${v}\r\n` : `${all}${v}`), "")}\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    const end = () => (socket.destroy(), up.destroy());
    socket.on("error", end);
    up.on("error", end);
    socket.on("close", end);
    up.on("close", end);
  });
  return new Promise((resolve, reject) => server.once("error", reject).listen(FRONT_PORT, "127.0.0.1", () => resolve(server)));
}

/** What the policy refused a page, as the browser says it in the console and to the document. */
function watchPolicy(page) {
  page.refused = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) page.refused.push(m.text().slice(0, 300));
  });
  return page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`Content Security Policy refused ${e.violatedDirective}: ${e.blockedURI}`));
  });
}

async function guestPage(browser, link, name, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ...options });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await watchPolicy(page);
  await page.goto(`${SITE}/j/${link.session}#k=${link.key}`);
  await page.fill("#name", name);
  await page.click("#join button[type=submit]");
  await page.locator(".term.shown .xterm").first().waitFor({ timeout: 20_000 });
  return page;
}

async function screen(page) {
  return page.evaluate(() => {
    const t = document.querySelector(".term.shown");
    return t ? [...t.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent).join("\n") : "";
  });
}

/** Type a line into the terminal in front, once its shell is taking keys. */
async function shell(page, line) {
  await page.locator(".term.shown .xterm").first().click();
  await page.keyboard.type(`${line}\r`);
}

/** The line the cursor is on, and what is selected, read off the editor in front. */
function place(page) {
  return page.evaluate(() => {
    const ed = document.querySelector("#viewer .editor-group.focused .monaco-editor") ?? document.querySelector("#viewer .monaco-editor");
    const active = ed?.querySelector(".line-numbers.active-line-number");
    return { line: active ? Number(active.textContent) : null, title: document.getElementById("viewer-title")?.textContent ?? null };
  });
}

async function main() {
  if (!existsSync("web/dist/index.html")) throw new Error("web/dist is missing — run `npm run build:ajar` first");
  const base = await mkdtemp(join(tmpdir(), "ajar-guest-tools-"));
  workdir = join(base, "project");
  await mkdir(join(workdir, "src", "nested"), { recursive: true });
  await writeFile(join(workdir, "main.py"), "import sys\n\n\ndef f( x ):\n    return x*2\n\n\nprint( 'alpha' )\n");
  await writeFile(join(workdir, "note.txt"), "one two three\n");
  await writeFile(join(workdir, "src", "one.py"), "alpha ALPHA alphabet\nprint('two')\n");
  await writeFile(join(workdir, "src", "nested", "two.txt"), "alpha\n");
  await writeFile(join(workdir, "README.md"), "# Notes\n\nSee [the program](main.py) and [the section](#second-part).\n\n![dot](dot.png)\n\n## Second part\n\n- [x] done\n");
  await writeFile(join(workdir, "empty.py"), "");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await writeFile(join(workdir, "dot.png"), png);
  await writeFile(join(workdir, ".gitignore"), "secret.txt\n");
  await writeFile(join(workdir, "secret.txt"), "alpha, where no guest looks\n");

  const relay = procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`, "--web", "web/dist"], "relay");
  await waitForHealth(RELAY);
  await sleep(200);
  if (relay.exitCode !== null) throw new Error(`the relay exited at start:\n${relay.output}`);
  // In its panel: `l` makes the session read-only part way through.
  const agent = startAgentInPanel(procs, [workdir, "--relay", RELAY, "--name", "hosty"]);
  const link = await linkOf(agent, 20_000);
  const site = await front();

  const browser = await chromium.launch({ channel: process.env.AJAR_BROWSER_CHANNEL || process.env.PAD_BROWSER_CHANNEL || undefined, headless: true });
  const ana = await guestPage(browser, link, "ana");

  // ---- the tree, as the pad draws its own --------------------------------------
  await row(ana, "main.py").waitFor({ timeout: 10_000 });
  const bar = await ana.locator(".tree-bar button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
  check(
    JSON.stringify(bar) === JSON.stringify(["New file", "New folder", "Upload files", "Download the whole workspace as a zip"]),
    "the bar over the files makes, uploads and downloads, as the pad's does",
    JSON.stringify(bar),
  );
  await row(ana, "main.py").hover();
  const actions = await row(ana, "main.py").locator(".row-actions button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
  check(
    JSON.stringify(actions) === JSON.stringify(["Rename main.py", "Download main.py", "Delete main.py"]) && (await row(ana, "src").locator(".ico svg").count()) === 1,
    "each row has an icon, and its own Rename, Download and Delete",
    JSON.stringify(actions),
  );

  // ---- making ---------------------------------------------------------------------
  await ana.getByRole("button", { name: "New file", exact: true }).click();
  await ana.locator(".name-input").fill("main.py");
  const problem = await until(async () => (await ana.locator(".name-problem").textContent()) || null, 3000);
  await ana.keyboard.press("Enter");
  check(/already a file called main\.py/.test(problem ?? "") && (await ana.locator(".name-input").count()) === 1, "a name that is taken is said to be, as it is typed, and Enter makes nothing", String(problem));
  await ana.locator(".name-input").fill("made/fresh.py");
  await ana.keyboard.press("Enter");
  const madeOpen = await editing(ana, "made/fresh.py");
  check(madeOpen && exists("made/fresh.py") && (await disk("made/fresh.py")) === "", "a file named in the tree is made on the host, folders and all, and opened", JSON.stringify({ madeOpen, there: exists("made/fresh.py") }));
  // An empty file of a kind there is a starter for offers one, as a pad's does.
  const hint = ana.locator(".starter-hint button");
  await hint.waitFor({ timeout: 8000 }).catch(() => {});
  const offered = await hint.textContent().catch(() => null);
  await hint.click().catch(() => {});
  const started = await onDisk("made/fresh.py", (t) => /Hello/.test(t));
  check(/Insert a Python starter/.test(offered ?? "") && /Hello/.test(started ?? ""), "and offers a starter, which is typed into it for everyone and saved", `${offered} → ${JSON.stringify((started ?? "").slice(0, 40))}`);

  await row(ana, "src").click({ button: "right" });
  await ana.getByRole("menuitem", { name: "New folder here", exact: true }).click();
  await ana.locator(".name-input").fill("lib");
  await ana.keyboard.press("Enter");
  check(
    (await until(async () => exists("src/lib") && (await row(ana, "src/lib").count()) === 1, 8000)) && (await stat(join(workdir, "src", "lib"))).isDirectory(),
    "a row's menu makes a folder inside it",
  );

  // ---- renaming and moving -------------------------------------------------------
  await row(ana, "note.txt").click();
  check(await editing(ana, "note.txt"), "note.txt opens for editing");
  await ana.locator("#viewer .view-line").first().click();
  await ana.keyboard.press(END);
  await ana.keyboard.type("typed before the rename\n");
  // By keyboard: the tree's stop, F2, the name typed over, Enter.
  await row(ana, "note.txt").focus();
  await ana.keyboard.press("F2");
  const selected = await ana.locator(".name-input").evaluate((i) => i.value.slice(i.selectionStart, i.selectionEnd));
  await ana.keyboard.type("renamed");
  await ana.keyboard.press("Enter");
  const renamedOpen = await editing(ana, "renamed.txt");
  const kept = await onDisk("renamed.txt", (t) => t.includes("typed before the rename"));
  check(
    selected === "note" && renamedOpen && !exists("note.txt") && (kept ?? "").includes("typed before the rename") && (await ana.locator('.editor-tab.active [role="tab"]').getAttribute("title")) === "renamed.txt",
    "F2 renames a file on the host; the tab open on it follows, with what was typed, and takes typing again",
    JSON.stringify({ selected, renamedOpen, old: exists("note.txt"), kept }),
  );
  await row(ana, "renamed.txt").dragTo(row(ana, "src"));
  const moved = await until(async () => exists("src/renamed.txt") && !exists("renamed.txt"), 8000);
  check(moved && (await editing(ana, "src/renamed.txt")), "dragged onto a folder, a file moves into it, and its tab with it");
  // Onto a name that is taken, it asks first.
  await writeFile(join(workdir, "renamed.txt"), "another of the same name\n");
  await row(ana, "renamed.txt").waitFor({ timeout: 8000 });
  await row(ana, "renamed.txt").dragTo(row(ana, "src"));
  const asks = ana.locator("dialog[open]");
  await asks.waitFor({ timeout: 5000 }).catch(() => {});
  const question = await asks.locator("h2").textContent().catch(() => null);
  await asks.getByRole("button", { name: "Cancel" }).click().catch(() => {});
  await sleep(400);
  check(/Replace src\/renamed\.txt\?/.test(question ?? "") && exists("renamed.txt") && (await disk("src/renamed.txt")).includes("typed before"), "a move onto a file that is there asks before replacing it, and Cancel moves nothing", String(question));

  // ---- deleting --------------------------------------------------------------------
  await row(ana, "renamed.txt").hover();
  await ana.getByRole("button", { name: "Delete renamed.txt", exact: true }).click();
  await ana.locator("dialog[open]").waitFor({ timeout: 5000 });
  const warning = await ana.locator("dialog[open] p").first().textContent();
  await ana.locator("dialog[open]").getByRole("button", { name: "Cancel" }).click();
  await sleep(300);
  const keptAfterCancel = exists("renamed.txt");
  await row(ana, "renamed.txt").focus();
  await ana.keyboard.press("Delete");
  await ana.locator("dialog[open]").getByRole("button", { name: "Delete", exact: true }).click();
  const gone = await until(async () => !exists("renamed.txt") && (await row(ana, "renamed.txt").count()) === 0, 8000);
  check(/no bin/.test(warning ?? "") && keptAfterCancel && gone, "Delete asks first, saying there is no bin; Cancel keeps the file, and Delete removes it from the host", JSON.stringify({ warning, keptAfterCancel, gone }));

  // ---- uploading -------------------------------------------------------------------
  const picture = Buffer.concat([png, Buffer.alloc(300_000, 7)]);
  await row(ana, "src").click();
  let chooser = ana.waitForEvent("filechooser");
  await ana.getByRole("button", { name: "Upload files", exact: true }).click();
  await (await chooser).setFiles([{ name: "upload.bin", mimeType: "application/octet-stream", buffer: picture }, { name: "words.txt", mimeType: "text/plain", buffer: Buffer.from("uploaded words\n") }]);
  const uploaded = await until(async () => exists("src/upload.bin") && exists("src/words.txt") && (await stat(join(workdir, "src", "upload.bin"))).size === picture.length, 15_000);
  check(
    uploaded && Buffer.compare(await readFile(join(workdir, "src", "upload.bin")), picture) === 0 && (await disk("src/words.txt")) === "uploaded words\n" && !!(await said(ana, /Uploaded 2 files to src\//)),
    "files picked are uploaded into the folder the tree is on, byte for byte",
    JSON.stringify(await toasts(ana)),
  );
  chooser = ana.waitForEvent("filechooser");
  await ana.getByRole("button", { name: "Upload files", exact: true }).click();
  await (await chooser).setFiles([{ name: "words.txt", mimeType: "text/plain", buffer: Buffer.from("the newer words\n") }]);
  await ana.locator("dialog[open]").waitFor({ timeout: 5000 });
  const replaceAsk = await ana.locator("dialog[open] h2").textContent();
  await ana.locator("dialog[open]").getByRole("button", { name: "Replace", exact: true }).click();
  check(/Replace words\.txt\?/.test(replaceAsk ?? "") && (await onDisk("src/words.txt", (t) => t === "the newer words\n")) === "the newer words\n", "one of a name that is taken replaces it only once asked", String(replaceAsk));

  // ---- search ----------------------------------------------------------------------
  await ana.locator("#sidebar .search-toggle").click();
  const query = ana.getByRole("searchbox", { name: "Search query" });
  await query.fill("alpha");
  await ana.waitForFunction(() => document.querySelector(".search-results")?.getAttribute("aria-busy") === "false" && document.querySelector(".search-hit"), null, { timeout: 15_000 }).catch(() => {});
  const groups = await ana.locator(".search-file-head strong").allTextContents();
  check(
    JSON.stringify(groups) === JSON.stringify(["main.py (1)", "src/nested/two.txt (1)", "src/one.py (3)"]),
    "a search of file contents is run on the host's disk: every file the tree shows, and none it hides",
    JSON.stringify(groups),
  );
  await ana.locator(".search-group", { hasText: "main.py" }).locator(".search-hit").first().click();
  const at = await until(async () => {
    const p = await place(ana);
    return p.title === "main.py" && p.line === 8 ? p : null;
  }, 10_000);
  const selection = await ana.evaluate(() => window.getSelection()?.toString() ?? "");
  check(!!at, "a result opens its file with the cursor on its line", JSON.stringify({ ...(await place(ana)), selection }));

  await ana.locator(".search-replace summary").click();
  await ana.getByLabel("Replacement text").fill("beta");
  await ana.locator(".search-group", { hasText: "src/one.py" }).getByRole("button", { name: "Replace…" }).click();
  await ana.locator("dialog.search-preview[open]").waitFor({ timeout: 15_000 });
  const before = await ana.locator(".search-diff-before").allTextContents();
  const after = await ana.locator(".search-diff-after").allTextContents();
  await ana.getByRole("button", { name: "Apply replacements" }).click();
  const outcome = await until(async () => {
    const t = await ana.locator("dialog.search-preview p[role=status]").textContent().catch(() => "");
    return /\d+ replacements? in \d+ files?/.test(t ?? "") ? t : null;
  }, 15_000);
  await ana.locator("dialog.search-preview").getByRole("button", { name: "Done" }).click().catch(() => {});
  check(
    before.join("|") === "1 − alpha ALPHA alphabet" && after.join("|") === "1 + beta beta betabet" && /3 replacements in 1 file/.test(outcome ?? "") && (await disk("src/one.py")) === "beta beta betabet\nprint('two')\n" && (await disk("main.py")).includes("alpha"),
    "Replace shows each changed line before it is changed, and changes only the file it was asked to, on the host",
    JSON.stringify({ before, after, outcome }),
  );
  // By name: its key, the arrows, Enter.
  await ana.locator("#viewer .view-line").first().click();
  await ana.keyboard.press(`${MOD}+p`);
  await query.fill("two.txt");
  await ana.waitForFunction(() => document.querySelector(".search-results")?.getAttribute("aria-busy") === "false" && document.querySelector(".search-hit"), null, { timeout: 10_000 }).catch(() => {});
  await ana.keyboard.press("Enter");
  check(await editing(ana, "src/nested/two.txt"), "a search of file names, from its key, opens the file found");
  await ana.getByRole("button", { name: "Back to files" }).click();

  // ---- the editor's tools -----------------------------------------------------------
  await row(ana, "main.py").click();
  await editing(ana, "main.py");
  await ana.locator("#format-file").click();
  const formatted = await onDisk("main.py", (t) => t.includes("def f(x):") && t.includes('print("alpha")'), 20_000);
  check((formatted ?? "").includes("def f(x):\n    return x * 2") && !!(await said(ana, /Formatted main\.py/)), "Format formats the file with its language's own formatter, for everyone, and it is saved", JSON.stringify(formatted));
  // What an editor has of its own, which this page's did not load until
  // 19 November: find and replace in the file, and a menu on a right click.
  await ana.locator("#viewer .view-line").first().click();
  await ana.keyboard.press(`${MOD}+f`);
  const finds = await until(async () => (await ana.locator("#viewer .find-widget.visible").count()) > 0, 5000);
  await ana.keyboard.press("Escape");
  await ana.locator("#viewer .view-line").first().click({ button: "right" });
  const menu = await until(async () => {
    const items = await ana.locator(".monaco-menu .action-label").allTextContents();
    return items.some((t) => /Format Document/.test(t)) ? items : null;
  }, 5000);
  await ana.keyboard.press("Escape");
  check(!!finds && !!menu, "the editor finds and replaces within a file, and its own menu has Format Document", JSON.stringify({ finds, menu: (menu || []).slice(0, 6) }));
  const indent = ana.locator("#indent");
  const wasIndent = await indent.textContent();
  await indent.click();
  await ana.locator("#viewer .view-line").last().click();
  await ana.keyboard.press(END);
  await ana.keyboard.type("if True:\npass\n");
  const twoSpaces = await onDisk("main.py", (t) => t.includes("if True:\n  pass\n"));
  check(wasIndent === "Spaces: 4" && (await indent.textContent()) === "Spaces: 2" && (twoSpaces ?? "").includes("if True:\n  pass\n"), "Spaces switches the indent to 2, for what is typed from then on", JSON.stringify({ wasIndent, now: await indent.textContent() }));
  await indent.click();

  await row(ana, "README.md").click();
  await editing(ana, "README.md");
  await ana.locator("#markdown-view").click();
  await ana.locator(".md-body h1").waitFor({ timeout: 15_000 }).catch(() => {});
  const heading = await ana.locator(".md-body h1").textContent().catch(() => null);
  const img = await until(async () => {
    const src = await ana.locator(".md-body img").getAttribute("src").catch(() => null);
    return src?.startsWith("data:image/png;base64,") ? src : null;
  }, 10_000);
  check(
    heading === "Notes" && !!img && Buffer.compare(Buffer.from(img.split(",")[1], "base64"), png) === 0 && (await ana.locator(".md-body input[type=checkbox]").count()) === 1,
    "a Markdown file is shown formatted, beside its text, with its pictures — their bytes from the host",
    JSON.stringify({ heading, img: img?.slice(0, 40) }),
  );
  await ana.locator('.md-body a[href="main.py"]').click();
  check(await editing(ana, "main.py"), "and a link in it to another file opens that file");

  await row(ana, "dot.png").click();
  const shown = await until(async () => ana.locator(".editor-group.focused .image-view img").evaluate((i) => (i.complete && i.naturalWidth ? `${i.naturalWidth}x${i.naturalHeight}` : null)).catch(() => null), 10_000);
  check(shown === "1x1" && (await ana.locator("#editor-actions .editor-tools").isHidden()), "an image opens as a picture, in the editor's place, and the editor's tools step aside", String(shown));

  // ---- the terminals ----------------------------------------------------------------
  await shell(ana, `clear; printf 'Traceback:\\n  File "main.py", line 4, in f\\n'`);
  const where = await until(async () => {
    const box = await ana.evaluate(() => {
      const rows = [...document.querySelectorAll(".term.shown .xterm-rows > div")];
      const at = rows.find((r) => r.textContent.trimStart().startsWith('File "main.py", line 4'));
      if (!at) return null;
      const r = at.getBoundingClientRect();
      return { x: r.left + r.width * 0.06, y: r.top + r.height / 2 };
    });
    return box;
  }, 10_000);
  if (where) {
    await ana.mouse.move(where.x, where.y);
    await sleep(300);
    await ana.mouse.click(where.x, where.y);
  }
  const jumped = await until(async () => {
    const p = await place(ana);
    return p.title === "main.py" && p.line === 4 ? p : null;
  }, 10_000);
  check(!!jumped, "a file and line a program printed is a link: clicked, the file opens at that line", JSON.stringify(await place(ana)));

  const reader = ana.getByRole("button", { name: "Screen reader", exact: true });
  await reader.click();
  const reading = await until(async () => (await ana.locator(".term.shown .xterm-accessibility").count()) > 0, 5000);
  check((await reader.getAttribute("aria-pressed")) === "true" && reading, "Screen reader gives a screen reader the terminal's text");
  await reader.click();

  await ana.click("#new-terminal");
  await until(async () => (await ana.locator(".term").count()) === 2, 8000);
  await ana.locator(".tab-wrap").last().hover();
  await ana.locator(".tab-wrap").last().locator(".tab-close").click();
  await ana.locator("dialog[open]").waitFor({ timeout: 5000 }).catch(() => {});
  const closing = await ana.locator("dialog[open] p").first().textContent().catch(() => null);
  await ana.locator("dialog[open]").getByRole("button", { name: "Close it", exact: true }).click().catch(() => {});
  check(/for everyone here/.test(closing ?? "") && (await until(async () => (await ana.locator(".term").count()) === 1, 8000)), "the cross on a terminal's tab closes it — for everyone, so it asks first", String(closing));

  // ---- read-only ---------------------------------------------------------------------
  // The host's `l`. What changes the folder is still there, and off, saying
  // why; what does not — downloading, searching, looking — carries on.
  agent.press("l");
  await until(async () => (await ana.locator("#readonly").isVisible()), 8000);
  await row(ana, "main.py").hover();
  const off = await ana.evaluate(() => ({
    bar: [...document.querySelectorAll(".tree-bar button")].map((b) => [b.getAttribute("aria-label"), b.disabled]),
    why: document.querySelector('.tree-bar button[aria-label="New file"]')?.title ?? "",
    row: [...document.querySelectorAll('.tree-row[data-path="main.py"] .row-actions button')].map((b) => [b.getAttribute("aria-label"), b.disabled]),
    close: [...document.querySelectorAll(".tab-close")].every((b) => b.hidden),
  }));
  await ana.locator("#sidebar .search-toggle").click();
  await query.fill("beta");
  await ana.waitForFunction(() => document.querySelector(".search-results")?.getAttribute("aria-busy") === "false" && document.querySelector(".search-hit"), null, { timeout: 15_000 }).catch(() => {});
  const stillFinds = await ana.locator(".search-hit").count();
  const replaceOffered = (await ana.locator(".search-replace").isVisible()) || (await ana.locator(".search-file-head .btn").count()) > 0;
  await ana.getByRole("button", { name: "Back to files" }).click();
  check(
    JSON.stringify(off.bar) === JSON.stringify([["New file", true], ["New folder", true], ["Upload files", true], ["Download the whole workspace as a zip", false]]) &&
      /read-only/.test(off.why) &&
      JSON.stringify(off.row) === JSON.stringify([["Rename main.py", true], ["Download main.py", false], ["Delete main.py", true]]) &&
      off.close && stillFinds > 0 && !replaceOffered,
    "read-only switches off what changes the folder, saying why, and leaves downloading and searching",
    JSON.stringify({ ...off, stillFinds, replaceOffered }),
  );
  agent.press("l");
  check(await until(async () => !(await ana.getByRole("button", { name: "New file", exact: true }).isDisabled()), 8000), "and it all comes back when the host allows changes again");

  // ---- suggestions --------------------------------------------------------------------
  // Grey text as code is typed, from the model the front serves beside the
  // page; Tab takes it, and only then is it in the file. Typed a key at a
  // time, as a person does, since each key asks again.
  if (!MODEL) {
    console.log("  skip suggestions: no model in pad/public/packages (pad/scripts/fetch-packages.mjs fetches it)");
  } else {
    await row(ana, "empty.py").click();
    await editing(ana, "empty.py");
    const suggest = ana.locator("#suggest");
    await suggest.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    const offeredSwitch = (await suggest.isVisible()) && (await suggest.getAttribute("aria-pressed")) === "true";
    await ana.locator("#viewer .monaco-editor").first().click();
    await ana.keyboard.type("d");
    const ready = await until(async () => /^Suggestions on: Tab/.test((await suggest.getAttribute("title")) ?? ""), 120_000, 250);
    check(offeredSwitch && !!ready, "where the site has the suggestion model, Suggest is offered, and the model loads at the first key typed into code", String(await suggest.getAttribute("title").catch(() => null)));
    const ghost = () => ana.evaluate(() => document.querySelector("#viewer .ghost-text-decoration")?.textContent ?? "");
    const lines = ["ef mean(values):", "return sum(values) / len(values)", "", "", "def median(values):", "ordered = sorted(values)", "middle = len(ordered) // 2", "return ordered[middle]"];
    let shown = 0;
    let taken = "";
    let typed = "d";
    let held = true;
    for (const line of lines) {
      let i = 0;
      while (i < line.length) {
        await sleep(120);
        const grey = await ghost();
        if (grey) shown++;
        if (grey && !taken && line.slice(i).startsWith(grey)) {
          // Grey text is not in the file, on the host's disk or anyone's page.
          await sleep(900);
          held = !((await disk("empty.py")) ?? "").includes(typed + grey);
          await ana.keyboard.press("Tab");
          taken = grey;
          typed += grey;
          i += grey.length;
          continue;
        }
        await ana.keyboard.type(line[i]);
        typed += line[i];
        i++;
      }
      await ana.keyboard.press("Enter");
      typed = "";
    }
    const kept = taken ? await onDisk("empty.py", (t) => t.includes("def mean(values):") && t.includes("return ordered[middle]")) : null;
    check(
      shown > 0 && taken !== "" && held && !!kept && kept.includes("def mean(values):"),
      "the rest of a line is offered in grey as code is typed, is not in the file until Tab takes it, and then is, on the host",
      JSON.stringify({ shown, taken, held, kept: (kept ?? "").slice(0, 60) }),
    );
  }

  // ---- a phone -----------------------------------------------------------------------
  // The keys its keyboard lacks, under the terminal's header: sent to the
  // terminal in front as the key would be.
  const phone = await guestPage(browser, link, "phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const keys = await phone.locator(".term-keys .term-key").allTextContents();
  await phone.locator(".term.shown .xterm").first().tap();
  await phone.keyboard.type("clear; cat\r");
  await sleep(600);
  await phone.keyboard.type("held by cat\r");
  await phone.locator(".term-keys .term-key", { hasText: "Ctrl-D" }).tap();
  await phone.keyboard.type("echo after-$((40+2))\r");
  const ended = await until(async () => (/after-42/.test(await screen(phone)) ? true : null), 10_000);
  check(
    JSON.stringify(keys) === JSON.stringify(["Tab", "Ctrl-C", "↑", "↓", "←", "→", "Esc", "Ctrl-D"]) && ended,
    "on a touch screen a row of keys sits under the terminal's header, and Ctrl-D there ends a program's input",
    JSON.stringify({ keys, screen: (await screen(phone)).slice(-200) }),
  );
  check(phone.errors.length === 0 && phone.refused.length === 0, "no page errors, and nothing the site's policy refused (phone)", [...phone.errors, ...phone.refused].join(" | "));
  await phone.context().close();

  // ---- the guide ---------------------------------------------------------------------
  const help = await browser.newPage();
  await watchPolicy(help);
  await help.goto(`${SITE}/help`);
  const title = await help.locator(".md-body h1").textContent({ timeout: 15_000 }).catch(() => null);
  await help.goto(`${SITE}/`);
  const linked = await help.locator('.landing a[href="/help"]').count();
  check(title === "Sharing a machine" && linked === 1 && help.refused.length === 0, "the guide is a page of the site, at /help, and the front page links to it", `${title} ${help.refused.join(" | ")}`);
  await help.close();

  check(ana.errors.length === 0, "no page errors (ana)", ana.errors.join(" | "));
  check(ana.refused.length === 0, "and nothing the site's policy refused: formatters, pictures, the search's worker, the model", ana.refused.join(" | "));
  await browser.close();
  site.closeAllConnections();
  site.close();
  await rm(base, { recursive: true, force: true });
  finish(procs, "a guest's page makes, renames, moves, deletes, uploads, searches, formats and previews, as the pad's does");
}

main().catch(async (e) => {
  fail(e.stack ?? String(e));
  finish(procs, "");
});

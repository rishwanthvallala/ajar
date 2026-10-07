#!/usr/bin/env node
// The session client, in a real browser, through the things that go wrong
// around it: a blip on the guest's own connection, Back out of the
// back/forward cache, the relay restarting, the host away, other guests
// arriving and leaving, files the editor cannot safely edit, and a terminal
// the host refuses.
//
// Each of these was found broken by putting a browser through it, in the
// review of 7 October; the wire-level suites passed throughout. So this drives
// web/dist, served by a real relay, with a real agent.
//
// Needs `npm run build:ajar` and `cargo build` first.
//
//   node scripts/check-guest.mjs

import { connect, createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { fail, finish, Guest, linkOf, ok, Procs, sleep, startAgentInPanel, waitForHealth } from "./lib/wire.mjs";

const { chromium } = createRequire(new URL("../web/package.json", import.meta.url))("playwright");

const PORT = 8841;
const GUEST_PORT = 8842;
const AGENT_PORT = 8843;
const LAG_PORT = 8844;
const RELAY = `http://127.0.0.1:${PORT}`;
/** Guests load the page through their own hop, so their socket can be cut. */
const GUEST = `http://127.0.0.1:${GUEST_PORT}`;
const START = process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home";

const procs = new Procs();
let workdir;
const browsers = [];

/** A hop that can be cut — every connection through it dropped, new ones refused. */
function cuttableProxy(listenPort, targetPort) {
  const live = new Set();
  let cut = false;
  const server = createServer((down) => {
    if (cut) return void down.destroy();
    const up = connect(targetPort, "127.0.0.1");
    const pair = { down, up };
    live.add(pair);
    const end = () => {
      down.destroy();
      up.destroy();
      live.delete(pair);
    };
    down.on("error", end).on("close", end);
    up.on("error", end).on("close", end);
    down.pipe(up);
    up.pipe(down);
  });
  return {
    listen: () => new Promise((r) => server.listen(listenPort, "127.0.0.1", r)),
    cut() {
      cut = true;
      for (const { down, up } of live) {
        down.destroy();
        up.destroy();
      }
      live.clear();
    },
    restore() {
      cut = false;
    },
    close: () => server.close(),
  };
}

/** A hop that delays everything by `ms` each way, in order — a guest far away. */
function laggyProxy(listenPort, targetPort, ms) {
  const server = createServer((down) => {
    const up = connect(targetPort, "127.0.0.1");
    const lag = (from, to) => {
      let last = 0;
      from.on("data", (chunk) => {
        const at = Math.max(Date.now() + ms, last);
        last = at;
        setTimeout(() => to.writable && to.write(chunk), at - Date.now());
      });
    };
    lag(down, up);
    lag(up, down);
    const end = () => {
      down.destroy();
      up.destroy();
    };
    down.on("error", end).on("close", end);
    up.on("error", end).on("close", end);
  });
  return {
    listen: () => new Promise((r) => server.listen(listenPort, "127.0.0.1", r)),
    close: () => server.close(),
  };
}

/** What the editor shows, for a file short enough to be all on screen. */
function editorText(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll("#viewer .view-lines .view-line")];
    lines.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
    return lines.map((l) => l.textContent.replace(/\u00a0/g, " ")).join("\n");
  });
}

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

async function startRelay() {
  const relay = procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`, "--web", "web/dist"], "relay");
  await waitForHealth(RELAY);
  // Something else already on the port would have answered that health
  // check, and every result below would be about a different binary.
  await sleep(200);
  if (relay.exitCode !== null) throw new Error(`the relay exited at start:\n${relay.output}`);
  return relay;
}

async function guestPage(browser, link, name, viewport = { width: 1400, height: 800 }) {
  const page = await browser.newPage({ viewport });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.addInitScript(() => {
    window.__restored = 0;
    addEventListener("pageshow", (e) => {
      if (e.persisted) window.__restored += 1;
    });
  });
  await page.goto(`${GUEST}/j/${link.session}#k=${link.key}`);
  await page.fill("#name", name);
  await page.click("#join button[type=submit]");
  await page.locator(".term.shown .xterm").first().waitFor({ timeout: 20_000 });
  return page;
}

/** Open a file and wait until it is bound for editing, or shown if it cannot be. */
async function open(page, path, { editable = true } = {}) {
  await page.locator(`.tree-row[data-path="${path}"]`).click();
  if (editable) {
    await page.waitForFunction((p) => document.getElementById("viewer")?.dataset.editing === p, path, { timeout: 15_000 }).catch(async (e) => {
      // What the page was showing instead, so a failure here says why.
      const seen = await page.evaluate(() => ({
        status: document.getElementById("status")?.textContent,
        title: document.getElementById("viewer-title")?.textContent,
        active: document.querySelector(".tree-row.active")?.dataset.path,
      }));
      throw new Error(`${path} was not opened for editing: ${JSON.stringify({ ...seen, errors: page.errors })}\n${e.message}`);
    });
  } else {
    // What the title then says is for the caller to check.
    await page.waitForFunction((p) => document.getElementById("viewer-title")?.textContent?.startsWith(`${p} ·`), path, { timeout: 8000 }).catch(() => {});
  }
}

/** The first line on screen and the cursor's line, read off the editor. */
async function where(page) {
  await focusEditor(page);
  await sleep(100);
  return page.evaluate(() => {
    const ed = document.querySelector("#viewer .monaco-editor");
    if (!ed) return null;
    const box = ed.getBoundingClientRect();
    const shown = [...ed.querySelectorAll(".line-numbers")]
      .map((n) => ({ n: Number(n.textContent), r: n.getBoundingClientRect() }))
      .filter((x) => x.n > 0 && x.r.bottom > box.top + 2 && x.r.top < box.bottom)
      .sort((a, b) => a.r.top - b.r.top);
    const active = ed.querySelector(".line-numbers.active-line-number");
    return { top: shown[0]?.n ?? null, cursor: active ? Number(active.textContent) : null };
  });
}

/** Focus the editor without moving its cursor. Monaco 0.56 takes keys through an edit context where the browser has one. */
async function focusEditor(page) {
  await page.evaluate(() => {
    const ed = document.querySelector("#viewer .monaco-editor");
    (ed?.querySelector(".native-edit-context") ?? ed?.querySelector("textarea"))?.focus();
  });
}

/** Page well down a long file: the view and the cursor both end up there. */
async function settleMidway(page) {
  await page.locator("#viewer .view-line").first().click();
  for (let i = 0; i < 30; i++) await page.keyboard.press("PageDown");
  await sleep(300);
}

async function screen(page, nth = 0) {
  return page.evaluate((n) => {
    const t = document.querySelectorAll(".term.shown")[n];
    return t ? [...t.querySelectorAll(".xterm-rows > div")].map((d) => d.textContent).join("\n") : "";
  }, nth);
}

/** Ask the shell in the first terminal how big it is: [rows, cols]. */
async function ttySize(page, tag) {
  await page.locator(".term.shown .xterm").first().click();
  await page.keyboard.type(`clear; echo ${tag}=$(stty size | tr ' ' x)\r`);
  const found = await until(async () => (await screen(page)).match(new RegExp(`${tag}=(\\d+)x(\\d+)`)), 8000);
  return found ? [Number(found[1]), Number(found[2])] : null;
}

async function onDisk(file, test, timeoutMs = 8000) {
  let text = "";
  await until(async () => {
    text = await readFile(file, "utf8");
    return test(text);
  }, timeoutMs);
  return text;
}

async function main() {
  if (!existsSync("web/dist/index.html")) throw new Error("web/dist is missing — run `npm run build:ajar` first");
  workdir = await mkdtemp(join(tmpdir(), "ajar-guest-ui-"));
  const long = join(workdir, "long.txt");
  await writeFile(long, Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  await writeFile(join(workdir, "note.txt"), "one two three\n");
  await writeFile(join(workdir, "pic.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff, 0xfe, 0, 1, 2, 3]));
  const mixed = join(workdir, "mixed.txt");
  await writeFile(mixed, "one\r\ntwo\nthree\n");
  const bom = join(workdir, "bom.txt");
  await writeFile(bom, "﻿hello\nworld\n");
  // For downloads: something the ignore rules hide, and something big enough
  // to need more than one window of the transfer.
  await writeFile(join(workdir, ".gitignore"), "secret.txt\n");
  await writeFile(join(workdir, "secret.txt"), "not for guests\n");
  await writeFile(join(workdir, "big.bin"), randomBytes(3 * 1024 * 1024));
  await mkdir(join(workdir, "nothing-here"));

  let relay = await startRelay();
  const guestHop = cuttableProxy(GUEST_PORT, PORT);
  await guestHop.listen();
  const agentHop = cuttableProxy(AGENT_PORT, PORT);
  await agentHop.listen();
  const agent = procs.start(
    "target/debug/ajar",
    [workdir, "--relay", `http://127.0.0.1:${AGENT_PORT}`, "--name", "hosty", "--max-terminals", "2"],
    "agent",
  );
  const link = await linkOf(agent);

  const browser = await chromium.launch({ headless: true });
  browsers.push(browser);
  const ana = await guestPage(browser, link, "ana");

  // ---- links that cannot work ------------------------------------------------
  // A key cut short — as an 80-column panel used to cut it — or missing, or
  // whole but not this session's: the page joined anyway and sat on
  // "Loading…" for good.
  for (const [hash, title] of [
    [`#k=${link.key.slice(0, 32)}`, "This link is incomplete"],
    ["", "This link is incomplete"],
    [`#k=${"A".repeat(43)}`, "This link's key doesn't fit"],
  ]) {
    const page = await browser.newPage();
    await page.goto(`${GUEST}/j/${link.session}${hash}`);
    if (await page.locator("#name").count()) {
      await page.fill("#name", "keyless");
      await page.click("#join button[type=submit]");
    }
    const shown = await page.locator(".gate h1", { hasText: title }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check(shown, `a link ${hash ? (hash.length < 40 ? "with its key cut short" : "with someone else's key") : "with no key"} says "${title}"`);
    await page.close();
  }
  const dots = await ana.locator("#people .person-dot").count();
  check(dots === (await ana.locator("#people [role=listitem]").count()) && dots >= 2, "each person has a dot in their cursor's colour", String(dots));
  check(
    await ana.locator('.tree-row.empty-folder[data-path="nothing-here/"]').waitFor({ timeout: 5000 }).then(() => true, () => false),
    "an open folder with nothing in it says so",
  );
  const listed = await ana.locator("#people [role=listitem]").allTextContents();
  check(listed.some((t) => /ana \(you\)/.test(t)) && listed.some((t) => /hosty \(host\)/.test(t)), "the people here are a list, with you and the host marked in words", JSON.stringify(listed));

  // ---- by keyboard -------------------------------------------------------------
  // The tree is one stop, moved through with the arrows; every row used to be
  // a stop of its own, and a repaint dropped the focus once Tab got past the
  // first screenful.
  await ana.locator('#tree [role="tree"] [tabindex="0"]').focus();
  const focused = () => ana.evaluate(() => document.activeElement?.dataset?.path ?? document.activeElement?.id ?? null);
  await ana.keyboard.press("End");
  const lastRow = await focused();
  await ana.keyboard.press("Home");
  const firstRow = await focused();
  await ana.keyboard.press("ArrowDown");
  const secondRow = await focused();
  check(lastRow && firstRow && secondRow && firstRow !== lastRow && secondRow !== firstRow, "the file tree moves with Home, End and the arrows", JSON.stringify({ firstRow, secondRow, lastRow }));
  const level = await ana.locator(`.tree-row[data-path="${firstRow}"]`).getAttribute("aria-level");
  check(level === "1", "and says how deep each row is", String(level));
  for (let i = 0; i < 12 && (await focused()) !== "note.txt"; i++) await ana.keyboard.press("ArrowDown");
  await ana.keyboard.press("Enter");
  check(
    await ana.waitForFunction(() => document.getElementById("viewer")?.dataset.editing === "note.txt", null, { timeout: 10_000 }).then(() => true, () => false),
    "and Enter opens a file",
  );
  // A terminal takes every key, so focus that went in could not come out.
  await ana.locator(".term.shown .xterm").first().click();
  await ana.keyboard.press("F6");
  const out = await focused();
  check(out === "new-terminal" || out === "split", "F6 leaves the terminal", String(out));

  // ---- by mouse ----------------------------------------------------------------
  // A click is a press and a release on the same row. Every change in the
  // folder repaints the tree, and a repaint used to replace every row, so a
  // file arriving between the two swallowed the click. It sorts below the
  // row pressed, so that row stays under the pointer.
  await ana.locator("#close-file").click();
  await sleep(300);
  const row = await ana.locator('.tree-row[data-path="note.txt"]').boundingBox();
  await ana.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
  await ana.mouse.down();
  await writeFile(join(workdir, "zz-arrived.txt"), "mid-click\n");
  const repainted = await ana.locator('.tree-row[data-path="zz-arrived.txt"]').waitFor({ timeout: 10_000 }).then(() => true, () => false);
  await ana.mouse.up();
  check(
    repainted && (await ana.waitForFunction(() => document.getElementById("viewer")?.dataset.editing === "note.txt", null, { timeout: 10_000 }).then(() => true, () => false)),
    "a click on a file survives the tree changing between press and release",
    JSON.stringify({ repainted, editing: await ana.evaluate(() => document.getElementById("viewer")?.dataset.editing ?? null) }),
  );

  // ---- downloads --------------------------------------------------------------
  // On a fresh page, before anything in the tree has been chosen, Download all
  // is everything — the tree's stop falls back to its first row, a folder
  // here, and that folder alone was what came down.
  {
    const fresh = await guestPage(browser, link, "fresh");
    const button = fresh.locator("#sidebar-actions button.download");
    const label = await button.textContent();
    const [first] = await Promise.all([fresh.waitForEvent("download", { timeout: 30_000 }), button.click()]);
    check(
      label === "Download all" && first.suggestedFilename() !== "nothing-here.zip",
      "Download all on a fresh page downloads everything, not the first folder",
      `${label} → ${first.suggestedFilename()}`,
    );
    await fresh.close();
  }
  // Everything, as a zip the host makes from the tree's own list; and one
  // file as itself. The zip is over a megabyte, so it only arrives whole if
  // each window is acknowledged and the next one sent.
  await ana.locator('.tree-row[data-path="note.txt"]').click();
  const allButton = ana.locator("#sidebar-actions button.download");
  await until(async () => (await allButton.textContent()) === "Download all", 5000);
  const [zipDownload] = await Promise.all([ana.waitForEvent("download", { timeout: 30_000 }), allButton.click()]);
  const zipPath = join(workdir, "..", `${zipDownload.suggestedFilename()}`);
  await zipDownload.saveAs(zipPath);
  let listing = "";
  try {
    execFileSync("unzip", ["-tq", zipPath]);
    listing = execFileSync("unzip", ["-Z1", zipPath]).toString();
  } catch (e) {
    listing = `unzip failed: ${e.message}`;
  }
  const top = zipDownload.suggestedFilename().replace(/\.zip$/, "");
  check(
    listing.includes(`${top}/long.txt`) && listing.includes(`${top}/big.bin`) && !listing.includes("secret.txt"),
    "Download all is a zip of the folder, intact, without what the ignore rules hide",
    listing.split("\n").slice(0, 12).join(", "),
  );
  await rm(zipPath, { force: true });
  await open(ana, "note.txt");
  const [fileDownload] = await Promise.all([ana.waitForEvent("download", { timeout: 15_000 }), ana.locator("#editor-actions button.download").click()]);
  const filePath = join(workdir, "..", `downloaded-${fileDownload.suggestedFilename()}`);
  await fileDownload.saveAs(filePath);
  check(
    fileDownload.suggestedFilename() === "note.txt" && (await readFile(filePath, "utf8")) === (await readFile(join(workdir, "note.txt"), "utf8")),
    "and the open file downloads as itself",
  );
  await rm(filePath, { force: true });

  // ---- files the editor must not edit ---------------------------------------
  await open(ana, "pic.bin", { editable: false });
  const binTitle = await ana.locator("#viewer-title").textContent();
  check(/binary/.test(binTitle), "a binary file says so in its title", JSON.stringify(binTitle));

  for (const [name, file, before] of [["mixed.txt", mixed, "one\r\ntwo\nthree\n"], ["bom.txt", bom, "﻿hello\nworld\n"]]) {
    await open(ana, name, { editable: false });
    // The host's refusal titles it first, then the read-only copy it falls
    // back to; a slow runner looked in between (CI run 139).
    const title = await until(async () => {
      const t = await ana.locator("#viewer-title").textContent();
      return /read-only/.test(t) ? t : null;
    }, 8000);
    check(title, `${name} opens read-only, saying why`, JSON.stringify(await ana.locator("#viewer-title").textContent()));
    await ana.locator("#viewer .view-line").nth(1).click();
    await ana.keyboard.type("Y");
    await sleep(1200);
    const after = await readFile(file, "utf8");
    check(after === before, `and typing at it changes nothing on disk`, JSON.stringify(after));
  }

  // ---- where you were in a file ---------------------------------------------
  await open(ana, "long.txt");
  await settleMidway(ana);
  const mid = await where(ana);
  check(mid?.top > 100 && mid?.cursor > mid.top, "settled well down long.txt", JSON.stringify(mid));
  await open(ana, "note.txt");
  await open(ana, "long.txt");
  await sleep(300);
  const back = await where(ana);
  check(back?.top === mid.top && back?.cursor === mid.cursor, "another file and back: the same place in long.txt", `${JSON.stringify(mid)} → ${JSON.stringify(back)}`);

  // ---- a blip on the guest's own connection ---------------------------------
  // Somewhere other than where the file was left, so that what comes back
  // after the blip cannot be that saved place by coincidence.
  await focusEditor(ana);
  for (let i = 0; i < 7; i++) await ana.keyboard.press("ArrowDown");
  await ana.keyboard.press("PageDown");
  await sleep(200);
  const moved = await where(ana);
  check(moved?.cursor !== mid.cursor, "moved on in long.txt", `${JSON.stringify(mid)} → ${JSON.stringify(moved)}`);
  mid.top = moved.top;
  mid.cursor = moved.cursor;
  guestHop.cut();
  await ana.locator("#status", { hasText: "reconnecting" }).waitFor({ timeout: 10_000 });
  await sleep(1500);
  guestHop.restore();
  await ana.locator("#status", { hasText: /^connected$/ }).waitFor({ timeout: 20_000 });
  await ana.waitForFunction(() => document.getElementById("viewer")?.dataset.editing === "long.txt", null, { timeout: 15_000 });
  await sleep(500);
  const afterBlip = await where(ana);
  check(afterBlip?.top === mid.top && afterBlip?.cursor === mid.cursor, "a dropped connection leaves the reader where they were", `${JSON.stringify(mid)} → ${JSON.stringify(afterBlip)}`);
  await focusEditor(ana);
  await ana.keyboard.type("BLIP ");
  const blipped = await onDisk(long, (t) => t.includes("BLIP "));
  const blipLine = blipped.split("\n").findIndex((l) => l.includes("BLIP ")) + 1;
  check(blipLine === mid.cursor, "and the next keystroke lands where the cursor was, not at line 1", `landed on line ${blipLine}, cursor was ${mid.cursor}`);

  // ---- other guests: cursors and terminal sizes -----------------------------
  const before = await ttySize(ana, "BIG");
  const ben = await guestPage(browser, link, "ben", { width: 800, height: 540 });
  await open(ben, "long.txt");
  await ben.locator("#viewer .view-line").first().click();
  await ben.keyboard.type("ben-was-here ");
  const anaSeesBen = await until(() => ana.locator(".remote-caret").count(), 8000);
  // Ben is at the top of the file, ana well down it: scroll ana up to see.
  if (!anaSeesBen) {
    await ana.locator("#viewer").click();
    await ana.keyboard.press(START);
  }
  check(await until(() => ana.locator(".remote-caret").count(), 15_000), "another guest's cursor shows");
  await ana.locator(".term.shown .xterm").first().click();
  const small = await ttySize(ana, "SMALL");
  check(small && before && small[1] < before[1], "a smaller guest narrows the terminal for everyone", `${before} → ${small}`);
  await ben.close();
  const cursorGone = await until(async () => (await ana.locator(".remote-caret").count()) === 0, 8000);
  check(cursorGone, "a guest who leaves takes their cursor with them");
  const after = await until(async () => {
    const s = await ttySize(ana, "AFTER");
    return s && s[1] === before[1] ? s : null;
  }, 12_000, 1000);
  check(after, "and once they leave, the terminal is the size of who is left", `${before} → ${small} → ${await ttySize(ana, "LAST")}`);

  // ---- the terminal limit ---------------------------------------------------
  await ana.click("#new-terminal");
  await until(async () => (await ana.locator(".term").count()) === 2, 8000);
  await ana.click("#new-terminal");
  const refusal = await until(async () => (await ana.locator(".term-notice").textContent()) || null, 8000);
  check(/limit/.test(refusal ?? ""), "a terminal the host refuses says why", JSON.stringify(refusal));

  // ---- a terminal that ends while a guest cannot hear -----------------------
  // Another guest, on a connection of their own, exits the second terminal
  // while ana's is down. Nobody can tell ana; the host's list on her return
  // is all she has to go on.
  const eve = await browser.newPage();
  await eve.goto(`${RELAY}/j/${link.session}#k=${link.key}`);
  await eve.fill("#name", "eve");
  await eve.click("#join button[type=submit]");
  await until(async () => (await eve.locator(".term").count()) === 2, 15_000);
  guestHop.cut();
  await ana.locator("#status", { hasText: "reconnecting" }).waitFor({ timeout: 10_000 });
  await eve.locator(".term.shown .xterm").first().click();
  await eve.keyboard.type("exit\r");
  await until(async () => (await eve.locator(".term").count()) === 1, 10_000);
  guestHop.restore();
  await ana.locator("#status", { hasText: /^connected$/ }).waitFor({ timeout: 20_000 });
  const anaTerms = await until(async () => ((await ana.locator(".term").count()) === 1 ? 1 : null), 10_000);
  check(anaTerms === 1, "a terminal that ended while a guest was disconnected is gone from their tabs too", `${await ana.locator(".term").count()} terminals`);
  await eve.close();

  // ---- the host away --------------------------------------------------------
  agentHop.cut();
  await ana.locator("#away:not([hidden])").waitFor({ timeout: 10_000 });
  const leaving = () => ana.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
  check(!(await leaving()), "with nothing typed, leaving the page asks nothing");
  await focusEditor(ana);
  await ana.keyboard.type("AWAY ");
  check(await leaving(), "typing that has nowhere to go yet makes leaving the page ask first");
  check(/host away/.test(await ana.locator("#status").textContent()), "with the host away the status says so, not \"connected\"");
  const first = await ana.locator("#away").textContent();
  await sleep(2100);
  const second = await ana.locator("#away").textContent();
  check(first !== second && /Holding this session for/.test(second), "and the countdown counts", `${first} / ${second}`);
  const cara = await browser.newPage();
  await cara.goto(`${GUEST}/j/${link.session}#k=${link.key}`);
  await cara.fill("#name", "cara");
  await cara.click("#join button[type=submit]");
  check(
    await cara.locator("#away:not([hidden])").waitFor({ timeout: 10_000 }).then(() => true, () => false),
    "someone joining while the host is away is told, rather than shown an empty session",
  );
  await cara.close();
  await ana.locator('.tree-row[data-path="note.txt"]').click();
  const awayTitle = await until(async () => {
    const t = await ana.locator("#viewer-title").textContent();
    return t.startsWith("note.txt ·") ? t : null;
  }, 8000);
  check(awayTitle, "a file opened while the host is away says where it came from, or why it cannot open", JSON.stringify(awayTitle));
  agentHop.restore();
  await ana.locator("#away[hidden]").waitFor({ state: "attached", timeout: 30_000 });
  check(
    await ana.waitForFunction(() => document.getElementById("viewer")?.dataset.editing === "note.txt", null, { timeout: 15_000 }).then(() => true, () => false),
    "and when the host is back, the file is the live, editable one again",
  );
  check((await onDisk(long, (t) => t.includes("AWAY "))).includes("AWAY "), "what was typed while the host was away reached the file, though another was open by then");
  check(!(await leaving()), "and once it has, leaving asks nothing");

  // ---- a host whose machine is asleep -----------------------------------------
  // Its socket stays open, so the relay counts it as here; it answers
  // nothing. Someone arriving saw an empty, working session.
  process.kill(agent.pid, "SIGSTOP");
  const sam = await browser.newPage();
  await sam.goto(`${GUEST}/j/${link.session}#k=${link.key}`);
  await sam.fill("#name", "sam");
  await sam.click("#join button[type=submit]");
  const asleep = await sam.locator("#status", { hasText: "waiting for the host" }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
  const button = await sam.locator("#new-terminal").isDisabled();
  check(asleep && button, "a host whose machine is asleep is waited for, not shown as an empty session", `status ${JSON.stringify(await sam.locator("#status").textContent())}, New terminal disabled ${button}`);
  process.kill(agent.pid, "SIGCONT");
  check(
    await sam.locator("#status", { hasText: /^connected$/ }).waitFor({ timeout: 15_000 }).then(() => true, () => false),
    "and once it answers, the session is there",
  );
  await sam.close();

  // ---- the relay restarting -------------------------------------------------
  // The agent is held back, as it is when the guests' browsers notice first:
  // until it reconnects, the new relay has never heard of the session.
  agentHop.cut();
  procs.kill(relay);
  await sleep(300);
  relay = await startRelay();
  await sleep(3000);
  agentHop.restore();
  const backAfterRestart = await until(async () => {
    if (await ana.locator(".gate").count()) return `gave up: ${await ana.locator(".gate h1").textContent()}`;
    return (await ana.locator("#status").textContent()) === "connected" && (await ana.locator("#away").isHidden()) ? "in" : null;
  }, 40_000, 250);
  check(backAfterRestart === "in", "a guest outlasts a relay restart that the host's agent is slow to notice", String(backAfterRestart));
  await ana.locator(".term.shown .xterm").first().click();
  await ana.keyboard.type("echo restarted-$((40+2))\r");
  check(await until(async () => (await screen(ana)).includes("restarted-42"), 10_000), "and their terminal works afterwards");
  // The restarted relay lost the copy of the folder. The agent offers it
  // again — it used to go on claiming one was kept until a file changed — so
  // a host who drops now still leaves the files readable.
  await sleep(7000);
  agentHop.cut();
  const copyAgain = await until(async () => {
    const t = await ana.locator("#away").textContent();
    return /saved copy/.test(t) ? t : /No copy/.test(t) ? `none: ${t}` : null;
  }, 15_000);
  check(/saved copy/.test(String(copyAgain)) && !/^none/.test(String(copyAgain)), "after a relay restart the folder's copy is kept again", String(copyAgain));
  agentHop.restore();
  await ana.locator("#away[hidden]").waitFor({ state: "attached", timeout: 30_000 });

  // ---- an open file deleted on the host -------------------------------------
  // It stayed editable, and everything typed into it went nowhere.
  await writeFile(join(workdir, "doomed.txt"), "soon gone\n");
  await until(async () => (await ana.locator('.tree-row[data-path="doomed.txt"]').count()) > 0, 10_000);
  await open(ana, "doomed.txt");
  await ana.locator("#viewer .view-line").first().click();
  await ana.keyboard.type("kept ");
  await rm(join(workdir, "doomed.txt"));
  const stranded = await until(async () => {
    const t = await ana.locator("#viewer-title").textContent();
    return /not saved, read-only/.test(t) ? t : null;
  }, 10_000);
  check(stranded, "an open file deleted on the host says it can no longer be saved", JSON.stringify(await ana.locator("#viewer-title").textContent()));
  check((await editorText(ana)).includes("kept"), "and what was typed into it is still on screen to copy", JSON.stringify(await editorText(ana)));
  await ana.locator("#viewer .view-line").first().click();
  await ana.keyboard.type("more");
  await sleep(300);
  check(!(await editorText(ana)).includes("more"), "and it takes no more typing");

  // ---- Back out of the back/forward cache -----------------------------------
  // Playwright turns the cache off; this browser has it on, as people do.
  const cached = await chromium.launch({ channel: "chromium", ignoreDefaultArgs: ["--disable-back-forward-cache"] });
  browsers.push(cached);
  const dan = await guestPage(cached, link, "dan");
  await open(dan, "long.txt");
  await settleMidway(dan);
  const danAt = await where(dan);
  let restored = false;
  for (let attempt = 0; attempt < 2 && !restored; attempt++) {
    await dan.goto(`${GUEST}/`);
    await sleep(800);
    // A page out of the cache fires no load event.
    await dan.goBack({ waitUntil: "commit" });
    await sleep(500);
    restored = (await dan.evaluate(() => window.__restored).catch(() => 0)) > 0;
    if (!restored) {
      const why = await dan.evaluate(() => JSON.stringify(performance.getEntriesByType("navigation")[0]?.notRestoredReasons ?? null)).catch((e) => e.message);
      console.log(`  note: Back was not served from the cache: ${why}`);
      // A fresh load, not the cached page: put it back as it was and retry.
      if (!(await dan.locator("#name").count())) break;
      await dan.fill("#name", "dan");
      await dan.click("#join button[type=submit]");
      await dan.locator(".term.shown .xterm").first().waitFor({ timeout: 20_000 });
      await open(dan, "long.txt");
      await settleMidway(dan);
      // Where dan is now, for the comparison after the next Back.
      Object.assign(danAt, await where(dan));
    }
  }
  if (check(restored, "Back returns the session page from the cache")) {
    await dan.locator("#status", { hasText: /^connected$/ }).waitFor({ timeout: 20_000 }).catch(() => {});
    check(await dan.waitForFunction(() => document.getElementById("viewer")?.dataset.editing === "long.txt", null, { timeout: 15_000 }).then(() => true, () => false), "and it is live: the file is open for editing again");
    const danBack = await where(dan);
    check(danBack?.top === danAt.top && danBack?.cursor === danAt.cursor, "at the same place in it", `${JSON.stringify(danAt)} → ${JSON.stringify(danBack)}`);
    await focusEditor(dan);
    await dan.keyboard.type("CACHED ");
    check((await onDisk(long, (t) => t.includes("CACHED "))).includes("CACHED "), "and typing reaches the file");
    await dan.locator(".term.shown .xterm").first().click();
    await dan.keyboard.type("echo cached-$((50+5))\r");
    check(await until(async () => (await screen(dan)).includes("cached-55"), 10_000), "and the terminal answers");
    // Someone is "…" between arriving and saying who they are, so this waits
    // for the roster to settle rather than reading one moment of it.
    const roster = await until(async () => {
      const t = await ana.locator("#people").textContent();
      return /dan/.test(t) && !t.includes("…") ? t : null;
    }, 10_000);
    check(roster, "and nobody's roster gained a nameless guest", JSON.stringify(await ana.locator("#people").textContent()));
  }

  // ---- the host's keys -------------------------------------------------------
  // The agent as a person runs it, in a terminal with its panel, its keys
  // pressed. Every other check here runs it with no panel, and so never
  // pressed one.
  const panelDir = await mkdtemp(join(tmpdir(), "ajar-guest-panel-"));
  const roFile = join(panelDir, "ro.txt");
  await writeFile(roFile, "start\n");
  const panel = startAgentInPanel(procs, [panelDir, "--relay", RELAY, "--name", "panelhost"]);
  const panelLink = await linkOf(panel, 20_000);
  const lag = laggyProxy(LAG_PORT, PORT, 250);
  await lag.listen();
  const pat = await browser.newPage();
  pat.errors = [];
  pat.on("pageerror", (e) => pat.errors.push(e.message));
  await pat.goto(`http://127.0.0.1:${LAG_PORT}/j/${panelLink.session}#k=${panelLink.key}`);
  await pat.fill("#name", "pat");
  await pat.click("#join button[type=submit]");
  await pat.locator(".term.shown .xterm").first().waitFor({ timeout: 30_000 }).catch(async (e) => {
    const seen = await pat.evaluate(() => ({
      status: document.getElementById("status")?.textContent,
      gate: document.querySelector(".gate")?.textContent?.trim().slice(0, 200),
      tabs: document.getElementById("tabs")?.textContent,
    }));
    throw new Error(`pat, a quarter-second away, never got a terminal: ${JSON.stringify({ ...seen, errors: pat.errors })}\n${e.message}`);
  });
  await open(pat, "ro.txt");
  await pat.locator("#viewer .view-line").first().click();
  await pat.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
  // Read-only on while pat is typing, a quarter of a second away: some of it
  // reaches the host after the switch and is refused there.
  const typing = pat.keyboard.type("abcdefghijklmnop", { delay: 40 });
  await sleep(300);
  panel.press("l");
  await typing;
  await pat.locator("#readonly:not([hidden])").waitFor({ timeout: 10_000 });
  await sleep(1500);
  panel.press("l");
  await pat.locator("#readonly[hidden]").waitFor({ state: "attached", timeout: 10_000 });
  await pat.waitForFunction(() => document.getElementById("viewer")?.dataset.editing === "ro.txt", null, { timeout: 15_000 });
  await sleep(600);
  await pat.locator("#viewer .view-line").first().click();
  await pat.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
  await pat.keyboard.type(" AFTER");
  const disk = await onDisk(roFile, (t) => t.includes("AFTER"), 10_000);
  const shown = await until(async () => {
    const t = await editorText(pat);
    return t.trimEnd() === disk.trimEnd() ? t : null;
  }, 8000);
  check(disk.includes("AFTER") && shown, "read-only switched on mid-typing and off again: later typing reaches the file, and the page agrees with it", `disk ${JSON.stringify(disk)}, page ${JSON.stringify(await editorText(pat))}`);

  // And while it is on, the host drops a guest's keystrokes itself — the
  // page not sending them is only manners.
  const wire = new Guest(`ws://127.0.0.1:${PORT}/ws`, panelLink.session, "wire", panelLink.key);
  await wire.connect();
  await wire.waitUntil((g) => g.ptys.size >= 1, "the terminal pat has");
  const [wirePty] = [...wire.ptys.keys()];
  await wire.ready(wirePty);
  panel.press("l");
  await wire.waitUntil((g) => g.ptyMessages.some((m) => m.t === "read_only" && m.read_only === true), "the read-only notice");
  wire.type(wirePty, "echo RO-$((6*7))\r");
  await sleep(1500);
  check(!(wire.ptys.get(wirePty) ?? "").includes("RO-42"), "with the host's [l] on, a guest's keystrokes are dropped at the host");
  wire.close();
  await pat.close();
  lag.close();
  panel.press("l");

  // Locked, then the relay restarts — as it does at every deploy. The new
  // relay has never heard of anyone; the agent vouches for those it let in,
  // and the lock keeps out everyone else.
  const quinn = await browser.newPage();
  quinn.errors = [];
  quinn.on("pageerror", (e) => quinn.errors.push(e.message));
  await quinn.goto(`${RELAY}/j/${panelLink.session}#k=${panelLink.key}`);
  await quinn.fill("#name", "quinn");
  await quinn.click("#join button[type=submit]");
  await quinn.locator(".term.shown .xterm").first().waitFor({ timeout: 30_000 });
  await until(async () => /quinn/.test(panel.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")), 8000);
  panel.press("x");
  await quinn.locator("#locked:not([hidden])").waitFor({ timeout: 10_000 });
  check(
    await quinn.locator(".toast", { hasText: "locked this session" }).waitFor({ timeout: 5000 }).then(() => true, () => false),
    "locking is said in words, not only a badge",
  );
  procs.kill(relay);
  await sleep(300);
  relay = await startRelay();
  const quinnBack = await until(async () => {
    if (await quinn.locator(".gate").count()) return `turned away: ${await quinn.locator(".gate h1").textContent()}`;
    return (await quinn.locator("#status").textContent()) === "connected" && (await quinn.locator("#locked").isVisible()) ? "in" : null;
  }, 40_000, 250);
  check(quinnBack === "in", "a locked session takes its guests back after the relay restarts", String(quinnBack));
  const rex = await browser.newPage();
  await rex.goto(`${RELAY}/j/${panelLink.session}#k=${panelLink.key}`);
  await rex.fill("#name", "rex");
  await rex.click("#join button[type=submit]");
  check(
    await rex.locator(".gate h1", { hasText: "This session is locked" }).waitFor({ timeout: 15_000 }).then(() => true, () => false),
    "and still turns away someone new",
  );
  await rex.close();

  // [k], quinn's number, Enter: the host's kick, pressed as the host would.
  // The number is the one the panel shows beside quinn; it is read from the
  // page, because the panel draws only what changed and its output cannot be
  // read back as rows.
  const number = await quinn.locator("#people .person.me").getAttribute("data-id");
  if (check(number, "quinn has a number to be kicked by", String(number))) {
    panel.press("k");
    await sleep(200);
    for (const digit of number) panel.press(digit);
    panel.press("\r");
    check(
      await quinn.locator(".gate h1", { hasText: "You were removed from this session" }).waitFor({ timeout: 10_000 }).then(() => true, () => false),
      "a guest the host kicks is told so",
    );
    await quinn.reload();
    if (await quinn.locator("#name").count()) {
      await quinn.fill("#name", "quinn");
      await quinn.click("#join button[type=submit]");
    }
    check(
      await quinn.locator(".gate h1", { hasText: "This session is locked" }).waitFor({ timeout: 15_000 }).then(() => true, () => false),
      "and does not get back into the locked session by reloading",
    );
  }
  await quinn.close();
  panel.press("q");
  await rm(panelDir, { recursive: true, force: true });

  for (const [who, page] of [["ana", ana], ["dan", dan], ["pat", pat], ["quinn", quinn]]) {
    check(page.errors.length === 0, `no page errors (${who})`, page.errors.join(" | "));
  }

  for (const b of browsers) await b.close();
  guestHop.close();
  agentHop.close();
  finish(procs, "the guest's page holds up through blips, Back, restarts and the host away");
}

main()
  .catch(async (e) => {
    fail(e.stack ?? String(e));
    for (const b of browsers) await b.close().catch(() => {});
    procs.killAll();
    process.exit(1);
  })
  .finally(() => {
    if (workdir) rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

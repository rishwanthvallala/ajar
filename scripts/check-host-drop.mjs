#!/usr/bin/env node
// The session client, in a real browser, across a host's blip.
//
// smoke-hostdrop proves the agent and the protocol recover from the host
// dropping inside its grace period, using a Node guest that does what the
// browser is supposed to do. This proves the browser does it: the shipped
// client, built, served by a real relay, typing into Monaco while the host is
// away and checking what reaches the file.
//
// Needs `npm run build:ajar` first; it drives web/dist, not the dev server.
//
//   node scripts/check-host-drop.mjs

import { connect, createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { fail, finish, linkOf, ok, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const { chromium } = createRequire(new URL("../web/package.json", import.meta.url))("playwright");

const PORT = 8827;
const PROXY_PORT = 8828;
const HTTP = `http://127.0.0.1:${PORT}`;

const procs = new Procs();
let workdir;
let browser;

/** The same cuttable hop as smoke-hostdrop: only the agent goes through it. */
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

async function onDisk(file, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await readFile(file, "utf8");
    if (text.includes(needle)) return text;
    await sleep(100);
  }
  return text;
}

async function main() {
  if (!existsSync("web/dist/index.html")) {
    throw new Error("web/dist is missing — run `npm run build:ajar` first");
  }
  workdir = await mkdtemp(join(tmpdir(), "ajar-hostdrop-ui-"));
  const note = join(workdir, "note.txt");
  await writeFile(note, "one two three\n");

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`, "--web", "web/dist"], "relay");
  await waitForHealth(HTTP);
  const proxy = cuttableProxy(PROXY_PORT, PORT);
  await proxy.listen();
  const agent = procs.start(
    "target/debug/ajar",
    [workdir, "--relay", `http://127.0.0.1:${PROXY_PORT}`, "--name", "hosty"],
    "agent",
  );
  const { session, key } = await linkOf(agent);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${HTTP}/j/${session}#k=${key}`);
  await page.fill("#name", "ana");
  await page.click("#join button[type=submit]");
  // Nobody has opened a terminal in this session, so the guest gets one
  // without asking — arriving to "No terminals yet" was a click before
  // anything worked.
  await page.locator(".term .xterm").first().waitFor({ timeout: 20_000 });
  ok("a guest arriving to no terminals is given one");
  await page.locator('.tree-row[data-path="note.txt"]').click();
  // Editable means the document is bound, not merely that text is showing.
  const lines = page.locator(".monaco-editor .view-lines");
  await lines.filter({ hasText: "one two three" }).waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    () => !document.querySelector(".monaco-editor")?.classList.contains("read-only"),
    null,
    { timeout: 10_000 },
  ).catch(() => {});
  ok("the browser has note.txt open for editing");

  const typeAtStart = async (text) => {
    await lines.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type(text);
  };

  // ---- the gap ------------------------------------------------------------
  proxy.cut();
  await page.locator("#away:not([hidden])").waitFor({ timeout: 10_000 });
  ok("the page says the host went away");
  await typeAtStart("GAP ");
  await sleep(1500);
  proxy.restore();
  await page.locator("#away[hidden]").waitFor({ state: "attached", timeout: 30_000 });
  ok("the page says the host is back");

  // ---- what reached the file ----------------------------------------------
  const gap = await onDisk(note, "GAP ", 6000);
  if (!gap.includes("GAP ")) fail(`what was typed during the gap never reached the file: ${JSON.stringify(gap)}`);
  else ok("what was typed during the gap reached the file");

  await typeAtStart("AFTER ");
  const after = await onDisk(note, "AFTER ", 6000);
  if (!after.includes("AFTER ")) fail(`typing after the host came back is stuck: ${JSON.stringify(after)}`);
  else ok("typing after the host came back reaches the file");

  // The host's return re-sends the read-only state, which is what triggers
  // the first terminal. It must not open a second.
  const terminals = await page.locator(".term").count();
  if (terminals !== 1) fail(`the guest has ${terminals} terminals after the host came back, not 1`);
  else ok("and only one, even after the host came back");

  if (errors.length) fail(`the page threw: ${errors.join(" | ")}`);
  else ok("no page errors");

  await browser.close();
  proxy.close();
  finish(procs, "the browser hands back what was typed while the host was away");
}

main()
  .catch(async (e) => {
    fail(e.stack ?? String(e));
    await browser?.close().catch(() => {});
    procs.killAll();
    process.exit(1);
  })
  .finally(() => {
    if (workdir) rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

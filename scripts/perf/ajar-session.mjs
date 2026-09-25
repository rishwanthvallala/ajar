#!/usr/bin/env node
// One ajar session, measured as the people in it feel it: a host starting the
// agent, a guest opening the link in a fresh browser, typing, running
// something, and a burst of output.
//
//   node scripts/perf/ajar-session.mjs
//   AGENT=target/release/ajar node scripts/perf/ajar-session.mjs   # a local build
//
// AGENT defaults to the `ajar` on PATH — the installed release, which is what
// hosts run. RELAY points it somewhere other than the agent's default, the
// production relay. KEYS sets how many keystrokes the echo is measured over.
// Costs one session against the relay's 20 a minute per address; nothing
// against the pad.
//
// Echo is from a key press to the character on screen, so it includes the
// browser's frame: twice the TCP connect time from network.sh is the floor.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, ms, record, stats } from "./common.mjs";

const AGENT = process.env.AGENT ?? "ajar";
const KEYS = Number(process.env.KEYS ?? 60);
const out = { harness: "ajar-session", agent: AGENT };

// A small folder, so the tree and scan are not what is being timed.
const project = mkdtempSync(join(tmpdir(), "ajar-perf-"));
mkdirSync(join(project, "src"));
for (let i = 0; i < 12; i++) writeFileSync(join(project, "src", `file${i}.txt`), `line ${i}\n`.repeat(20));
writeFileSync(join(project, "README.md"), "# perf\n");

const args = [project, "--name", "host"];
if (process.env.RELAY) args.push("--relay", process.env.RELAY);
const started = performance.now();
const agent = spawn(AGENT, args, { stdio: ["ignore", "pipe", "pipe"] });
let log = "";
agent.stdout.on("data", (d) => (log += d));
agent.stderr.on("data", (d) => (log += d));

const browser = await chromium.launch();
try {
  const link = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the agent printed no link:\n${log}`)), 30_000);
    const poll = setInterval(() => {
      const m = log.match(/https?:\/\/\S+\/j\/[a-z0-9-]+#k=[A-Za-z0-9_-]+/i);
      if (m) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(m[0]);
      }
    }, 10);
  });
  out.host_start_to_link_ms = ms(started);

  const context = await browser.newContext(); // an empty cache: a first visit
  let bytes = 0;
  let requests = 0;
  context.on("requestfinished", async (r) => {
    requests++;
    bytes += (await r.sizes().catch(() => ({ responseBodySize: 0 }))).responseBodySize;
  });
  const page = await context.newPage();

  const opened = performance.now();
  await page.goto(link, { waitUntil: "commit" });
  await page.locator("#name").waitFor();
  out.guest_link_to_name_form_ms = ms(opened);
  await page.fill("#name", "guest");
  const joined = performance.now();
  await page.click("#join button[type=submit]");
  await page.locator(".tree-row").first().waitFor({ timeout: 30_000 });
  out.guest_join_to_tree_ms = ms(joined);

  // A current client opens a first terminal by itself; an older one needs the
  // button. Either way the clock runs from the join.
  const auto = await page.locator(".term .xterm").first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
  if (!auto) await page.getByRole("button", { name: "New terminal" }).first().click();
  out.guest_terminal_opened_by = auto ? "page" : "click";
  await page.waitForFunction(
    () => /[$#%>][\s ]*$/m.test(document.querySelector(".xterm-rows")?.innerText ?? ""),
    null, { timeout: 20_000, polling: "raf" });
  out.guest_join_to_prompt_ms = ms(joined);
  const firstLines = (await page.locator(".xterm-rows").first().innerText()).split("\n").slice(0, 6).join("\n");
  out.guest_shell_starts_with_errors = /permission denied|no such file/i.test(firstLines);
  out.guest_first_visit_requests = requests;
  out.guest_first_visit_mb = +(bytes / 1e6).toFixed(2);

  // Echo: one key at a steady human pace, until it is drawn. Each line starts
  // with `#`, which no prompt contains: starting with a letter, the first key
  // "arrived" the instant it was pressed because the prompt already had one.
  await page.locator(".xterm-helper-textarea").focus();
  const echo = [];
  let typed = "";
  for (let i = 0; i < KEYS; i++) {
    if (typed.length >= 30) {
      await page.keyboard.press("Control+u");
      typed = "";
      await page.waitForTimeout(300);
    }
    typed += typed ? "abcdefghijklmnopqrstuvwxyz"[i % 26] : "#";
    const want = typed;
    const t = performance.now();
    await page.keyboard.type(want.at(-1));
    await page.waitForFunction((w) => document.querySelector(".xterm-rows").innerText.includes(w), want,
      { timeout: 10_000, polling: "raf" });
    echo.push(performance.now() - t);
    await page.waitForTimeout(120);
  }
  await page.keyboard.press("Control+u");
  out.guest_echo_ms = stats(echo);

  // A short command, from Enter to its output.
  const command = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(300);
    const tag = `perf${i}x${Math.floor(Math.random() * 1e6)}`;
    await page.keyboard.type(`echo ${tag}-ok`);
    await page.waitForTimeout(150);
    const t = performance.now();
    await page.keyboard.press("Enter");
    await page.waitForFunction((t) => document.querySelector(".xterm-rows").innerText
      .split("\n").some((l) => l.trim() === `${t}-ok`), tag, { timeout: 10_000, polling: "raf" });
    command.push(performance.now() - t);
  }
  out.guest_command_ms = stats(command);

  // A burst: 100 000 lines, until the last is drawn.
  await page.keyboard.type("clear\n");
  await page.waitForTimeout(500);
  const burst = performance.now();
  await page.keyboard.type("seq 1 100000; echo seq-done\n");
  await page.waitForFunction(() => /^seq-done$/m.test(document.querySelector(".xterm-rows").innerText),
    null, { timeout: 120_000, polling: "raf" });
  out.guest_100k_lines_ms = ms(burst);
} catch (e) {
  out.error = String(e.message).split("\n")[0];
} finally {
  await browser.close();
  agent.kill("SIGTERM");
  rmSync(project, { recursive: true, force: true });
}
record(out);

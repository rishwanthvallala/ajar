#!/usr/bin/env node
// A guest's terminal, used the way a person uses a terminal: real key presses
// into the browser client, a real bash on the host at the far end of the
// relay, judged by what is on the guest's screen.
//
// What is under test is the path, not bash: every key has to leave xterm as
// the bytes a terminal sends, cross the relay sealed, reach the pty, and come
// back drawn. So the host's shell is pinned — bash, a known prompt, a known
// inputrc, UTF-8 — rather than whatever the machine's own startup files make
// of it; the same keys on another shell are that shell's business.
//
//   npm run build:ajar && cargo build && node scripts/check-terminal.mjs
//   AJAR_RELAY=https://ajar.rishwanth.dev AGENT=~/.local/bin/ajar node scripts/check-terminal.mjs
//
// Locally it starts a relay and the debug agent. With AJAR_RELAY it uses that
// relay and its web client, and AGENT picks the agent — an installed release
// is what hosts actually run.

import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { fail, finish, linkOf, ok, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const { chromium } = createRequire(new URL("../web/package.json", import.meta.url))("playwright");

const PORT = 8835;
const LIVE = process.env.AJAR_RELAY ?? null;
const HTTP = LIVE ?? `http://127.0.0.1:${PORT}`;
const AGENT = process.env.AGENT ?? "target/debug/ajar";
const PROMPT = "ajar-check$ ";

const procs = new Procs();
let workdir;
let shelldir;
let browser;

async function main() {
  if (!LIVE && !existsSync("web/dist/index.html")) {
    throw new Error("web/dist is missing — run `npm run build:ajar` first");
  }
  workdir = await mkdtemp(join(tmpdir(), "ajar-terminal-"));
  await writeFile(join(workdir, "notes.txt"), "one\ntwo\nthree\n");

  // The shell, pinned. Kept out of the shared folder so it is not part of
  // what the guest sees.
  shelldir = await mkdtemp(join(tmpdir(), "ajar-terminal-shell-"));
  await writeFile(
    join(shelldir, "inputrc"),
    [
      // What Ubuntu's /etc/inputrc binds and macOS's bash 3.2 does not.
      '"\\e[1;5C": forward-word',
      '"\\e[1;5D": backward-word',
      '"\\e[H": beginning-of-line',
      '"\\e[F": end-of-line',
      '"\\eOH": beginning-of-line',
      '"\\eOF": end-of-line',
      '"\\e[3~": delete-char',
      // UTF-8 typed as UTF-8, not as meta keys — bash 3.2 needs telling.
      "set input-meta on",
      "set output-meta on",
      "set convert-meta off",
      "",
    ].join("\n"),
  );
  const shell = join(shelldir, "shell");
  await writeFile(
    shell,
    [
      "#!/bin/bash",
      `export INPUTRC='${join(shelldir, "inputrc")}' PS1='${PROMPT}' HISTFILE=/dev/null`,
      'if [ "$(uname)" = Darwin ]; then export LANG=en_US.UTF-8; else export LANG=C.UTF-8; fi',
      "exec /bin/bash --noprofile --norc -i",
      "",
    ].join("\n"),
  );
  await chmod(shell, 0o755);

  if (!LIVE) {
    procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`, "--web", "web/dist"], "relay");
    await waitForHealth(HTTP);
  }
  const agent = procs.start(AGENT, [workdir, "--relay", HTTP, "--name", "host"], "agent", {
    env: { ...process.env, SHELL: shell },
  });
  const { session, key } = await linkOf(agent, 30_000);

  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${HTTP}/j/${session}#k=${key}`);
  await page.fill("#name", "guest");
  await page.click("#join button[type=submit]");
  await page.locator(".term .xterm").first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    (p) => (document.querySelector(".xterm-rows")?.innerText ?? "").replace(/ /g, " ").includes(p.trim()),
    PROMPT,
    { timeout: 30_000 },
  );
  await page.locator(".xterm-helper-textarea").first().focus();

  const rows = async () => (await page.evaluate(() => document.querySelector(".xterm-rows")?.innerText ?? ""))
    .split("\n").map((l) => l.replace(/ /g, " ").replace(/\s+$/, ""));
  /** What is typed after the last prompt on screen. */
  const typed = async () => {
    const line = (await rows()).filter((l) => l.startsWith(PROMPT.trim())).at(-1);
    return line === undefined ? null : line.slice(PROMPT.trim().length).replace(/^ /, "");
  };
  const printed = async (text) => (await rows()).some((l) => l.trim() === text);
  const appears = (text, ms = 10_000) => page.waitForFunction(
    (t) => (document.querySelector(".xterm-rows")?.innerText ?? "").replace(/ /g, " ").split("\n").some((l) => l.trim() === t),
    text, { timeout: ms }).then(() => true, () => false);
  const settle = (ms = 300) => sleep(ms);
  const type = (text) => page.keyboard.type(text, { delay: 15 });
  const press = (k) => page.keyboard.press(k);
  const expect = (m, pass, detail) => (pass ? ok(m) : fail(detail ? `${m} — ${detail}` : m));
  async function run(command, output) {
    await type(command);
    await press("Enter");
    if (output) await appears(output);
    await settle();
  }
  async function keys(name, setup, sequence, want) {
    await type(setup);
    for (const k of sequence) await (k.startsWith("text:") ? type(k.slice(5)) : press(k));
    await settle();
    const got = await typed();
    expect(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
    await press("Control+c");
    await settle();
  }

  await run("echo ready", "ready");
  expect("a typed command runs", await printed("ready"));

  // ---- history ----
  await run("echo first", "first");
  await run("echo second", "second");
  await press("ArrowUp"); await settle();
  expect("↑ recalls the last command", (await typed()) === "echo second", await typed());
  await press("ArrowUp"); await settle();
  expect("↑↑ the one before", (await typed()) === "echo first", await typed());
  await press("ArrowDown"); await press("ArrowDown"); await settle();
  expect("↓ past the newest is an empty line again", (await typed()) === "", JSON.stringify(await typed()));
  await press("ArrowUp"); await press("ArrowLeft"); await press("ArrowLeft"); await type("X");
  await press("Enter");
  expect("a recalled line edits and runs", await appears("secoXnd"));

  // ---- editing keys ----
  await keys("Home", "echo abc", ["Home", "text:X"], "Xecho abc");
  await keys("End", "echo abc", ["ArrowLeft", "ArrowLeft", "End", "text:Z"], "echo abcZ");
  await keys("Delete", "echo abc", ["ArrowLeft", "ArrowLeft", "Delete"], "echo ac");
  await keys("ctrl-a", "echo abc", ["Control+a", "text:X"], "Xecho abc");
  await keys("ctrl-e", "echo abc", ["Home", "Control+e", "text:Z"], "echo abcZ");
  await keys("ctrl-u", "echo abc", ["Control+u"], "");
  await keys("ctrl-k", "echo abc", ["ArrowLeft", "ArrowLeft", "ArrowLeft", "Control+k"], "echo");
  await keys("ctrl-w", "echo abc def", ["Control+w"], "echo abc");
  await keys("ctrl-←", "echo abc def", ["Control+ArrowLeft", "text:X"], "echo abc Xdef");

  // ---- completion ----
  await keys("Tab completes a file", "cat no", ["Tab"], "cat notes.txt");
  await type("pytho"); await press("Tab"); await settle(600);
  expect("Tab completes a command", /^python/.test((await typed()) ?? ""), await typed());
  await press("Control+c"); await settle();

  // ---- search and clearing ----
  await run("echo needle-in-history", "needle-in-history");
  await run("echo something-else", "something-else");
  await press("Control+r"); await type("needle"); await settle(500);
  const searching = (await rows()).filter(Boolean).at(-1) ?? "";
  expect("ctrl-r finds a past command", /reverse-i-search.*needle-in-history/.test(searching), searching);
  await press("Control+c"); await settle();
  await run("echo before-clear", "before-clear");
  await press("Control+l"); await settle(500);
  expect("ctrl-l clears the screen", !(await printed("before-clear")));
  await run("echo before-clear-again", "before-clear-again");
  await run("clear"); await settle(300);
  expect("`clear` clears the screen", !(await printed("before-clear-again")));

  // ---- ctrl-c ----
  await run("sleep 30"); await press("Control+c"); await settle(800);
  expect("ctrl-c stops a running command", (await typed()) === "", (await rows()).filter(Boolean).slice(-2).join(" | "));
  await run("echo after-interrupt", "after-interrupt");
  expect("…and the shell carries on", await printed("after-interrupt"));

  // ---- paste ----
  // bash 5 holds a multi-line paste until Enter; bash 3.2 runs it at once.
  // Either is a terminal doing its job; both lines running is the point.
  await page.evaluate((t) => {
    const area = document.querySelector(".xterm-helper-textarea");
    const data = new DataTransfer();
    data.setData("text/plain", t);
    area.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, "echo paste-one\necho paste-two\n");
  await settle(800);
  if (!(await printed("paste-two"))) await press("Enter");
  expect("a two-line paste runs both lines", (await appears("paste-one")) && (await appears("paste-two")),
    (await rows()).filter(Boolean).slice(-4).join(" | "));

  // ---- programs that read input, and unicode ----
  await run("python3 -q"); await settle(1500);
  await type("6*7"); await press("Enter");
  expect("the python REPL answers", await appears("42"), (await rows()).filter(Boolean).slice(-3).join(" | "));
  await type("exit()"); await press("Enter"); await settle(1000);
  expect("…and exits to the prompt", (await typed()) === "", (await rows()).filter(Boolean).slice(-2).join(" | "));
  await run("echo héllo ✓ 日本", "héllo ✓ 日本");
  expect("unicode goes there and back", await printed("héllo ✓ 日本"));

  // ---- programs that take over the screen ----
  for (const [command, quit, drew] of [
    ["less notes.txt", ["q"], /three/],
    ["vi notes.txt", ["Escape", "text::q!", "Enter"], /three/],
    ["nano notes.txt", ["Control+x"], /three/],
    ["top", ["q"], /load av/i],
  ]) {
    await run(command); await settle(1500);
    const screen = (await rows()).join("\n");
    for (const k of quit) await (k.startsWith("text:") ? type(k.slice(5)) : press(k));
    await settle(1000);
    const back = (await typed()) === "";
    expect(`${command.split(" ")[0]} draws the screen and quits`, drew.test(screen) && back,
      `drew=${drew.test(screen)} back=${back}: ${(await rows()).filter(Boolean).slice(-2).join(" | ")}`);
    if (!back) { await press("Control+c"); await settle(); }
  }

  expect("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  procs.killAll();
  await cleanUp();
  // Exits, so anything after it would never run.
  finish(procs, "a guest's terminal behaves like one");
}

async function cleanUp() {
  for (const dir of [workdir, shelldir]) if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
}

main().catch(async (e) => {
  fail(e.stack ?? String(e));
  await browser?.close().catch(() => {});
  procs.killAll();
  await cleanUp();
  process.exit(1);
});

#!/usr/bin/env node
// The ajar perf lab: one session, measured as the people in it feel it — a
// host starting `ajar`, a guest opening the link in a fresh browser, and then
// everything that crosses between the host's machine and the guest's page:
// keys and output in a terminal, a file changed on the host's disk reaching
// the page, typing in the page reaching the host's disk, two guests typing,
// files opened, and what the host does for a guest (search, upload, download).
//
//   node scripts/perf/ajar-lab.mjs <profile> [scenarios] [runs]
//
// Profiles are the two links of a session, each a set length (link.mjs):
//
//   near    this machine's loopback
//   office  32 ms each way on both, 50 Mbit/s — the maintainer's office to the relay, 19 November
//   abroad  the host 32 ms away, the guest 120 ms, 20 Mbit/s
//   live    production: this tree's agent through ajar.rishwanth.dev — a live check, once
//
// Scenarios, in the order a session meets them: start, join, open, terminal,
// disk, type, copy, pair, work, drop, return, agent — and big, a session of
// its own on a folder of five thousand files. Each prints a JSON line of its numbers.
//
// A real agent (AGENT, default target/release/ajar) in a terminal of its own,
// showing its panel as a host's does; a real relay (RELAY_BIN, default
// target/release/ajar-relay) serving the page's build (WEB_DIST, default
// web/dist); Chromium with an empty profile. With all three set to another
// tree's, that tree is measured — an older commit's, beside this one's, in
// one sitting: times taken on different days differ by more than most
// changes do. A time is taken where the
// thing happened and where it was seen — in the page, by an observer on the
// page's own document — and the two clocks are set against each other first.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { chromium, record, stats } from "./common.mjs";
import { link } from "./link.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PROFILES = {
  near: { host: 0, guest: 0, mbit: 0 },
  office: { host: 32, guest: 32, mbit: 50 },
  abroad: { host: 32, guest: 120, mbit: 20 },
  live: null,
};
const [profileName = "near", scenarioList = "", runsArg = "1"] = process.argv.slice(2);
if (!(profileName in PROFILES)) {
  console.error(`profiles: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(2);
}
const PROFILE = PROFILES[profileName];
const LIVE = profileName === "live";
const ALL = ["start", "join", "open", "terminal", "disk", "type", "copy", "pair", "work", "drop", "return", "agent", "big"];
/** What each profile is worth: big transfers only where the link is not what is measured, and little of production's. */
const DEFAULT = {
  near: ALL,
  office: ALL.filter((s) => s !== "start" && s !== "big"),
  abroad: ["join", "open", "terminal", "disk", "type", "copy", "pair", "return"],
  live: ["join", "open", "terminal", "disk", "type", "pair", "return"],
}[profileName];
const SCENARIOS = new Set(scenarioList ? scenarioList.split(",") : DEFAULT);
const RUNS = Number(runsArg);
const AGENT = process.env.AGENT ?? "target/release/ajar";
const RELAY_BIN = process.env.RELAY_BIN ?? "target/release/ajar-relay";
/** The page's build the relay serves: another tree's, to measure that tree's page with this lab. */
const WEB_DIST = process.env.WEB_DIST ?? "web/dist";
const SITE = "https://ajar.rishwanth.dev";
const PORT = { relay: 8872, host: 8873, guest: 8874 };

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x) => Math.round(x * 10) / 10;
const say = (m) => process.stderr.write(`    ${m}\n`);
const median = (xs) => stats(xs).p50;
/** With SAMPLES set, every sample behind a median or a tail, to see what its shape is. */
const samples = (name, xs) => {
  if (process.env.SAMPLES) say(`${name}: ${xs.map((x) => Math.round(x)).join(" ")}`);
  return xs;
};

// ------------------------------------------------------------------ the folder

/** A valid PNG of about `bytes`: noise, stored, so it is the size it says. */
function png(bytes) {
  const side = Math.ceil(Math.sqrt(bytes / 4));
  const raw = Buffer.alloc((side * 4 + 1) * side);
  for (let y = 0; y < side; y++) for (let x = 1; x <= side * 4; x++) raw[y * (side * 4 + 1) + x] = (x * 31 + y * 17) & 0xff;
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Bytes that do not compress and are the same every time. */
function noise(bytes, seed) {
  const out = Buffer.alloc(bytes);
  let s = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

const MAIN = "# MAINPY-FIRST\nimport sys\n\n\ndef double(x):\n    return x * 2\n\n\nprint(double(21))\n";
const SCRATCH = "SCRATCH-FIRST\n";

/** A project a few hundred files big: enough that the tree is one, small enough to make each run. */
function project(dir, { heavy }) {
  const file = (rel, content) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  file("main.py", MAIN);
  file("scratch.txt", SCRATCH);
  file("notes.md", "# NOTES-FIRST\n\nA few notes.\n");
  file(".gitignore", "node_modules\n*.log\n");
  file("big.txt", `BIGFILE-FIRST\n${"the quick brown fox jumps over the lazy dog, again and again\n".repeat(16_500)}`);
  file("pic.png", png(1_000_000));
  for (let i = 0; i < 40; i++) file(`src/mod${i}.py`, `def f${i}(x):\n    return x + ${i}\n`);
  for (let i = 0; i < 150; i++) file(`lib/pkg${i % 10}/part${i}.js`, `export const part${i} = ${i};\n`);
  for (let i = 0; i < 300; i++) file(`data/row${i}.txt`, `${"lorem ipsum dolor sit amet ".repeat(70)}\n${i % 10 === 0 ? "the needle is here\n" : ""}`);
  if (heavy) for (let i = 0; i < 4; i++) file(`blob/part${i}.bin`, noise(5_000_000, i + 1));
}

/** Five thousand files, for how long a host waits on a real project's scan. */
function bigProject(dir) {
  for (let d = 0; d < 100; d++) {
    mkdirSync(join(dir, `pkg${d}`), { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `pkg${d}`, `file${i}.ts`), `export const v${i} = ${d * 50 + i};\n`);
  }
}

// ------------------------------------------------------------------ the host

const children = new Set();
function run(cmd, argv, opts = {}) {
  const child = spawn(cmd, argv, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], ...opts });
  child.output = "";
  child.stdout.on("data", (d) => (child.output += d));
  child.stderr.on("data", (d) => (child.output += d));
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}
const stop = (child, signal = "SIGTERM") =>
  new Promise((done) => {
    if (!child || child.exitCode !== null) return done();
    child.once("exit", done);
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
  });

/** The link the agent printed, once it has: the session and its key. */
async function linkOf(agent, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const m = agent.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").match(/\/j\/([a-z0-9-]+)#k=([A-Za-z0-9_-]+)/i);
    if (m) return { session: m[1], key: m[2] };
    if (agent.exitCode !== null) break;
    await sleep(2);
  }
  throw new Error(`the agent printed no link:\n${agent.output.slice(-800)}`);
}

/** From the command to a link that works — the agent with no terminal prints it only once the relay has answered. */
async function startTime(dir, relay) {
  const t0 = now();
  const agent = run(AGENT, [dir, "--name", "host", ...(relay ? ["--relay", relay] : [])], { stdio: ["ignore", "pipe", "pipe"] });
  await linkOf(agent);
  const took = now() - t0;
  await stop(agent, "SIGINT");
  return took;
}

/** How much CPU a process has used, in seconds, and what it holds, in MB. */
function usage(pid) {
  const out = spawnSync("ps", ["-o", "time=,rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  const m = /(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(\d+)/.exec(out);
  if (!m) return null;
  return { cpu: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), rssMb: Number(m[4]) / 1024 };
}

// ------------------------------------------------------------------ the page

/** In the page from its first script: when a thing was seen, by the page's own clock. */
function recorder() {
  const now = () => performance.timeOrigin + performance.now();
  const armed = new Map();
  const lab = (window.__lab = {
    now,
    inputAt: 0,
    longTasks: 0,
    /** Note when something first holds: a selector matching, or not, text inside one, anything at all inside one, an image drawn. */
    arm(id, kind, a, b) {
      const holds = {
        sel: () => !!document.querySelector(a),
        nosel: () => !document.querySelector(a),
        text: () => {
          for (const el of document.querySelectorAll(a)) if (el.textContent.includes(b)) return true;
          return false;
        },
        filled: () => (document.querySelector(a)?.textContent ?? "").trim().length > 0,
        img: () => {
          const i = document.querySelector(a);
          return !!i && i.complete && i.naturalWidth > 0;
        },
      }[kind];
      const entry = { at: null };
      armed.set(id, entry);
      let poll = null;
      const check = () => {
        if (entry.at !== null || !holds()) return;
        entry.at = now();
        watch.disconnect();
        clearInterval(poll);
      };
      const watch = new MutationObserver(check);
      watch.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      // An image is drawn with no change to the document.
      if (kind === "img") poll = setInterval(check, 4);
      check();
    },
    seen: (id) => armed.get(id)?.at ?? null,
  });
  // When the person did the thing: the last key or click, as the page got it.
  for (const type of ["keydown", "click"]) addEventListener(type, () => (lab.inputAt = now()), true);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) lab.longTasks += e.duration;
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // No such observer: long tasks stay 0.
  }
}

let seq = 0;
/** How far the page's clock is ahead of this process's: the least of several asks, which waited least. */
async function clockOf(page) {
  let best = null;
  for (let i = 0; i < 12; i++) {
    const a = now();
    const theirs = await page.evaluate(() => window.__lab.now());
    const b = now();
    if (!best || b - a < best.rtt) best = { rtt: b - a, ahead: theirs - (a + b) / 2 };
  }
  return best.ahead;
}

/**
 * How long from `act` to the page seeing `[kind, a, b]`. `act` returns when it
 * happened by this process's clock, or nothing for "the page's last key or
 * click". The watch is in place before the act.
 */
async function timed(guest, watchFor, act, timeout = 30_000) {
  const { page } = guest;
  const id = `w${++seq}`;
  await page.evaluate(([id, kind, a, b]) => window.__lab.arm(id, kind, a, b), [id, ...watchFor]);
  const happened = await act();
  await page.waitForFunction((id) => window.__lab.seen(id) !== null, id, { timeout, polling: 25 });
  const [seen, input] = await page.evaluate((id) => [window.__lab.seen(id), window.__lab.inputAt], id);
  return typeof happened === "number" ? seen - guest.ahead - happened : seen - input;
}

/** The same, for a thing done in one page and seen in another. */
async function across(from, to, watchFor, act, timeout = 30_000) {
  const id = `w${++seq}`;
  await to.page.evaluate(([id, kind, a, b]) => window.__lab.arm(id, kind, a, b), [id, ...watchFor]);
  await act();
  const input = await from.page.evaluate(() => window.__lab.inputAt);
  await to.page.waitForFunction((id) => window.__lab.seen(id) !== null, id, { timeout, polling: 25 });
  const seen = await to.page.evaluate((id) => window.__lab.seen(id), id);
  return seen - to.ahead - (input - from.ahead);
}

const rowSel = (path) => `.tree-row[data-path="${path}"]`;
const TERM = ".term.shown .xterm-rows";
const LINES = "#viewer .view-lines";
const END = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

/** A guest in a browser that has never been here: the page loaded, the name given, the session joined. */
async function enter(browser, url, name, out, returning = null) {
  let guest;
  if (returning) {
    // The same browser, its cache as the first visit left it: what is fetched is counted where that visit's was.
    guest = { context: returning.context, does: returning.does };
  } else {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    if (LIVE) await context.addCookies([{ name: "ajar_check", value: "1", url: SITE }]);
    await context.addInitScript(recorder);
    guest = { context, bytes: 0, requests: 0 };
  }
  const { context } = guest;
  const page = (guest.page = await context.newPage());
  // What came over the wire, as the browser's network stack counts it:
  // headers and body as sent — compressed, if they were — and a request
  // answered from the browser's cache is no request at all. (Playwright's own
  // `requestfinished` counts those too, and gives them their headers' size.)
  const counted = returning ?? guest;
  const wire = await context.newCDPSession(page);
  await wire.send("Network.enable");
  wire.on("Network.loadingFinished", (e) => {
    if (e.encodedDataLength <= 0) return;
    counted.requests++;
    counted.bytes += e.encodedDataLength;
  });
  page.on("pageerror", (e) => say(`page error (${name}): ${e.message.slice(0, 200)}`));
  const opened = now();
  await page.goto(url, { waitUntil: "commit" });
  await page.locator("#name").waitFor();
  const form = now() - opened;
  guest.ahead = await clockOf(page);
  await page.fill("#name", name);
  // The terminal is there for the guest when its shell's prompt is: any
  // character at all in its rows.
  await page.evaluate(() => {
    window.__lab.arm("tree", "sel", ".tree-row");
    window.__lab.arm("prompt", "filled", ".term.shown .xterm-rows");
  });
  await page.click("#join button[type=submit]");
  await page.waitForFunction(() => window.__lab.seen("tree") !== null && window.__lab.seen("prompt") !== null, null, { timeout: 60_000 });
  const marks = await page.evaluate(() => ({ click: window.__lab.inputAt, tree: window.__lab.seen("tree"), prompt: window.__lab.seen("prompt") }));
  if (out) {
    out.form_ms = round(form);
    out.tree_ms = round(marks.tree - marks.click);
    out.terminal_ms = round(marks.prompt - marks.click);
    // And settled: with what the page then fetches by itself, for the file
    // somebody is about to open.
    await sleep(returning ? 1500 : 4000);
    if (returning) return guest;
    // What it took to get here, by the page's own account: everything it
    // asked for before it began fetching the editor unasked, which it marks.
    // (Counted from outside, some of that is in before anyone could look.)
    const arrived = await page.evaluate(() => {
      const unasked = performance.getEntriesByName("ajar-editor-warm")[0]?.startTime ?? Infinity;
      const fetched = [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")].filter((e) => e.transferSize > 0 && e.startTime < unasked);
      return { bytes: fetched.reduce((sum, e) => sum + e.transferSize, 0), requests: fetched.length };
    });
    out.bytes = arrived.bytes;
    out.requests = arrived.requests;
    out.bytes_settled = guest.bytes;
    out.long_tasks_ms = Math.round(await page.evaluate(() => window.__lab.longTasks));
    const cdp = await context.newCDPSession(page);
    await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
    const heap = (await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }))).metrics.find((m) => m.name === "JSHeapUsedSize");
    if (heap) out.heap_mb = round(heap.value / 1e6);
    await cdp.detach().catch(() => {});
  }
  return guest;
}

/** Every folder at the top of the list, closed. */
async function shut(guest) {
  for (const folder of ["blob", "data", "lib", "src"]) {
    const row = guest.page.locator(rowSel(folder));
    if ((await row.count()) && (await row.getAttribute("aria-expanded")) !== "false") await row.click();
  }
}

const shellKeys = (guest) => guest.page.locator(".term.shown .xterm-helper-textarea").focus();
async function openFile(guest, path) {
  await guest.page.locator(rowSel(path)).click();
  await guest.page.waitForFunction((p) => document.getElementById("viewer")?.dataset.editing === p, path, { timeout: 30_000 });
}

// ------------------------------------------------------------------ the scenarios

const scenarios = {
  /** Opening files: the first, which brings the editor; then a small one, a megabyte, and a picture. */
  async open({ guest }, out) {
    const { page } = guest;
    const before = guest.bytes;
    out.first_file_ms = round(await timed(guest, ["text", LINES, "MAINPY-FIRST"], () => page.locator(rowSel("main.py")).click(), 60_000));
    await sleep(800);
    out.first_file_bytes = guest.bytes - before;
    out.small_file_ms = round(await timed(guest, ["text", LINES, "NOTES-FIRST"], () => page.locator(rowSel("notes.md")).click()));
    await sleep(300);
    out.big_file_ms = round(await timed(guest, ["text", LINES, "BIGFILE-FIRST"], () => page.locator(rowSel("big.txt")).click(), 60_000));
    await sleep(300);
    if (guest.does) out.image_ms = round(await timed(guest, ["img", "#viewer .image-view img"], () => page.locator(rowSel("pic.png")).click(), 60_000));
  },

  /** A terminal: a key to its echo, a command to its output, and a hundred thousand lines. */
  async terminal({ guest }, out) {
    const { page } = guest;
    await shellKeys(guest);
    const echo = [];
    let typed = "";
    for (let i = 0; i < 40; i++) {
      if (typed.length >= 30) {
        await page.keyboard.press("Control+u");
        typed = "";
        await sleep(300);
      }
      // `#` first: no prompt has one, so the first key cannot have "arrived" already.
      typed += typed ? "abcdefghijklmnopqrstuvwxyz"[i % 26] : "#";
      const want = typed;
      echo.push(await timed(guest, ["text", TERM, want], () => page.keyboard.type(want.at(-1)), 15_000));
      await sleep(110);
    }
    await page.keyboard.press("Control+u");
    samples("echo", echo);
    out.echo_p50_ms = round(stats(echo).p50);
    out.echo_p95_ms = round(stats(echo).p95);

    const command = [];
    for (let i = 0; i < 5; i++) {
      await sleep(300);
      // The answer is not in what was typed: `$((…))` is worked out by the shell.
      await page.keyboard.type(`echo perf-$((${i} + 4200))`);
      await sleep(150);
      command.push(await timed(guest, ["text", TERM, `perf-${i + 4200}`], () => page.keyboard.press("Enter"), 15_000));
    }
    out.command_ms = round(median(command));

    await page.keyboard.type("clear\n");
    await sleep(500);
    await page.keyboard.type("seq 1 100000; echo done-$((41 + 1))");
    out.burst_100k_lines_ms = Math.round(await timed(guest, ["text", TERM, "done-42"], () => page.keyboard.press("Enter"), 180_000));
    await sleep(300);
    await page.keyboard.type("clear\n");
  },

  /** The host's disk to the guest's page: a file saved, made, deleted; a burst; and what a guest's own command made. */
  async disk({ guest, dir }, out) {
    const { page } = guest;
    const at = (rel) => join(dir, rel);
    await openFile(guest, "main.py");
    await sleep(600);
    // Between samples, a pause of no fixed length: the agent gathers changes
    // on a tick, and a steady beat would meet the same part of it each time.
    const pause = () => sleep(350 + Math.random() * 400);

    const saved = [];
    for (let i = 0; i < 12; i++) {
      await pause();
      const token = `saved${seq}x${i}z`;
      saved.push(await timed(guest, ["text", LINES, token], () => {
        const t = now();
        writeFileSync(at("main.py"), `${MAIN}# ${token}\n`);
        return t;
      }));
    }
    samples("save", saved);
    out.save_to_editor_p50_ms = round(stats(saved).p50);
    out.save_to_editor_p95_ms = round(stats(saved).p95);

    // As an editor that writes beside the file and renames over it.
    const renamed = [];
    for (let i = 0; i < 12; i++) {
      await pause();
      const token = `renamed${seq}x${i}z`;
      renamed.push(await timed(guest, ["text", LINES, token], () => {
        const t = now();
        writeFileSync(at(".main.py.tmp"), `${MAIN}# ${token}\n`);
        renameSync(at(".main.py.tmp"), at("main.py"));
        return t;
      }));
    }
    samples("atomic save", renamed);
    out.atomic_save_to_editor_p50_ms = round(stats(renamed).p50);
    out.atomic_save_to_editor_p95_ms = round(stats(renamed).p95);

    const made = [];
    const gone = [];
    for (let i = 0; i < 10; i++) {
      await pause();
      const name = `aa-new-${seq}-${i}.txt`;
      made.push(await timed(guest, ["sel", rowSel(name)], () => {
        const t = now();
        writeFileSync(at(name), "new\n");
        return t;
      }));
      await pause();
      gone.push(await timed(guest, ["nosel", rowSel(name)], () => {
        const t = now();
        unlinkSync(at(name));
        return t;
      }));
    }
    samples("new file", made);
    samples("delete", gone);
    out.new_file_to_tree_p50_ms = round(stats(made).p50);
    out.new_file_to_tree_p95_ms = round(stats(made).p95);
    out.delete_to_tree_p50_ms = round(stats(gone).p50);

    // Bursts, each ended by one more thing made — a folder, which the list
    // puts first, where it is drawn however long the list has grown: when
    // the page has that, it has what came before it.
    const burst = async (count, folder) => {
      await pause();
      const done = `00-${folder}-done`;
      const took = await timed(guest, ["sel", rowSel(done)], () => {
        const t = now();
        for (let i = 0; i < count; i++) {
          const d = at(join(folder, `p${Math.floor(i / 50)}`));
          if (i % 50 === 0) mkdirSync(d, { recursive: true });
          writeFileSync(join(d, `f${i}.txt`), "x\n");
        }
        mkdirSync(at(done));
        return t;
      }, 120_000);
      rmSync(at(folder), { recursive: true, force: true });
      rmSync(at(done), { recursive: true, force: true });
      await page.waitForFunction(([a, b]) => !document.querySelector(a) && !document.querySelector(b), [rowSel(folder), rowSel(done)], { timeout: 60_000 });
      await sleep(1200);
      return took;
    };
    out.burst_50_files_to_tree_ms = Math.round(await burst(50, "zz-burst50"));
    if (!LIVE) out.burst_3000_files_to_tree_ms = Math.round(await burst(3000, "zz-burst3k"));

    // What a guest's own command does to the folder, as the guest sees it.
    await sleep(800);
    await shellKeys(guest);
    const touched = [];
    for (let i = 0; i < 5; i++) {
      await pause();
      const name = `aa-sh-${seq}-${i}.txt`;
      await page.keyboard.type(`touch ${name}`);
      await sleep(150);
      touched.push(await timed(guest, ["sel", rowSel(name)], () => page.keyboard.press("Enter")));
    }
    out.shell_file_to_tree_ms = round(median(touched));
    const appended = [];
    for (let i = 0; i < 5; i++) {
      writeFileSync(at("main.py"), MAIN);
      await sleep(900);
      const token = `shell${seq}x${i}z`;
      await page.keyboard.type(`echo "# ${token}" >> main.py`);
      await sleep(150);
      appended.push(await timed(guest, ["text", LINES, token], () => page.keyboard.press("Enter")));
    }
    out.shell_edit_to_editor_ms = round(median(appended));
    await page.keyboard.type("rm -f aa-sh-*.txt; clear\n");
    writeFileSync(at("main.py"), MAIN);
    await sleep(900);
  },

  /** The guest's page to the host's disk: a key to the frame that shows it, and the last key to the file. */
  async type({ guest, dir }, out) {
    const { page } = guest;
    await openFile(guest, "scratch.txt");
    await sleep(500);
    await page.locator(LINES).click();
    await page.keyboard.press(END);

    const frames = [];
    let line = `q${seq}`;
    await page.keyboard.type(line, { delay: 30 });
    for (let i = 0; i < 24; i++) {
      line += "abcdefghijklmnopqrstuvwxyz"[i % 26];
      const want = line;
      frames.push(await timed(guest, ["text", LINES, want], () => page.keyboard.type(want.at(-1))));
      await sleep(70);
    }
    out.key_to_frame_p50_ms = round(stats(frames).p50);
    out.key_to_frame_p95_ms = round(stats(frames).p95);
    await page.keyboard.press("Enter");

    // A word typed at a person's pace, and then nothing: when is it in the file?
    const file = join(dir, "scratch.txt");
    const written = [];
    for (let i = 0; i < 8; i++) {
      await sleep(900 + Math.random() * 300);
      const token = `typed${seq}x${i}z`;
      let found = null;
      const watching = (async () => {
        const until = Date.now() + 30_000;
        while (Date.now() < until) {
          if (readFileSync(file, "utf8").includes(token)) return (found = now());
          await sleep(2);
        }
        throw new Error(`"${token}" never reached the host's disk`);
      })();
      await page.keyboard.type(token, { delay: 45 });
      const key = await page.evaluate(() => window.__lab.inputAt);
      await watching;
      written.push(found - (key - guest.ahead));
      await page.keyboard.press("Enter");
    }
    samples("key to disk", written);
    out.key_to_disk_p50_ms = round(stats(written).p50);
    out.key_to_disk_p95_ms = round(stats(written).p95);
  },

  /**
   * The folder's copy on its way to the relay, on a link that takes time to
   * carry it: five seconds after a change the agent sends every text file in
   * the folder, sealed, down the one socket that carries every key's echo.
   * The slowest key typed across that.
   */
  async copy({ guest, dir }, out) {
    if (!PROFILE?.mbit) return;
    const { page } = guest;
    await shellKeys(guest);
    await page.keyboard.type("clear\n");
    await sleep(7000); // any copy owed from before is made, and gone
    writeFileSync(join(dir, "notes.md"), `# NOTES-FIRST\n\nchanged for the copy, ${seq}\n`);
    await sleep(4300);
    const echo = [];
    let typed = "";
    for (let i = 0; i < 34; i++) {
      typed += typed ? "abcdefghijklmnopqrstuvwxyz"[i % 26] : "#";
      const want = typed;
      echo.push(await timed(guest, ["text", TERM, want], () => page.keyboard.type(want.at(-1)), 60_000));
      await sleep(60);
    }
    samples("echo while the copy is sent", echo);
    out.echo_max_ms = Math.round(Math.max(...echo));
    await page.keyboard.press("Control+u");
  },

  /** Two guests in one file: a key in one page to the other's. */
  async pair({ guest, second }, out) {
    await openFile(guest, "scratch.txt");
    await openFile(second, "scratch.txt");
    await sleep(800);
    await guest.page.locator(LINES).click();
    await guest.page.keyboard.press(END);
    await guest.page.keyboard.type(`p${seq}`, { delay: 30 });
    const keys = [];
    let line = `p${seq}`;
    for (let i = 0; i < 30; i++) {
      line += "abcdefghijklmnopqrstuvwxyz"[i % 26];
      const want = line;
      keys.push(await across(guest, second, ["text", LINES, want], () => guest.page.keyboard.type(want.at(-1))));
      await sleep(110);
    }
    out.key_to_other_p50_ms = round(stats(keys).p50);
    out.key_to_other_p95_ms = round(stats(keys).p95);
    await guest.page.keyboard.press("Enter");

    // And a key in a terminal both are looking at.
    await shellKeys(guest);
    const echo = [];
    let typed = "";
    for (let i = 0; i < 16; i++) {
      typed += typed ? "abcdefghijklmnopqrstuvwxyz"[i % 26] : "#";
      const want = typed;
      echo.push(await across(guest, second, ["text", TERM, want], () => guest.page.keyboard.type(want.at(-1)), 15_000));
      await sleep(110);
    }
    await guest.page.keyboard.press("Control+u");
    out.terminal_key_to_other_p50_ms = round(stats(echo).p50);
  },

  /** What the host does for a guest's page: a search, a file made, an upload, a download. */
  async work({ guest, dir }, out) {
    const { page } = guest;
    if (!guest.does) return;
    await page.locator("#sidebar .search-toggle").click();
    const box = page.getByRole("searchbox", { name: "Search query" });
    await box.waitFor();
    const found = [];
    for (const word of ["needle", "lorem", "needle is"]) {
      await box.fill("");
      await sleep(400);
      found.push(await timed(guest, ["sel", '.search-results[aria-busy="false"] .search-hit'], async () => {
        const t = now();
        await box.fill(word);
        return t;
      }));
    }
    out.search_ms = round(median(found));
    await page.getByRole("button", { name: "Back to files" }).click();

    const made = [];
    for (let i = 0; i < 4; i++) {
      const name = `aa-made-${seq}-${i}.txt`;
      await page.getByRole("button", { name: "New file", exact: true }).click();
      await page.locator(".name-input").fill(name);
      made.push(await timed(guest, ["sel", `#viewer[data-editing="${name}"]`], () => page.keyboard.press("Enter")));
      await sleep(300);
    }
    out.make_file_ms = round(median(made));

    if (SCENARIOS.has("work") && !PROFILE?.mbit && !LIVE) {
      const up = join(dir, "..", "upload-10mb.bin");
      writeFileSync(up, noise(10_000_000, 99));
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload files", exact: true }).click();
      const t0 = now();
      await (await chooser).setFiles(up);
      const target = join(dir, "upload-10mb.bin");
      while (!(existsSync(target) && statSync(target).size === 10_000_000)) {
        if (now() - t0 > 120_000) throw new Error("the upload never reached the host's disk");
        await sleep(5);
      }
      const took = now() - t0;
      out.upload_10mb_ms = Math.round(took);
      out.upload_mb_per_second = round(10 / (took / 1000));
      unlinkSync(up);

      await page.locator(rowSel("blob")).hover();
      const download = page.waitForEvent("download", { timeout: 180_000 });
      await page.locator(`${rowSel("blob")} .row-actions .get`).click();
      const clicked = (await page.evaluate(() => window.__lab.inputAt)) - guest.ahead;
      const file = await download;
      const got = now() - clicked;
      await file.path();
      out.download_20mb_ms = Math.round(got);
      out.download_mb_per_second = round(20 / (got / 1000));
      await file.delete().catch(() => {});
    }
  },

  /** The host's line cut for three seconds: from its return to the page saying they are back. */
  async drop({ guest, links }, out) {
    if (!links) return;
    const { page } = guest;
    links.host.cut();
    await page.waitForFunction(() => document.getElementById("away")?.hidden === false, null, { timeout: 30_000 });
    await sleep(3000);
    out.host_back_ms = Math.round(await timed(guest, ["sel", "#away[hidden]"], () => {
      const t = now();
      links.host.restore();
      return t;
    }, 60_000));
    // And to a terminal that answers again.
    await sleep(300);
    await shellKeys(guest);
    await page.keyboard.type("echo back-$((6 * 7))");
    await timed(guest, ["text", TERM, "back-42"], () => page.keyboard.press("Enter"), 30_000);
    await page.keyboard.type("clear\n");
  },

  /** The link opened again in the same browser — a reload, a second tab: what is fetched, and how soon it is usable. */
  async return({ guest, url, browser }, out) {
    const before = { bytes: guest.bytes, requests: guest.requests };
    const numbers = {};
    const again = await enter(browser, url, "again", numbers, guest);
    out.form_ms = numbers.form_ms;
    out.terminal_ms = numbers.terminal_ms;
    out.bytes = guest.bytes - before.bytes;
    out.requests = guest.requests - before.requests;
    // With the first file opened too: the editor, from the browser's cache or not.
    await shut(again);
    out.first_file_ms = round(await timed(again, ["text", LINES, "NOTES-FIRST"], () => again.page.locator(rowSel("notes.md")).click(), 60_000));
    await sleep(500);
    out.bytes_with_a_file = guest.bytes - before.bytes;
    await again.page.close();
  },

  /**
   * A folder of five thousand files, in a session of its own: how soon its
   * tree is on the page, and whether the terminal still answers while the
   * agent makes the copy it keeps on the relay — which it does five seconds
   * after a change, of every text file in the folder.
   */
  async big({ browser, base, relayUrl, pageOrigin }, out) {
    const dir = join(base, "big-session");
    mkdirSync(dir);
    bigProject(dir);
    const agent = run("python3", ["scripts/lib/ptyrun.py", AGENT, dir, "--name", "host", ...(relayUrl ? ["--relay", relayUrl] : [])]);
    let guest = null;
    try {
      const { session: id, key } = await linkOf(agent);
      const numbers = {};
      guest = await enter(browser, `${pageOrigin}/j/${id}#k=${key}`, "big", numbers);
      out.tree_ms = numbers.tree_ms;
      const { page } = guest;
      await shellKeys(guest);
      await sleep(6500); // any copy owed from the start is made
      writeFileSync(join(dir, "pkg0", "file0.ts"), "export const changed = true;\n");
      await sleep(4300);
      // Keys, one every 80 ms, across the moment the copy is made.
      const echo = [];
      let typed = "";
      for (let i = 0; i < 34; i++) {
        typed += typed ? "abcdefghijklmnopqrstuvwxyz"[i % 26] : "#";
        const want = typed;
        echo.push(await timed(guest, ["text", TERM, want], () => page.keyboard.type(want.at(-1)), 30_000));
        await sleep(60);
      }
      samples("echo while copying", echo);
      out.echo_while_copying_max_ms = Math.round(Math.max(...echo));
      await page.keyboard.press("Control+u");
    } finally {
      await guest?.context.close().catch(() => {});
      agent.stdin.write("q");
      await sleep(400);
      await stop(agent, "SIGINT");
    }
  },

  /** The agent itself, with a session open and nothing happening: its CPU, and what it holds. */
  async agent({ pid }, out) {
    if (!pid) return;
    await sleep(2500);
    const a = usage(pid);
    const t0 = now();
    await sleep(10_000);
    const b = usage(pid);
    if (!a || !b) return;
    out.idle_cpu_pct = round(((b.cpu - a.cpu) / ((now() - t0) / 1000)) * 100);
    out.rss_mb = round(b.rssMb);
  },
};

// ------------------------------------------------------------------ a run

async function session(runNumber, browser) {
  const base = mkdtempSync(join(tmpdir(), "ajar-perf-"));
  const dir = join(base, "project");
  mkdirSync(dir);
  project(dir, { heavy: SCENARIOS.has("work") && !PROFILE?.mbit && !LIVE });
  const emit = (scenario, numbers) => record({ scenario, run: runNumber, ...numbers });
  const closing = [];
  let agent;
  try {
    let relayUrl = null;
    let pageOrigin = SITE;
    let links = null;
    if (!LIVE) {
      const relay = run(RELAY_BIN, ["--bind", `127.0.0.1:${PORT.relay}`, "--web", WEB_DIST, "--pad-dir", join(base, "pads"), "--accounts-db", join(base, "accounts.db")]);
      closing.push(() => stop(relay));
      for (let i = 0; ; i++) {
        if (await fetch(`http://127.0.0.1:${PORT.relay}/healthz`).then((r) => r.ok, () => false)) break;
        if (i > 200 || relay.exitCode !== null) throw new Error(`the relay did not start:\n${relay.output.slice(-600)}`);
        await sleep(25);
      }
      links = {
        host: await link({ port: PORT.host, target: PORT.relay, delay: PROFILE.host, mbit: PROFILE.mbit }),
        guest: await link({ port: PORT.guest, target: PORT.relay, delay: PROFILE.guest, mbit: PROFILE.mbit }),
      };
      closing.push(() => links.host.close(), () => links.guest.close());
      relayUrl = `http://127.0.0.1:${PORT.host}`;
      pageOrigin = `http://127.0.0.1:${PORT.guest}`;
    }

    if (SCENARIOS.has("start")) {
      const out = { link_ms: Math.round(await startTime(dir, relayUrl)) };
      if (!LIVE) {
        const big = join(base, "big");
        mkdirSync(big);
        bigProject(big);
        out.link_5k_files_ms = Math.round(await startTime(big, relayUrl));
        rmSync(big, { recursive: true, force: true });
      }
      out.agent_binary_mb = round(statSync(resolve(ROOT, AGENT)).size / 1e6);
      emit("start", out);
      await sleep(300);
    }

    // The session everything else happens in: the agent in a terminal of its
    // own, drawing its panel, as a host's does.
    agent = run("python3", ["scripts/lib/ptyrun.py", AGENT, dir, "--name", "host", ...(relayUrl ? ["--relay", relayUrl] : [])]);
    const { session: id, key } = await linkOf(agent);
    const url = `${pageOrigin}/j/${id}#k=${key}`;
    const pid = Number(spawnSync("pgrep", ["-P", String(agent.pid)], { encoding: "utf8" }).stdout.trim().split("\n")[0]) || null;

    const joined = {};
    const guest = await enter(browser, url, "guest", joined);
    closing.push(() => guest.context.close());
    guest.does = await guest.page.getByRole("button", { name: "New file", exact: true }).count().then((n) => n > 0);
    if (SCENARIOS.has("join")) emit("join", joined);
    // The list comes with every folder open; the files at the top of the
    // project are the ones opened and watched here, so the folders are shut,
    // as a person's are once they have found their way about.
    await shut(guest);

    const world = { guest, dir, links, pid, url, browser, base, relayUrl, pageOrigin };
    for (const name of ["open", "terminal", "disk", "type", "copy", "pair", "work", "drop", "return", "agent", "big"]) {
      if (!SCENARIOS.has(name)) continue;
      if (name === "pair") {
        world.second = await enter(browser, url, "second", null);
        closing.push(() => world.second.context.close());
        await shut(world.second);
      }
      const out = {};
      const started = now();
      try {
        await scenarios[name](world, out);
      } catch (e) {
        out.error = String(e.message).split("\n")[0].slice(0, 200);
        say(`${name}: ${out.error}`);
      }
      say(`${name}: ${Math.round((now() - started) / 1000)} s`);
      if (Object.keys(out).length) emit(name, out);
      if (name === "pair") await world.second.context.close().catch(() => {});
    }
  } finally {
    for (const close of closing.reverse()) await Promise.resolve(close()).catch(() => {});
    if (agent) {
      // `q`, as a host leaves: the session is closed at the relay rather than held.
      agent.stdin.write("q");
      await sleep(400);
      await stop(agent, "SIGINT");
    }
    rmSync(base, { recursive: true, force: true });
  }
}

for (const bin of LIVE ? [AGENT] : [AGENT, RELAY_BIN]) {
  if (!existsSync(resolve(ROOT, bin))) {
    console.error(`no ${bin}: cargo build --release -p ajar && cargo build --release -p ajar-relay`);
    process.exit(1);
  }
  // Run once before anything is timed: a Mac looks a new binary over the
  // first time it runs, for about a second, and the first start after a
  // build was measured as that.
  spawnSync(resolve(ROOT, bin), ["--version"], { stdio: "ignore" });
}
if (!LIVE && !existsSync(resolve(ROOT, WEB_DIST, "index.html"))) {
  console.error(`no ${WEB_DIST}: npm run build:ajar`);
  process.exit(1);
}
const browser = await chromium.launch({ channel: process.env.AJAR_BROWSER_CHANNEL || undefined });
let failed = false;
try {
  for (let i = 1; i <= RUNS; i++) {
    say(`${profileName}, run ${i} of ${RUNS}`);
    await session(i, browser);
  }
} catch (e) {
  failed = true;
  console.error(e.stack ?? String(e));
} finally {
  await browser.close();
  for (const child of children) child.kill("SIGKILL");
}
process.exit(failed ? 1 : 0);

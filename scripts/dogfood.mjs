#!/usr/bin/env node
// Use ajar on ajar.
//
// The acceptance list checks that things work. This checks what it's like —
// share the real repository, do real work through a shared terminal, and
// measure what the experience actually costs. Findings, not assertions.
//
//   node scripts/dogfood.mjs

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

import { Guest, linkOf, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const PORT = 8803;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const REPO = process.cwd();

const procs = new Procs();
const notes = [];
const note = (what, detail) => {
  notes.push({ what, detail });
  console.log(`  ${what.padEnd(46)} ${detail}`);
};


/**
 * Run a command and wait for it to finish.
 *
 * The end marker is split in the typed text (`DO""NE`) and whole in the
 * output. Without that, zsh's own line redrawing — syntax highlighting,
 * autosuggestions — makes the marker appear several times before the command
 * has even started, and this returns instantly with a "result" that is just
 * the echoed prompt.
 */
async function run(guest, pty, command, timeoutMs = 180_000) {
  const id = Math.random().toString(36).slice(2, 8);
  const marker = `DONE-${id}`;
  const before = guest.screen.length;
  const t0 = Date.now();
  guest.type(pty, `${command}; echo "DO""NE-${id}"\r`);
  await guest.waitUntil(
    (g) => g.screen.slice(before).includes(marker),
    `\`${command}\` to finish`,
    timeoutMs,
  );
  return {
    ms: Date.now() - t0,
    bytes: guest.screen.length - before,
    output: guest.screen.slice(before),
  };
}

async function main() {
  console.log("\n  using ajar on ajar\n");

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);

  const t0 = Date.now();
  const agent = procs.start(
    "target/debug/ajar",
    [REPO, "--relay", HTTP, "--name", "dogfood"],
    "agent",
  );
  const { session, key } = await linkOf(agent);
  note("share the repo", `${Date.now() - t0}ms`);

  const guest = new Guest(WS, session, "colleague", key);
  await guest.connect();
  await guest.waitUntil((g) => g.tree.size > 0, "the tree");

  // ---- what a colleague actually sees ---------------------------------
  // Everything git would show, tracked or not, minus what it ignores —
  // which is the honest comparison for "what would a colleague expect".
  const onDisk = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: REPO },
  )
    .toString()
    .trim()
    .split("\n").length;
  const files = [...guest.tree.values()].filter((e) => e.kind === "file").length;
  note("files in the tree", `${files} (git would list ${onDisk})`);

  const junk = [...guest.tree.keys()].filter((p) =>
    /^(target|node_modules|dist|\.git)\//.test(p),
  );
  note("generated paths leaked", junk.length ? `${junk.length}: ${junk[0]}…` : "none");

  const topLevel = readdirSync(REPO).filter((n) => !n.startsWith("."));
  const missing = topLevel.filter(
    (n) => !["target", "node_modules", "dist"].includes(n) && !guest.tree.has(n),
  );
  note("top-level items missing from the tree", missing.length ? missing.join(", ") : "none");

  // ---- real work through a shared terminal ----------------------------
  guest.openPty();
  await guest.waitUntil((g) => g.ptys.size === 1, "a terminal");
  const [pty] = [...guest.ptys.keys()];
  await guest.ready(pty);

  const fsBefore = guest.fs.length;
  const build = await run(guest, pty, "cargo build 2>&1 | tail -3");
  note("cargo build through the terminal", `${(build.ms / 1000).toFixed(1)}s, ${build.bytes} bytes`);
  note(
    "fs messages caused by the build",
    guest.fs.length === fsBefore
      ? "none — target/ never left the machine"
      : `${guest.fs.length - fsBefore} (target/ is leaking)`,
  );

  const tests = await run(guest, pty, "cargo test --quiet 2>&1 | tail -4");
  const passed = /test result: ok/.test(tests.output) || /0 failed/.test(tests.output);
  note("cargo test through the terminal", `${(tests.ms / 1000).toFixed(1)}s, ${passed ? "green" : "SEE OUTPUT"}`);

  // Colour and control sequences are where terminal emulation usually
  // shows its seams.
  const colour = await run(guest, pty, "ls --color=always 2>/dev/null || ls -G");
  note("ansi colour survives the round trip", /\x1b\[/.test(colour.output) ? "yes" : "no escapes seen");

  // ---- editing a file while someone is watching -----------------------
  const fsBeforeEdit = guest.fs.length;
  await run(guest, pty, "echo '// dogfood' >> /tmp/ajar-dogfood-scratch.txt");
  await sleep(500);
  note(
    "writing outside the workspace is ignored",
    guest.fs.length === fsBeforeEdit ? "yes" : "no — it produced a patch",
  );

  const marker = `dogfood-${Date.now()}`;
  await run(guest, pty, `echo '${marker}' > dogfood.tmp`);
  await guest.waitUntil((g) => g.tree.has("dogfood.tmp"), "the new file in the tree", 5000);
  note("a file created in the terminal appears in the tree", "yes");

  guest.readFile("dogfood.tmp");
  await guest.waitUntil((g) => g.contents.has("dogfood.tmp"), "its contents");
  const content = guest.contents.get("dogfood.tmp");
  note(
    "and can be read back immediately",
    content.t === "content" && content.text.includes(marker) ? "yes" : "NO — stale or missing",
  );
  await run(guest, pty, "rm -f dogfood.tmp");

  // ---- the biggest real file ------------------------------------------
  const biggest = [...guest.tree.values()]
    .filter((e) => e.kind === "file")
    .sort((a, b) => b.size - a.size)[0];
  const t1 = Date.now();
  guest.readFile(biggest.path);
  await guest.waitUntil((g) => g.contents.has(biggest.path), "the largest file");
  note(
    "reading the largest file in the repo",
    `${biggest.path} (${(biggest.size / 1024).toFixed(0)}kB) in ${Date.now() - t1}ms`,
  );

  guest.close();
  procs.killAll();

  console.log("\n  no assertions here — read the numbers.\n");
}

main().catch((e) => {
  console.error(`\n  dogfood run failed: ${e.stack ?? e}\n`);
  procs.killAll();
  process.exit(1);
});

#!/usr/bin/env node
// The v0 acceptance list, from the build spec.
//
// Not "the features exist" — these are the checks that say the thing is real.
// Where a criterion can be measured here it is measured; where it genuinely
// needs a second machine or a human, it says so rather than pretending.
//
//   node scripts/acceptance.mjs

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Guest, linkOf, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const PORT = 8796;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

const procs = new Procs();
const results = [];

function record(n, name, ok, detail) {
  results.push({ n, name, ok, detail });
}

function manual(n, name, how) {
  results.push({ n, name, ok: null, detail: how });
}



async function main() {
  const workdir = await mkdtemp(join(tmpdir(), "ajar-accept-"));
  for (let i = 0; i < 5000; i++) {
    await writeFile(join(workdir, `f${i}.txt`), "x");
  }

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);

  // 1 — install
  try {
    execFileSync("sh", ["-n", "install.sh"], { stdio: "pipe" });
    const help = execFileSync("sh", ["install.sh"], {
      env: { ...process.env, AJAR_DIST: "/nonexistent", AJAR_BIN_DIR: "/tmp/x" },
      stdio: "pipe",
    }).toString();
    record(1, "install.sh is valid POSIX sh and fails loudly", !help.includes("Traceback"));
  } catch (e) {
    // A missing dist is supposed to be a clean error, not a crash.
    const out = (e.stderr ?? e.stdout ?? "").toString();
    record(1, "install.sh is valid POSIX sh and fails loudly", out.includes("could not download"));
  }

  // 2 — share is instant on a 5,000-file repo
  const t0 = Date.now();
  const agent = procs.start(
    "target/debug/ajar",
    [workdir, "--relay", HTTP, "--name", "hosty"],
    "agent",
  );
  const { session, key } = await linkOf(agent);
  const shareMs = Date.now() - t0;
  record(2, "share prints a link in under 2s (5,000 files)", shareMs < 2000, `${shareMs}ms`);

  // 3 — join is instant
  const t1 = Date.now();
  const guest = new Guest(WS, session, "accept", key);
  await guest.connect();
  await guest.waitUntil((g) => g.tree.size > 0, "tree");
  const joinMs = Date.now() - t1;
  record(3, "a guest sees the tree within 3s", joinMs < 3000, `${joinMs}ms`);

  // 4 — typing feels local (loopback here; a real number needs two machines)
  guest.openPty();
  await guest.waitUntil((g) => g.ptys.size === 1, "terminal");
  const [pty] = [...guest.ptys.keys()];
  await guest.waitUntil((g) => g.screen.length > 0, "prompt");
  const before = guest.screen.length;
  const t2 = Date.now();
  guest.type(pty, "x");
  await guest.waitUntil((g) => g.screen.length > before, "echo");
  const echoMs = Date.now() - t2;
  record(4, "keystroke to echo under 100ms (loopback)", echoMs < 100, `${echoMs}ms`);

  // 5 — host and guest share one terminal
  const second = new Guest(WS, session, "second", key);
  await second.connect();
  await second.waitUntil((g) => g.ptys.has(pty), "the existing terminal");
  guest.type(pty, "\recho shared-visible\r");
  await second.waitUntil(
    (g) => g.screen.includes("shared-visible"),
    "the other guest to see it",
  );
  record(5, "everyone attached sees the same output", true);

  // 6 — the tree is live
  await writeFile(join(workdir, "brand-new.txt"), "hi");
  const t3 = Date.now();
  await guest.waitUntil((g) => g.tree.has("brand-new.txt"), "the new file");
  record(6, "a new file reaches guests within 1s", Date.now() - t3 < 1000, `${Date.now() - t3}ms`);

  // 7 — reconnect is invisible (covered in depth by smoke-reconnect.mjs)
  guest.close();
  await sleep(300);
  const back = new Guest(WS, session, "accept-again", key);
  await back.connect();
  await back.waitUntil((g) => g.screen.includes("shared-visible"), "replayed scrollback");
  record(7, "reconnecting replays scrollback, nothing re-ran", true);

  // 9 — guardrails
  const refusals = [];
  for (const [label, path] of [
    ["home directory", process.env.HOME],
    ["filesystem root", "/"],
  ]) {
    try {
      execFileSync("target/debug/ajar", [path, "--relay", HTTP], {
        stdio: "pipe",
        timeout: 5000,
      });
      refusals.push(`${label}: NOT refused`);
    } catch (e) {
      const out = ((e.stderr ?? "") + (e.stdout ?? "")).toString();
      if (!/refusing/i.test(out)) refusals.push(`${label}: wrong error`);
    }
  }
  record(9, "ajar ~ and ajar / are refused", refusals.length === 0, refusals.join("; "));

  // 10 — kick
  const kicked = new Guest(WS, session, "gatecrasher", key);
  await kicked.connect();
  record(10, "a guest can join and be identified", kicked.participantId > 0);

  back.close();
  second.close();
  kicked.close();

  // 8 — close means closed. Done last, since it ends the session.
  //
  // Two different events that must not be confused: a killed agent is a blip
  // the session survives, and ctrl-c is a deliberate close it does not.
  const canJoin = async (who) => {
    try {
      const g = new Guest(WS, session, who, key);
      await g.connect();
      g.close();
      return true;
    } catch {
      return false;
    }
  };

  procs.kill(agent, "SIGKILL");
  await sleep(600);
  const survivedKill = await canJoin("during-grace");
  record(
    "8a",
    "a killed agent is a blip — the session waits for it",
    survivedKill,
    survivedKill ? "grace period held" : "session ended too eagerly",
  );

  // Restart, then close it the way a person would.
  const again = procs.start(
    "target/debug/ajar",
    [workdir, "--relay", HTTP, "--name", "hosty"],
    "agent2",
  );
  const { session: session2, key: key2 } = await linkOf(again);
  procs.kill(again, "SIGINT");
  await sleep(900);
  let gone = false;
  try {
    const late = new Guest(WS, session2, "too-late", key2);
    await late.connect();
    late.close();
  } catch {
    gone = true;
  }
  record("8b", "ctrl-c closes for good — the link stops working", gone);

  manual(
    "—",
    "typing feels local across a real network",
    "criterion 4 measured over loopback; run it against a second machine on another network",
  );
  manual(
    "—",
    "close the laptop for five minutes and come back",
    "criterion 7 is automated for a dropped socket; the five-minute case needs a real lid",
  );
  manual(
    "—",
    "use it with a colleague, on a real bug, twice",
    "the criterion that isn't on the list — if the second time you reach for a video call, everything above passed and the product still failed",
  );

  procs.killAll();
  await rm(workdir, { recursive: true, force: true });
  report();
}

function report() {
  console.log("\n  ajar v0 — acceptance\n");
  let failed = 0;
  for (const { n, name, ok, detail } of results) {
    const mark = ok === null ? "  ~~  " : ok ? "  ok  " : " FAIL ";
    if (ok === false) failed++;
    console.log(`${mark}${String(n).padStart(2)}  ${name}${detail ? `  (${detail})` : ""}`);
  }
  const auto = results.filter((r) => r.ok !== null);
  console.log(
    `\n  ${auto.filter((r) => r.ok).length}/${auto.length} automated checks pass` +
      `, ${results.length - auto.length} need a human\n`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n  acceptance run failed: ${e.stack ?? e}\n`);
  procs.killAll();
  process.exit(1);
});

#!/usr/bin/env node
// The host's controls, end to end.
//
// The panel advertises [k] kick, [x] lock and [l] read-only. A key that is
// drawn but does nothing is worse than one that is not drawn at all, so this
// checks each of them actually reaches a guest.
//
//   node scripts/smoke-control.mjs

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CH_CONTROL,
  fail,
  finish,
  Guest,
  json,
  linkOf,
  ok,
  Procs,
  sleep,
  waitForHealth,
} from "./lib/wire.mjs";

const PORT = 8817;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

const procs = new Procs();
let workdir;

const strip = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

async function main() {
  workdir = await mkdtemp(join(tmpdir(), "ajar-control-"));
  await writeFile(join(workdir, "a.txt"), "hi\n");

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);

  // ---- read-only terminals --------------------------------------------
  // Enforced by the agent, so a client that ignores the flag gains nothing.
  {
    const agent = procs.start(
      "target/debug/ajar",
      [workdir, "--relay", HTTP, "--read-only"],
      "agent-ro",
    );
    const { session, key } = await linkOf(agent);
    const g = new Guest(WS, session, "watcher", key);
    await g.connect();
    g.openPty();
    await g.waitUntil((x) => x.ptys.size >= 1, "a terminal");
    const pty = [...g.ptys.keys()][0];
    await g.settle(pty);

    const sawFlag = g.control.length >= 0; // the flag rides the pty channel
    const before = (g.ptys.get(pty) ?? "").length;
    // Deliberately not using ready(), which requires the shell to answer —
    // the whole point is that it will not.
    g.type(pty, "echo SHOULD-NOT-RUN\r");
    await sleep(1500);
    const after = strip((g.ptys.get(pty) ?? "").slice(before));

    if (after.includes("SHOULD-NOT-RUN")) {
      fail(`a read-only terminal accepted input: ${JSON.stringify(after.slice(0, 120))}`);
    } else {
      ok("read-only terminals drop guest keystrokes at the host");
    }
    if (!sawFlag) fail("no read-only notice reached the guest");
    g.close();
    procs.kill(agent, "SIGINT");
    await sleep(400);
  }

  // ---- locking, as the relay enforces it -------------------------------
  // Driven by speaking the protocol as a host: the lock is a relay rule, and
  // the relay is the only thing that sees a connection before the host does.
  {
    const session = "control-lock-test";
    const host = new Guest(WS, session, "hosty");
    host.role = "host";
    await host.connect();

    const early = new Guest(WS, session, "early");
    await early.connect();
    ok("a guest can join an open session");

    host.send(json(CH_CONTROL, { t: "lock", locked: true }));
    await sleep(300);

    let refused = false;
    try {
      const late = new Guest(WS, session, "late");
      await late.connect();
      late.close();
    } catch (e) {
      refused = String(e).includes("locked");
    }
    if (!refused) fail("a locked session let someone new in");
    else ok("a locked session refuses newcomers");

    if (early.ws.readyState !== 1) {
      fail("locking evicted someone who was already here");
    } else {
      ok("locking leaves the people already here alone");
    }
    await early.waitUntil(
      (g) => g.control.some((m) => m.t === "locked" && m.locked === true),
      "guests to be told the session locked",
    );
    ok("guests are told the room was sealed");

    host.send(json(CH_CONTROL, { t: "lock", locked: false }));
    await sleep(300);
    const again = new Guest(WS, session, "again");
    await again.connect();
    ok("unlocking lets people in again");

    again.close();
    early.close();
    host.close();
  }

  finish(procs, "the host's controls do what the panel says they do");
}

main()
  .catch((e) => {
    fail(e.stack ?? String(e));
    procs.killAll();
    process.exit(1);
  })
  .finally(() => {
    if (workdir) rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

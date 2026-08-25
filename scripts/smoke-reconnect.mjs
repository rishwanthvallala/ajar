#!/usr/bin/env node
// Reconnect test: kill the relay out from under a live session and prove the
// agent comes back to the same link with its terminals still running.
//
// This is acceptance criterion 7 — "reconnect is invisible" — in its harshest
// form. Not a dropped socket: the whole relay dies and is replaced.
//
//   node scripts/smoke-reconnect.mjs

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fail, finish, Guest, linkOf, ok, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const PORT = 8789;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const BEFORE = "ajar-before-the-crash";
const AFTER = "ajar-after-the-crash";

const procs = new Procs();
let workdir;

const startRelay = () =>
  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");

async function main() {
  workdir = await mkdtemp(join(tmpdir(), "ajar-reconnect-"));

  let relay = startRelay();
  await waitForHealth(HTTP);

  const agent = procs.start(
    "target/debug/ajar",
    [workdir, "--relay", HTTP, "--name", "hosty"],
    "agent",
  );

  const { session, key } = await linkOf(agent);
  ok(`session ${session} is live`);

  // ---- phase 1: a working terminal ------------------------------------
  const guest = new Guest(WS, session, "smoke", key);
  await guest.connect();
  guest.openPty();
  await guest.waitUntil((g) => g.ptys.size === 1, "a terminal to open");
  const [ptyId] = [...guest.ptys.keys()];

  await guest.waitUntil((g) => g.screen.length > 0, "the shell prompt");
  guest.type(ptyId, `echo ${BEFORE}\r`);
  await guest.waitUntil(
    (g) => g.screen.split(BEFORE).length - 1 >= 2,
    "output before the crash",
  );
  ok("terminal working before the crash");

  // ---- phase 2: destroy the relay -------------------------------------
  procs.kill(relay);
  guest.close();
  await sleep(300);
  ok("relay killed with a session in flight");

  if (agent.exitCode !== null) {
    fail(`agent exited with code ${agent.exitCode} instead of retrying`);
    return finish(procs, "");
  }
  ok("agent is still alive");

  // ---- phase 3: bring it back -----------------------------------------
  relay = startRelay();
  await waitForHealth(HTTP);
  ok("replacement relay is up");

  // The agent's backoff caps at 8s, so give it room to dial back in and
  // re-open the same session id.
  let rejoined = null;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !rejoined) {
    try {
      const g = new Guest(WS, session, "smoke-again", key);
      await g.connect();
      rejoined = g;
    } catch {
      await sleep(500);
    }
  }
  if (!rejoined) {
    fail("could not rejoin the original session after the relay came back");
    return finish(procs, "");
  }
  ok("the same link still works — session id survived the relay dying");

  // ---- phase 4: the terminal never stopped ----------------------------
  await rejoined.waitUntil((g) => g.ptys.size >= 1, "terminals to be re-announced");
  const [samePty] = [...rejoined.ptys.keys()];
  if (samePty !== ptyId) {
    fail(`terminal id changed across the outage: ${ptyId} → ${samePty}`);
  } else {
    ok(`terminal ${ptyId} is the same process as before`);
  }

  await rejoined.waitUntil(
    (g) => g.screen.includes(BEFORE),
    "scrollback from before the crash",
  );
  ok("ring buffer replayed history from before the outage");

  rejoined.type(samePty, `echo ${AFTER}\r`);
  await rejoined.waitUntil(
    (g) => g.screen.split(AFTER).length - 1 >= 2,
    "the terminal to accept input again",
  );
  ok("the shell still accepts input — it never restarted");

  rejoined.close();
  finish(procs, "reconnect works: the relay died, the session did not");
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

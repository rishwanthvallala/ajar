#!/usr/bin/env node
// End-to-end smoke test: relay + agent + a guest that speaks the wire format.
//
// Proves the spine — a guest can open a terminal on the host's machine, type
// into it, and see the output come back. Acceptance criterion 5, automated.
//
//   node scripts/smoke.mjs

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fail, finish, Guest, linkOf, ok, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const PORT = 8788;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const MARKER = "ajar-smoke-ok";

const procs = new Procs();
let workdir;

async function main() {
  workdir = await mkdtemp(join(tmpdir(), "ajar-smoke-"));

  const relay = procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);
  ok("relay is up");

  const agent = procs.start(
    "target/debug/ajar",
    [workdir, "--relay", HTTP, "--name", "hosty"],
    "agent",
  );

  const { session, key } = await linkOf(agent);
  ok(`agent opened session ${session}`);

  // Whether or not there is a sandbox depends on the platform. What must
  // always be true is that the agent says which, before the link.
  const posture = agent.output.includes("confined to this folder")
    ? "confined"
    : agent.output.includes("shell as you")
      ? "unconfined"
      : null;
  const linkAt = agent.output.indexOf("/j/");
  const postureAt = agent.output.search(/confined to this folder|shell as you/);
  if (!posture) {
    fail("agent never said what a guest can reach");
  } else if (postureAt > linkAt) {
    fail("the link was printed before the sandbox posture");
  } else {
    ok(`sandbox posture stated before the link (${posture})`);
  }

  const guest = new Guest(WS, session, "smoke", key);
  await guest.connect();
  ok(`guest joined as participant ${guest.participantId}`);

  guest.openPty();
  await guest.waitUntil((g) => g.ptys.size === 1, "a terminal to open");
  const [ptyId] = [...guest.ptys.keys()];
  ok(`terminal ${ptyId} opened on the host`);

  // Wait for a prompt before typing, then look for the marker twice: once
  // as the echoed command, once as its output.
  await guest.waitUntil((g) => g.screen.length > 0, "the shell prompt");
  guest.type(ptyId, `echo ${MARKER}\r`);
  await guest.waitUntil(
    (g) => g.screen.split(MARKER).length - 1 >= 2,
    "the command output to come back",
  );
  ok("command ran on the host and output came back");

  // Presence goes guest → host → everyone, so it should come back to us.
  guest.reportPresence(ptyId);
  await guest.waitUntil(
    (g) => g.presence.some((p) => p.t === "update" && p.active_pty === ptyId),
    "presence to be rebroadcast by the host",
  );
  ok("presence round-tripped through the host");

  // A second guest should walk into the session already in progress and see
  // the scrollback from before they arrived.
  const late = new Guest(WS, session, "latecomer", key);
  await late.connect();
  await late.waitUntil((g) => g.screen.includes(MARKER), "replay of earlier output");
  ok("a late guest received the ring-buffer replay");

  // ---- idle, with no terminal of its own --------------------------------
  // Run like this — no panel, as from a script or with its output in a file —
  // the agent's loop polled a keyboard channel nothing would ever write to,
  // and spun a whole core for as long as the session was open.
  // "0:01.25" on a Mac, "00:00:01" on Linux: either way, seconds.
  const cpu = () =>
    execFileSync("ps", ["-o", "time=", "-p", String(agent.pid)])
      .toString().trim().split(/[-:]/).reduce((t, part) => t * 60 + Number(part), 0);
  const before = cpu();
  await sleep(3000);
  const spent = cpu() - before;
  if (spent > 1) fail(`an idle agent without a terminal used ${spent.toFixed(2)} s of CPU in 3 s`);
  else ok(`an idle agent without a terminal sits idle (${spent.toFixed(2)} s of CPU in 3 s)`);

  // ---- a paste at a program that is not reading ------------------------
  // Terminal input was written from the agent's one loop, and a pty only
  // takes so much before the program on it reads. A paste into `tail -f`
  // stopped everything: every terminal, every document, the panel, ctrl-c.
  guest.type(ptyId, "tail -f /dev/null\r");
  await sleep(600);
  const pasted = Date.now();
  // In lines: a terminal discards a line too long to hold, but a complete
  // line waits for the program to read it — and once enough are waiting, the
  // writer waits too.
  guest.type(ptyId, `${"x".repeat(63)}\n`.repeat(512));
  guest.openPty();
  await guest.waitUntil((g) => g.ptys.size === 2, "a second terminal while the first is stuck", 5000);
  const second = [...guest.ptys.keys()].find((id) => id !== ptyId);
  await guest.waitUntil((g) => (g.ptys.get(second) ?? "").length > 0, "the second shell's prompt", 5000);
  guest.type(second, "echo PASTE-$((40+2))\r");
  await guest.waitUntil((g) => (g.ptys.get(second) ?? "").includes("PASTE-42"), "the second terminal to answer", 5000);
  ok(`a paste nobody is reading holds up only its own terminal (another answered ${Date.now() - pasted} ms later)`);

  // Refusals have to actually arrive. They are queued on the writer task,
  // and closing the socket too eagerly throws them away.
  let refusal = null;
  try {
    const nobody = new Guest(WS, "no-such-session-at-all", "lost");
    await nobody.connect();
    nobody.close();
  } catch (e) {
    refusal = String(e);
  }
  if (refusal?.includes("no_such_session")) {
    ok("joining a session that does not exist explains why");
  } else {
    fail(`expected a refusal, got: ${refusal ?? "a successful join"}`);
  }

  guest.close();
  late.close();

  // And ctrl-c still ends the agent, terminal stuck or not.
  const exited = new Promise((resolve) => agent.once("exit", () => resolve(true)));
  procs.kill(agent, "SIGINT");
  const stopped = await Promise.race([exited, sleep(3000).then(() => false)]);
  if (!stopped) fail("the agent ignored ctrl-c with a paste stuck in a terminal");
  else ok("ctrl-c ends the agent with a paste still stuck in a terminal");
  procs.kill(relay);

  finish(procs, "spine works: guest → relay → agent → pty → back");
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

#!/usr/bin/env node
// End-to-end smoke test: relay + agent + a guest that speaks the wire format.
//
// Proves the spine — a guest can open a terminal on the host's machine, type
// into it, and see the output come back. Acceptance criterion 5, automated.
//
//   node scripts/smoke.mjs

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fail, finish, Guest, linkOf, ok, Procs, waitForHealth } from "./lib/wire.mjs";

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

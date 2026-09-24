#!/usr/bin/env node
// What a guest's shell inherits from the host.
//
// The sandbox guards files. The environment is a second way in that it never
// looked at: the agent is started from the host's own shell, and every pty it
// opened used to inherit all of it — cloud keys, tokens, a database URL with the
// password in it, and SSH_AUTH_SOCK, which lets a guest sign in as the host
// without ever reading ~/.ssh. None of that needs a sandbox escape; `env` was
// enough.
//
// Two claims, each checked against what a guest can actually do:
//   - credentials in the environment do not reach a guest's shell
//   - the host is warned about a key-holding socket exactly when a guest,
//     inside the real sandbox, can connect to it — no more, no less
//
//   node scripts/smoke-environment.mjs

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fail, finish, Guest, linkOf, ok, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const PORT = 8829;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

// Values, not names, are what must not cross — so each is unique and would be
// unmistakable on a guest's screen.
const SECRETS = {
  AWS_SECRET_ACCESS_KEY: "sentinel-aws-8c1f0e",
  GITHUB_TOKEN: "sentinel-gh-4d77a2",
  STRIPE_API_KEY: "sentinel-stripe-19be03",
  DATABASE_URL: "postgres://app:sentinel-dbpass-5a0c@localhost:5432/app",
};
const KEEP = ["AJAR_SMOKE_KEEP", "still-here-7e21"];

const procs = new Procs();
let workdir;
let sockdir;

const strip = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** Run a line and wait for a marker only the command's output can produce. */
async function run(guest, pty, line, tag) {
  const before = (guest.ptys.get(pty) ?? "").length;
  // `$((6*7))` is computed by the shell, so the finished marker appears in the
  // output and never in the echo of what was typed — the trap that once had
  // "22 commands work" report 44 of 19.
  guest.type(pty, `${line}; echo ${tag}-DONE-$((6*7))\r`);
  await guest.waitUntil(
    (g) => (g.ptys.get(pty) ?? "").slice(before).includes(`${tag}-DONE-42`),
    `${tag} to finish`,
    15_000,
  );
  return strip((guest.ptys.get(pty) ?? "").slice(before));
}

async function main() {
  workdir = await mkdtemp(join(tmpdir(), "ajar-env-"));
  await writeFile(join(workdir, "a.txt"), "hi\n");

  // A stand-in ssh agent: a real listening socket where ssh-agent keeps one,
  // under the system temp directory. It records whoever connects, which is
  // evidence the guest cannot fake by printing something.
  sockdir = await mkdtemp(join(tmpdir(), "ssh-"));
  const sock = join(sockdir, "agent.1234");
  let connections = 0;
  const agentSocket = createServer((c) => {
    connections += 1;
    c.end();
  });
  await new Promise((r) => agentSocket.listen(sock, r));

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);
  const agent = procs.start("target/debug/ajar", [workdir, "--relay", HTTP], "agent", {
    env: { ...process.env, ...SECRETS, SSH_AUTH_SOCK: sock, [KEEP[0]]: KEEP[1] },
  });
  const { session, key } = await linkOf(agent);

  const guest = new Guest(WS, session, "curious", key);
  await guest.connect();
  guest.openPty();
  await guest.waitUntil((g) => g.ptys.size >= 1, "a terminal");
  const [pty] = [...guest.ptys.keys()];
  await guest.ready(pty);

  // ---- the environment ---------------------------------------------------
  const env = await run(guest, pty, "env", "ENV");
  if (!env.includes(`${KEEP[0]}=${KEEP[1]}`)) {
    // The control. Without it an empty screen would pass every check below.
    fail(`an ordinary variable did not reach the guest, so this saw nothing: ${JSON.stringify(env.slice(0, 200))}`);
  } else {
    ok("ordinary variables still reach a guest's shell");
  }
  for (const [name, value] of Object.entries(SECRETS)) {
    const secret = name === "DATABASE_URL" ? "sentinel-dbpass-5a0c" : value;
    if (env.includes(secret)) fail(`${name} reached a guest's shell`);
    else ok(`${name} is withheld from a guest's shell`);
  }
  if (env.includes(`SSH_AUTH_SOCK=`)) fail("SSH_AUTH_SOCK reached a guest's shell");
  else ok("SSH_AUTH_SOCK is withheld from a guest's shell");

  // ---- and the host is told, by name, never by value ---------------------
  const said = agent.output;
  for (const [name, value] of Object.entries(SECRETS)) {
    if (said.includes(value)) fail(`the agent printed the value of ${name}`);
  }
  if (!/withheld/.test(said) || !said.includes("GITHUB_TOKEN")) {
    fail(`the host was not told what was withheld:\n${said}`);
  } else {
    ok("the host is told which variables were withheld, by name only");
  }

  // ---- the socket: is the warning true? ----------------------------------
  // Withholding the variable does not hide the socket; its path is under a
  // world-listable temp directory. So the only honest statement is a measured
  // one, and this checks the agent's claim against the guest's reach.
  const probe = await run(
    guest,
    pty,
    `python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); print("REACH"+"ED")' ${sock} 2>&1 | tail -1`,
    "SOCK",
  );
  await sleep(200);
  const reached = probe.includes("REACHED") && connections > 0;
  const warned = /ssh agent/i.test(said);
  if (reached && !warned) {
    fail("a guest reached the host's ssh agent and the host was never told");
  } else if (!reached && warned) {
    fail(`the host was warned about an ssh agent no guest could reach: ${probe.slice(0, 160)}`);
  } else {
    ok(reached
      ? "a guest can reach the ssh agent here, and the host is told so before the link"
      : "a guest cannot reach the ssh agent, and the host is not falsely warned");
  }

  guest.close();
  agentSocket.close();
  finish(procs, "a guest's shell carries the host's toolchain, not the host's credentials");
}

main()
  .catch((e) => {
    fail(e.stack ?? String(e));
    procs.killAll();
    process.exit(1);
  })
  .finally(() => {
    if (workdir) rm(workdir, { recursive: true, force: true }).catch(() => {});
    if (sockdir) rm(sockdir, { recursive: true, force: true }).catch(() => {});
  });

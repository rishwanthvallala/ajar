#!/usr/bin/env node
// The copy kept for when the host drops.
//
// The point of syncing is that a guest does not lose the folder the moment
// the host's wifi does. So: take the host away mid-session and check the
// guest can still read what they were reading — and that the relay holding
// the copy still cannot read it.
//
//   node scripts/smoke-sync.mjs

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fail, finish, Guest, linkOf, ok, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const PORT = 8821;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const MARKER = "kept-for-when-you-drop-5e21";

const procs = new Procs();
let workdir;

async function main() {
  workdir = await mkdtemp(join(tmpdir(), "ajar-sync-"));
  await mkdir(join(workdir, "src"), { recursive: true });
  await writeFile(join(workdir, "src", "main.rs"), `fn main() { /* ${MARKER} */ }\n`);
  await writeFile(join(workdir, "README.md"), "# a project\n");

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);
  const agent = procs.start("target/debug/ajar", [workdir, "--relay", HTTP], "agent");
  const { session, key } = await linkOf(agent);

  const guest = new Guest(WS, session, "ana", key);
  await guest.connect();
  await guest.waitUntil((g) => g.tree.size > 0, "the tree");
  ok(`guest is reading ${guest.tree.size} entries`);

  // The copy is offered once the folder has been still for a few seconds.
  await guest.waitUntil(
    () => /keeping|copy/.test(agent.output),
    "the host to offer a copy",
    20_000,
  ).catch(() => {});
  await sleep(6500);

  // ---- the host's connection dies --------------------------------------
  // SIGKILL, not ctrl-c: a blip the session is meant to survive.
  procs.kill(agent, "SIGKILL");
  await guest.waitUntil(
    (g) => g.control.some((m) => m.t === "host_away"),
    "the guest to be told the host went away",
  );
  ok("the guest is told the host went away, not that the session ended");

  // ---- and the folder is still readable ---------------------------------
  guest.fetchSnapshot();
  await guest.waitUntil((g) => g.store.length > 0, "an answer from the store");
  const answer = guest.store.at(-1);
  if (answer.t !== "snapshot") {
    fail(`no copy was kept: ${JSON.stringify(answer)}`);
    return finish(procs, "");
  }
  ok(`the relay is holding ${answer.files} files`);

  await guest.waitUntil((g) => g.snapshot !== null, "the sealed copy");
  const body = await guest.openSnapshot();
  const main = body.files.find((f) => f.path === "src/main.rs");
  if (!main || !main.text.includes(MARKER)) {
    fail("the copy did not contain what the guest was reading");
  } else {
    ok("the guest can still read the file, with the host gone");
  }

  // ---- and the relay still cannot read it -------------------------------
  const sealedText = Buffer.from(guest.snapshot).toString("latin1");
  if (sealedText.includes(MARKER) || sealedText.includes("main.rs")) {
    fail("the stored copy is not sealed — the relay can read it");
  } else {
    ok("the copy is sealed; the relay stores bytes it cannot read");
  }

  // ---- a guest with the wrong key gets nothing usable --------------------
  const impostor = new Guest(WS, session, "impostor", "A".repeat(43));
  await impostor.connect();
  impostor.fetchSnapshot();
  await impostor.waitUntil((g) => g.snapshot !== null, "the sealed copy");
  let opened = null;
  try {
    opened = await impostor.openSnapshot();
  } catch {
    opened = null;
  }
  if (opened) fail("the wrong key opened the stored copy");
  else ok("the wrong key cannot open it either");

  impostor.close();
  guest.close();
  finish(procs, "the folder survives the host's connection, sealed the whole way");
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

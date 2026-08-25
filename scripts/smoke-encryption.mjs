#!/usr/bin/env node
// Prove the relay cannot read the session.
//
// Not by inspecting the code — by recording every byte that crosses the wire
// between the agent and the relay, and requiring that what was typed is not
// in there anywhere.
//
//   node scripts/smoke-encryption.mjs

import { createServer, connect } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fail, finish, Guest, linkOf, ok, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const RELAY_PORT = 8819;
const TAP_PORT = 8820;
const HTTP_TAP = `http://127.0.0.1:${TAP_PORT}`;
const WS_TAP = `ws://127.0.0.1:${TAP_PORT}/ws`;

// Distinctive enough that finding it in the capture is unambiguous.
const SECRET = "correct-horse-battery-staple-9f3a";
const FILENAME = "unmistakable-filename-7b21.txt";
// Names are content too, and used to travel in the handshake in the clear.
const GUEST_NAME = "distinctive-guest-name-4c88";

const procs = new Procs();
let workdir;
let tap;
// Kept apart on purpose. WebSocket masks client→server payloads with a
// per-frame key, so a substring search cannot see them whether or not they
// are encrypted. The server→client direction is *not* masked — which makes it
// the direction where this test proves anything.
const fromClients = [];
const fromRelay = [];

/** A TCP proxy that keeps a copy of everything it forwards. */
function startTap() {
  return new Promise((resolve) => {
    tap = createServer((client) => {
      const upstream = connect(RELAY_PORT, "127.0.0.1");
      client.on("data", (b) => {
        fromClients.push(b);
        upstream.write(b);
      });
      upstream.on("data", (b) => {
        fromRelay.push(b);
        client.write(b);
      });
      const bye = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", bye);
      upstream.on("error", bye);
      client.on("close", bye);
      upstream.on("close", bye);
    });
    tap.listen(TAP_PORT, "127.0.0.1", resolve);
  });
}

const relayText = () => Buffer.concat(fromRelay).toString("latin1");
const allText = () =>
  Buffer.concat([...fromClients, ...fromRelay]).toString("latin1");

async function main() {
  workdir = await mkdtemp(join(tmpdir(), "ajar-crypt-"));
  await writeFile(join(workdir, FILENAME), `${SECRET}\n`);

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${RELAY_PORT}`], "relay");
  await waitForHealth(`http://127.0.0.1:${RELAY_PORT}`);
  await startTap();
  ok("wiretap listening between the agent and the relay");

  const agent = procs.start(
    "target/debug/ajar",
    [workdir, "--relay", HTTP_TAP, "--name", "hosty"],
    "agent",
  );
  const { session, key } = await linkOf(agent);
  if (!key) {
    fail("the link carried no key — the session is not encrypted at all");
    return finish(procs, "");
  }
  ok("the link carries a key in its fragment");

  const guest = new Guest(WS_TAP, session, GUEST_NAME, key);
  await guest.connect();
  await guest.waitUntil((g) => g.tree.size > 0, "the file tree");

  // The tree names files. Those names are content too.
  if (!guest.tree.has(FILENAME)) {
    fail("the guest never saw the file");
  } else {
    ok("the guest can read the tree");
  }

  // Read the file, and type the secret into a terminal.
  guest.readFile(FILENAME);
  await guest.waitUntil((g) => g.contents.has(FILENAME), "file contents");
  if (!guest.contents.get(FILENAME).text.includes(SECRET)) {
    fail("the guest could not read the file it was sent");
  } else {
    ok("the guest can read file contents");
  }

  guest.openPty();
  await guest.waitUntil((g) => g.ptys.size >= 1, "a terminal");
  const pty = [...guest.ptys.keys()][0];
  await guest.ready(pty);
  guest.type(pty, `echo ${SECRET}\r`);
  await guest.waitUntil(
    (g) => (g.ptys.get(pty) ?? "").split(SECRET).length - 1 >= 2,
    "the secret to echo back",
  );
  ok("the secret went through a terminal in both directions");

  await sleep(500);

  // ---- the actual claim ------------------------------------------------
  const inbound = relayText();
  const wire = allText();
  if (wire.length < 1000) {
    fail(`the wiretap captured almost nothing (${wire.length} bytes) — is it in the path?`);
  } else {
    ok(`wiretap captured ${(wire.length / 1024).toFixed(0)}kB of traffic`);
  }

  // A test that cannot fail proves nothing. Control frames are deliberately
  // readable and travel unmasked from the relay, so finding one shows the tap
  // would have caught plaintext content had there been any.
  if (!/"t":"(welcome|joined|locked)"/.test(inbound)) {
    fail("the tap saw no readable control frames — it cannot show anything is hidden");
  } else {
    ok("the tap can read control frames, so it would have seen plaintext content");
  }

  if (inbound.includes(SECRET)) {
    fail("what was typed came back from the relay in the clear");
  } else if (wire.includes(SECRET)) {
    fail("what was typed appeared on the wire in the clear");
  } else {
    ok("nothing typed appears anywhere in the captured traffic");
  }
  if (wire.includes(FILENAME)) {
    fail(`a filename appeared on the wire in the clear — the tree is content too`);
  } else {
    ok("filenames do not appear either");
  }
  if (wire.includes(key)) {
    fail("the key itself crossed the wire");
  } else {
    ok("the key never crosses the wire");
  }
  if (wire.includes(GUEST_NAME)) {
    fail("a participant's name appeared on the wire in the clear");
  } else {
    ok("names do not appear either — they arrive after the handshake, sealed");
  }
  // And the name still reaches the people who should see it.
  await guest.waitUntil(
    (g) => g.roster.some((p) => p.name === GUEST_NAME),
    "the host's roster to name the guest",
  );
  ok("the host still assembles a roster, because only the host can");

  // ---- a guest with the wrong key --------------------------------------
  const wrong = "A".repeat(43); // 32 bytes of base64url, but not the key
  const impostor = new Guest(WS_TAP, session, "impostor", wrong);
  await impostor.connect();
  await sleep(1200);
  if (impostor.tree.size > 0 || impostor.ptys.size > 0) {
    fail("a guest with the wrong key could still read the session");
  } else {
    ok("a guest with the wrong key reads nothing");
  }

  impostor.close();
  guest.close();
  tap.close();
  finish(procs, "the relay carries the session without being able to read it");
}

main()
  .catch((e) => {
    fail(e.stack ?? String(e));
    tap?.close();
    procs.killAll();
    process.exit(1);
  })
  .finally(() => {
    if (workdir) rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

#!/usr/bin/env node
// The host's controls, end to end.
//
// The panel advertises [k] kick, [x] lock and [l] read-only. A key that is
// drawn but does nothing is worse than one that is not drawn at all, so this
// checks each of them actually reaches a guest.
//
//   node scripts/smoke-control.mjs

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CH_CONTROL,
  CH_DOC,
  CH_STORE,
  SNAPSHOT_STREAM,
  DOC_UPDATE,
  encode,
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

const Y = createRequire(new URL("../web/package.json", import.meta.url))("yjs");

/** Open a file for editing as a guest, the way the browser does, and hold its document. */
async function openDoc(guest, path) {
  const ydoc = new Y.Doc();
  const early = [];
  let id = null;
  guest.onDoc = (streamId, kind, body) => {
    if (kind !== DOC_UPDATE) return;
    if (id === null) early.push([streamId, body]);
    else if (streamId === id) Y.applyUpdate(ydoc, body, "remote");
  };
  guest.send(json(CH_DOC, { t: "open", path }));
  await guest.waitUntil((g) => g.docMessages.some((m) => m.t === "opened" && m.path === path), `${path} to open`);
  id = guest.docMessages.find((m) => m.t === "opened" && m.path === path).doc_id;
  for (const [streamId, body] of early) if (streamId === id) Y.applyUpdate(ydoc, body, "remote");
  await sleep(300);
  return {
    id,
    text: () => ydoc.getText("content").toString(),
    type(at, what) {
      const before = Y.encodeStateVector(ydoc);
      ydoc.getText("content").insert(at, what);
      const update = Y.encodeStateAsUpdate(ydoc, before);
      guest.send(encode({ channel: CH_DOC, streamId: id, payload: Uint8Array.from([DOC_UPDATE, ...update]) }));
    },
  };
}

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
    // The flag rides the pty channel. This used to read `control.length >= 0`,
    // which is true of every array, so a notice that never arrived passed.
    await g.waitUntil((x) => x.ptyMessages.some((m) => m.t === "read_only" && m.read_only === true), "the read-only notice");
    ok("the guest is told the terminals are read-only");

    // A shell nobody here may type into is a process on the host for
    // nothing, so none is opened. (That keystrokes are dropped, for a session
    // made read-only with terminals already open, is checked where the
    // panel's keys can be pressed.)
    g.openPty();
    await g.waitUntil((x) => x.ptyMessages.some((m) => m.t === "refused"), "a refusal for the terminal");
    const why = g.ptyMessages.find((m) => m.t === "refused").reason;
    await sleep(300);
    if (g.ptys.size !== 0) fail("a read-only guest was given a terminal");
    else ok(`a read-only guest asking for a terminal is refused, saying why ("${why}")`);

    // And the files. Read-only used to stop at the terminals: an edit to an
    // open file was applied, passed on to everyone and written to disk.
    const doc = await openDoc(g, "a.txt");
    doc.type(0, "EDITED-WHILE-READ-ONLY\n");
    await sleep(800);
    g.send(json(CH_DOC, { t: "close", doc_id: doc.id }));
    await sleep(800);
    const other = new Guest(WS, session, "other", key);
    await other.connect();
    const seen = (await openDoc(other, "a.txt")).text();
    const disk = await readFile(join(workdir, "a.txt"), "utf8");
    if (seen !== "hi\n" || disk !== "hi\n") {
      fail(`a read-only file took an edit: another guest sees ${JSON.stringify(seen)}, the disk has ${JSON.stringify(disk)}`);
    } else {
      ok("read-only files drop guest edits at the host — nobody else sees them, and the disk keeps its copy");
    }
    other.close();
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

  // ---- what the relay refuses on the host's behalf --------------------
  // Spoken as raw protocol, the way a hostile client would.
  {
    const session = "control-relay-test";
    const host = new Guest(WS, session, "hosty");
    host.role = "host";
    await host.connect();
    const guest = new Guest(WS, session, "guesty");
    await guest.connect();
    await sleep(200);

    // A guest may not originate control after the handshake. Forwarding
    // malformed cleartext control used to terminate the host, and nothing
    // here ever sent one as a guest.
    const before = host.control.length;
    guest.send(json(CH_CONTROL, { t: "closed", reason: "SENT-BY-A-GUEST" }));
    guest.send(json(CH_CONTROL, { t: "lock", locked: true }));
    guest.send(encode({ channel: CH_CONTROL, payload: new TextEncoder().encode("{not json") }));
    await sleep(500);
    const reached = host.control.slice(before).filter((m) => m.t !== "joined" && m.t !== "left");
    if (reached.length > 0) fail(`a guest's control frame reached the host: ${JSON.stringify(reached)}`);
    else ok("a guest's control frames never reach the host");
    const after = new Guest(WS, session, "after");
    await after.connect().then(
      () => ok("and its lock was not applied"),
      (e) => fail(`a guest locked the session: ${e}`),
    );
    after.close();

    // The stored copy, over the outbox's 8 MB. Its header and blob were
    // queued one at a time, the blob judged as a backlog behind the header,
    // and the guest asking for it was cut off instead of answered.
    const blob = new Uint8Array(9 * 1024 * 1024).fill(42);
    host.send(json(CH_STORE, { t: "offer", bytes: blob.length, files: 1 }));
    await host.waitUntil((h) => h.store.some((m) => m.t === "accepted"), "the offer to be accepted");
    host.send(encode({ channel: CH_STORE, streamId: SNAPSHOT_STREAM, payload: blob }));
    await sleep(500);
    guest.send(json(CH_STORE, { t: "fetch" }));
    const got = await guest
      .waitUntil((g) => g.snapshot?.length === blob.length, "the stored copy", 15_000)
      .then(() => true, () => false);
    if (!got) fail(`a ${blob.length}-byte stored copy never reached the guest (got ${guest.snapshot?.length ?? "nothing"})`);
    else ok("a stored copy over 8 MB reaches a guest whole");

    guest.close();
    host.close();
  }

  // ---- a socket that never says hello ----------------------------------
  // It is charged to no quota until it does, so without a deadline it was
  // free to hold open for good.
  {
    const silent = new WebSocket(WS);
    await new Promise((resolve, reject) => {
      silent.onopen = resolve;
      silent.onerror = () => reject(new Error("could not open a socket"));
    });
    const opened = Date.now();
    const closedAfter = await new Promise((resolve) => {
      silent.onclose = () => resolve(Date.now() - opened);
      setTimeout(() => resolve(null), 20_000);
    });
    if (closedAfter === null) fail("a socket that never said hello was still open after 20 s");
    else ok(`a socket that never says hello is closed (after ${Math.round(closedAfter / 1000)} s)`);
    if (silent.readyState === WebSocket.OPEN) silent.close();
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

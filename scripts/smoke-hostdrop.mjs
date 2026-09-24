#!/usr/bin/env node
// The host's connection drops and comes back inside the grace period.
//
// This is the most ordinary failure there is — wifi hands over, a laptop lid
// closes for ten seconds — and the one no suite covered. smoke-sync kills the
// host outright; smoke-reconnect kills the relay, so every guest reconnects
// too and is rebuilt from scratch. Here only the host's socket goes away: the
// agent process keeps running, the guests stay connected to the relay, and
// everything that happened in between has to be put back.
//
// What travels during the gap is dropped rather than queued, by design. So the
// claim under test is that nothing *stays* lost once the host is back:
//
//   - a guest's typing during the gap reaches the file, and every editor
//   - typing after the host returns is not stuck behind what was missed
//   - a file changed on disk during the gap reaches the editors
//   - a file created during the gap appears in the tree
//   - someone who joined during the gap gets a tree and a name
//   - someone who left during the gap stops being listed
//
//   node scripts/smoke-hostdrop.mjs

import { createServer, connect } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import {
  CH_DOC,
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

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const Y = webRequire("yjs");

const PORT = 8825;
const PROXY_PORT = 8826;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

const procs = new Procs();
let workdir;

/**
 * A TCP hop between the agent and the relay that can be cut.
 *
 * Only the agent goes through it, so cutting it drops the host and nobody
 * else — which is what a host's wifi dropping looks like from the relay.
 * While cut it refuses new connections too, so the agent's reconnects fail
 * until the gap is over, the way they would with no network at all.
 */
function cuttableProxy(listenPort, targetPort) {
  const live = new Set();
  let cut = false;
  const server = createServer((down) => {
    if (cut) {
      down.destroy();
      return;
    }
    const up = connect(targetPort, "127.0.0.1");
    const pair = { down, up };
    live.add(pair);
    const end = () => {
      down.destroy();
      up.destroy();
      live.delete(pair);
    };
    down.on("error", end).on("close", end);
    up.on("error", end).on("close", end);
    down.pipe(up);
    up.pipe(down);
  });
  return {
    listen: () => new Promise((r) => server.listen(listenPort, "127.0.0.1", r)),
    cut() {
      cut = true;
      for (const { down, up } of live) {
        down.destroy();
        up.destroy();
      }
      live.clear();
    },
    restore() {
      cut = false;
    },
    close: () => server.close(),
  };
}

/**
 * A guest with a document bound, doing what the browser client does —
 * including on `host_back`, where it hands the host its whole state. Yjs
 * updates are idempotent, so resending everything it has is safe, and it is
 * the only way the typing that fell into the gap gets anywhere.
 */
class Editor {
  constructor(guest) {
    this.guest = guest;
    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText("content");
    this.docId = null;
    this.ydoc.on("update", (update, origin) => {
      if (origin === "remote" || this.docId === null) return;
      this.sendUpdate(update);
    });
    // One router per guest, so a guest can hold several documents: each
    // binary frame goes to whichever editor owns its stream, and frames that
    // arrive before `opened` names the stream wait for it.
    if (!guest.editors) {
      guest.editors = new Map();
      guest.early = [];
      guest.onDoc = (streamId, kind, body) => {
        const ed = guest.editors.get(streamId);
        if (!ed) return void guest.early.push([streamId, kind, body]);
        if (kind === DOC_UPDATE) Y.applyUpdate(ed.ydoc, body, "remote");
      };
    }
    const seen = guest.control.length;
    this.handled = 0;
    this.watch = setInterval(() => {
      for (const m of guest.control.slice(seen + this.handled)) {
        this.handled += 1;
        if (m.t === "host_back" && this.docId !== null) {
          this.sendUpdate(Y.encodeStateAsUpdate(this.ydoc));
        }
      }
    }, 20);
  }

  sendUpdate(update) {
    this.guest.send(
      encode({ channel: CH_DOC, streamId: this.docId, payload: Uint8Array.from([DOC_UPDATE, ...update]) }),
    );
  }

  async open(path) {
    this.guest.send(json(CH_DOC, { t: "open", path }));
    await this.guest.waitUntil(
      (g) => g.docMessages.some((m) => m.t === "opened" && m.path === path),
      `${path} to open`,
    );
    this.docId = this.guest.docMessages.find((m) => m.t === "opened" && m.path === path).doc_id;
    this.guest.editors.set(this.docId, this);
    const early = this.guest.early.splice(0);
    for (const [id, kind, body] of early) {
      if (id === this.docId && kind === DOC_UPDATE) Y.applyUpdate(this.ydoc, body, "remote");
      else this.guest.early.push([id, kind, body]);
    }
    await sleep(250);
  }

  get text() {
    return this.ytext.toString();
  }

  close() {
    clearInterval(this.watch);
  }
}

async function onDisk(file, needle, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = await readFile(file, "utf8");
    if (text.includes(needle)) return text;
    await sleep(100);
  }
  return text;
}

const names = (g) => g.roster.map((p) => p.name).sort();

async function main() {
  workdir = await mkdtemp(join(tmpdir(), "ajar-hostdrop-"));
  const note = join(workdir, "note.txt");
  const other = join(workdir, "other.txt");
  await writeFile(note, "one two three\n");
  await writeFile(other, "before the gap\n");

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);
  const proxy = cuttableProxy(PROXY_PORT, PORT);
  await proxy.listen();
  const agent = procs.start(
    "target/debug/ajar",
    [workdir, "--relay", `http://127.0.0.1:${PROXY_PORT}`, "--name", "hosty"],
    "agent",
  );
  const { session, key } = await linkOf(agent);

  const ga = new Guest(WS, session, "ana", key);
  const gb = new Guest(WS, session, "bo", key);
  const gd = new Guest(WS, session, "dee", key);
  await ga.connect();
  await gb.connect();
  await gd.connect();
  await ga.waitUntil((g) => names(g).includes("dee"), "the roster to list everyone");
  const a = new Editor(ga);
  const b = new Editor(gb);
  await a.open("note.txt");
  await b.open("note.txt");
  const bOther = new Editor(gb);
  await bOther.open("other.txt");
  await gb.waitUntil(() => bOther.text.includes("before the gap"), "other.txt's contents");
  if (a.text !== "one two three\n" || b.text !== a.text) {
    fail(`the editors did not start from the file: ${JSON.stringify([a.text, b.text])}`);
  }
  ok("three guests in, two editing, before anything goes wrong");

  // ---- the gap ------------------------------------------------------------
  proxy.cut();
  await ga.waitUntil((g) => g.control.some((m) => m.t === "host_away"), "host_away");
  ok("the host's connection dropped; guests are told it is away");

  a.ytext.insert(0, "GAP-EDIT ");
  await writeFile(other, "rewritten during the gap\n");
  await writeFile(join(workdir, "gap.txt"), "made while the host was away\n");
  gd.close();
  const gc = new Guest(WS, session, "cy", key);
  await gc.connect();
  await sleep(1500);
  proxy.restore();

  await ga.waitUntil((g) => g.control.some((m) => m.t === "host_back"), "host_back", 30_000);
  ok("the host came back inside its grace period");
  await sleep(1500);

  // ---- nothing stays lost -------------------------------------------------
  const noteText = await onDisk(note, "GAP-EDIT");
  if (!noteText.includes("GAP-EDIT")) fail(`typing from the gap never reached the file: ${JSON.stringify(noteText)}`);
  else ok("typing from the gap reached the file");

  await gb.waitUntil(() => b.text.includes("GAP-EDIT"), "the gap edit to reach bo", 5000).catch(() => {});
  if (!b.text.includes("GAP-EDIT")) fail(`the other editor never saw the gap edit: ${JSON.stringify(b.text)}`);
  else ok("the other editor has it too");

  a.ytext.insert(a.text.length, "AFTER-EDIT");
  const after = await onDisk(note, "AFTER-EDIT");
  if (!after.includes("AFTER-EDIT")) fail(`typing after the host returned is stuck: ${JSON.stringify(after)}`);
  else ok("typing after the host returned is not stuck behind what was missed");
  await gb.waitUntil(() => b.text.includes("AFTER-EDIT"), "bo to see it", 5000).catch(() => {});
  if (a.text !== b.text) fail(`the editors diverged:\n    ana: ${JSON.stringify(a.text)}\n    bo:  ${JSON.stringify(b.text)}`);
  else ok("both editors agree");

  await gb.waitUntil(() => bOther.text.includes("rewritten during the gap"), "the disk change", 5000).catch(() => {});
  if (!bOther.text.includes("rewritten during the gap")) {
    fail(`a file rewritten on disk during the gap never reached its editor: ${JSON.stringify(bOther.text)}`);
  } else {
    ok("a file rewritten on disk during the gap reached its editor");
  }

  await ga.waitUntil((g) => g.tree.has("gap.txt"), "gap.txt in the tree", 5000).catch(() => {});
  if (!ga.tree.has("gap.txt")) fail("a file created during the gap never appeared in the tree");
  else ok("a file created during the gap appears in the tree");

  // The browser re-introduces itself on host_back, as the client under test.
  gc.send(json(0x04, { t: "iam", name: "cy" }));
  // A whole tree, not a non-empty one. A patch for a file somebody saved
  // meanwhile also makes the mirrored tree non-empty, and the first draft of
  // this check passed on exactly that while no tree had been sent at all.
  const everything = ["note.txt", "other.txt", "gap.txt"];
  const hasWholeTree = (g) =>
    g.fs.some((m) => m.t === "tree") && everything.every((p) => g.tree.has(p));
  await gc.waitUntil(hasWholeTree, "cy's tree", 5000).catch(() => {});
  if (!hasWholeTree(gc)) {
    fail(`someone who joined during the gap never got the tree: ${[...gc.tree.keys()]}`);
  } else {
    ok("someone who joined during the gap got the whole tree");
  }

  await ga.waitUntil((g) => names(g).includes("cy") && !names(g).includes("dee"), "the roster to settle", 5000).catch(() => {});
  const roster = names(ga);
  if (!roster.includes("cy")) fail(`someone who joined during the gap is missing from the roster: ${roster}`);
  else ok("someone who joined during the gap is in the roster");
  if (roster.includes("dee")) fail(`someone who left during the gap is still listed: ${roster}`);
  else ok("someone who left during the gap is no longer listed");

  a.close();
  b.close();
  bOther.close();
  for (const g of [ga, gb, gc]) g.close();
  proxy.close();
  finish(procs, "a host's blip loses nothing that anyone can see");
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

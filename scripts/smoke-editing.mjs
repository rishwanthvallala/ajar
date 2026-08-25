#!/usr/bin/env node
// Collaborative editing, end to end.
//
// The unit tests prove the diff and the document registry. This proves the
// part that can only fail in combination: two people editing one file while
// the terminal next to them rewrites it on disk.
//
//   node scripts/smoke-editing.mjs

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Y from "../web/node_modules/yjs/dist/yjs.mjs";
import {
  CH_DOC,
  DOC_AWARENESS,
  DOC_UPDATE,
  encode,
  fail,
  finish,
  Guest,
  linkOf,
  json,
  ok,
  Procs,
  sleep,
  waitForHealth,
} from "./lib/wire.mjs";

const PORT = 8808;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

const procs = new Procs();
let workdir;

/** A guest with a Yjs document bound to it, the way the browser has one. */
class Editor {
  constructor(guest) {
    this.guest = guest;
    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText("content");
    this.docId = null;
    this.awarenessSeen = 0;
    this.ydoc.on("update", (update, origin) => {
      if (origin === "remote" || this.docId === null) return;
      this.guest.send(
        encode({
          channel: CH_DOC,
          streamId: this.docId,
          payload: Uint8Array.from([DOC_UPDATE, ...update]),
        }),
      );
    });
    // The host sends the full state right after `opened`, which can land
    // before the id is known — the same race the browser client has.
    this.early = [];
    guest.onDoc = (streamId, kind, body) => {
      if (this.docId === null) {
        this.early.push([streamId, kind, body]);
        return;
      }
      if (streamId !== this.docId) return;
      this.absorb(kind, body);
    };
  }

  async open(path) {
    this.guest.send(json(CH_DOC, { t: "open", path }));
    await this.guest.waitUntil(
      (g) => g.docMessages.some((m) => m.t === "opened" && m.path === path),
      `${path} to open for editing`,
    );
    this.docId = this.guest.docMessages.find((m) => m.t === "opened" && m.path === path).doc_id;
    for (const [streamId, kind, body] of this.early.splice(0)) {
      if (streamId === this.docId) this.absorb(kind, body);
    }
    // The full state follows the `opened` message.
    await sleep(250);
    return this.docId;
  }

  absorb(kind, body) {
    if (kind === DOC_UPDATE) Y.applyUpdate(this.ydoc, body, "remote");
    else this.awarenessSeen++;
  }

  get text() {
    return this.ytext.toString();
  }

  type(index, text) {
    this.ytext.insert(index, text);
  }
}

async function main() {
  workdir = await mkdtemp(join(tmpdir(), "ajar-editing-"));
  const file = join(workdir, "note.txt");
  await writeFile(file, "one two three\n");
  await writeFile(join(workdir, "logo.png"), Buffer.from([0x89, 0x50, 0, 1, 2]));

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);
  const agent = procs.start(
    "target/debug/ajar",
    [workdir, "--relay", HTTP, "--name", "hosty"],
    "agent",
  );
  const { session, key } = await linkOf(agent);

  const ga = new Guest(WS, session, "ana", key);
  const gb = new Guest(WS, session, "bo", key);
  await ga.connect();
  await gb.connect();
  const a = new Editor(ga);
  const b = new Editor(gb);

  // ---- both open the same file ----------------------------------------
  const idA = await a.open("note.txt");
  const idB = await b.open("note.txt");
  if (idA !== idB) fail(`one file should be one document: ${idA} vs ${idB}`);
  else ok(`both opened note.txt as document ${idA}`);

  if (a.text !== "one two three\n" || b.text !== "one two three\n") {
    fail(`initial state wrong: ${JSON.stringify([a.text, b.text])}`);
  } else {
    ok("both received the file's contents");
  }

  // ---- an edit reaches the other person --------------------------------
  a.type(3, " AND-A-HALF");
  await gb.waitUntil(() => b.text.includes("AND-A-HALF"), "ana's edit to reach bo");
  ok("an edit reached the other editor");

  // ---- and reaches the disk -------------------------------------------
  await ga.waitUntil(
    async () => (await readFile(file, "utf8")).includes("AND-A-HALF"),
    "the edit to be written back",
    8000,
  ).catch(() => {});
  let onDisk = await readFile(file, "utf8");
  if (!onDisk.includes("AND-A-HALF")) {
    // waitUntil takes a sync predicate; poll explicitly.
    for (let i = 0; i < 40 && !onDisk.includes("AND-A-HALF"); i++) {
      await sleep(100);
      onDisk = await readFile(file, "utf8");
    }
  }
  if (!onDisk.includes("AND-A-HALF")) fail(`the file was never written: ${JSON.stringify(onDisk)}`);
  else ok("the edit was written back to the file");

  // ---- concurrent edits converge --------------------------------------
  const before = a.text;
  a.type(0, "<<");
  b.type(b.text.length, ">>");
  await sleep(1200);
  if (a.text !== b.text) {
    fail(`concurrent edits diverged:\n    ana: ${JSON.stringify(a.text)}\n    bo:  ${JSON.stringify(b.text)}`);
  } else if (!a.text.startsWith("<<") || !a.text.trimEnd().endsWith(">>")) {
    fail(`an edit was lost: ${JSON.stringify(a.text)} (was ${JSON.stringify(before)})`);
  } else {
    ok("simultaneous edits converged, neither lost");
  }

  // ---- the terminal rewrites the file underneath them ------------------
  // This is the case that makes ajar different from an editor: the disk is
  // not the document's private property.
  ga.openPty();
  await ga.waitUntil((g) => g.ptys.size >= 1, "a terminal");
  const [pty] = [...ga.ptys.keys()];
  await ga.ready(pty);
  ga.type(pty, `printf 'rewritten by the terminal\\n' > note.txt\r`);

  await ga.waitUntil(
    () => a.text.includes("rewritten by the terminal"),
    "the terminal's write to reach the editors",
    10_000,
  );
  if (b.text !== a.text) {
    fail(`only one editor saw the external change:\n    ana: ${JSON.stringify(a.text)}\n    bo:  ${JSON.stringify(b.text)}`);
  } else {
    ok("a write from the terminal reached both editors");
  }

  // ---- the write-back loop terminates ---------------------------------
  // If reconciling marked the document dirty, the agent would write it back,
  // see its own write, reconcile again, and never stop.
  const settled = await readFile(file, "utf8");
  await sleep(1500);
  const stillSettled = await readFile(file, "utf8");
  if (settled !== stillSettled) fail("the file kept changing on its own — write-back is looping");
  else ok("the file settled — no write-back loop");

  // ---- editing something that cannot be edited ------------------------
  gb.send(json(CH_DOC, { t: "open", path: "logo.png" }));
  await gb.waitUntil(
    (g) => g.docMessages.some((m) => m.t === "error" && m.path === "logo.png"),
    "a refusal for the binary file",
  );
  ok("a binary file is refused rather than corrupted");

  // ---- awareness travels ----------------------------------------------
  ga.send(
    encode({
      channel: CH_DOC,
      streamId: idA,
      payload: Uint8Array.from([DOC_AWARENESS, 1, 2, 3]),
    }),
  );
  await gb.waitUntil(() => b.awarenessSeen > 0, "an awareness update to reach bo");
  ok("awareness updates are relayed without being interpreted");

  ga.close();
  gb.close();
  finish(procs, "editing works: two people, one file, and a terminal writing underneath");
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

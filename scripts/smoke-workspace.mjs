#!/usr/bin/env node
// Workspace test: the file tree a guest sees, and how it keeps up.
//
// Covers the parts of weeks 5-6 that unit tests can't reach — a real watcher,
// on a real directory, with a real install-shaped burst of churn.
//
//   node scripts/smoke-workspace.mjs

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fail, finish, Guest, linkOf, ok, Procs, waitForHealth } from "./lib/wire.mjs";

const PORT = 8790;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

const procs = new Procs();
let workdir;

async function main() {
  workdir = await mkdtemp(join(tmpdir(), "ajar-workspace-"));

  // A project shaped like a real one: source, a dependency directory that
  // must never be shared, and a gitignore that hides something else.
  await mkdir(join(workdir, "src"), { recursive: true });
  await mkdir(join(workdir, "node_modules", "react"), { recursive: true });
  await mkdir(join(workdir, "secrets"), { recursive: true });
  await writeFile(join(workdir, "src", "main.rs"), "fn main() {}\n");
  await writeFile(join(workdir, "README.md"), "# hello\n");
  await writeFile(join(workdir, ".gitignore"), "secrets/\n");
  await writeFile(join(workdir, "secrets", "key.pem"), "PRIVATE\n");
  await writeFile(join(workdir, "node_modules", "react", "index.js"), "module.exports={}\n");
  await writeFile(join(workdir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);

  const agent = procs.start(
    "target/debug/ajar",
    [workdir, "--relay", HTTP, "--name", "hosty"],
    "agent",
  );

  const { session, key } = await linkOf(agent);

  const guest = new Guest(WS, session, "smoke", key);
  await guest.connect();
  await guest.waitUntil((g) => g.tree.size > 0, "the initial tree");
  ok(`tree arrived with ${guest.tree.size} entries`);

  // ---- what's in it, and what isn't -----------------------------------
  const has = (p) => guest.tree.has(p);
  if (!has("src/main.rs") || !has("README.md")) {
    fail(`source files missing from the tree: ${[...guest.tree.keys()].join(", ")}`);
  } else {
    ok("source files are present");
  }
  if (!has(".gitignore")) {
    fail("dotfiles should be visible — a project wants its .gitignore shown");
  } else {
    ok("dotfiles are visible");
  }

  const leaked = [...guest.tree.keys()].filter(
    (p) => p.startsWith("node_modules") || p.startsWith("secrets"),
  );
  if (leaked.length) {
    fail(`ignored paths leaked into the tree: ${leaked.join(", ")}`);
  } else {
    ok("dependencies and gitignored paths stayed out");
  }

  // ---- reading ---------------------------------------------------------
  guest.readFile("src/main.rs");
  await guest.waitUntil((g) => g.contents.has("src/main.rs"), "file content");
  const content = guest.contents.get("src/main.rs");
  if (content.t !== "content" || !content.text.includes("fn main")) {
    fail(`unexpected content: ${JSON.stringify(content)}`);
  } else {
    ok("read a text file");
  }

  guest.readFile("logo.png");
  await guest.waitUntil((g) => g.contents.has("logo.png"), "binary response");
  const png = guest.contents.get("logo.png");
  if (!png.binary || png.text !== "") {
    fail(`binary file should be flagged, not shipped: ${JSON.stringify(png).slice(0, 120)}`);
  } else {
    ok("binary file was flagged, not shipped");
  }

  guest.readFile("../../../etc/passwd");
  await guest.waitUntil((g) => g.contents.has("../../../etc/passwd"), "an escape refusal");
  if (guest.contents.get("../../../etc/passwd").t !== "read_error") {
    fail("a path escaping the workspace should be refused");
  } else {
    ok("path traversal was refused");
  }

  // ---- the watcher -----------------------------------------------------
  await writeFile(join(workdir, "src", "added.rs"), "// new\n");
  await guest.waitUntil((g) => g.tree.has("src/added.rs"), "a patch adding a file");
  ok("a new file arrived as a patch");

  await rm(join(workdir, "src", "added.rs"));
  await guest.waitUntil((g) => !g.tree.has("src/added.rs"), "a patch removing a file");
  ok("a deleted file arrived as a patch");

  // Writing into an ignored directory must produce nothing at all. This is
  // the case that floods every guest if the watcher and scanner disagree.
  const before = guest.fs.length;
  for (let i = 0; i < 40; i++) {
    await writeFile(join(workdir, "node_modules", "react", `f${i}.js`), "x");
  }
  await new Promise((r) => setTimeout(r, 900));
  if (guest.fs.length !== before) {
    fail(`writes into node_modules produced ${guest.fs.length - before} fs messages`);
  } else {
    ok("churn inside ignored directories was silent");
  }

  // ---- the resync escape hatch ----------------------------------------
  // Past ~500 paths in one flush the host stops describing deltas and sends
  // a fresh tree instead. There is no separate "resync" message: a tree
  // already means replace everything.
  const treesBefore = guest.fs.filter((m) => m.t === "tree").length;
  const BURST = 3000;
  await mkdir(join(workdir, "generated"), { recursive: true });
  await Promise.all(
    Array.from({ length: BURST }, (_, i) =>
      writeFile(join(workdir, "generated", `f${i}.txt`), String(i)),
    ),
  );

  await guest.waitUntil(
    (g) => g.fs.filter((m) => m.t === "tree").length > treesBefore,
    "a rebuilt tree after an install-sized burst",
    25_000,
  );
  ok("an install-sized burst produced a fresh tree, not thousands of deltas");

  await guest.waitUntil(
    (g) => g.tree.has(`generated/f${BURST - 1}.txt`),
    "the rebuilt tree to contain every new file",
    25_000,
  );
  ok(`the rebuilt tree is complete (${guest.tree.size} entries)`);

  // The cooldown should keep a sustained burst from re-sending the whole
  // tree on every flush.
  const trees = guest.fs.filter((m) => m.t === "tree").length - treesBefore;
  if (trees > 6) {
    fail(`${trees} full trees for one burst — the resync cooldown isn't holding`);
  } else {
    ok(`the burst cost ${trees} full ${trees === 1 ? "tree" : "trees"}, not one per flush`);
  }

  guest.close();
  finish(procs, "workspace works: scan, ignore rules, patches, resync");
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

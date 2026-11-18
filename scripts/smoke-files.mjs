#!/usr/bin/env node
// What a guest's page asks the host's ajar to do to the folder, on the wire:
// make a file or a folder, rename and move, remove, upload, search every
// file's text, replace what was found, and send a file's bytes to look at.
//
// Since 0.0.9 the agent does these for a guest, outside the sandbox its
// shell is in. So besides that each works, this is what each must refuse:
// anything outside the folder, anything the tree hides, anything through a
// link — and all of it, for everyone, while the host has the session
// read-only. The unit tests hold `fileops` to the same (crates/ajar); this
// is a real agent, a real relay, and the frames a page would send.
//
//   cargo build && node scripts/smoke-files.mjs

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CH_FS, CH_PTY, fail, finish, Guest, json, linkOf, ok, Procs, sleep, startAgentInPanel, waitForHealth } from "./lib/wire.mjs";

const PORT = 8856;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

const procs = new Procs();
let workdir;
let outside;

function check(cond, msg, detail = "") {
  if (cond) ok(msg);
  else fail(`${msg}${detail ? ` — ${detail}` : ""}`);
  return cond;
}

const sum = (text) => createHash("sha256").update(text).digest("hex");
const exists = (rel) => existsSync(join(workdir, rel));
const read = (rel) => readFile(join(workdir, rel), "utf8");

async function main() {
  const base = await mkdtemp(join(tmpdir(), "ajar-files-"));
  workdir = join(base, "project");
  outside = join(base, "outside");
  await mkdir(join(workdir, "src", "nested"), { recursive: true });
  await mkdir(join(workdir, ".git"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "theirs.txt"), "the host's own\n");
  await writeFile(join(workdir, "main.py"), "print('alpha')\n");
  await writeFile(join(workdir, "src", "one.py"), "alpha ALPHA alphabet\r\nprint('two')\r\n");
  await writeFile(join(workdir, "src", "nested", "two.txt"), "alpha\n");
  await writeFile(join(workdir, "notes.md"), "a cat and a concatenation\n");
  await writeFile(join(workdir, ".gitignore"), "secret.env\n");
  await writeFile(join(workdir, "secret.env"), "KEY=alpha\n");
  await writeFile(join(workdir, ".git", "config"), "[core]\n");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await writeFile(join(workdir, "dot.png"), png);
  await symlink(outside, join(workdir, "out"));

  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);
  // In its panel, so that `l` can make the session read-only part way through.
  const agent = startAgentInPanel(procs, [workdir, "--relay", HTTP, "--name", "hosty"]);
  const { session, key } = await linkOf(agent, 20_000);

  const guest = new Guest(WS, session, "ana", key);
  await guest.connect();
  await guest.waitUntil((g) => g.tree.size > 0, "the initial tree");
  await guest.waitUntil((g) => g.presence.some((m) => m.t === "roster"), "the roster");

  // ---- what the host says it can do ----------------------------------------
  const roster = guest.presence.findLast((m) => m.t === "roster");
  check(
    Array.isArray(roster.can) && ["write", "search", "bytes"].every((c) => roster.can.includes(c)),
    "the roster says what this host does for a guest's page",
    JSON.stringify(roster.can),
  );

  // ---- making ---------------------------------------------------------------
  let done = await guest.fileOp({ t: "make", path: "src/deep/new.py", dir: false });
  await guest.waitUntil((g) => g.tree.has("src/deep/new.py"), "the new file in the tree").catch(() => {});
  check(
    done.ok && exists("src/deep/new.py") && (await read("src/deep/new.py")) === "" && guest.tree.has("src/deep") && guest.tree.get("src/deep/new.py")?.kind === "file",
    "a file is made, empty, with the folders on the way to it — and is in the tree as the answer comes",
    JSON.stringify(done),
  );
  done = await guest.fileOp({ t: "make", path: "docs", dir: true });
  await guest.waitUntil((g) => g.tree.has("docs"), "the new folder in the tree").catch(() => {});
  check(done.ok && (await stat(join(workdir, "docs"))).isDirectory() && guest.tree.get("docs")?.kind === "dir", "and a folder");
  done = await guest.fileOp({ t: "make", path: "main.py", dir: false });
  check(!done.ok && /already/.test(done.message) && (await read("main.py")) === "print('alpha')\n", "a name that is taken is refused, and what has it is left as it was", done.message);

  // ---- renaming and moving ---------------------------------------------------
  done = await guest.fileOp({ t: "rename", from: "notes.md", to: "docs/notes.md", replace: false });
  await guest.waitUntil((g) => g.tree.has("docs/notes.md") && !g.tree.has("notes.md"), "the move in the tree").catch(() => {});
  check(
    done.ok && !exists("notes.md") && (await read("docs/notes.md")) === "a cat and a concatenation\n" && guest.fs.some((m) => m.t === "moved" && m.from === "notes.md" && m.to === "docs/notes.md"),
    "a file is moved, and every page is told where it went",
    JSON.stringify(done),
  );
  done = await guest.fileOp({ t: "rename", from: "src/nested/two.txt", to: "main.py", replace: false });
  check(!done.ok && /already a file/.test(done.message) && exists("src/nested/two.txt"), "onto a file that is there it is refused", done.message);
  done = await guest.fileOp({ t: "rename", from: "src", to: "lib", replace: false });
  await guest.waitUntil((g) => g.tree.has("lib/one.py") && !g.tree.has("src/one.py"), "the folder's move in the tree").catch(() => {});
  check(done.ok && exists("lib/nested/two.txt") && !exists("src") && guest.tree.has("lib/deep/new.py"), "a folder moves with everything in it, and the tree follows");
  done = await guest.fileOp({ t: "rename", from: "lib", to: "lib/inside", replace: false });
  check(!done.ok && /inside itself/.test(done.message), "but never into itself", done.message);

  // ---- uploading --------------------------------------------------------------
  const big = randomBytes(3 * 1024 * 1024 + 123);
  done = await guest.putFile("assets/big.bin", big);
  check(
    done.ok && Buffer.compare(await readFile(join(workdir, "assets", "big.bin")), big) === 0 && guest.fs.some((m) => m.t === "got"),
    "an upload of 3 MB arrives whole, a window at a time against the host's acknowledgements",
    JSON.stringify(done),
  );
  done = await guest.putFile("assets/big.bin", Buffer.from("smaller"));
  check(!done.ok && /already a file/.test(done.message) && (await stat(join(workdir, "assets", "big.bin"))).size === big.length, "over a file that is there it is refused unless told to replace", done.message);
  done = await guest.putFile("assets/big.bin", Buffer.from("smaller"), true);
  check(done.ok && (await read("assets/big.bin")) === "smaller", "and told to, replaces it");
  done = await guest.putFile("empty.txt", Buffer.alloc(0));
  check(done.ok && (await read("empty.txt")) === "", "an empty file uploads too");
  // More than was announced: the upload is dropped, and nothing of it kept.
  {
    const id = 9001;
    guest.send(json(CH_FS, { t: "put", id, path: "lying.bin", bytes: 4, replace: false }));
    await guest.waitUntil((g) => g.fs.some((m) => m.t === "taking" && m.id === id), "the lying upload to be taken");
    const { encode } = await import("./lib/wire.mjs");
    guest.send(encode({ channel: CH_FS, streamId: id, payload: Buffer.from("far more than four") }));
    await guest.waitUntil((g) => g.fs.some((m) => m.t === "done" && m.id === id), "the lying upload to be answered");
    const answer = guest.fs.find((m) => m.t === "done" && m.id === id);
    check(!answer.ok && !exists("lying.bin"), "an upload that sends more than it announced is dropped", answer.message);
  }
  done = await guest.fileOp({ t: "put", path: "huge.bin", bytes: 51 * 1024 * 1024, replace: false });
  check(!done.ok && /at most/.test(done.message), "and one over the limit is refused before a byte of it is sent", done.message);

  // ---- searching ----------------------------------------------------------------
  let found = await guest.find("alpha");
  const paths = found.groups.map((g) => g.path);
  check(
    JSON.stringify(paths) === JSON.stringify(["lib/nested/two.txt", "lib/one.py", "main.py"]) && !found.truncated,
    "a search finds the text in every file the tree shows, and in nothing it hides",
    JSON.stringify(paths),
  );
  const one = found.groups.find((g) => g.path === "lib/one.py");
  check(
    one?.matches.length === 3 && one.matches[1].start === 6 && one.matches[1].column === 7 && one.matches[1].hit === "ALPHA" && one.matches[0].after === " ALPHA alphabet",
    "each match says where it is, as the editor counts, and what is on its line",
    JSON.stringify(one?.matches[1]),
  );
  found = await guest.find("alpha", { folder: "lib/nested", match_case: true, whole_word: true });
  check(found.groups.length === 1 && found.groups[0].path === "lib/nested/two.txt", "kept to a folder, to a case and to whole words when asked");

  // ---- replacing ------------------------------------------------------------------
  done = await guest.fileOp({
    t: "replace",
    query: "cat",
    match_case: false,
    whole_word: true,
    replacement: "dog",
    files: [
      { path: "docs/notes.md", sum: sum("a cat and a concatenation\n") },
      // Not what it is now: changed since the guest was shown it.
      { path: "main.py", sum: sum("print('something else')\n") },
    ],
  });
  check(
    done.ok && (await read("docs/notes.md")) === "a dog and a concatenation\n" && (await read("main.py")) === "print('alpha')\n" && /1 replacement in 1 file/.test(done.message) && /main\.py \(changed since the preview\)/.test(done.message),
    "a replace changes the files that are still what was shown, and leaves alone — and names — one that is not",
    done.message,
  );

  // ---- a file's bytes, to look at ---------------------------------------------------
  const seen = await guest.viewFile("dot.png");
  check(seen.t === "sight" && Buffer.compare(Buffer.from(seen.data), png) === 0, "a picture's bytes come whole, to look at");
  const refusedView = await guest.viewFile("secret.env");
  check(refusedView.t === "done" && !refusedView.ok, "but not a file the tree hides", refusedView.message);

  // ---- what every one of them refuses ---------------------------------------------
  // Outside the folder, by any spelling; what the ignore rules hide; and
  // through a link, which here leads out of the folder altogether.
  const escapes = ["../outside/planted.txt", "/etc/planted", "lib/../../outside/planted.txt", "out/planted.txt", ".git/hooks/pre-commit", "secret.env", "node_modules/x.js"];
  const refusals = [];
  for (const path of escapes) {
    refusals.push((await guest.fileOp({ t: "make", path, dir: false })).ok);
    refusals.push((await guest.putFile(path, Buffer.from("planted"), true)).ok);
    refusals.push((await guest.fileOp({ t: "rename", from: "main.py", to: path, replace: true })).ok);
  }
  for (const path of ["../outside/theirs.txt", "out/theirs.txt", ".git", ".git/config", "secret.env"]) {
    refusals.push((await guest.fileOp({ t: "remove", path })).ok);
    refusals.push((await guest.fileOp({ t: "rename", from: path, to: "taken.txt", replace: true })).ok);
    const view = await guest.viewFile(path);
    refusals.push(view.t === "sight");
  }
  // The link itself is one of the folder's own things, and may be moved or
  // removed as one (below) — but it is not a file to look into.
  refusals.push((await guest.viewFile("out")).t === "sight");
  check(
    refusals.every((r) => r === false) &&
      (await readFile(join(outside, "theirs.txt"), "utf8")) === "the host's own\n" &&
      !existsSync(join(outside, "planted.txt")) &&
      (await read(".git/config")) === "[core]\n" &&
      (await read("secret.env")) === "KEY=alpha\n" &&
      exists("main.py") &&
      !exists("taken.txt") &&
      !exists("node_modules"),
    "nothing is made, written, moved, removed or read outside the folder, through a link, or where the tree hides",
    `${refusals.filter(Boolean).length} of ${refusals.length} were let through`,
  );

  // ---- removing --------------------------------------------------------------------
  done = await guest.fileOp({ t: "remove", path: "empty.txt" });
  await guest.waitUntil((g) => !g.tree.has("empty.txt"), "the removal in the tree").catch(() => {});
  check(done.ok && !exists("empty.txt") && !guest.tree.has("empty.txt"), "a file is removed");
  done = await guest.fileOp({ t: "remove", path: "lib" });
  await guest.waitUntil((g) => !g.tree.has("lib/one.py"), "the folder's removal in the tree").catch(() => {});
  check(done.ok && !exists("lib") && ![...guest.tree.keys()].some((p) => p === "lib" || p.startsWith("lib/")), "and a folder with everything in it");
  // The link itself is the folder's: it goes, and what it pointed at stays.
  done = await guest.fileOp({ t: "remove", path: "out" });
  check(done.ok && !exists("out") && existsSync(join(outside, "theirs.txt")), "a link is removed as itself, and what it led to is left alone");

  // ---- read-only -------------------------------------------------------------------
  // The host's `l`. Guests watch and read: every one of these is refused,
  // for a page that asks anyway — and a terminal is not closed either.
  guest.openPty();
  await guest.waitUntil((g) => g.ptys.size === 1, "a terminal");
  const pty = [...guest.ptys.keys()][0];
  agent.press("l");
  await guest.waitUntil((g) => g.ptyMessages.some((m) => m.t === "read_only" && m.read_only), "the session to be made read-only");
  const while_ = [
    await guest.fileOp({ t: "make", path: "while-read-only.txt", dir: false }),
    await guest.fileOp({ t: "rename", from: "main.py", to: "renamed.py", replace: false }),
    await guest.fileOp({ t: "remove", path: "main.py" }),
    await guest.putFile("uploaded.txt", Buffer.from("x")),
    await guest.fileOp({ t: "replace", query: "alpha", match_case: false, whole_word: false, replacement: "beta", files: [{ path: "main.py", sum: sum("print('alpha')\n") }] }),
  ];
  check(
    while_.every((r) => !r.ok && /read-only/.test(r.message)) && !exists("while-read-only.txt") && !exists("renamed.py") && !exists("uploaded.txt") && (await read("main.py")) === "print('alpha')\n",
    "read-only refuses every change, at the host, whatever a page sends",
    JSON.stringify(while_.map((r) => r.message)),
  );
  guest.send(json(CH_PTY, { t: "close", pty_id: pty }));
  await sleep(700);
  check(guest.ptys.has(pty), "and a terminal is not closed by a guest who may only watch");
  found = await guest.find("alpha");
  const look = await guest.viewFile("dot.png");
  check(found.groups.some((g) => g.path === "main.py") && look.t === "sight", "searching and looking, which change nothing, still work");
  agent.press("l");
  await guest.waitUntil((g) => g.ptyMessages.some((m) => m.t === "read_only" && !m.read_only), "the session to take changes again");
  guest.send(json(CH_PTY, { t: "close", pty_id: pty }));
  await guest.waitUntil((g) => !g.ptys.has(pty), "the terminal to close").catch(() => {});
  check(!guest.ptys.has(pty), "a terminal's tab closes it, once the session takes changes again");

  // ---- the host's own account -----------------------------------------------------
  const panel = agent.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  check(
    /ana made the file src\/deep\/new\.py/.test(panel) || /ana deleted/.test(panel),
    "what a guest did to the folder is in the host's activity pane",
    panel.split("\n").filter((l) => /ana /.test(l)).slice(-6).join(" | ").slice(0, 300),
  );

  guest.close();
  await rm(base, { recursive: true, force: true });
  finish(procs, "the host does a guest's file operations, inside the folder and nowhere else");
}

main().catch(async (e) => {
  fail(e.stack ?? String(e));
  finish(procs, "");
});

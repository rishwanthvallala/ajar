#!/usr/bin/env node
// Mirror the wasm packages this app actually downloads.
//
// Wasmer's CDN serves `.webc` with no content encoding at all, so python alone
// is 58.9 MB on the wire. The same file from our origin behind zstd is roughly
// a quarter of that, and immutable caching makes a later visit free.
//
// The URLs are *observed*, not derived. An earlier version asked the registry
// for each package's `downloadUrl` and got, for coreutils, a `.tar.gz` the
// runtime never requests — plus it had no way to know about the dependencies a
// package pulls in on its own. Running the app once and recording what it asks
// for cannot be wrong about either.
//
//   npx vite build && node scripts/fetch-packages.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdir, readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const run = promisify(execFile);

const OUT = new URL("../public/packages/", import.meta.url);
const ROOT = new URL("../dist/", import.meta.url).pathname;
const PORT = 5201;

// What can never run in the pad, taken out of the packages that ship it.
// Measured on 25 September: 3.1 MB of python's 13.6 MB download and 13.5 MB of
// its 61.7 MB in memory. Everything that can run stays, and the SDK accepts a
// mirrored package whose bytes differ from the registry's. `app-check.mjs`
// runs through the mirror and presses Run, so an SDK that stopped accepting it
// fails there, loudly. See docs/dev/pad.md, "The download".
const PY = "/fs/nix/store/*-python3-static-*/lib/python3.13";
const NC = "/fs/nix/store/*-ncurses-static-*";
const TRIM = [
  // A second pip. ensurepip installs pip into an environment that lacks one,
  // and this one ships pip already installed. It is a wheel — a zip — so it
  // barely compresses: 1.7 MB of every first visit. `python -m venv` without
  // `--without-pip` needs it, and is the one thing this costs.
  ["--drop", `${PY}/ensurepip`],
  // A desktop IDE, the Tk bindings and the turtle. All need Tcl/Tk, which
  // this runtime does not have; `import tkinter` fails with or without them.
  ["--drop", `${PY}/idlelib`],
  ["--drop", `${PY}/tkinter`],
  ["--drop", `${PY}/turtledemo`],
  ["--drop", `${PY}/turtle.py`],
  ["--drop", `${PY}/__pycache__/turtle.*`],
  // pip's launchers for installing scripts on Windows.
  ["--drop", `${PY}/site-packages/pip/_vendor/distlib/*.exe`],
  // ncurses ships its terminal database twice, byte for byte. The path
  // compiled into the interpreter is share/terminfo, so lib/ is never read.
  ["--drop", `${NC}/lib/terminfo`],
  // And 2,899 terminal types in the copy that is read. The pad's terminal is
  // an xterm; these are it and what a program might still assume.
  ["--keep-only", `${NC}/share/terminfo/*=xterm,xterm-256color,xterm-color,xterm-16color,vt100,vt102,vt220,ansi,dumb,linux,screen,screen-256color,tmux,tmux-256color`],
];
// In the file name, so a change to the rules is a new URL and the immutable
// cache header stays honest.
const TRIM_TAG = createHash("sha256").update(JSON.stringify(TRIM)).digest("hex").slice(0, 8);

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript",
};

// Served without the service worker's mirror, so the run reaches the CDN and
// every URL it wants is visible.
const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  if (path === "/sw.js" || path.startsWith("/packages/")) {
    res.statusCode = 404;
    return res.end("not while recording");
  }
  // Just enough store to let the page open. No relay here — this run exists
  // only to watch which packages the runtime reaches for.
  if (path.startsWith("/api/pad/")) {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      req.method === "PUT"
        ? JSON.stringify({ seq: 1 })
        : JSON.stringify({ exists: false, seq: 0, files: {} }),
    );
  }
  const file = join(ROOT, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.setHeader("Content-Type", "text/html");
    res.end(await readFile(join(ROOT, "index.html")));
  }
});
await new Promise((r) => server.listen(PORT, r));

console.log("  recording what the runtime asks for…");
const browser = await chromium.launch();
const page = await browser.newPage();
const wanted = new Set();
page.on("request", (r) => {
  if (r.url().startsWith("https://cdn.wasmer.io/")) wanted.add(r.url());
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".monaco-editor", { timeout: 60_000 });
await page.click("#run");
await page
  .waitForFunction(() => document.getElementById("status")?.textContent === "done", {
    timeout: 300_000,
  })
  .catch(() => console.log("  (the run did not finish; recording what was asked for anyway)"));
await browser.close();
server.close();

await mkdir(OUT, { recursive: true });
const manifest = {};
let total = 0;

console.log("  building the trimmer…");
const TRIMMER_DIR = new URL("./webc-trim/", import.meta.url).pathname;
const TARGET_DIR = new URL("../../target/webc-trim/", import.meta.url).pathname;
await run("cargo", [
  "build", "--release", "--locked", "-q",
  "--manifest-path", `${TRIMMER_DIR}Cargo.toml`, "--target-dir", TARGET_DIR,
]).catch((e) => {
  throw new Error(`building pad/scripts/webc-trim failed — is cargo installed? ${e.message}`);
});
const trimmer = `${TARGET_DIR}release/webc-trim`;

for (const url of [...wanted].sort()) {
  // Named by the content hash the CDN already uses, so a changed package is a
  // different file and the immutable cache header is safe. A trimmed one also
  // carries the rules' hash, for the same reason.
  const base = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const plain = `${base}.webc`;
  const trimmed = `${base}-${TRIM_TAG}.webc`;
  const have = async (name) => stat(new URL(name, OUT)).catch(() => null);

  let file = (await have(trimmed)) ? trimmed : null;
  if (!file) {
    if (!(await have(plain))) {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      await writeFile(new URL(plain, OUT), bytes);
      console.log(`  ${(bytes.length / 1048576).toFixed(1).padStart(6)} MB  ${plain} downloaded`);
    }
    // Every package goes through the rules; one they do not touch is left
    // byte for byte as the registry published it.
    const args = TRIM.flat();
    const { stdout } = await run(trimmer, [new URL(plain, OUT).pathname, new URL(trimmed, OUT).pathname, ...args]);
    file = (await have(trimmed)) ? trimmed : plain;
    if (file === trimmed) console.log(`  ${stdout.trim().replace(/^.*: /, `${plain}: `)}`);
  }
  manifest[url] = `/packages/${file}`;
  const size = (await have(file)).size;
  total += size;
  console.log(`  ${(size / 1048576).toFixed(1).padStart(6)} MB  ${file}`);
}

// Compressed once here rather than per request by Caddy.
//
// Caddy's `encode` decides from the response Content-Type, and it has no idea
// what a `.webc` is — it serves them with no Content-Type at all, so the
// default match never fires and 72 MB goes out raw. `file_server` with
// `precompressed` sidesteps that entirely: it serves `<file>.zst` when the
// client accepts zstd, and it costs nothing at request time.
//
// Also worth more: this is zstd -19, which no server would spend per request.
console.log("  compressing…");
let raw = 0;
let small = 0;
for (const local of Object.values(manifest)) {
  const file = new URL(local.replace("/packages/", ""), OUT).pathname;
  raw += (await stat(file)).size;
  for (const [tool, args, ext] of [
    ["zstd", ["-19", "-q", "-f", "--keep"], ".zst"],
    ["gzip", ["-9", "-f", "--keep"], ".gz"],
  ]) {
    const out = file + ext;
    if (await stat(out).catch(() => null)) continue;
    await run(tool, [...args, file]).catch((e) => {
      throw new Error(`${tool} failed — is it installed? ${e.message}`);
    });
  }
  small += (await stat(file + ".zst")).size;
}
console.log(
  `  ${(raw / 1048576).toFixed(1)} MB raw, ${(small / 1048576).toFixed(1)} MB zstd ` +
    `(${Math.round((1 - small / raw) * 100)}% smaller over the wire)`,
);

await writeFile(new URL("manifest.json", OUT), JSON.stringify(manifest, null, 2));

// Anything here that the manifest no longer names is a package we used to
// pin. Nothing requests it, so it is dead weight on the origin — 40 MB of it
// after the bash upgrade, because this used to only ever add files.
const keep = new Set(
  Object.values(manifest).flatMap((local) => {
    const file = local.replace("/packages/", "");
    return [file, `${file}.zst`, `${file}.gz`];
  }),
);
keep.add("manifest.json");
let freed = 0;
for (const name of await readdir(OUT)) {
  if (keep.has(name)) continue;
  const path = new URL(name, OUT);
  freed += (await stat(path)).size;
  await rm(path);
  console.log(`  dropped ${name}, no longer pinned`);
}
if (freed) console.log(`  ${(freed / 1048576).toFixed(1)} MB of superseded packages removed`);

console.log(`  ${Object.keys(manifest).length} packages, ${(total / 1048576).toFixed(1)} MB mirrored`);

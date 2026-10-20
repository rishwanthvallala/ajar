#!/usr/bin/env node
// Build the pad's awk: The One True Awk, for WASIX, into pad/src/tools/awk.wasm.
//
// No awk is published for this runtime, and the pad's was a translator into
// python that said of itself "it is not awk": a reviewer's harness against
// gawk, mawk and this same awk found 79 of 169 programs answered differently,
// 34 of them quietly — ranges printing every line, `2^10` as 8, `print
// length` as a python repr. This builds the real one instead, with the
// registry's clang/clang, whose `clang` targets WASIX: system(), `print |
// "cmd"` and `"cmd" | getline` start their commands as any awk's do. See
// awk/build.sh for how, and awk/wasix.c for the four things its libc needed.
//
// What comes out is committed, unlike the packages: the pad's browser checks
// run in CI with no package mirror, and they run awk. 430 KB, 130 gzipped.
//
//   node pad/scripts/build-awk.mjs
//
// Needs podman (or CONTAINER=docker) and tar. The build itself runs in the
// pinned Ubuntu container, Wasmer's CLI included; nothing downloaded is run on
// this machine. Downloads about 400 MB the first time — the compiler from the
// mirror if it is there — kept in target/awk.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CLANG, CONTAINER, ONE_TRUE_AWK, STACK_SIZE, WASMER } from "./awk/pins.mjs";

const run = promisify(execFile);
const say = (s) => console.log(`  ${s}`);
const ENGINE = process.env.CONTAINER ?? "podman";

const ROOT = new URL("../../", import.meta.url).pathname;
const RECIPE = new URL("./awk/", import.meta.url).pathname;
const SCRATCH = `${ROOT}target/awk/`;
const MIRROR = `${ROOT}pad/public/packages/`;
const OUT = `${ROOT}pad/src/tools/awk.wasm`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function sh(cmd, args) {
  try {
    return (await run(cmd, args, { maxBuffer: 64 << 20 })).stdout;
  } catch (e) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${e.stderr || e.message}`);
  }
}

// ---- 1. what it is made of, downloaded once and checked against the pins

/**
 * A large file, in parts. Wasmer's 285 MB from GitHub ran at 70 kB/s on one
 * connection and stalled for minutes on another (20 October): eight at once,
 * each resumed where it stopped and dropped after 20 s without a byte.
 */
async function download(url, path) {
  const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
  const total = Number(probe.headers.get("content-range")?.split("/")[1]);
  await probe.body?.cancel();
  if (!probe.ok) throw new Error(`${url}: ${probe.status}`);
  if (probe.status !== 206 || !total) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return writeFile(path, new Uint8Array(await res.arrayBuffer()));
  }
  const PARTS = 8;
  const each = Math.ceil(total / PARTS);
  const parts = [...Array(PARTS).keys()].map((i) => ({
    file: `${path}.part${i}`, from: i * each, to: Math.min(total, (i + 1) * each) - 1,
  }));
  await Promise.all(parts.map((p) => part(url, p)));
  const whole = await open(path, "w");
  for (const p of parts) await whole.write(await readFile(p.file));
  await whole.close();
  for (const p of parts) await rm(p.file);
}

async function part(url, { file, from, to }) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const have = existsSync(file) ? (await stat(file)).size : 0;
    if (from + have > to) return;
    const stop = new AbortController();
    let quiet;
    const heard = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => stop.abort(), 20_000);
    };
    const out = await open(file, "a");
    try {
      heard();
      const res = await fetch(url, { headers: { Range: `bytes=${from + have}-${to}` }, signal: stop.signal });
      if (res.status !== 206) throw new Error(`${res.status}`);
      for await (const chunk of res.body) {
        heard();
        await out.write(chunk);
      }
    } catch {
      // Resumed from what arrived, on the next pass.
    } finally {
      clearTimeout(quiet);
      await out.close();
    }
  }
  throw new Error(`${url}: bytes ${from}-${to} would not download`);
}

/** `file` in target/awk, or `url` fetched there, and its bytes checked. */
async function fetched(url, file, check) {
  const path = `${SCRATCH}${file}`;
  if (existsSync(path) && !check(await readFile(path))) await rm(path);
  if (!existsSync(path)) {
    say(`downloading ${url}…`);
    await download(url, path);
    if (!check(await readFile(path))) throw new Error(`${file} is not the pinned one`);
  }
  return path;
}

await mkdir(SCRATCH, { recursive: true });

// The compiler: the mirror's copy when there is one, as it is 110 MB.
async function clang() {
  const manifest = existsSync(`${MIRROR}manifest.json`) ? JSON.parse(await readFile(`${MIRROR}manifest.json`, "utf8")) : {};
  const mirrored = manifest[CLANG.url] && `${ROOT}pad/public${manifest[CLANG.url]}`;
  if (mirrored && existsSync(mirrored) && sha256(await readFile(mirrored)) === CLANG.sha256) return mirrored;
  return fetched(CLANG.url, `clang-${CLANG.sha256.slice(0, 16)}.webc`, (b) => sha256(b) === CLANG.sha256);
}

// Asked of the container itself, which podman and docker answer alike.
const machine = (await sh(ENGINE, ["run", "--rm", CONTAINER.image, "uname", "-m"])).trim();
const arch = { aarch64: "arm64", x86_64: "amd64" }[machine] ?? machine;
const cli = WASMER[arch];
if (!cli) throw new Error(`no Wasmer CLI pinned for a ${arch} container`);

const source = await fetched(ONE_TRUE_AWK.tarball, `awk-${ONE_TRUE_AWK.commit}.tar.gz`, (b) => sha256(gunzipSync(b)) === ONE_TRUE_AWK.tarSha256);
const compiler = await clang();
const wasmer = await fetched(cli.url, `wasmer-${WASMER.version}-${arch}.tar.gz`, (b) => sha256(b) === cli.sha256);
say(`awk ${ONE_TRUE_AWK.tag} (${ONE_TRUE_AWK.commit.slice(0, 12)}), ${CLANG.pkg}, wasmer ${WASMER.version} for ${arch}`);

// ---- 2. the source, unpacked afresh, and still under the licence NOTICE.md quotes

const SRC = `${SCRATCH}src/`;
await rm(SRC, { recursive: true, force: true });
await mkdir(SRC, { recursive: true });
await sh("tar", ["-xzf", source, "-C", SRC, "--strip-components=1"]);
const quoted = /```text\n([\s\S]*?)```/.exec(await readFile(`${RECIPE}NOTICE.md`, "utf8"))?.[1];
if ((await readFile(`${SRC}LICENSE`, "utf8")) !== quoted) {
  throw new Error("The One True Awk's LICENSE is not the licence awk/NOTICE.md quotes: read it before shipping this");
}

// ---- 3. the build, in the container

const BUILT = `${SCRATCH}out/`;
await rm(BUILT, { recursive: true, force: true });
await mkdir(BUILT, { recursive: true });
// Wasmer's compiled clang, kept between builds: compiling its 87 MB of
// modules afresh is most of ten minutes. It changes how long, not what.
const CACHE = `${SCRATCH}wasmer-cache/`;
await mkdir(CACHE, { recursive: true });
say(`building in ${CONTAINER.image.split("@")[0]}…`);
await new Promise((resolve, reject) => {
  const child = spawn(ENGINE, [
    "run", "--rm", "--name", `ajar-awk-build-${process.pid}`, "--security-opt", "label=disable",
    "-e", `BYACC=${CONTAINER.apt.byacc}`, "-e", `BINARYEN=${CONTAINER.apt.binaryen}`,
    "-e", `STACK_SIZE=${STACK_SIZE}`, "-e", `VERSION=${ONE_TRUE_AWK.version}`,
    "-v", `${SRC}:/in/awk:ro`, "-v", `${compiler}:/in/clang.webc:ro`, "-v", `${wasmer}:/in/wasmer.tar.gz:ro`,
    "-v", `${RECIPE}:/recipe:ro`, "-v", `${BUILT}:/out`, "-v", `${CACHE}:/cache`, "-e", "WASMER_CACHE_DIR=/cache",
    CONTAINER.image, "bash", "/recipe/build.sh",
  ], { stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`the build failed (exit ${code})`))));
});

// ---- 4. what came out: a WASIX program, asyncified, its stack first

const wasm = await readFile(`${BUILT}awk.wasm`);
const { imports, exports, globals } = sections(wasm);
const missing = [
  ...["wasix_32v1.proc_fork", "wasix_32v1.stack_checkpoint"].filter((i) => !imports.includes(i)),
  ...["asyncify_start_unwind", "asyncify_stop_rewind"].filter((e) => !(e in exports)),
];
if (missing.length) throw new Error(`awk.wasm lacks ${missing.join(", ")}`);
if (globals[exports.__stack_pointer] !== STACK_SIZE) throw new Error("awk.wasm's stack is not the first 8 MiB of its memory");

const before = existsSync(OUT) ? sha256(await readFile(OUT)) : null;
await writeFile(OUT, wasm);
const hash = sha256(wasm);
say(`pad/src/tools/awk.wasm: ${wasm.length.toLocaleString("en")} bytes, sha256 ${hash}${before === hash ? ", unchanged" : ""}`);

/** A module's imports, its exports (name to index) and its globals' constant starts. */
function sections(bytes) {
  let at = 8;
  const u = () => {
    let r = 0, s = 0, b;
    do { b = bytes[at++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80);
    return r;
  };
  const sleb = () => {
    let r = 0, s = 0, b;
    do { b = bytes[at++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    return s < 32 && b & 0x40 ? r | (-1 << s) : r;
  };
  const name = () => { const n = u(); const s = new TextDecoder().decode(bytes.subarray(at, at + n)); at += n; return s; };
  const out = { imports: [], exports: {}, globals: [] };
  while (at < bytes.length) {
    const id = bytes[at++];
    const size = u();
    const end = at + size;
    if (id === 2) {
      for (let n = u(); n > 0; n--) {
        out.imports.push(`${name()}.${name()}`);
        const kind = bytes[at++];
        if (kind === 0) u();
        else if (kind === 1) { at++; const f = u(); u(); if (f & 1) u(); }
        else if (kind === 2) { const f = u(); u(); if (f & 1) u(); }
        else if (kind === 3) at += 2;
        else if (kind === 4) { at++; u(); }
      }
    } else if (id === 6) {
      for (let n = u(); n > 0; n--) {
        at += 2;
        const op = bytes[at++];
        out.globals.push(op === 0x41 ? sleb() : null);
        while (bytes[at] !== 0x0b) at++;
        at++;
      }
    } else if (id === 7) {
      for (let n = u(); n > 0; n--) { const nm = name(); at++; out.exports[nm] = u(); }
    }
    at = end;
  }
  return out;
}

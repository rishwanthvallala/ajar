#!/usr/bin/env node
// Brotli and gzip copies beside every compressible file of the pad's build,
// for nginx's `brotli_static` and `gzip_static` to send in place of the file
// (deploy/nginx/sites.conf). Run by deploy.sh after the build:
//
//   node pad/scripts/compress-static.mjs [dist]      # default pad/dist
//
// nginx compresses on the fly only the types `gzip_types` names, and until
// 16 November that left out wasm and fonts: a first visit was sent the
// SDK's 4.6 MB of wasm uncompressed, where Caddy, the front before, had
// compressed it. Compressing at the build instead does better than any
// server would per request — brotli at its highest setting, about 30% under
// gzip at nginx's level for the page's scripts — and costs once, at the
// deploy, not on every visit. A copy newer than its file is kept.
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { constants, createBrotliCompress, createGzip } from "node:zlib";

const COMPRESSIBLE = /\.(js|mjs|css|wasm|ttf|otf|svg|json|html|txt|map)$/;
/** Smaller files gain less than the header the encoding costs. */
const MIN_BYTES = 1024;

const DIST = process.argv[2] ?? fileURLToPath(new URL("../dist/", import.meta.url));

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // The runtime's packages have their own copies (brotli-packages.mjs).
    if (entry.isDirectory() && entry.name !== "packages") yield* files(path);
    else if (entry.isFile() && COMPRESSIBLE.test(entry.name)) yield path;
  }
}

/** `out` from `file` through `encoder`, written whole or not at all. */
async function copy(file, out, encoder) {
  const tmp = `${out}.${process.pid}.tmp`;
  try {
    await pipeline(createReadStream(file), encoder, createWriteStream(tmp));
    await rename(tmp, out);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const fresh = async (file, out) => {
  const [a, b] = await Promise.all([stat(file), stat(out).catch(() => null)]);
  return b !== null && b.mtimeMs >= a.mtimeMs;
};

export async function compressAll(dist = DIST) {
  const todo = [];
  for await (const file of files(dist)) {
    const { size } = await stat(file);
    if (size >= MIN_BYTES) todo.push({ file, size });
  }
  let made = 0;
  let raw = 0;
  let brotli = 0;
  let next = 0;
  const work = async () => {
    while (next < todo.length) {
      const { file, size } = todo[next++];
      if (!(await fresh(file, `${file}.br`))) {
        await copy(file, `${file}.br`, createBrotliCompress({
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 11,
            [constants.BROTLI_PARAM_LGWIN]: 24,
            [constants.BROTLI_PARAM_SIZE_HINT]: size,
          },
        }));
        made++;
      }
      if (!(await fresh(file, `${file}.gz`))) await copy(file, `${file}.gz`, createGzip({ level: 9 }));
      raw += size;
      brotli += (await stat(`${file}.br`)).size;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cpus().length, 8)) }, work));
  return { files: todo.length, made, raw, brotli };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const started = Date.now();
  const { files: n, made, raw, brotli } = await compressAll();
  console.log(`  ${n} files compressed as stored (${made} new): ${(raw / 1048576).toFixed(1)} MB → ${(brotli / 1048576).toFixed(1)} MB brotli, ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

#!/usr/bin/env node
// A brotli copy beside every package in the mirror, for nginx's
// `brotli_static` to send in place of the file (deploy/nginx/sites.conf).
//
//   node pad/scripts/brotli-packages.mjs [dir]      # default pad/public/packages
//
// Since 14 November nginx is the front, and Ubuntu's nginx has no zstd: the
// `.zst` copies Caddy sent go unused. Brotli at its highest setting, with a
// 16 MB window, comes out a little smaller than zstd -19 — 9.3 MB against
// 10.0 for a 46 MB package, and gzip -9's 13.7 — and costs about a minute
// and a half for each 46 MB, once: a copy already there is left as it is.
// Files are done several at once, one a CPU.
//
// Run by deploy.sh before every build, not by fetch-packages.mjs: CI deploys
// only while that script is unchanged since the last deploy (deploy/from-ci.sh),
// and the copies are made from the mirror, not fetched. fetch-packages.mjs
// drops what its manifest does not name, these among them; the next deploy
// makes them again.
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { cpus } from "node:os";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { constants, createBrotliCompress } from "node:zlib";

const DIR = process.argv[2] ?? fileURLToPath(new URL("../public/packages/", import.meta.url));
const dir = DIR.endsWith("/") ? DIR : `${DIR}/`;

/** `file.br` beside `file`, written whole or not at all. */
export async function brotliCopy(file) {
  const out = `${file}.br`;
  if (existsSync(out)) return false;
  const size = (await stat(file)).size;
  const tmp = `${out}.${process.pid}.tmp`;
  try {
    await pipeline(
      createReadStream(file),
      createBrotliCompress({
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_LGWIN]: 24,
          [constants.BROTLI_PARAM_SIZE_HINT]: size,
        },
      }),
      createWriteStream(tmp),
    );
    await rename(tmp, out);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return true;
}

/** Every file in `dir` that has a gzip copy — the ones worth sending compressed — given a brotli one too. */
export async function brotliAll(where = dir) {
  const names = await readdir(where);
  const todo = names.filter((n) => names.includes(`${n}.gz`) && !names.includes(`${n}.br`));
  let made = 0;
  let next = 0;
  const work = async () => {
    while (next < todo.length) {
      const name = todo[next++];
      const started = Date.now();
      if (await brotliCopy(`${where}${name}`)) {
        made++;
        const [raw, br] = await Promise.all([stat(`${where}${name}`), stat(`${where}${name}.br`)]);
        console.log(`  ${name}: ${(raw.size / 1048576).toFixed(1)} MB → ${(br.size / 1048576).toFixed(1)} MB brotli, ${((Date.now() - started) / 1000).toFixed(0)} s`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cpus().length, 8)) }, work));
  return made;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const made = await brotliAll();
  console.log(made ? `  ${made} brotli copies made` : "  every package has its brotli copy");
}

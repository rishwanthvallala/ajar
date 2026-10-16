#!/usr/bin/env node
// The completion lab's runtime: transformers.js's self-contained browser
// build, and the ONNX Runtime WebAssembly files it loads, into
// public/vendor/lab/ (gitignored, like the rest of public/vendor/).
//
//   node pad/scripts/fetch-lab.mjs
//
// Taken from the npm tarballs rather than installed: the package depends on
// onnxruntime-node and sharp, native binaries for Node that a page never
// uses, and as a dependency of the pad every CI run would install them.
// Pinned, and each tarball checked against the registry's own integrity
// hash. The runtime is the one transformers.js was built against: its bundle
// names the version, and a different .wasm under the same name fails to load.
//
// The models are made by pad/lab/build-models.sh, into the same directory.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TRANSFORMERS = "4.3.0";
const OUT = fileURLToPath(new URL("../public/vendor/lab/", import.meta.url));

async function tarball(name, version) {
  const meta = await (await fetch(`https://registry.npmjs.org/${name}/${version}`)).json();
  const { tarball: url, integrity } = meta.dist;
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  const [algorithm, expected] = integrity.split("-");
  const actual = createHash(algorithm).update(bytes).digest("base64");
  if (actual !== expected) throw new Error(`${name}@${version}: the tarball does not match the registry's ${algorithm}`);
  // Each in a directory of its own, and read only as files from there.
  const dir = await mkdtemp(join(tmpdir(), "pad-lab-"));
  await writeFile(join(dir, "package.tgz"), bytes);
  execFileSync("tar", ["xzf", "package.tgz"], { cwd: dir });
  return { dir: join(dir, "package"), meta, root: dir };
}

const transformers = await tarball("@huggingface/transformers", TRANSFORMERS);
const ortVersion = transformers.meta.dependencies["onnxruntime-web"];
const ort = await tarball("onnxruntime-web", ortVersion);

await mkdir(join(OUT, "ort"), { recursive: true });
await copyFile(join(transformers.dir, "dist", "transformers.min.js"), join(OUT, "transformers.min.js"));
// Which of these the browser takes depends on what it supports — JSPI, or
// asyncify for WebGPU, or neither — so all of them; it fetches one.
const variants = ["", ".jsep", ".asyncify", ".jspi"];
for (const v of variants) {
  for (const ext of [".mjs", ".wasm"]) {
    await copyFile(join(ort.dir, "dist", `ort-wasm-simd-threaded${v}${ext}`), join(OUT, "ort", `ort-wasm-simd-threaded${v}${ext}`));
  }
}
await writeFile(join(OUT, "versions.json"), `${JSON.stringify({ transformers: TRANSFORMERS, "onnxruntime-web": ortVersion }, null, 2)}\n`);
for (const t of [transformers, ort]) await rm(t.root, { recursive: true, force: true });
console.log(`  transformers.js ${TRANSFORMERS}, onnxruntime-web ${ortVersion}, in ${OUT}`);

// Compressed beside each file, as fetch-packages.mjs does for the wasm
// packages: Caddy serves the .zst or .gz as it is (`precompressed`), so what
// the lab reports as downloaded is what really crossed the wire. The models
// too, once build-models.sh has made them — quantized weights look like noise
// and gain little, which is worth seeing measured rather than assumed.
async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (!/\.(zst|gz)$/.test(entry.name)) yield path;
  }
}
let raw = 0;
let packed = 0;
for await (const file of files(OUT)) {
  const size = (await stat(file)).size;
  const zst = await stat(`${file}.zst`).catch(() => null);
  if (!zst || zst.mtimeMs < (await stat(file)).mtimeMs) {
    execFileSync("zstd", ["-19", "-q", "-f", "--keep", file]);
    execFileSync("gzip", ["-9", "-f", "--keep", file]);
  }
  raw += size;
  packed += (await stat(`${file}.zst`)).size;
}
console.log(`  ${(raw / 1e6).toFixed(1)} MB in all, ${(packed / 1e6).toFixed(1)} MB as zstd`);

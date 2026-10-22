// Puts a model where the pad serves it: pad/public/packages, beside the
// mirrored wasm packages and under the same rules.
//
//   node packages/complete/scripts/install-model.mjs <model.bin> <tokenizer.json> [card.json] [out dir]
//
// The card (default models/M1-qat.json) says what the blob is — its shape,
// its special tokens, its prompt and the confidence cuts measured for it. What
// lands in the output directory:
//
//   ajar-complete-model-<hash>.bin   the blob, plus .zst and .gz copies, which
//   ajar-complete-vocab-<hash>.bin   Caddy's `precompressed` serves in its place
//   ajar-complete.json               the manifest the page asks for, written last
//
// Content-named, so the immutable caching of /packages/ is right for them, and
// prefixed `ajar-`, which fetch-packages.mjs leaves alone when it prunes. Older
// `ajar-complete-*` files the new manifest does not name are removed.
//
// The model is not in git (18 MB). The pad's deploy carries it the way it
// carries the packages: deploy.sh uploads pad/public/packages, and a deploy
// from CI copies them back from the server first (deploy/from-ci.sh).
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, zstdCompressSync, constants } from "node:zlib";
import { buildVocab } from "./vocab.mjs";

const here = new URL("./", import.meta.url);
const [modelPath, tokPath, cardPath = new URL("../models/M1-qat.json", here).pathname, outDir = new URL("../../../pad/public/packages/", here).pathname] =
  process.argv.slice(2);
if (!modelPath || !tokPath) {
  console.error("usage: install-model.mjs <model.bin> <tokenizer.json> [card.json] [out dir]");
  process.exit(2);
}
const card = JSON.parse(await readFile(cardPath, "utf8"));
const model = await readFile(modelPath);
const vocab = buildVocab(JSON.parse(await readFile(tokPath, "utf8")));

// The engine reads the blob by walking it (engine/llm.c, walk_model); a blob
// of any other size is another shape, or not a model.
const al16 = (n) => (n + 15) & ~15;
const mat = (rows, cols) => al16((rows * cols) / 2) + al16(((rows * cols) / 64) * 2);
const vec = (n) => al16(n * 4);
const { V, d, L, nkv, ffn } = card.shape;
const kvd = nkv * 64;
const want = mat(V, d) + L * (vec(d) + mat(d + 2 * kvd, d) + mat(d, d) + vec(d) + mat(2 * ffn, d) + mat(d, ffn)) + vec(d);
if (model.length !== want) {
  console.error(`${modelPath} is ${model.length} bytes; a ${card.name} of that shape is ${want}`);
  process.exit(1);
}
if (new DataView(vocab.buffer).getUint32(4, true) !== card.tokens.used) {
  console.error(`the tokenizer has ${new DataView(vocab.buffer).getUint32(4, true)} tokens; the card says ${card.tokens.used}`);
  process.exit(1);
}

async function put(kind, bytes) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = `ajar-complete-${kind}-${sha256.slice(0, 12)}.bin`;
  const path = join(outDir, file);
  const have = await stat(path).catch(() => null);
  if (have?.size !== bytes.length) {
    await writeFile(path, bytes);
    // zstd -19 and gzip -9, as fetch-packages.mjs makes them.
    await writeFile(`${path}.zst`, zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }));
    await writeFile(`${path}.gz`, gzipSync(bytes, { level: 9 }));
  }
  const zst = (await stat(`${path}.zst`)).size;
  console.log(`  ${file}  ${(bytes.length / 1e6).toFixed(2)} MB, ${(zst / 1e6).toFixed(2)} MB zstd`);
  return { file, bytes: bytes.length, sha256 };
}

console.log(`${card.name} into ${outDir}`);
const manifest = {
  format: 1,
  name: card.name,
  model: await put("model", model),
  vocab: await put("vocab", vocab),
  shape: card.shape,
  tokens: card.tokens,
  prompt: card.prompt,
  confidence: card.confidence,
};
await writeFile(join(outDir, "ajar-complete.json"), JSON.stringify(manifest, null, 2) + "\n");
const keep = new Set([manifest.model.file, manifest.vocab.file].flatMap((f) => [f, `${f}.zst`, `${f}.gz`]));
for (const name of await readdir(outDir)) {
  if (name.startsWith("ajar-complete-") && !keep.has(name)) {
    await rm(join(outDir, name));
    console.log(`  dropped ${name}`);
  }
}
console.log("  ajar-complete.json");

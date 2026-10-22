// The tokenizer as the browser reads it, from a Hugging Face tokenizer.json.
//
// The JSON is 442 KB and needs a byte-level alphabet undone and 16,000 merges
// parsed before the first prompt; this is the same content in 214 KB, in the
// order src/tokenizer.ts uses it:
//
//   "PCV1", u32 tokens, u32 merges
//   per token:  u8 flags (1 matched as written in the input, 2 left out when decoding), u8 length, bytes
//   per merge, best first:  u16 left, u16 right, u16 merged
//
// Only what src/tokenizer.ts implements is accepted — NFC, the one split
// pattern, byte-level BPE without dropout or an unknown token — so a tokenizer
// of another shape fails here rather than tokenizing differently in a browser.

const PATTERN = "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

const fail = (what) => {
  throw new Error(`tokenizer.json: ${what}`);
};

/** GPT-2's bytes_to_unicode, backwards: printable bytes stand for themselves, the rest are shifted past 255 in order. */
function byteAlphabet() {
  const keep = new Set();
  for (let b = 33; b <= 126; b++) keep.add(b);
  for (let b = 161; b <= 172; b++) keep.add(b);
  for (let b = 174; b <= 255; b++) keep.add(b);
  const byteOf = new Map();
  let n = 0;
  for (let b = 0; b < 256; b++) byteOf.set(String.fromCodePoint(keep.has(b) ? b : 256 + n++), b);
  return byteOf;
}

/** The vocabulary file for a parsed tokenizer.json. */
export function buildVocab(tj) {
  if (tj.normalizer?.type !== "NFC") fail("the normalizer is not NFC");
  const pre = tj.pre_tokenizer?.pretokenizers;
  if (pre?.length !== 2 || pre[0].type !== "Split" || pre[0].pattern?.Regex !== PATTERN || pre[0].behavior !== "Isolated" || pre[0].invert
    || pre[1].type !== "ByteLevel" || pre[1].add_prefix_space || pre[1].use_regex) fail("the pre-tokenizer is not Qwen2's split and byte level");
  if (tj.post_processor) fail("it has a post-processor");
  const m = tj.model;
  if (m.type !== "BPE" || m.dropout || m.unk_token || m.continuing_subword_prefix || m.end_of_word_suffix || m.byte_fallback || m.ignore_merges) {
    fail("the model is not plain byte-level BPE");
  }
  const byteOf = byteAlphabet();
  const added = new Map(tj.added_tokens.map((t) => [t.id, t]));
  for (const t of tj.added_tokens) if (t.single_word || t.lstrip || t.rstrip || t.normalized) fail(`added token ${t.content} is not matched as written`);
  const n = Math.max(...Object.values(m.vocab), ...added.keys()) + 1;
  const bytes = new Array(n);
  const flags = new Uint8Array(n);
  for (const [s, id] of Object.entries(m.vocab)) {
    bytes[id] = Uint8Array.from([...s].map((ch) => byteOf.get(ch) ?? fail(`token ${id} has a character outside the byte alphabet`)));
  }
  for (const [id, t] of added) {
    bytes[id] = new TextEncoder().encode(t.content);
    flags[id] = 1 | (t.special ? 2 : 0);
  }
  for (let id = 0; id < n; id++) {
    if (!bytes[id]) fail(`there is no token ${id}`);
    if (bytes[id].length > 255) fail(`token ${id} is over 255 bytes`);
  }
  for (const [ch, b] of byteOf) if (m.vocab[ch] === undefined) fail(`there is no token for byte ${b}`);

  const merges = m.merges.map((x) => (typeof x === "string" ? x.split(" ") : x));
  const triples = new Uint16Array(merges.length * 3);
  merges.forEach(([a, b], i) => {
    const ia = m.vocab[a], ib = m.vocab[b], ic = m.vocab[a + b];
    if (ia === undefined || ib === undefined || ic === undefined) fail(`merge ${i} names a token the vocabulary lacks`);
    triples.set([ia, ib, ic], i * 3);
  });

  let size = 12 + merges.length * 6;
  for (let id = 0; id < n; id++) size += 2 + bytes[id].length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x31564350, true); // "PCV1"
  dv.setUint32(4, n, true);
  dv.setUint32(8, merges.length, true);
  let o = 12;
  for (let id = 0; id < n; id++) {
    out[o] = flags[id];
    out[o + 1] = bytes[id].length;
    out.set(bytes[id], o + 2);
    o += 2 + bytes[id].length;
  }
  triples.forEach((v, i) => dv.setUint16(o + i * 2, v, true));
  return out;
}

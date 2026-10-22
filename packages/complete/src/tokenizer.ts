/**
 * The model's tokenizer: Qwen2.5's byte-level BPE cut to its first 16,000
 * merges, read from the file scripts/make-vocab.mjs writes.
 *
 * It has to agree with Hugging Face `tokenizers` token for token, because that
 * is what the model was trained and measured on; a prompt split differently
 * is a prompt the model has never seen. test/tokenizer.test.mjs holds it to
 * fixtures that library wrote, and the parity run in the autocomplete study to
 * every file of both evaluation sets.
 *
 * The steps, in that library's order: tokens written out in the text
 * (`<|endoftext|>` and the FIM markers) are cut out first and kept whole; each
 * piece between them is NFC-normalized, split by Qwen2's pattern, and each
 * split is merged from bytes by rank.
 */

/** Unicode White_Space — Oniguruma's `\s`. JavaScript's adds U+FEFF and lacks U+0085. */
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/**
 * Qwen2's pre-tokenizer pattern, in JavaScript:
 * `(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+`.
 * The case-insensitive group is spelled out (U+017F, long s, folds to s), and
 * `\s` is the set above.
 */
const SPLIT = new RegExp(
  "'(?:[sS\\u017f]|[tT]|[rR][eE]|[vV][eE]|[mM]|[lL][lL]|[dD])" +
    "|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+" +
    "|\\p{N}" +
    `| ?[^${WS}\\p{L}\\p{N}]+[\\r\\n]*` +
    `|[${WS}]*[\\r\\n]+` +
    `|[${WS}]+(?![^${WS}])` +
    `|[${WS}]+`,
  "gu",
);
const ASCII = /^[\x00-\x7f]*$/;
const CACHE_MAX = 1 << 16;

const FLAG_LITERAL = 1;
const FLAG_SKIP = 2;

export class Tokenizer {
  /** Each token's bytes. */
  readonly bytes: Uint8Array[];
  /**
   * Each token decoded on its own, as `tokenizer.decode([id])` gives it:
   * invalid UTF-8 as U+FFFD, and "" for the tokens decoding leaves out. Token
   * healing compares against these, as the evaluation did.
   */
  readonly text: string[];
  private readonly flags: Uint8Array;
  private readonly byteId = new Int32Array(256);
  /** (left << 16 | right) -> rank */
  private readonly rankOf = new Map<number, number>();
  private readonly mergedOf: Uint16Array;
  /** Written-out tokens, longest first, for leftmost-longest matching. */
  private readonly literals: { text: string; id: number }[] = [];
  private readonly cache = new Map<string, number[]>();
  private readonly utf8 = new TextEncoder();
  private readonly lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

  constructor(file: ArrayBuffer) {
    const dv = new DataView(file);
    if (file.byteLength < 12 || dv.getUint32(0, true) !== 0x31564350) throw new Error("not a vocabulary file");
    const n = dv.getUint32(4, true);
    const nm = dv.getUint32(8, true);
    const all = new Uint8Array(file);
    this.bytes = new Array<Uint8Array>(n);
    this.flags = new Uint8Array(n);
    let o = 12;
    for (let id = 0; id < n; id++) {
      this.flags[id] = all[o]!;
      const len = all[o + 1]!;
      this.bytes[id] = all.subarray(o + 2, o + 2 + len);
      o += 2 + len;
    }
    this.byteId.fill(-1);
    for (let id = 0; id < n; id++) {
      const b = this.bytes[id]!;
      if (b.length === 1 && !(this.flags[id]! & FLAG_LITERAL)) this.byteId[b[0]!] = id;
    }
    this.mergedOf = new Uint16Array(nm);
    for (let r = 0; r < nm; r++) {
      const p = o + r * 6;
      this.rankOf.set((dv.getUint16(p, true) << 16) | dv.getUint16(p + 2, true), r);
      this.mergedOf[r] = dv.getUint16(p + 4, true);
    }
    this.text = this.bytes.map((b, id) => (this.flags[id]! & FLAG_SKIP ? "" : this.lossy.decode(b)));
    for (let id = 0; id < n; id++) {
      if (this.flags[id]! & FLAG_LITERAL) this.literals.push({ text: this.lossy.decode(this.bytes[id]!), id });
    }
    this.literals.sort((a, b) => b.text.length - a.text.length);
  }

  get size(): number {
    return this.bytes.length;
  }

  /**
   * Token ids for `text`. With `limit`, stops once that many are made — the
   * first `limit` of the full encoding, since splits are tokenized
   * independently. With `starts`, also records where in `text` each token's
   * split began.
   */
  encode(text: string, limit = Infinity, starts?: number[]): number[] {
    const out: number[] = [];
    let at = 0;
    while (at < text.length && out.length < limit) {
      const hit = this.nextLiteral(text, at);
      const end = hit ? hit.at : text.length;
      if (end > at) this.encodePiece(text.slice(at, end), at, out, limit, starts);
      if (!hit || out.length >= limit) break;
      out.push(hit.id);
      starts?.push(hit.at);
      at = hit.at + hit.len;
    }
    if (out.length > limit) {
      out.length = limit;
      if (starts) starts.length = limit;
    }
    return out;
  }

  /** The text of `ids`, as `tokenizer.decode(ids)` gives it. */
  decode(ids: readonly number[]): string {
    let n = 0;
    for (const id of ids) if (!(this.flags[id]! & FLAG_SKIP)) n += this.bytes[id]!.length;
    const buf = new Uint8Array(n);
    let o = 0;
    for (const id of ids) {
      if (this.flags[id]! & FLAG_SKIP) continue;
      buf.set(this.bytes[id]!, o);
      o += this.bytes[id]!.length;
    }
    return this.lossy.decode(buf);
  }

  private nextLiteral(text: string, from: number): { at: number; len: number; id: number } | null {
    for (let i = text.indexOf("<|", from); i >= 0; i = text.indexOf("<|", i + 1)) {
      for (const l of this.literals) if (text.startsWith(l.text, i)) return { at: i, len: l.text.length, id: l.id };
    }
    return null;
  }

  private encodePiece(piece: string, base: number, out: number[], limit: number, starts?: number[]): void {
    const norm = ASCII.test(piece) ? piece : piece.normalize("NFC");
    SPLIT.lastIndex = 0;
    let last = 0;
    for (let m = SPLIT.exec(norm); m && out.length < limit; m = SPLIT.exec(norm)) {
      // Isolated: what lies between two matches is a split of its own. The
      // pattern leaves nothing between, but the library would keep it.
      if (m.index > last) this.word(norm.slice(last, m.index), base + last, out, starts);
      if (out.length >= limit) return;
      this.word(m[0], base + m.index, out, starts);
      last = m.index + m[0].length;
    }
    if (last < norm.length && out.length < limit) this.word(norm.slice(last), base + last, out, starts);
  }

  private word(w: string, at: number, out: number[], starts?: number[]): void {
    let ids = this.cache.get(w);
    if (!ids) {
      ids = this.bpe(this.utf8.encode(w));
      if (this.cache.size >= CACHE_MAX) this.cache.clear();
      this.cache.set(w, ids);
    }
    for (const id of ids) {
      out.push(id);
      starts?.push(at);
    }
  }

  /**
   * Byte-level BPE as `tokenizers` does it: a heap of candidate merges by
   * (rank, position), each re-checked when it comes off, since an earlier
   * merge may have used one of its halves.
   */
  private bpe(b: Uint8Array): number[] {
    const n = b.length;
    const c = new Int32Array(n);
    for (let i = 0; i < n; i++) c[i] = this.byteId[b[i]!]!;
    if (n === 1) return [c[0]!];
    const prev = new Int32Array(n);
    const next = new Int32Array(n);
    const gone = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      prev[i] = i - 1;
      next[i] = i + 1 < n ? i + 1 : -1;
    }
    const heap = new MergeHeap();
    for (let i = 0; i + 1 < n; i++) {
      const r = this.rankOf.get((c[i]! << 16) | c[i + 1]!);
      if (r !== undefined) heap.push(r, i);
    }
    while (heap.size) {
      const key = heap.pop();
      const r = Math.floor(key / POS);
      const pos = key - r * POS;
      if (gone[pos]) continue;
      const nx = next[pos]!;
      if (nx < 0) continue;
      if (this.rankOf.get((c[pos]! << 16) | c[nx]!) !== r) continue;
      c[pos] = this.mergedOf[r]!;
      gone[nx] = 1;
      const after = next[nx]!;
      next[pos] = after;
      if (after >= 0) prev[after] = pos;
      const pv = prev[pos]!;
      if (pv >= 0) {
        const rp = this.rankOf.get((c[pv]! << 16) | c[pos]!);
        if (rp !== undefined) heap.push(rp, pv);
      }
      if (after >= 0) {
        const rn = this.rankOf.get((c[pos]! << 16) | c[after]!);
        if (rn !== undefined) heap.push(rn, pos);
      }
    }
    const ids: number[] = [];
    for (let i = 0; i >= 0; i = next[i]!) ids.push(c[i]!);
    return ids;
  }
}

/** Positions per rank in a heap key: rank * POS + position, so one number orders both. */
const POS = 2 ** 26;

/** A binary min-heap of numbers. */
class MergeHeap {
  private a: number[] = [];
  get size(): number {
    return this.a.length;
  }
  push(rank: number, pos: number): void {
    const a = this.a;
    let i = a.length;
    a.push(rank * POS + pos);
    const v = a[i]!;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]! <= v) break;
      a[i] = a[p]!;
      i = p;
    }
    a[i] = v;
  }
  pop(): number {
    const a = this.a;
    const top = a[0]!;
    const v = a.pop()!;
    if (a.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= a.length) break;
        const r = l + 1;
        const m = r < a.length && a[r]! < a[l]! ? r : l;
        if (a[m]! >= v) break;
        a[i] = a[m]!;
        i = m;
      }
      a[i] = v;
    }
    return top;
  }
}

/**
 * What somebody typed into a file before its shared document was ready.
 *
 * The editor shows the stored copy the moment a file opens. The document
 * arrives a moment later — once the relay has said who is here and somebody
 * has sent theirs — and binding it puts the document's text in the editor.
 * Whatever was typed in between would go with the text it replaced.
 *
 * Split out of `app.ts` for the same reason as `seed.ts`: the moment it runs
 * is a race, and as a function over three strings it is ordinary.
 */

/**
 * The common start and end of two texts, `head` and `tail` long, moved so
 * that neither cuts a character in two. An emoji is two UTF-16 units, and two
 * from one block share the first: changed one for the other, the difference
 * began between the halves, and a CRDT asked to cut a character there puts a
 * replacement character in each half.
 */
export function wholeCharacters(a: string, head: number, tail: number): [number, number] {
  const low = (i: number) => i >= 0 && i < a.length && a.charCodeAt(i) >= 0xdc00 && a.charCodeAt(i) <= 0xdfff;
  if (head > 0 && low(head)) head--;
  if (tail > 0 && low(a.length - tail)) tail--;
  return [head, tail];
}

/** Remove `remove` characters at `at`, and put `insert` there. */
export interface Edit {
  at: number;
  remove: number;
  insert: string;
}

/**
 * The typing as one edit to the document's text, or null when the document
 * needs none.
 *
 * `shown` is what the editor showed when the file opened, `typed` what it held
 * when the document arrived, and `doc` the document's text. Usually `doc` is
 * `shown`, and the edit is exactly what was typed. When somebody else's work
 * is in the document too, the two are merged (`merge`), and the edit is what
 * makes the document that: one edit, from the first place the two differ to
 * the last, since everything that takes this applies one.
 */
export function carryOver(shown: string, typed: string, doc: string): Edit | null {
  if (typed === shown) return null;
  const merged = merge(shown, typed, doc);
  if (merged === doc) return null;
  return between(doc, merged);
}

/** `edit` made to `text`. */
export function applied(text: string, edit: Edit | null): string {
  return edit ? text.slice(0, edit.at) + edit.insert + text.slice(edit.at + edit.remove) : text;
}

/**
 * What a page that lost its access puts back into the pad once it has it
 * again: each file it kept that changed here — `base` the stored text when
 * access went, `mine` what the page holds now, null for deleted — rebased
 * onto the pad as it stands. A file not changed here is left alone, and so is
 * one the pad already holds the change in. It used to be written back
 * whatever it held, over whatever collaborators had done to it meanwhile.
 */
export function putBack(
  kept: Map<string, { base: string | undefined; mine: string | null }>,
  stored: Map<string, string>,
): { path: string; content: string | null }[] {
  const out: { path: string; content: string | null }[] = [];
  for (const [path, { base, mine }] of kept) {
    if (mine === base) continue;
    const now = stored.get(path);
    if (mine === null || now === undefined || base === undefined) {
      out.push({ path, content: mine });
      continue;
    }
    const content = applied(now, carryOver(base, mine, now));
    if (content !== now) out.push({ path, content });
  }
  return out;
}

/** The one edit that makes `from` into `to`: what lies between their common start and end. */
function between(from: string, to: string): Edit {
  const shorter = Math.min(from.length, to.length);
  let head = 0;
  while (head < shorter && from.charCodeAt(head) === to.charCodeAt(head)) head++;
  let tail = 0;
  while (tail < shorter - head && from.charCodeAt(from.length - 1 - tail) === to.charCodeAt(to.length - 1 - tail)) tail++;
  [head, tail] = wholeCharacters(from, head, tail);
  [head, tail] = wholeCharacters(to, head, tail);
  return { at: head, remove: from.length - head - tail, insert: to.slice(head, to.length - tail) };
}

// ------------------------------------------------------------------- merge

/**
 * Two changes of `base` made one: `mine`, this page's, and `theirs`, what
 * everyone else's work has made of it — the document.
 *
 * Each side's change is found as hunks, line by line, and a hunk goes in
 * where it was made when the other side did not touch those lines. Where both
 * did, the stretch is compared again character by character, so two edits to
 * one line that do not meet are both kept. Where they still meet:
 *
 * - the same change on both sides goes in once;
 * - otherwise the stretch is the other side's text, then what this side
 *   typed into it, less any start or end of that the other side typed too.
 *   Nothing anyone else wrote is removed, nothing typed is lost, and nothing
 *   that was in `base` comes out twice. A deletion over text somebody
 *   changed removes none of theirs; typing inside text somebody deleted is
 *   kept, the deletion too.
 *
 * Until 18 October the local change was one replacement, from the first
 * character typed to the last, and when somebody else had changed anything
 * in between it all went in beside their text — the original lines it had
 * kept included. `A B C` made `a B c` here while somebody made `B` into `B!`
 * came out `a B cA B! C`, a line each (audit of 17 October, DC-06).
 *
 * One limit, for changes too large to compare (`MOST_STEPS`, `MOST_WORK`):
 * a stretch past them that no unchanged unique line divides is one hunk, and
 * where the two sides' hunks meet there, the rule above can keep some
 * original text twice. That takes somebody rewriting most of a large file
 * while somebody else edits it.
 */
export function merge(base: string, mine: string, theirs: string): string {
  if (mine === base || mine === theirs) return theirs;
  if (theirs === base) return mine;
  // Whole lines at either end that nobody changed are left out of the
  // comparison, which is then usually a few lines however long the file.
  const limit = Math.min(base.length, mine.length, theirs.length);
  let head = 0;
  while (head < limit && base.charCodeAt(head) === mine.charCodeAt(head) && base.charCodeAt(head) === theirs.charCodeAt(head)) head++;
  head = head > 0 ? base.lastIndexOf("\n", head - 1) + 1 : 0;
  let tail = 0;
  while (
    tail < limit - head &&
    base.charCodeAt(base.length - 1 - tail) === mine.charCodeAt(mine.length - 1 - tail) &&
    base.charCodeAt(base.length - 1 - tail) === theirs.charCodeAt(theirs.length - 1 - tail)
  ) tail++;
  // From just after a line break inside it, so it starts a line in all three.
  const cut = base.indexOf("\n", base.length - tail);
  tail = cut === -1 ? 0 : base.length - cut - 1;
  const middle = (text: string) => linesOf(text.slice(head, text.length - tail));
  const [b, m, t] = numbered([middle(base), middle(mine), middle(theirs)]);
  return base.slice(0, head) + combine(b!, m!, t!, true) + base.slice(base.length - tail);
}

/** A stretch of the base, `from` up to `to` in pieces, that one side made `text`. */
interface Hunk {
  from: number;
  to: number;
  text: string;
}

/** A text in pieces — lines, or characters — and a number for each, the same for the same piece. */
interface Pieces {
  parts: string[];
  ids: Int32Array;
}

/** Lines, each with its line break. */
function linesOf(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    const nl = text.indexOf("\n", at);
    const end = nl === -1 ? text.length : nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

function numbered(texts: string[][]): Pieces[] {
  const seen = new Map<string, number>();
  return texts.map((parts) => {
    const ids = new Int32Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
      let id = seen.get(parts[i]!);
      if (id === undefined) {
        id = seen.size;
        seen.set(parts[i]!, id);
      }
      ids[i] = id;
    }
    return { parts, ids };
  });
}

/** Whether `x` is wholly before `y`, so both go in, `x` first. Two insertions at one place are not. */
function before(x: { from: number; to: number }, y: { from: number; to: number }): boolean {
  return x.to < y.from || (x.to === y.from && (x.from < x.to || y.from < y.to));
}

/** The merge of three texts in pieces: `inLines` for lines, which may be compared again by character. */
function combine(base: Pieces, mine: Pieces, theirs: Pieces, inLines: boolean): string {
  const ours = hunksOf(base, mine, inLines);
  const other = hunksOf(base, theirs, inLines);
  const out: string[] = [];
  let pos = 0;
  const upTo = (to: number) => {
    for (; pos < to; pos++) out.push(base.parts[pos]!);
  };
  let i = 0;
  let j = 0;
  while (i < ours.length || j < other.length) {
    const a = ours[i];
    const b = other[j];
    if (a && (!b || before(a, b))) {
      upTo(a.from);
      out.push(a.text);
      pos = a.to;
      i++;
    } else if (b && (!a || before(b, a))) {
      upTo(b.from);
      out.push(b.text);
      pos = b.to;
      j++;
    } else {
      // Both changed this stretch: it takes in every hunk of either side
      // that reaches into it, however far that carries it.
      const stretch = { from: Math.min(a!.from, b!.from), to: Math.max(a!.to, b!.to) };
      const mineIn = [a!];
      const theirsIn = [b!];
      i++;
      j++;
      for (;;) {
        const na = ours[i];
        const nb = other[j];
        if (na && !before(stretch, na)) {
          mineIn.push(na);
          stretch.to = Math.max(stretch.to, na.to);
          i++;
        } else if (nb && !before(stretch, nb)) {
          theirsIn.push(nb);
          stretch.to = Math.max(stretch.to, nb.to);
          j++;
        } else break;
      }
      upTo(stretch.from);
      out.push(settle(base, stretch.from, stretch.to, mineIn, theirsIn, inLines));
      pos = stretch.to;
    }
  }
  upTo(base.parts.length);
  return out.join("");
}

/** A character comparison of a stretch this long and longer is not tried. */
const MOST_CHARACTERS = 1 << 20;

/** A stretch both sides changed, `from` up to `to` of the base: see `merge` for the rule. */
function settle(base: Pieces, from: number, to: number, mineIn: Hunk[], theirsIn: Hunk[], inLines: boolean): string {
  const mine = spliced(base, from, to, mineIn);
  const theirs = spliced(base, from, to, theirsIn);
  if (mine === theirs) return mine;
  if (inLines) {
    const original = base.parts.slice(from, to).join("");
    if (original.length + mine.length + theirs.length < MOST_CHARACTERS) {
      // By code point, so no hunk cuts a character in two.
      const [b, m, t] = numbered([Array.from(original), Array.from(mine), Array.from(theirs)]);
      return combine(b!, m!, t!, false);
    }
  }
  // What both sides put in alike — `b` made `B` on both, and here a line
  // added after it — is in their text already, and goes in once.
  const typed = mineIn.map((h) => h.text).join("");
  const alike = theirsIn.map((h) => h.text).join("");
  const shorter = Math.min(typed.length, alike.length);
  let head = 0;
  while (head < shorter && typed.charCodeAt(head) === alike.charCodeAt(head)) head++;
  let tail = 0;
  while (tail < shorter - head && typed.charCodeAt(typed.length - 1 - tail) === alike.charCodeAt(alike.length - 1 - tail)) tail++;
  [head, tail] = wholeCharacters(typed, head, tail);
  return theirs + typed.slice(head, typed.length - tail);
}

/** The base from `from` up to `to`, with `hunks` made to it. */
function spliced(base: Pieces, from: number, to: number, hunks: Hunk[]): string {
  const out: string[] = [];
  let pos = from;
  for (const h of hunks) {
    for (; pos < h.from; pos++) out.push(base.parts[pos]!);
    out.push(h.text);
    pos = h.to;
  }
  for (; pos < to; pos++) out.push(base.parts[pos]!);
  return out.join("");
}

function hunksOf(base: Pieces, other: Pieces, anchored: boolean): Hunk[] {
  const runs: Run[] = [];
  compare(base.ids, other.ids, 0, base.ids.length, 0, other.ids.length, anchored, runs);
  return runs.map(([from, to, start, end]) => ({ from, to, text: other.parts.slice(start, end).join("") }));
}

// -------------------------------------------------------------------- diff

/** Where `a` and `b` differ: `a` from, `a` to, `b` from, `b` to. */
type Run = [number, number, number, number];

/** The most edits a shortest-path comparison looks for, and the most steps it takes looking. */
const MOST_STEPS = 1000;
const MOST_WORK = 20_000_000;

/**
 * The runs where `a` and `b` differ between the bounds given, in order.
 * Myers' shortest edit script, within limits; past them, lines that occur
 * once on each side and in the same order hold the two together, and the
 * gaps between are compared the same way. Characters repeat too often for
 * that (`anchored` false), and past the limits are one run.
 */
function compare(a: Int32Array, b: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number, anchored: boolean, out: Run[]): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    aLo++;
    bLo++;
  }
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
  }
  if (aLo === aHi && bLo === bHi) return;
  if (aLo === aHi || bLo === bHi) {
    out.push([aLo, aHi, bLo, bHi]);
    return;
  }
  const runs = shortest(a.subarray(aLo, aHi), b.subarray(bLo, bHi));
  if (runs) {
    for (const [s, e, t, u] of runs) out.push([s + aLo, e + aLo, t + bLo, u + bLo]);
    return;
  }
  const anchors = anchored ? uniqueInOrder(a, b, aLo, aHi, bLo, bHi) : [];
  if (anchors.length === 0) {
    out.push([aLo, aHi, bLo, bHi]);
    return;
  }
  for (const [i, j] of anchors) {
    compare(a, b, aLo, i, bLo, j, anchored, out);
    aLo = i + 1;
    bLo = j + 1;
  }
  compare(a, b, aLo, aHi, bLo, bHi, anchored, out);
}

/** Myers' greedy shortest edit script as runs, or null past `MOST_STEPS` or `MOST_WORK`. */
function shortest(a: Int32Array, b: Int32Array): Run[] | null {
  const n = a.length;
  const m = b.length;
  const most = Math.min(n + m, MOST_STEPS);
  const off = most + 1;
  const v = new Int32Array(2 * most + 3);
  // The furthest point on each diagonal after each step, for the walk back.
  const trace: Int32Array[] = [];
  let work = 0;
  for (let d = 0; d <= most; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      const start = x;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      work += x - start + 1;
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1));
        return walkBack(trace, n, m);
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
    if (work > MOST_WORK) return null;
  }
  return null;
}

function walkBack(trace: Int32Array[], n: number, m: number): Run[] {
  const runs: Run[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]!;
    const at = (k: number) => prev[k + d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    // The edit this step made, from (px, py): one piece of `b` put in, or
    // one of `a` taken out. Joined to the run after it when nothing the two
    // share lies between.
    const ex = down ? px : px + 1;
    const ey = down ? py + 1 : py;
    const last = runs[runs.length - 1];
    if (last && last[0] === ex && last[2] === ey && x === ex && y === ey) {
      last[0] = px;
      last[2] = py;
    } else {
      runs.push([px, ex, py, ey]);
    }
    x = px;
    y = py;
  }
  return runs.reverse();
}

/**
 * Pairs of positions, `a`'s and `b`'s, of pieces that occur once in each
 * between the bounds, as many as stay in the same order on both sides.
 */
function uniqueInOrder(a: Int32Array, b: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number): [number, number][] {
  // [times in a, times in b, where in a, where in b]
  const seen = new Map<number, [number, number, number, number]>();
  for (let i = aLo; i < aHi; i++) {
    const e = seen.get(a[i]!);
    if (e) e[0]++;
    else seen.set(a[i]!, [1, 0, i, -1]);
  }
  for (let j = bLo; j < bHi; j++) {
    const e = seen.get(b[j]!);
    if (e) {
      e[1]++;
      e[3] = j;
    }
  }
  const pairs: [number, number][] = [];
  for (const [inA, inB, i, j] of seen.values()) if (inA === 1 && inB === 1) pairs.push([i, j]);
  pairs.sort((p, q) => p[0] - q[0]);
  // The longest run of them increasing in `b` as well.
  const ends: number[] = [];
  const back = new Int32Array(pairs.length);
  for (let p = 0; p < pairs.length; p++) {
    const j = pairs[p]![1];
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[ends[mid]!]![1] < j) lo = mid + 1;
      else hi = mid;
    }
    back[p] = lo > 0 ? ends[lo - 1]! : -1;
    ends[lo] = p;
  }
  const out: [number, number][] = [];
  for (let p = ends.length ? ends[ends.length - 1]! : -1; p !== -1; p = back[p]!) out.push(pairs[p]!);
  return out.reverse();
}

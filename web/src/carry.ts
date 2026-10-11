/**
 * Typing to put back into a document whose text may have moved meanwhile.
 *
 * The same function as the pad's `carryOver` in `pad/src/carry.ts`, which
 * carries typing made before a file's document arrived; here it is typing
 * made while the page had lost touch with the host. Put back at the offset it
 * was typed at, as it was until 11 October, it went wherever that offset now
 * fell: "brave " typed after "hello ", with someone else's "Oh, " put in
 * front meanwhile, made "Oh, hebrave llo world" — and a delete could take
 * someone else's text.
 */

/** Remove `remove` characters at `at`, and put `insert` there. */
export interface Edit {
  at: number;
  remove: number;
  insert: string;
}

/**
 * The typing as one edit to the document's text, or null when there was none.
 *
 * `shown` is the text the typing started from, `typed` what it made of it,
 * and `doc` the document's text now. When somebody else's work is in the
 * document too, the edit goes where the text around it still matches; if
 * nothing does, what was typed is kept and nothing of anyone else's is
 * removed.
 */
export function carryOver(shown: string, typed: string, doc: string): Edit | null {
  if (typed === shown) return null;
  const shorter = Math.min(shown.length, typed.length);
  let head = 0;
  while (head < shorter && shown[head] === typed[head]) head++;
  let tail = 0;
  while (tail < shorter - head && shown[shown.length - 1 - tail] === typed[typed.length - 1 - tail]) tail++;
  const removed = shown.slice(head, shown.length - tail);
  const insert = typed.slice(head, typed.length - tail);

  // The text before the change is still there, and so is what it replaced.
  if (doc.startsWith(shown.slice(0, head)) && doc.slice(head, head + removed.length) === removed) {
    return { at: head, remove: removed.length, insert };
  }
  // Or the text after it is.
  const at = doc.length - tail - removed.length;
  if (at >= 0 && doc.endsWith(shown.slice(shown.length - tail)) && doc.slice(at, at + removed.length) === removed) {
    return { at, remove: removed.length, insert };
  }
  return { at: Math.min(head, doc.length), remove: 0, insert };
}

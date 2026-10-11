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
 * The typing as one edit to the document's text, or null when there was none.
 *
 * `shown` is what the editor showed when the file opened, `typed` what it held
 * when the document arrived, and `doc` the document's text. Usually `doc` is
 * `shown`, and the edit is exactly what was typed. When somebody else's work
 * is in the document too, the edit goes where the text around it still
 * matches; if nothing does, what was typed is kept and nothing of anyone
 * else's is removed.
 */
export function carryOver(shown: string, typed: string, doc: string): Edit | null {
  if (typed === shown) return null;
  const shorter = Math.min(shown.length, typed.length);
  let head = 0;
  while (head < shorter && shown[head] === typed[head]) head++;
  let tail = 0;
  while (tail < shorter - head && shown[shown.length - 1 - tail] === typed[typed.length - 1 - tail]) tail++;
  [head, tail] = wholeCharacters(shown, head, tail);
  [head, tail] = wholeCharacters(typed, head, tail);
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

/** `edit` made to `text`. */
export function applied(text: string, edit: Edit | null): string {
  return edit ? text.slice(0, edit.at) + edit.insert + text.slice(edit.at + edit.remove) : text;
}

/**
 * What a page that lost its access puts back into the pad once it has it
 * again: each file it kept that changed here — `base` the stored text when
 * access went, `mine` what the page holds now, null for deleted — rebased
 * onto the pad as it stands. A file not changed here is left alone. It used
 * to be written back whatever it held, over whatever collaborators had done
 * to it meanwhile.
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
    out.push({ path, content: applied(now, carryOver(base, mine, now)) });
  }
  return out;
}

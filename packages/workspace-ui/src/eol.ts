/**
 * Line endings as Monaco holds them, for the pad's documents and the guest
 * page's alike: a document holding what an editor would convert is one
 * every edit lands a character off in.
 */

/**
 * The line ending an editor model made from `text` has — Monaco's own rule,
 * so the two never disagree: CRLF when more than half the line breaks have a
 * carriage return, LF otherwise, and none when there are no line breaks.
 */
export function eolOf(text: string): "\n" | "\r\n" | null {
  let cr = 0;
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  const total = cr + lf + crlf;
  if (total === 0) return null;
  return cr + crlf > total / 2 ? "\r\n" : "\n";
}

/** Every line break in `text` as `eol`. */
export function withEol(text: string, eol: "\n" | "\r\n"): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

/**
 * Text as an editor holds it: one line ending throughout.
 *
 * A Monaco model cannot hold mixed line endings. Made from a file with both,
 * it converts them all to one, and from then on every offset after a
 * converted one was off by a character between the editor and the document:
 * a paste over a value in a CSV left part of the old value behind in the
 * document — what was saved, and what every other place showed once it opened
 * the file — while the screen that pasted looked right. Found in the pad on 9 October.
 */
export function asEditorHolds(text: string): string {
  const eol = eolOf(text);
  return eol ? withEol(text, eol) : text;
}

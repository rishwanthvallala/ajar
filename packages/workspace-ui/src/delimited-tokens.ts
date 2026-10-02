/**
 * Colours for CSV and TSV: every column its own, so a row can be read across.
 *
 * Its own module so it is fetched only once a folder has a file that needs
 * it — see delimited.ts.
 *
 * Hand-written rather than Monarch. A quoted field may run over several lines,
 * and outside one each line starts again at the first column; Monarch carries
 * its state from line to line with no way to reset it at a line's end.
 */

export interface Token { startIndex: number; scopes: string }

/** Where a line starts: at the first column, or inside a quoted field left open above it. */
export class DelimitedState {
  constructor(readonly column: number, readonly quoted: boolean) {}
  clone() { return this; }
  equals(other: unknown) {
    return other instanceof DelimitedState && other.column === this.column && other.quoted === this.quoted;
  }
}

const START = new DelimitedState(0, false);

/** Colours cycle after eight, so a wide table still reads as columns. */
export const PALETTE = 8;

/**
 * One line's tokens.
 *
 * A quote opens a quoted field only where a field starts, as RFC 4180 has it;
 * a quote in the middle of `5" screen` is a character. Inside a quoted field
 * the delimiter is text and `""` is a quote.
 */
export function tokenizeLine(line: string, state: DelimitedState, delimiter: string, language: string) {
  const tokens: Token[] = [];
  let column = state.quoted ? state.column : 0;
  let quoted = state.quoted;
  let fieldStart = !quoted;
  const mark = (at: number, scopes: string) => {
    if (tokens.at(-1)?.scopes !== scopes) tokens.push({ startIndex: at, scopes });
  };
  const field = () => `column${column % PALETTE}.${language}`;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      mark(i, field());
      if (ch === '"') {
        if (line[i + 1] === '"') i++;
        else quoted = false;
      }
      continue;
    }
    if (ch === delimiter) {
      mark(i, `delimiter.${language}`);
      column++;
      fieldStart = true;
      continue;
    }
    mark(i, field());
    if (ch === '"' && fieldStart) quoted = true;
    fieldStart = false;
  }
  return { tokens, endState: quoted ? new DelimitedState(column, true) : START };
}

/** Monaco's tokens provider, as far as this one needs it. */
export interface DelimitedProvider {
  getInitialState(): DelimitedState;
  tokenize(line: string, state: DelimitedState): { tokens: Token[]; endState: DelimitedState };
}

export function delimitedTokens(delimiter: string, language: string): DelimitedProvider {
  return {
    getInitialState: () => START,
    tokenize: (line: string, state: DelimitedState) => tokenizeLine(line, state, delimiter, language),
  };
}

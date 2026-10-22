/**
 * The prompt: the code after the cursor first, then the code before it
 *
 *   <fim_suffix> suffix (at most 256 tokens) <fim_middle> prefix
 *
 * which is the order the model was trained to fill in ("suffix-first"), and
 * the reason a keystroke is cheap: typing changes only the end of the prompt,
 * so everything before it is still in the cache.
 *
 * Token healing: the prefix's last token is left off and the first token the
 * model writes must begin with its text. Without it the model would be asked
 * to continue from a token boundary that only exists because the cursor is
 * there — `pri` rather than `print` — which it has rarely seen.
 *
 * Two ways to choose how much code before the cursor goes in. `evalPrompt`
 * is exactly what the evaluation did, for the parity check. `Prompter` is the
 * one for typing: it starts the prefix at a line and keeps that start while
 * the prefix still fits, so successive keystrokes share their whole beginning
 * with the cache.
 */
import type { PromptConfig } from "./manifest";
import type { Tokenizer } from "./tokenizer";

export interface Prompt {
  ids: number[];
  /** The text of the token left off, which the first written token must start with. */
  heal: string;
}

export interface Tokens {
  fimSuffix: number;
  fimMiddle: number;
}

/**
 * What the page sends: the code before the cursor, starting at the beginning
 * of document line `line` (or -1 when it was cut mid-line), and the code after.
 * `key` names the document, so a start chosen in one file is never used for another.
 */
export interface Request {
  key: string;
  line: number;
  prefix: string;
  suffix: string;
}

/** eval2.py's build_prompt for spm: the last 6,000 characters, then as many of their last tokens as fit. */
export function evalPrompt(tok: Tokenizer, cfg: PromptConfig, t: Tokens, prefix: string, suffix: string): Prompt | null {
  const suf = tok.encode(suffix, cfg.suffixTokens);
  const ids = tok.encode(lastCodePoints(prefix, cfg.prefixChars));
  const keep = cfg.ctx - cfg.maxNew - suf.length - 3;
  const pre = ids.slice(-keep);
  return assemble(tok, t, suf, pre);
}

export class Prompter {
  private anchor: { key: string; line: number } | null = null;
  private readonly tok: Tokenizer;
  private readonly cfg: PromptConfig;
  private readonly t: Tokens;
  /**
   * Tokens left free when a start is chosen, for the prefix to grow into
   * before a new start (and one whole prefix run) is needed. A quarter of the
   * room, at most 192: about 600 characters of typing.
   */
  private readonly headroom: number;

  constructor(tok: Tokenizer, cfg: PromptConfig, t: Tokens, headroom = 192) {
    this.tok = tok;
    this.cfg = cfg;
    this.t = t;
    this.headroom = headroom;
  }

  build(r: Request): Prompt | null {
    const suf = this.tok.encode(r.suffix, this.cfg.suffixTokens);
    const room = this.cfg.ctx - this.cfg.maxNew - suf.length - 3;
    let pre = this.kept(r, room);
    if (!pre) pre = this.choose(r, room);
    return assemble(this.tok, this.t, suf, pre);
  }

  /** The prefix from the start already chosen, while it is still a good one. */
  private kept(r: Request, room: number): number[] | null {
    const a = this.anchor;
    if (!a || a.key !== r.key || r.line < 0 || a.line < r.line) return null;
    const at = lineStart(r.prefix, a.line - r.line);
    if (at < 0) return null;
    const ids = this.tok.encode(r.prefix.slice(at));
    // Too long, or so short that more of the file would fit: choose again.
    if (ids.length > room || (ids.length * 2 < room && at > 0)) return null;
    return ids;
  }

  private choose(r: Request, room: number): number[] {
    const starts: number[] = [];
    const all = this.tok.encode(r.prefix, Infinity, starts);
    const fill = room - Math.min(this.headroom, room >> 2);
    this.anchor = null;
    if (all.length <= fill) {
      if (r.line >= 0) this.anchor = { key: r.key, line: r.line };
      return all;
    }
    // The first line that begins at or after the token where `fill` tokens
    // before the cursor start. On one very long line there is none: then the
    // prefix starts mid-line, with no start kept.
    const from = starts[all.length - fill]!;
    const nl = r.prefix[from - 1] === "\n" ? from - 1 : r.prefix.indexOf("\n", from);
    if (r.line < 0 || nl < 0 || nl + 1 >= r.prefix.length) return all.slice(-fill);
    let line = r.line;
    for (let i = r.prefix.indexOf("\n"); i >= 0 && i <= nl; i = r.prefix.indexOf("\n", i + 1)) line++;
    this.anchor = { key: r.key, line };
    return this.tok.encode(r.prefix.slice(nl + 1));
  }
}

function assemble(tok: Tokenizer, t: Tokens, suf: number[], pre: number[]): Prompt | null {
  if (!pre.length) return null;
  const heal = tok.text[pre[pre.length - 1]!]!;
  return { ids: [t.fimSuffix, ...suf, t.fimMiddle, ...pre.slice(0, -1)], heal };
}

/** Where the `n`th line after the first begins in `s`, or -1 if `s` has fewer lines. */
function lineStart(s: string, n: number): number {
  let at = 0;
  for (let i = 0; i < n; i++) {
    const nl = s.indexOf("\n", at);
    if (nl < 0) return -1;
    at = nl + 1;
  }
  return at;
}

/** The last `n` code points of `s`, as Python's s[-n:] counts. */
export function lastCodePoints(s: string, n: number): string {
  if (s.length <= n) return s;
  let i = s.length;
  for (let k = 0; k < n && i > 0; k++) {
    const c = s.charCodeAt(i - 1);
    i -= c >= 0xdc00 && c <= 0xdfff && i > 1 ? 2 : 1;
  }
  return s.slice(i);
}

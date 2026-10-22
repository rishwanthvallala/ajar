/**
 * One completion from request to text: the prompt, the run, the decoding, and
 * the cut the evaluation made. This is what the worker does with a request,
 * without the worker around it, so the tests run exactly this code.
 */
import type { Engine, Stop } from "./engine";
import type { Manifest } from "./manifest";
import { evalPrompt, Prompter, type Request } from "./prompt";
import type { Tokenizer } from "./tokenizer";

/** A FIM marker written out as text ends the completion there (eval_lib.SPECIAL). */
const SPECIAL = /<\|(?:fim_\w+|endoftext|file_sep|repo_name|im_start|im_end)\|>/;
/** What Python's str.rstrip() takes off. */
const TRAILING = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;

export interface Completion {
  /** What to insert at the cursor: at most one line, no trailing space. Empty when the model would write nothing. */
  text: string;
  /** Sum of the log-probabilities of the tokens written, the one that ended it included. */
  confidence: number;
  /** Tokens run for the prompt — the rest of it came from the cache. */
  prefilled: number;
  generated: number;
  ms: number;
}

export interface Options {
  /** The evaluation's prompt (last 6,000 characters) rather than the typing one. */
  eval?: boolean;
  /** Run the prompt into the cache and stop: the next keystroke there starts warm. */
  prepare?: boolean;
}

export class Session {
  readonly engine: Engine;
  readonly tok: Tokenizer;
  readonly manifest: Manifest;
  private readonly prompter: Prompter;
  private readonly ends: Set<number>;
  private readonly masks = new Map<string, Uint8Array>();

  constructor(engine: Engine, tok: Tokenizer, manifest: Manifest, headroom?: number) {
    this.engine = engine;
    this.tok = tok;
    this.manifest = manifest;
    this.prompter = new Prompter(tok, manifest.prompt, manifest.tokens, headroom);
    this.ends = new Set(manifest.tokens.stop);
  }

  /** The completion, null when there is no prompt to make (nothing before the cursor), or "stopped". */
  async complete(r: Request, stop: Stop, o: Options = {}): Promise<Completion | null | "stopped"> {
    const t0 = performance.now();
    const cfg = this.manifest.prompt;
    const p = o.eval ? evalPrompt(this.tok, cfg, this.manifest.tokens, r.prefix, r.suffix) : this.prompter.build(r);
    if (!p) return null;
    const prefilled = await this.engine.prefill(p.ids, stop);
    if (prefilled === null) return "stopped";
    if (o.prepare) return { text: "", confidence: -Infinity, prefilled, generated: 0, ms: performance.now() - t0 };
    // As eval2.py: the written text is checked for a line break after the
    // healed part, token by token, each token's text taken on its own.
    let written = "";
    const end = (id: number): boolean => {
      written += this.tok.text[id]!;
      return this.ends.has(id) || written.slice(p.heal.length).includes("\n");
    };
    const out = await this.engine.decode(this.mask(p.heal), cfg.maxNew, end, stop);
    if (!out) return "stopped";
    const text = this.tok.decode(out.ids).slice(p.heal.length).split(SPECIAL)[0]!.split("\n")[0]!.replace(TRAILING, "");
    return {
      text,
      confidence: out.lps.reduce((a, b) => a + b, 0),
      prefilled,
      generated: out.ids.length,
      ms: performance.now() - t0,
    };
  }

  /** The tokens the first written one may be: those whose text starts with the healed token's. */
  private mask(heal: string): Uint8Array {
    let m = this.masks.get(heal);
    if (!m) {
      m = new Uint8Array(this.manifest.tokens.used);
      for (let id = 0; id < m.length; id++) if (this.tok.text[id]!.startsWith(heal)) m[id] = 1;
      if (this.masks.size > 4096) this.masks.clear();
      this.masks.set(heal, m);
    }
    return m;
  }
}

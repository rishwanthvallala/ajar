/**
 * What a model directory says about itself, in `manifest.json` beside the
 * model and its vocabulary. scripts/install-model.mjs writes it; nothing in
 * the code names a model, so a new one is a new directory and nothing else.
 */
export interface Manifest {
  format: 1;
  /** The training run, for the record: "M1-qat". */
  name: string;
  model: FileRef;
  vocab: FileRef;
  /** The transformer's shape, as the engine needs it to read the blob. */
  shape: Shape;
  tokens: {
    /** Tokens with an embedding row that was trained; the rest are padding and never picked. */
    used: number;
    fimSuffix: number;
    fimMiddle: number;
    /** Tokens that end a completion: end-of-text and the FIM markers. */
    stop: number[];
  };
  prompt: PromptConfig;
  /**
   * Log-probability a completion must reach to be shown, by the share of
   * shown completions that should be exactly right: "70" is the cut at which
   * 70% of them were, on 18,060 places in code written in 2026, measured with
   * this engine.
   */
  confidence: Record<string, number>;
}

export interface FileRef {
  /** Relative to the manifest. Content-named, so it can be cached for good. */
  file: string;
  bytes: number;
  sha256: string;
}

export interface Shape {
  V: number;
  d: number;
  L: number;
  nh: number;
  nkv: number;
  ffn: number;
}

export interface PromptConfig {
  /** Prompt plus completion, in tokens. */
  ctx: number;
  /** Most tokens a completion may run to; one more ends it regardless. */
  maxNew: number;
  /** Most tokens of the code after the cursor. */
  suffixTokens: number;
  /** Characters before the cursor the evaluation tokenized. */
  prefixChars: number;
}

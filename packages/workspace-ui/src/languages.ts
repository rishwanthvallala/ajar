/**
 * Which colours a file gets, in both products.
 *
 * Until 28 September the pad loaded Monaco's core and no language at all, so
 * every file — Python included, the one thing the pad runs — was plain text.
 * pad/src/monaco-languages.ts registers Monarch tokenizers for the common
 * formats, ajar's viewer registers all of Monaco's, and delimited.ts adds CSV
 * and TSV to both. They colour on the main thread with no worker, and each is
 * fetched the first time a file needs it.
 *
 * The file's language comes from that registry rather than a list kept here:
 * each language names its own extensions and file names, so whatever Monaco
 * can colour, a file ending that way gets. Until 2 October ajar kept its own
 * list of 25 extensions instead, and so showed `.lua` or `.proto` as plain
 * text while it had the tokenizer for each loaded.
 */

export interface Language {
  id: string;
  extensions?: string[];
  filenames?: string[];
}

/**
 * Formats with no tokenizer of their own, and the one that colours them.
 *
 * JSON has a full language service in Monaco and no Monarch tokenizer, and the
 * service's worker cannot run here. JSON is a JavaScript object literal, so
 * JavaScript's colours are right for it; what is missing is validation. A
 * JSON Lines file is one such literal per line, which colours the same way.
 *
 * Matched against the end of the name, so a whole file name works too.
 */
const BORROWED: Record<string, string> = {
  ".json": "javascript",
  ".jsonc": "javascript",
  ".jsonl": "javascript",
  ".ndjson": "javascript",
  ".geojson": "javascript",
  ".webmanifest": "javascript",
  ".ipynb": "javascript",
  ".toml": "ini",
  "cargo.lock": "ini",
  "poetry.lock": "ini",
  ".env": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".zsh": "shell",
  ".fish": "shell",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
};

export function languageFor(languages: Language[], path: string): string {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  for (const [ext, id] of Object.entries(BORROWED)) {
    if (lower.endsWith(ext)) return id;
  }
  // A whole name first — `Dockerfile` is not an extension.
  for (const l of languages) {
    if (l.filenames?.some((f) => f.toLowerCase() === lower)) return l.id;
  }
  // The longest extension that matches wins, so a specific one is not lost to
  // a shorter one that happens to be registered first.
  let best: { id: string; length: number } | null = null;
  for (const l of languages) {
    for (const e of l.extensions ?? []) {
      if (lower.endsWith(e.toLowerCase()) && e.length > (best?.length ?? 0)) best = { id: l.id, length: e.length };
    }
  }
  return best?.id ?? "plaintext";
}

import type { DelimitedProvider } from "./delimited-tokens";

/**
 * CSV and TSV, which Monaco has no tokenizer for.
 *
 * Registering costs the two names below. The tokenizer itself is fetched the
 * first time a file of either kind turns up — the way Monaco's own languages
 * arrive — so a folder with no table in it never downloads it.
 */

/** The part of Monaco's `languages` namespace this needs; either product's version fits. */
export interface DelimitedLanguages {
  register(language: { id: string; extensions: string[]; aliases: string[] }): void;
  onLanguageEncountered(id: string, callback: () => void): unknown;
  setTokensProvider(id: string, provider: Promise<DelimitedProvider>): unknown;
}

const FORMATS = [
  { id: "csv", extensions: [".csv"], aliases: ["CSV"], delimiter: "," },
  { id: "tsv", extensions: [".tsv", ".tab"], aliases: ["TSV"], delimiter: "\t" },
];

export function registerDelimited(languages: DelimitedLanguages): void {
  for (const { id, extensions, aliases, delimiter } of FORMATS) {
    languages.register({ id, extensions, aliases });
    languages.onLanguageEncountered(id, () => {
      languages.setTokensProvider(id, import("./delimited-tokens").then((m) => m.delimitedTokens(delimiter, id)));
    });
  }
}

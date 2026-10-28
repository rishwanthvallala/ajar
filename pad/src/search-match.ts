/** Literal matching shared by the worker and replacement validation. Offsets are UTF-16. */
export interface SearchOptions {
  query: string;
  mode: "names" | "contents";
  folder: string;
  matchCase: boolean;
  wholeWord: boolean;
}
export interface SearchFile { path: string; text?: string; revision: number }
export interface SearchMatch {
  start: number; end: number; line: number; column: number;
  before: string; hit: string; after: string;
}
export interface SearchGroup { path: string; revision: number; matches: SearchMatch[] }
export interface SearchResults { generation: number; groups: SearchGroup[]; truncated: boolean }
export interface SearchRequest {
  generation: number; updates: SearchFile[]; removed: string[]; options: SearchOptions;
}
export interface ReplacementFile { path: string; before: string; matches: SearchMatch[] }
export interface ReplacementPlan { files: ReplacementFile[]; replacement: string; skipped: string[] }
export const SEARCH_LIMIT = 5000;

export function inFolder(path: string, folder: string): boolean {
  return !folder || path.startsWith(`${folder}/`);
}

const word = /[\p{L}\p{M}\p{N}_]/u;
function before(text: string, offset: number): string {
  if (offset <= 0) return "";
  const last = text.charCodeAt(offset - 1);
  return text.slice(offset - (last >= 0xdc00 && last <= 0xdfff && offset > 1 ? 2 : 1), offset);
}

/** No user-supplied regular expression is ever executed. */
export function literal(query: string, matchCase: boolean): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "gu" : "giu");
}

export function matchesIn(text: string, options: SearchOptions, limit = SEARCH_LIMIT + 1): SearchMatch[] {
  if (!options.query || /[\r\n]/.test(options.query)) return [];
  const regex = literal(options.query, options.matchCase);
  const matches: SearchMatch[] = [];
  let line = 1, counted = 0, lineStart = 0, lineEnd = -1;
  let nextLF = -1, nextCR = -1;
  for (let found = regex.exec(text); found; found = regex.exec(text)) {
    const start = found.index, end = start + found[0].length;
    if (options.wholeWord && (word.test(before(text, start)) || word.test(String.fromCodePoint(text.codePointAt(end) ?? 32)))) continue;
    for (let i = counted; i < start; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 10 || (ch === 13 && text.charCodeAt(i + 1) !== 10)) { line++; lineStart = i + 1; }
    }
    counted = start;
    // Cache each delimiter separately, including absence. Otherwise an LF-only
    // file's remaining tail is rescanned for CR on every matching line (and vice versa).
    if (lineEnd < end) {
      if (nextLF < end) {
        const at = text.indexOf("\n", end);
        nextLF = at < 0 ? text.length : at;
      }
      if (nextCR < end) {
        const at = text.indexOf("\r", end);
        nextCR = at < 0 ? text.length : at;
      }
      lineEnd = Math.min(nextLF, nextCR);
    }
    matches.push({ start, end, line, column: start - lineStart + 1,
      before: text.slice(Math.max(lineStart, start - 80), start), hit: found[0].slice(0, 160),
      after: text.slice(end, Math.min(lineEnd, end + 80)).replace(/\r$/, "") });
    if (matches.length >= limit) break;
  }
  return matches;
}

export function searchFile(file: SearchFile, options: SearchOptions, limit: number): SearchGroup | null {
  if (!options.query || /[\r\n]/.test(options.query) || !inFolder(file.path, options.folder)) return null;
  if (options.mode === "names") {
    const matches = matchesIn(file.path, { ...options, wholeWord: false, matchCase: false }, 1);
    return matches.length ? { path: file.path, revision: file.revision, matches } : null;
  }
  if (file.text === undefined) return null;
  const matches = matchesIn(file.text, options, limit);
  return matches.length ? { path: file.path, revision: file.revision, matches } : null;
}

export function replaced(text: string, matches: readonly SearchMatch[], replacement: string): string {
  const parts: string[] = [];
  let offset = 0;
  for (const match of matches) {
    parts.push(text.slice(offset, match.start), replacement);
    offset = match.end;
  }
  parts.push(text.slice(offset));
  return parts.join("");
}

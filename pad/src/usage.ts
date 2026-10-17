/**
 * Programs run, counted for the operator's view (crates/ajar-relay/src/usage.rs):
 * the language, and whether Run or a typed line started it — nothing about
 * the pad, the person or the program. Sent and forgotten: a count that does
 * not arrive is a count lower, never an error anyone sees.
 *
 * Opening a pad is counted by the relay itself, from the first read a page
 * makes (`Store.read`'s `opening`).
 */
import { commandsIn } from "./toolchains";

/** What Run runs, by the file's extension: runtime.ts's interpreters and toolchains.ts's runners. */
const BY_EXTENSION: Record<string, string> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  go: "go",
  java: "java",
  php: "php",
};

/** A typed line's language, by the first command in it that is one. */
const BY_COMMAND: Record<string, string> = {
  python: "python",
  python3: "python",
  flask: "python",
  pytest: "python",
  uvicorn: "python",
  gunicorn: "python",
  node: "javascript",
  clang: "c",
  gcc: "c",
  cc: "c",
  "clang++": "cpp",
  "g++": "cpp",
  "c++": "cpp",
  go: "go",
  java: "java",
  javac: "java",
  php: "php",
  repl: "lisp",
};

export function languageOfFile(path: string): string | null {
  return BY_EXTENSION[path.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

export function languageOfLine(line: string): string | null {
  for (const command of commandsIn(line)) {
    const language = BY_COMMAND[command];
    if (language) return language;
  }
  return null;
}

/** One run, in `language`, when it is one counted. */
export function countRun(language: string | null, via: "run" | "typed"): void {
  if (!language) return;
  // Not `keepalive`: a run is counted as it starts, with the page there, and
  // Chrome holds keepalive requests to a budget of their own.
  void fetch("/api/usage/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language, via }),
  }).catch(() => {});
}

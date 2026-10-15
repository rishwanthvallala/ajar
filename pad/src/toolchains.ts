/**
 * Languages fetched the first time they are used, not on every visit.
 *
 * Each is a package of its own, and every one is heavy: a C compiler is 106 MB
 * as published, Go 273. Shipped with the rest, every first visit would carry
 * them for the few who write C, so each is installed into the sandbox when a
 * line first names one of its commands, or Run is pressed on a file it runs.
 *
 * A package installed into a running sandbox is seen only by processes the
 * sandbox starts afterwards — not the shell already open, not a `bash -c`
 * from it, nothing under /bin (measured on 12 October). So installing one
 * means a fresh shell, opened where the old one was and with what it had
 * exported: see `App.prepare`.
 *
 * The registry has no JVM, no javac, no gcc and no tcc. C is clang; Java is a
 * package of our own, built by pad/scripts/build-java.mjs and answered for by
 * the service worker. See docs/dev/pad.md, "Languages on first use" and "Java".
 */

export interface Toolchain {
  /** What a person calls it. */
  name: string;
  /** The registry package, pinned with `=` as the shipped ones are. */
  pkg: string;
  /** The commands it provides; naming one installs it. */
  commands: readonly string[];
  /** Roughly what a first use downloads, said before it starts. */
  mb: number;
  /** How Run runs a file of this kind, by extension. */
  runs?: Readonly<Record<string, (file: string) => string>>;
  /** Said once, when it arrives: what would otherwise look like a fault. */
  note?: string;
}

/** Names people type for a C or C++ compiler, and what each stands for here. */
export const CLANG_ALIASES = [
  ["gcc", "clang"],
  ["cc", "clang"],
  ["g++", "clang --driver-mode=g++"],
  ["c++", "clang --driver-mode=g++"],
  ["clang++", "clang --driver-mode=g++"],
] as const;

/** A path as one shell word. */
const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * C++, compiled and run — and said first when it includes <iostream>, which
 * does not finish compiling here: fifteen minutes on a three-line program on
 * 12 October, where <cstdio> takes seconds. Without the word it looks hung.
 */
const cxx = (f: string) =>
  `{ grep -q '#include *<iostream>' ${quoted(f)} && echo "note: <iostream> does not finish compiling here — <cstdio> and printf do" >&2; true; } && clang++ ${quoted(f)} -o /tmp/a.out && /tmp/a.out`;

export const TOOLCHAINS: readonly Toolchain[] = [
  {
    // C, and C++ through clang told to be one: the package has no clang++.
    // gcc, g++, cc, c++ and clang++ are aliases to it (shell.ts), as on a Mac
    // — there is no gcc for this sandbox at all.
    name: "C and C++ (clang)",
    pkg: "clang/clang@=0.160000.1",
    commands: ["clang", "clang-16", "lld", "wasm-ld", "llvm-ar", "llvm-nm", ...CLANG_ALIASES.map(([alias]) => alias)],
    mb: 106,
    runs: {
      c: (f) => `clang ${quoted(f)} -o /tmp/a.out && /tmp/a.out`,
      cpp: (f) => cxx(f),
      cc: (f) => cxx(f),
      cxx: (f) => cxx(f),
    },
  },
  {
    name: "Node.js",
    pkg: "wasmer/edgejs@=0.2.5",
    commands: ["node", "npm", "pnpm", "edgejs"],
    mb: 75,
    runs: {
      js: (f) => `node ${quoted(f)}`,
      mjs: (f) => `node ${quoted(f)}`,
    },
  },
  {
    name: "PHP",
    pkg: "php/php@=8.3.403",
    commands: ["php"],
    mb: 82,
    runs: { php: (f) => `php ${quoted(f)}` },
  },
  {
    name: "Go",
    pkg: "golang/go@=1.25.5-wasix-1",
    commands: ["go", "gofmt"],
    mb: 273,
    runs: { go: (f) => `go run ${quoted(f)}` },
  },
  {
    // Ours, not the registry's: Ristretto, a JVM written in Rust, with Amazon
    // Corretto 25's class library. javac is compiled by the page with javac
    // compiled to WebAssembly (javac/bridge.ts), or where that cannot run, by the
    // JDK's own javac interpreted in the sandbox. A file is run as `java
    // File.java` runs it anywhere, compiled first.
    name: "Java",
    pkg: "ajar/java@=1.0.0",
    commands: ["java", "javac"],
    // The package, 61, and the fast javac with its class library, 4.6.
    mb: 66,
    // Said only when the fast javac is not there (App.prepare).
    note: "javac compiles in the sandbox here, which takes several seconds; a compiled class runs in under one",
    runs: { java: (f) => `java ${quoted(f)}` },
  },
  {
    // Its one command is called `repl`; there is no `clisp`. A file passed to
    // it crashes (exit 11), so Run is not offered for .lisp.
    name: "Common Lisp (clisp)",
    pkg: "selwynsimsek/clisp@=0.1.3",
    commands: ["repl"],
    mb: 4,
  },
];

/** Words that run the word after them: `time go build` uses go. */
const PREFIXES = new Set(["time", "exec", "command", "nohup", "env", "sudo", "nice", "builtin", "then", "do", "else", "if", "while", "until", "!"]);

/**
 * The commands a line runs: the first word of each part of it, past any
 * `NAME=value` and the words that only run the next one. Good enough for what
 * people type; a command named inside a script it runs is not seen, and says
 * "command not found" as it would anywhere.
 */
export function commandsIn(line: string): string[] {
  const out: string[] = [];
  for (const part of line.split(/\|\|?|&&|;|&|\(|\)|\n|`|\$\(/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || PREFIXES.has(words[i]!))) i++;
    const word = words[i];
    if (word) out.push(word.replace(/^.*\//, ""));
  }
  return out;
}

/** The toolchains a line needs that are not installed yet, in the order it names them. */
export function neededBy(line: string, installed: ReadonlySet<string>): Toolchain[] {
  const needed: Toolchain[] = [];
  for (const command of commandsIn(line)) {
    const t = TOOLCHAINS.find((c) => c.commands.includes(command));
    if (t && !installed.has(t.pkg) && !needed.includes(t)) needed.push(t);
  }
  return needed;
}

/** The toolchain Run uses for a file, and the line it runs it with. */
export function runnerFor(path: string): { toolchain: Toolchain; line: string } | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  for (const toolchain of TOOLCHAINS) {
    const run = toolchain.runs?.[ext];
    if (run) return { toolchain, line: run(path) };
  }
  return null;
}

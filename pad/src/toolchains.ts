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
 * The registry has no JVM, no javac, no gcc and no tcc. C is clang; Java and
 * C++ are packages of our own, built by pad/scripts/build-java.mjs and
 * build-cxx.mjs and answered for by the service worker. See docs/dev/pad.md,
 * "Languages on first use", "Java" and "C++".
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

/** Names people type for a C compiler, and what each stands for here. */
export const CLANG_ALIASES = [
  ["gcc", "clang"],
  ["cc", "clang"],
] as const;

/** Names people type for a C++ compiler: each is tools/cxx.py, with ajar/cxx's clang 22. */
export const CXX_COMMANDS = ["clang++", "g++", "c++"] as const;

/** A path as one shell word, nothing in it expanded — `$`, backquotes, spaces. */
export const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const TOOLCHAINS: readonly Toolchain[] = [
  {
    // C. gcc and cc are aliases to it (shell.ts), as on a Mac — there is no
    // gcc for this sandbox at all. Not C++: linked with wasm-ld's default
    // 64 KiB stack, it ran past it on the C++ standard library's headers.
    name: "C (clang)",
    pkg: "clang/clang@=0.160000.1",
    commands: ["clang", "clang-16", "lld", "wasm-ld", "llvm-ar", "llvm-nm", ...CLANG_ALIASES.map(([alias]) => alias)],
    mb: 106,
    runs: {
      c: (f) => `clang ${quoted(f)} -o /tmp/a.out && /tmp/a.out`,
    },
  },
  {
    // Ours: YoWASP's clang 22, one WASI module with an 8 MiB stack, and
    // wasi-sdk 34's libc++, built with C++ exceptions (build-cxx.mjs). Its
    // steps are run one at a time by tools/cxx.py, which clang++, g++ and c++
    // are aliases to (shell.ts); what it builds is a WASI program.
    name: "C++ (clang 22)",
    pkg: "ajar/cxx@=1.0.0",
    commands: ["cxx-llvm", ...CXX_COMMANDS],
    mb: 20,
    runs: {
      cpp: (f) => `clang++ ${quoted(f)} -o /tmp/a.out && /tmp/a.out`,
      cc: (f) => `clang++ ${quoted(f)} -o /tmp/a.out && /tmp/a.out`,
      cxx: (f) => `clang++ ${quoted(f)} -o /tmp/a.out && /tmp/a.out`,
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
 * The commands a line runs: the first word of each simple command in it,
 * past any `NAME=value` and the words that only run the next one (with their
 * options: `env -i node`). Read as a shell reads it — quotes, backslashes
 * and comments — so `echo 'hello; go run main.go'` runs `echo` and fetches
 * nothing, where splitting at every `;` fetched 273 MB of Go for it; and
 * `"node" app.js` is node (audit R5). Not a whole shell: a command named
 * inside a script it runs is not seen, and says "command not found" as it
 * would anywhere.
 */
export function commandsIn(line: string): string[] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length) word += line[++i];
      else word += c;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < line.length) word += line[++i];
      inWord = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "#" && !inWord) {
      // A comment, to the end of its line.
      const nl = line.indexOf("\n", i);
      if (nl < 0) break;
      i = nl - 1;
      continue;
    }
    if (c === "\n") {
      endCommand();
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      endCommand();
      i++;
      continue;
    }
    // A redirect's `&` — `2>&1`, `&>log` — is not a separator.
    if (c === "&" && (line[i - 1] === ">" || line[i - 1] === "<" || line[i + 1] === ">")) {
      word += c;
      inWord = true;
      continue;
    }
    if ("|&;()`".includes(c)) {
      endCommand();
      continue;
    }
    word += c;
    inWord = true;
  }
  endCommand();
  const out: string[] = [];
  for (const command of commands) {
    let i = 0;
    for (;;) {
      while (i < command.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[i]!)) i++;
      if (i < command.length && PREFIXES.has(command[i]!)) {
        i++;
        // The prefix's own options: `env -i`, `nice -n10`.
        while (i < command.length && command[i]!.startsWith("-")) i++;
        continue;
      }
      break;
    }
    const first = command[i];
    if (first) out.push(first.replace(/^.*\//, ""));
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

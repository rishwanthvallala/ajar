/**
 * Where a program's output points into the pad: the file and line a
 * traceback or a compiler names. Two uses (app.ts) — each place a link in the
 * terminal that opens the file there, and the errors a run reported marked in
 * the editor, as squiggles under the lines.
 *
 * What people run here, as each says it:
 *
 *   Python   File "/workspace/main.py", line 3, in f   …then  NameError: …
 *   clang    main.c:4:5: error: use of undeclared identifier 'x'
 *   Go       ./main.go:5:2: undefined: x
 *   javac    Main.java:3: error: ';' expected
 *   Java     Exception in thread "main" java.lang.…  …then  at Main.main(Main.java:5)
 *   Node     /workspace/app.js:3   …then  ReferenceError: …  at … (/workspace/app.js:3:13)
 *   PHP      PHP Parse error:  … in /workspace/index.php on line 3
 *
 * A path is the pad's when it is under /workspace or relative; which file it
 * is, exactly, is the caller's to say (`resolve`), since only the caller
 * knows the pad's files.
 */

/** A file and a line in it, 1-based, and the column when the output gives one. */
export interface Place {
  path: string;
  line: number;
  column?: number;
}

/** A place, with where in its line of output it is: for a link over it. */
export interface Found extends Place {
  /** From, and up to but not including, as indices into the line. */
  start: number;
  end: number;
}

export interface Problem extends Place {
  message: string;
  severity: "error" | "warning";
}

const SOURCE = String.raw`(?:py|pyw|js|mjs|cjs|ts|tsx|jsx|c|h|cc|cpp|cxx|hh|hpp|go|java|kt|php|rb|rs|lua|sh|lisp)`;
/** A path the way tools print one: `main.py`, `./src/a.go`, `/workspace/x/Main.java`. */
const PATH = String.raw`(?:\.{1,2}\/|\/)?[\w.\-+@]+(?:\/[\w.\-+@]+)*\.${SOURCE}`;

const PYTHON_FRAME = /File "([^"]+)", line (\d+)/g;
const PATH_LINE = new RegExp(String.raw`(?<![\w.\/])(${PATH}):(\d+)(?::(\d+))?`, "g");
const PHP_LINE = new RegExp(String.raw`in (${PATH}) on line (\d+)`, "g");

/** The places named in one line of output, in order. */
export function placesIn(line: string): Found[] {
  const found: Found[] = [];
  const add = (path: string, lineNo: string, column: string | undefined, start: number, end: number) => {
    if (found.some((f) => start < f.end && f.start < end)) return;
    found.push({ path, line: Number(lineNo), ...(column ? { column: Number(column) } : {}), start, end });
  };
  for (const m of line.matchAll(PYTHON_FRAME)) add(m[1]!, m[2]!, undefined, m.index!, m.index! + m[0].length);
  for (const m of line.matchAll(PHP_LINE)) {
    const at = m.index! + 3;
    add(m[1]!, m[2]!, undefined, at, m.index! + m[0].length);
  }
  for (const m of line.matchAll(PATH_LINE)) add(m[1]!, m[2]!, m[3], m.index!, m.index! + m[0].length);
  return found.sort((a, b) => a.start - b.start);
}

/** An exception's own line: `NameError: name 'x' is not defined`, `java.lang.RuntimeException: boom`. */
const EXCEPTION = /^(?:Exception in thread "[^"]*" )?((?:[A-Za-z_$][\w$]*\.)*(?:[A-Z][\w$]*)?(?:Error|Exception|Warning|Fault))\b(?::\s*(.*))?$/;
/** A compiler's: `main.c:4:5: error: …`, `Main.java:3: error: …`, `./main.go:5:2: undefined: x`. */
const COMPILER = new RegExp(String.raw`^(${PATH}):(\d+)(?::(\d+))?:\s*(?:(fatal error|error|warning|note):\s*)?(.+)$`);
const PHP_ERROR = new RegExp(String.raw`^(?:PHP )?(Parse error|Fatal error|Warning):\s+(.*?) in (${PATH})(?: on line |:)(\d+)`);
/** A stack frame: Java's `at Main.main(Main.java:5)`, Node's `at f (/workspace/app.js:3:13)`. */
const FRAME = new RegExp(String.raw`^\s+at .*?\(?(${PATH}):(\d+)(?::(\d+))?\)?$`);
/** Go's, under a panic: a tab, the file and line, and an offset. */
const GO_FRAME = new RegExp(String.raw`^\s+(${PATH}):(\d+)(?: \+0x[0-9a-f]+)?$`);
/** A Node error's first line, the file and line it is in, before the code and the caret. */
const NODE_HEADER = new RegExp(String.raw`^(${PATH}):(\d+)$`);

/**
 * The errors a run's output reports, each where it happened — for Python,
 * the innermost frame of the pad's own files (`ours`), not the library's it
 * was in when it raised. Stopped by Ctrl-C is not a problem with the code.
 */
export function problemsIn(output: string, ours: (path: string) => string | null): Problem[] {
  const problems: Problem[] = [];
  const add = (p: Problem) => {
    if (!problems.some((q) => q.path === p.path && q.line === p.line && q.message === p.message)) problems.push(p);
  };
  // The pad's innermost frame of the traceback being read, and Node's
  // `path:line` header, waiting for the exception's line that says what.
  let frame: Place | null = null;
  // In a Python traceback the exception is the first line not indented,
  // whatever it is called — `Boom: …` for a class of the program's own.
  let python = false;
  // A Java exception or a Go panic is said first and placed after, by the
  // first of its frames in the pad.
  let pending: { message: string } | null = null;
  // Python 3.13 colours its tracebacks, escapes in the middle of `File "…"`,
  // and so may anything: read as the text it is on screen.
  const text = output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;

    const pythonFrame = /^\s*File "([^"]+)", line (\d+)/.exec(line);
    if (pythonFrame) {
      const path = ours(pythonFrame[1]!);
      if (path) frame = { path, line: Number(pythonFrame[2]) };
      python = true;
      continue;
    }
    if (python && !/^\s/.test(line)) {
      python = false;
      if (/^(Traceback|During handling|The above exception)/.test(line)) {
        python = line.startsWith("Traceback");
        continue;
      }
      if (frame && !/^KeyboardInterrupt\b/.test(line)) add({ ...frame, message: line.trim(), severity: "error" });
      frame = null;
      continue;
    }
    if (line.startsWith("Traceback (most recent call last)")) {
      python = true;
      frame = null;
      continue;
    }
    if (line.startsWith("panic: ")) {
      pending = { message: line };
      continue;
    }
    const go = GO_FRAME.exec(line);
    if (go) {
      const path = ours(go[1]!);
      if (path && pending) {
        add({ path, line: Number(go[2]), message: pending.message, severity: "error" });
        pending = null;
      }
      continue;
    }
    const php = PHP_ERROR.exec(line);
    if (php) {
      const path = ours(php[3]!);
      if (path) add({ path, line: Number(php[4]), message: php[2]!.trim(), severity: php[1] === "Warning" ? "warning" : "error" });
      continue;
    }
    const stack = FRAME.exec(line);
    if (stack) {
      const path = ours(stack[1]!);
      if (path && pending) {
        add({ path, line: Number(stack[2]), ...(stack[3] ? { column: Number(stack[3]) } : {}), message: pending.message, severity: "error" });
        pending = null;
      }
      continue;
    }
    const compiler = COMPILER.exec(line);
    if (compiler) {
      const path = ours(compiler[1]!);
      const kind = compiler[4];
      if (path && kind !== "note") {
        add({ path, line: Number(compiler[2]), ...(compiler[3] ? { column: Number(compiler[3]) } : {}), message: compiler[5]!.trim(), severity: kind === "warning" ? "warning" : "error" });
      }
      continue;
    }
    const header = NODE_HEADER.exec(line);
    if (header) {
      const path = ours(header[1]!);
      if (path) frame = { path, line: Number(header[2]) };
      continue;
    }
    const exception = EXCEPTION.exec(line.trim());
    if (exception) {
      const message = exception[2] ? `${exception[1]}: ${exception[2]}` : exception[1]!;
      if (frame) add({ ...frame, message, severity: "error" });
      else if (line.startsWith("Exception in thread")) pending = { message };
      frame = null;
    }
  }
  return problems;
}

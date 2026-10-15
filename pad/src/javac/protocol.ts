/**
 * The fast javac's requests and answers, and the compile in between.
 *
 * `javac` in the sandbox is Ristretto's javac, which interprets the JDK's
 * compiler: several seconds a file. When the page is there to ask, it asks it
 * instead (ristretto.patch, `bridge.rs`): it writes everything javac would
 * read — the folder it ran in, its arguments, the source files they name and
 * what is on the class and source paths — into one request file under
 * `.ajar/javac/`, and the page compiles it with javac compiled ahead of time
 * to WebAssembly (`bridge.ts`, `worker.ts`). The answer is what javac printed,
 * its exit status, and every file it wrote, which the program in the sandbox
 * writes out itself, so they arrive as any program's files do.
 *
 * Both are a magic word and then records — a tag byte, then fields. A string
 * is a u32 length and UTF-8; bytes are a u32 length and the bytes; a number is
 * a float64. Little-endian throughout.
 *
 *   request  "AJR1"  C cwd | A arg | E $CLASSPATH | F path, modified, bytes
 *   answer   "AJS1"  X exit | O stdout | R stderr | W path, bytes
 *
 * No imports, so java-fidelity.mjs runs the same code under Node.
 */

export interface JavacFile {
  path: string;
  modified: number;
  data: Uint8Array;
}

export interface JavacRequest {
  cwd: string;
  args: string[];
  /** $CLASSPATH, or null when it is not set. */
  classPath: string | null;
  files: JavacFile[];
}

export interface JavacAnswer {
  exit: number;
  stdout: string;
  stderr: string;
  written: { path: string; data: Uint8Array }[];
}

/** The compiler as TeaVM exports it (org.ajar.javac.Javac). */
export interface TeaJavac {
  reset(): void;
  setCwd(cwd: string): void;
  addArg(arg: string): void;
  addFile(path: string, data: Int8Array, modified: number): void;
  setEnvClassPath(value: string): void;
  run(): number;
  stdout(): string;
  stderr(): string;
  outputPaths(): string[];
  outputData(index: number): Int8Array;
}

const REQUEST = "AJR1";
const ANSWER = "AJS1";

class Writer {
  private chunks: Uint8Array[] = [];
  private encoder = new TextEncoder();

  constructor(magic: string) {
    this.chunks.push(this.encoder.encode(magic));
  }

  tag(t: string): this {
    this.chunks.push(Uint8Array.of(t.charCodeAt(0)));
    return this;
  }

  bytes(b: Uint8Array): this {
    const n = new Uint8Array(4);
    new DataView(n.buffer).setUint32(0, b.length, true);
    this.chunks.push(n, b);
    return this;
  }

  string(s: string): this {
    return this.bytes(this.encoder.encode(s));
  }

  number(v: number): this {
    const n = new Uint8Array(8);
    new DataView(n.buffer).setFloat64(0, v, true);
    this.chunks.push(n);
    return this;
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

class Reader {
  private at = 4;
  private data: Uint8Array;
  private view: DataView;
  private decoder = new TextDecoder();

  // No parameter properties: Node runs this file by stripping its types.
  constructor(data: Uint8Array, magic: string) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (this.decoder.decode(data.subarray(0, 4)) !== magic) throw new Error(`not a ${magic} record`);
  }

  more(): boolean {
    return this.at < this.data.length;
  }

  tag(): string {
    return String.fromCharCode(this.data[this.at++]!);
  }

  bytes(): Uint8Array {
    const n = this.view.getUint32(this.at, true);
    const b = this.data.subarray(this.at + 4, this.at + 4 + n);
    if (b.length !== n) throw new Error("truncated");
    this.at += 4 + n;
    return b;
  }

  string(): string {
    return this.decoder.decode(this.bytes());
  }

  number(): number {
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }
}

export function encodeRequest(r: JavacRequest): Uint8Array {
  const w = new Writer(REQUEST).tag("C").string(r.cwd);
  for (const a of r.args) w.tag("A").string(a);
  if (r.classPath !== null) w.tag("E").string(r.classPath);
  for (const f of r.files) w.tag("F").string(f.path).number(f.modified).bytes(f.data);
  return w.done();
}

export function decodeRequest(data: Uint8Array): JavacRequest {
  const r = new Reader(data, REQUEST);
  const out: JavacRequest = { cwd: "/", args: [], classPath: null, files: [] };
  while (r.more()) {
    const t = r.tag();
    if (t === "C") out.cwd = r.string();
    else if (t === "A") out.args.push(r.string());
    else if (t === "E") out.classPath = r.string();
    else if (t === "F") out.files.push({ path: r.string(), modified: r.number(), data: r.bytes() });
    else throw new Error(`unknown request record ${t}`);
  }
  return out;
}

export function encodeAnswer(a: JavacAnswer): Uint8Array {
  const w = new Writer(ANSWER).tag("X").number(a.exit).tag("O").string(a.stdout).tag("R").string(a.stderr);
  for (const f of a.written) w.tag("W").string(f.path).bytes(f.data);
  return w.done();
}

export function decodeAnswer(data: Uint8Array): JavacAnswer {
  const r = new Reader(data, ANSWER);
  const out: JavacAnswer = { exit: 4, stdout: "", stderr: "", written: [] };
  while (r.more()) {
    const t = r.tag();
    if (t === "X") out.exit = r.number();
    else if (t === "O") out.stdout = r.string();
    else if (t === "R") out.stderr = r.string();
    else if (t === "W") out.written.push({ path: r.string(), data: r.bytes() });
    else throw new Error(`unknown answer record ${t}`);
  }
  return out;
}

const signed = (b: Uint8Array) => new Int8Array(b.buffer, b.byteOffset, b.byteLength);

/** One javac run, as the request describes it. */
export function compile(javac: TeaJavac, r: JavacRequest): JavacAnswer {
  javac.reset();
  javac.setCwd(r.cwd);
  for (const a of r.args) javac.addArg(a);
  if (r.classPath !== null) javac.setEnvClassPath(r.classPath);
  for (const f of r.files) javac.addFile(f.path, signed(f.data), f.modified);
  const exit = javac.run();
  const written = javac.outputPaths().map((path, i) => {
    const d = javac.outputData(i);
    return { path, data: new Uint8Array(d.buffer, d.byteOffset, d.byteLength) };
  });
  return { exit, stdout: javac.stdout(), stderr: javac.stderr(), written };
}

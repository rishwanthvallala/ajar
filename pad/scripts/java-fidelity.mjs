#!/usr/bin/env node
// Is the pad's Java the real thing? Every program here is run on HotSpot and on
// the Java package that ships, and what each printed is compared byte for byte.
//
//   node pad/scripts/java-fidelity.mjs [--only A,B] [--javac fast|sandbox|both|none]
//
// Two comparisons, both against Corretto, pinned in java/pins.mjs — the JDK
// whose class library the package carries:
//
//   run     each program in java/fidelity/run, compiled by HotSpot's javac,
//           run by HotSpot and by the package's `java`: stdout, stderr and the
//           exit status, given the same stdin (<Name>.in) and arguments
//           (<Name>.args) in an empty folder of its own;
//   javac   a folder of files and a javac command line, run by HotSpot's javac
//           and by ours: what it printed, its exit status, and every file it
//           wrote, byte for byte. The cases are each run program compiled with
//           -d, each program in java/fidelity/errors (which do not compile),
//           and the command lines in CLI below.
//
// "Ours" is the fast javac the page answers `javac` with (fast-javac.mjs runs it
// under Node, as the page does), or with --javac sandbox the package's own
// javac, which the sandbox falls back to; both, or neither.
//
// The package is read from pad/public/packages, as served, so build-java.mjs
// runs first. Its atoms run under Node's WASI rather than the pad's Wasmer;
// java/wasi-run.mjs says what that can miss.
//
// A difference listed in KNOWN is reported and allowed; any other fails the
// run. Needs podman, for HotSpot; scratch is target/java/fidelity.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CORRETTO } from "./java/pins.mjs";

const run = promisify(execFile);
const ROOT = new URL("../../", import.meta.url).pathname;
const HERE = new URL("./java/", import.meta.url).pathname;
const PROGRAMS = `${HERE}fidelity/`;
const SCRATCH = `${ROOT}target/java/fidelity/`;
const PACKAGES = `${ROOT}pad/public/packages/`;

// Differences we know of, and why they are allowed. Anything else fails.
// The package's JDK has no lib/ct.sym, javac's signatures of each release:
// it would be 10 MB for the slow javac alone, which the pad uses only where
// the fast one cannot run.
const NO_CT_SYM = "the package's JDK has no lib/ct.sym, so its own javac refuses --release and lists no releases in its help; the fast javac matches";
const KNOWN = {
  "run/Errors":
    "HotSpot's ClassCastException names the modules and its NullPointerException the method's full names; and storing an Integer in a String[] throws ArrayStoreException on HotSpot only — Ristretto's aastore does not check the element type yet",
  "javac:sandbox/cli/no-arguments": NO_CT_SYM,
  "javac:sandbox/cli/help": NO_CT_SYM,
  "javac:sandbox/cli/release-25": NO_CT_SYM,
};

const flags = process.argv.slice(2);
const only = flags.includes("--only") ? new Set(flags[flags.indexOf("--only") + 1].split(",")) : null;
const javacMode = flags.includes("--no-javac") ? "none" : flags.includes("--javac") ? flags[flags.indexOf("--javac") + 1] : "fast";
const compilers = { fast: ["fast"], sandbox: ["sandbox"], both: ["fast", "sandbox"], none: [] }[javacMode];
if (!compilers) throw new Error(`--javac takes fast, sandbox, both or none, not ${javacMode}`);
const wanted = (name) => !only || only.has(name.replace(/\.java$/, "").replace(/^.*\//, ""));

// Folders for the command-line cases.
const TREE = {
  "src/app/Main.java": "package app;\n\nimport util.Helper;\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println(Helper.twice(21));\n    }\n}\n",
  "src/util/Helper.java": "package util;\n\npublic class Helper {\n    public static int twice(int x) {\n        return 2 * x;\n    }\n}\n",
};
const BROKEN = {
  "src/app/UsesBroken.java": "package app;\n\npublic class UsesBroken {\n    int f() { return util.Broken.value(); }\n}\n",
  "src/util/Broken.java": "package util;\n\npublic class Broken {\n    public static int value() { return \"not a number\"; }\n}\n",
};
const program = (name) => ({ [`${name}.java`]: { from: `run/${name}.java` } });
const errorProgram = (name) => ({ [`${name}.java`]: { from: `errors/${name}.java` } });
const CLI = [
  { name: "no-arguments", args: [] },
  { name: "invalid-flag", args: ["-foo"] },
  { name: "missing-file", args: ["Missing.java"] },
  { name: "no-source-files", args: ["-d", "out"] },
  { name: "class-name", files: program("Strings"), args: ["Strings"] },
  { name: "version", args: ["-version"] },
  { name: "full-version", args: ["--full-version"] },
  { name: "help", args: ["--help"] },
  { name: "help-extra", args: ["--help-extra"] },
  { name: "packages-with-d", files: TREE, args: ["-d", "out", "-sourcepath", "src", "src/app/Main.java"] },
  { name: "packages-beside-sources", files: TREE, args: ["src/app/Main.java", "src/util/Helper.java"] },
  { name: "found-on-class-path", files: TREE, cwd: "src", args: ["app/Main.java"] },
  { name: "class-path-option", files: TREE, args: ["-cp", "src", "-d", "out", "src/app/Main.java"] },
  { name: "error-in-implicit-file", files: BROKEN, args: ["-sourcepath", "src", "-d", "out", "src/app/UsesBroken.java"] },
  { name: "lint-all", files: errorProgram("Warnings"), args: ["-Xlint:all", "-d", "out", "Warnings.java"] },
  { name: "nowarn", files: errorProgram("Warnings"), args: ["-nowarn", "-d", "out", "Warnings.java"] },
  { name: "werror", files: errorProgram("Warnings"), args: ["-Werror", "-Xlint:all", "-d", "out", "Warnings.java"] },
  { name: "debug-all", files: program("Strings"), args: ["-g", "-d", "out", "Strings.java"] },
  { name: "debug-none", files: program("Strings"), args: ["-g:none", "-d", "out", "Strings.java"] },
  { name: "parameters", files: program("Oop"), args: ["-parameters", "-d", "out", "Oop.java"] },
  { name: "release-25", files: program("Strings"), args: ["--release", "25", "-d", "out", "Strings.java"] },
  { name: "argument-file", files: { ...program("Strings"), "opts.txt": '-d "out dir"\n# a comment\nStrings.java\n' }, args: ["@opts.txt"] },
  { name: "max-errors", files: errorProgram("Types"), args: ["-Xmaxerrs", "2", "-d", "out", "Types.java"] },
  { name: "raw-diagnostics", files: errorProgram("Types"), args: ["-XDrawDiagnostics", "-d", "out", "Types.java"] },
  { name: "two-files", files: { ...program("Strings"), ...program("Numbers") }, args: ["-d", "out", "Strings.java", "Numbers.java"] },
];

async function sh(cmd, args, opts = {}) {
  try {
    return (await run(cmd, args, { maxBuffer: 64 << 20, ...opts })).stdout;
  } catch (e) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${e.stderr || e.message}`);
  }
}

/** Run a command to completion with a file as stdin; what it wrote, and its status. */
function capture(cmd, args, { stdin, cwd, timeout = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ out: Buffer.concat(out), err: Buffer.concat(err), code: signal ? `killed (${signal}, over ${timeout / 1000} s)` : code });
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

// ---- the package, as it ships ----
const own = JSON.parse(await readFile(`${PACKAGES}own.json`, "utf8").catch(() => {
  throw new Error("pad/public/packages has no own.json: run node pad/scripts/build-java.mjs");
}));
const shipped = Object.values(own.files).find((f) => f.includes("ajar-java-"));
const TOOLS = `${ROOT}target/webc-trim/`;
await sh("cargo", ["build", "--release", "--locked", "-q", "--manifest-path", `${HERE}../webc-trim/Cargo.toml`, "--target-dir", TOOLS]);
await rm(SCRATCH, { recursive: true, force: true });
await mkdir(SCRATCH, { recursive: true });
const PKG = `${SCRATCH}package/`;
await sh(`${TOOLS}release/webc-pack`, ["--extract", `${PACKAGES}${shipped.replace("/packages/", "")}`, PKG]);
console.log(`  ${shipped.replace("/packages/", "")} against ${CORRETTO.replace(/^.*@/, "Corretto ").slice(0, 26)}…`);

const runs = (await readdir(`${PROGRAMS}run`)).filter((f) => f.endsWith(".java") && wanted(f)).sort();
const errors = (await readdir(`${PROGRAMS}errors`)).filter((f) => f.endsWith(".java") && wanted(f)).sort();
const extra = async (name, ext) => (await readFile(`${PROGRAMS}run/${name}.${ext}`, "utf8").catch(() => "")).trim();
const base = (f) => f.replace(/\.java$/, "");

// Every javac case: a folder of files, the folder it runs in, a command line.
const cases = compilers.length
  ? [
      ...runs.map((f) => ({ name: `run/${base(f)}`, files: program(base(f)), args: ["-d", "out", f] })),
      ...errors.map((f) => ({ name: `errors/${base(f)}`, files: errorProgram(base(f)), args: ["-d", "out", f] })),
      ...CLI.filter((c) => wanted(c.name)).map((c) => ({ files: {}, ...c, name: `cli/${c.name}` })),
    ]
  : [];
const id = (c) => c.name.replace(/\//g, "-");
/** Lay a case's folder out; what is in it before javac runs. */
async function lay(dir, c) {
  const inputs = new Set();
  for (const [path, content] of Object.entries(c.files)) {
    const data = typeof content === "string" ? content : await readFile(`${PROGRAMS}${content.from}`);
    await mkdir(`${dir}/${path}`.replace(/\/[^/]*$/, ""), { recursive: true });
    await writeFile(`${dir}/${path}`, data);
    inputs.add(path);
  }
  await mkdir(`${dir}/${c.cwd ?? ""}`, { recursive: true });
  return inputs;
}
/** The files javac wrote: everything in the folder that was not put there. */
async function made(dir, inputs) {
  const all = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
  return all.map((e) => `${e.parentPath ?? e.path}/${e.name}`.slice(dir.length + 1)).filter((p) => !inputs.has(p)).sort();
}

// ---- HotSpot ----
// One container for all of it: each program in a folder of its own, its class
// files from one javac run, its output in files beside it.
console.log(`  HotSpot: ${runs.length} programs to run, ${cases.length} javac cases…`);
const HS = `${SCRATCH}hotspot/`;
await mkdir(`${HS}classes`, { recursive: true });
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
// x64 HotSpot computes Math.exp, log, pow and the like with intrinsics of its
// own, which can differ from its portable fdlibm code in the last digit — the
// specification allows an ulp. Measured on 15 October: Math.exp(1) is
// 2.718281828459045 with them and 2.7182818284590455 without, which is also
// what arm64 HotSpot prints, and what the package prints. The comparison is
// with the portable code.
const HOTSPOT = "java -XX:+UnlockDiagnosticVMOptions -XX:-UseLibmIntrinsic";
const hsInputs = new Map();
for (const c of cases) hsInputs.set(c.name, await lay(`${HS}javac/${id(c)}`, c));
const script = [
  "set -u",
  `cd /p/run && javac -d /o/classes ${runs.map(q).join(" ")} > /o/javac.out 2>&1 || { cat /o/javac.out; exit 3; }`,
  ...(await Promise.all(runs.map(async (f) => {
    const name = base(f);
    const stdin = existsSync(`${PROGRAMS}run/${name}.in`) ? `/p/run/${name}.in` : "/dev/null";
    return `mkdir -p /o/run/${name} && cd /o/run/${name} && { ${HOTSPOT} -cp /o/classes ${name} ${await extra(name, "args")} < ${stdin} > /o/run/${name}.out 2> /o/run/${name}.err; echo $? > /o/run/${name}.code; }`;
  }))),
  ...cases.map((c) => `cd /o/javac/${id(c)}/${c.cwd ?? ""} && { javac ${c.args.map(q).join(" ")} > /o/javac/${id(c)}.out 2> /o/javac/${id(c)}.err; echo $? > /o/javac/${id(c)}.code; }`),
].join("\n");
await sh("podman", ["run", "--rm", "--platform", "linux/amd64", "-v", `${PROGRAMS}:/p:ro,Z`, "-v", `${HS}:/o:Z`, CORRETTO, "sh", "-c", script]);

// ---- the package ----
const OURS = `${SCRATCH}package-runs/`;
const JDK = `${PKG}volumes/jdk`;
const wasm = (atom, cwd, args, stdin) =>
  capture("node", [
    "--no-warnings", `${HERE}wasi-run.mjs`, `${PKG}atoms/${atom}`,
    "--dir", `/workspace=${cwd}`, "--dir", `/classes=${HS}classes`, "--dir", `/jdk=${JDK}`, "--dir", `/tmp=${SCRATCH}tmp`,
    "--env", "RISTRETTO_JDK_HOME=/jdk", "--env", "PWD=/workspace", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
    "--", ...args,
  ], { stdin });
await mkdir(`${SCRATCH}tmp`, { recursive: true });

const results = [];
const compare = (kind, name, theirs, ours) => {
  const key = `${kind}/${name}`;
  const diffs = [];
  for (const [what, a, b] of theirs.map((t, i) => [t[0], t[1], ours[i][1]])) {
    if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) diffs.push({ what, theirs: String(a), ours: String(b) });
  }
  results.push({ key, diffs, known: KNOWN[key] });
};
const hs = async (path) => readFile(`${HS}${path}`).catch(() => Buffer.from("(missing)"));

console.log(`  the package: running them…`);
for (const f of runs) {
  const name = base(f);
  const cwd = `${OURS}run/${name}/`;
  await mkdir(cwd, { recursive: true });
  const stdin = existsSync(`${PROGRAMS}run/${name}.in`) ? await readFile(`${PROGRAMS}run/${name}.in`) : null;
  const args = (await extra(name, "args")).split(/\s+/).filter(Boolean);
  const r = await wasm("java", cwd, ["-cp", "/classes", name, ...args], stdin);
  compare("run", name, [
    ["stdout", await hs(`run/${name}.out`)],
    ["stderr", await hs(`run/${name}.err`)],
    ["exit", String(await hs(`run/${name}.code`)).trim()],
  ], [["stdout", r.out], ["stderr", r.err], ["exit", String(r.code)]]);
}

for (const compiler of compilers) {
  console.log(compiler === "fast"
    ? `  the fast javac: ${cases.length} cases…`
    : `  the package's own javac: ${cases.length} cases (interpreted: several seconds each)…`);
  const dirs = new Map();
  for (const c of cases) {
    const dir = `${OURS}javac-${compiler}/${id(c)}`;
    dirs.set(c.name, { dir, inputs: await lay(dir, c) });
  }
  const printed = new Map();
  if (compiler === "fast") {
    const jobs = cases.map((c) => ({ cwd: `${dirs.get(c.name).dir}/${c.cwd ?? ""}`.replace(/\/$/, ""), args: c.args }));
    await writeFile(`${SCRATCH}jobs.json`, JSON.stringify(jobs));
    const r = await capture("node", ["--no-warnings", "--experimental-wasm-exnref", `${HERE}fast-javac.mjs`, `${SCRATCH}jobs.json`], { timeout: 600_000 });
    if (r.code !== 0) throw new Error(`fast-javac.mjs failed: ${r.err}`);
    const answers = JSON.parse(String(r.out));
    cases.forEach((c, i) => printed.set(c.name, { out: answers[i].stdout, err: answers[i].stderr, code: answers[i].exit }));
    const times = answers.map((a) => a.ms).sort((a, b) => a - b);
    console.log(`    compiled in ${times[0]} to ${times.at(-1)} ms, median ${times[Math.floor(times.length / 2)]} ms`);
  } else {
    for (const c of cases) {
      const r = await wasm("javac", `${dirs.get(c.name).dir}/${c.cwd ?? ""}`, c.args);
      printed.set(c.name, r);
    }
  }
  for (const c of cases) {
    const { dir, inputs } = dirs.get(c.name);
    const p = printed.get(c.name);
    const theirsMade = await made(`${HS}javac/${id(c)}`, hsInputs.get(c.name));
    const oursMade = await made(dir, inputs);
    const theirs = [
      ["stdout", await hs(`javac/${id(c)}.out`)],
      ["stderr", await hs(`javac/${id(c)}.err`)],
      ["exit", String(await hs(`javac/${id(c)}.code`)).trim()],
      ["files written", theirsMade.join("\n")],
    ];
    const ours = [["stdout", p.out], ["stderr", p.err], ["exit", String(p.code)], ["files written", oursMade.join("\n")]];
    for (const f of theirsMade.filter((f) => oursMade.includes(f))) {
      theirs.push([f, await readFile(`${HS}javac/${id(c)}/${f}`)]);
      ours.push([f, await readFile(`${dir}/${f}`)]);
    }
    compare(`javac:${compiler}`, c.name, theirs, ours);
  }
}

// ---- what it found ----
let unexpected = 0;
for (const r of results) {
  if (!r.diffs.length) {
    console.log(`  same   ${r.key}`);
    continue;
  }
  if (r.known) {
    console.log(`  known  ${r.key}: ${r.known}`);
    continue;
  }
  unexpected += 1;
  console.log(`  DIFF   ${r.key}`);
  for (const d of r.diffs) {
    console.log(`         ${d.what}:`);
    const a = d.theirs.split("\n");
    const b = d.ours.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length) && i < 400; i++) {
      if (a[i] !== b[i]) {
        console.log(`           HotSpot | ${(a[i] ?? "(nothing)").slice(0, 160)}`);
        console.log(`           package | ${(b[i] ?? "(nothing)").slice(0, 160)}`);
      }
    }
  }
}
const same = results.filter((r) => !r.diffs.length).length;
console.log(`\n  ${same} of ${results.length} identical, ${results.length - same - unexpected} known differences, ${unexpected} unexpected`);
process.exit(unexpected ? 1 : 0);

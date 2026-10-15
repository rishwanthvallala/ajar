// The pad's fast javac under Node, as the page runs it, for java-fidelity.mjs.
//
//   node --experimental-wasm-exnref fast-javac.mjs <jobs.json>
//
// Each job is {cwd, args}: a real folder and javac's arguments. The request
// carries what the sandbox's javac sends the page (ristretto.patch, bridge.rs):
// the named sources, the class and source paths' files, $CLASSPATH. It goes
// through the same encoding and the same compile as in the page
// (src/javac/protocol.ts); what javac wrote is written out, and what it printed
// comes back as JSON on stdout, a result per job.
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compile, decodeAnswer, decodeRequest, encodeAnswer, encodeRequest } from "../../src/javac/protocol.ts";

const PACKAGES = new URL("../../public/packages/", import.meta.url).pathname;
const own = JSON.parse(await readFile(`${PACKAGES}own.json`, "utf8"));
if (!own.javac) throw new Error("own.json has no fast javac: run node pad/scripts/build-java.mjs");
const local = (url) => `${PACKAGES}${url.replace("/packages/", "")}`;
const { load } = await import(local(own.javac.runtime));
const module = await load(new Uint8Array(await readFile(local(own.javac.wasm))), { stackDeobfuscator: { enabled: false } });
const javac = module.exports.createJavac(new Int8Array(await readFile(local(own.javac.sdk))), own.javac.release);

// javac's options whose value is the next argument (as bridge.rs has them).
const VALUED = new Set([
  "-d", "-s", "-h", "-cp", "-classpath", "--class-path", "-sourcepath", "--source-path", "-encoding", "--release",
  "-source", "--source", "-target", "--target", "-processorpath", "--processor-path", "--processor-module-path",
  "-processor", "--module-path", "-p", "--module-source-path", "--upgrade-module-path", "--system", "-bootclasspath",
  "--boot-class-path", "-extdirs", "-endorseddirs", "--add-modules", "--limit-modules", "--add-exports", "--add-reads",
  "--patch-module", "--module", "-m", "--default-module-for-created-files", "-Xmaxerrs", "-Xmaxwarns", "-Xstdout",
  "--module-version",
]);

async function collect(entry, extensions, files) {
  const meta = await stat(entry).catch(() => null);
  if (!meta) return;
  if (meta.isFile()) {
    files.add(entry);
    return;
  }
  for (const item of await readdir(entry, { withFileTypes: true })) {
    const path = join(entry, item.name);
    if (item.isDirectory()) {
      if (!item.name.startsWith(".")) await collect(path, extensions, files);
    } else if (extensions.some((e) => item.name.endsWith(`.${e}`))) {
      files.add(path);
    }
  }
}

async function request(cwd, args) {
  const sources = [];
  let classPath = null;
  let sourcePath = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const option = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUED.has(option)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (["-cp", "-classpath", "--class-path"].includes(option)) classPath = value;
      if (["-sourcepath", "--source-path"].includes(option)) sourcePath = value;
    } else if (!arg.startsWith("-") && arg.endsWith(".java")) {
      sources.push(resolve(cwd, arg));
    }
  }
  const envClassPath = process.env.CLASSPATH ?? null;
  const files = new Set(sources.filter((s) => existsSync(s)));
  for (const entry of (classPath ?? envClassPath ?? ".").split(":")) {
    await collect(resolve(cwd, entry || "."), ["class", "java", "jar", "zip"], files);
  }
  if (sourcePath !== null) {
    for (const entry of sourcePath.split(":")) await collect(resolve(cwd, entry || "."), ["java"], files);
  }
  const out = [];
  for (const path of [...files].sort()) {
    out.push({ path, modified: Math.floor((await stat(path)).mtimeMs), data: new Uint8Array(await readFile(path)) });
  }
  return { cwd, args, classPath: envClassPath, files: out };
}

/** `@file` arguments replaced by the file's, as javac's CommandLine (and bridge.rs) does it. */
async function expand(cwd, args) {
  const out = [];
  for (const arg of args) {
    if (arg.length > 1 && arg[0] === "@") {
      if (arg[1] === "@") out.push(arg.slice(1));
      else out.push(...tokens(await readFile(resolve(cwd, arg.slice(1)), "utf8")));
    } else out.push(arg);
  }
  return out;
}

function tokens(text) {
  const out = [];
  let i = 0;
  for (;;) {
    while (i < text.length) {
      if (" \t\n\r\f".includes(text[i])) i++;
      else if (text[i] === "#") while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
      else break;
    }
    if (i >= text.length) return out;
    let token = "";
    let quote = null;
    for (; i < text.length; i++) {
      const c = text[i];
      if (" \t\f".includes(c) && !quote) break;
      if (c === "\n" || c === "\r") break;
      if (c === "'" || c === '"') {
        if (!quote) quote = c;
        else if (quote === c) quote = null;
        else token += c;
      } else if (c === "\\" && quote) {
        const next = text[++i];
        if (next === "\n" || next === "\r") {
          while (" \n\r\t\f".includes(text[i + 1] ?? "x")) i++;
          continue;
        }
        token += { n: "\n", r: "\r", t: "\t", f: "\f" }[next] ?? next ?? "";
      } else token += c;
    }
    out.push(token);
  }
}

const results = [];
for (const job of JSON.parse(await readFile(process.argv[2], "utf8"))) {
  job.args = await expand(job.cwd, job.args);
  const began = performance.now();
  const answer = decodeAnswer(encodeAnswer(compile(javac, decodeRequest(encodeRequest(await request(job.cwd, job.args))))));
  const ms = Math.round(performance.now() - began);
  for (const { path, data } of answer.written) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  results.push({ exit: answer.exit, stdout: answer.stdout, stderr: answer.stderr, written: answer.written.map((w) => w.path), ms });
}
process.stdout.write(JSON.stringify(results));

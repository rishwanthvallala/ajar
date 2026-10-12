#!/usr/bin/env node
// Build the pad's Java: `java` and `javac`, as a package of our own.
//
// Wasmer's registry has no JVM and no javac, so this makes one. The JVM is
// Ristretto (github.com/theseus-rs/ristretto, Apache-2.0 OR MIT), a JVM written
// in Rust, built for WASI preview 1 so the pad's sandbox can run it. It runs
// the real class library: Amazon Corretto 25's, trimmed with jlink. `javac` is
// the JDK's own compiler, run by that JVM. See docs/dev/pad.md, "Java".
//
// What comes out is a `.webc` and its registry answer, in pad/public/packages
// beside the mirror: `ajar-java-<hash>.webc` (with .zst and .gz) and
// `own.json`. The service worker answers the registry from own.json as it does
// from registry.json, so `ajar/java` installs like any other toolchain, and
// nothing about it is published anywhere.
//
//   node pad/scripts/build-java.mjs
//
// Needs: git; rustup with Ristretto's pinned toolchain and its wasm32-wasip1
// target (the script says how); podman, for jlink and for javac on the
// compiler bridge; zstd and gzip. Scratch lives in target/java.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const run = promisify(execFile);
const say = (s) => console.log(`  ${s}`);

// Everything that decides the bytes, pinned.
const RISTRETTO = {
  repo: "https://github.com/theseus-rs/ristretto",
  // 10 October 2026, "Merge pull request #879 from theseus-rs/wide-branch-overflow".
  commit: "78837078129e6db91c276499d3ce68c35b37652a",
};
// Corretto 25.0.4.10.1, linux/amd64: the JDK Ristretto's own tests run on.
// The image is multi-arch; this is the amd64 manifest, which an arm64 podman
// runs under emulation (jlink takes about 20 s that way).
const CORRETTO = "docker.io/library/amazoncorretto@sha256:bdcb93b1fa4b54427b35d94160114f6b05bf461624898e25f8fdfdf30ae233fa";
const JAVA_VERSION = "25.0.4.1";
// The class library: java.base and the compiler, and the modules a program
// written for a course or an exercise reaches for. Not jdk.localedata, which
// is 26 MB of formats for locales other than English; nor the desktop, which
// cannot draw here.
const MODULES = [
  "java.base", "java.compiler", "jdk.compiler", "jdk.zipfs", "java.logging", "java.xml",
  "java.sql", "java.net.http", "jdk.unsupported", "java.prefs", "java.scripting",
];
// Ristretto reads jimage entries uncompressed; the package is compressed
// whole instead.
const JLINK = [
  "--endian", "little", "--disable-plugin", "compress", "--strip-java-debug-attributes",
  "--no-header-files", "--no-man-pages",
];
// The package, as the pad pins it in toolchains.ts.
const NAME = "ajar/java";
const VERSION = "1.0.0";
// Where the JDK is mounted in the sandbox, and so where the commands look.
const JDK_MOUNT = "/usr/lib/jvm/java-25";
// Not a host anyone can reach: only the service worker answers for it.
const HOST = "https://packages.ajar.invalid/";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRATCH = `${ROOT}target/java/`;
const SRC = `${SCRATCH}ristretto/`;
const OUT = `${ROOT}pad/public/packages/`;
const PATCH = new URL("./java/ristretto.patch", import.meta.url).pathname;

async function sh(cmd, args, opts = {}) {
  try {
    return (await run(cmd, args, { maxBuffer: 64 << 20, ...opts })).stdout;
  } catch (e) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${e.stderr || e.message}`);
  }
}

await mkdir(SCRATCH, { recursive: true });

// 1. Ristretto at the pinned commit, with our patch.
say(`Ristretto ${RISTRETTO.commit.slice(0, 10)}, patched…`);
if (!existsSync(`${SRC}.git`)) {
  await sh("git", ["init", "-q", SRC]);
  await sh("git", ["-C", SRC, "remote", "add", "origin", RISTRETTO.repo]);
}
const have = await sh("git", ["-C", SRC, "cat-file", "-t", RISTRETTO.commit]).catch(() => "");
if (!have.includes("commit")) await sh("git", ["-C", SRC, "fetch", "-q", "--depth", "1", "origin", RISTRETTO.commit]);
// The scratch clone is ours alone; anything in it besides the patch is stale.
await sh("git", ["-C", SRC, "checkout", "-q", "--force", RISTRETTO.commit]);
await sh("git", ["-C", SRC, "clean", "-q", "-fd", "--exclude=target/"]);
await sh("git", ["-C", SRC, "apply", PATCH]);
// The patch changes the compiler bridge's Java; its class files are checked in
// and embedded, so they are compiled again here, as its README says, for 8.
const BRIDGE = `${SRC}ristretto_vm/src/compiler/`;
await sh("podman", [
  "run", "--rm", "--platform", "linux/amd64", "-v", `${BRIDGE}:/c:Z`, CORRETTO,
  "javac", "--release", "8", "-Xlint:-options", "-d", "/c/classes",
  "/c/java/org/ristretto/compiler/CompilerBridge.java",
]);

// 2. The JVM and the compiler, for WASI preview 1. The repository's
// rust-toolchain.toml picks the compiler.
say("building java and javac for wasm32-wasip1…");
const toolchain = /channel\s*=\s*"([^"]+)"/.exec(await readFile(`${SRC}rust-toolchain.toml`, "utf8"))?.[1];
const targets = await sh("rustup", ["target", "list", "--installed", "--toolchain", toolchain]).catch(() => "");
if (!targets.split("\n").includes("wasm32-wasip1")) {
  throw new Error(`Rust ${toolchain} with wasm32-wasip1 is needed:\n  rustup toolchain install ${toolchain} --profile minimal --target wasm32-wasip1`);
}
await sh("cargo", [
  "build", "--release", "--locked", "-q", "--target", "wasm32-wasip1",
  "-p", "ristretto_java", "-p", "ristretto_javac", "--no-default-features",
], { cwd: SRC });
const WASM = `${SRC}target/wasm32-wasip1/release/`;
const atoms = { java: `${WASM}java.wasm`, javac: `${WASM}javac.wasm` };

// 3. The class library.
say(`Corretto ${JAVA_VERSION}, trimmed to ${MODULES.length} modules…`);
const IMAGE = `${SCRATCH}image/`;
await rm(IMAGE, { recursive: true, force: true });
await mkdir(SCRATCH, { recursive: true });
// The JDK's own release fields go along, so `java -version` can say which
// Corretto build the class library is.
await sh("podman", [
  "run", "--rm", "--platform", "linux/amd64", "-v", `${SCRATCH}:/out:Z`, CORRETTO, "sh", "-c",
  `jlink --add-modules ${MODULES.join(",")} ${JLINK.join(" ")} --release-info "$JAVA_HOME/release" --output /out/image`,
]);
const release = await readFile(`${IMAGE}release`, "utf8");
if (!release.includes(`JAVA_VERSION="${JAVA_VERSION}"`)) throw new Error(`the image is not Java ${JAVA_VERSION}:\n${release}`);
// What Ristretto reads, and the notices that go with it; no native code.
const JDK = `${SCRATCH}jdk/`;
await rm(JDK, { recursive: true, force: true });
for (const keep of ["release", "lib/modules", "lib/tzdb.dat", "lib/security", "conf", "legal"]) {
  await cp(`${IMAGE}${keep}`, `${JDK}${keep}`, { recursive: true, dereference: true });
}
const EMPTY = `${SCRATCH}metadata/`;
await mkdir(EMPTY, { recursive: true });

// 4. The package.
say("packing…");
const signature = async (file) => `sha256:${createHash("sha256").update(await readFile(file)).digest("base64")}`;
const command = (atom) => ({
  runner: "https://webc.org/runner/wasi",
  annotations: {
    atom: { name: atom },
    wasi: { atom, env: [`RISTRETTO_JDK_HOME=${JDK_MOUNT}`] },
  },
});
const manifest = {
  package: {
    wapm: {
      name: NAME,
      version: VERSION,
      description: `Ristretto ${RISTRETTO.commit.slice(0, 10)} with the Amazon Corretto ${JAVA_VERSION} class library`,
      license: "(Apache-2.0 OR MIT) AND GPL-2.0-only WITH Classpath-exception-2.0",
      repository: RISTRETTO.repo,
    },
    fs: [{ from: null, volume_name: "/jdk", mount_path: JDK_MOUNT }],
  },
  atoms: Object.fromEntries(
    await Promise.all(Object.entries(atoms).map(async ([n, f]) => [n, { kind: "https://webc.org/kind/wasm", signature: await signature(f) }])),
  ),
  commands: { java: command("java"), javac: command("javac") },
  entrypoint: "java",
};
await writeFile(`${SCRATCH}manifest.json`, JSON.stringify(manifest, null, 2));

const TRIMMER = new URL("./webc-trim/", import.meta.url).pathname;
const TOOLS = `${ROOT}target/webc-trim/`;
await sh("cargo", ["build", "--release", "--locked", "-q", "--manifest-path", `${TRIMMER}Cargo.toml`, "--target-dir", TOOLS]);
const packed = `${SCRATCH}java.webc`;
say((await sh(`${TOOLS}release/webc-pack`, [
  `${SCRATCH}manifest.json`, packed,
  ...Object.entries(atoms).flatMap(([n, f]) => ["--atom", `${n}=${f}`]),
  "--volume", `/jdk=${JDK}`, "--volume", `metadata=${EMPTY}`,
])).trim());

// 5. Into the mirror, named by content so the immutable cache header is safe.
const bytes = await readFile(packed);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const file = `ajar-java-${sha256.slice(0, 16)}.webc`;
for (const old of await readdir(OUT)) {
  if (old.startsWith("ajar-java-") && !old.startsWith(file)) await rm(`${OUT}${old}`);
}
await writeFile(`${OUT}${file}`, bytes);
for (const [tool, args, ext] of [["zstd", ["-19", "-q", "-f", "--keep"], ".zst"], ["gzip", ["-9", "-f", "--keep"], ".gz"]]) {
  if (!existsSync(`${OUT}${file}${ext}`)) await sh(tool, [...args, `${OUT}${file}`]);
}
const url = `${HOST}${sha256}.webc`;
// The registry's answer, shaped as registry.wasmer.io gives it.
const pirita = { piritaDownloadUrl: url, piritaSha256Hash: sha256, webcManifest: JSON.stringify(manifest) };
const answer = {
  data: {
    getPackage: {
      packageName: NAME.split("/")[1],
      namespace: NAME.split("/")[0],
      versions: [{ version: VERSION, isArchived: false, v2: pirita, v3: pirita }],
    },
    // The SDK refuses an answer without it.
    info: { defaultFrontend: "https://wasmer.io/" },
  },
};
await writeFile(`${OUT}own.json`, JSON.stringify({ answers: { [NAME]: answer }, files: { [url]: `/packages/${file}` } }, null, 1));

const mb = (n) => (n / 1048576).toFixed(1);
const zst = (await stat(`${OUT}${file}.zst`)).size;
say(`${file}: ${mb(bytes.length)} MB, ${mb(zst)} MB zstd`);
say(`${NAME}@=${VERSION} is in pad/public/packages/own.json`);

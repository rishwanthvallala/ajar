#!/usr/bin/env node
// Build the pad's C++: `clang++`, as a package of our own.
//
// The registry's clang/clang compiles C, and C++ without its standard library:
// it was linked with wasm-ld's default 64 KiB stack, and parsing <vector> or
// <iostream> runs past it into the compiler's own data — "out of bounds memory
// access" for <utility>, no end for <vector> (measured 18 October 2026, in the
// browser and under Wasmer's own CLI alike). This packs another: YoWASP's Clang
// 22, one WASI preview 1 module with an 8 MiB stack, and wasi-sdk's libraries,
// whose libc++ is built with C++ exceptions. See docs/dev/pad.md, "C++".
//
// What comes out, in pad/public/packages beside the mirror:
//
//   ajar-cxx-<hash>.webc     the package (with .zst and .gz)
//   own.json                 the registry's answer for ajar/cxx, added to
//                            what is there (build-java.mjs writes Java's)
//
// The package holds the compiler as its one atom, run as `cxx-llvm clang++ …`,
// and /opt/cxx: the sysroot and clang's own headers. The sandbox's `clang++`,
// `g++` and `c++` are pad/src/tools/cxx.py, which runs the compiler's steps in
// turn — a WASI module cannot start one of its own.
//
//   node pad/scripts/build-cxx.mjs
//
// Needs: tar, zstd and gzip; Rust, for webc-pack. Downloads about 230 MB the
// first time, kept in target/cxx with what was made of it.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { WASI_SDK, YOWASP_CLANG } from "./cxx/pins.mjs";

const run = promisify(execFile);
const say = (s) => console.log(`  ${s}`);

const NAME = "ajar/cxx";
const VERSION = "1.0.0";
// Where the package's files are in the sandbox; tools/cxx.py says so to clang.
const MOUNT = "/opt/cxx";
// Not a host anyone can reach: only the service worker answers for it.
const HOST = "https://packages.ajar.invalid/";

const ROOT = new URL("../../", import.meta.url).pathname;
const SCRATCH = `${ROOT}target/cxx/`;
const OUT = `${ROOT}pad/public/packages/`;

async function sh(cmd, args, opts = {}) {
  try {
    return (await run(cmd, args, { maxBuffer: 64 << 20, ...opts })).stdout;
  } catch (e) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${e.stderr || e.message}`);
  }
}

await mkdir(SCRATCH, { recursive: true });

// 1. What it is made of, downloaded once and checked against the pins.
async function fetched(url, file, check) {
  const path = `${SCRATCH}${file}`;
  if (!existsSync(path)) {
    say(`downloading ${url}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    await writeFile(path, new Uint8Array(await res.arrayBuffer()));
  }
  const bytes = await readFile(path);
  const [algorithm, want, encoding] = check;
  const got = createHash(algorithm).update(bytes).digest(encoding);
  if (got !== want) throw new Error(`${file} is not the pinned one: ${algorithm} ${got}, want ${want}`);
  return path;
}
const clangTgz = await fetched(YOWASP_CLANG.tarball, `yowasp-clang-${YOWASP_CLANG.version}.tgz`, ["sha512", YOWASP_CLANG.integrity.replace(/^sha512-/, ""), "base64"]);
const sysrootTgz = await fetched(WASI_SDK.url, `wasi-sysroot-${WASI_SDK.version}.tar.gz`, ["sha256", WASI_SDK.sha256, "hex"]);

// 2. Unpacked afresh, so nothing from an older run is in what ships.
const UNPACKED = `${SCRATCH}unpacked/`;
await rm(UNPACKED, { recursive: true, force: true });
await mkdir(`${UNPACKED}clang`, { recursive: true });
await mkdir(`${UNPACKED}clang-usr`, { recursive: true });
await mkdir(`${UNPACKED}wasi`, { recursive: true });
await sh("tar", ["-xzf", clangTgz, "-C", `${UNPACKED}clang`]);
await sh("tar", ["-xf", `${UNPACKED}clang/package/gen/llvm-resources.tar`, "-C", `${UNPACKED}clang-usr`]);
await sh("tar", ["-xzf", sysrootTgz, "-C", `${UNPACKED}wasi`]);
const LLVM = `${UNPACKED}clang/package/gen/llvm.core.wasm`;
const Y = `${UNPACKED}clang-usr/`;
const S = `${UNPACKED}wasi/wasi-sysroot-${WASI_SDK.version}.0/`;
for (const need of [LLVM, `${Y}include/stddef.h`, `${S}lib/wasm32-wasip1/eh/libc++.a`]) {
  if (!existsSync(need)) throw new Error(`${need} is not where it was: has the layout changed?`);
}

// 3. /opt/cxx. The sysroot is wasi-sdk's wasm32-wasip1 with its exceptions
// build of libc++ where clang 22 looks for one: wasi-sdk 34 keeps the two
// builds in eh/ and noeh/, which only clang 23 knows to choose between.
say(`/opt/cxx: wasi-sdk ${WASI_SDK.version}'s wasm32-wasip1, clang ${YOWASP_CLANG.clang}'s headers…`);
const TREE = `${SCRATCH}opt-cxx/`;
await rm(TREE, { recursive: true, force: true });
const SYS = `${TREE}sysroot/`;
const T = "wasm32-wasip1";
await cp(`${S}include/${T}`, `${SYS}include/${T}`, { recursive: true, dereference: true });
for (const variant of ["eh", "noeh"]) await rm(`${SYS}include/${T}/${variant}`, { recursive: true, force: true });
await cp(`${S}include/${T}/eh`, `${SYS}include/${T}`, { recursive: true, dereference: true });
await rm(`${SYS}include/${T}/mach-o`, { recursive: true, force: true });
// Empty, as in wasi-sdk: clang finds libc++'s version from it, and only then
// looks for the target's own headers.
await mkdir(`${SYS}include/c++/v1`, { recursive: true });
// Static libraries alone, nothing built for LTO, and the C++ ones with
// exceptions.
await mkdir(`${SYS}lib/${T}`, { recursive: true });
for (const entry of await readdir(`${S}lib/${T}`)) {
  if (entry.endsWith(".so") || ["eh", "noeh", "llvm-lto"].includes(entry)) continue;
  await cp(`${S}lib/${T}/${entry}`, `${SYS}lib/${T}/${entry}`, { recursive: true, dereference: true });
}
for (const lib of ["libc++.a", "libc++abi.a", "libc++experimental.a", "libunwind.a"]) {
  await cp(`${S}lib/${T}/eh/${lib}`, `${SYS}lib/${T}/${lib}`);
}
// clang's own headers — stddef.h, stdarg.h, wasm_simd128.h and the rest — and
// its builtins library, without what is for other machines: x86, Arm, PowerPC
// and RISC-V intrinsics, GPU offloading, the sanitizers. And without the
// copies of libc's and libc++'s headers YoWASP keeps beside them.
const CLANG = `${TREE}clang/`;
await cp(`${Y}include`, `${CLANG}include`, { recursive: true, dereference: true });
const OTHER_MACHINES = [
  /^__clang_(cuda|hip|spirv)_/, /intrin\.h$/, /^arm(64)?_|^armintr\.h$|^arm64intr\.h$/, /^(altivec|vecintrin|htmxlintrin|s390intrin)\.h$/,
  /^(hexagon|hvx)_/, /^opencl-/, /^(riscv|sifive|andes)_/, /^amdgpu/, /^amo\.h$/, /^(msa|lasxintrin|lsxintrin|larchintrin)\.h$/,
  /^(cpuid|mm_malloc|mm3dnow|nmmintrin|pmmintrin|smmintrin|tmmintrin|emmintrin|xmmintrin|immintrin|x86intrin|ia32intrin)\.h$/,
];
for (const entry of await readdir(`${CLANG}include`)) {
  const dir = ["c++", T, "sanitizer", "cuda_wrappers", "ppc_wrappers", "openmp_wrappers", "llvm_libc_wrappers", "llvm_offload_wrappers", "zos_wrappers", "orc", "xray", "profile", "fuzzer"];
  if (dir.includes(entry) || OTHER_MACHINES.some((re) => re.test(entry))) await rm(`${CLANG}include/${entry}`, { recursive: true, force: true });
}
await cp(`${Y}lib/wasm32-unknown-wasip1/libclang_rt.builtins.a`, `${CLANG}lib/wasm32-unknown-wasip1/libclang_rt.builtins.a`);
await writeFile(`${TREE}NOTICE.md`, `# The pad's C++

- **clang ${YOWASP_CLANG.clang}**, as YoWASP builds it for WebAssembly
  (@yowasp/clang ${YOWASP_CLANG.version}, https://yowasp.org/, ISC). LLVM is
  Apache-2.0 WITH LLVM-exception: https://llvm.org/LICENSE.txt
- **wasi-sdk ${WASI_SDK.version}'s sysroot** (https://github.com/WebAssembly/wasi-sdk):
  wasi-libc (Apache-2.0 WITH LLVM-exception, Apache-2.0, MIT; parts of musl,
  MIT), libc++, libc++abi and libunwind (Apache-2.0 WITH LLVM-exception).
`);
const size = async (dir) => Number((await sh("du", ["-sk", dir])).split("\t")[0]) / 1024;
say(`/opt/cxx is ${(await size(TREE)).toFixed(1)} MB`);

// 4. The package.
say("packing…");
const signature = async (file) => `sha256:${createHash("sha256").update(await readFile(file)).digest("base64")}`;
const manifest = {
  package: {
    wapm: {
      name: NAME,
      version: VERSION,
      description: `clang ${YOWASP_CLANG.clang} (YoWASP) with wasi-sdk ${WASI_SDK.version}'s libc++, for WASI preview 1`,
      license: "ISC AND Apache-2.0 WITH LLVM-exception AND MIT",
      repository: "https://github.com/YoWASP/clang",
    },
    fs: [{ from: null, volume_name: "/cxx", mount_path: MOUNT }],
  },
  atoms: { llvm: { kind: "https://webc.org/kind/wasm", signature: await signature(LLVM) } },
  commands: {
    "cxx-llvm": {
      runner: "https://webc.org/runner/wasi",
      annotations: { atom: { name: "llvm" }, wasi: { atom: "llvm" } },
    },
  },
  entrypoint: "cxx-llvm",
};
await writeFile(`${SCRATCH}manifest.json`, JSON.stringify(manifest, null, 2));
const EMPTY = `${SCRATCH}metadata/`;
await mkdir(EMPTY, { recursive: true });

const TRIMMER = new URL("./webc-trim/", import.meta.url).pathname;
const TOOLS = `${ROOT}target/webc-trim/`;
await sh("cargo", ["build", "--release", "--locked", "-q", "--manifest-path", `${TRIMMER}Cargo.toml`, "--target-dir", TOOLS]);
const packed = `${SCRATCH}cxx.webc`;
say((await sh(`${TOOLS}release/webc-pack`, [
  `${SCRATCH}manifest.json`, packed, "--atom", `llvm=${LLVM}`, "--volume", `/cxx=${TREE}`, "--volume", `metadata=${EMPTY}`,
])).trim());

// 5. Into the mirror, named by content so the immutable cache header is safe.
const mb = (n) => (n / 1048576).toFixed(1);
const bytes = await readFile(packed);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const file = `ajar-cxx-${sha256.slice(0, 16)}.webc`;
for (const old of await readdir(OUT)) {
  if (old.startsWith("ajar-cxx-") && !old.startsWith(file)) await rm(`${OUT}${old}`);
}
await writeFile(`${OUT}${file}`, bytes);
for (const [tool, args, ext] of [["zstd", ["-19", "-q", "-f", "--keep"], ".zst"], ["gzip", ["-9", "-f", "--keep"], ".gz"]]) {
  if (!existsSync(`${OUT}${file}${ext}`)) await sh(tool, [...args, `${OUT}${file}`]);
}
say(`${file}: ${mb(bytes.length)} MB, ${mb((await stat(`${OUT}${file}.zst`)).size)} MB zstd`);
const url = `${HOST}${sha256}.webc`;

// 6. The registry's answer, beside Java's: own.json is both packages', and
// each build replaces only its own entries.
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
const own = existsSync(`${OUT}own.json`) ? JSON.parse(await readFile(`${OUT}own.json`, "utf8")) : {};
own.answers = { ...(own.answers ?? {}), [NAME]: answer };
own.files = Object.fromEntries(Object.entries(own.files ?? {}).filter(([, to]) => !to.startsWith("/packages/ajar-cxx-")));
own.files[url] = `/packages/${file}`;
await writeFile(`${OUT}own.json`, JSON.stringify(own, null, 1));
say(`${NAME}@=${VERSION} is in pad/public/packages/own.json`);

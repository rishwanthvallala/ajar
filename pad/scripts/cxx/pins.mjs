// What the pad's C++ is built from, pinned: build-cxx.mjs reads this.
//
// The compiler is YoWASP's Clang (yowasp.org, ISC; LLVM itself Apache-2.0 WITH
// LLVM-exception): clang, clang++ and wasm-ld in one WASI preview 1 module,
// built with an 8 MiB stack. The registry's clang/clang has wasm-ld's default
// 64 KiB, and the C++ standard library's headers run past it: <utility> ended
// in "out of bounds memory access", <vector> and <iostream> never finished
// (18 October 2026). The npm package's llvm.core.wasm is that module as built,
// before jco wraps it into a component.
export const YOWASP_CLANG = {
  version: "22.0.0-git20542-10",
  tarball: "https://registry.npmjs.org/@yowasp/clang/-/clang-22.0.0-git20542-10.tgz",
  integrity: "sha512-V31/z9GrJECKeACTDUyvg2llbEUiFi3bxtL5HSg7H/6sydSxdI/AoVAD9F5ozrfLjotWl0B9rghR87m+DUM/zg==",
  // What `clang --version` says it is.
  clang: "22.1.0",
};

// The C and C++ libraries: wasi-sdk's sysroot (wasi-libc, libc++, libc++abi,
// libunwind), whose libc++ since wasi-sdk 33 comes in a second build with C++
// exceptions — try and catch work, as WebAssembly's exception handling. YoWASP
// ships one built without them. Its LLVM is 23; clang 22 compiles its headers.
export const WASI_SDK = {
  version: "34",
  url: "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sysroot-34.0.tar.gz",
  sha256: "9d813544eeebe38b7b8f2244ed591de46b6db812c6dd1a257ff9f0d2a905a2be",
};

// What the pad's awk is built from, pinned: build-awk.mjs reads this.
//
// The awk is The One True Awk — Brian Kernighan's, the awk of The AWK
// Programming Language — at its 26 April 2026 release. Its licence is
// Lucent's permissive one; NOTICE.md beside this file has it whole, and
// build-awk.mjs refuses a source whose LICENSE says anything else.
//
// GitHub makes the archive on request and has changed its compression before
// (January 2023), so what is pinned is the tar inside the .tar.gz, not the
// .tar.gz.
export const ONE_TRUE_AWK = {
  repo: "https://github.com/onetrueawk/awk",
  tag: "20260426",
  commit: "5739fd79bcfc75ba7526773d0cf634521f8aca3c",
  tarball: "https://codeload.github.com/onetrueawk/awk/tar.gz/5739fd79bcfc75ba7526773d0cf634521f8aca3c",
  tarSha256: "97a55abd244452d4cec66b55cfc1c9f7acb4910811bb6aeeb214beaed4afd902",
  // What `awk --version` says.
  version: "awk version 20260426",
};

// The compiler: the registry's clang/clang, whose `clang` command targets
// WASIX — its own sysroot, wasix-libc, and the flags for threads and shared
// memory — so what it makes can fork and exec, which system() and pipes need.
// The same package the pad installs for C (toolchains.ts); its file name in
// the CDN is its sha256, and the mirror (pad/public/packages) keeps it under
// its own, which manifest.json records.
export const CLANG = {
  pkg: "clang/clang@=0.160000.1",
  url: "https://cdn.wasmer.io/webcimages/c127b7bfc0041d02c94045f40be7fb4b3eeb98cede25fad96261b7b90a82f405.webc",
  sha256: "c127b7bfc0041d02c94045f40be7fb4b3eeb98cede25fad96261b7b90a82f405",
};

// What runs that clang: Wasmer's own CLI, inside the container — never on the
// machine running this script. The release for the container's architecture.
export const WASMER = {
  version: "7.5.0",
  arm64: {
    url: "https://github.com/wasmerio/wasmer/releases/download/v7.5.0/wasmer-linux-aarch64.tar.gz",
    sha256: "903dadb34ba984d981a9bdd2ed1e456dab862c4489d65d2498ad5e7cf1a1fe87",
  },
  amd64: {
    url: "https://github.com/wasmerio/wasmer/releases/download/v7.5.0/wasmer-linux-amd64.tar.gz",
    sha256: "23f99818deaad93859f8bb8292af81f0c39f25aea19eaccfb72fc7c9e8a3fae9",
  },
};

// The container the build runs in, by the digest of its multi-architecture
// index, and the two tools in it whose output becomes part of awk.wasm: byacc
// writes the parser, binaryen's wasm-opt adds asyncify. Ubuntu 24.04's own,
// at these versions. (gcc builds awk's maketab, whose output is text the same
// whichever gcc.)
export const CONTAINER = {
  image: "docker.io/library/ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55",
  apt: { byacc: "1:2.0.20221106-1", binaryen: "108-1" },
};

// How it is built. 8 MiB of stack, first in memory, so a deep recursion in an
// awk program ends in a trap rather than writing over awk's own data: clang's
// default is 64 KiB, placed above the data.
export const STACK_SIZE = 8 * 1024 * 1024;

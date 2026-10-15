// What the pad's Java is built from and checked against, pinned: build-java.mjs
// and java-fidelity.mjs both read this, so the JDK a program is compared with
// is the one whose class library ships.

export const RISTRETTO = {
  repo: "https://github.com/theseus-rs/ristretto",
  // 10 October 2026, "Merge pull request #879 from theseus-rs/wide-branch-overflow".
  commit: "78837078129e6db91c276499d3ce68c35b37652a",
};
// Corretto 25.0.4.10.1, linux/amd64: the JDK Ristretto's own tests run on.
// The image is multi-arch; this is the amd64 manifest, which an arm64 podman
// runs under emulation (jlink takes about 20 s that way).
export const CORRETTO = "docker.io/library/amazoncorretto@sha256:bdcb93b1fa4b54427b35d94160114f6b05bf461624898e25f8fdfdf30ae233fa";
export const JAVA_VERSION = "25.0.4.1";
// The class library: java.base and the compiler, and the modules a program
// written for a course or an exercise reaches for. Not jdk.localedata, which
// is 26 MB of formats for locales other than English; nor the desktop, which
// cannot draw here.
export const MODULES = [
  "java.base", "java.compiler", "jdk.compiler", "jdk.zipfs", "java.logging", "java.xml",
  "java.sql", "java.net.http", "jdk.unsupported", "java.prefs", "java.scripting",
];
// The same Corretto release, as the multi-arch index, so it runs natively:
// what builds the fast javac. Its javac prints the --help text that javac
// carries, so it has to be this release's.
export const CORRETTO_NATIVE = "docker.io/library/amazoncorretto@sha256:06f99cdfd01c26ed2a5b03dc85385d36c17aa81ddfcaf8500f641ab556a985d6";
// The fast javac: teavm-javac (Apache-2.0), which compiles javac with TeaVM
// to WebAssembly. Its build takes javac's source from Corretto at the tag the
// class library is, set in teavm-javac.patch.
export const TEAVM_JAVAC = {
  repo: "https://github.com/konsoletyper/teavm-javac",
  // 5 October 2026, "Add simple test harness as well as few simple compiler tests".
  commit: "208d4c97a602ba0df055f16e6882059fb69d0122",
};
// What --release names the class library as.
export const RELEASE = "25";

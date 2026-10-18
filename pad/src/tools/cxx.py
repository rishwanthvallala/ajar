"""clang++, g++ and c++: the pad's C++ compiler, one step at a time.

The compiler is the ajar/cxx package (pad/scripts/build-cxx.mjs): YoWASP's
clang 22, which is clang, clang++ and wasm-ld in one WASI module, run as
`cxx-llvm clang++ …`, with wasi-sdk's libc++ in /opt/cxx. A WASI program
cannot start another, so the compiler cannot run the steps it plans —
compiling each file, then linking them. This asks it for them (`-###`) and
runs each itself, as YoWASP's own runClang does.

What it builds is a WASI program, run as any is: `./a.out`. C++ exceptions
are WebAssembly's, so try and catch work.

Nor can a WASI program tell which directory the shell is in, so every path
the line names is made absolute from it here, and the compiler is told the
rest (`-working-directory`).
"""

import os
import subprocess
import sys

ROOT = "/opt/cxx"
LLVM = "cxx-llvm"
FLAGS = [
    "--target=wasm32-wasip1",
    f"--sysroot={ROOT}/sysroot",
    "-resource-dir", f"{ROOT}/clang",
    # try and catch, as the libraries are built for: WebAssembly's exception
    # handling, in its standard instructions rather than LLVM's older default.
    "-fwasm-exceptions", "-mllvm", "-wasm-use-legacy-eh=false",
]
# Lines that stop before linking, which then takes no -lunwind.
NOT_LINKING = {"-c", "-S", "-E", "-fsyntax-only", "-M", "-MM", "--version", "-dumpversion", "-print-search-dirs"}
# Options whose value is a path, given as the next argument; -I and -L may
# also have it joined.
PATH_OPTIONS = ("-o", "-I", "-L", "-isystem", "-iquote", "-include", "-MF")
JOINED = ("-I", "-L")


def absolute(path, here):
    return path if path.startswith("/") else os.path.normpath(os.path.join(here, path))


def rewrite(args, here):
    """The paths the compiler's steps need absolute: where things go, where to
    look, and the objects the linker takes. Source files stay as typed — the
    compiler reads them from `-working-directory`, and says them as typed in
    an error."""
    out = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in PATH_OPTIONS and i + 1 < len(args):
            out += [arg, absolute(args[i + 1], here)]
            i += 2
            continue
        joined = next((o for o in JOINED if arg.startswith(o) and len(arg) > len(o)), None)
        if joined:
            out.append(joined + absolute(arg[len(joined):], here))
        elif not arg.startswith("-") and arg.endswith((".o", ".a")):
            # For the linker, which is not told the directory.
            out.append(absolute(arg, here))
        else:
            out.append(arg)
        i += 1
    return out


def words(line):
    """One job of `-###`'s, as the driver quotes it: `"a" "b \\"c\\""`."""
    out, i = [], 0
    while i < len(line):
        if line[i] == " ":
            i += 1
        elif line[i] == '"':
            i += 1
            word = []
            while i < len(line) and line[i] != '"':
                if line[i] == "\\" and i + 1 < len(line):
                    i += 1
                word.append(line[i])
                i += 1
            out.append("".join(word))
            i += 1
        else:
            j = line.find(" ", i)
            j = len(line) if j < 0 else j
            out.append(line[i:j])
            i = j
    return out


# An exception nothing catches leaves main, under WebAssembly's exception
# handling, as a trap: std::terminate is never called, and the program ended
# with exit status 11 and not a word (18 October). Every program is linked
# with this around its main — wasi-libc's _start calls it as __main_void —
# which says it as a native one would. It exits 1, not abort's 134: this
# runtime gives a WASI program's status as 79 past a few dozen.
UNCAUGHT = r"""#include <cstdio>
#include <cstdlib>
#include <exception>
#include <typeinfo>
#include <cxxabi.h>

extern "C" int __real___main_void(void);
extern "C" int __wrap___main_void(void) {
  try {
    return __real___main_void();
  } catch (...) {
    std::type_info *type = abi::__cxa_current_exception_type();
    int status = -1;
    char *name = type ? abi::__cxa_demangle(type->name(), nullptr, nullptr, &status) : nullptr;
    std::fflush(stdout);
    std::fprintf(stderr, "terminate called after throwing an instance of '%s'\n", status == 0 ? name : type ? type->name() : "?");
    try {
      throw;
    } catch (const std::exception &e) {
      std::fprintf(stderr, "  what():  %s\n", e.what());
    } catch (...) {
    }
    std::_Exit(1);
  }
}
"""
UNCAUGHT_O = "/tmp/.cxx/uncaught.o"
# Lines that make something with no main of the usual kind.
NO_MAIN = {"-nostdlib", "-nostartfiles", "-shared", "-Wl,--no-entry", "-mexec-model=reactor"}


def build(args, here):
    linking = not any(a in NOT_LINKING for a in args) and any(not a.startswith("-") for a in args)
    if linking and not any(a == "-o" for a in args):
        # The default, where a compiler run from here would leave it.
        args = [*args, "-o", os.path.join(here, "a.out")]
    line = [LLVM, "clang++", *FLAGS, "-working-directory", here, *args, *(["-lunwind"] if linking else [])]
    try:
        planned = subprocess.run([*line, "-###"], capture_output=True, text=True)
    except FileNotFoundError:
        sys.stderr.write("clang++: not here yet — type it again once C++ has been fetched\n")
        return 127
    jobs, said = [], []
    for out in (planned.stderr + planned.stdout).splitlines():
        if out.startswith(' "'):
            jobs.append(words(out))
        elif out.strip() and not out.startswith(("clang version", "Target:", "Thread model:", "InstalledDir:", "Build config:", " (in-process)")):
            said.append(out)
    # What the driver itself had to say — an unknown option, a missing file —
    # or everything, for -v.
    if said or "-v" in args or not jobs:
        text = planned.stderr if "-v" in args else "\n".join(said)
        if text:
            sys.stderr.write(text if text.endswith("\n") else text + "\n")
    if planned.returncode != 0 or not jobs:
        return planned.returncode
    for job in jobs:
        program, rest = job[0], job[1:]
        tool = os.path.basename(program)
        step = [LLVM, "wasm-ld", *rest] if tool in ("wasm-ld", "ld", "lld", "ld.lld") else [LLVM, *rest]
        done = subprocess.run(step)
        if done.returncode != 0:
            return done.returncode
    return 0


def main():
    here = os.getcwd()
    args = rewrite(sys.argv[1:], here)
    linking = not any(a in NOT_LINKING for a in args) and any(not a.startswith("-") for a in args)
    if linking and not NO_MAIN.intersection(args):
        if not os.path.exists(UNCAUGHT_O):
            source = UNCAUGHT_O[:-2] + ".cpp"
            os.makedirs(os.path.dirname(source), exist_ok=True)
            with open(source, "w") as f:
                f.write(UNCAUGHT)
            made = build(["-c", source, "-o", UNCAUGHT_O], "/tmp")
            if made != 0:
                return made
        args += [UNCAUGHT_O, "-Wl,--wrap=__main_void"]
    return build(args, here)


if __name__ == "__main__":
    sys.exit(main())

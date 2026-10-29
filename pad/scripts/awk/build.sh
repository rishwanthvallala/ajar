#!/bin/bash
# The pad's awk, built inside the pinned container: build-awk.mjs runs this,
# with what it fetched and checked in /in, this directory in /recipe, and
# /out for the result. Nothing here is fetched except Ubuntu's two packages.
#
#   /in/awk/            The One True Awk's source, unpacked
#   /in/clang.webc      the registry's clang/clang, which targets WASIX
#   /in/wasmer.tar.gz   Wasmer's CLI, to run it
set -euo pipefail
: "${BYACC:?}" "${BINARYEN:?}" "${STACK_SIZE:?}" "${VERSION:?}"

export DEBIAN_FRONTEND=noninteractive
{ apt-get update -qq && apt-get install -y -qq --no-install-recommends "byacc=$BYACC" "binaryen=$BINARYEN" gcc libc6-dev; } \
  >/tmp/apt.log 2>&1 || { cat /tmp/apt.log; exit 1; }
mkdir -p /opt/wasmer && tar -xzf /in/wasmer.tar.gz -C /opt/wasmer
WASMER=/opt/wasmer/bin/wasmer
echo "  $($WASMER --version), byacc $BYACC, wasm-opt $(wasm-opt --version | cut -d' ' -f3)"

B=/tmp/awk
mkdir -p $B
cp /in/awk/*.c /in/awk/*.h /in/awk/awkgram.y /recipe/wasix.c $B/
cd $B

# printf's %u, %o, %x and %X: awk makes the number a uintmax_t with a plain
# cast, which C leaves undefined for a negative one. Where awk usually runs
# that wraps, so printf "%x", -1 is ffffffffffffffff in this awk, gawk and
# mawk alike; WebAssembly's conversion gave 0 (review of 28 October). A
# negative number goes through intmax_t first, which is the wrap they give.
sed -i -e 's/(uintmax_t) getfval(x)/awk_unsigned(getfval(x))/' \
  -e '/^#include "awkgram.tab.h"$/a static uintmax_t awk_unsigned(double v) { return v < 0 ? (uintmax_t) (intmax_t) v : (uintmax_t) v; }' run.c
[ "$(grep -c awk_unsigned run.c)" = 2 ] || { echo "run.c: printf's %u is not converted where it was" >&2; exit 1; }

# The parser, and the table of what each token does, as awk's makefile makes
# them — with byacc, the makefile's other yacc, rather than bison: the
# registry's clang runs past its own 64 KiB stack parsing bison's yyparse
# ("out of bounds memory access", even with -fsyntax-only), and byacc's it
# compiles. The grammar's 44 shift/reduce and 85 reduce/reduce conflicts are
# resolved alike by both.
byacc -d -b awkgram awkgram.y
gcc -O2 maketab.c -o maketab
./maketab awkgram.tab.h > proctab.c

# Compiled for WASIX by the registry's clang under Wasmer's CLI. Its `clang`
# command brings the sysroot and the flags for threads and shared memory
# itself. -fno-integrated-cc1: the compiler in clang's own process says
# "unknown integrated tool '-cc1'" for every -c; a process of its own works.
clang() { $WASMER run -q --offline /in/clang.webc --volume $B:$B --cwd $B -- "$@"; }
for f in awkgram.tab.c b.c lex.c lib.c parse.c proctab.c run.c tran.c wasix.c; do
  clang -O2 -fno-integrated-cc1 -w -c "$f" 2>&1 | grep -v "linker' input unused" || true
  [ -f "${f%.c}.o" ] || { echo "$f did not compile" >&2; exit 1; }
done
# awk's main is wasix.c's to call (see there).
clang -O2 -fno-integrated-cc1 -w -Dmain=awk_main -c main.c 2>&1 | grep -v "linker' input unused" || true
[ -f main.o ] || { echo "main.c did not compile" >&2; exit 1; }
clang -O2 -o awk.raw.wasm awkgram.tab.o b.o lex.o lib.o parse.o proctab.o run.o tran.o wasix.o main.o -lm \
  -Wl,-z,stack-size=$STACK_SIZE -Wl,--stack-first -Wl,--strip-debug

# Asyncify, which WASIX unwinds and rewinds the stack with: fork() needs it,
# and so do setjmp and longjmp, with which awk leaves its main loop for END
# on `exit`. Without it the first of either ends the program, status 45.
wasm-opt -O2 --asyncify --enable-threads --enable-bulk-memory --enable-mutable-globals --enable-sign-ext \
  --strip-debug --strip-producers awk.raw.wasm -o awk.wasm

# Before it leaves: it runs, it is this awk, and longjmp works.
cd /tmp && printf 'a 1\nb 2\n' > in.txt
run() { $WASMER run -q --volume /tmp:/tmp --cwd /tmp $B/awk.wasm -- "$@"; }
[ "$(run --version)" = "$VERSION" ] || { echo "awk --version: $(run --version)" >&2; exit 1; }
got=$(run '{ s += $2; print $1 } END { print s, 2^10, length("hello") }' in.txt | tr '\n' ' ')
[ "$got" = "a b 3 1024 5 " ] || { echo "awk ran wrong: $got" >&2; exit 1; }
got=$(run '{ print; exit 3 } END { print "end" }' in.txt | tr '\n' ' '; echo "${PIPESTATUS[0]}")
[ "$got" = "a 1 end 3" ] || { echo "exit in a rule: $got" >&2; exit 1; }
got=$(run 'BEGIN { printf "%u %x %o %X %u\n", -1, -1, -8, 255, 2^40 }')
[ "$got" = "18446744073709551615 ffffffffffffffff 1777777777777777777770 FF 1099511627776" ] || { echo "printf %u of -1: $got" >&2; exit 1; }

cp $B/awk.wasm /out/awk.wasm

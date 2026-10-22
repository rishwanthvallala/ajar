#!/bin/sh
# The engine, four ways: relaxed SIMD or plain SIMD128, one thread or a pool of workers on shared memory.
# The page picks one at run time (src/engine.ts). Needs zig 0.13 or later: ZIG=/path/to/zig engine/build.sh
#
# TMAX=128: a prompt is fed in chunks of at most 128 tokens. That keeps the activation buffers at 4 MB rather
# than 35, and gives a newer request a chance to stop an older one between chunks. Results are the same.
# A 1 MB stack rather than zig's 16: the pool's threads run the same kernels on 256 KB.
set -e
cd "$(dirname "$0")"
ZIG=${ZIG:-zig}
OUT=../assets
W="$ZIG cc -target wasm32-wasi -mexec-model=reactor -O3 -s -DTMAX=128 -Wl,-z,stack-size=1048576 -Wall -Wextra -Wno-unused-function -Wno-unused-parameter"
MT="-matomics -mbulk-memory -DWASM_THREADS -Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=268435456 -Wl,--export=__stack_pointer"
$W -msimd128 -mrelaxed-simd     -o $OUT/engine-relaxed.wasm    complete.c
$W -msimd128                    -o $OUT/engine-simd.wasm       complete.c
$W -msimd128 -mrelaxed-simd $MT -o $OUT/engine-relaxed-mt.wasm complete.c
$W -msimd128 $MT                -o $OUT/engine-simd-mt.wasm    complete.c
ls -la $OUT/*.wasm

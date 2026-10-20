# The pad's awk

`pad/src/tools/awk.wasm` is built from:

- **The One True Awk** (https://github.com/onetrueawk/awk), at the release
  `pins.mjs` names. Its licence, which build-awk.mjs checks the source still
  carries, is this:

```text
/****************************************************************
Copyright (C) Lucent Technologies 1997
All Rights Reserved

Permission to use, copy, modify, and distribute this software and
its documentation for any purpose and without fee is hereby
granted, provided that the above copyright notice appear in all
copies and that both that the copyright notice and this
permission notice and warranty disclaimer appear in supporting
documentation, and that the name Lucent Technologies or any of
its entities not be used in advertising or publicity pertaining
to distribution of the software without specific, written prior
permission.

LUCENT DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE,
INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS.
IN NO EVENT SHALL LUCENT OR ANY OF ITS ENTITIES BE LIABLE FOR ANY
SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER
IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
****************************************************************/
```

- **wasix-libc** (https://github.com/wasix-org/wasix-libc), as the sysroot of
  the registry's `clang/clang` package, linked in statically: a fork of
  wasi-libc (Apache-2.0 WITH LLVM-exception, Apache-2.0 or MIT) and so of musl
  (MIT), with parts of cloudlibc (BSD-2-Clause) and dlmalloc (CC0).
- `wasix.c` beside this file, the pad's own.

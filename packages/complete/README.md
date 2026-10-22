# @ajar/complete

Code completion that runs in the page. A 36M-parameter model, 4-bit, in a
worker with its own WebAssembly engine: it suggests the rest of the line from
the code before the cursor and the code after it, and nothing it reads leaves
the browser. The pad uses it for grey-text suggestions (`pad/src/complete.ts`).

```ts
import { Completer } from "@ajar/complete";
import { attachCompleter } from "@ajar/complete/monaco";

const completer = new Completer({ manifest: "/packages/ajar-complete.json" });
attachCompleter(monaco, editor, completer, { enabled: (model) => true });
```

`Completer` alone takes `{ key, line, prefix, suffix }` and answers with the
text, its confidence and timings; `completer.shows(c)` says whether it is sure
enough to show. `attachCompleter` is everything an editor needs on top: the
text around the cursor cut as the prompt wants it, typing through a shown
suggestion without asking again, a prompt prepared when the cursor comes to
rest somewhere new, and brackets already after the cursor not suggested twice.

## What it costs

| | |
|---|---|
| First visit | 16.95 MB on the wire (the model as zstd; 18.95 MB raw), 0.14 MB vocabulary, about 45 KB of engine and 20 KB of script |
| After that | Nothing: Cache Storage keeps the model, checked against its SHA-256 at each start; ready in about 50 ms |
| Memory | About 50 MB in the worker (65 MB for the plain SIMD128 build, which keeps attention in f32) |
| A keystroke | 12 ms from the key to grey text, median; 30 ms p90 (10 ms of it in the worker) |
| The cursor somewhere new | The whole prompt, about 1,000 tokens: 150 ms with 4 threads, 430 ms with one |

Measured in headless Chromium 149 and Node 24 on an i9-14900KS; a laptop is
slower, by perhaps two to three times. The threads need cross-origin
isolation, which the pad has; without it the engine runs on one. Where relaxed
SIMD is missing (Firefox, Safari) the plain SIMD128 build runs, about twice as
slow; a browser without SIMD128 gets no suggestions.

The page's own thread only builds the request: typing a file into Monaco with
suggestions on made no task over 50 ms.

## How good it is

On 18,060 places in code written in 2026 (the autocomplete study's eval v2),
through this package's own code:

| | |
|---|---|
| Exactly what was written next, the evaluation's prompt | 31.55%, every one of the 18,060 identical to the engine measured in the study |
| The same with the prompt the editor sends | 31.21% |
| Shown when 70% sure (the default), editor's prompt | on 36.4% of places, 70% of those exactly right |

`precision` (50, 60, 70 or 80) trades how often a suggestion shows against
how often it is right; the cuts are in the manifest, measured with the
editor's prompt on that set.

The editor's prompt starts the code before the cursor at a line and keeps that
start while typing, so each keystroke shares its whole beginning with the cache.
`Prompter` leaves room for the prefix to grow (`headroom`, 192 tokens) before
a new start, and with it one whole prefix run, is needed. Measured both ways —
the 18,060 places, and 21,829 keystrokes retyping 15 lines in each of 40 files:

| Headroom | Exact | Whole-prefix runs per 1,000 keys | Slowest 1% of keys (one thread) |
|---|---|---|---|
| 0 | 31.53% | 23.8 | 732 ms |
| 64 | 31.37% | 3.7 | 141 ms |
| 192 (used) | 31.21% | 0.7 | 100 ms |

The evaluation counts a fresh start at every place; while typing, the prefix
grows back towards full between starts, so the difference in use is about half.

## The model directory

The model is not in git. `scripts/install-model.mjs` puts one where the pad
serves it:

```sh
node packages/complete/scripts/install-model.mjs model.bin tokenizer.json   # into pad/public/packages
```

It writes `ajar-complete-model-<hash>.bin` and `ajar-complete-vocab-<hash>.bin`
with `.zst` and `.gz` copies, and `ajar-complete.json` last. The card in
`models/M1-qat.json` says what the blob is: its shape, its special tokens, its
prompt and its confidence cuts. The pad's deploy carries the directory the way
it carries the wasm packages.

## What is where

| | |
|---|---|
| `src/index.ts` | `Completer`: the page's side — the worker, requests, the newest one winning |
| `src/monaco.ts` | `attachCompleter`: inline suggestions in a Monaco editor |
| `src/worker.ts` | The worker: the model fetched and kept, one request at a time |
| `src/session.ts` | One completion: prompt, run, decode, and the evaluation's cut of the text |
| `src/prompt.ts` | The suffix-first prompt, token healing, and where the prefix starts |
| `src/tokenizer.ts` | Qwen2.5's byte-level BPE, cut to 16,000 merges, as Hugging Face's `tokenizers` does it |
| `src/engine.ts`, `src/thread.ts` | The engine: which build, its threads, the KV cache's contents |
| `src/node-entry.ts` | The worker's core without the worker, for running it under Node |
| `engine/complete.c` | The engine's C side: `llm.c`'s kernels as a library |
| `engine/llm.c`, `engine/simd.h` | The kernels, from the study's benchmark (`pad/autocomplete/wasm-bench`) |
| `assets/*.wasm` | The four builds, made by `engine/build.sh` (zig 0.13 or later) |
| `scripts/install-model.mjs`, `scripts/vocab.mjs` | The model directory |
| `test/browser.mjs` | The package in headless Chromium, served as the pad is |

## Checks

`test/browser.mjs` builds a page with Monaco and the completer and serves it
with the pad's headers, policy and precompressed files: the model's first load
and the one from Cache Storage, a file typed key by key (when grey text
shows, how long after the key, Tab), and the two fallbacks. With
`EVAL_ITEMS`/`EVAL_ROWS` it also runs evaluation items through the page and
holds them to rows from Node. `pad/scripts/complete-check.mjs` is the same in
the pad itself. Both skip when no model is installed.

The parity runs that need the study's data live with it, in
`pad/autocomplete`: `scripts/js_parity.py` (this tokenizer against Hugging
Face's on 17,350 files, 48.5M tokens, no difference), `web/run_eval.mjs` with
`scripts/js_score.py` (the 18,060 places).

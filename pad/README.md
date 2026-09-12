# pad

A folder you can open, edit and run in a browser tab, with nobody's machine
involved but the one you are sitting at.

Live at **[code.rishwanth.dev](https://code.rishwanth.dev)**. Open it, paste
something, press Run, send the link. Whoever opens it sees the same folder and
can carry on from where you left off.

It is the second product in this repository and shares only the relay with the
first. `ajar` shares *someone's actual machine* over an agent; this shares a
folder and runs it in each visitor's own tab as WebAssembly. Same relay, same
domain, entirely different architecture.

## Running it

```sh
npm install
node scripts/fetch-packages.mjs   # mirrors ~73 MB of wasm; needed once
npm run dev
```

The relay supplies `/api/pad/*` and `/ws`, so run one alongside:

```sh
cargo run -p ajar-relay -- --bind 127.0.0.1:8787 --pad-dir ./ajar-pads
```

```sh
npm run check    # typecheck, build, then both browser suites
```

Both suites drive headless Chromium, and they have to. The Python package fails
wasm validation under Node — `Validate("Unknown validation error")` — and
cross-origin isolation, which the runtime needs for `SharedArrayBuffer`, does
not exist outside a browser. `scripts/browser-check.mjs` tests the pieces;
`scripts/app-check.mjs` drives the app the way a person would and takes a
screenshot at the end. Point the second at a deployment with
`PAD_ORIGIN=https://code.rishwanth.dev`.

## What is where

| | |
|---|---|
| `src/runtime.ts` | The WASIX sandbox, and the pinned binary set |
| `src/shell.ts` | One shell per session, and how a command's end is detected |
| `src/console.ts` | The prompt, the echo, the line editing — all of it the page's job |
| `src/editing.ts` | Yjs bound to Monaco, lifted from ajar's session client |
| `src/peers.ts` | The relay connection: presence, nudges, document updates |
| `src/store.ts` | The durable folder over HTTP |
| `src/sync.ts` | What a command changed, and what never gets published |
| `src/files.ts` | The file tree, with folders derived from paths |
| `src/app.ts` | Everything wired together |
| `src/tools/awk.py` | An awk, because no awk is published for this runtime |
| `public/sw.js` | Serves the wasm packages from this origin instead of Wasmer's CDN |
| [`../crates/ajar-relay/src/pad.rs`](../crates/ajar-relay/src/pad.rs) | The durable store, on the server |

## The binary set

Pinned, mirrored, and served from this origin. A folder that ran last week has
to run this week, and a registry nobody here controls cannot promise that.

```
sharrattj/bash@1.0.18        wasmer/grep@3.12.0
sharrattj/coreutils@1.0.16   wasmer/sed@4.9.0
python/python@3.13.20        wasmer/find@4.10.0
```

Note the two namespaces. `sharrattj/grep` does not exist and `wasmer/grep`
does; the registry's search endpoint returns nothing for *any* query, including
`python`, so guessing namespaces is the only way to find anything. An earlier
version of this document said these tools were unavailable, which was a wrong
conclusion from a broken search.

`awk` is not published anywhere — `gawk`, `mawk`, `goawk`, `busybox` and a
dozen other guesses all return nothing — so `src/tools/awk.py` stands in for
it, checked against real awk on thirty programs. It refuses what it does not
understand rather than quietly doing something else.

Present: `ls cat wc echo cp mv rm mkdir rmdir touch pwd env date printf test
basename dirname du df stat ln readlink seq head tail sort uniq cut tr tee nl
od split grep sed find python bash sh`. Absent: `xargs diff patch tar gzip curl
wget git make cc`.

## Things about this runtime that are not obvious

Every one of these cost real time to find, and none of them is documented
anywhere upstream.

**The JavaScript filesystem and the process filesystem are different
namespaces.** The JS root *is* the process's working directory: a file written
to `/out.csv` from the page is `out.csv` to the program. A path that looks
absolute to a process — `/app/main.py` — lands at `/workspace/app/main.py`
instead, so Python reports `[Errno 44]` for a file `readDir` can plainly see.
Every path in this application is root-relative in the JS view.

**The SDK cannot be bundled.** It resolves its worker with `new URL(…,
import.meta.url)`, and that worker statically imports two siblings. A bundler
flattens the layout, the siblings 404, and every command hangs forever with
nothing thrown. It is vendored verbatim — see `vendor-wasmer-sdk` in
`vite.config.ts`.

**Bash functions define fine and hang when called.** So does a script on
`PATH`. An alias works, being textual substitution with nothing to fork, which
is why `awk` is one.

**bash prints no prompt and echoes nothing of its own input**, even with a real
pty attached — but it *does* restore the terminal around each foreground job,
so what a running program reads is echoed by the terminal. That division is why
the page draws the prompt and echoes while composing a line, never during a
command, and strips the echo of what it sent.

**ctrl-c ends the shell, not merely the command.** The output stream stays open
afterwards, so a shell that can serve nothing more still looks healthy and
every later command hangs against it. The console tears it down deliberately
and starts a fresh one.

**ctrl-d does nothing** — there is no canonical mode, so there is no EOF to
send.

**`FileStat` carries `kind` and `size` and nothing else** — no modification
time, no hash — so the sync diff must read every file to know what changed.
That is affordable only under the 500-file cap.

**`find` exits 1** after doing its work, unable to restore its working
directory. The output is correct; only `find … && …` is affected.

## How a change travels

Two layers, and the split matters.

**Text in an open file** is a CRDT. Yjs updates cross the relay's doc channel
directly between browsers, so two people can type in one file at once. The
stream is a hash of the path, so every browser agrees which stream a file is on
without being told.

**Everything else** — a file a script wrote, a file somebody added — goes
through the store. A peer broadcasts only that something *moved*, and everyone
re-reads. Shipping the contents over the relay would make the broadcast and the
store two copies of one truth, and a frame dropped or arriving mid-reconnect
would leave a browser confidently out of step with no way to notice.

Getting a document's *initial* state right is the subtle part. Seeding every
browser from the store is wrong — a CRDT identifies each character by who
inserted it, so two browsers inserting the same string are two insertions and
the merge keeps both. Seeding under a fixed client id is worse: identical text
dedupes, but *different* text produces conflicting operations under the same
ids, which Yjs discards as already known, and two documents then exchange
updates while silently ignoring each other. A newcomer therefore asks the room
and takes what it is given, seeding only when nobody answers — which needs the
relay to have said who is here first.

## The download

Wasmer's CDN sends `.webc` with no content encoding at all: 73 MB raw for the
eight packages the runtime actually fetches. From this origin, pre-compressed
with zstd, the same set is about 16 MB, and the immutable cache header makes
any later visit free.

It has to be a service worker. The SDK has no registry override and its browser
build cannot decode in-memory WEBC — `packages.load(bytes)` fails with
`FeatureNotEnabled { "authoring" }` — and patching `fetch` would not reach the
downloads either, because the SDK does them inside workers with their own
globals.

The URL list is *observed*, not derived: `scripts/fetch-packages.mjs` runs the
app once and records what it asks for. Asking the registry for each package's
download URL returned, for coreutils, a `.tar.gz` the runtime never requests,
and said nothing about the two dependencies the packages pull in on their own —
three of eight URLs were wrong or missing.

One trap worth knowing: a service worker's response keeps the *original*
request URL, so a network log attributes every mirrored download to
cdn.wasmer.io and reads like total failure while the mirror works perfectly.
The check asserts on the worker's own counters instead.

And the worker strips `Content-Encoding` and `Content-Length` before handing a
response back. `fetch` has already decompressed the body, but those headers
still describe the compressed form, and the SDK — which decodes HTTP itself,
inside wasm — tries to decompress bytes that are already plain, failing with
`zstd content-encoding is not supported on wasm32`.

## What it does not do

- **Empty folders do not persist.** Directories are derived from the paths
  under them, so one with nothing in it has nothing to imply it.
- **No accounts, no locks.** Everything is open to whoever has the link, and a
  folder untouched for a week is deleted — though its name is never reused, so
  a link shared in a tutorial can never later resolve to a stranger's files.
- **No network from the sandbox.** A browser cannot open a TCP socket, so there
  is no `pip install` and no `git clone`.
- **Nothing is encrypted.** ajar sessions are end-to-end encrypted; pads are
  plaintext on the server, which is the trade for a clean shareable URL.

# The browser tier

`pad/`. A real bash, python and coreutils compiled to WebAssembly, running in
the visitor's tab. Nothing executes on the server.

Every finding below cost real time and none of it is documented upstream.

## Running it

```sh
npm ci
node pad/scripts/fetch-packages.mjs   # mirrors ~73 MB of wasm; needed once
npm run dev:pad
cargo run -p ajar-relay -- --bind 127.0.0.1:8787 --pad-dir ./ajar-pads
npm run check --workspace=ajar-pad
```

## The binary set

Pinned, mirrored, and served from this origin — **80 MB raw, 18.6 MB
compressed**. A folder that ran last week has to run this week, and a registry
nobody here controls cannot promise that.

```
wasmer/bash@1.0.25           wasmer/grep@3.12.0      syrusakbary/jq@0.1.0
sharrattj/coreutils@1.0.16   wasmer/sed@4.9.0        wasmer/gzip@1.14.0
python/python@3.13.20        wasmer/find@4.10.0      wasmer/tar@1.35.0
                                                     sqlite/sqlite@0.2.2
                                                     saghul/quickjs@0.0.3
```

Note the namespaces. `sharrattj/grep` does not exist and `wasmer/grep` does;
the registry's search endpoint returns nothing for any query, including
`python`. An earlier version of this document concluded several of these tools
were unavailable, which was a wrong conclusion from a broken search — see
[what else the registry has](#what-else-the-registry-has) for how that was
eventually done properly.

`wasmer/bash` rather than `sharrattj/bash`: the older build takes SIGINT on
`$(...)` and dies with exit 130, so command substitution killed the session
shell. Backticks were unaffected, which is why it survived so long. The same
upgrade fixed shell functions, which this document used to call a WASIX
limitation and which was only ever that build.

## Commands that come from python

Twenty-six of them, aliased in `shell.ts`:

| | Why |
|---|---|
| `awk`, `diff`, `patch`, `cmp`, `zip`, `unzip`, `bzip2`, `xz`, `tree`, `xargs`, `xxd`, `which` | No port published anywhere |
| `sort`, `tail`, `split`, `stat`, `du`, `sha256sum`, `sha1sum`, `md5sum` | Advertised by the shipped coreutils and **not compiled into it** |
| `hexdump`, `cal`, `rev` | Published in `syrusakbary/util-linux`, where only `cal` runs |
| `nano` / `edit` | Neither nano nor vim can be installed, and curses cannot start |
| `find` | Published and working, but it cannot spawn, so `-exec` produces nothing — and it exits 1 even on success, unable to restore its cwd |

`awk`, `sort` and `tail` are a file each, being large. The other twenty-three
live in `src/tools/box.py` and dispatch on their first argument — the same
multi-call shape as the coreutils binary, and unlike that one everything listed
is present. One file rather than twenty-three because the shell writes and
aliases these before the first prompt; all twenty-eight aliases go out in a
single `run` for the same reason. A warm command costs **142 ms**.

`find` is the one entry in that table that shadows a *working* binary, and it
earns the exception twice over. `-exec` needs to spawn, which the binary cannot
do and python can — the same capability that makes `xargs` work here. And the
shipped one exits 1 after doing its work, having failed to restore its working
directory under WASIX, so `find … && …` never ran the second half. Both faults
are silent: a correct search that looks like a failed one. The shim's own
`-exec` inherits the limit that spawning implies — it reaches real binaries
only, never the aliases in this file, and says so rather than ending in a
traceback.

It also hides `.ajar/` from a walk, which was found by running it against the
live site: `find . -name '*.py'` listed five files nobody wrote. The shims live
in the folder so the shell can reach them, `sync.ts` already refuses to publish
them in those words, the file tree does not draw them and `ls` does not show
them — a search should not be the one place they surface. Naming the directory
still reaches them, exactly as a hidden one should.

`sharrattj/coreutils` is uutils 0.0.7 as a multi-call binary. `sort file`
answers `file: function/utility not found`, and so does `sort sort file` — the
name is simply not among the functions built in. `wasmer/coreutils@1.0.25` is
the identical build, so the newer-package move that fixed bash does nothing
here, and `kilyanni/coreutils` (GNU 9.11) cannot be installed.

Each shim is checked against the real tool before being trusted — awk on thirty
programs, sort on fifteen cases, tail on twelve, the boxed set on twenty-three —
and then again inside the runtime. Each refuses what it does not implement
rather than ignoring it: a `sort` that silently drops `-k` is worse than one
that says it cannot.

The cost is one python start per invocation: **214 ms against 39 ms** for a
native command. Worth paying for a command that otherwise does not exist, and
not worth paying for one that works — which is why nothing already in coreutils
is shimmed.

### Four worth knowing individually

`xargs` needs to launch other programs, and `find -exec` cannot. That is find's
limitation rather than the runtime's: python's `os.system`, `subprocess.run`
and `os.popen` all work here, though `os.fork` does not.

`patch` applies context-matched hunks with no fuzz. A hunk whose context does
not match is refused rather than guessed at, because patch guessing wrong is
how a file silently becomes something nobody wrote.

`du` reports **apparent** size, which GNU calls `--apparent-size` and not its
default. Real `du` counts allocated blocks and this filesystem has none to
count; a number invented to look like a real one would be worse than the true
one.

`watch` is deliberately absent. It ends only when interrupted, and ctrl-c here
ends the shell rather than the command, so it would trap whoever ran it.

## What else the registry has

Enumerating every package that ships a command found **550 of them, with 491
distinct command names**. An earlier search probed 420 name guesses across six
namespaces and concluded most of these did not exist — guessing is not
searching, and the enumeration took one query.

There is no server-side popularity sort. `Package.totalDownloads` exists but is
partial: only 189 of the 550 report any, and `python/python` reports zero,
which cannot be true. `likersCount` is sparser and more honest — python 36,
spidermonkey 28, sqlite 26, rustpython 22. Together they give a usable
shortlist; neither alone does.

Everything on that shortlist was probed. **None of it is worth shipping:**

| | |
|---|---|
| `rg` (ripgrep), `fd` | Listed by the API, `packages.load` cannot fetch them |
| `bzip2` | Installs, then exits 11 on every invocation |
| `util-linux` | `cal` works; `rev` and `hexdump` exit 1 |
| `ruby` | `ruby -e` works; a script file exits 1 |
| `rustpython` | Works, but cannot replace CPython — see below |

**`rustpython` is 22.3 MB against CPython's 58.9 and is not a saving.**
Installed without CPython, `pwd` still answers `/workspace` while every
relative path fails and `open()` raises `PermissionError` — the exact signature
of a sandbox missing CPython. The filesystem comes from the CPython package
rather than from the runtime. Alongside CPython it passes everything, where it
is redundant.

That is also why the probe catalogue has a `without` field: a candidate
proposed as a replacement, installed next to the thing it would replace, proves
nothing.

Two namespaces now list packages the SDK cannot fetch — `kilyanni/*` and
`liftm/*`. Registry presence is no guide to installability.

## Things about this runtime that are not obvious

**The JavaScript filesystem and the process filesystem are different
namespaces.** The JS root *is* the process's working directory: a file written
to `/out.csv` from the page is `out.csv` to the program. A path that looks
absolute to a process — `/app/main.py` — lands at `/workspace/app/main.py`
instead, so Python reports `[Errno 44]` for a file `readDir` can plainly see.
Every path in this application is root-relative in the JS view.

**The SDK cannot be bundled.** It resolves its worker with `new URL(…,
import.meta.url)`, and that worker statically imports two siblings. A bundler
flattens the layout, the siblings 404, and **every command hangs forever with
nothing thrown**. It is vendored verbatim — see `vendor-wasmer-sdk` in
`pad/vite.config.ts`.

**`spawnShell` must pass only `terminal`.** Naming stdin/stdout/stderr
alongside it replaces the pty with pipes, and the shell stops behaving like a
terminal.

**Bash functions used to define fine and hang when called** — and that was a
property of `sharrattj/bash@1.0.18`, not of WASIX, which this document
previously got wrong. `wasmer/bash@1.0.25` runs them. The same upgrade fixed
`$(...)`, which took SIGINT and killed the shell on the old build while
backticks worked, so it went unnoticed for a long time.

`awk` remains an alias. It was made one to dodge the hang, and an alias is
still the simpler thing — textual substitution with nothing to fork.

A script on `PATH` still does not work.

**A full-screen program does work, despite what this used to imply.** `curses`
imports and `initscr()` fails — there is no terminfo database — but everything
underneath it is present: `os.get_terminal_size()` reports the real size,
`tty.setraw()` works, `sys.stdin.read(1)` returns one byte unbuffered, and
cursor escapes reach the terminal. `src/tools/edit.py` is an editor written
straight against ANSI on that basis, aliased as `nano` and `edit`.

It binds nothing to ctrl-c, and cannot: the page intercepts ctrl-c and tears
the shell down before a program sees it. ctrl-x is the way out, which is nano's
key anyway.

**bash prints no prompt and echoes nothing of its own input**, even with a real
pty attached — but it *does* restore the terminal around each foreground job,
so what a running program reads is echoed by the terminal. That division is
why the page draws the prompt and echoes while composing a line, never during
a command, and strips the echo of what it sent.

**ctrl-c ends the shell, not merely the command.** The output stream stays
open afterwards, so a shell that can serve nothing more still looks healthy
and every later command hangs against it. The console tears it down
deliberately and starts a fresh one.

**ctrl-d does nothing** — there is no canonical mode, so there is no EOF.

**`FileStat` carries `kind` and `size` and nothing else** — no modification
time, no hash — so the sync diff must read every file to know what changed.
Affordable only under the 500-file cap; if that cap rises this breaks first.

**`find` exits 1** after doing its work, unable to restore its working
directory. The output is correct; only `find … && …` is affected.

## Probing a package before shipping it

`pad/src/packages/catalogue.ts` lists candidate packages and what each has to
do to earn its megabytes; `npm run probe --workspace=ajar-pad` installs each in
a real browser and runs its checks (`--all` for the heavy ones, `--only <name>`
for one, `PROBE_VERBOSE=1` for the detail). Adding a binary is one entry there.

Each check declares the capability it proves, so a partial pass names what is
broken rather than counting: `broken: sort, tail -n, stat`. A package that
half-works is worse than one that is absent, because it fails later and
somewhere else.

Three rules, each learned by getting it wrong:

**Install the candidate alongside the full shipped set, never alone.** A
reduced sandbox changes behaviour in ways indistinguishable from a broken
package — without python the working directory is wrong and every relative
path resolves against `/`; with a partial set a file written by python is
invisible to `cat`. Both looked exactly like a package failing, and one was
reported as a production bug before the control disproved it.

**One line per check.** The shell detects a command's end with a sentinel
appended to the same line, so an embedded newline splits the command from its
sentinel and reads as a hang. A heredoc test killed the shell and made nine
working bash features look broken.

**Never pipe through an unverified tool.** Piping through the shipped `sort`,
which is broken, made `find`, `tar` and `xargs` all look broken too.

The `__shipped__` entry is a control, not a candidate: it installs exactly what
the product installs. When it passes and a candidate fails, the candidate is at
fault; when it fails, the harness is. It caught all three mistakes above.

### What the probe found

**Most of what it first reported as broken was the tests, not the tools.**
`tar -C` extracts and then exits 2 the way `find` does, and chaining with `&&`
hid a successful extraction behind the status. `sqlite` reads stdin and prints
an interactive banner, which `-batch` suppresses. `node -e` puts the first
argument at `argv[1]` because there is no script path. `clang` was compiling
`printf("0")`, because the shell's own `printf` had eaten the `%d` meant for
the C source. `find -size -1k` matches nothing because GNU rounds sizes up to
whole blocks. Six of the eight first reported were mine.

What the probe found that was real, and is now fixed: `$(...)` killed the
shell, shell functions hung, and `sort`, `tail`, `split`, `stat`, `du`,
`sha256sum` and `md5sum` were absent. The first two were a bash build; the rest
are python shims.

Still real and unfixed:

| | |
|---|---|
| `find -exec` | Produces nothing and exits 1 in all three forms — it cannot spawn |
| `lua` | Does not start; even `lua -v` exits 45. The only published build |

**`git` works, and needs `--no-pager`.** `git log` alone spawns a pager that
does not exist and exits 79 with no output — indistinguishable from a commit
that never happened, and reported that way here before being diagnosed. If git
is ever shipped, `shell.ts` has to set `GIT_PAGER=cat`.

Registry presence is **not** installability. Every `kilyanni/*` and `liftm/*`
package returns full metadata from the GraphQL API and then fails
`packages.load` with "not found" — two namespaces, so it is a property of the
registry rather than one bad publisher. `kilyanni/coreutils` is GNU 9.11 at
half the size of ours and would remove seven shims if that ever changes, so the
entries stay.

## The shell, and detecting when a command ends

One shell per session. A sentinel is appended to the command **on the same
line**:

```ts
const trimmed = command.trimEnd();
const joiner = trimmed.endsWith("&") ? " " : "; ";
const line = `${trimmed}${joiner}printf '\001%s\001' "$?"`;
```

As a *second* line it gets eaten by anything reading stdin — which is how
`cat` with no arguments appeared to hang. `dropEcho()` searches for the echo
anywhere rather than at position 0, and `watchForExit()` uses `proc.wait()`
because the output stream stays open after bash dies.

## How a change travels

**Text in an open file** is a CRDT, straight between browsers on the doc
channel. The stream id is a hash of the path, so every browser agrees which
stream a file is on without being told.

**Everything else** goes through the store: a peer broadcasts only that
something *moved*, and everyone re-reads.

### Seeding a document is the subtle part

Three attempts, and the first two are instructive:

- **Seeding every browser from the store** duplicates text. A CRDT identifies
  each character by who inserted it, so two browsers inserting the same string
  are two insertions and the merge keeps both.
- **Seeding under a fixed client id** is worse. Identical text dedupes, but
  *different* text produces conflicting operations under the same ids, which
  Yjs discards as already known. Two documents then exchange updates while
  silently ignoring each other — 73 frames sent, 72 received, no text moving.
- **Correct:** a newcomer asks the room and takes what it is given, seeding
  only when nobody answers. Which requires the relay to have said who is here
  first.

### Seeding the sandbox is a separate problem, with the same shape

The document seeding above is about the *room*. Seeding the **sandbox** is
about one browser, and it got the order wrong for a while.

The runtime is created inside the first content change any model reports, and
`ensureRuntime` takes its snapshot synchronously at that instant — so the
snapshot lands *during* the editor binding, when the model being bound can
still be empty. Seeding from the models alone therefore gave the sandbox every
filename and no contents. Opening a shared link and running a file you had not
yourself edited did nothing at all, and said nothing about why.

`pad/src/seed.ts` puts the three sources in the order each becomes true:

1. **The store**, as the base layer — the only source already correct when the
   runtime starts.
2. **The model**, where it has something, so unsaved edits run.
3. **The document**, where there is one, since it is what fills the model.

An empty model is taken only for a path the store has never heard of, which is
the one case where empty is the truth rather than a file that has not loaded.

It lives in its own module because the moment it runs is a race, and a race is
untestable from the outside: three separate attempts to catch the bug through
a driven browser all passed against the broken code. As a pure function it is
ordinary, and `src/check.ts` asserts it directly.

## The download

Wasmer's CDN sends `.webc` with no content encoding at all: 73 MB raw for the
eight packages the runtime actually fetches. From this origin, pre-compressed
with zstd, the same set is about 16 MB, and an immutable cache header makes
any later visit free.

It has to be a service worker. The SDK has no registry override, its browser
build cannot decode in-memory WEBC (`packages.load(bytes)` fails with
`FeatureNotEnabled { "authoring" }`), and patching `fetch` would not reach the
downloads because the SDK does them inside workers with their own globals.

The URL list is **observed, not derived**: `pad/scripts/fetch-packages.mjs`
runs the app once and records what it asks for. Asking the registry for each
package's download URL returned, for coreutils, a `.tar.gz` the runtime never
requests, and said nothing about two dependencies the packages pull in on
their own — three of eight URLs were wrong or missing.

Two traps:

**A service worker's response keeps the original request URL**, so a network
log attributes every mirrored download to `cdn.wasmer.io` and reads like total
failure while the mirror works perfectly. The check asserts on the worker's
own counters instead.

**The worker must strip `Content-Encoding` and `Content-Length`.** `fetch` has
already decompressed the body, but those headers still describe the compressed
form, and the SDK — which decodes HTTP itself, inside wasm — tries to
decompress bytes that are already plain, failing with `zstd content-encoding
is not supported on wasm32`.

Caddy also needs `precompressed zstd gzip` for `.webc`: its `encode` directive
decides from Content-Type and does not know that extension.

## What it does not do

- **Empty folders do not persist.** Directories are derived from the paths
  under them, so one with nothing in it has nothing to imply it.
- **No accounts, no locks, no encryption.** Deliberate — the trade for a clean
  shareable URL. See [security.md](security.md#what-the-pad-does-not-have).
- **No network from the sandbox.** A browser cannot open a TCP socket, so
  there is no `pip install` and no `git clone`, permanently.
- **A process that never exits never syncs.** The folder is published at
  command exit, which is a real transaction boundary — it either ran or it did
  not, and a half-written file is never shared. Fine for paste-run-look; wrong
  for a dev server.
- **No `make`, `ssh`, `vim`, `less` or `curl`.** The network ones are
  impossible rather than unbuilt. `make` is possible now that spawning works
  and is simply not written. `nano` exists; `vim` does not.

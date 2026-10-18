# The browser tier

`pad/`. A real bash, python and coreutils compiled to WebAssembly, running in
the visitor's tab. Nothing executes on the server.

Every finding below cost real time and none of it is documented upstream.

## Running it

```sh
npm ci
node pad/scripts/fetch-packages.mjs   # mirrors ~66 MB of wasm, with .zst and .gz copies beside it; needed once
npm run dev:pad
cargo run -p ajar-relay -- --bind 127.0.0.1:8787 --pad-dir ./ajar-pads
npm run check --workspace=ajar-pad
```

## The binary set

Pinned, mirrored, and served from this origin — **66.5 MB raw, 15.1 MB
compressed**, across ten `.webc` files for nine pinned packages and what they
pull in. A folder that ran last week has to run this week, and a registry
nobody here controls cannot promise that.

```
wasmer/bash@1.0.25           wasmer/grep@3.12.0      syrusakbary/jq@0.1.0
  └ wasmer/coreutils@1.0.27  wasmer/sed@4.9.0        wasmer/gzip@1.14.0
python/python@3.13.20        wasmer/find@4.10.0      wasmer/tar@1.35.0
                                                     saghul/quickjs@0.0.3
```

A version without `=` is a range: `wasmer/bash@1.0.25` means 1.0.25 or any
later 1.x. Everything in `runtime.ts` is pinned with `=` now, and coreutils —
bash's dependency, which no list of packages can pin, because bash resolves
its own range — is pinned in `public/sw.js`, by answering the SDK's registry
query with one version. Until 28 September it floated, and a coreutils
release on Wasmer's side changed what every visitor ran. It is 1.0.27, not
the smaller 1.0.25, because with 1.0.25 the browser check hangs every time.
Listing `sharrattj/coreutils` beside bash, an earlier attempt, downloaded both.
`sqlite/sqlite` was dropped the same day, 25 September: it was a second copy of
the engine python's `sqlite3` module carries, so the `sqlite3` command is gone
and `import sqlite3` is not.

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

Twenty-eight aliases, covering twenty-eight names, all of them in
`shell.ts`:

| | Why |
|---|---|
| `awk`, `diff`, `patch`, `cmp`, `zip`, `unzip`, `bzip2`, `bunzip2`, `xz`, `unxz`, `tree`, `xargs`, `xxd`, `which` | No port published anywhere |
| `sort`, `tail`, `split`, `stat`, `du`, `sha256sum`, `sha1sum`, `md5sum` | Advertised by the shipped coreutils and **not compiled into it** |
| `hexdump`, `cal`, `rev` | Published in `syrusakbary/util-linux`, where only `cal` runs |
| `nano` / `edit` | Neither nano nor vim can be installed, and curses cannot start |
| `find` | Published and working, but it cannot spawn, so `-exec` produces nothing — and it exits 1 even on success, unable to restore its cwd |

`awk`, `sort` and `tail` are a file each, being large. The other twenty-three
live in `src/tools/box.py` and dispatch on their first argument — the same
multi-call shape as the coreutils binary, and unlike that one everything listed
is present. One file rather than twenty-three because the shell writes and
aliases these before the first prompt; all twenty-eight aliases go out in a
single `run` for the same reason, along with `clear` and the shell's exports —
the two below among them. A warm
command costs **142 ms**.

Those exports are `PIP_TARGET` and `PYTHONPATH`, both pointing at
`/workspace/.deps`, and neither is a convenience. python's own site-packages
lives under a read-only `/nix/store` path: a plain `pip install` reports
success and the package is then not importable, because the write landed in a
layer that does not outlive the process. Sending it to the folder instead makes
it real for as long as the sandbox runs. They used to sync with the pad too,
until numpy's 1,336 files met the 500 a pad holds (18 October): `.deps` is
ignored by the sync now (sync.ts), and what reaches whoever opens the link is
`requirements.txt`, which a typed `pip install` adds to (`App.recordInstalled`)
and Run installs from (`App.installRequirements`).

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

The shipped coreutils — `wasmer/coreutils`, by way of bash — is uutils 0.0.7 as
a multi-call binary. `sort file` answers `file: function/utility not found`, and
so does `sort sort file` — the name is simply not among the functions built in.
`sharrattj/coreutils`, which the pad used to pin, is the identical build, so the
newer-package move that fixed bash does nothing here, and `kilyanni/coreutils`
(GNU 9.11) cannot be installed.

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

`xargs` needs to launch other programs, and so does `find -exec`. Neither is a
limitation of the runtime: python's `os.system`, `subprocess.run` and
`os.popen` all work here, though `os.fork` does not. It was the shipped
findutils binary that could not spawn, which is why `find` is a shim too.

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

**Even with the pty, stderr is a pipe of its own.** Only stdout is read, so
`Shell.run` sends each command's stderr into it (`eval '…' 2>&1`). Until 27
September nothing did, and every error went nowhere. A traceback showed as a
bare `exit 1`, `def f(in):` looked like the pad refusing to run code, and `ls`
of a missing folder printed nothing. `terminal-check.mjs` now checks that errors
arrive, in order, and that a typed `2>/dev/null` still silences them.

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

It binds nothing to ctrl-c, which reaches it as a key: while the alternate
buffer is up, the page passes ctrl-c through instead of stopping the program.
ctrl-x is the way out, which is nano's key anyway, and Stop ends it.

**ctrl-c is a signal through the pty, and bash survives it.** It used to end
the shell, on the belief that bash could not survive an interrupt. Measured on
27 September it does — and ending the shell never stopped the program anyway. `terminate()` and `kill()` end bash and nothing
under it, so a python loop went on printing into the terminal a minute after
ctrl-c. Written as `\x03` into the pty, the signal stops python in any state
within 30 ms, and bash keeps its directory and variables. Two details are in
`Shell.interrupt`: a program killed mid-read leaves the read pending, and it
swallows the next line unless a newline is sent first; and a signal that lands
on bash itself abandons the sentinel, so the shell is ended after 1.5 s if the
command has not finished.

**No threads.** The first `Thread.start()` traps in the engine ("table index
is out of bounds") and the program hangs with no output. This is the registry's
python exactly as published, with the mirror bypassed, so it is not the trim.
`src/tools/sitecustomize.py` makes `start()` raise instead. pip's progress bar
starts a thread, which is why `pip install requests` used to freeze the page:
`PIP_PROGRESS_BAR=off` is set in the shell, and it installs in about 6 s.
socketserver's threading servers — `python -m http.server` — serve their
requests in turn instead, since 15 October ([networking.md](networking.md)),
and so does Werkzeug's, under Flask. Flask's debug mode asks for the
reloader, which watches files on a thread; since 16 October `run_simple` is
given `use_reloader=False` and says so, where it was this file's traceback.
sitecustomize changes a module only once it is imported, through a finder
first on `sys.meta_path`, so the aliased tools that start a python for every
`sort` pay nothing for it.

**A pad of more than 200 text files was a page error.** Every file had a
Monaco model, every model listens to Monaco's language service, and that
emitter calls more than 200 listeners a leak — `[001] potential listener LEAK
detected` — thrown on a timer as an unexpected error. `pip install flask`
alone puts 187 files in `.deps` (not saved since 18 October, but models then).
It is not a leak here, and a pad holds 500,
so since 16 October `App.openEditor` drops that one report from Monaco's
`errorHandler` and passes every other error on; Monaco's console warning
stays. Since 18 October a file has a model only once the editor needs one
([Opening a pad of 500 files](#opening-a-pad-of-500-files)), so only someone
who opens more than 200 files in one visit gets that far.

**More than one terminal, since 16 October** (`terminals.ts`). Each is a
`TerminalSession` — its xterm, its console, its bash — in the one sandbox, so
they share the files, and a port one listens on is reachable from another. Run
and Stop are the front one's; what needs nothing to be running (a move, an
import) waits for all of them, and the javac and fetch bridges look for
requests while any runs. A language installed by one terminal's line is seen
only by shells opened after it (toolchains.ts), so a terminal whose shell is
older gets a fresh one, where it was, at its next line (`stale`). The first
terminal is the workspace's `#terminal`; the rest are made beside it.

**Ctrl-C reaches a program's child, not the program.** A program that started
another process still running — `subprocess.Popen(["sleep", "100"])` — takes no
notice of Ctrl-C here, and neither does the child it reaches; after a second and
a half `Shell.interrupt` ends bash, and the program goes on unseen. Flask's
debug mode was the common case, without starting anything itself: its debugger
makes a `multiprocessing.Value`, and the first lock like that starts Python's
resource tracker, a process of its own. Flask served on, holding its port,
behind a prompt that looked as though it had stopped, and the next run said
"Address in use". Since 16 October `sitecustomize.py` does not start the
tracker — what it would clean up goes with the sandbox — and when an interrupt
has to end the shell the console says the program may still be running. A
program with a real child is still unreachable; only a reload ends it.

**There is no home directory.** `~` is not expanded, so a tool that keeps
something under it — pip's cache, for one — makes a directory called `~` in
the folder. pip's went into every pad that installed anything,
fifty files for Flask, saved for everyone, until 16 October: the shell sets
`PIP_NO_CACHE_DIR=1`, and `~/` is ignored by the sync like `__pycache__`, which
also deletes what a pad had stored there at its next command.

**bash prints no prompt and echoes nothing of its own input**, even with a real
pty attached — but it *does* restore the terminal around each foreground job,
so what a running program reads is echoed by the terminal. That division is
why the page draws the prompt and echoes while composing a line, never during
a command, and strips the echo of what it sent.

**A shell that has exited still looks alive.** The output stream stays open
after bash dies, so `watchForExit()` waits on the process instead, and the
console replaces a dead shell before the next command and says so.

**ctrl-d closes the program's input.** The byte alone does nothing — there is
no canonical mode to turn it into end-of-file — so the page closes stdin
instead. That is a real EOF, and bash's own stdin too, so bash exits once the
program does and the next command starts a fresh shell. At the prompt it
deletes forward; to `nano`, both ctrl-c and ctrl-d are just keys.

**`FileStat` carries `kind` and `size` and nothing else** — no modification
time, no hash — so the sync diff must read every file to know what changed.
Affordable under the pad's caps of 500 files and 100 MB — 25 MB until 7
October, 60 until 11 October. Timed then, in a 100 MB pad of 50 files: a
command's change is stored 0.1 s after Enter, the diff included, as at 25 MB.
The sandbox's files are in memory, so reading them all is cheap; if the caps
rise again, time it again.

**A binary cannot restore its working directory**, so the shipped `find`
exited 1 after doing its work correctly and `find … && …` never ran its second
half. That is what made a shim worth writing rather than a quirk worth
documenting; python does not chdir, so the shim exits 0.

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

A program that is not a package yet can be tried the same way:
`probe.html?files=<url>` fetches a manifest — `{"files": {path: url},
"commands": [...]}` — seeds the folder with those files, and runs each command
in one shell, reporting what each printed and how long it took. The sandbox
runs a `.wasm` straight from the folder (`./java.wasm -cp . Main`), which is
how Java was tried before it was packed.

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
| `lua` | Does not start; even `lua -v` exits 45. The only published build |

`find -exec` was on this list — it produced nothing in all three forms, being
unable to spawn — until `find` became a shim like the rest.

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

## Languages on first use

Asked for on 12 October: java and javac, gcc, and other languages. The registry
has **no JVM, no javac, no gcc and no tcc** — found by listing it (47,033
packages, most of them app deployments; its listing repeats and skips, so every
likely name was then looked up too). So Java is a package of our own — see
[Java](#java) below. What the registry has, probed in the browser that day
(`probe-packages.mjs`, the catalogue's "languages" block):

| | Package | As published | What works |
|---|---|---|---|
| C | `clang/clang` | 106 MB | compiling and running C, exit status (`syrusakbary/clang`, the same build, also 4/4); a C binary runs as often as it likes |
| C++ | the same, `--driver-mode=g++` | — | lambdas, `<cstdio>`; `<iostream>` did not finish compiling in fifteen minutes, so Run says so first |
| JavaScript | `wasmer/edgejs` | 75 MB | `node`, `npm`, `pnpm` — all ten checks |
| PHP | `php/php` | 82 MB | all six checks |
| Go | `golang/go@=1.25.5-wasix-1` | 273 MB | single-file programs through `go run`, given absolute paths — see below |
| Common Lisp | `selwynsimsek/clisp` | 4 MB | the REPL and `-x` expressions; the command is `repl`; a file crashes it (exit 11) |
| Ruby | `katei/ruby` | — | `-e` only; a script file exits 1, and `-e "$(cat f.rb)"` prints nothing. Not offered |
| Zig | `fschuett/zig` | — | `zig version` only; `zig run` and `zig cc` fail with FileNotFound. Not offered |

None of them is installed on a visit. Every one is heavier than everything the
pad does ship, so each is fetched into the sandbox the first time a line names
one of its commands, or Run is pressed on a file it runs (`toolchains.ts`): the
terminal says what is being fetched and how big it is, and the line then runs.

**A package installed into a running sandbox is seen only by processes it
starts afterwards** (`sandbox.installPackage`, measured 12 October): not the
shell already open, not a `bash -c` from it, and nothing under `/bin`. So after
fetching, the page opens a fresh shell where the old one was, with what it had
exported (`App.replaceShell`), and the line runs there. Variables that were not
exported, and the person's own aliases, stay with the old shell.

**Go cannot open a relative path, or learn its working directory.** `go run
main.go` answers `stat main.go: Bad file number`; in a module, `getwd: File name
too long`. With an absolute path a single-file program runs and builds, so `go`
and `gofmt` are aliases to `tools/go.py`, which makes every `.go` argument and
the path after `-o` absolute and runs the real command from the folder root,
where Go can tell where it is — an alias rather than a shell function because
calling a function hangs in this bash. Modules, and so anything with more than
one package, do not work. Inside a Go program a relative path fails the same
way (`open data.txt: Math result not representable`), so a program opens files
by absolute path. And a binary `go build` makes runs once: the second time,
`cannot execute binary file: Exec format error` — so `go run`, which builds
afresh each time, is the way to run one, and what Run uses. A C binary runs as
often as it likes.

Asked for by name alone, `golang/go` is "not in the registry": its only version
is a pre-release, which a bare name never resolves to. Pinned, it installs.

`fetch-packages.mjs` uses each of them once while recording, so they are
mirrored and their registry answers recorded like the rest; a first `go` from
Wasmer's CDN would otherwise be 273 MB uncompressed.

### Java

`java` and `javac` are **Ristretto** (github.com/theseus-rs/ristretto, Apache-2.0
OR MIT), a JVM written in Rust, built for WASI preview 1, running **Amazon
Corretto 25's class library** — the real one, not a reimplementation. `javac` is
the JDK's own compiler, run by that JVM. `pad/scripts/build-java.mjs` builds the
whole thing from pinned inputs: Ristretto at a commit, with
`pad/scripts/java/ristretto.patch`; Ristretto's own pinned Rust; the Corretto
linux/amd64 image by digest, trimmed with jlink to java.base, the compiler, and
the modules course and exercise code reaches for (logging, XML, SQL, the HTTP
client, prefs, scripting). It packs them with `webc-pack` into
`pad/public/packages/ajar-java-<hash>.webc`: two atoms, `java` and `javac`, and
the JDK as a volume mounted at `/usr/lib/jvm/java-25`, which the commands find
through `RISTRETTO_JDK_HOME` in their own environment. 60.5 MB, 11.1 MB zstd. The
same inputs make the same bytes, and so the same URL.

No registry has it, so `build-java.mjs` also writes `own.json`: the answer
registry.wasmer.io would give for `ajar/java`, and where its file is. The
service worker answers from it as it does from `registry.json`, and serves the
download for `packages.ajar.invalid` — a host nothing else answers for — from
the mirror. Nothing is published anywhere. `fetch-packages.mjs` serves both
while it records and keeps them when it prunes; deploy refuses without
`own.json`.

The alternatives, looked at that day: TeaVM compiles Java ahead of time to wasm
with a class library of its own, which lacks `Scanner` on `System.in`,
`printStackTrace` and more; CheerpJ runs a real JDK in the browser but is
proprietary, and needs a commercial licence to self-host. Ristretto ran the
real class library and already built for WASI.

**What the patch changes**, each found by a program that behaved differently
from HotSpot:

- WASI preview 1 has no HTTP, and Ristretto's runtime downloader pulled in
  wasip2 imports through `wstd`, which no preview 1 host can satisfy. It is
  compiled out there; the JDK comes from `RISTRETTO_JDK_HOME`.
- A preview 1 process starts in `/` whatever its shell's directory: both
  commands `chdir` to `$PWD` first, so `-cp .`, `javac Main.java` and a
  program's `new File("data.txt")` resolve as they would anywhere.
- `env::split_paths` is unsupported on WASI; `-cp` is split on `:`.
- `System.in.available()` threw, and `Scanner` swallowed it and read nothing.
- `Files.createDirectories`, `move`, `delete` and `copy`: `access0` returned -1
  where Java 21 and later want an errno, and WASI's errno numbers are not the
  Linux ones the class library compares against; `rename0`, `unlink0`, `rmdir0`,
  `link0`, `close0`, `statvfs0`, `bufferedCopy0` and `LinuxNativeDispatcher`'s
  natives had no WASI version.
- `Thread.sleep` blocked every Java thread, and a thread still running when
  `main` returned was cancelled: each call made its own task set, which died
  with it. One set now holds every thread, `sleep` yields, and the VM waits for
  non-daemon threads as a JVM does.
- An uncaught exception printed Ristretto's own summary without a trace; it is
  now `Exception in thread "main"` and Java's own `printStackTrace`.
- Java 25's launch protocol: `void main()` and instance main methods, so a
  compact source file runs.
- `java Main.java` compiles in memory and runs, as the JDK's source launcher
  does, and its diagnostics say `Main.java`, not `/Main.java`.
- `java -version` prints the class library's version as the JDK's launcher
  would, with Ristretto named on its last line.
- `javac` and `java Main.java` ask the page to compile first (`bridge.rs`;
  see the fast javac below), and compile here only when it does not answer.

**Measured** with `java-fidelity.mjs` (below), on 15 October: 15 programs —
strings and formatting, collections and streams, records and pattern switches,
`BigDecimal`, `java.time` with zones, regex, threads and executors, exceptions
with causes, `Scanner` on stdin, files, `System.exit`, compile-time constants —
run on HotSpot 25 and here, compared byte for byte: 14 identical. The 15th is
two messages HotSpot words in more detail (a `ClassCastException`'s module
suffix, a `NullPointerException`'s method names) and a missing
`ArrayStoreException`: Ristretto's `aastore` does not check the element type yet.
One run in about ten, `FilesIO` hung after its first line and was killed; not
seen again in the runs after it. In the pad, in Chromium: `java` on a compiled
class about 0.7 s. `Thread.getAllStackTraces` and the desktop do not work; there
is no `jshell`.

#### The fast javac

The package's `javac` interprets the JDK's compiler: about 6 s for a small file,
and a warm compiler in one VM was still 4.5 s. So the page compiles instead,
with javac compiled ahead of time to WebAssembly: 0.12 s for the same file in
the pad, `java Main.java` about 1 s with the run.

It is **teavm-javac** (github.com/konsoletyper/teavm-javac, Apache-2.0), which
compiles javac's own source with TeaVM to WebAssembly GC, built by
`build-java.mjs` with `pad/scripts/java/teavm-javac.patch`:

- javac's source is Corretto's, at the tag the class library is
  (`corretto-25` 25.0.4.10.1), not OpenJDK's jdk-25+36, so `javac -version`
  says what Corretto's says, and with a version bundle the JDK's build makes and
  teavm-javac did not have.
- It compiles against the real class library: `SdkBuilder.java` takes every
  class of the runtime's modules — less javac's own and zipfs — as its API,
  with constant values, signatures and annotations, and private members, which
  javac needs to say "has private access" rather than "cannot find symbol".
  1.8 MB. teavm-javac's own is TeaVM's class library, with gaps.
- TeaVM's class library parses and prints some numbers differently from the
  JDK — `4.9e-324` read as zero, so javac said "floating-point number too
  small" — and its WebAssembly traps on an integer division by zero, which
  javac folds in `int x = 10 / 0;` and expects to throw. TeaVM rewrites
  `Double`'s and `Float`'s parsing and printing to the JDK's own code, copied
  from the JDK in the build (`org.ajar.javac.jdkmath`), and constant folding's
  division, remainder and negation to `org.ajar.javac.Exact`. Found by, and
  checked with, the constants program in the fidelity set — they were found by
  Java Arena first (github.com/AntonyPerez0/Java-Arena).
- A command line, `PadJavac`: javac's own option table, help, errors and exit
  status over an in-memory folder (`MemoryFileManager`) that answers as javac's
  file manager does for -d, -cp, -sourcepath and a class or source found on the
  class path. `--help` prints the option list javac printed at build time,
  because javac sorts it with `java.text.Collator`, which TeaVM does not have.
  Annotation processing, plugins and doclint are not there; `--release` is 25
  only; `JDK_JAVAC_OPTIONS` is not read.

2.8 MB, 0.8 MB zstd, and the 1.8 MB class library; both load when Java arrives,
so they are ready by the first `javac`. How it is asked (`src/javac/`): while a
command runs, the page looks at `.ajar/javac/` every 40 ms. The sandbox's
`javac` writes everything javac would read — its folder, its arguments with
`@files` expanded, the sources they name, what is on the class and source
paths, `$CLASSPATH` — into one request; the page claims it with a file of its
own beside it, compiles it in a worker, and answers with what javac printed,
its exit status and the files it wrote, which the program in the sandbox then
writes, so they arrive as any program's files do. The page never renames or
removes the sandbox's files: a rename made from the page left the old name
listed in the sandbox, unreadable. The sandbox removes everything once it has
its answer. `java Main.java` sends the options the JDK's
source launcher gives javac, without `-implicit:none`, so classes from other
source files are compiled too, and loads the classes from the answer.

It needs WebAssembly GC and exception references — Chrome 137, Firefox 131,
Safari 18.4. Where it cannot load, the page says so once, writes no `ready`,
and `javac` compiles in the sandbox as before; checked by blocking its download.
A request the page has not claimed in two seconds, or one it could not
compile, is compiled in the sandbox too. 48 command lines compared with
HotSpot's javac below, identical in what they printed, their exit status and
every class file: 2 to 400 ms each, median 45 ms, under Node.

#### Checking it against HotSpot

`node pad/scripts/java-fidelity.mjs` runs the programs in
`pad/scripts/java/fidelity/run` on Corretto's HotSpot (podman, the pinned
image) and on the package as it ships (its atoms, extracted from the `.webc`
and run under Node's WASI), and compares what they printed. Then javac:
each of those programs, each program in `fidelity/errors` (which do not
compile), and the command lines in the script — help, a bad flag, -d with
packages, a class found on the class path, an error in a file compiled
implicitly, -Xlint, -Werror, -g, an `@file`, -Xmaxerrs, -XDrawDiagnostics — run
by HotSpot's javac and by the fast javac (`fast-javac.mjs`, as the page runs it),
or with `--javac sandbox` the package's own. A difference not in its `KNOWN`
list fails it. About four minutes; ten with `--javac both`.

On 15 October: 14 of 15 programs ran identically, the 15th the known one above;
the fast javac matched in all 48 javac cases; the package's own in 45. The other
three are one gap: its JDK has no `lib/ct.sym`, javac's signatures of every
release, which would be 10 MB for the slow javac alone — so it refuses
`--release 25` and its help lists no releases.

The licences: Ristretto and teavm-javac are Apache-2.0 (Ristretto also MIT);
the class library and javac are GPLv2 with the Classpath Exception, the class
library's notices in the package at `/usr/lib/jvm/java-25/legal`, the source of
both at github.com/corretto/corretto-25, tag 25.0.4.10.1.

## The shell, and detecting when a command ends

One shell per session. A sentinel is appended to the command **on the same
line**:

```ts
const quoted = `'${command.trimEnd().replaceAll("'", `'\\''`)}'`;
const line = `eval ${quoted} 2>&1; printf '\\001%s\\001' "$?"`;
```

The command goes through `eval` as one single-quoted word, so a `#`, an
unclosed quote or an unfinished `if` cannot swallow the sentinel; `eval` runs
in this shell, so `cd`, variables and a trailing `&` behave as typed. `2>&1`
puts errors in the same stream as the output and the sentinel, in order.

As a *second* line it gets eaten by anything reading stdin — which is how
`cat` with no arguments appeared to hang. `dropEcho()` searches for the echo
anywhere rather than at position 0, and `watchForExit()` uses `proc.wait()`
because the output stream stays open after bash dies.

## How a change travels

**Text in an open file** is a CRDT, straight between browsers on the doc
channel. The stream id is a hash of the path, so every browser agrees which
stream a file is on without being told. It is 32 bits, the frame's own, and
32 bits of hash collide — `file-1ezsubx.txt` and `file-6yp6oj.txt` share
one — so since 18 October each document message also names its path, after
the Yjs bytes: the path, its length in two bytes, then `0xFF` (`docPayload`
and `readDoc` in `peers.ts`). A page goes by the name, and drops a message
whose name is not on the stream it came on. A page from before reads Yjs's
encoding from the front and never reaches the name; a message from one names
nothing, and is taken for the file open on its stream, or dropped when two
are (audit DC-09).

**Everything else** goes through the store: a peer broadcasts only that
something *moved*, and everyone re-reads.

The re-read changes the editor and the file tree at once. It writes into the
sandbox only when the runtime is already up; until 2 October it waited for a
runtime still starting, so a browser still downloading one — a first visit,
for a while — showed nobody else's new or deleted files until it arrived. A
runtime that arrives late was seeded from an older snapshot, so before it is
ready `catchUp` writes in whatever changed since, looking again until a pass
finds nothing, and marks it ready in that same step. No command can run before
then, so nothing is written into a sandbox mid-command. `app-check.mjs` holds
one browser's packages back and deletes a file under it.

**Only the file on screen is bound to its document.** A file somebody else is
typing in, while this browser shows another, keeps the editor model it had
when it was last on screen; its document — and the sandbox, which each update
is written into — move on without it. So anything that writes a file into the
sandbox reads it with `App.current`: the document when it has state, the model
otherwise — or, for a file this browser has not needed a model of, its text
(since 18 October; see [Opening a pad of 500 files](#opening-a-pad-of-500-files)).
Run wrote models until 4 October, which put the older text back
into the sandbox, and the save after the run stored it over the newer — the
other person's last edit gone from the store until they typed again.
`accounts-check.mjs` has an editor press Run in one file while the owner types
in another.

**A typed line reads what the editor holds.** An edit reaches the sandbox when
its save comes round, a moment later; Run wrote the files first, a typed line
did not, so `javac Main.java` typed straight after an edit compiled the copy
from before it — found on 15 October, when javac began answering in
milliseconds from the page. `App.prepare` now writes edited files into the
sandbox before every typed line, through the same queue as the save after it.
`user-check.mjs` makes a Java file and compiles it at once.

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

Waiting for that answer left three ways to lose what the screen showed, all
found on 2 October and all in `app.ts`'s `readyDoc`, `attach` and `onDoc`:

- **The wait ended on any update.** A newcomer hears other people's traffic
  about a file before the answer to its own request — the diffs they swap
  whenever somebody joins, a keystroke — and an update it cannot use leaves
  the text empty. It bound that, and the open file went blank until the real
  answer came. The wait now ends only when the document `hasState`: some
  history, and nothing pending.
- **The first file was bound twice.** Opening a folder shows it from
  `setFile` and again from `start`, and the second call was handed the
  document while the first was still waiting for it. Every caller now shares
  one wait.
- **Binding replaces the editor's text with the document's.** The editor
  shows the stored copy meanwhile, so it can be typed into, and that typing
  went with it. `pad/src/carry.ts` merges it into the document's text and
  makes the difference one edit, made again after binding so it reaches
  everybody and is saved. Since 18 October the merge is three-way and hunk
  by hunk (`merge`): each side's change is cut into line hunks, a hunk goes
  in where it was made when the other side left those lines alone, and lines
  both sides changed are compared again by character. Where the two still
  overlap, the same change goes in once; otherwise the other side's text
  stays and what was typed follows it. Nothing of the base appears twice,
  nothing typed is lost, and nothing somebody else wrote is removed. Until
  then it was one span from the first difference to the last, so two edits
  far apart carried everything between them over somebody else's work
  (audit DC-06). A stretch too long to compare that has no line found once
  on each side can still, when both changed it, show base text twice.
- **Typing straight after New file went in twice** until 15 October: `abc`
  was `abcabc`. A new file is unsaved from the start, so the document was
  seeded from the model — typing and all — and binding then carried the same
  typing over from the empty file shown. The stored copy can hold some of it
  too, saved while the room was asked. So a document this browser seeded, and
  nothing has changed since, is carried over from itself — only what it lacks
  of the typing goes in (`App.seeds`) — and one from somebody else, from what
  was shown, as before. Compared without a leading byte-order mark: Monaco
  sets one aside when it makes a model, and the difference read as the mark
  deleted (`pair-check.mjs` caught it).

`app-check.mjs` slows one browser's relay by 400 ms, types the moment the
editor appears, and checks the file never blanks and the line stays where it
was typed.

And it no longer gives up after 600 ms. A newcomer whose room answered more
slowly seeded the stored copy beside a document that had moved on from it —
the second attempt above, two documents ignoring each other; in the check, the
newcomer's copy of a line the room had added came out twice. Now a browser
asked for a file it does not have open answers `DOC_NONE`, and the newcomer
seeds only once everyone present has said so or left; otherwise it waits, up
to five seconds, for whoever does have it. The check slows one browser's relay
by 1.5 s and compares the whole text on both sides — a check of each side's
lines alone passed against the 600 ms wait.

**A file past 24 MiB is not a live document** (`LIVE_MAX` in `app.ts`), since
11 October. A live document reaches somebody arriving as its whole state, in
one message, and the relay takes 32 MB a frame. Over that it does not close
the socket — it stops reading it, so everything that page sends afterwards,
for every file, goes nowhere, and neither side says so. Measured with a 40 MB
file open in two places: the second never saw a keystroke. Pads held at most
25 MB until 7 October, so no file could get there; at 60, and now 100, one
can. Such a file opens read-only, with a line saying why; a command changes
it, and the store carries the change to everyone, as it does a binary file's.
A file already live in a page that grows past the limit stays live there. And
`Peers.doc` sends no message over 30 MiB (`MAX_DOC_MESSAGE`): a newcomer asking
for one is answered `DOC_NONE` and takes the stored copy, and the page says
the file has grown too large to share live. `pair-check` opens a 25 MB file in
two places. Whether a file is past the limit is decided by its length when that
is enough, and otherwise by counting its bytes once, a line at a time:
encoding the whole text instead left every later switch back to a 20 MB file
18 ms slower ([pad-store.md](pad-store.md#old-against-new-11-october)).

**The seed's client id comes from its text** since 4 October, not a fixed 0.
Viewers made the fixed id dangerous. A viewer keeps a document but cannot hand
it on — the relay drops everything a viewer sends but `DOC_WANT` and
`DOC_NONE` — so when the editors who shared its history leave, the next editor
to arrive hears `DOC_NONE` from everyone and seeds again from the stored copy.
Under one id for every seed, that new document claims the same characters as
the viewer's old one, and the viewer applied the new editor's typing against
the wrong ones: garbled text, nothing pending, nothing to notice. With the id
made from the text (`seedId` in `editing.ts` — 64-bit FNV-1a folded to the
53 bits a number holds exactly, since 18 October; the 32-bit one gave two
different seeds one id within tens of thousands of texts, audit DC-09), the same text still
dedupes, and a different one shares no ids — the newcomer's edits wait in the
viewer's document as unplaceable, which `App.unstick` notices after 1.5 s: it
throws the document away and asks the room again. `accounts-check.mjs` plays
exactly that, typing at the start of the file, where the garble shows.

**A document holds what an editor can, line endings included,** since 9
October. A Monaco model has one line ending, and made from text with both
`\r\n` and `\n` it converts them all; the binding maps model offsets to the
document's one for one, so every edit after a converted line ending landed a
character off in the document. A paste over a CSV value left part of the old
value behind — `beta,2` pasted over became `beta12331322` — in what was saved
and in what every other place showed when it opened the file, while the
screen that pasted looked right. So `seed` converts the stored text as
Monaco would (`eolOf`, its own rule: CRLF when more than half the line breaks
carry a CR), every place converting the same text the same way, so seeds
still dedupe; `replace` puts a command's output in with the document's own
line ending; and `bind` gives the model the document's. A document mixed
anyway — made by a page from before this, or written in from elsewhere — is
mended when bound, or when a remote update leaves the model a different
length from it: to LF, by deleting carriage returns, because two places
mending at once each delete the same characters, where two inserting the
same CR would put in two. `check.ts` plays all of it with real editors.

**A command's work is what it changed,** since 9 October. After a command,
the page diffs the sandbox against the stored copy and publishes what moved;
for an open file it used to take the sandbox's text back into the document as
well. But the sandbox's copy of an open file is the page's own, written in as
the document moved — and a moment old. Taken back, it put that older text
over whatever somebody had typed since, in every place: a command run in one
browser while somebody typed in another lost them characters. `Runtime` now
records what the page last wrote to each file and waits for writes in flight
before the diff reads; an open file still holding what the page wrote is one
the command did not touch, and is left alone — the editors save it. One the
command did change takes only that change, rebased onto the live text by
`carryOver`. And the sandbox's text is decoded with `ignoreBOM`, or a file
with a byte-order mark read back without one and every command published it
so. `pair-check.mjs` plays both, two places at once.

Until 15 October that held only if nothing wrote the file between the
command's change and the diff, and something did: every keystroke from
another place, and every save of theirs re-read here, is written into this
sandbox as it arrives, so the next command runs what everyone has. Landing
in that window, it put the old text back over the command's change, which
then read as untouched and was lost for everyone — macOS CI hit it once. Now
`commandOut` is set from a command's start until the diff after it has read
the sandbox, and in that time `intoSandbox` writes somebody else's text only
over a file that still holds what the page last wrote. The rest waits for
the diff, which puts the command's change on the document; the document then
goes back into the sandbox. `pair-check.mjs` makes the window certain with a
command that sleeps after its change.

And the change was measured from the wrong text, until 16 October. A
collaborator's keystrokes still go into the sandbox while a command runs, as
long as the command has not changed the file, so the file a command reads is
not always the one the page wrote last: `sed -i` read `abcdef`, the page wrote
`abcdefg`, and sed wrote its change to `abcdef`. Measured from `abcdefg`, the
command had also deleted the `g` — one character lost on CI, and all of the
typing for a command that reads, waits, then writes. `Runtime` now keeps every
version it writes to each file while a command runs (`recordVersions`), and the
change is measured from the one the command's result differs from least: the
version it read. `pair-check.mjs` has a command that copies the file, sleeps
while the other place types, and writes its change to the copy.

**Two histories of one file are told apart, not merged,** since 9 October.
Seeding from the stored copy is safe only when nobody holds a live document,
and "nobody answered" is not the same thing: a place whose connection dropped
holds one and cannot say so. Back, its document and the newcomer's shared no
history, and the merge kept both — the file doubled. A document's own history
starts with one insert that has nothing to either side; an update carrying
such an insert from a client it has never seen, into a document with text,
is the other history (`DocSession.foreignRoot`). Both places see it, and the
one whose first insert has the smaller client id gives its document up and
rejoins (`App.rejoin`): it takes the room's, then replays what it typed since
the two parted — measured from its text when it lost the room, or from what
it seeded, whichever came later. That text is taken once, as the room is
lost (`App.inRoom`); until 18 October every failed retry took it again, with
the typing since in it, and a rejoin then saw nothing typed. And document
frames queued while the room is lost are not sent when it is back: the room
may have a history of its own by then, which cannot place them, and the
state exchange every join starts carries the same typing anyway (`Peers.lost`).
`pair-check.mjs` cuts a place's sockets the
way a sleeping laptop's are cut, types on both sides of the gap, and wants
one file with both people's work.

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
2. **The model**, where it has something, so unsaved edits run — or the
   file's text, for one the editor has not needed a model of, which reads the
   same way.
3. **The document**, where there is one, since it is what fills the model.

An empty model is taken only for a path the store has never heard of, which is
the one case where empty is the truth rather than a file that has not loaded.

It lives in its own module because the moment it runs is a race, and a race is
untestable from the outside: three separate attempts to catch the bug through
a driven browser all passed against the broken code. As a pure function it is
ordinary, and `src/check.ts` asserts it directly.

## Colours, and what they cost

Measured on 2 October in headless Chromium against the built pad, with the pad
API answered in-page. Open is navigation to first painted line; a keystroke is
an edit to the next frame; tokenizing is Monaco forced through the whole file —
the work it otherwise does in idle time.

| File | Open | Keystroke p50 / max | Whole-file tokenizing |
|---|---:|---:|---:|
| python, 100k lines, 5.2 MB | 2237 ms | 17 / 18 ms | 631 ms |
| the same as plain text | 2183 ms | 17 / 19 ms | 0 |
| python, 290k lines, 15.7 MB | 2387 ms | 17 / 38 ms | 1853 ms |
| the same as plain text | 2369 ms | 17 / 18 ms | 0 |
| csv, 100k rows, 9.5 MB | 2275 ms | 17 / 21 ms | — |
| the same as plain text | 2248 ms | 16 / 20 ms | 0 |

Colouring does not make a long file slow to open or to type in. Its cost is
CPU spent in idle frames. The CSV tokenizer on its own takes about 250 ms per
100k rows, timed in Node. Monaco stops tokenizing by itself at 20 MB or 300k
lines, so the pad adds no limit of its own. **Colours** in the editor header
switches it off for anyone who wants that anyway.

### Two people in one long file

Measured on 4 October with `pad/scripts/typing-perf.mjs`: two headless
Chromium pages on one pad through a real relay, the runtime up in both, one
typing 200 characters into the middle of `big.py`. Long tasks are the browser's
own (over 50 ms); lag is how late a 50 ms timer fires on that page.

| `big.py` | Typing | Typist: long tasks, lag p95 / max | Watcher: long tasks, lag p95 / max |
|---|---|---:|---:|
| 0.1 MB | steady, 20 a second | 0, 10 / 15 ms | 0, 2 / 3 ms |
| 4.8 MB | steady | 0, 18 / 33 ms | 0, 6 / 45 ms |
| 4.8 MB | bursts of 10, 0.7 s apart | **19 (3.1 s), 146 / 174 ms** | 0, 7 / 36 ms |
| 4.8 MB, saving after 2 s | bursts | 0, 14 / 42 ms | 0, 8 / 15 ms |

**The suspect was innocent.** Every remote update writes the whole file into
the watcher's sandbox (the `DOC_UPDATE` branch of `onDoc`), and the watcher
never had a long task, at 4.8 MB.

**The save was the cost.** A save sends the whole file: at 4.8 MB that was
80–165 ms of the typist's main thread — the request body, the timer's own
work, collection after — once per pause of half a second, which is most of
them. Live collaboration does not depend on it — the room carries every
keystroke as it is typed — so a file over 1 MB now saves 2 s after typing
stops rather than 0.5 s, and the long tasks went. Since 11 October a save of
a file over 16 KB sends only what changed — one edit, measured from the text
the page last stored and named by that text's hash — and the relay applies it
to exactly that version or answers 409, when the page sends the file whole
([pad-store.md](pad-store.md)). A keystroke's save in a 300 KB file is 165
bytes rather than 310 KB; the 2 s delay for a file over 1 MB stays, as hashing
the stored text is still the size of the file.

**Closing a tab inside the save delay used to lose that typing**, unless
someone else in the room saved the same file. The page now saves what is
waiting when it is hidden and when it goes; `keepalive` lets the browser
finish a request of up to 64 KB after the page has gone, so a bigger file
relies on the hidden moment, which comes first.

## Opening a pad of 500 files

An outside review of 17 October found that a pad of 500 files made 500
editor models as it opened, with Monaco's listener-leak warnings, and was
usable after 61 s. Measured on 18 October with `pad/scripts/open-perf.mjs`:
headless Chromium on this Mac, a local relay, 500 files in folders, and a
return visit, the page and the runtime cached. Two runs each, before and
after the change below. Editor is the first file on screen, ready the page
wired up, terminal a typed `find` answering with all 500 files. Slow is
Chromium's throttles — 20 Mbit/s with 80 ms of latency, the CPU four times
slower — with the pad's reads gzipped, as Caddy sends them.

| Pad | Link | Editor | Ready | Terminal | Longest task |
|---|---|---:|---:|---:|---:|
| 500 × 2.4 KB | local | 0.30 → 0.28 s | 0.38 → 0.35 s | 1.5 → 1.5 s | 0.15 → 0.15 s |
| 500 × 165 KB, 78 MB | local | 1.2–1.4 → 1.2 s | 1.3–1.5 → 1.3 s | 3.0–3.6 → 2.9–3.1 s | 0.31–0.33 → 0.25–0.26 s |
| 500 × 2.4 KB | slow | 0.61 → 0.50 s | 0.90 → 0.77 s | 8.3 → 8.1 s | 0.6 → 0.6 s |
| 500 × 165 KB, 78 MB | slow | 6.1–6.2 → 4.9–5.2 s | 6.4–6.6 → 5.2–5.6 s | 17.4–17.5 → 15.7–16.2 s | 1.23–1.29 → 0.82–0.97 s |

Models went from 500 to 1, the leak warnings from 4 to none, and the heap
after opening from 19 to 14 MB for the small pad and from 94 to 89 MB for
the large one.

**The models were not the 61 s,** and nothing here came near it. For the
small pad they were 25 ms. For 78 MB of text they were the largest part of
the page's own work — 1.0 s of `App.start`'s 1.25 s with the CPU slowed, in
one long task — and still less than the network: in the slow case most of
the wait is the pad's read, 4 s for 9 MB gzipped, and then the same read
again (below).

**A file has a model only once the editor needs it, since 18 October**
(`pad/src/texts.ts`). Saving, seeding the sandbox, Run, a move, a download
and the history read a file's text, from its model when it has one. A model
is made for the file shown (`App.show`), for one a run marks a problem in,
for `requirements.txt` when a typed `pip install` adds to it, and for a file
somebody else moved while typing in it here was not yet saved; once made,
it stays, with its undo, until the file goes. New text for a file without a
model is told as a change to a model is (`App.changed`), so it is saved and
marked as an edit to its model would have been. A command that makes 499
files, with another place watching, saved them and showed them there in
4 to 5 s before and after; each place ended with one model rather than 500.

**Text kept as text is kept exactly.** A model converts mixed line endings
to one and sets a byte-order mark aside, and until 18 October that converted
text was what the sandbox was given of every file nobody had opened — and
what the first command saved of it, for everyone. A CSV from Excel lost its
mark at the first Run anywhere in the pad. A file opened in the editor
takes the editor's line ending, as before
([above](#seeding-a-document-is-the-subtle-part)).

`user-check.mjs` opens a 500-file pad and finds one model and no warning, a
file opened from the tree given its model then, and a byte-order mark and
mixed line endings in files nobody opened in the sandbox byte for byte and
saved by no command. Against the code before, all four failed: 500 models,
4 warnings, and both files saved converted. `check.ts` holds `Texts` to the
same.

**Not changed: the room's welcome reads the whole pad again.** `onPresence`
calls `refresh` on every welcome — to catch a save made between the page's
read and its joining the room — and whenever anyone joins or leaves. For
the 78 MB pad on the slow link the welcome's is a second 9 MB, finished 7 s
after the editor is up, and the terminal waits behind it: 14.8 s without
that read, on the code before, against 17.4 s. Knowing that nothing moved
needs the relay to say the pad's sequence in the welcome, or to answer a
read with "unchanged".

## The download

Wasmer's CDN sends `.webc` with no content encoding at all: **66.5 MB raw**
for the ten files the runtime fetches, after trimming — 84 MB as published.
From this origin, pre-compressed with zstd, the set is **15.1 MB**, and an immutable
cache header makes any later visit free. (An earlier figure here, 124 MB, was
`du` over a directory that also holds the `.zst` and `.gz` copies.)

It is a service worker because the SDK has no registry override and does its
downloads inside workers with their own globals, where patching `fetch` would
not reach. SDK 0.11 can now load a package from bytes — `packages.load(bytes)`
used to fail with `FeatureNotEnabled { "authoring" }` — and was measured doing
so on 25 September, but the worker still covers everything the registry path
fetches without the page having to.

### What is in it, and what is trimmed

Python is 48 MB of the 66.5 once trimmed, and 61.7 MB as published. Unpacked on
25 September, the published package is:

| | raw | zstd | |
|---|---|---|---|
| `python.wasm` | 18.1 MB | 4.6 MB | the interpreter, with every C library a module might use linked in |
| stdlib `.pyc` | 10.2 MB | 3.0 MB | the same modules again, precompiled |
| stdlib `.py` | 9.7 MB | 1.7 MB | |
| pip | 5.7 MB | 1.2 MB | installed, so `pip install` works |
| `ensurepip` | 1.8 MB | 1.7 MB | **trimmed** — a second pip, as a wheel, which barely compresses |
| IDLE, tkinter, turtle | 3.2 MB | 0.8 MB | **trimmed** — they need Tcl/Tk, which this runtime does not have |
| terminfo | 6.8 MB | 0.5 MB | **trimmed** — two identical copies of 2,899 terminal types; one copy, fourteen types remain |
| tzdata, `help()` text | 3.9 MB | 0.3 MB | kept — usable, if rarely |

The interpreter's 12 MB of code is roughly a third CPython, a fifth OpenSSL —
all of it, post-quantum and legacy ciphers included — a sixth SQLite with
full-text search, R-trees and sessions, a seventh libc, and a C++ standard
library. That is what a static WASIX build of a general-purpose CPython costs;
shrinking it would mean building one here, which is not worth it yet.

The trimming is `pad/scripts/webc-trim`, run by `fetch-packages.mjs` with the
rules written out in that script. It keeps the manifest and every atom byte
for byte and rewrites only the filesystem, and a trimmed package is named with
the rules' hash so a changed rule is a new URL. The SDK checks a package
against the registry's hash — the strings `image hash mismatch` and
`FailOnHashMismatch` are in it — but as shipped it runs a mirrored package whose
bytes differ. `app-check.mjs` goes through the mirror and presses Run, so an
SDK that stopped accepting one would fail there before it reached anybody.

### The registry's answers

The bytes were never all of it. On every start the runtime asks
`registry.wasmer.io` where each package is — ten lookups, one after another,
about three seconds of a cold Run — and when one failed, as it did from one
network in three local runs of eight on 2 October, the terminal said so and Run
never answered. Since 12 October `fetch-packages.mjs` records the answers the
page received into `packages/registry.json` (59 KB, coreutils already pinned),
and the service worker answers each lookup from it; a package it has no answer
for still asks the registry. `--registry-only` records them again through the
mirror already on disk, without the downloads. `app-check` runs a browser that
cannot resolve `registry.wasmer.io` at all, not one with a route — a route does
not see what a service worker fetches — and presses Run; with the worker
asking the registry instead, that check fails. `deploy.sh` refuses to ship
without the file.

The two lists, `manifest.json` and `registry.json`, are not cached as
immutable with the packages: they change when a package does, and a returning
browser holding a year-old list was pointed at files a later deploy removed.
They revalidate each visit (`deploy/caddy/check.sh` asserts both headers).

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

## Zips, in and out

`pad/src/zip.ts`, about 300 lines and no library: the browser's own
`CompressionStream("deflate-raw")` does the deflating both ways, and the rest
is the format's headers and a CRC. Names are written with the UTF-8 flag
(0x0800) and read as UTF-8 when it is set, CP437 when not, which is what old
Windows zips use.

**Reading checks before it inflates.** The central directory says how many
entries and how many bytes they unpack to; over the pad's 500 files or 100 MB is
refused there, before any inflating. A zip can lie about those sizes — the
classic zip bomb — so the inflated bytes are counted again as they come, and
each entry's size and CRC must match what the directory claimed. Encrypted
entries, methods other than stored and deflate, and ZIP64 are refused with a
reason rather than read wrongly.

**What a zip becomes** is `prepareImport`'s decision, kept apart from reading
so it can be checked on its own:

- Junk out: `__MACOSX/`, `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`, and
  what `sync.ts` already never publishes (`__pycache__`, `.git`,
  `node_modules`).
- One wrapping folder off: when every entry is under the same top folder.
  GitHub's Download ZIP and macOS's Compress both wrap a project that way. The
  whole-pad download wraps in `<name>/` for the same reason, so a pad's own zip
  round-trips whatever its layout. A downloaded *folder* is not restored as
  that folder: `src.zip` holds `src/…` alone, which unwraps.
- The relay's path rule (`pad::check_path`), byte length included, applied
  before sending, so nothing is written that the store would refuse half-way.
- Text as text, everything else as base64: strict UTF-8 with no NUL byte is
  text (`textOf`, the same rule a command's files are sorted by — see
  [binary files](#binary-files)). Binary files used to be left out here.

**Importing into an open pad** is one store write, in `queueWrite` behind any
save, then each file applied the way a peer's change would be: through the
editor if the file is open (so its live document carries it to everyone),
through `replace` on a document that is open but not bound, otherwise to the
model, and in every case to the sandbox. A file that would change is asked
about first, in one dialog for all of them. An untouched starter — a new pad's
`main.py`, unsaved and unchanged — is removed rather than left beside the zip.

**From the dashboard**, Import a zip reads and checks the zip first, then makes
the pad and writes into it; a write that fails deletes the pad it just made.

## Binary files

The store has always had two encodings, `utf8` and `base64`; until 5 October
only text reached it from the page. After a command, `diff` read every file
with `readText`, which does not refuse a binary — it replaces what is not
UTF-8 — so an image or a zip made in the terminal was published as garbled
text, and everyone else's tree, sandbox and download got the garbled copy.

Now `diff` reads bytes (`readBytes`) and sorts them with `textOf`: strict
UTF-8 with no NUL is text, anything else goes as base64. The page keeps two
maps of what the store holds — `known` for text, `binaries` for the rest — and
a file that changes kind is one change, not a removal and an addition.
Binary files travel everywhere text does, except into the editor:

- **The sandbox**: seeded with them as bytes when it starts, caught up with
  any that change while it loads, and written with `writeBytes` when another
  browser's change arrives.
- **The tree**: listed in italics; clicking one says it is not text and how
  big it is. They download, move and delete like any file. A viewer's binary
  files stay in their own sandbox, and a viewer cannot delete the pad's.
- **Zips**: imported as they are, and in every download.

The cost is reading each binary file's bytes and encoding them as base64 after
every command — the diff already read every file as text, and a pad is capped
at 100 MB; base64 makes a binary file a third larger against that cap.

## numpy, pandas and matplotlib

From 16 October they install with pip, from Wasmer's own builds. The pad's
Python, `python/python@=3.13.20`, loads native modules: it is built as a
dynamically linked main module, and dlopens a `.cpython-313-wasm32-wasi.so`.
PyPI has no wheels for it. Wasmer keeps an index of them at
`python-registry.wasmer.app`, with numpy, pandas, matplotlib, pillow,
contourpy and kiwisolver among them, tagged `cp313-cp313-wasix_wasm32`.
Three things make `pip install numpy` reach it:

- **The index, beside PyPI:** `PIP_EXTRA_INDEX_URL` in the shell
  (`WHEELS` in shell.ts). The egress endpoint allows its host
  (deploy/wisp-server.mjs).
- **The platform, named:** this interpreter calls itself
  `wasi_0_0_0_wasm32`, so pip passed over the wheels and spent two minutes
  failing to compile numpy's source. `PIP_PLATFORM=wasix_wasm32` fixes that.
  pip then insists on `PIP_ONLY_BINARY=:all:`, so a package published only as
  source no longer installs. Teaching pip's tag list the extra platform was
  tried first, and pip still took the source.
- **An SDK that can load them:** see below.

Measured in the browser, with the CPU free:

| | Install | Import |
|---|---|---|
| numpy, a 5.4 MB wheel | 6.5 s | 0.4 s |
| pandas | 10 s | 1.5 s |
| matplotlib, and what it pulls in | 20–40 s | — |

A plot saved with matplotlib takes about a second.

**Why the SDK is 0.18.0.** Each version had something the pad could not ship:
- **0.11.0** loaded numpy and pandas, but not two of matplotlib's C++ modules
  in one process: `table index is out of bounds`, from importing
  `matplotlib._path` and `matplotlib.ft2font` together, and the SDK's worker
  died.
- **0.19.0 and 0.19.1** load all of matplotlib, but Ctrl-C no longer stops a
  loop that makes no system calls: `while True: pass` ran on until the pad
  ended the shell, cwd and variables lost.
- **0.16.0 and 0.18.0** stop that loop in 5 ms, and 0.18.0 draws and saves a
  plot.

So it is 0.18.0, until a later version has both. The same upgrade changed
`box.fs`: it takes the process's own paths now, only inside `/workspace`.
`at()` in runtime.ts makes them, and the fetch and javac bridges name
`/workspace/.ajar/…`.

**Plots.** `MPLBACKEND=Agg`, so drawing never looks for a window, and
`MPLCONFIGDIR` in `.deps`, so the font cache is built once per sandbox. `plt.show()` is replaced (tools/sitecustomize.py): each figure is
saved as `figure-<n>.png` where the program ran, and the program prints
`ESC ] 7777 ; pad-image=<path> BEL`, a number no terminal standard uses. The
terminal takes that escape off the screen (`registerOscHandler`, terminals.ts)
and the app shows the image in place of the editor, read from the sandbox
because the pad's own copy arrives only after the command. Any image file
opened from the tree shows the same way (`images.ts`). They go in as `data:`
URLs, since the CSP allows no other source for images.

**requirements.txt** is installed before the first thing that runs Python,
and again when it changes: `App.installRequirements`. pip resolves a file at
once, so when it fails each line is tried on its own and only the ones that
failed are named; a failure is never recorded as installed. A typed
`pip install` that worked adds its packages to the file
(`App.recordInstalled`, `requirements.ts`), since `.deps` is not saved — so the
file is how the packages reach the next person, whose sandbox installs them.

**What a pad cannot keep** is said, not refused with everything else.
`App.publish` checks a command's files against the relay's rules first
(`unstorable`, the 500-file cap) and leaves those out, naming them in the
status line and above the prompt; a batch the relay refuses anyway is sent
again one file at a time. Until 18 October one file with a backslash in its
name, or the 1,336 of numpy, stopped every later command's files from saving:
refused, never remembered, sent again and refused again. The files left out
stay out of `known`, so a later command offers them again.

## Where a file was left

`show` keeps each file's view state — `saveViewState` on the way out,
`restoreViewState` on the way back — so a file opens where it was left. Until
6 October it opened at line 1 every time.

Keeping the view is not enough if the text is then replaced under it: a file
changed while somebody looked elsewhere was brought up to date with
`setValue`, which throws the view and the cursor away. Two places did that —
binding a document to its model, and `setFile` — and both now replace only
the stretch that differs (`replaceText` in `editing.ts`: the longest common
start and end kept, the middle edited), which moves the view only as far as
the text before it changed. `DocSession.replace` does the same for a
document, so a change made that way reaches everyone with the file open as an
edit, not as a new file that sends them to its top.

Fixing this found a bug of the room's. A command's change to a file this page
had a live document for, but was not showing, went into the model and the
store and not into the document — so not to anybody in the room with it on
screen, whose next save could put the old text back, and not to this page
either: showing the file again bound it to the stale document, which put the
old text back here. `publish` now sends it into the document too, as an
import does.

## Back, and the back-forward cache

A browser keeps a page it leaves in its back-forward cache, frozen as it is,
and shows it again on Back. The pad used to tear itself down on `pagehide` —
editor, terminal, documents and room disposed, every listener aborted — which
is right for a page leaving for good and wrong for one going into the cache:
Back from Your pads brought back the file list over an empty editor that
answered nothing. Until 6 October; no check saw it, because Playwright launches
Chromium with `--disable-back-forward-cache`.

`bootstrap.ts` now tears down only when `pagehide` says the page is not being
kept (`persisted` false). On `pageshow` with `persisted`, `App.resume` puts
back what the world changed while the page was frozen: the room gets a fresh
socket — the old one was closed by the browser, though Chrome still calls it
`OPEN` when `pageshow` runs, and a browser that never delivers that close
would leave the room dead — and the pad is read again, which also says who
this browser is to it now (signed in or out on Your pads meanwhile). Anything
an action left busy as it navigated away — New pad, Save as my copy, Copy a
pad's dialog — is freed, on the pad and on the dashboard, or it would ignore
every click after Back.

## Empty files and folders

The store keeps paths and their contents, nothing else, so a folder exists
only while a path implies it. Until 6 October that meant three losses: an
empty file made with New file was never saved, since nothing in it had
changed; a folder made with New folder lived only in the tab that made it;
and an empty folder made with `mkdir` was invisible to the diff, which listed
files. New folder also wrote a `.keep` into the sandbox, which the next
command then published as a file in everyone's tree.

Now an empty folder is kept by a **marker**: an empty `.keep` inside it, the
git convention (`MARKER` in `sync.ts`). The tree draws the folder and never
the marker. New file saves at once; New folder stores its marker at once; and
`diff` lists empty directories (`Runtime.list(dir, true)`) and reports each as
its marker — a sandbox may hold the marker as a real file, or only as the
empty directory, and the diff says the same either way.

Folders have to go as well as come. A removal that arrives from another
browser goes through `removeAndPrune`, which also removes the folders it leaves
empty: left behind, this page's next command would publish them back — an
empty folder somebody moved elsewhere reappearing where it was. A folder
moved or deleted here goes whole (`removeTree`). Deleting a file from the
tree prunes the same way, so the folder goes from the sandbox as it goes from
the tree. Folders now have a delete button too; without one, an empty folder
the pad kept could be removed only from the terminal.

Markers travel like files otherwise: in moves, in Save as my copy and Copy a
pad, and in every download, so an empty folder survives a zip and coming back.
A zip from elsewhere that lists an empty directory brings it in kept by a
marker; one that lists every directory, as most do, gets markers only for the
empty ones.

## Moving files

Drag and drop in the tree (`files.ts`), and F2 with a new name for the
keyboard; both end in `App.move`. A move is **one store write** holding the
new paths and `null` for the old ones, so nobody can read the pad between the
two and see the file in both places or in neither. Then this page catches up
the way an import does — the new paths' models, the editor following the open
file, the old documents closed and their models disposed, the sandbox written
if it is up — and the `moved` nudge sends everyone else to re-read, where the
old path goes and the new one arrives like any other change. It never waits
for the sandbox, so a move on a first visit is immediate.

The text that moves is `current(path)` — the live document when there is one —
so typing not yet saved goes along. A folder's binary files, which only the
store holds, go in the same write. Dragged onto a file that exists, it asks
first; a folder into itself, or a file onto a folder's name, is refused in
words. Renamed with F2, a name that is taken is refused under the name
instead: a rename that replaced a file would do it by a typo.

The tree is not redrawn while a drag is under way: the row being dragged has to
outlive it, so a collapsed folder does not open on hover as it would in an
editor — drop on it, and it opens after. Two things a move does not do for
someone else on the pad: a person who had the old file open is moved to
another file rather than following it, and typing they did in the old file in
the moment between the move and their re-read is lost with it.

## Naming in the tree

New file, New folder and F2 type the name into the tree, where the thing will
be, as an editor's explorer does; they were `prompt()`s, which asked for a
whole path and said nothing of where that was. The row is an input in a row
like the others (`FileTree.startNaming`): a new file's goes first among the
files of its folder, a folder's first among the folders, a rename's in place
of the row, its name selected up to the extension.

- **Where it goes** is the folder clicked last, as in VS Code, or beside the
  open file when a file was clicked since; the space under the rows is the
  top. That folder opens, so the row can be seen.
- **The name is the path within that folder**; a `/` makes the folders on the
  way, and a leading `/` is from the top — the keyboard's way to move a file
  up, which a name within its folder cannot. `pathFor` and `nameProblem` in
  `files.ts`, checked in `check.ts`.
- **What is wrong is said under it as it is typed**, and Enter does nothing
  until it is put right; Escape, or an empty name, makes nothing.
- **Clicking elsewhere keeps a name that will do**, and drops one that will
  not. Not until the click is over: the tree is redrawn from scratch whenever
  anything changes, and redrawn on the blur, the row being clicked was gone
  before its click, which then went nowhere. A file made that way is not
  opened either: what was clicked is what was wanted.
- **The tree is redrawn under it all the time** — a save, someone else's
  change, a command — so the same input goes into each new tree, with its
  caret, and its focus if it had it. A row whose folder somebody moved or
  deleted meanwhile ends the naming.

## Starters

An empty file of a kind the pad knows offers what it could start as, on its
first line: a Monaco content widget (`App.paintStarter`), a link and "or start
typing", gone with the first character. Taking it is an ordinary edit, so it
is undone by one undo and reaches everyone as typing does. `starters.ts`
writes them with a tab per level and gives them the editor's indent; each
prints the same two things, so one that runs is easy to tell. Java's class
is named after the file when the name can be a class's, and otherwise is a
`class Main` that is not public, which `javac` and `java File.java` both take.
C++'s uses `<cstdio>`, since `<iostream>` does not finish compiling here. Each
runnable one is run by `PAD_LANGUAGES=1 user-check.mjs`; Python's by every
run.

## Format

Monaco's formatters live in its language workers, which cannot start here, so
the editor had none. `format.ts` maps an extension to a formatter compiled to
WebAssembly, each fetched the first time a file of its kind is formatted — by
dynamic `import()` of its Vite entry, whose `.wasm` Vite emits under
`/assets`, so a page that never formats fetches none of them:

| Files | Formatter | npm | wasm |
|---|---|---|---|
| `.py` `.pyi` | Ruff | `@wasm-fmt/ruff_fmt` | 1.2 MB |
| C, C++, Java, C#, `.proto` | clang-format | `@wasm-fmt/clang-format` | 2.6 MB |
| `.go` | gofmt | `@wasm-fmt/gofmt` | 0.27 MB |
| JS, TS, JSX, CSS, SCSS, Less, HTML, Vue, Svelte, GraphQL | Biome, malva, markup_fmt | `@wasm-fmt/web_fmt` | 3.4 MB |
| `.json` | VS Code's own, jsonc-parser | `jsonc-parser` | — |
| `.sql` | sqlformat | `@wasm-fmt/sql_fmt` | 0.24 MB |
| `.yaml` | pretty_yaml | `@wasm-fmt/yamlfmt` | 0.30 MB |
| `.toml` | Taplo | `@wasm-fmt/taplo_fmt` | 0.34 MB |
| `.md` | dprint | `@wasm-fmt/markdown` | 0.52 MB |
| `.sh` `.bash` | shfmt | `@wasm-fmt/shfmt` | 0.40 MB |
| `.php` | Mago | `@wasm-fmt/mago_fmt` | 1.3 MB |
| `.lua` | StyLua | `@wasm-fmt/lua_fmt` | 0.59 MB |

All MIT, pinned exactly. JSON is not Biome's: it keeps an object that fits on
a line on one line, so minified JSON stayed minified, where jsonc-parser
expands it as VS Code does and writes every number as it was written. Java is
Google's style and C and C++ LLVM's, with the indent set here.

The result goes in as one edit of only what changed (`carryOver` against
itself), so one undo takes it back and somebody typing further down is not
replaced under. Text typed while a formatter loads is not formatted over; the
status says to format again. A formatter's complaint is said by line: Ruff and
Mago give a byte offset, which `problemOf` turns into one.

The indent is the browser's (`pad.indent` in local storage), 4 unless set to
2, and every model is given it rather than one Monaco guesses from the file,
so Tab, Format and a starter agree. Go and Makefiles take tabs whatever it is.
Format and Spaces sit beside Colours, quiet as it is; Format only where
something formats the file. Format Document and Insert Starter Code are also
Monaco actions, so they have Shift-Alt-F, the right-click menu and F1.

## What it does not do

- **An anonymous pad has no locks.** Deliberate — the trade for a clean
  shareable URL. A pad owned by an account has roles — owner, editor, viewer —
  through its view and edit links; see [accounts.md](accounts.md). **Neither
  kind is encrypted:** the server can read every pad. See
  [security.md](security.md#what-the-pad-does-not-have).
- **A socket reaches PyPI and nowhere else.** `pip install` works, through
  an endpoint we run that allows those two hostnames on 443 and refuses the
  rest. `curl`, `wget`, `urllib` and `requests` go through the page's fetch
  instead, to sites that let a web page read them. No `git clone`, no `ssh`,
  no reaching your own machines. See [networking.md](networking.md).
- **A process that never exits never syncs.** The folder is published at
  command exit, which is a real transaction boundary — it either ran or it did
  not, and a half-written file is never shared. Fine for paste-run-look; wrong
  for a dev server.
- **No `make`, `ssh`, `vim` or `less`.** `ssh` is impossible rather than
  unbuilt. `curl` is the page's (above), not curl's. `make` is possible now that spawning works
  and is simply not written. `nano` exists; `vim` does not.

## Saving when it goes wrong (audit of 17 October)

- **A 409** — a save of edits against a version the store no longer holds —
  reads the store's version and merges this page's change onto it
  (`App.writeOverStale`, `carryOver`), never sends the whole file over it,
  which lost the newer version while saying "saved" (DC-03).
- **A 413 or 507** keeps the files unsaved (`dirty`) without retrying on its
  own — the next edit tries again (DC-04).
- **While saving fails**, the unsaved text and the stored text it was typed
  over are kept in `localStorage` (`App.journal`, `pad.unsaved.<name>`),
  cleared as each file saves, and merged back on the next visit
  (`App.recoverJournal`); leaving asks first while there is any (DC-05).
- **A response body** is under the same deadline as its headers, as an idle
  time, not a total (`request` in store.ts, DC-07).
- **A zip import** joins the live documents of files it replaces that another
  place has open, so the import is in their editor, not undone by their next
  keystroke (DC-01). **A move** never deletes a path another file of the same
  move arrives at (DC-02). **A zip** is inflated under a running limit and
  stopped at the entry's declared size (DC-08).
- **A failed start of the runtime** is forgotten, so the next Run tries again
  (R6); **a file that cannot be read** is kept as stored, not published as
  deleted (R8).

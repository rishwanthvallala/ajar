# The gate, and how checks lie

```sh
./scripts/check.sh      # everything, in order
```

`AJAR_SKIP_UI=1` skips the browser suite. It is the only skip, it is opt-in,
and it changes the summary: the script never prints `all green` unless every
check ran. A missing browser is otherwise **fatal everywhere** — a gate that
quietly downgrades itself on the machine where someone is about to commit is
worse than no gate, because it still reports success.

CI runs the same script on every push to `main` and every pull request, on
`ubuntu-latest` and `macos-latest` (`.github/workflows/ci.yml`). It installs
Playwright's Chromium first, so the UI suites cannot skip there, and gives the
Mac runner a `~/.viminfo`, as a real Mac has — without one, vim failing to
quit inside the sandbox stayed hidden. On a failure the end of the log becomes
an annotation, which anyone can read through the API where the log needs a
sign-in. Ubuntu then runs `scripts/linux-sandbox.sh`, and builds Caddy for
both architectures and checks its rate limits (`deploy/caddy/check.sh`).

A second job, `first-run`, is someone else's first install, on both
runners: the agent built as it is released, then `scripts/check-first-run.sh`
— on Ubuntu, the static binary in twelve distributions' containers and the
installer as a new user meets it; on both, the installer into a throwaway
home, its PATH advice followed. Every other check runs on the machine that
built the binary, with a PATH somebody already set up, which is how the
release ran on three distributions of fifteen and nobody's tests noticed.

## What each suite proves

| | |
|---|---|
| `cargo test` | Frame codec, guardrails, ring buffer, ids, backoff, session lifecycle, ignore rules, scanning, patches, panel keys, process accounting, the reconciler, secret detection, checkpoints, sandbox escapes, sealing, the store, quotas, guest limits, durable pads, peer sessions, accounts — roles, links, quotas, sealing, deletion — and sign-in's PKCE and cookie state; and a disk change merged with typing not yet written, which files the editor may edit, a terminal's input never blocking the agent, a folder renamed or moved in, the host's key and its stale socket, a locked session taking back its own guests and nobody kicked, download zips, and the panel drawn at 80×24 |
| `npm run typecheck` / `build` | Both browser builds |
| `pad/scripts/browser-check.mjs` | Drives `pad/src/check.ts` in headless Chromium — the runtime, the shell, every python shim against its real tool, the sandbox seed, the CSV tokenizer, the zip reader and writer and what an imported zip becomes, what a pasted pad link names, a zip's empty directories kept by markers, the diff sending a command's binary file as its exact bytes and a file that changes kind as one change, typing carried over while a document arrives, the sync diff, the store over real HTTP, and that the WISP transport loads. It cannot be a node test: the python package fails wasm validation there, and `SharedArrayBuffer` needs cross-origin isolation. Packages come through the mirror's service worker, as for a visitor; fetched from Wasmer's CDN instead, python's 62 MB stalled for minutes from one network and the check hung at the runtime's start |
| `pad/scripts/terminal-check.mjs` | The pad's terminal by real key presses, judged by what is on screen: history, Tab completion, Ctrl-R, the editing keys, clearing, a multi-line paste, a line longer than the terminal, Ctrl-C, and that errors reach the screen at all. The line editor is the page's own, so nothing else tests it. `PAD_ORIGIN` runs it against a deployment; the old editor failed 33 of its checks. In the gate |
| `pad/scripts/user-check.mjs` | The pad as a person uses it: mistakes and their tracebacks, `input()`, Ctrl-C on a loop and on `input()`, Ctrl-D, the Stop button, `nano`, output without a final newline, Run after a `cd`, New file, threads, Ctrl-S, colours by language and Ctrl-F, a long file opening where it was left — after a switch, after a command changed it meanwhile or while on screen, and after a move — deleting from the tree, and zips in and out — upload, a zip dropped on the file list, asking before replacing a changed file, junk and binaries left out, a pad's own zip round-tripping — empty folders too — and downloads read back by Python's `zipfile`; a binary file a command makes — listed as one, sent as its bytes, downloaded byte for byte, a zip made in the terminal that opens, and moved like any file; and moving in the tree — a file dragged into a folder in one store write, beside a file, a folder with the open file following it, never into itself, F2's typed path, asking before replacing, and unsaved typing going along. `PAD_ORIGIN` adds a real `pip install requests`. Against the code before 28 September it failed at the first check. In the gate |
| dockerfile check | Every `COPY` source exists — the cheap half of `docker build` |
| `scripts/test-ui.cjs` | Runs both layout checks below, then boots each app and requires no page errors, then opens the built pad's editor: languages, the CSV tokenizer fetched only once a CSV opens, Colours, and the theme reaching Monaco and surviving a reload |
| `scripts/check-workspace-layout.cjs` | The session client: editor lifecycle, pointer and keyboard resize, four viewport sizes, drawer focus, preferences, the theme toggle, preview isolation, lazy loading, disposal, read-only refusing typing and reopening the file from the host's copy when it flips, a cursor id that cannot write the stylesheet — and that a guest meeting a host on another protocol is told so instead of getting a dead session. Its stand-in host seals every content frame with a key it puts in the link, as an agent does: since 7 October a page with no key stops at "This link is incomplete" |
| `scripts/check-pad-layout.cjs` | The pad against the same shared shell: resize, four viewports, drawer focus, status fixtures, the theme toggle, Colours hidden over a server preview, and that pad preferences and network state stay isolated from the session client's |
| `scripts/smoke.mjs` | relay + agent + a guest that runs a real command, sees replay, round-trips presence; the sandbox posture printed before the link; a paste into a terminal whose program is not reading holds up only that terminal; a session that does not exist is refused in words; and ctrl-c still ends the agent with the paste stuck |
| `scripts/smoke-workspace.mjs` | Ignore rules, reads, path-traversal refusal, what the tree hides refused when asked for by name — a gitignored file, a dependency's, `.git/config` — patches, a folder renamed or moved in arriving with its contents and the old name gone, and an install-sized burst |
| `scripts/smoke-editing.mjs` | Two people editing one file while the terminal rewrites it; typing not yet written surviving appends made on disk meanwhile, each once; an open file deleted underneath closing for its readers with the reason, said once in the host's log; Latin-1 and mixed line endings refused for editing, as a binary file is |
| `scripts/smoke-control.mjs` | The host's controls as the agent and relay enforce them: a read-only session refuses a guest a terminal, saying why, and drops their file edits at the host; a locked session refuses newcomers and keeps those already in — through a blip too, by the secret each tab sends — refuses a stranger with a secret of their own and a kicked guest with their old one, and opens again on unlock; a guest's control frames never reach the host; a stored copy over 8 MB arrives whole; a socket that never says hello is closed |
| `scripts/smoke-environment.mjs` | Credentials in the host's environment do not reach a guest's shell, and the socket warning matches what a guest can actually reach |
| `scripts/smoke-encryption.mjs` | Wiretaps the wire and requires nothing readable crosses it |
| `scripts/smoke-sync.mjs` | Kills the host mid-session; the guest can still read the folder |
| `scripts/smoke-reconnect.mjs` | Kills the relay mid-session; the agent returns to the same link |
| `scripts/smoke-hostdrop.mjs` | Cuts only the host's socket, through a proxy, and requires everything from the gap back: typing, disk changes, new files, joins and leaves; a guest claiming the away host's place refused; the agent taking its place back from its own stale socket with its key, without guests being told the host left, and anyone else still refused; twenty-five resumes not counted as twenty-five new sessions |
| `scripts/check-terminal.mjs` | A guest's terminal by real key presses, through the relay to a real bash on the host: history, the editing keys, Tab, Ctrl-R, clearing, Ctrl-C, a paste, the python REPL, unicode, and less, vi, nano and top drawing and quitting. The host's shell is pinned — prompt, inputrc, locale — so what is tested is the path, not the machine's bash. `AJAR_RELAY` and `AGENT` run it against a deployment. With the client dropping one byte, ESC, twelve of its thirty fail — needs `npm run build:ajar` |
| `scripts/check-host-drop.mjs` | The same blip in the real browser client, typing into Monaco; and that a guest arriving to no terminals is given exactly one — needs `npm run build:ajar` |
| `scripts/check-guest.mjs` | The guest's page through what goes wrong around it — `web/dist`, served by a real relay, with a real agent; each item was found broken by a browser in the review of 7 October while the wire-level suites passed. Links with the key cut short, missing or someone else's, each saying so; the people here as a list, "(you)" and "(host)" in words and a dot in each cursor's colour; an empty folder marked; the file tree by keyboard and F6 out of a terminal; a click on a file surviving a file arriving between press and release; Download all on a fresh page and from the tree, a zip over a megabyte that passes `unzip -t` and leaves out what the ignore rules hide, and the open file as itself; binary, mixed-ending and BOM files opening read-only; the place in a file kept across a switch and across the guest's own connection cut, the next keystroke landing there; another guest's cursor and smaller terminal, both gone when they leave; the terminal limit said in words; a terminal that ended while the guest was cut off gone from their tabs too; the host away — the status, the countdown, the leave prompt only while typing is unsent, someone arriving told, a file opened meanwhile labelled, the typing reaching disk once the host is back; a host whose machine is asleep (the agent stopped with `SIGSTOP`) waited for; the relay restarted before the agent is back; an open file deleted on the host; Back out of the back/forward cache, in a second Chromium launched with the cache on, which Playwright turns off. Then the agent as a person runs it, in a pseudo-terminal (`scripts/lib/ptyrun.py`), its keys pressed: `l` on and off while a guest 250 ms away is typing, and that guest's keystrokes dropped at the host; `x`, the locked session taking its guests back through a relay restart and still turning away someone new; `k` and a guest's number, the guest told and not let back in by reloading; `q`. Nothing else presses the panel's keys. Needs `npm run build:ajar` and `cargo build` |
| `scripts/smoke-peer.mjs` | Peer sessions — the only suite that starts a relay and no agent |
| `scripts/smoke-accounts.mjs` | Accounts at the relay, against a stand-in OAuth provider that checks PKCE: sign-in, the cookie's flags, a replayed callback, an off-site return address; then the store and the peer room as a stranger, a viewer, an editor and the owner — a viewer's edit dropped and its `DOC_NONE` passed, every setting, revoking, eviction of people already inside, both quotas, deletion, a restart, and no token or code in the database in the clear; the admin figures for the operator and a 404 for anyone else; signing out ending that sign-in's owner connections in the room and only those; deleting an account; and a relay with no provider set up. Each enforcement point was reverted and the suite failed |
| `pad/scripts/pair-check.mjs` | Two places in one pad, one file open in both, compared — what each editor shows and what each document holds — after each thing a person does: a value pasted over in a sheet with mixed line endings, and typing in the other place; typing in one place while the other runs quick commands, and a command that takes a moment; a command that changes the open file while the other place types in it, both changes kept; a command run beside a file with a byte-order mark. Written on 9 October for two bugs every one-place check missed. Against the code before, four fail. In the gate |
| `pad/scripts/accounts-check.mjs` | Accounts in three browsers — owner, edit link, bare name: signing in, New pad, the share dialog's links, the code taken out of the address bar, live typing both ways, a viewer's copy-on-write, a command's file kept local, Discard rejoining the live document, Save as my copy, settings reaching people already inside, the private screen, the dashboard; a long file opening where the owner left it after the editor typed in it meanwhile; a file the owner drags into a folder reaching the editor's tree and the store, and a viewer unable to drag; a viewer's document outliving its editors; a tab closed inside its save delay, Run in one file while another is typed in, `/admin`, a pad made from a zip, Copy a pad — the refusals in words, a failed write leaving no pad, a pasted code sent with the read and not kept, the original untouched — **Not live** on a name an ajar session holds and its backoff, signing out with the pad open as owner in another tab, Back out of the back-forward cache — to a pad, to the dashboard after New pad and after Copy a pad, and after a viewer's Save as my copy — and deleting the account behind its typed confirmation. In the gate |
| `scripts/check-first-run.sh` | A first install somewhere else. Given `dist`: the static Linux binary's `--version` in fresh containers of Ubuntu 20.04, 22.04 and 24.04, Debian 11 and 12, Rocky 8 and 9, Fedora 41, Amazon Linux 2 and 2023, openSUSE Leap 15.6 and Alpine; then, in Ubuntu, `install.sh` as a new bash, zsh and fish user, its PATH line run as printed and a new terminal finding `ajar`, `run.sh` pasted into a terminal still in the home folder, and a binary that cannot run said so at install. `--here` does the installer part on this machine, in a throwaway home — on a Mac, zsh as a login shell. Docker or podman; on a Mac, podman runs the containers as arm64. Against the 0.0.7 release binary ten of the twelve distributions fail, and against the installer before 8 October five of its checks |
| `scripts/linux-sandbox.sh` | Eleven attempts to escape Landlock on a real kernel, and eight controls — that ordinary work still works, and that each probe can see a success when there is one |
| `scripts/acceptance.mjs` | The v0 acceptance list — 11 automated, 3 that need a human |
| `scripts/perf/` | Not a check: timings of what a person feels, against production — see [below](#measuring-what-a-person-feels) |

Two habits of `scripts/lib/wire.mjs`, which every ajar suite uses. A
relay that dies at start — its port already taken, by a relay a killed run
left behind — no longer passes for a working one: the health check answers
from whatever holds the port, so after it does, the suite looks for a relay it
started that has exited, and stops with "is something else on its port?". And
`finish()` says every failure again at the end, because CI's annotation shows
only a log's last few kilobytes.

It also runs the agent as a person does: `startAgentInPanel` starts it inside
a pseudo-terminal through `scripts/lib/ptyrun.py` (220×50 unless `COLS` and
`ROWS` say otherwise), so the panel draws and `press()` sends it keys, and
`linkOf` reads the link through the panel's escape sequences. And a `Guest`
can carry `hostKey`, to speak as the agent that opened a session, and
`resume`, the secret a tab sends so a locked session takes it back.

The browser tier is checked separately, because each run downloads the wasm
packages and drives a real Chromium:

```sh
npm run check --workspace=ajar-pad                              # the pieces, then the product
PAD_ORIGIN=https://code.rishwanth.dev node pad/scripts/app-check.mjs
npm run probe --workspace=ajar-pad                              # what a package can actually do
```

`app-check.mjs` drives the product the way a person would, including the
terminal editor: it opens a file in `nano`, types, writes with ctrl-o, leaves
with ctrl-x and reads the file back. The three assertions that matter are the
exit conditions — the edit reached disk, the terminal was restored rather than
left in the alternate buffer, and the same shell still runs commands. It is
also where a binary file made in one browser is required to reach another
browser's sandbox and the server byte for byte, and to be in the sandbox of a
browser that arrives after it; and where empty files and folders are — stored
as they are made, by the buttons and by `mkdir`, seen by another browser as
folders with no `.keep` in sight, not published back after somebody else moves
one away, deleted from a folder's row for everyone and from the sandbox, and
still there after a reload; and a command's change to a file open in another browser reaching it live, without moving that browser from where it was in the file.

That last one was wrong first time. "The shell survived" was a *negative*
assertion on screen text, and an earlier check in the same run interrupts `cat`
on purpose — so the previous test's deliberate restart was reported as this
one's failure. Proving the shell works by running a command in it is the only
version that means anything.

`probe-packages.mjs` is documented in [pad.md](pad.md#probing-a-package-before-shipping-it):
it installs each candidate package in a real browser and exercises it, which is
the only way to know whether something in the registry is worth its megabytes.

Both drive headless Chromium and have to: the python package fails wasm
validation under Node, and cross-origin isolation — which the runtime needs
for `SharedArrayBuffer` — does not exist outside a browser. Pointing
`app-check.mjs` at a deployment is how a service worker that worked locally
and broke over https was caught.

## The workspace preview

Both workspace UIs can be opened without Rust, a relay, or a session at all:

```sh
npm run dev:ajar
# then http://127.0.0.1:5173/?preview=workspace

npm run dev:pad
# then http://127.0.0.1:5175/?preview=workspace
```

The Ajar fixture has **Populated**, **Empty**, and **Disconnected** examples.
The Pad fixture adds **Saving**, **Save failure**, **Runtime loading**, and
**Running**. Both use the production presentation adapter and simulated data;
neither opens a relay socket or starts a runtime. Pad's simulated Run and Share
controls make the resulting status and terminal presentation reviewable.

It exists because the alternative is standing up an agent and a relay to look
at a padding change, and because `check-workspace-layout.cjs` needs a
deterministic UI to assert against. It is **development-only**: the route has
no special behaviour in a production build, so it cannot ship by accident.

Layout preferences in each preview use injected in-memory storage. Real Ajar
preferences remain under `ajar.*`, real Pad preferences remain under `pad.*`,
and experimenting in either fixture writes neither set.

## The pad's own harnesses

`check.sh` does not run these in full — each drives a real browser and moves
real bytes, and the gate is already the slowest thing in the repository. Of
`npm run check`'s four, `browser-check.mjs`, `terminal-check.mjs` and
`user-check.mjs` are in the gate; `app-check.mjs` is not. `browser-check.mjs`
joined on 9 October, when the line-ending checks in `check.ts` turned out to
have run nowhere but on the machine they were written on. `accounts-check.mjs`
and `pair-check.mjs`, which `npm run check` does not run, are in the gate too.
Of the rest below, only `smoke-abuse.mjs` is.

```sh
npm run check --workspace=ajar-pad          # the pieces, then the product
npm run probe --workspace=ajar-pad          # what a package can actually do
node pad/scripts/ingress-check.mjs          # a process in the sandbox serving HTTP
node scripts/smoke-abuse.mjs                # refusing abuse — also runs in check.sh

VITE_PREVIEW_ORIGIN=http://127.0.0.1:5251 npx vite build
node pad/scripts/preview-check.mjs          # the Preview button, end to end

node deploy/wisp-server.mjs &               # or point at the deployed one
node pad/scripts/wisp-check.mjs             # egress, and the limits on it
WISP_URL=wss://code.rishwanth.dev/wisp/ node pad/scripts/wisp-check.mjs
```

`preview-check.mjs` is the one worth reading if you touch the preview: it
writes a server, runs it, waits for the button, presses it, reads the iframe
and presses it again. Three of its steps only exist because earlier versions
lied — see below. It takes `PAD_ORIGIN` to drive the deployed site, which it
silently ignored until 15 September.

`wisp-check.mjs` asserts two things that are only worth anything together:
`pip install` reaches PyPI, **and** everything that is not PyPI is refused. The
second is what separates a package installer from an open proxy running on our
address, so it is measured rather than read off the configuration — and it is
gated on the first, because with the endpoint down every destination is refused
and the allowlist assertions pass while proving nothing.

It drives `src/wisp-probe.ts` through `rt.run()` rather than typing into the
terminal. That is deliberate: every flaky result in this area came from a
driver racing its own keystrokes, and this one has never been flaky.

### The abuse suite, and why it is not unit tests

`scripts/smoke-abuse.mjs` asserts the relay **refuses and survives**, which is a
different property from working and was covered nowhere: `ws.rs` and
`outbox.rs` had no tests at all.

It exists because unit tests could not do the job. `quota.rs` has sixty-odd
tests proving the arithmetic, and **every one of them passes with the claim in
`ws.rs` deleted** — they prove the limit computes, not that it is reached. So
this suite opens real sockets until it is refused, fills a store over HTTP until
it answers 507, watches how many bytes the server was willing to read, and reads
the relay's own resident memory while a dozen reads of a 24 MiB pad run at once —
every one of those reads succeeds with or without the fix, so a status code
could never have shown the 647 MiB they used to cost.

It is also why the suite is heavier than it looks: roughly 120 connections per
run, which on a monitored laptop is close enough to a port scan to be worth
knowing about. It belongs on a server or in CI.

## Measuring what a person feels

`scripts/perf/` measures the product the way people meet it: against the
deployed site by default, from a key press or a click to pixels on screen. These
are measurements, not checks — nothing fails, and they are not in the gate.

```sh
scripts/perf/network.sh                        # the floor: DNS, TCP, TLS, first byte
node scripts/perf/ajar-session.mjs             # host start, guest join, echo, output
AGENT=target/release/ajar node scripts/perf/ajar-session.mjs   # a local build
COLD=0,5000 WARM=3000,3000 node scripts/perf/pad-visit.mjs     # first and return visits
node pad/scripts/typing-perf.mjs 125000 bursts                 # two people in one long file, locally
```

`typing-perf.mjs` is the one that runs locally rather than against the site:
two pages on one pad through a real relay, one typing into a long file, both
watched for long tasks and timer lag. Its numbers are in
[pad.md](pad.md#two-people-in-one-long-file); it needs `cargo build` and the
pad built first.

Run them one at a time — two browsers on one machine slow each other down. Each
prints a JSON line per result and appends it to `$OUT` when that is set. A first
pad visit fetches every runtime file once, and production allows 100 fetches
of each an hour per address, shared with anyone using the pad from that address,
so keep `COLD` short; return visits cost nothing. `app-check.mjs` against the live
site is about five first visits a run.

Taken on production on 25 September, before and after the changes they drove:

| What the person feels | Before | After |
|---|---|---|
| Pad, first visit, Run after 5 s of reading → output | 7.7–10.1 s | 1.0 s |
| Pad, return visit, Run → output | 1.5 s | 0.5 s |
| Pad shell, a line starting with `#` | hung until ctrl-c | finishes |
| ajar guest, join → a shell prompt | a click on "New terminal" first | 0.35–0.55 s, no click |
| ajar guest's first shell | three `Permission denied` lines | clean (v0.0.5) |

Already fine, and left alone: ajar echo 63–94 ms at the 50th percentile against
a floor of two ~30 ms round trips to Mumbai; host start 0.2–0.4 s; 100 000 lines
of output 0.4–0.9 s; the guest page 0.11 MB; pad shell echo 13 ms; autosave
0.6 s; `pip install six` 5 s.

Three ways these measured the wrong thing before they were fixed:

- **An echo that arrived before it was sent.** Typed lines started with a
  letter, and the prompt already contained that letter, so the first key of
  every line "echoed" in 5 ms. Lines now start with `#`.
- **A hang that was not there.** The comment-line check typed its next command
  straight after Enter, racing the line it was testing. It now asks the shell
  whether it is idle.
- **Results lost to a crash.** Node flushes a piped stdout asynchronously, so a
  run that failed late took everything it had printed with it — the first
  cold-visit numbers went that way. Results are now written synchronously.

## Checks that passed for the wrong reason

Thirty-one so far, and they are the most transferable lesson in this repository.
The pattern is always the same: **the thing under test could produce the
passing evidence by accident.**

| The check | Why it proved nothing |
|---|---|
| macOS sandbox escape | The fixture wrote to the system temp directory, which is deliberately writable |
| Linux sandbox escape | The fake home was under `/tmp`, which is granted writable so toolchains work — six checks leaked |
| Encryption wiretap | It searched the client→server stream, which WebSocket **masks** per frame. A substring search cannot find plaintext there whether or not it is encrypted |
| Fork bomb | It read an exit status from a shell that exits 0 on the failure being tested |
| Peer sessions | It watched for a file the browser had already created itself |
| Reconnect | It built a fresh client, where a browser reuses one |
| ctrl-d | It matched `cat`'s own echo |
| Package mirroring | A service worker response keeps the original URL, so the network log blamed the CDN while the mirror worked |
| CSS injection | It counted stylesheet rules, which cannot see a trailing backslash eating the next rule |
| Concurrent editing | It asserted contiguity a CRDT never promises |
| The link race | It measured a *delay* before joining, so it passed with and without the fix |
| "22 commands work on live" | Every marker appeared in the echoed command line too, so a command that never ran still "passed" — the tell was `44 of 19` |
| "the shell survived the editor" | A *negative* assertion on shared scrollback, and an earlier check interrupts `cat` on purpose — it reported the previous test's work as this one's failure |
| The preview's server | Seeded through the store, where a pad's files are present but empty in the sandbox, so the server exited instantly and the button never appeared |
| Three revert tests of the seeding fix | The revert failed the typecheck, so `vite` never ran and `dist/` still held the build made from the *fixed* source — the check measured the fix it was meant to be deprived of |
| "the egress allowlist is refusing hosts" | With the endpoint down, every destination is refused and the allowlist assertions pass without an allowlist doing anything. They now require `pypi.org` to work in the same run |
| `--no-network` refuses outbound tcp | The probe used `/dev/tcp` under `/bin/sh`, which is dash on Debian and Ubuntu, where `/dev/tcp` is just a missing path. It "failed to connect" with the network wide open. It now uses bash and requires the same probe to *succeed* with the network allowed first |
| "a read-only notice reached the guest" | `control.length >= 0` — true of every array |
| A busy host still lets a guest fork | First draft: `sh -c 'echo …'` as the shell's last command is exec'd rather than forked, and `echo` is a builtin, so nothing forked and it passed against the bug |
| Someone who joined during a host's blip got a tree | "The mirrored tree is non-empty" — satisfied by a *patch* for a file somebody else saved meanwhile, with no tree ever sent |
| Capability probes under Landlock | Built at the crate's default best-effort level, where an unsupported right is silently dropped and `create()` succeeds anyway. Every probe said yes on every kernel |
| A pad newcomer seeding beside a slow room | It checked each side had the other's line; two documents ignoring each other's history still both take a line typed at the end. Then it compared whole texts, but read the stored copy before the room's save had landed — the one case where seeding is safe |
| A cursor id writing the stylesheet | It looked for any `display: none` in a style element, and the page's own stylesheets have those |
| A pad Run's status | It read the status once, straight after Run; a save landing a moment later overwrote it only on a fast machine, so the check passed locally and failed on CI |
| A viewer converging after its editors left | With every seed under one client id, the new editor's typing is put against the viewer's characters of the same ids — but typed at the end of the file it lands at the end anyway. The fix was to type *inside* the seed, after its first character, with Cmd+Home and an arrow; Cmd+Home is not a Monaco binding on a Mac, the cursor never left the end, and it passed twice more. The cursor is now placed through Monaco's API, and the check asserts the editor's own text first |
| Discard rejoining the live file | It waited for the room's next line to appear, which the stored copy also delivers, a save later. It now requires the live document itself |
| A hosted session squatting an owned pad's name | It tried to squat a pad whose room had people in it, and the relay refuses a host there for its own reasons. With the fix removed it still passed. It now squats a pad whose room is empty — the attack — and then requires the owner to get in |
| Back from Your pads | Every pad check passed while a real browser's Back showed an empty, dead page: Playwright launches Chromium with `--disable-back-forward-cache`, so Back was always a fresh load and never the frozen page people get. `accounts-check.mjs` now runs those flows in a second Chromium with the cache on. The first Back must come out of the cache, or the section proves nothing; the browser may decline to keep a page under load — CI's did, now and then, failing the check where the product was fine — so a later miss is tried again and, still missed, noted with the browser's reasons. The guest's page in ajar had the same blind spot until 7 October; `check-guest.mjs` launches its second Chromium the same way |
| Acceptance #7, "nothing re-ran" | It was recorded true without looking. It now counts the command's output in the replay against what a guest watching live saw |
| check-host-drop's "open for editing" | It waited for Monaco to drop a `read-only` class Monaco never sets, and swallowed the timeout, so it waited for nothing. It now waits for `#viewer[data-editing]`, which the page sets only once the document is bound |
| Typing kept when editing is locked mid-save | It passed whenever the lock reached the editor before its save left, which is every local run. The other order — the save in flight when the demotion lands, so the demotion finds nothing unsaved — lost the typing, and only CI's macOS runner was slow enough to hit it, on 5 October. The editor's save is now held until the lock has landed, so that order is the one tested |

**Wait for what you check; never look once.** Three more on 7 October, all on
the macOS runner: the pad's Ctrl-R check read the screen between the echo and
the command's output; `check-guest` read a refused file's title between the
host's reason and the read-only copy's; and after a Back that came back as a
fresh load, it compared with a place from before the retry. The product was
right each time.

And once it was not the test. On 7 October `check-guest`'s guest 250 ms away
clicked a file on CI and nothing opened, where locally it opened in 1.6 s
every time. The tree replaced every row whenever the folder changed, and a
click whose press and release land on different elements is no click. The
check that came of it presses a row, writes a file, waits for the file to
appear, and only then releases.

A fourth habit, from the same week: **read the failure, not the status.** A
502 from the sandbox's HTTP route carries the error in its body — the service
worker answers with `new Response(error.message, { status: 502 })`. Reporting
"502" and stopping cost a session.

**The habit that catches them: revert the fix, watch the check fail, restore
it.** Do this every time. It has caught worthless checks repeatedly, including
several written specifically to prove a fix worked.

The habit has a failure mode of its own, and it cost a session. `npm run
build` is `tsc --noEmit && vite build`, so a revert that leaves a parameter
unused fails the typecheck, **never reaches vite, and leaves `dist/` holding
the build made from the fixed source**. The check then runs against the fix it
was supposed to be deprived of and passes. Three consecutive revert tests were
read as "the check does not discriminate" when part of what they measured was
a stale bundle, and each was answered by rewriting the check — reasoning at
length from evidence that was partly an artefact of the build. Discarding the
build output to `/dev/null` is what hid it. **Never discard the build output
in a revert test; assert the build exited 0 before believing anything the
check says.**

The dev server has the same trap in a different place. Vite caches transformed
modules in `web/node_modules/.vite`, and a revert tested through `npm run
dev:ajar` can be served the cached transform of the fixed file. Delete that
directory before any revert test that goes through the dev server.

The same shape once more, one layer down: a revert that fails to *compile*
leaves the previous binary under `target/`, and a smoke suite spawning
`target/debug/ajar` runs the fix. Revert, build, see the build succeed, then
run the check. A stub that lets the revert compile is fair; the point is only
that the thing under test is the thing you think it is.

A fourth, from the egress work, and the most alarming: **a check that
reported a security hole that was not there.** The probe connected to
`example.com` through the allowlisted endpoint, got no error, and called it
`REACHED IT` — an open proxy. The server log showed it refusing every attempt.
`socket.create_connection` returns successfully for a destination WISP refused:
the stream is opened optimistically and the refusal only lands on first I/O. A
connect that "works" proves nothing, so the check now sends a byte and reads
one. **When a check says something alarming, read the other side's log before
believing it** — the server knew the answer the whole time.

And a fifth, which wasted more wall-clock than the rest put together: **a
driver that types into a terminal races the thing it typed.** `waitForFunction`
returns when a marker appears, which can be before the command finishes, and
the next keystrokes then go into the running command rather than the shell. It
does not fail — it mangles the next line, so a working feature reports as
broken. Twice this looked like `pip install` failing in production when it was
fine. Wait for the prompt to come back, or better, drive the runtime directly:
`wisp-check.mjs` goes through `wisp-probe.ts` and `rt.run()` for exactly this
reason, and has never once been flaky.

A third way to be misled, from verifying `find` on live: **a check that failed
because of its own quoting.** The driver types a shell command as a JS string,
and `"\\;"` written as `"\;"` is not an escape — JS silently drops the
backslash, so bash received a bare `;` and read it as a command separator. Two
rounds of live verification reported `-exec` broken when it was not, and the
tell was there each time in the echoed command line: `-exec cat {} ;`. The fix
is to build the argument as `String.fromCharCode(92, 59)` rather than trusting
a literal, and the habit is to **read the echoed command before believing the
result** — the terminal shows exactly what it was asked to run.

That round was not wasted: running against live is what turned up `find .`
listing five shim files nobody wrote, which no local check could see because
the fixtures never looked.

The same day, the inverse: a check that *failed* for the wrong reason.
`preview-check.mjs` drives `dist/`, and the preview origin is compiled into the
build — so running it straight after a deploy drove a production bundle, which
refuses to be framed by `127.0.0.1` exactly as it should. The console said
`frame-ancestors`, which reads as a broken preview rather than the wrong
bundle. It also ignored `PAD_ORIGIN` and always served locally, so asking it to check
live silently checked the local build instead. Both are fixed: it verifies the
bundle it is about to drive knows the origin it is about to serve and says to
rebuild if not, and `PAD_ORIGIN=https://code.rishwanth.dev` now drives the
deployed site — no relay spawned, no `dist/` served, both origins real. That is
the only way the preview is checked against the build users actually get.

A race is also the wrong thing to hang a regression check on. The sandbox seed
is taken synchronously inside the first content change a model reports, which
is the editor binding — so whether the bug lands depends on timing a driver
does not reproduce. The answer was to lift the decision into `pad/src/seed.ts`,
a pure function over the three sources, and assert it directly in `check.ts`.
It now fails on exactly three of its five cases when reverted. Prefer moving
the logic somewhere deterministic over trying to recreate the race.

A second habit worth keeping: when a check and a screenshot disagree, believe
the screenshot. A grid overflow left the sidebar 936px tall at y=−215 —
invisible on screen, perfectly correct in the DOM. Two separate bugs were
found this way and neither was visible to `textContent` assertions.

And a third: verify a fix in *isolation*. An injected error meant to prove the
ajar boot check worked was caught by a different suite running first, which
said nothing about the check under test.

Two more about where a check can run at all. `vite preview` serves the pad
*without* the cross-origin isolation headers — `pad/vite.config.ts` sets them
in `configureServer`, which only the dev server runs — so the runtime never
starts there: a Run that never finishes, which is not the code. Anything that
needs Run goes through a harness that sets them (`app-check.mjs`,
`browser-check.mjs`). And `deploy/caddy/check.sh` is Linux-only, but on a Mac
it runs in a container against the arm64 build:
`podman run --rm -v "$PWD":/src -w /src -e CADDY=dist/caddy-linux-arm64
docker.io/library/rust:slim bash -c 'apt-get update -qq && apt-get install -y
-qq curl && deploy/caddy/check.sh'`.

And a fourth, about Playwright: `waitForFunction(fn, arg, options)` takes the
function's argument *second*. Twenty-four waits in the pad's harnesses passed
`{ timeout: 180_000 }` there, so it became the argument and every one waited
the default 30 s. Locally that was enough. Against the live site a fresh
browser's first Run sometimes is not, which read as a flaky check, and the
browser check's whole-page wait was 30 s rather than three minutes — part of
why it "hung" when the CDN was slow. Pass `null` as the argument.

## Dogfooding

`scripts/dogfood.mjs` shares this repository through ajar and works in it —
builds, tests, reads files — then reports what that cost. **It asserts
nothing on purpose**: the acceptance list checks that things work, this checks
what it is *like*.

```
  cargo build through the terminal               0.6s, 1256 bytes
  fs messages caused by the build                none — target/ never left the machine
  tree matches git ls-files                      44 (git would list 44)
```

The build line is the one that matters: a full Rust build inside a shared
session produces zero filesystem traffic to guests. The tree matching
`git ls-files` means the file list is also a review of what you are about to
hand someone — the first run caught a build artifact staged by accident.

### What dogfooding found that testing hadn't

- A shell whose startup prints or prompts can swallow the first keystrokes.
- Raw bytes are not a screen: zsh redraws its input line for syntax
  highlighting, so a naive scan of the byte stream sees text a rendered
  terminal never shows.

Both were in the harness, not the product — but they are the kind of thing
only real use surfaces.

## The test that has not been run

Use it with a colleague, on a real bug, twice. Everything above is a judgement
made without that, and nothing in the suite substitutes for it.

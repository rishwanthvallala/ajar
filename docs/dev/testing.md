# The gate, and how checks lie

```sh
./scripts/check.sh      # everything, in order
```

`AJAR_SKIP_UI=1` skips the browser suite. It is the only skip, it is opt-in,
and it changes the summary: the script never prints `all green` unless every
check ran. A missing browser is otherwise **fatal everywhere** — a gate that
quietly downgrades itself on the machine where someone is about to commit is
worse than no gate, because it still reports success.

## What each suite proves

| | |
|---|---|
| `cargo test` | Frame codec, guardrails, ring buffer, ids, backoff, session lifecycle, ignore rules, scanning, patches, panel keys, process accounting, the reconciler, secret detection, checkpoints, sandbox escapes, sealing, the store, quotas, guest limits, durable pads, peer sessions |
| `npm run typecheck` / `build` | Both browser builds |
| `pad/scripts/browser-check.mjs` | Drives `pad/src/check.ts` in headless Chromium — the runtime, the shell, every python shim against its real tool, the sandbox seed, and that the WISP transport loads. It cannot be a node test: the python package fails wasm validation there, and `SharedArrayBuffer` needs cross-origin isolation |
| dockerfile check | Every `COPY` source exists — the cheap half of `docker build` |
| `scripts/test-ui.cjs` | Runs both layout checks below, then boots each app and requires no page errors |
| `scripts/check-workspace-layout.cjs` | The session client: editor lifecycle, pointer and keyboard resize, four viewport sizes, drawer focus, preferences, preview isolation, lazy loading, disposal — and that a guest meeting a host on another protocol is told so instead of getting a dead session |
| `scripts/check-pad-layout.cjs` | The pad against the same shared shell: resize, four viewports, drawer focus, status fixtures, and that pad preferences and network state stay isolated from the session client's |
| `scripts/smoke.mjs` | relay + agent + a guest that runs a real command, sees replay, round-trips presence |
| `scripts/smoke-workspace.mjs` | Ignore rules, reads, path-traversal refusal, patches, an install-sized burst |
| `scripts/smoke-editing.mjs` | Two people editing one file while the terminal rewrites it |
| `scripts/smoke-control.mjs` | Lock and read-only actually reach a guest |
| `scripts/smoke-environment.mjs` | Credentials in the host's environment do not reach a guest's shell, and the socket warning matches what a guest can actually reach |
| `scripts/smoke-encryption.mjs` | Wiretaps the wire and requires nothing readable crosses it |
| `scripts/smoke-sync.mjs` | Kills the host mid-session; the guest can still read the folder |
| `scripts/smoke-reconnect.mjs` | Kills the relay mid-session; the agent returns to the same link |
| `scripts/smoke-hostdrop.mjs` | Cuts only the host's socket, through a proxy, and requires everything from the gap back: typing, disk changes, new files, joins and leaves |
| `scripts/check-host-drop.mjs` | The same blip in the real browser client, typing into Monaco — needs `npm run build:ajar` |
| `scripts/smoke-peer.mjs` | Peer sessions — the only suite that starts a relay and no agent |
| `scripts/linux-sandbox.sh` | Ten attempts to escape Landlock on a real kernel, and seven controls — that ordinary work still works, and that each probe can see a success when there is one |
| `scripts/acceptance.mjs` | The v0 acceptance list — 11 automated, 3 that need a human |

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
left in the alternate buffer, and the same shell still runs commands.

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
# then http://localhost:5173/?preview=workspace

npm run dev:pad
# then http://localhost:5175/?preview=workspace
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

Four, none of them in `check.sh` — each drives a real browser and moves real
bytes, and the gate is already the slowest thing in the repository.

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
it answers 507, and watches how many bytes the server was willing to read.

It is also why the suite is heavier than it looks: roughly 120 connections per
run, which on a monitored laptop is close enough to a port scan to be worth
knowing about. It belongs on a server or in CI.

## Checks that passed for the wrong reason

Twenty-one so far, and they are the most transferable lesson in this repository.
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

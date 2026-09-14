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
| dockerfile check | Every `COPY` source exists — the cheap half of `docker build` |
| `scripts/test-ui.cjs` | Workspace layout, editor lifecycle, pointer and keyboard resize, four viewport sizes, drawer focus, lazy loading, disposal; both apps boot with no page errors |
| `scripts/smoke.mjs` | relay + agent + a guest that runs a real command, sees replay, round-trips presence |
| `scripts/smoke-workspace.mjs` | Ignore rules, reads, path-traversal refusal, patches, an install-sized burst |
| `scripts/smoke-editing.mjs` | Two people editing one file while the terminal rewrites it |
| `scripts/smoke-control.mjs` | Lock and read-only actually reach a guest |
| `scripts/smoke-encryption.mjs` | Wiretaps the wire and requires nothing readable crosses it |
| `scripts/smoke-sync.mjs` | Kills the host mid-session; the guest can still read the folder |
| `scripts/smoke-reconnect.mjs` | Kills the relay mid-session; the agent returns to the same link |
| `scripts/smoke-peer.mjs` | Peer sessions — the only suite that starts a relay and no agent |
| `scripts/linux-sandbox.sh` | Nine attempts to escape Landlock, on a real kernel |
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

The session UI can be opened without Rust, a relay, or a session at all:

```sh
npm run dev:ajar
# then http://localhost:5173/?preview=workspace
```

It renders the real layout, file tree, editor and panel controls against
sample data, with three examples — **Populated**, **Empty**, **Disconnected**.
Terminal output is simulated; typing does not execute anything.

It exists because the alternative is standing up an agent and a relay to look
at a padding change, and because `check-workspace-layout.cjs` needs a
deterministic UI to assert against. It is **development-only**: the route has
no special behaviour in a production build, so it cannot ship by accident.

Layout preferences in the preview are kept separate from real-session ones, so
experimenting here does not rearrange anybody's actual workspace.

## Checks that passed for the wrong reason

At least nine, and they are the most transferable lesson in this repository.
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

**The habit that catches them: revert the fix, watch the check fail, restore
it.** Do this every time. It has caught worthless checks repeatedly, including
several written specifically to prove a fix worked.

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

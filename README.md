# ajar

Leave a machine open to someone. One command on the host, a link for everyone
else, no install on the guest's side.

**v1 — collaborative editing.** Shared terminals, a live file tree, and files
two people can edit at once while a terminal rewrites them underneath. Still
no sandbox and nothing persists. See the build spec for
what that deliberately leaves out and why.

> **ajar v0 has no sandbox.** Anyone who opens a session link gets a shell as
> the host user — their files, their SSH keys, their cloud credentials. Share
> only with people you would hand your unlocked laptop to.

## Layout

| Path | What |
|---|---|
| `crates/ajar-proto` | Wire format shared by agent and relay |
| `crates/ajar` | The agent — owns the folder, the ptys, the documents, the link |
| `crates/ajar-relay` | Routes frames. Parses the 9-byte header and nothing else |
| `web` | Vite + TypeScript + xterm.js client |
| `scripts/` | End-to-end tests and the pre-commit gate |

## Installing

```sh
curl -sSf https://ajar.sh/install.sh | sh
```

One static binary, no runtime, nothing to configure. Native Windows is
refused with instructions; use WSL2, and keep projects in the WSL filesystem.

## Running it from source

Three terminals.

```sh
# 1. the relay
cargo run -p ajar-relay -- --bind 127.0.0.1:8787

# 2. the web client
cd web && VITE_RELAY=ws://127.0.0.1:8787/ws npm run dev

# 3. share a folder
cargo run -p ajar -- ~/some/project --relay http://127.0.0.1:8787
```

The agent prints a link like `http://127.0.0.1:8787/j/quiet-ember-4417`. In
development, open the same path on the Vite server instead:
`http://localhost:5173/j/quiet-ember-4417`.

## Checks

```sh
./scripts/check.sh      # everything below, in order
```

| | |
|---|---|
| `cargo test` | 131 tests: frame codec, guardrails, ring buffer, ids, backoff, session lifecycle, ignore rules, scanning, patches, panel keys, process accounting, the reconciler, secret detection, checkpoints, sandbox escapes, sealing, the store, quotas, guest limits |
| `npx tsc --noEmit` | web client typecheck |
| `scripts/smoke.mjs` | relay + agent + a guest that runs a real command, sees replay, round-trips presence |
| `scripts/smoke-workspace.mjs` | ignore rules, reads, path-traversal refusal, patches, and an install-sized burst |
| `scripts/smoke-editing.mjs` | two people editing one file while the terminal rewrites it |
| `scripts/smoke-control.mjs` | the host's controls — lock, read-only — actually reach a guest |
| `scripts/smoke-encryption.mjs` | wiretaps the wire and requires that nothing readable crosses it |
| `scripts/smoke-sync.mjs` | kills the host mid-session and requires the guest can still read the folder |
| `scripts/linux-sandbox.sh` | tries nine ways out of the Landlock sandbox, on a real Linux kernel |
| `scripts/smoke-reconnect.mjs` | kills the relay mid-session and proves the agent comes back to the same link |
| `scripts/acceptance.mjs` | the v0 acceptance list from the spec — 11 automated checks, 3 that need a human |
| `scripts/dogfood.mjs` | shares this repo through ajar and does real work in it. Reports numbers, asserts nothing |

## The wire format

Every message is one binary WebSocket frame:

```
byte  0      channel    u8   CONTROL | PTY | FS | PRESENCE
bytes 1..5   stream_id  u32  LE  pty id, or 0 for channel-level JSON
bytes 5..9   target     u32  LE  participant id, or 0 for broadcast
bytes 9..    payload    opaque to the relay
```

The relay reads the header and nothing else. That constraint was there from
the first commit, and it paid: turning on end-to-end encryption required
**zero changes to the relay**. The word "crypto" does not appear in it.

Routing is four cells and stays four cells:

| From | `target = 0` | `target = N` |
|---|---|---|
| guest | → host only | rejected |
| host | → every guest | → that participant |

Guests never address each other. Anything a guest needs from another guest —
presence, membership — goes through the host, which is the authority on
session state.

## What survives what

| Event | What happens |
|---|---|
| Guest's socket drops | Reconnects with backoff; the host re-announces every terminal and replays its ring buffer |
| Host's socket drops | Session held for 45s. Terminals keep running — the agent process never noticed. Guests see a "host away" banner |
| Host returns inside the grace | Guests get `host_back`, terminals are re-announced and replayed |
| Host never returns | The relay reaps the session and tells guests why |
| Host presses ctrl-c | `Control::Close` — the session ends immediately, no grace |
| Relay process dies | The agent dials back in and re-opens the same session id. Terminals were never touched |

Frames the agent tries to send while disconnected are **dropped, not queued**.
The ring buffers already hold the terminal output a guest needs; queueing here
would replay it twice.

## What the tree does and doesn't show

Ignore rules are shared by the scanner and the watcher, because they have to
agree: if the watcher let `node_modules` through, a dependency install would
flood every guest with churn the scanner never showed them.

| | |
|---|---|
| Always skipped | `.git`, `node_modules`, `target`, `dist`, `.next`, `__pycache__`, `.venv`, and friends — generated by definition, whether or not the project has a `.gitignore` |
| Also skipped | Anything the project's own `.gitignore` or `.ignore` matches |
| Shown | Dotfiles. A shared project usually wants its `.gitignore` and `.editorconfig` visible |
| Never sent | Binary content — flagged, not shipped. Files over 1 MB are truncated |
| Refused | Any path that escapes the workspace, including through a symlink |

Change arrives as a `patch` a few times a second. Past ~500 touched paths in
one flush the host stops describing deltas and sends a fresh `tree` instead —
rebuilding is cheaper than shipping fifty thousand entries, and far cheaper
than a client that falls behind forever. There is no separate "resync"
message: a `tree` already means *replace everything you know*.

Rebuilds are rate-limited to one a second, and **deferred rather than
dropped**. A dropped one would leave the tree permanently stale once a burst
ended and no further events arrived.

## The host's control panel

`ajar` doesn't return — it becomes a live view of who is connected, what they
are running, and what it is costing:

```
● open  api  /Users/you/projects/api
  412 files shared

  http://127.0.0.1:8787/j/quiet-ember-4417   ← send this

┌────────────────────────────────────────────────────────────────────┐
│ no sandbox — anyone with this link gets a shell as you: your files, │
│ your SSH keys, your cloud credentials                              │
└────────────────────────────────────────────────────────────────────┘
┌ here ──────────────────┐┌ running on your machine ─────────────────┐
│ 2  priya  3m · 2 term  ││ 1  priya   7% cpu   184M · 3 proc        │
│                        ││ 2  priya   0% cpu    12M · 1 proc        │
└────────────────────────┘└──────────────────────────────────────────┘
 [k] kick   [q] close — ends every terminal and stops the link
```

Per-terminal figures cover the shell's **whole process subtree**, not just the
shell — a guest running a build should show as a guest running a build.

The warning is not a startup banner that scrolls away. It stays on screen for
as long as the machine is open, because that is the whole time it is true.

**When stdout isn't a terminal** — piped, redirected, under a test — the panel
degrades to plain lines. Nobody wants ANSI escapes in a log file, and the
smoke tests depend on it.

## Shipping

```sh
./scripts/dist.sh --all     # tarballs + checksums into dist/
docker build -t ajar-relay .
```

`install.sh` is compiled into the relay and served at `/install.sh`, so the
published installer cannot drift from the binary that was built and there is
nothing extra to deploy. Release tarballs are named `ajar-<target>.tar.gz`
with a `.sha256` beside each — the installer verifies it and refuses on a
mismatch.

Try the whole install path without publishing anything:

```sh
./scripts/dist.sh
AJAR_DIST=$PWD/dist AJAR_BIN_DIR=/tmp/ajar-bin sh install.sh
```

## Front page

The relay serves a landing page that states the no-sandbox model plainly
rather than burying it: anyone with a session link gets a shell as you, the
read-only viewer is a convenience and not a boundary, and this is the same
bargain `tmate` has offered for a decade. A product that needs its central
caveat hidden is not ready to be shared.

Monaco is loaded lazily, so a visitor to the front page — or a session where
nobody opens a file — downloads 89 kB gzipped rather than 1 MB.

The whole deploy is 3.8 MB, down from 56 MB. Two things were paying for
nothing: production sourcemaps, which were 42 MB of Monaco's own vendor code
mapping back to source that is public here anyway; and the TypeScript, JSON,
HTML and CSS language services, which `monaco-editor`'s index pulls in whether
or not you use them. Those four can never run — `MonacoEnvironment.getWorker`
returns the editor worker for every request — so importing `editor.api` plus
the basic-languages contribution keeps syntax highlighting for every language
the viewer maps and drops nine megabytes of workers that were only ever
sitting on disk.

## Dogfooding

`scripts/dogfood.mjs` shares this repository through ajar and works in it —
builds, tests, reads files — then reports what that cost. It asserts nothing
on purpose: the acceptance list checks that things work, this checks what it
is *like*.

```
  share the repo                                 53ms
  files in the tree                              44 (git would list 44)
  generated paths leaked                         none
  cargo build through the terminal               0.6s, 1256 bytes
  fs messages caused by the build                none — target/ never left the machine
  cargo test through the terminal                0.9s, green
  ansi colour survives the round trip            yes
  reading the largest file in the repo           Cargo.lock (75kB) in 51ms
```

The line that matters most is the fourth: **a full Rust build inside a shared
session produces zero filesystem traffic to guests.** That is the ignore rules
doing exactly the job they exist for, under exactly the load that would
otherwise flood everyone watching.

The tree matching `git ls-files` is worth watching too — it means the file
list is also a review of what you are about to hand someone. The first run
caught a build artifact that had been staged by accident.

### What dogfooding found that testing hadn't

- **A shell whose startup prints or prompts can swallow the first keystrokes.**
  The same is true of any terminal, but a guest has less context for what
  they are looking at — they did not start this shell and cannot see how long
  ago it began.
- **Raw bytes are not a screen.** zsh redraws its input line for syntax
  highlighting and suggestions, so a naive scan of the byte stream sees text
  that a rendered terminal never shows. Both problems were in the harness,
  not the product — but they are the kind of thing only real use surfaces.

## Editing

Only open files get a CRDT. Twenty thousand documents for a repository nobody
is reading would be absurd; the interesting state is whatever somebody has on
screen. The agent holds the canonical document, guests sync to it, and updates
are forwarded verbatim — Yjs updates are idempotent and commutative, so the
host never interprets one to relay it.

The hard part is that the disk is not the document's private property:

| Event | What happens |
|---|---|
| Someone types | Update reaches the host, is applied, and fans out. The file is written back once typing stops for 400ms |
| A terminal rewrites the file | The watcher reports it, the agent diffs it into the document, everyone sees the change with their cursors intact |
| Our own write comes back | Ignored — compared against *what we last wrote*, not what the document says now |
| A binary or oversized file | Refused with a reason. It falls back to read-only rather than being corrupted on the next write-back |

That third row is subtler than it looks. The watcher reports a write only
after it lands, by which time the next keystroke has usually arrived — so
comparing the document to the file would treat your own typing as an external
change and silently undo it.

External changes are folded in with a prefix/suffix diff rather than a
wholesale replacement. Replacing the text would delete and reinsert every
character, throwing away every cursor in the session; keeping the common ends
means a formatter touching one line disturbs one line.

The Monaco binding is written here rather than taken from `y-monaco`, which
has not been published since 2024 and predates this Monaco by several major
versions.

### A hazard worth knowing about

A shell that is still starting can swallow the first characters you type, and
that is not harmless: `printf x > f` arriving as `rintf x > f` still performs
the redirect, truncating the file before failing. Real terminals behave the
same way, but a guest has less context — they did not start this shell and
cannot see how long ago it began. The test harness deals with it by sending a
sentinel and requiring it back before trusting the terminal.

## Before you open the door

Two things run before the link is minted, because both are about what the host
is agreeing to before anyone can arrive.

**A checkpoint.** `git stash create` builds a commit object from the working
tree *without touching the working tree* — plain `git stash` would disturb
what the host is looking at, at the exact moment they are deciding whether to
trust this. On the way out, the agent says what changed and how to undo it:

```
  2 files changed: src/main.rs, guest-file.txt
  to undo everything from before the session:
      git restore --source=a98a3195 --worktree -- .
```

It restores tracked files only. Anything a guest newly created stays put —
deleting unknown files on someone's behalf is not a favour.

**A credential scan.** Filenames by convention (`.env`, `*.pem`, `id_rsa`,
`.npmrc`) and a deliberately narrow set of content patterns — private key
headers, AWS key ids, GitHub and Slack tokens. `.env.example` and friends are
left alone; they are the template, not the secret. A scanner that cries wolf
gets ignored, and being ignored is the only real failure mode.

```
  !  2 credentials in this folder — .env, deploy.pem. A guest with a
     terminal can read them; there is no sandbox yet
```

That last clause is the point. **The scan is a warning, not a boundary.**
Keeping a file out of the tree would stop it being opened by accident, not
read on purpose — a guest has a shell. Claiming otherwise would be worse than
saying nothing. When the sandbox lands, exclusion starts to mean something.

## The sandbox

A guest keeps the host's real toolchain — that is the whole point of lending a
machine, and a container would hand them a different one. So the *account* is
restricted rather than the environment replaced.

| | |
|---|---|
| Writes | Confined to the shared folder, temp, and build caches |
| Credentials | `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, keychains and browser profiles are unreadable |
| Everything else | Readable, so compilers and language servers still work |
| Network | Allowed by default. `--no-network` cuts it off — Seatbelt on macOS, Landlock `ConnectTcp` on Linux. On a kernel older than 6.7 it **refuses to start** rather than pretend |

Confining writes to the project *alone* was the obvious first design and it is
wrong: it breaks `cargo`, `npm` and everything else that keeps a per-user
cache. A sandbox people switch off protects nobody, so the caches stay
writable and the summary says so rather than leaving it to be discovered.

**It is a sandbox, not a virtual machine.** It stops the ordinary case — a
stray `rm -rf`, an idle look through `~/.ssh`. It does not stop someone
determined with a kernel bug, and the wording everywhere reflects that.

### Two mechanisms, and Linux is the stricter one

| | macOS — Seatbelt | Linux — Landlock |
|---|---|---|
| Model | allow everything, then deny | grant nothing, then allow |
| Credentials | a named list is denied: `~/.ssh`, `~/.aws`, keychains, browser profiles | the whole home directory is invisible apart from shell config and build caches |
| Applied by | wrapping the shell in `sandbox-exec` | re-execing the agent as a launcher that restricts itself, then becomes the shell |

The difference follows from the mechanism. Landlock has no deny rules, so
"everything except `~/.ssh`" is not expressible — which forces the stricter
design of granting each top-level directory *except* the one home lives under,
and then handing back only what a shell and a toolchain actually need.

Landlock restricts the *calling* process and is inherited across `exec`, so
there is no way to confine a pty's shell from outside it. Hence the launcher:
`ajar __confine <project> net -- /bin/zsh`.

### Tested by trying to escape it

Ten tests in `sandbox.rs` and an end-to-end run through a real guest session:

```
  ok    write inside the folder works
  ok    cannot write to the home directory
  ok    cannot read ssh keys
  ok    cannot delete outside the folder
```

The first version of those tests passed while proving nothing — the fixture
put its "outside" file in the system temp directory, which is deliberately
writable. Fixtures now live under `$HOME`, which is the location a host
actually cares about.

One test shares a folder called `we"ird`: SBPL string literals are
double-quoted, so an unescaped path would close the literal early and turn the
rest of the profile into something else entirely.

On Linux, `scripts/linux-sandbox.sh` runs nine attacks against a real kernel —
borrowing one from podman or docker when you are not on Linux, because
Landlock is a kernel feature and there is nothing to test without one. Three
of them are the ones that actually worried me, and Landlock resolves paths, so
none of them reach a hierarchy that was never granted:

```
  ok    cannot escape through /proc/self/root
  ok    cannot escape through a symlink out of the project
  ok    cannot escape with .. out of the project
```

That suite also caught a fixture bug that looked exactly like a product
failure. The fake home started out in `/tmp`, which is granted writable so
toolchains work — so the "hidden" home was fully visible and six checks
leaked. Real home directories are not under `/tmp`; the fixture was wrong, not
the sandbox.

### The dependency worth knowing about

`sandbox-exec` is marked deprecated by Apple with no announced replacement. It
is still the only documented way to apply a Seatbelt profile to an arbitrary
process, and it is on the critical path for every macOS host. Linux has no
equivalent worry: Landlock is a stable kernel ABI.

## The host's controls

The panel prints `[k] kick  [x] lock  [l] read-only  [q] close`. A key that is
drawn but does nothing is worse than one that is not drawn at all, so each is
enforced where it cannot be argued with:

| Control | Enforced by | Why there |
|---|---|---|
| **kick** | the relay | it owns the socket |
| **lock** | the relay | it is the only thing that sees a connection *before* the host does |
| **read-only** | the agent | a client that ignores the flag still gets its keystrokes dropped |

Locking seals the room without evicting anyone already in it, and everyone is
told it happened. `--read-only` also exists as a flag, for a lecture or a demo
that should start that way.

### A bug worth recording

Wiring these up surfaced something older and worse: **the relay's refusals
never arrived.** `send_error` queued a frame on the writer task and the code
immediately called `writer.abort()`, killing the task before it could flush.
Every refusal — wrong session, host already taken, session locked — reached
the client as a connection that simply timed out.

The fix is to drop the sender and await the writer instead of aborting it, so
the channel drains first. There is now a test that joins a session which does
not exist and requires an explanation rather than silence.

## End-to-end encryption

The key is generated by the agent, printed in the link's fragment (`#k=…`),
and never sent to a server — browsers do not transmit fragments. Content
channels are sealed with AES-256-GCM and a fresh random nonce per frame; the
control channel stays readable because the relay routes on it.

| Sealed | In the clear |
|---|---|
| Terminal input and output | Session id |
| The file tree, and file contents | Participant ids and roles |
| Document edits and cursors | Joins, leaves, locks |
| Who is watching which terminal | Frame sizes and timing |
| **Everyone's name** | |

Names were the last thing the relay could see. They used to ride in the
handshake, because that was where the relay assembled the participant list.
Now the handshake carries only a session id and a role, and a guest introduces
itself on the encrypted channel afterwards. Assembling the roster moved to the
host, which is the only party that can: the relay does not know a single
name.

A relay operator can see that a session is busy. They cannot see what is in
it — and the claim is stated that precisely rather than as "the server sees
nothing".

### Proved by recording the wire

`smoke-encryption.mjs` puts a TCP proxy between the agent and the relay,
keeps every byte, types a distinctive secret through a terminal, and then
requires it not to be in the recording:

```
  ok    the tap can read control frames, so it would have seen plaintext content
  ok    nothing typed appears anywhere in the captured traffic
  ok    filenames do not appear either
  ok    the key never crosses the wire
  ok    names do not appear either — they arrive after the handshake, sealed
  ok    the host still assembles a roster, because only the host can
  ok    a guest with the wrong key reads nothing
```

The first line matters more than it looks. **WebSocket masks client→server
payloads** with a per-frame key, so a substring search cannot find them
whether or not they are encrypted — a naive version of this test would pass
against a completely unencrypted build. The two directions are captured
separately, and the check that proves anything is the unmasked one coming back
from the relay. Requiring a readable control frame in that stream shows the
tap would have caught plaintext content had there been any.

### One thing that mattered more than it looks

WebCrypto is asynchronous and terminal bytes must keep their order, so both
directions run through their own promise chain rather than being awaited
independently. Sealing frames concurrently would let a later keystroke
overtake an earlier one, which is the kind of bug that would show up once a
week and never reproduce.

## The copy kept for when you drop

Losing your wifi used to make the folder go dead for everyone reading it. The
agent now keeps a sealed copy on the relay, and a guest falls back to it the
moment the host goes away.

| | |
|---|---|
| What is stored | Source files only — the same ignore rules as the tree, and nothing binary or oversized |
| Who can read it | Anyone with the link, because it is sealed with the session key. **Not the relay** |
| When it is used | Only while the host is away, and only read-only |
| When it is offered | After the folder has been still for five seconds — a copy for an outage does not need to be current to the keystroke |
| Limits | 25 MB and 5,000 files. Over either, sync switches off and says so |
| Lifetime | It dies with the session |

The read-only part is the invariant, not a limitation: **the host is
authoritative whenever it is online**, so a store that nobody can write to can
never disagree with it. That is the whole reason this design has no merge
problem to solve.

Refusing loudly matters more than it looks. A store that quietly kept the
first 25 MB would hand guests a workspace silently missing files, which is
worse than having no copy at all:

```
  not keeping a copy — 5200 files is over the 5000 file limit
```

And the host is told before the link is printed, not after:

```
  keeping a copy so guests can read while you are away — --no-sync to stop
```

`[d]` in the panel stops it at any time, and tells the relay to forget what it
already has.

### Still deferred

The copy dies with the session, so it covers an outage rather than a restart.
Surviving a restart needs stable identity — a device key the content key can
be wrapped to — which is written down as decision 12 and not yet built. And
the whole snapshot is re-sent rather than diffed; at 25 MB that is fine, and
chunked transfer is the obvious optimisation when it stops being.

## Deploying the relay

The relay is one small binary with no database and no persistent state —
sessions live in memory and die with them. That makes it the easy half: a
single box, and moving to a different one is repointing DNS.

```sh
./deploy/deploy.sh root@your-host --bootstrap   # first time
./deploy/deploy.sh root@your-host               # every time after
```

`deploy/` holds a Caddyfile (TLS, and nothing else), a hardened systemd unit,
and the script above. Caddy handles WebSocket upgrades without configuration,
which is most of why it is there rather than nginx.

### Put it near the people using it

The relay sits in the path of every keystroke: `guest → relay → agent → back`.
Latency to the relay is doubled and paid on every character.

| Relay location, for users in India | Keystroke to echo |
|---|---|
| Mumbai or Bangalore | ~20–40 ms |
| Singapore | ~200–250 ms |
| Germany | ~500–600 ms |

The cheapest host and the right host are usually not the same one. Pick the
region first, then the provider.

### Do not proxy the WebSocket through Cloudflare's orange cloud

Free and Pro plans close idle WebSockets after **100 seconds**. A terminal
nobody touches for two minutes drops. The agent reconnects and replays, so
nothing is lost, but guests see churn for no reason. Use Cloudflare for DNS
only on that subdomain, or add heartbeats first.

## Backpressure

Every connection has a bounded outbox, and one that falls too far behind is
**closed rather than fed a lossy stream**. Terminal output with holes in it is
worse than a clean disconnect: a client would render a corrupted screen with
no way to know. Dropping the socket puts it on the reconnect-and-replay path,
which is already tested.

| | |
|---|---|
| Accumulation cap | 8 MB, or 2,048 frames |
| One large frame | Always allowed when the queue is empty — a snapshot is legitimately megabytes |
| Inbound frames | Capped at 32 MB by the relay, above the 25 MB the store accepts |

The cap governs *accumulation*, not the size of any single frame. Refusing a
snapshot to defend against a problem snapshots do not cause would be breaking
a working feature for nothing.

Writing this found a bug in the first version of it: signalling an overflow
with `notify_waiters` alone wakes only tasks that are *already parked*, so an
overflow landing while the writer was mid-send vanished and the connection
limped on. It latches a flag now, checked before parking. There is a test
named after that failure.

## What a guest can spend

The sandbox decides which *paths* a guest can touch and has nothing to say
about processes — and a shell is a process factory. Until this existed, a
guest could fork-bomb the machine they were lent. For a product whose pitch is
"lend me your machine", that undercut the offer more than any file-access
question.

| | |
|---|---|
| Terminals | 12 per session, `--max-terminals` |
| Processes | 512, enforced at `fork`, `--max-processes` |
| CPU, memory, disk | **Not capped** — and the panel says so |

That last row is deliberate. `RLIMIT_CPU` would kill a long build, `RLIMIT_AS`
breaks anything that maps aggressively including `rustc`, and disk is hard to
bound portably. Those are recoverable; a machine that cannot fork is not. A
host who read "limits are on" and assumed memory was covered would be worse
off than one told plainly that it is not.

Applied with `ulimit` in a wrapper shell rather than a syscall — no `unsafe`,
identical on both platforms, and rlimits are inherited across `exec` so the
sandbox wrappers compose with it rather than fighting it.

## What one address can ask for

Opening a session needs no account and no invitation, which is the point and
also means a public relay would accept sessions from anyone until it ran out
of memory.

| | |
|---|---|
| Open at once | 8 per address |
| Started per minute | 20 per address |
| Joining a session | Unmetered — a guest already needs the link |

Only *opening* is metered. Rationing the people a host invited would be
limiting the wrong side.

The slot is a Drop guard rather than a matching `release()` call, because the
handshake has several ways to fail after a slot is taken — a session id
already in use, most obviously — and every one is a path where a manual
release is easy to forget. Forgetting leaks an address's allowance to sessions
that never existed.

Behind a proxy, every connection is the proxy. `--trust-forwarded-for` reads
`X-Forwarded-For` instead, and should only be on when something you control
sets that header — otherwise any caller can claim any address and the limits
become decorative.

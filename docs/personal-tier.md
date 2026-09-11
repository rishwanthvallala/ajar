# The personal tier

*Design notes, September 2026. A second product on the same domain: a shared
browser scratchpad with a real shell, no install, no account, and no machine
involved but the ones the participants are already sitting at.*

---

## What this is

Open a URL. Paste something. Run it. Send the link to someone and they carry on
from where you left off, while you watch.

The compute runs in each participant's own tab as WebAssembly, so there is no
agent, no host machine, and nothing to lend. The server stores files and serves
`.wasm` packages — it never executes anything.

**It is not ajar.** ajar shares *someone's actual machine*: their toolchain,
their GPU, their database connection, and the bug that only reproduces there.
This shares a folder and runs it in a clean sandbox with a documented set of
binaries. Same domain, same audience, different architecture.

---

## The north star: instant usability

The benchmark is **rustpad.io**. You open it and you are typing. No signup, no
project wizard, no template picker, no decision of any kind before the thing is
useful.

The primary loop, because it should drive every decision below:

> **Paste → Run → Look at the output.**

Not "write a program from scratch." The realistic session is: you have Python
in your clipboard — often written with an AI's help — a CSV or three, and you
want the transformed output. Anything that delays the first paste is wrong.

---

## Open by default; the lock is what publishes

This is the polarity, and an earlier draft of this document had it backwards.

**Unclaimed is the normal state, and unclaimed means everyone edits.** Anyone
with the link can write files, run the shell, and change anything — and
everyone watching sees it happen. That is rustpad's model and it is the one
consistent with instant usability.

**Claiming is a lock.** It is the thing you do when the work is finished and
you want to hand it out without anyone changing it. After the lock, you edit
and everybody else reads and runs.

| State | Anyone with the link can |
|---|---|
| **Open** (default) | edit, run, add files — and see each other live |
| **Locked** (deliberate) | read, run locally — nothing they do persists |

So the claim is not how you get write access. It is how you take write access
*away from everyone else*.

### Entry has no decisions in it

| Path | What happens |
|---|---|
| **Fast** (default) | Landing mints a random name and drops you into a focused editor. Pasting within a second. Open to anyone you send it to. |
| **Vanity** | You type `/demowork` yourself. Free names are yours to use; taken ones say so. |
| **Lock** | A deliberate action, whenever you decide the work is done. |

---

## Decisions locked so far

### Runtime: Wasmer SDK + WASIX

`@wasmer/sdk`, open source, from npm. WASIX is Wasmer's POSIX superset over
WASI Preview 1, adding **threads, fork, exec, pipes and TTY** — the things
standard WASI deliberately omits and the things a shell cannot work without.
`wasmer.sh` already runs bash, Python, ffmpeg and clang in a browser tab, so
this is a shipping capability rather than a bet.

**What it costs:**

- **Cross-origin isolation.** Threads need `SharedArrayBuffer`, which needs
  `COOP`/`COEP` headers on the document. This is per-document, so it must live
  on a **separate origin** from the ajar session client — otherwise that client
  inherits the isolation and every cross-origin thing it loads needs `CORP`
  headers or fails silently.
- **A non-standard dependency.** WASIX is Wasmer's extension, not a committee
  standard, and WASI Preview 2 is explicitly not heading there — the Component
  Model replaces the process model rather than completing it. If Wasmer stops,
  this stack stops. Accepted, not overlooked.

### Files: plaintext on the server

ajar sessions stay end-to-end encrypted. Personal folders do not.

The URL is the clean one — `ajar.rishwanth.dev/demowork` — which means the
server can read what you store. Right trade for scratch work and CSVs, wrong
one for secrets, and the interface has to say so rather than letting the ajar
brand imply an encryption story that does not apply here.

**The relay's snapshot store cannot be reused.** It is in-memory, attached to a
live session, and `host_gone` calls `sessions.remove(id)` — files die with the
host by design, and that code calls "a restart drops everything" *correct*
rather than tolerable. This tier needs durable storage, no host, indefinite
lifetime. New machinery, though small: a blob keyed by name, capped around
25 MB.

### One shared filesystem, last write wins

Everyone in a folder sees one filesystem. A file written by anyone's shell
appears for everyone. When two writes race, the later one wins.

This is the ambitious option and it was chosen deliberately over "your run is
private." It is what makes *"they can continue or improve my work"* literally
true rather than approximately true. It also brings four problems that the
private-run model would not have had.

**1. Text files and shell writes need different merge rules.**

`transform.py` open in two editors is a CRDT document — Yjs handles concurrent
typing properly. But a shell can also write that same file (`sed -i`, a
formatter, a generator). An LWW blob write landing on a live CRDT document
would clobber whatever the other person was typing.

This is exactly the problem `docs.rs` already solves for ajar, where the disk
is a third editor alongside two humans. The answer there is `reconcile()`:
compute the one splice that turns the old text into the new, fold it into the
CRDT, never replace wholesale. The reasoning transfers directly even though the
code does not.

**2. "Last" needs a clock, and browsers do not have one.**

Wall clocks across machines are skewed, and a user can set theirs to anything.
The server is already in the path holding the files, so **the server assigns
the ordering** — a sequence number per write. Simple, and correct enough for a
scratchpad.

**3. A losing write disappears silently.**

Two people run the same script at the same time; both finish; both push
`out.csv`. One result vanishes, and the loser may not notice, because the file
*looks* freshly updated.

There is no fix inside LWW — that is the trade. The mitigation is to make it
visible: show who last wrote each file and when. Cheap, and turns a silent loss
into an obvious one.

**4. One command can write a thousand files.**

A build, an unpack, anything that generates output at scale. Broadcasting a
thousand individual file writes to everyone in the room is the same packet
storm `watch.rs` was written to prevent — it buffers touched paths, flushes a
few times a second, and past a threshold stops describing changes and asks for
a full resync instead. Same solution applies here, on a different event source.

### Detecting the writes: diff at command boundaries

**There is no watch mechanism to hook.** `@wasmer/sdk`'s `Directory` exposes
`writeFile`, `readFile`, `removeFile`, `createDir`, `removeDir` and `readDir`
— and nothing else. Asking it to emit change events is
[an open issue](https://github.com/wasmerio/wasmer-js/issues/395), not a
feature. So "intercept every write" is not a design option without forking the
runtime the whole product stands on, which is not a debt worth taking before
v0 has proven anything.

So: **when a command exits, diff the tree and push what changed.** A command
exiting is a real transaction boundary — it either ran or it did not, and a
half-written file is never broadcast.

Two details that decide whether this is cheap or ruinous:

- **Diff against the last synced state, not a before/after pair.** The client
  already holds what it last agreed with the server. Snapshotting the tree
  before every command would double the memory for nothing.
- **Walk metadata, not content.** Keep `path → (size, hash)`. A thousand
  unchanged files then cost a thousand comparisons rather than a thousand
  reads, and `readFile` is called only for what actually differs.

And it needs the caps `workspace/mod.rs` already learned to want. A `pip
install` inside the shell can create thousands of files, after which *every*
later command pays to walk them. So: a ceiling on entries, and the same
"too much changed, resync instead of enumerating" threshold.

**What this knowingly gives up:** a process that never exits never syncs. A
dev server, a `--watch`, anything streaming — it writes continuously and
nobody else sees a thing until it is stopped. That is acceptable for
paste-run-look and wrong for a live preview, and the interface should say so
plainly rather than letting people discover it. Adding a slow poll during a
running command covers it later without changing anything else here.

---

## Claim, lease, account

Locks are **leases**. A week, renewable by visiting. Accounts make them
permanent, with a per-account cap on locked names, and paid tiers above it.

This is the first revenue mechanism anywhere in the project. Phase 3 — org
hosts, accounts, billing — was never built for ajar, so the side product would
ship billing before the main one.

The lease is self-cleaning: abandoned folders age out without anyone deciding.

### Four fixes folded in

**1. Names are never reused.** The important one.

You share `/demowork` in a tutorial; the lease lapses a week later; someone
else claims the name; everyone holding your link now lands on a stranger's
files. If stored HTML ever rendered, that is a phishing page on your domain.

So expiry deletes the **content** and tombstones the **name**. `/demowork`
afterwards says "this expired" forever. A name is about twenty bytes; keeping
every one ever issued is free next to the problem it removes.

**2. Locking is a POST, never a GET side effect.** Slack, iMessage, WhatsApp
and Twitter fetch URLs to unfurl them, and crawlers fetch everything. Nothing
that changes state can happen because a page was merely opened.

**3. Lease state has to be durable, and IP limiting is a speed bump.**
`quota.rs` is `Mutex<HashMap<IpAddr, Caller>>` and its own header says it does
not survive a restart — correct for 45-second sessions, useless for week-long
leases. And IP as identity is weak both ways: CGNAT puts thousands of real
users behind one address, while a VPN defeats it in one click. Worth having
against casual bulk-claiming, not worth believing in.

**4. Stored files are never served as HTML.** By construction, files are
fetched by JavaScript and mounted into the WASM filesystem — never a browsable
web root. Worth protecting deliberately, because the day `…/name/index.html`
renders is the day this hosts arbitrary user HTML on the product's domain.

### Reserved names

`/ws`, `/healthz`, `/install.sh`, `/run.sh` and `/j/*` are taken, and a bare
path currently falls through to the SPA. The reserved list has to exist
**before** the first claim — it cannot be applied retroactively once someone
owns `/api`.

---

## What is reusable from ajar

The shared-filesystem decision made this much stronger. Three of the hard
sub-problems are ones ajar has already solved, because they are the same
problems wearing different clothes.

| From ajar | Reuse |
|---|---|
| `web/src/style.css` (587) | **Direct.** Layout, splitter, zoom-safe sizing. |
| `web/src/viewer.ts` (167) | **Direct.** Monaco setup, language map, already trimmed. |
| `web/src/tree.ts` (220) | **Direct.** Virtualised; only the data source changes. |
| `web/src/scale.ts` (31) | **Direct.** |
| `web/src/editing.ts` (218) | **Core now.** The Yjs/Monaco binding with cursors — written by hand precisely so it could be repurposed. |
| `crates/ajar/src/docs.rs` reasoning | **The `reconcile()` splice**, for shell writes landing on live documents. |
| `crates/ajar/src/workspace/watch.rs` reasoning | **Coalescing and the resync threshold**, for write storms. |
| `web/src/main.ts` (851) | **Partial.** Layout and wiring survive; relay-shaped parts do not. |
| `connection.ts`, `proto.ts`, `sealed.ts` | **No.** Relay-specific. |

xterm.js is already wired for terminal output, and a WASIX shell writes to it
exactly the way a pty does.

---

## Settled since

**Transport is the relay.** Extended rather than replaced: a session now has a
*shape*, and a `Peer` session is N browsers with no centre, everyone reaching
everyone else by broadcast. Peers stamp their own participant id on every
frame, a name nobody holds can simply be opened, an empty room is forgotten
rather than held open, and one id is one shape for its whole life. Shipped in
`586eb2f`, with `scripts/smoke-peer.mjs` — the first suite here that starts a
relay and no agent at all.

## Open questions, in the order they should be answered

1. **How big is the first load, and what happens during it?** Pyodide alone is
   ~10 MB. Instant usability and a 10 MB download are in direct tension — does
   the editor open before the runtime is ready, with the shell arriving late?

2. **What is in the binary set, and how is a version pinned?** Python first.
   Which coreutils? Is there any `pip install` without sockets, or is the answer
   a pre-baked, documented wheel set?

3. **What does "run" mean in the interface?** Button, keystroke, or a prompt you
   type into. The paste-run-look loop wants the fewest actions between clipboard
   and output.

4. **What is the file size cap, and does every write really sync?** A 50 MB
   `out.csv` broadcast to four people on every run is a different product from
   a 50 KB one.

5. **Account system: build or buy?** The first one in the project, and the thing
   most likely to consume a month if built from scratch.

6. **Domain, subdomain, or separate name?** Cross-origin isolation forces at
   least a separate origin; shared branding is a different question.

---

## Shape of a v0

Enough to find out whether the loop is worth anything:

- One page, separate origin, `COOP`/`COEP` set.
- Landing mints a random name and drops you into a focused editor.
- Python only. No vanity names, no accounts, no locks — everything is open and
  everything expires in a week.
- Shared filesystem, server-ordered, last write wins.
- One editor pane, one output pane, one run action.
- Share copies the bare URL.

If pasting a transform, getting a CSV back, and sending the link to one person
is not obviously useful at that size, none of the machinery above will save it.

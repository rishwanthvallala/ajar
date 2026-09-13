# Open points

*Kept as of 14 September 2026, after PR #2 merged and deployed.*

Things known to be unfinished, unfixed or undecided. Written down so they stay
visible rather than being rediscovered. Each one says what is actually true,
not what would be nice.

---

## Waiting on a decision

### Three inbound SSH rules, now that SSM exists

Port 22 is open to `49.205.207.206/32`, `49.37.152.176/32` and
`49.205.200.226/32` — one presumably current, the other two left over from
addresses that have moved on. Read from the live security group on 14
September, not from memory.

Session Manager is set up and working. The instance carries the
`ajar-relay-ssm` instance profile, the agent reports Online, and
`aws ssm start-session --target i-0ffebdae47c7b633d` lands a shell as
`ssm-user` without touching port 22.

What stops 22 closing today is [`deploy/deploy.sh`](../deploy/deploy.sh), which
drives `ssh` and `scp` directly. An SSH-over-SSM `ProxyCommand` would let it
keep working unchanged with nothing inbound at all. That is the remaining
piece, and it wants a verified deploy through it before any rule is removed —
closing 22 first would mean discovering the gap during an outage.

---

## Deliberate gaps in the pad's v0

These are scope, not defects. They are listed because "we chose this" and "we
missed this" look identical a month later.

**No accounts, no locks, no vanity names.** Everything is open to whoever has
the link, and a folder untouched for a week is deleted. The design in
[`personal-tier.md`](personal-tier.md) — a week-long lease without an account, a
permanent claim with one, per-account limits and some IP-based ceiling on
anonymous locks — is designed and unbuilt. A name is never reused after
expiry, so a link in a tutorial can never later resolve to a stranger's files.

**Empty folders do not survive a reload.** Directories are derived from the
paths under them, so one with nothing inside has nothing to imply it. The tab
that made it keeps it visible until something lands there; nobody else ever
sees it.

**`find` exits 1** after doing its work, unable to restore its working
directory under WASIX. Output is correct, so only `find … && …` is affected.

**A process that never exits never syncs.** The folder is published at command
exit, which is a real transaction boundary — it either ran or it did not, and a
half-written file is never shared. The cost is that a dev server's output is
invisible to everyone else. Fine for paste-run-look; wrong for anything
long-running.

**Nothing in a pad is encrypted.** ajar sessions are end-to-end encrypted and
the relay holds no plaintext; pads are stored in the clear, which is the trade
for a URL anyone can open. Decided deliberately —
"for agent it'll be encrypted, but for the personal type, we can let it be
clear and its fine."

**No network from the sandbox.** A browser cannot open a TCP socket, so there
is no `pip install` and no `git clone`, permanently. The pinned binary set is
what removes that from the critical path.

---

## Designed, not started

**Preview URLs for ajar.** A guest runs `npm run dev` and cannot reach the
thing they started. This was named the most urgent hole in the retrospective,
and again at the end of
[`wasm-in-the-browser.md`](wasm-in-the-browser.md), and it is still open. It is
a hole in the loop that already works, it serves the users who are already
here, and it costs a fraction of a new tier.

---

## The one that settles more than the rest

Use it with a colleague, on a real bug, twice.

Everything above is a judgement made without that. Two sessions with somebody
who did not build it would reorder this entire document, and nothing in the
test suite can stand in for them.

---

## A note on how these were found

Of the seven real bugs fixed or found in the last two rounds, none came from
using the product and all came from reading it or measuring it. The audit found
six; the live verification found the seventh, which no local test could see.

The recurring hazard is checks that pass for the wrong reason — nine so far in
this project. The pattern is consistent: whenever the thing under test can
produce the passing evidence by accident, the check proves nothing. Reverting
the fix and watching the check fail is the only habit that has reliably caught
them.

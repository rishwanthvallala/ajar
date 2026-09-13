# Open points

*Kept as of 14 September 2026, after PR #2 merged and deployed.*

Things known to be unfinished, unfixed or undecided. Written down so they stay
visible rather than being rediscovered. Each one says what is actually true,
not what would be nice.

---

## Waiting on a decision

### Command substitution kills the shell

`x=$(echo hi)` exits 130 — SIGINT — and takes bash with it. The next command
starts in a fresh shell at the folder root, so the working directory and every
variable are gone. Confirmed on code.rishwanth.dev, not just locally.

`$(date)`, `$(ls)`, `$(cat f)` are ordinary things to type, so this is a live
defect rather than a limitation. It is the same shape as the documented
ctrl-c behaviour — an interrupt bash does not survive — and probably the same
cause. The probe asserts it (`sharrattj/bash`, "command substitution"), ordered
last because everything after it in one shell reports "the shell has exited".

### `sort` is broken in the shipped coreutils

`printf 'b\na\n' | sort` prints the multi-call binary's usage instead of
sorting. `tail -n 1`, `tail -1`, `split`, `sha256sum`, `md5sum`, `stat` and
`du` fail too — `sharrattj/coreutils` is uutils 0.0.7, not GNU. `ls | sort` is
something people type.

Fixing it needs a different coreutils. `kilyanni/coreutils` is GNU 9.11 at half
the size, and cannot currently be installed — see
[dev/pad.md](dev/pad.md#probing-a-package-before-shipping-it).

---

## How to reach the server

There is no inbound SSH. Port 22 was closed on 14 September; the security
group allows 80 and 443 only.

```sh
ssh ajar-relay                                        # ssh, scp and rsync, tunnelled
aws ssm start-session --target i-0ffebdae47c7b633d     # a shell as ssm-user
```

`~/.ssh/config` points `ajar-relay` at the instance id with an SSM
`ProxyCommand`, so `deploy/deploy.sh` runs unchanged — a full deploy was
verified through the tunnel before the port was closed. `SSH_CONNECTION` on the
far side reads `127.0.0.1`, because the connection is handed to sshd by the
agent rather than arriving from outside.

**If SSM ever fails**, this is reversible from the AWS API without any access to
the instance — which is what made closing the port a small decision rather than
a large one:

```sh
aws ec2 authorize-security-group-ingress --group-id sg-00195dc456fe6c099 \
  --ip-permissions 'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=<your ip>/32}]' \
  --profile personal --region ap-south-1
```

The `ajar-relay-direct` host in `~/.ssh/config` still points at the address, so
it works again the moment a rule exists. The thing that must not be lost is the
AWS credential itself — `~/.aws/credentials`, profile `personal`.

A deeper break-glass exists and is not set up: `t4g` is Nitro, so EC2 Serial
Console works, but it needs a password on an OS user.

---

## Deliberate gaps in the pad's v0

These are scope, not defects. They are listed because "we chose this" and "we
missed this" look identical a month later.

**No accounts, no locks, no vanity names.** Everything is open to whoever has
the link, and a folder untouched for a week is deleted. The design in
[`personal-tier.md`](history/personal-tier.md) — a week-long lease without an account, a
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
[`wasm-in-the-browser.md`](history/wasm-in-the-browser.md), and it is still open. It is
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

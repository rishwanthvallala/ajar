# Open points

*Kept as of 16 September 2026, after egress shipped and `pip install` began working.*

Things known to be unfinished, unfixed or undecided. Written down so they stay
visible rather than being rediscovered. Each one says what is actually true,
not what would be nice.

---

## Waiting on a decision

### Tools that do not fully work

From `npm run probe --workspace=ajar-pad`, which installs each package and
exercises its capabilities.

| | |
|---|---|
| `lua` | Does not start; even `lua -v` exits 45. The only published build |

That is the whole list, and it is now one line long. `sort`, `tail`, `split`,
`stat`, `du`, `sha256sum` and `md5sum` were on it until they became python
shims, along with twenty more commands that had no port at all.

**`find` is a shim as of 15 September**, which closed the last entry above. The
shipped findutils binary had two faults it could not be talked out of: `-exec`
produced nothing because it cannot spawn, and every run exited 1 having done
the work and then failed to restore its working directory. Both were invisible
until something was chained onto a search, at which point a correct result
looked like a failed one. It supports `-name`, `-iname`, `-path`, `-type`,
`-size` (with GNU's round-up), `-empty`, `-maxdepth`, `-mindepth`, `-print`,
`-print0`, `-delete`, `-exec` with both `;` and `+`, and `!` / `-o` / `-a` with
parentheses.

It hides `.ajar/` from a walk, the directory the shims themselves live in —
found by running it against live, where `find . -name '*.py'` listed five files
nobody wrote.

One limit is worth knowing: **`-exec` can only run real binaries.** Every tool
in `box.py` is a shell alias, and a spawned process does not inherit those, so
`find . -exec tree {} \;` cannot work however much it looks like it should. It
says so rather than failing as a traceback.

**`git` works and needs `--no-pager`.** `git log` alone spawns a pager that
does not exist and exits 79 with no output, which is indistinguishable from a
commit that never happened and was reported that way here before being
diagnosed. Shipping git means setting `GIT_PAGER=cat` in `shell.ts`.

**Not shipped, working, and each a first-load decision of its own:** `node`,
`npm` and `pnpm` at 73.7 MB, `php` at 81.7, `git` at 85.1, `clang` at 104.3 —
against a mirror that is currently 80 MB.

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

**The network reaches PyPI and nowhere else.** `pip install` works as of 15
September; everything else is refused by the endpoint's allowlist. The pinned
binary set is still what keeps the network off the critical path — nothing in
the pad needs it to work.

---

## Built, with the parts that are still open

### The pad's network

**Built and live as of 15 September.** `pip install` works from a pad, against
our own WISP endpoint at `wss://code.rishwanth.dev/wisp`. The decision about
whose machine carries the traffic was settled by making it an allowlist rather
than a proxy: PyPI on 443 and nothing else, with private and link-local
destinations refused in the software filter and again by the unit's
`IPAddressDeny=`. See [dev/networking.md](dev/networking.md).

What is still open about it:

**A multi-dependency install stops the sandbox.** `pip install six` is
reliable. `pip install requests`, which pulls four more packages, ends with the
SDK worker dying — `WebAssembly.Module.imports(): Argument 0 must be a
WebAssembly.Module`, after a run of `received a DATA packet for a stream which
doesn't exist` from the wisp client. The runtime goes with it and the tab needs
a reload. It is not asserted in `wisp-check.mjs` because it does not fail there,
it hangs, and takes every check after it. Whether this is concurrency in the
wisp client, memory, or the SDK's worker is unknown.

**Nothing rate-limits the endpoint.** `stream_limit_total` is 32 per
connection, and there is no limit on connections. Caddy has no rate limiting
without a plugin. A pad is anonymous, so there is nothing to attribute use to.

**`bind()` under the wisp policy is unmeasured.** The preview works in
production, which is the ingress that matters, but that syscall has not been
run under this policy — the networking table says so rather than guessing.

Measured in full in [dev/networking.md](dev/networking.md), including the
undocumented COEP header the preview origin needs and the three wrong answers
it took to get there.

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

Almost none came from using the product. They came from reading it, measuring
it, or running it against the deployed site — which is a different thing again,
and the one that keeps paying: `find .` listing five files nobody wrote, a pad
opened from a link coming up empty, and the preview's own origin were all
invisible locally.

The recurring hazard is checks that pass for the wrong reason — sixteen so far,
plus two that *failed* for the wrong reason and cost more than any of them. The
pattern never changes: whenever the thing under test can produce the passing
evidence by accident, the check proves nothing. Reverting the fix and watching
the check fail is the only habit that has reliably caught them, and it has one
failure mode of its own worth knowing — a revert that does not compile leaves
the previous build in place, and the check then measures the fix it was meant
to be deprived of. See [dev/testing.md](dev/testing.md).

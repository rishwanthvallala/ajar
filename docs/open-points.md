# Open points

*Kept as of 24 September 2026. Four of five hardening steps are done and
pushed — see [handoff-2026-09-24.md](handoff-2026-09-24.md). The sandbox and
reconnect items below were found and partly fixed the same day.*

Things known to be unfinished, unfixed or undecided. Written down so they stay
visible rather than being rediscovered. Each one says what is actually true,
not what would be nice.

---

## Waiting on a decision

### Bandwidth, and the DNS rate, both wait on one plugin

Every cache-cold pad visitor pulls **19 MB** of wasm, and Caddy serves it off
disk without the relay seeing the request — so nothing in the relay can limit
it. `/dns-query` is bounded in shape and size but not in frequency, for the
same reason.

Both need the Caddy rate-limit plugin, which is step 5 of the hardening work
and the only piece not done. Procedure in
[dev/operations.md](dev/operations.md#adding-the-caddy-rate-limit-plugin).

### Two things the September review left untested or unbounded

From the 22-finding review merged as PR #3 — the findings are in
[code-review-2026-09-16.md](code-review-2026-09-16.md) and what was done about
each in [code-review-fixes-2026-09-16.md](code-review-fixes-2026-09-16.md).
Both of the below were implemented; neither is finished.

**The relay's control-frame refusal has no test.** Guests and peers can no
longer originate a control frame after the handshake — forwarding malformed
cleartext control used to terminate the host — but nothing exercises it. The
end-to-end smokes only ever have the *host* send control frames, so a
regression here would pass the gate. Seven relay tests came with that work;
this is not one of them.

**A few slow readers can still make pad reads wait.** Reads are streamed from
disk now, so they no longer cost memory, and they are held to 32 in flight per
address and 64 in all. A handful of addresses each holding 32 unread responses
fill the 64, and everyone else waits ten seconds and is told the server is busy.
That is an availability problem for the pad rather than a threat to the relay,
and it is the same shape a slow uploader already has against the four write
permits. A deadline on a response still being sent would close it.

### The sandbox still lets a guest reach key-holding sockets

The environment variables are withheld now, but the sockets they named are
still reachable by path: an ssh agent in a temp directory a guest can list, the
gpg agent and the session bus under `/run/user`, Docker's socket. The agent
measures each through the real sandbox and warns about every one a guest can
reach — so the host is told — but nothing refuses them yet.

| | What would refuse them |
|---|---|
| Linux | Landlock ABI 9 (`ResolveUnix`, Linux 7.1). Not reached for until `linux-sandbox.sh` has run on a kernel that has it |
| macOS | Seatbelt `network-outbound` denials on those paths. Needs writing and verifying on a Mac; nothing here can run one |

### Found reading the code on 24 September, not fixed yet

Each is from reading, not from a failing check, and each wants one written
before it is touched.

| | Where |
|---|---|
| The panel's kick takes one digit, and ids are never reused — every reconnect burns one — so a guest numbered 10 or more cannot be kicked | `ui.rs` `interpret` |
| Read-only covers terminals only: document edits are applied and written to disk regardless | `main.rs` doc channel, `web/src/main.ts` `startEditing` |
| A stored copy over about 8 MB never reaches a guest: its header and blob are queued back to back, and the outbox refuses the second once the first makes the queue non-empty | `ws.rs` store fetch, `outbox.rs` `send` |
| A socket that never sends `hello` is charged to no quota and has no timeout | `ws.rs` handshake |
| The watcher's filter reads only the root `.gitignore` and `.ignore`; the scanner also honours nested ones, global excludes and `info/exclude`, so changes there reach guests until the next resync | `workspace/filter.rs` |
| In the pad, a trailing comment, a pasted `# …` line or a syntax error swallows the end-of-command sentinel and hangs the terminal until ctrl-c | `pad/src/shell.ts` `run` |
| A cursor's `user.id` goes into a stylesheet unescaped — the name was fixed, the id was not. In the pad anyone with the link can send one | `web/src/editing.ts`, `pad/src/editing.ts` `drawCursors` |
| The checkpoint leaves out untracked files, and "files changed" is measured against HEAD, so the host's own earlier edits are reported as the guest's | `checkpoint.rs` |

### Scoped signals refuse `kill` across terminals

Each terminal is its own Landlock domain, so from Linux 6.12 a guest cannot
signal the agent or anything else the host runs — and also cannot `kill` a
server started in a *different* tab. That was the trade taken, and it is one
line (`Scope::Signal`) if it turns out to be the wrong one. Sharing one domain
across terminals would need a single confined parent that spawns every shell.

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
the link, and a folder nobody opens or edits for 90 days is deleted (it was a
week, counting only edits, until 25 September). The design in
[`personal-tier.md`](history/personal-tier.md) — a week-long lease without an account, a
permanent claim with one, per-account limits and some IP-based ceiling on
anonymous locks — is designed and unbuilt. A lapsed name is free again, so an
old link opens an empty folder or somebody else's newer one; until 24 September
it was sealed for good instead, which turned `/demo` into a permanent 410.

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

### `playwright` is declared in the wrong workspace

`web/package.json` declares it and nothing in `web/` uses it; the root
`scripts/` use it while declaring nothing, and work only because npm workspaces
hoist. `pad/` declares and uses its own.

Left alone deliberately. Fixing it means editing a `package.json`, which means
regenerating `package-lock.json`, which on a mac strips every platform binary
out of it — see [dev/operations.md](dev/operations.md#do-not-casually-regenerate-package-lockjson).
The declaration being in the wrong place costs nothing today; a lockfile that
only builds on one platform costs a CI run and an afternoon.

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

The recurring hazard is checks that pass for the wrong reason — twenty-one so far,
plus two that *failed* for the wrong reason and cost more than any of them. The
pattern never changes: whenever the thing under test can produce the passing
evidence by accident, the check proves nothing. Reverting the fix and watching
the check fail is the only habit that has reliably caught them, and it has one
failure mode of its own worth knowing — a revert that does not compile leaves
the previous build in place, and the check then measures the fix it was meant
to be deprived of. See [dev/testing.md](dev/testing.md).

# Open points

*Kept as of 2 October 2026. The relay, both browser clients and the deploy
config were deployed from `5b14947` on 24 September: four of the five hardening
steps, the sandbox and reconnect fixes that reach the browser, streamed pad
reads, freed pad names and the 90-day lease. The fifth step, per-address limits
in a Caddy built with the rate-limit plugin, followed on 25 September. The agent's halves — Landlock ABI
6, the withheld environment, process headroom, reconciling after its own blip —
shipped in v0.0.4 on 25 September. A host still on v0.0.3 has none of them
until it reinstalls. v0.0.5, the same day, lets a guest's shell source the
toolchain setup a host's rc files name — without it every guest terminal on
Linux opened with `Permission denied`.*

*On 2–3 October every item here that code could close was closed — see
[the list at the end](#closed-on-23-october). The agent's share of that reaches
hosts with the release after v0.0.5; the relay, both clients and Caddy deploy
as usual.*

Things known to be unfinished, unfixed or undecided. Written down so they stay
visible rather than being rediscovered. Each one says what is actually true,
not what would be nice.

---

## Waiting on a decision

### Unexplained once, and now able to explain themselves

**`smoke-editing` failed once.** *Terminal 1 never became ready*, on 24
September, and it has passed every run since. If it recurs, `ready()` now says
what the terminal showed, or that it was never opened; the shell's startup
under load is still the first suspect.

**A first pad visit waited 114 s once.** On 25 September one first visit in
seven took 114 s from Run to output, with the python download done in 2.3 s.
`scripts/perf/pad-visit.mjs` now prints every request and console line for a
Run slower than 15 s or one that never finishes. The suspect is below.

### The pad's runtime cannot start without registry.wasmer.io

Only the packages' bytes are mirrored. On every start the runtime asks
`registry.wasmer.io` where each package is — ten lookups, one after another,
about three seconds of a cold Run — and nothing here holds those answers. On 2
October they failed intermittently from one network: three local runs in eight
stopped at `unable to load package wasmer/bash … Could not fetch
registry.wasmer.io/graphql`, always on the coreutils lookup, and one first visit
to production never answered Run in four minutes. When one fails the terminal
says so and Run never does.

The answers for pinned packages do not change, so they can be mirrored like the
bytes: `fetch-packages.mjs` records them and the service worker serves them,
falling through to the registry only for what it has not seen. Not done yet.

### Still unbounded or unexplained

From the 22-finding review merged as PR #3 — the findings are in
[code-review-2026-09-16.md](code-review-2026-09-16.md) and what was done about
each in [code-review-fixes-2026-09-16.md](code-review-fixes-2026-09-16.md).

**The guest-counting limits test lost its shell four times, unexplained.**
`a_guests_own_processes_do_not_raise_their_ceiling`, on 25 September, in WSL:
the stand-in guest's shell was missing from `/proc` for the whole five seconds
the test waits, and none of its children outlived it. Every run with
instrumentation added passed. The assertion now says whether the shell had
exited, was running, or could not be waited for — the first version folded the
last into "still running" — so a recurrence explains itself.

**The process cap cannot see tasks outside the agent's pid namespace.** The
kernel charges `RLIMIT_NPROC` to the uid across every pid namespace; `in_use`
reads `/proc`, which shows one. Under WSL about 35 tasks for the same uid are
invisible, and they come out of a guest's 512. Harmless at that size; an agent
run in a container whose uid is also busy outside it would be back to the
original bug.

**Readers that keep asking can still fill the pad's read slots.** A reader that
*stops* is closed by the kernel after a minute now (`TCP_USER_TIMEOUT`), which
frees its slots. Two addresses that open 32 large reads each and re-open them as
they are closed can still keep the 64 busy; that is a rate problem the per-address
limit bounds rather than a stall, and the same shape a slow uploader has against
the four write permits.

### On Linux the sandbox still lets a guest reach key-holding sockets

The environment variables are withheld, but the sockets they named are still
reachable by path on Linux: an ssh agent in a temp directory a guest can list,
the gpg agent and the session bus under `/run/user`, Docker's socket. The agent
measures each through the real sandbox and warns about every one a guest can
reach, so the host is told. **macOS refuses them since 2 October** — Seatbelt
`network-outbound` denials, verified on a Mac against a real listener.

| | What would refuse them |
|---|---|
| Linux | Landlock ABI 9 (`ResolveUnix`, Linux 7.1). Not reached for until `linux-sandbox.sh` has run on a kernel that has it |

### On a macOS host, a guest cannot run `top`

`bash: /usr/bin/top: Operation not permitted`, from a guest's terminal on
GitHub's macOS runner, found by `scripts/check-terminal.mjs` on 25 September.
The Seatbelt profile allows every exec. It is macOS refusing to start, inside
a `sandbox-exec` sandbox, a binary that carries system entitlements — `top`
reads other processes. Other tools of that kind (`ps`, `lsof`) have not been
tried and may do the same. It is the price of the sandbox rather than a rule
of ajar's, and the check leaves `top` out on macOS rather than failing on it.

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

**Nothing limits the bytes.** Streams, open tunnels and new tunnels are all
bounded — 32 per tunnel, 8 open per address, 30 opened a minute — but not what
flows through them. A pad is anonymous, so there is nothing to attribute a
download to beyond its address.

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

---

## Closed on 2–3 October

Each with a check that fails without it, revert-tested.

| | Commit |
|---|---|
| Read-only covered terminals only; a guest's edit to a file was applied, broadcast and written to disk | `d52f69d` |
| A cursor's id went into a stylesheet unescaped — `1 {} body { display: none }` blanked the page | `8ffe031` |
| A socket that never sent hello had no deadline and no quota | `456e4a6` |
| A stored copy over 8 MB never reached a guest — header and blob were judged separately | `456e4a6` |
| The relay's refusal of guest control frames had no test | `456e4a6` |
| The panel's kick took one digit, so guests numbered 10 or more could not be removed | `ef117b8` |
| The checkpoint left out untracked files, and "files changed" counted the host's own earlier edits | `a8f138e` |
| The watcher read only the root's ignore files; nested ones, `info/exclude` and global excludes reached guests | `178ab36` |
| A macOS guest could read the host's shell and REPL history | `9bc7b84` |
| A macOS guest could use the host's ssh agent, gpg agent and Docker | `9bc7b84` |
| A pad newcomer whose room answered in over 600 ms seeded a second, diverging document | `d4198ad` |
| A few stalled readers could hold every pad read slot | `749f33e` |
| A pad file went blank while its document arrived, and typing then landed wherever the merge put it | `ab9a5cd` |
| Caddy's 30 first visits an hour per address turned away the thirty-first person on one network | `2de0243` |

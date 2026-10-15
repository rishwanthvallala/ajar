# Open points

*Kept as of 8 October 2026. The relay, both browser clients and the deploy
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
[the list at the end](#closed-on-23-october). The agent's share of that shipped
in v0.0.6 on 3 October. Accounts were deployed on 4 October with sign-in
live; what closed then is in [its own list](#closed-on-4-october).*

*On 7 October four reviews of ajar — security, parity with the pad, the
guest's page, and end-to-end flows — closed what is in [that day's
list](#closed-on-7-october); every finding and its check is in
[ajar-review-2026-10-07.md](ajar-review-2026-10-07.md). The relay and the page
were deployed that day, and the agent's share shipped in v0.0.7. A host still
on v0.0.6 or older can have its place taken while it is away, and lets a guest
read by name what the tree hides, until it reinstalls. The same day a pad's
cap went to 60 MB, meant for now; on 11 October it went to 100 MB to stay,
once the store could carry it — [that day's list](#closed-on-11-october).*

*On 8 October a click on a file in the guest's tree stopped being lost to
the folder changing, and fresh containers of fifteen Linux distributions
found what a first install meets — [that day's list](#closed-on-8-october).
The installer's half is live with the relay; the static Linux build and the
agent's half shipped in v0.0.8 the same day.*

*On 11 October the pad store became a file per blob and a save the edit, and a
pad went to 100 MB; every case measured before was run again against the
release before, and two slowdowns found that way were fixed. On 12 October a
pad's runtime stopped needing registry.wasmer.io to start, and two typing
losses on the guest's page were closed — [those days' lists](#closed-on-12-october).
The relay and both pages are live; nothing of it needs an agent release.*

Things known to be unfinished, unfixed or undecided. Written down so they stay
visible rather than being rediscovered. Each one says what is actually true,
not what would be nice.

---

## Waiting on a decision

### The guest page: one fix without a check

Of 11 October's fixes to typing held for a host that is away, one still has no
check of its own: held typing being handed back when a second blip of the
guest's own lands *during* the hand-back — between the host's answer naming the
document and the document's state arriving. Those are two frames the host sends
back to back; a proxy cannot reliably come between them, so a check would need a
hook in the page. The other two, and the bug left that day, were closed on 12
October.

### Unexplained once, and now able to explain themselves

**`accounts-check` failed twice on CI's Ubuntu runner,** on 8 and 9 October,
at its last step: the owner's other tab, its pad deleted, was refused
`rate_limited` on its way back into the room, and was still backing off when
the 15 s wait ran out. Every browser in the suite is one address, and by then
it has spent much of the relay's joins for the minute. The wait now runs to
the window's length. If it fails past that, the limit is being hit for a
reason other than one suite's volume.

**The guest's editor would not load, twice on CI.** On 11 October `check-guest`
saw "Couldn't load the editor" opening `ro.txt` through a 250 ms lag, once on
Ubuntu and once on macOS; eight runs here did not. The second time no request
had failed, nothing was refused and nothing was thrown — the loader caught the
error and kept nothing of it. It now logs it (`90fc82d`) and the check reports
it, so a recurrence says what the editor's module threw.

**`smoke-editing` failed once.** *Terminal 1 never became ready*, on 24
September, and it has passed every run since. If it recurs, `ready()` now says
what the terminal showed, or that it was never opened; the shell's startup
under load is still the first suspect.

**A first pad visit waited 114 s once.** On 25 September one first visit in
seven took 114 s from Run to output, with the python download done in 2.3 s.
`scripts/perf/pad-visit.mjs` now prints every request and console line for a
Run slower than 15 s or one that never finishes. The suspect is below.

**A typed command's file never reached the tree, once, live.** On 5 October
`app-check.mjs` against production typed `echo seeded-by-the-room > notes.txt`;
the prompt came back, the status said "saved", and `notes.txt` was not in the
tree 30 s later. The run straight after passed, as has every local run. A
publish waits its turn in the page's write queue, so the likeliest reading is
a store request ahead of it that stalled on the network. Store requests have
had a deadline since 11 October, so a stall now fails and is retried rather
than holding the queue; if it recurs, it was something else.

**A pad page threw "Atomics.wait cannot be called in this context", once.**
On 7 October, on the macOS runner (CI run 37622394950), the second editor
`accounts-check` opens on a pad raised it as a page error; Linux passed the
same commit and the rerun failed elsewhere. `Atomics.wait` on the main thread
is the Wasmer SDK's, so the suspect is its start-up racing the page's first
use of the runtime. Not reproduced locally.

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
the two write permits (four until 7 October).

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
| `go` (fetched on first use) | Single files only: Go cannot open a relative path or learn its working directory, so `go.py` hands it absolute ones, and a module (`go mod init`, `go run .`) fails with `getwd: File name too long`. A Go program opening a file by a relative path fails too, and a binary `go build` makes runs once — the second exec is `Exec format error` — so `go run` is the way |
| C++ (clang, on first use) | `#include <iostream>` does not finish compiling — fifteen minutes on a three-line program — where `<cstdio>` takes seconds. Run on a file that includes it says so first |
| `repl`, Common Lisp (on first use) | Expressions and the REPL; a file passed to it crashes, exit 11 |
| `java`, `javac` (on first use) | Storing an `Integer` in a `String[]` does not throw `ArrayStoreException`; two exception messages are less detailed than HotSpot's; `Thread.getAllStackTraces` and `jshell` do not exist. The fast javac has no annotation processing or doclint, takes `--release 25` only, and needs a browser with WebAssembly GC and exception references, falling back to the slow one elsewhere. `FilesIO` in the fidelity set hung once in about ten runs on 15 October, not seen since. The patches to Ristretto and teavm-javac are ours alone, not offered upstream |
| `ruby` | `-e` only; a script file exits 1, and `-e "$(cat f.rb)"` prints nothing. Not offered |
| `zig` | `zig version` only; `zig run` and `zig cc` fail with FileNotFound. Not offered |

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

**Fetched the first time they are used, since 12 October:** C and C++
(`clang`, with `gcc`, `g++`, `cc` and `c++` as aliases to it), `node`, `npm`
and `pnpm`, `php`, `go`, Common Lisp as `repl`, and Java — `java` and `javac`,
a package of our own — none on a visit, each when a line names it or Run is
pressed on a file it runs. See
[dev/pad.md](dev/pad.md#languages-on-first-use). **Not offered at all:** `gcc`
itself, which does not exist for this sandbox; `git` (85 MB, and it needs
`GIT_PAGER=cat`), which is a tool rather than a language and was not asked
for.

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

**Anonymous pads have no owner and no locks.** Everything in one is open to
whoever has the link, and a folder nobody opens or edits for 90 days is deleted
(it was a week, counting only edits, until 25 September). Owned pads — roles,
three-word names, no expiry — came with accounts on 4 October
([dev/accounts.md](dev/accounts.md)), in place of the claim-a-name plan in
[`personal-tier.md`](history/personal-tier.md): an anonymous pad is copied into
an account, never claimed. A lapsed name is free again, so an old link opens an
empty folder or somebody else's newer one; until 24 September it was sealed for
good instead, which turned `/demo` into a permanent 410.

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

### Pads of up to 100 MB

From the measurements of 11 October ([pad-store.md](dev/pad-store.md#old-against-new-11-october)):

- **A paste over 30 MiB into a file open live is not shared live.** A page
  sends no document message over the relay's limit, and says so; the paste is
  saved, but the other places' documents never get it, and the next save from
  one of them goes whole over it. Nobody pastes 30 MB into a browser editor
  often; refusing the paste, or closing the file's live document first, would
  end it.
- **One large file uploads more slowly than it did in one request** — about
  0.4 s at 58 MB — because each part after the first copies the file so far,
  and a write in parts that fails partway leaves the parts before it in the pad.
- **Switching back to a large file re-reads its line endings.** Binding a
  document scans the whole text for them (`eolOf`): about 30 ms each time at
  20 MB, the largest cost of the switch. Old, and not made worse.

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

~~**A multi-dependency install stops the sandbox.**~~ Solved on 28 September
(`2dede1f`): pip's progress bar starts a thread, which this runtime cannot, and
with `PIP_PROGRESS_BAR=off` `pip install requests` finishes in about 6 s —
`user-check.mjs` installs and imports it against the live site.

**Nothing limits the bytes.** Streams, open tunnels and new tunnels are all
bounded — 32 per tunnel, 8 open per address, 30 opened a minute — but not what
flows through them. A tunnel carries no pad and no account, so there is
nothing to attribute a download to beyond its address.

**`bind()` under the wisp policy is unmeasured.** The preview works in
production, which is the ingress that matters, but that syscall has not been
run under this policy — the networking table says so rather than guessing.

Measured in full in [dev/networking.md](dev/networking.md), including the
undocumented COEP header the preview origin needs and the three wrong answers
it took to get there.

---

### Accounts

Built on 4 October — [dev/accounts.md](dev/accounts.md#as-built). What is
still open in it:

- **The accounts database is not backed up.** It lives on the box alone.
  Litestream to S3 is the plan, which needs a bucket and credentials on the
  AWS account, and must leave `accounts.key` behind — the database and the key
  together are every edit link.
- **Google and GitHub are two accounts** for one person until linking is built.
- **No takedown tooling.** Taking a pad down for abuse, or banning an account,
  means editing the database by hand. `/admin` shows the biggest pads and the
  newest accounts but changes nothing.
- **Viewers are counted in the presence dots** like anybody else; whether
  editors should see them apart is undecided.
- **An anonymous pad moves into an account as a copy, from the dashboard.**
  Copy a pad takes its link and makes a pad of theirs with its files — a
  copy, not a claim. There is no button for it on the pad itself yet.
- **Left from the review of 4 October** (the rest was fixed — see
  [accounts](dev/accounts.md#as-built)):
  - An anonymous pad's name can still be held by a hosted session opened
    under it, keeping its live room shut while it lasts (owned pads refuse
    this now). The page says so — **Not live** — and goes live when the
    session ends, but nothing stops the session being opened.
  - Typing that reached the room but not the store when its typist lost
    editing is on everyone else's screen and in no one's save: only the
    typist saves a file, and theirs was refused. The typist keeps it as
    their own copy; the room's copy goes when the room empties, unless the
    owner types in that file. Closing or hiding the tab now saves what is
    waiting first (`6de80ed`); typing is still lost if the connection drops
    mid-typing and the typist was the only one to have typed.
  - Two sign-ins started at once in one browser share the cookie: the first
    to come back is refused as "started elsewhere", and lands where the
    second was going.
  - An owner signed out in another tab keeps their page and its unsaved work,
    but signing in again is a trip away from it; carrying the work across
    that trip (sessionStorage) would let it be saved to the pad itself.

## Designed, not started

**Further on accounts.** Deferred from its v1 on purpose:

- **Suggestions.** A viewer submits their local changes against the version
  they saw; the owner reviews a diff and accepts or rejects. Accepting is a
  three-way merge per file — the CRDT cannot help, because the change was made
  offline. Suggesting should need an account; anonymous suggestions are a spam
  channel.
- **Requesting edit access.** Lighter than suggestions, but it needs somewhere
  to tell the owner: a dashboard inbox, or email.
- **Encrypted private pads,** so that "only people with a view link" is
  something the server cannot read rather than something it enforces.

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

The recurring hazard is checks that pass for the wrong reason — thirty-one so far,
plus two that *failed* for the wrong reason and cost more than any of them. The
pattern never changes: whenever the thing under test can produce the passing
evidence by accident, the check proves nothing. Reverting the fix and watching
the check fail is the only habit that has reliably caught them, and it has one
failure mode of its own worth knowing — a revert that does not compile leaves
the previous build in place, and the check then measures the fix it was meant
to be deprived of. See [dev/testing.md](dev/testing.md).

---

## Closed on 12 October

| | |
|---|---|
| A pad's runtime could not start without registry.wasmer.io: it asks where each of ten packages is, one after another, on every start, and when one failed — three runs of eight from one network on 2 October — Run never answered. The answers are recorded with the packages and the service worker gives them; `app-check` runs a browser that cannot resolve the registry and presses Run | `5fd244f` |
| The two lists beside the mirrored packages, `manifest.json` and now `registry.json`, were cached for a year as immutable with the packages: a returning browser kept a list naming files a later deploy had removed, and fell back to Wasmer. They revalidate each visit | `5fd244f` |
| A guest typing into a file while the host was away, leaving it and going back before they returned was dropped by the host as a reader of that file on their return: the page closed the document it had parked while the same file was being opened again, the host removed it, and every keystroke after was refused — with the file open and editable on screen. Found and left on 11 October | `d62b567` |
| Typing held back for a file, gone back to while the host was away, was dropped as they returned: on screen, it was handed back as a file being opened again, which sends only what differs from the text held, and kept typing is already in that text. Found writing the check for the guard that ignores a second answer for one file, which has a check now, as does the toast for typing held for a file the host refuses | `337893f` |
| A pipe into `head` could end with the runtime's own `Program recieved termination signal: Broken pipe` and a run of `fatal signal: Aborted` on the terminal, on a slow machine. The shell leaves them out — the abort only after a broken pipe, so a program's own abort is still told | `f68770a` |

## Closed on 11 October

| | |
|---|---|
| Measured against the release before: working out a large write's requests cost up to 385 ms of the page's main thread, now 88; switching back to a 20 MB file was 18 ms slower every time, from counting its bytes in one piece, now counted a line at a time and as fast as before | `f6e92ab` |
| A pad's 60 MB was a stopgap meant to go back to 25. It is 100 MB now, to stay: an address may add 512 MiB a day and an account holds 250 MB. What made a large pad dangerous is gone — see the next three rows — and a request carries at most 24 MiB, so a larger upload, copy or file goes in parts | `adfa6fa` |
| One large file and twenty one-character saves into it: a 60 MB file took the relay to 274 MB of its 512, a 25 MB one before it got it killed, and the saves left 1.3 GB of old copies on disk, outside the ceiling's count. An edit is now streamed from one stored copy to the next, and the one it replaced deleted then: a save adds no memory at 99 MB, and one copy stays | `adfa6fa` |
| A write's body could be 121 MiB, held whole with the text parsed out of it: 268 MB for one 60 MB file. A request is now 33 MiB at most, and glibc's mmap threshold is fixed so the relay gives back what uploads used — 59 MB held after files of 25, 60 and 99 MB, not 261 | `adfa6fa` |
| A text file over 32 MB open in two places stopped reaching the second, and took the first place's whole connection with it: the relay stops reading a socket that sends a frame over its limit rather than closing it, so nothing said so. Possible since pads went to 60 MB. A file over 24 MiB now opens read-only with no live document, and its changes go through the store; no page sends a document message over 30 MiB | `129a79a` |
| Every save rewrote the whole pad: a keystroke in a 60 MB pad cost the relay 130 ms and about four times the pad in memory, and a relay that had saved a few large pads was killed by its own memory limit on the next — every session with it. The store now keeps each file once under its hash, with SQLite listing them, and a save writes only what it changes: 1 ms and flat memory | `4a13fa6` |
| A keystroke in a large file sent the whole file: a 300 KB file's save was 310 KB. A save of a large file is now the edit, against the stored version's hash, and goes whole only if that version has moved on — 165 bytes | `4a13fa6` |
| A host gone in the moment after a guest's own connection came back took the guest's ask for their open file with it, and what they typed while it was out went too: not counted as unsent, so closing the tab asked nothing; replaced on screen by the saved copy; and thrown away when another file was opened. Typing kept for a host that was away went the same way if the guest's own connection blipped before the host was back. CI's Mac found the first on 8 October; `check-guest` now holds the agent's hop so the ask never arrives | `c8bb7b3` |
| Keystrokes handed to a guest's socket in the moments before it was found dead never reached the file, and the host's copy, put back on screen, took them away: the page replayed what was typed since it noticed, and its text then held them already. The replay is now measured from what the host has sent back — it passes every update on to its sender too — and typing that arrived with only its echo lost is not put in twice. `check-guest` stalls a hop one way, dropping bytes with the connection still up | `3352bef` |
| Typing from a guest's outage was replayed at the offset it was typed at: "brave " typed after "hello ", with someone else's "Oh, " put in front meanwhile, made "Oh, hebrave llo world", and a replayed delete could take someone else's text. It now goes where the text around it still is, as the pad's `carryOver` puts it | `ca0a939` |
| An owner signed out under a private pad and back in wrote every file the page had kept back into the pad — the ones not on screen as they were when last shown — over whatever collaborators had done meanwhile. Only files changed here go back now, each rebased onto the pad as it is | `648544c` |
| A command's change from one emoji to another of the same block — 👍 to 🔥 — began between the two halves of the character, and the document put a replacement character in each; the editor's own guard covered only the start | `648544c` |
| Typing in a file while it was being moved went with the old file's document when the move landed | `648544c` |
| A store request the server never answered held the page's write queue for good — every save and publish behind it | `648544c` |
| The pad's own `awk` — and `sort`, `tail` and `box.py` with it — printed `Exception ignored on flushing sys.stdout: BrokenPipeError` after its output when piped into `head` | `fa97ffb` |
| A command that changed a file with typing in it not yet saved — the half-second before a save — lost its change: the page wrote its unsaved files into the sandbox after the command, over what it had done, before reading anything back. Found running the checks for the rest, as a flaky `user-check` | `648544c` |

## Closed on 9 October

| | |
|---|---|
| A save in the moment a file's document was still waiting for the room stored the file as nothing: the waiting document is empty, and the save read it rather than the editor's text. Found by reading, not reproduced — the moment is too short to make happen on purpose | `2462282` |
| A place whose connection dropped while somebody else opened the file came back with a document sharing no history with theirs — the newcomer, unanswered, had seeded from the stored copy — and the merge kept both: the whole file doubled, for everyone. Each side now sees the other's history for what it is; one, by a fixed rule, rejoins with what it typed since they parted | `378f69d` |
| A command in one place that rewrote a file open only in another reached the store and nobody's editor: theirs kept the old text, and their next keystroke saved it back over the command's work, for everyone | `9262712` |
| A new file opened while empty, then written by a command, opened empty — its document had no state, so the command's output went to the store and the model and never into it — and typing in it saved only the typing | `9262712` |
| A guest on Windows typing the first line break into a one-line file put CRLF in the document while a Mac guest's editor held LF — Monaco's default line ending is the operating system's — and every edit after it would land a character off, on the host's disk. Found by reading, and fixed without a check: one needs a Windows browser. The page now gives the editor the document's line ending, and stops editing if the two ever differ in length; `check-guest` covers the host's own guard, which ends a document a tool gives mixed line endings | `9262712` |
| A terminal command finishing in one place took the sandbox's copy of each open file back as the command's work, and put that older text over whatever was typed meanwhile in any place — a character at a time, or a paste | `7b3ec09` |
| Every terminal command dropped the byte-order mark from a file that had one — Excel's "CSV UTF-8" — and published it so | `7b3ec09` |
| A pad file with mixed line endings — a CSV a script wrote part of — put every edit after the first converted line ending a character off between the editor and the shared document: a value pasted into a cell showed right where it was pasted, and with part of the old value beside it everywhere else, and in the saved file | `5f98110` |

## Closed on 8 October

| | |
|---|---|
| A click on a file in the guest's tree did nothing whenever anything in the folder changed between press and release — every change repainted every row — so in a folder a build was writing to, files could hardly be opened | `12b7381` |
| The Linux release ran on three distributions of fifteen tried — it needed glibc 2.39, so not Ubuntu 22.04, Debian 12, RHEL 8 or 9, Amazon Linux or Alpine — and `install.sh` said "installed" anyway. Linux builds are now static, and the installer runs what it installed | `2b584a3`, in v0.0.8 |
| The installer's PATH advice, `~/.profile`, is read by no zsh — every Mac's shell — no fish, and no bash a terminal opens on Linux; a new terminal still said "command not found". It now names the file for the shell in use | `2b584a3` |
| The one-liner pasted into a new terminal, which starts in the home folder, was refused, with advice in terms of `ajar` rather than of the command just pasted | `2b584a3` |
| Without curl the install could not start, where wget was there all along; a minimal image with tar but no gzip failed mid-extract | `2b584a3` |
| Run without a terminal — from a script, with its output in a file — the agent spun a whole core for as long as the session was open | `2b584a3`, in v0.0.8 |
| A relay that could not be reached was said above the banner, where nobody reads, and without why — no certificates, no such host and a refused port read the same | `2b584a3`, in v0.0.8 |

## Closed on 7 October

| | |
|---|---|
| A guest could take the host's place in the 45 s after the host's socket dropped — welcomed as the host coming back, able to send the others anything — and the real agent then quit | `58fbdbe` |
| A guest could read what the tree hides by naming it — `.git/config`, gitignored files — read-only guests included | `58fbdbe` |
| A guest could open every file in the folder as a document, a megabyte of the host's memory apiece | `58fbdbe` |
| The landing page and `install.sh` told people to pipe a script from `ajar.sh`, a domain nobody owns, to `sh` | `0574a0c` |
| A change on disk to an open file deleted whatever had been typed since the last write, for everyone | `e7d4c23` |
| A paste into a terminal whose program was not reading froze the whole agent, ctrl-c included | `e7d4c23` |
| Editing a file with a byte-order mark or mixed line endings wrote every edit a character early; a Latin-1 file lost its accents | `e7d4c23` |
| The guest's page: Back showed a dead page and a nameless roster entry; a reconnect or a file switch went back to line 1; a relay restart ejected guests for good; with the host away the status said "open", and its countdown never moved | `e7d4c23` |
| The agent quit, ending every terminal, when the relay still held its dead socket or rate-limited a flaky network | `e7d4c23` |
| An open file deleted, moved or turned binary stayed editable, every keystroke going nowhere and the host's log saying so four times a second | `e7d4c23` |
| Locking a session shut out everyone already in at their first blip, and everyone at a relay restart | `1093ca9` |
| At 80 columns the host's panel cut the end off the link's key, and never showed the credentials warning | `1093ca9` |
| A link with its key cut short, missing or wrong opened a session that never worked | `1093ca9` |
| A host whose laptop was asleep looked like an empty, working session | `1093ca9` |
| The terminal was a keyboard trap, and the file tree could not be reached by keyboard past its first screenful | `1093ca9` |
| A guest could take nothing away but by copying it out of an editor — a file, a folder or everything now downloads | `1093ca9` |

The whole review — every finding, its fix, and the check that holds it — is in
[ajar-review-2026-10-07.md](ajar-review-2026-10-07.md).

## Closed on 4 October

| | |
|---|---|
| Sign-in was off in production until the OAuth apps existed — both are live, and the Google app is published | — |
| No way to delete an account; the privacy page promised it by email, which meant editing the database by hand | `e2786ae` |
| A pad page refused from its room as the wrong shape retried four times a second and never said so; it backs off and shows **Not live** | `eadbd53` |
| Signing out left that session's room connections as owner until they dropped | `e2786ae` |
| Typing inside the save delay was lost when its tab closed, unless someone else saved the file | `6de80ed` |
| Every save of a multi-megabyte file stalled the typist's editor 80–165 ms | `6de80ed` |
| A file opened at its first line every time it was switched back to, and after any change made to it meanwhile | `ecf47f9` |
| A command's change to a file this page had open in the room but was not showing never reached the room — nor this page, which put the old text back on showing it | `ecf47f9` |
| Back from Your pads, or from any page the pad navigated to, showed an empty editor that answered nothing: the page tore itself down going into the back-forward cache | `344e0a0` |
| Empty files and empty folders were lost on reload — New file saved nothing until typed in, New folder lived in one tab, an empty `mkdir` was invisible — and New folder's `.keep` showed up as a file once a command ran | `a05476b` |
| A binary file a command made was published as garbled text — to the store, everyone's tree and sandbox, and every download. It is carried as base64 now, and zips keep their images | `e97ead6` |
| Typing in flight when editing was locked was neither saved nor kept as the editor's own copy — the demotion looked for unsaved work while the save held it | `aab1a48` |

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

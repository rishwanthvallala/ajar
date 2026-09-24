# Security

What is actually enforced, what merely warns, and the difference between them.
The governing rule: **a claim in an interface must be true.** Saying a cap is
on when it is not is worse than admitting there is none, because the host
makes decisions on what they were told.

## The sandbox

A guest keeps the host's real toolchain — that is the whole point of lending a
machine, and a container would hand them a different one. So the *account* is
restricted rather than the environment replaced.

| | |
|---|---|
| Writes | Confined to the shared folder, temp, and build caches — truncation included, from Linux 6.2 |
| Credentials | `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, keychains and browser profiles unreadable |
| Environment | Variables that look like credentials, and the ones naming key agents, are withheld from a guest's shell. The host is told which, by name |
| Key-holding sockets | ssh and gpg agents, Docker, the desktop session bus: **measured**, and the host warned about each one a guest can reach. Not yet refused — see below |
| Other processes | A guest cannot signal anything outside its own terminal, the agent included — from Linux 6.12 |
| Everything else | Readable, so compilers and language servers still work |
| Network | Allowed by default. `--no-network` cuts it — Seatbelt on macOS, Landlock `ConnectTcp` on Linux. On a kernel older than 6.7 it **refuses to start** rather than pretend |

Confining writes to the project *alone* was the obvious first design and it is
wrong: it breaks `cargo`, `npm` and everything else that keeps a per-user
cache. A sandbox people switch off protects nobody, so the caches stay
writable and the summary says so rather than leaving it to be discovered.

**It is a sandbox, not a virtual machine.** It stops the ordinary case. It
does not stop someone determined with a kernel bug, and the wording everywhere
reflects that.

### Two mechanisms, and Linux is the stricter one

| | macOS — Seatbelt | Linux — Landlock |
|---|---|---|
| Model | allow everything, then deny | grant nothing, then allow |
| Credentials | a named list is denied | the whole home directory is invisible apart from shell config and build caches |
| Applied by | wrapping the shell in `sandbox-exec` | re-execing the agent as a launcher that restricts itself, then becomes the shell |

The difference follows from the mechanism. Landlock has no deny rules, so
"everything except `~/.ssh`" is not expressible — which forces granting each
top-level directory *except* the one home lives under, then handing back only
what a shell and a toolchain need.

Landlock restricts the *calling* process and is inherited across `exec`, so
there is no way to confine a pty's shell from outside it. Hence the launcher:
`ajar __confine <project> net -- /bin/zsh`.

### Which Landlock, and asking the kernel honestly

The launcher targets **ABI 6** (`linux::TARGET`), best effort: an older kernel
gets what it can enforce, and `gaps()` names the rest in the warning list
before the link is printed.

It was ABI 1 until September 2026, and that was a hole rather than a cautious
floor. ABI 1 has no idea truncation exists, so `truncate(2)` — which takes a
path and needs no writable file descriptor — emptied any file the host owned
from a shell that could not write a byte outside the folder. ABI 1 also refused
every cross-directory `rename(2)`, even inside the project, with
`Invalid cross-device link`; `mv` hides that by copying, and tools that rename
atomically do not. And it could not stop a guest `kill`ing the agent, which
ends the session for everyone, or anything else the host runs.

| ABI | Kernel | What it adds here |
|---|---|---|
| 2 | 5.19 | cross-directory renames inside what is writable |
| 3 | 6.2 | truncation refused outside what is writable |
| 4 | 6.7 | `--no-network` |
| 6 | 6.12 | signals and abstract sockets scoped to the guest's own terminal |
| 9 | 7.1 | pathname sockets — **not used yet**, see below |

Scoping has a cost worth knowing: each terminal is its own domain, so `kill` of
a server started in a *different* tab is refused. Stop it from the tab that
started it.

**Probes have to ask with a hard requirement.** The `landlock` crate's default
is best effort, under which an unsupported right is dropped without an error
and `create()` still succeeds. Every capability probe was written that way, so
each one answered "yes" on every kernel: a host on Linux 6.1 who passed
`--no-network` was told "no outbound network" and given a shell that could
reach anything, and a kernel with Landlock switched off reported a sandbox and
then failed to start every terminal. The probes now set
`CompatLevel::HardRequirement`; the launcher itself stays best effort.

### The environment, and the sockets it points at

The agent runs in the host's own shell, and every pty used to inherit all of
it. `env` was the whole attack: cloud keys, tokens, a database URL with the
password in it, and `SSH_AUTH_SOCK`, which signs as the host without anyone
reading `~/.ssh`. `secrets::withheld_env` now removes anything whose name looks
like a credential, anything in a cloud provider's family, anything naming a key
agent, and any URL carrying a password. It errs wide, because over-matching
costs a guest a variable they can ask for and under-matching hands over a key.

Withholding the *variable* does not hide the *socket*. An ssh agent listens in
a temp directory the guest can list; Docker, gpg and the session bus sit at
well-known paths. Refusing them needs Landlock ABI 9 (Linux 7.1) or Seatbelt
rules that have not been written and verified on a Mac yet. So for now the
agent **measures** instead of claiming: for each socket that exists it runs
itself through the real sandbox (`__reach`) and tries to connect, and warns
about exactly the ones that answered. `smoke-environment.mjs` checks the
warning against what a guest can actually do, in both directions.

The Landlock launcher answers the probe in its own process after restricting
itself. The first version exec'd the agent binary inside the sandbox instead —
and the binary lives under the home directory, which the sandbox hides, so the
exec failed and every socket read as unreachable. A reassurance produced by the
probe breaking.

### A trap when narrowing grants

Landlock grants for paths that do not exist are **silently dropped**. An
attempt to narrow the sandbox by granting specific cache directories broke
`npx`, because the path did not exist yet at grant time and the rule vanished
without error. Grants are filtered with `|p| p.exists()` and the roots stay
broad for exactly this reason.

### `sandbox-exec` is deprecated

Apple marks it deprecated with no announced replacement. It is still the only
documented way to apply a Seatbelt profile to an arbitrary process, and it is
on the critical path for every macOS host. Linux has no equivalent worry:
Landlock is a stable kernel ABI.

## Resource limits

The sandbox decides which *paths* a guest can touch and has nothing to say
about processes — and a shell is a process factory. Until this existed a guest
could fork-bomb the machine they were lent.

| | |
|---|---|
| Terminals | 12 per session, `--max-terminals` |
| Processes | 512 for guests together, above what the host already runs, enforced at `fork`, `--max-processes` |
| CPU, memory, disk | **Not capped** — and the panel says so |

**512 is headroom, not a total.** `RLIMIT_NPROC` is charged to the user, and
the host's browser and editor are that same user — on Linux every thread
counts. A desktop is past 512 before anyone joins, so a bare `ulimit -u 512`
left guests unable to start a single command, while every test passed on CI
machines running almost nothing. The cap is now set at each terminal's open to
what the host is running (`limits::in_use`, which leaves out the guests' own
process trees so they cannot raise their own ceiling) plus 512. Above the
user's hard limit it falls back to the hard limit, never to no limit.

That last row is deliberate. `RLIMIT_CPU` kills a long build, `RLIMIT_AS`
breaks anything that maps aggressively including `rustc`, and disk is hard to
bound portably. Those are recoverable; a machine that cannot fork is not.

Applied with `ulimit` in a wrapper shell rather than a syscall — no `unsafe`,
and rlimits are inherited across `exec`, so the sandbox wrappers compose with
it rather than fighting it.

### The shell has to be probed, not assumed

`ulimit -u` is not POSIX. bash and zsh have it; **dash does not**, and dash is
`/bin/sh` on Debian and Ubuntu. The wrapper sent its complaint to `/dev/null`
and dash exits 0 anyway, so on every Linux host the cap was silently never
applied — while the panel reported "512 processes". It shipped that way in
v0.0.1.

The shell is now chosen by asking: set the limit, read it back, believe only
the number. A zero exit status proves nothing here, because the failure writes
to stderr and exits 0. When no candidate works the wrapper is dropped and both
the summary and the warning list say processes are uncapped.

The tests missed it for the same reason the code did: they set the limit with
one shell and read it back with `/bin/sh`, which made a real bug look like a
platform quirk.

## End-to-end encryption

The key is generated by the agent, printed in the link's fragment (`#k=…`),
and never sent to a server — browsers do not transmit fragments. Content
channels are sealed with AES-256-GCM and a fresh random nonce per frame.

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
host, which is the only party that can.

A relay operator can see that a session is busy. They cannot see what is in
it — stated that precisely, rather than as "the server sees nothing".

### The header is authenticated, not just the payload

Sealing the payload alone leaves the nine-byte header in the clear *and
unauthenticated*. A hostile relay could not read a keystroke, but it could
take a sealed frame bound for one terminal and deliver it to another, or
replay it. The plaintext never changes, so nothing detects it.

The header is passed as AES-GCM associated data: still readable, because the
relay has to route on it, but no longer editable without the tag failing.
Routing metadata became something the relay reports rather than chooses.

### The replay window is bounded on purpose

Replay is refused by remembering recent nonces — a **window of 4,096**, not
every nonce ever seen. One `ls -R` is a couple of thousand frames, so
remembering all of them costs tens of megabytes an hour on the host and in
every guest's tab. The trade is explicit: a frame replayed after another 4,096
have arrived is accepted, the same bargain DTLS and IPsec make.

Counter nonces would remove the window and are the **wrong answer here**: the
session key is shared by the host and every guest, so independent counters
would collide, and a repeated nonce under GCM gives up the authentication key.
Random 96-bit nonces are correct precisely because the key is shared.

### Ordering

WebCrypto is asynchronous and terminal bytes must keep their order, so both
directions run through their own promise chain rather than being awaited
independently. Sealing concurrently would let a later keystroke overtake an
earlier one — a bug that would surface once a week and never reproduce.

## The credential scan is a warning, not a boundary

Filenames by convention (`.env`, `*.pem`, `id_rsa`, `.npmrc`) and a
deliberately narrow set of content patterns — private key headers, AWS key
ids, GitHub and Slack tokens. `.env.example` and friends are left alone; they
are the template, not the secret.

Keeping a file out of the tree would stop it being opened by accident, not
read on purpose — a guest has a shell. Claiming otherwise would be worse than
saying nothing, so the warning tracks the posture: with no sandbox available
the line ends "A guest with a terminal can read them; there is no sandbox".

A scanner that cries wolf gets ignored, and being ignored is the only real
failure mode.

## Rate limits

Opening a session needs no account, which is the point and also means a public
relay would accept sessions from anyone until it ran out of memory.

| | |
|---|---|
| Open at once | 8 per address |
| Started per minute | 20 per address |
| Joining a session | 96 at once, 240 per minute — see [below](#what-bounds-an-anonymous-caller) |

Opening is metered tightly and joining generously. Rationing the people a host
invited would be limiting the wrong side, but leaving joins unmetered let one
address hold unlimited sockets, which is why they have their own, much larger
budget.

The slot is a `Drop` guard rather than a matching `release()` call, because the
handshake has several ways to fail after a slot is taken and every one is a
path where a manual release is easy to forget.

Behind a proxy, every connection is the proxy. `--trust-forwarded-for` reads
`X-Forwarded-For` instead, and should only be on when something you control
sets that header — otherwise any caller can claim any address.

## What the pad does not have

The pad is plaintext on the server, has no accounts and no locks, and anyone
with the link can change anything. That was decided deliberately as the trade
for a URL anyone can open. Do not read pad code expecting ajar's guarantees.

## What bounds an anonymous caller

Added 24 September 2026, after a survey found that the relay had exactly one
limiter and both halves of it were broken. The posture is **cap what kills the
box, not what looks impolite** — every number below is set so ordinary use never
meets it.

| | Limit | Where |
|---|---|---|
| Sessions opened per address | 8 at once, 20/min | `quota.rs` `MAX_OPEN_PER_IP` |
| Sessions **joined** per address | 96 at once, 240/min | `quota.rs` `MAX_JOINS_PER_IP` |
| Every pad together | 4 GB, `--max-store-bytes` | `pad.rs` `MAX_STORE_BYTES` |
| What one address may add to the store | 256 MiB a day, growth only; `--pad-growth-per-address` | `quota.rs` `MAX_PAD_GROWTH_PER_IP` |
| One pad write, off the wire | 51 MiB | `main.rs` `MAX_PAD_HTTP_BODY` |
| Pad writes being read at once | 4 | `main.rs` `MAX_CONCURRENT_PAD_WRITES` |
| Memory one pad read costs | A chunk buffer — streamed from the file | `pad.rs` `open_for_read` |
| Pad reads in flight | 64 total, 32 per address, no rate limit; a 10 s wait, then 503 | `main.rs` `MAX_CONCURRENT_PAD_READS`, `quota.rs` `MAX_READS_PER_IP` |
| Egress tunnels | 64 total, 8 per address | `wisp-server.mjs` `MAX_TUNNELS` |
| `/dns-query` | GET/POST only, 4 KB body | `deploy/Caddyfile` |

Three of these need their reasoning kept, because the obvious version is wrong:

**Joins are metered separately and generously.** They used to be exempt
entirely — guests always, and peers whenever the name already existed, which is
every pad after the first visit. One address could hold unlimited sockets, each
with an 8 MiB outbox allowance, uncounted. But a whole office behind one NAT is
an ordinary shape, so the join ceiling is twelve times the open ceiling and the
two budgets cannot spend each other. A `const` assertion in `quota.rs` fails the
build if that relationship is ever lost.

**The address is the rightmost `X-Forwarded-For`, not the leftmost.** A proxy
*appends* the peer it saw, so the last element is the only one it vouched for.
Reading the leftmost made every per-address limit decorative: a caller sending
its own header got that value back, and rotating it bought a fresh bucket per
request. Caddy also replaces the header now rather than appending, so either
half holds alone.

**The body limit and the concurrency limit are one number, not two.** 51 MiB × 4
is 204 MiB against the unit's `MemoryMax=512M`. Raising either alone fails to
compile — there is a `const` assertion on the product, because the ceiling that
applied before was the OOM killer.

The permit for a pad write is taken in an **extractor, not the handler**.
Extractors that do not touch the body run first, so a request waits before
51 MiB is pulled off the wire; taken in the handler it would bound nothing.

**The store allowance counts bytes added, not pads created.** A cap on
creations does not protect a disk: sixty pads an hour at 25 MiB each fills the
ceiling before lunch. So each address may add 256 MiB a day — ten full pads, or
tens of thousands of ordinary ones — and only growth is charged, so an edit in
place is always free and an address at its limit can still make room. It is
what made a 90-day lease affordable: without it, one address could fill the
store in minutes and keep it full for a season.

**A pad read is streamed, and that is the bound — not the count.** Reads used to
hold the file, the parsed pad and the serialised response at once, and nothing
limited how many ran together: twelve concurrent reads of one 24 MiB pad grew
the relay by 647 MiB, past its own `MemoryMax`, and five OOM kills inside a
minute is systemd giving up on the relay and every session in it. Now the lease
is checked by a pass that skips everything but `updated_ms` without allocating
it, and the stored file itself is the response, with `exists` spliced in front
of its opening brace. The same twelve reads grow it by about 1 MiB.

The counts that remain bound descriptors and slow readers, not memory. The
per-address slot and the global permit ride *inside the body stream*, so they are
held until the last byte goes or the client leaves — held by the handler, they
would be released before a byte of the body had moved. Reads are deliberately
not metered by rate: every save in a busy pad sends every other browser to
re-read it, and a classroom behind one address does that thousands of times a
minute.

### Still unbounded

- **Bandwidth.** 19 MB per cache-cold pad visitor, served by Caddy from disk
  without the relay seeing it. Needs an edge rate limit — see
  [operations.md](operations.md#adding-the-caddy-rate-limit-plugin).
- **`/dns-query` request rate.** Bounded in shape and size, not in frequency.
  Same plugin.

## The egress endpoint is the one thing that acts on the internet for a stranger

`wss://code.rishwanth.dev/wisp` takes a request from an anonymous browser and
makes a TCP connection from our address. That is a different shape of risk from
everything else here: the relay only ever talks to itself and the sandbox only
ever talks to the tab, but this reaches outward on somebody else's say-so, and
whatever it does is attributed to our IP.

**It is an allowlist, not a proxy.** `pypi.org` and `files.pythonhosted.org`,
port 443, TCP only. That is the whole reachable internet from a pad. The
alternative — an open WISP endpoint — is an open TCP proxy, and the first thing
anyone would know about it is an abuse report or a terminated instance.

Four properties are doing the work, and each is worth keeping:

| | |
|---|---|
| Anchored patterns | `/^pypi\.org$/`, not `/pypi\.org/`. The loose form also matches `pypi.org.example.com`, a host somebody else controls |
| No direct IPs | `allow_direct_ip: false`, so a raw address cannot step around the hostname list |
| No private or link-local | Refused in the filter, and denied again by the unit's `IPAddressDeny=`. **169.254.169.254** hands out this instance's IAM credentials to anything that can make an HTTP request from it, and a server-side proxy talked into fetching it is the worst outcome available here |
| No UDP | pip does not need it, and open UDP is how a proxy becomes an amplification source |

The hostname is checked, then resolved, then the **resolved address** is checked
against the same ranges — so a name that points into private space is refused
rather than followed.

TLS is end to end between the sandbox and PyPI. python does the handshake and
the endpoint relays ciphertext, so it sees hostnames and byte counts and never
content. That is a privacy property and also a limit: it cannot inspect what is
being downloaded, so the allowlist is the only control.

**What it does not have.** Nothing rate-limits it beyond 32 streams per
connection, and nothing limits connections. A pad is anonymous, so there is
nothing to attribute use to and nothing to throttle against. Caddy cannot rate
limit without a plugin. This is the known gap, recorded in
[open-points.md](../open-points.md) rather than quietly carried.

**The DNS proxy is a smaller version of the same thing.** `/dns-query` forwards
to Cloudflare so the sandbox's DoH lookups are same-origin, which keeps them
inside `connect-src 'self'`. It will resolve any name for anyone who asks. It
was accepted because a public resolver is already public, and because it tells
us nothing `/wisp` does not show a moment later — but it is an open forwarder
and should be counted as one.

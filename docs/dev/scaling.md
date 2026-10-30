# Scaling: where it breaks first

A review of 30 October 2026: what gives way first as people, pads and rooms
grow, on the one server everything runs on today. Four reviews of the code
(the relay's store and HTTP path, its sockets and rooms, delivery and the
server, the pad in the browser), the server's own numbers from AWS, and a load
test of the relay. Each finding says how it is known:

- **measured** — run here, numbers below;
- **in code** — read and checked in the source, not run;
- **reported** — from a review's reading, with its file and line, not yet
  checked or run. Estimates are said to be estimates.

What was fixed the same day is marked **fixed** and is in the commit with this
document. The rest is ordered for doing.

## The server

One AWS EC2 **t4g.small** in `ap-south-1` (read from AWS on 30 October):

| | |
|---|---|
| CPU | 2 Graviton2 vCPUs, burstable: a baseline of 20% each. Credits are **unlimited**, so sustained load past the baseline is not throttled but billed, from the free plan's credits |
| Memory | 2 GiB; the relay is held to `MemoryMax=512M`, the egress endpoint to 384M |
| Disk | gp3, 20 GB, 3,000 IOPS, 125 MB/s |
| Network | "up to 5 Gbit/s" in bursts; the sustained baseline is far lower (about 128 Mbit/s for this size by AWS's tables — an estimate, not measured here) |
| Load today | CPU 0.5% on average, 40% at peak; the credit balance full (576) |
| Traffic out | **64.7 GB in 14 days** (16–29 October), about 140 GB a month, at today's light use — past the 100 GB a month that is free, so each further GB draws on the credits |

Everything below is against that box: the relay, Caddy, the egress endpoint,
the pad's static files and its package mirror all run and are served there.

## What breaks first, by who is using it

- **Many people, each in a pad of their own** — the money first: every first
  visit is 19–36 MB out of this box (item 6). Then, before the fixes today,
  about a thousand open tabs at once (items 3a and 3b).
- **A class or an office behind one address** — the per-address limits, in
  this order: pip's tunnels (8), live rooms for separate pads (8), page files
  (100 loads of each file an hour), pad reads in flight (32), sockets (96)
  (item 8).
- **Many people in one pad** — each save sends the whole pad to everyone
  else (item 1), and each arrival or departure makes everyone resend every open
  file to everyone (item 2). A big file in such a room can run the relay out of
  memory (item 4).

## Ranked

### 1. Every save sends the whole pad to everyone else in the room — in code

A save broadcasts `moved` (`pad/src/app.ts`, `saveEdits`, `this.peers?.moved(seq)`);
every other page's `onMoved` calls `refresh()`, which reads the pad with
`x-pad-seq` — and the relay answers "unchanged" only when nothing moved
(`Store::unchanged_since`), so after a save it sends every file
(`open_for_read`), though the typed file already reached them through the room.
`refresh` has no guard against running twice at once. Commands and moves send
the same nudge.

The cost is the people in the room, times the saves, times the pad: one person
typing in a 5 MB pad with nine others watching, saving at every pause, is 45
MB out per save; thirty people in a 78 MB pad (9 MB gzipped) is 261 MB a save
(estimates). It is the egress bill, the relay's 64 read slots, and Caddy's
compression CPU at once, and it grows as the square of the room.

**Fix**: a read since a sequence returns only the files whose `seq` is newer,
and the paths deleted since — each stored file already has its `seq`. The
nudge can carry the changed paths, and a page skips a file it has live. Make
`refresh` single-flight with a trailing run.

### 2. Every arrival or departure makes everyone resend every open file — in code

`onPresence` runs on every `joined` and `left` as well as a page's own
welcome (`peers.ts`), and each time every page asks again for every document it
has open (`DOC_WANT`, `app.ts` `onPresence`) and re-reads the pad. Every holder
answers with its whole state, every other page with `DOC_NONE`, and every
answer is a broadcast. One arrival is about D·N·(N−1)² frames out of the
relay for N people with D files open (reported estimate): about 50,000 for
thirty people with two files. A socket is closed at 2,048 queued frames
(`outbox.rs`), which that reaches at N ≈ 32–45, and a reconnect is another
arrival — a loop. A lecture of a hundred viewers would be about a million
frames an arrival.

**Fix**: ask again only on this page's own welcome; one holder answers (the
lowest id, or a short random wait cancelled by another's answer); nothing when
the state vectors already match; viewers and pages without the file stay
quiet.

### 3a. A thousand sockets — in code, **fixed**

The relay's unit set no `LimitNOFILE`, so it had systemd's soft limit of 1,024
descriptors — every pad tab, terminal, guest and pad read is one, and Caddy
holds one to the relay for each browser socket. Past it, `accept` fails and
axum sleeps a second each time, and blob and SQLite opens fail too. The unit
now allows 65,536, and the egress endpoint 8,192.

### 3b. 140 KB a socket — measured, **fixed**

An idle pad socket cost the relay about 140 KB: tungstenite's 128 KiB read
buffer and its write buffer. Measured in the container below, 1,000 → 2,000
idle sockets took the relay from 201 to 342 MB, and little came back when
they closed. At `MemoryMax=512M` that is some 3,500 tabs. With 16 KiB buffers
(`WS_BUFFER`, main.rs) it is **26 KB a socket** — 2,000 sockets in 64 MB —
with the same throughput (below).

### 4. A large live update is held once per person in the room — measured

One 20 MiB document update sent into a room of twelve took the relay from 10
to **262 MB**, and it stayed there until the sockets closed: each recipient's
writer copies the frame into a buffer of its own that keeps its size
(tungstenite), and the relay decodes and encodes each frame on the way
(reported). A room of about 24 doing that once reaches `MemoryMax`, and the
relay is killed — every session and room with it. A live document may be 24
MiB (`LIVE_MAX`), and the relay takes 32 MiB frames from any socket before its
hello.

**Fix**: hold live documents smaller — `MAX_DOC_MESSAGE` and a peer's frame
limit at a few MiB, with the existing "too large to share live" path past it;
forward a frame's bytes without decoding and encoding them; send large frames
in WebSocket fragments; keep the bytes in flight counted until written; a
global budget for them.

### 5. 40 ms on every pad read — measured, **fixed**

The relay sent without `TCP_NODELAY`, and a pad read is many small writes —
the pad's fields, each file's few bytes of JSON around its text. With Nagle,
the second write waits for the first one's ACK, which Linux delays 40 ms: on
a connection used before, **every read took 40 ms however small** (4 ms on a
new one; `/healthz`, one write, under 1 ms). Caddy reuses its connections to
the relay, so production paid it on every read. Then, without Nagle, each tiny
write was a packet. Now accepted sockets set `TCP_NODELAY`, a read's pieces go
out in writes of at least 64 KiB (`coalesced`, `READ_CHUNK`), and blobs are
read 64 KiB at a time rather than 4 KiB.

| Pad reads, 2 CPUs and 512 MB | before | Nagle off | and batched |
|---|---:|---:|---:|
| 40 KB pad, one reader | 40/s, 22 ms | 317/s, 3 ms | **320/s, 3 ms** |
| 40 KB pad, best | 1,623/s (64 readers) | 1,185/s (8) | **1,845/s (8)** |
| 5 MB pad, one reader | 47 MB/s | 49 MB/s | **243 MB/s** |
| 5 MB pad, best | 282 MB/s | 219 MB/s | **388 MB/s** |
| peak memory | 75 MB | 67 MB | 113 MB |

### 6. Every first visit is 19–36 MB from this box — measured sizes, estimated cost

Measured from the build and the mirror (reported by the delivery review):
the page, Monaco and xterm are 1.4 MB, the SDK 1.8 MB, the runtime's default
packages (Python 10.5, coreutils 2.8 and the rest) 15.8 MB — **19 MB for a
reader**, since the runtime warms for every visitor — and the suggestion model
17 MB more at the first key: **36 MB for someone who types**. Return visits
are nearly free: `/assets`, `/vendor` and `/packages` are immutable for a
year, the model is in Cache Storage. A pad's own contents are not cached
(`no-store`). At about $0.109 a GB out of Mumbai (assumed), 1,000 new typists
are about $4; the free plan's $95 of credits — which also pay for the instance,
its disk and its address — cover perhaps 160 first visits a day until it ends
in February 2027 (estimate). On demand: Java 14 MB, C++ 20, clang 24, Node 18,
PHP 19, Go 47.

**Fix**: a CDN in front of `/assets`, `/vendor` and `/packages` (CloudFront's
origin fetches from EC2 are free), or the packages on R2, which charges no
egress — keeping the CORP and CORS headers the page needs; warm the runtime for
a reader only once they act; brotli for the browsers that do not take zstd.

### 7. pip goes through one Node process on this box — in code, partly reported

The egress endpoint (`deploy/wisp-server.mjs`) allows **64 tunnels in all and
8 per address** (in code). The SDK keeps a tunnel open until the sandbox
closes and Caddy allows a day, so the 65th open tab that has installed
anything, or the 9th behind one address, is refused and pip fails (reported).
wisp-js buffers up to 32 MiB a tunnel against the unit's 384 MiB, so about ten
large wheels to slow clients at once could have it killed (reported
estimate); every install is downloaded again on every reload, since `.deps`
is not kept; every byte crosses the box twice; every deploy restarts it, which
ends installs under way.

**Fix**: fetch wheels through the browser, as the page's `curl` does
(files.pythonhosted.org sends CORS headers) — no egress here, and cached; or
close idle tunnels when pip ends, a send buffer of about 1 MiB, higher caps,
and a restart only when it changed.

### 8. A class behind one address — in code

What thirty people on one network meet, roughly in order:

1. pip: 8 tunnels an address (item 7).
2. `MAX_OPEN_PER_IP = 8` (`quota.rs`): the first person into a pad's room
   counts as opening it, so the 9th person with a pad of their own gets no
   live room; the page retries quietly and says "not live".
3. `pad_dns`, 120 a minute: each name is two DNS-over-HTTPS queries, pip's
   three hosts six, about twenty installs starting a minute (reported).
4. `pad_files`, **100 fetches of each file an hour an address** (`Caddyfile`):
   the 101st page load in an hour gets 429s on `/assets`, which nothing falls
   back from — a broken page; the package lists are fetched again whenever the
   service worker starts, and a 429 there sends the runtime to Wasmer's CDN.
5. Pad reads: 32 in flight an address, which the re-reads of item 1 use up
   with a room of 33.
6. Sockets: 96 an address.

Addresses are counted whole, so an IPv6 host can change its own and pass all
of them (reported). **Fix**: count opens per device rather than per address,
raise these per address, a separate and larger zone for the package lists
(hashed, then immutable), IPv6 by /64.

### 9. The store's one connection — partly measured

Every read, write and lease renewal of the pad store takes one
`Mutex<Connection>`, and a write holds it across its fsyncs (WAL with
`synchronous = FULL`, and a directory fsync for each new blob), reading every
file of the pad and the newest version's whole manifest while it does
(reported, with lines: `write_within`, `newest_version`, `count_ref`).
**Measured** in the container: 400 people each saving 2 KB every 500 ms, 800
saves a second, a 99th percentile of 6 ms, one CPU — but the container's disk
does not sync as EBS does, so the box will be lower; the review estimated 4–8
ms a save under the lock, 125–250 a second (estimate). What holds it longer:

- a 500-file upload — some 500 directory fsyncs and 3,500 statements in one
  hold, 1–2.5 s with every pad waiting (estimate);
- keeping a version (every ten minutes of activity) — about 2,000
  statements for a 500-file pad; deleting a pad's history — up to 45,000
  (reported);
- the hourly sweep of blobs, which takes the lock once per blob
  whether or not anything lapsed (reported);
- the accounts database: `/admin`'s statistics are O(users × sessions) with no
  index on `sessions.user_id`, sessions are never purged, and New pad's name
  check holds the accounts lock while asking the store (reported) — a slow
  store stalls every access check, sockets included.

The write handler parses a body of up to 33 MiB on an async worker, of which
there are two, **before** checking the caller may write (reported) — an
anonymous client can keep both busy against a private pad.

**Fix**: read-only WAL connections for reads; blobs placed and their
directories synced before taking the lock, once per directory; the
version-due check reading `at_ms` alone; cached statements; history deleted in
batches in the background; the orphan scan at start only; the access check,
then the account's turn, then the permit, and the parse in `spawn_blocking`;
an index on `sessions(user_id)` and a purge; `synchronous = NORMAL` for the
accounts and usage databases.

### 10. Editing a large file rewrites all of it every save — reported

An edit is applied by streaming the whole stored blob through the splice,
SHA-256 and `sync_data` (`stage_edits`): for a 100 MiB file, each save reads
and writes 100 MiB — some 50 MB/s of writes at the 2 s save delay, 40% of the
disk, holding one of the two write slots a second at a time (estimate). Two
such typists take both slots; growth alone is charged against an address's
allowance, so rewrites are free. **Fix**: files as lists of chunks (a few MiB
each), or a smaller size past which a file is not edited live.

### 11. Hosted sessions hold their snapshots in memory — reported

Each ajar session's workspace snapshot, up to 25 MiB, is in the relay's
memory with no budget over all of them; a guest's fetch copies it twice more;
and after a relay restart every agent offers its snapshot again about 5 s
after it reconnects, all at once. About ten full-size workspaces reach
`MemoryMax`; a restart can then end in another kill, and five in a minute
(`StartLimitBurst=5`) leaves the relay stopped (estimate). **Fix**: a global
snapshot budget, or snapshots on disk and streamed like pads; the encoded frame
kept and shared; one fetch at a time a guest; jitter on the re-offer.

### 12. A deploy is a storm — in code

Every deploy restarts the relay with no notice to its sockets, and every
client — the pad, ajar's page and the agent — backs off the same way, `250 ms ·
2ⁿ` to 8 s with no jitter, so they come back in waves (about 0.75, 1.75 and
3.75 s), each room then replaying item 2 and item 1, each agent item 11. The
egress endpoint is restarted every deploy too, whether it changed or not.
**Fix**: full jitter (a random wait up to the backoff, the first one random
over a few seconds); a "restarting" word on SIGTERM; restart the egress
endpoint only when it changed.

### 13. In the browser — reported

What a page does that grows with the pad, the room or the session (the browser
review; each with its lines there):

- **Opening** reads the pad as one JSON, buffered and parsed: a transient peak
  of 3–4× the pad, 600–800 MB at 200 MiB; after a re-read every file is held
  twice (`Texts` keeps the old strings while `known` takes the new) — a one-line
  fix: reuse the known string when equal.
- **Every remote keystroke** writes the whole file into the sandbox
  (`intoSandbox`), and while a command runs keeps up to 64 versions of it —
  1.5 GB for a 24 MB file under a running server (estimate). Coalesce to one
  write before a command, or every 250 ms.
- **After every command**, `ls` included, the diff reads every file on the
  main thread (measured before at 0.1 s for 100 MB), and re-encodes every
  binary as base64. A stamp file and `find -newer`, and binaries compared by
  length and hash.
- **Each save** hashes the stored text again, though the relay returns each
  file's hash — 20–30 ms at 24 MB; keep a map of hashes.
- **The journal** has no total budget, and a failed save retries every 0.5 s
  with no backoff — every page at once while the relay restarts.
- **Cursors**: every selection change is broadcast, and each remote one
  rewrites a `<style>` sheet — a page-wide restyle, about 45 a second with ten
  people. Documents are never closed when their file is, so a session's open
  documents only grow, and feed item 2.
- **Search** clears its results on every edit anyone makes, so with two
  typists they never appear; its worker holds a copy of every file and is
  never ended.
- Terminals and editor groups have no cap; models are not disposed while their
  file exists; a toolchain stays loaded (clang 106 MB, Go 273 MB).

### 14. One of everything — in code

One instance, one zone, one disk, **no backups** ([durability.md](durability.md));
a deploy restarts the relay and drops every session and room; Caddy's reload
cuts every socket after 10 s. The disk (estimate): the package mirror twice
over, its staging copy kept beside it, about 2.5 GB; the pad store up to 4 GiB
with its WAL; journald's default 10%; logs small. Daily EBS snapshots are
cheap; journald `SystemMaxUse` and the mirror off the box free the rest.

## The load test

`scripts/relay-load.mjs`, against the relay's Linux build in podman held to
the box's 2 CPUs and 512 MB, each simulated person on an address of their own
(`--trust-forwarded-for` and `X-Forwarded-For`), on this Mac on 30 October.
The CPUs are the Mac's, faster than Graviton2's, and the container's disk
syncs more cheaply than EBS: read the numbers as relative, and the box as
lower.

```sh
podman run --rm -v "$PWD":/src -w /src docker.io/library/rust:1 \
  bash -c "CARGO_TARGET_DIR=/src/target/container cargo build --release -p ajar-relay"
podman run -d --name relay-load --cpus 2 --memory 512m -p 18787:8787 \
  -v "$PWD/target/container/release/ajar-relay:/relay:ro" -e MALLOC_MMAP_THRESHOLD_=1048576 \
  docker.io/library/rust:1 /relay --bind 0.0.0.0:8787 --trust-forwarded-for \
  --pad-dir /tmp/pads --accounts-db /tmp/a.db
RELAY=http://127.0.0.1:18787 node scripts/relay-load.mjs all   # reads, writes, rooms
podman rm -f relay-load
```

Never against production: it is a load test, and production's limits would
answer it with 429s.

Saves (each person saving a 2 KB file every 500 ms, after the fixes):

| People | Saves/s | p50 | p99 |
|---:|---:|---:|---:|
| 10 | 20 | 4 ms | 428 ms (the first) |
| 100 | 200 | 2 ms | 11 ms |
| 400 | 800 | 1 ms | 6 ms |

Rooms (each person sending five 60-byte updates a second, as a typist does):

| Rooms × people | Sockets | Delivered/s | p50 | p99 | Memory |
|---|---:|---:|---:|---:|---:|
| 25 × 4 | 100 | 1,470 | 4 ms | 18 ms | |
| 250 × 4 | 1,000 | 14,697 | 19 ms | 39 ms | 59 MB (188 before item 3b) |
| 1 × 50 | 50 | 12,001 | 7 ms | 18 ms | |

Keystrokes are not the bottleneck: a thousand people typing at once used
about two thirds of the two CPUs. Rooms break by their membership churn
(item 2) and their big frames (item 4) first.

## In what order

1. Reads since a sequence, and a single-flight `refresh` (item 1).
2. Re-ask only on one's own welcome, one answer (item 2).
3. Live documents held to a few MiB, frames forwarded as they came (item 4).
4. A CDN or R2 for the static files and packages (item 6), and pip through the
   browser (item 7).
5. The per-address limits for a class (item 8), and jitter everywhere (item 12).
6. The store's lock (item 9), then large files (item 10) and snapshots (item 11).
7. The browser's own (item 13), starting with the one-line string reuse and
   coalesced sandbox writes.
8. Backups ([durability.md](durability.md)), before any of this matters.

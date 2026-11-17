# Performance: every number, and none traded away

How fast and how big the pad is, from a newcomer's first open on a phone's
link to the relay's requests a second — each with how it is measured, its value
now, and how much worse counts as worse. Written 17 November 2026; the values
are `docs/dev/perf-baseline.json`, measured at f44c685-dirty.

**The rule**: a change made for speed or size runs the scorecard before and
after, and lands only with no other number worse past its tolerance — or with
the trade written down here and agreed. Any number made better by making
another worse is a trade, not an improvement, and is said as one.

```sh
npm run build:pad && node pad/scripts/compress-static.mjs   # the build as the deploy ships it
node scripts/perf/run.mjs                  # browser scenarios in the perf lab, ~25 min; exit 1 on a regression
node scripts/perf/run.mjs --server         # and the relay's, nginx's and the load benchmarks (~15 min)
node scripts/perf/run.mjs --only live      # production, once, after the deploy: a live check
node scripts/perf/run.mjs --save           # the new numbers become the baseline, with the change
```

## How it is measured

**The perf lab** (`scripts/perf/lab.sh`): production's nginx config
(`deploy/nginx`) and the relay in one podman container, serving this tree's
build compressed as the deploy compresses it, under the sites' own names. The
link is shaped on what nginx sends (netem, `reshape.sh`), and reset between
scenarios:

| Profile | Link | CPU |
|---|---|---|
| `fast` | unshaped — this machine's loopback | as is |
| `cable` | 25 Mbit/s, 20 ms | as is |
| `slow` | 1.6 Mbit/s, 150 ms (Lighthouse's "slow 4G") | as is |
| `cable-cpu4` | 25 Mbit/s, 20 ms | the page's thread 4× slower (Lighthouse's mobile run) |

**The browser** (`scripts/perf/browser.mjs`): Chromium with a profile of its
own made empty for each newcomer — a real profile with a disk cache, as a
visitor's — and the lab's key trusted. What the page records from its first
script: paints, long tasks, layout shifts, and when the editor, its focus and
the terminal came; and every byte on the wire, the service worker's too. Each
scenario three times; the median kept.

Three things the lab got wrong on the way, each of which made its numbers
quietly meaningless, and is checked now:

- **The shaping missed the browser.** Podman on a Mac hands the browser's
  connections in on the container's loopback, not eth0: shaped on eth0, a
  9.7 MB package came in 0.04 s on the "slow" link. On loopback now, and the
  same package takes 3.3 s on `cable` and 50 s on `slow`.
- **Nothing was cached.** Chrome caches nothing from a certificate whose
  errors it was told to ignore, and Playwright's throwaway contexts keep
  little anyway: every visit was a first one, and Run after the runtime's
  bytes had been fetched fetched them again. The lab's key is trusted now
  (`--ignore-certificate-errors-spki-list`) and profiles are real: a second
  fetch is from the cache, the page's and the service worker's alike.
- **One scenario waited for the last.** The shaper's queue held what was
  still being sent to a browser that had closed; the next scenario's first
  byte came a second late on `cable`. Reset before each scenario now.

**The server** (`--server`): `scripts/relay-bench/run.sh relay` and `nginx` —
wrk against the relay alone and through production's nginx with TLS, two CPUs
and 512 MB as the box — and `scripts/relay-load.mjs`: reads, saves, rooms and
re-reads at rising load. In podman on this Mac: faster cores than the box's
Graviton2 and a cheaper disk, so relative.

**Production** (`--live`): one newcomer's visit, editing and pressing Run, from
wherever it is run; and DNS. A live check: once, marked as one so it is not
counted as use.

## The numbers

### A newcomer's first open — nothing cached anywhere

The pad's page, the editor and the terminal; what an edit-only visit costs;
when the runtime's bytes are asked for, unasked; and pressing Run.

| | fast | cable | slow | cable, CPU 4× | production |
|---|---:|---:|---:|---:|---:|
| First byte (TTFB) | 6 ms | 67 ms | 474 ms | 73 ms | 126 ms |
| First paint (FCP) | 93 ms | 548 ms | 5743 ms | 711 ms | 496 ms |
| Largest paint (LCP) | 211 ms | 653 ms | 5961 ms | 960 ms | 654 ms |
| **Editor takes keys** | **183 ms** | **613 ms** | **5948 ms** | **872 ms** | **619 ms** |
| Terminal on screen | 227 ms | 739 ms | 7335 ms | 1073 ms | 720 ms |
| Main thread blocked before then | 0 ms | 0 ms | 79 ms | 446 ms | 59 ms |
| Layout shift | 0.002 | 0.002 | 0.002 | 0.002 | 0.002 |
| Bytes before the editor | 905 KB | 885 KB | 885 KB | 905 KB | 905 KB |
| **An edit-only visit, without the runtime** | **1.09 MB** | **1.09 MB** | **1.09 MB** | **1.09 MB** | **1.09 MB** |
| The runtime's bytes first asked for, unasked | 2304 ms | 3209 ms | 15905 ms | 3542 ms | 3109 ms |
| …and the runtime started? | no | no | no | no | no |
| JS heap once settled | 14 MB | 14 MB | 14 MB | 14 MB | 14 MB |
| **Run pressed at once: its output** | **1.39 s** | **7.12 s** | **91.23 s** | **8.51 s** | **4.74 s** |
| …from the button | 1.16 s | 6.38 s | 83.88 s | 7.22 s | 4.14 s |
| …bytes in all | 16.55 MB | 16.55 MB | 16.55 MB | 16.55 MB | 16.56 MB |
| Run pressed once settled, from the button | 1.18 s | 1.35 s | — | — | — |

Times are from the start of the navigation. DNS is not in the lab's: below.

### DNS, cold

The name is at NS1; its records live an hour.

| | |
|---|---:|
| NS1 answering, from here | 94 ms |
| A name no resolver has cached, through 1.1.1.1 | 67 ms |
| The A record's TTL | 3600 s |

So a newcomer whose resolver has not seen the name in the last hour adds
about this much before the first byte; 8.8.8.8 took 147 ms and 9.9.9.9 459 ms
once on 17 November.

### Coming back, and using it

A return visit in the same browser — its cache and service worker warm — and
then typing, saving, Run again and a command, on its page.

| | fast | cable |
|---|---:|---:|
| Editor takes keys | 168 ms | 192 ms |
| Bytes, to the first Run's output | 3 KB | 2 KB |
| Run, from the button (the runtime from the cache) | 1.05 s | 1.07 s |
| A key, to the frame that shows it (p50 / p95) | 4.8 / 15.3 ms | 4.6 / 16.6 ms |
| The last key, to "saved" | 490 ms | 1582 ms |
| Run again, the runtime warm | 215 ms | 216 ms |
| A command in the terminal, to its output | 46 ms | 47 ms |
| The suggestion model, once code is typed | 16.12 MB | 0.16 MB (still coming) |

### Two people in one pad

A key typed in one browser, to the change in the other's (p50 / p95):
6 / 24 ms unshaped,
27 / 59 ms on `cable`.

### The server

Requests a second, 64 connections, two CPUs shared as on the box (p99 in
brackets):

| | the relay alone | through nginx, TLS |
|---|---:|---:|
| `/healthz` | 266,232 (0.93 ms) | 126,577 (35.15 ms) |
| `/api/limits`, not signed in | 103,473 | 76,435 |
| `/api/limits`, signed in | 59,412 | 46,443 |
| `/api/me` | 49,685 | 43,856 |
| A small pad, read | 48,735 (39.09 ms) | 36,469 (50.7 ms) |
| …unchanged since the page's sequence | 71,813 | 55,352 |
| …by its signed-in owner | 40,560 | 32,270 |
| A 2 KB save | 8,827 (15.68 ms) | 8,876 (14.13 ms) |

The load test (`relay-load.mjs`):

| | |
|---|---:|
| A 40 KB pad read, one reader / at best | 1,822 / 9,476 a second |
| A 5 MB pad read, one reader / eight | 347.1 / 488.3 MB/s |
| 400 people saving every 500 ms | 801 a second, p99 6 ms |
| 1,000 people typing, 250 rooms of 4 | 14,621 updates a second, p99 29 ms |
| 50 people typing in one room | 11,944 a second, p99 18 ms |
| A save in a 5 MB pad, re-read by a room of 10: whole / what changed | 45,222 / 246 KB, p50 116 / 5 ms |
| …a room of 30, what changed | 792 KB, p50 6 ms |

**On the box itself**, which needs AWS and is not in `run.mjs`: through
production's nginx from a load generator beside it, 16 November — 7,700 small
pad reads a second, 10,200 unchanged checks, 15,900 `/api/limits`, 800 saves a
second at p99 18 ms, a thousand people typing at 14,625 updates a second
([scaling.md](scaling.md), "On production, 16 November").

## What the scorecard found, 17 November

- **A first open is quick to edit, slow to run on a slow link.** The editor
  takes keys at 613 ms on `cable` and 5.95 s on `slow`, from
  about 1.09 MB — all an edit-only visit costs where the runtime's
  bytes do not come unasked. Run pressed at once costs the runtime's 16 MB
  then: 6.38 s from the button on `cable`, 83.88 s on `slow`. Pressed once
  the page has settled and the bytes have come by themselves, 1.35 s.
- **The suggestion model costs the first minute of typing code.** Its 17 MB
  come at the first code typed, on the typist's own link, and what else the
  page sends then waits behind it: the last key to "saved" is
  1.58 s on `cable`, against 0.49 s unshaped. Two people typing code
  together in the lab, on one shared link, saw each other's keys at p50
  138 ms on `cable` while it came, against 27 ms with suggestions off — the
  number the scenario keeps, as two people on links of their own would not
  share it. A trade the scorecard now shows, not yet made smaller.
- **A slow CPU costs the editor most.** With the page's thread 4× slower the
  editor takes keys at 872 ms against 613, after 446 ms of the
  main thread blocked — Monaco's parse and the page's first layout.
- **On production** the editor takes keys at 619 ms and the starter's
  output comes at 4.74 s, from the maintainer's office; DNS adds
  67–94 ms for a resolver that has not seen the name in the hour.

## Worse counts as worse past

| Kind | Worse when |
|---|---|
| A time (`_ms`) | 15% and 40 ms slower |
| Long tasks | 100 ms more (they come whole, 50 ms at a time) |
| Bytes | 2% and 4 KB more |
| Requests or updates a second, MB/s | 10% fewer |
| A key reaching another browser | 50% and 100 ms slower (two sockets and a relay: its tail moves a third run to run) |
| Heap | 15% and 5 MB more |
| Layout shift | 0.02 more |
| A yes/no (runtime started) | changed |

The lab's own spread between runs, on 17 November: times within a few
percent on a shaped link, up to ±20 ms unshaped; bytes exact.

## What the numbers do not cover yet

- **Chrome's own estimate of the link** (`navigator.connection`) sees the
  lab's loopback, not its shaping: on `slow` it still called the link fast
  and the runtime's bytes were fetched unasked. Whether a slow link is spared
  them is `spareConnection`'s, tested in `check.ts`, and data saver is in
  `user-check.mjs`.
- **The CPU slowdown is the page's thread only**: the runtime's workers —
  Python's compile — are not slowed, so `cable-cpu4`'s Run is as quick as a
  fast machine's once the bytes are in.
- **Firefox and Safari**: Chromium only.
- **CI** runs none of it: shared runners are too noisy for times, and the run
  is long. Bytes are exact and could be budgeted there — not yet.

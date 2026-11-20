# Performance of a session: every number, and none traded away

How fast a session of ajar is for the people in it — a host starting `ajar`,
a guest opening the link, and everything that then crosses between the
host's machine and the guest's page — each with how it is measured, what it
was, and what it is. The pad's are in [performance.md](performance.md), and
this is the same scorecard: one runner, one baseline
(`docs/dev/perf-baseline.json`), one rule.

**The rule**: a change made for speed or size runs the scorecard before and
after, and lands only with no other number worse past its tolerance — or with
the trade written down here and agreed.

```sh
cargo build --release -p ajar && cargo build --release -p ajar-relay   # each alone, as a release is built
npm run build:ajar
node scripts/perf/run.mjs --only ajar          # three links, three runs each, ~25 min; exit 1 on a regression
node scripts/perf/run.mjs --only ajar-live     # production, once, this tree's agent: a live check
node scripts/perf/run.mjs --only ajar --save   # the new numbers become the baseline, with the change
node scripts/perf/ajar-lab.mjs near disk 1     # one scenario, once; SAMPLES=1 prints every sample
```

Written 20 November 2026, when a host said a change on their computer took
a long time to show on the website. Before is 4184471 — what was released
as 0.0.9 — and after is this tree, both measured that day, one after the
other.

## How it is measured

**The lab** (`scripts/perf/ajar-lab.mjs`): a real agent in a terminal of its
own, drawing its panel as a host's does; a real relay serving the page's
build; Chromium with an empty profile; a project of five hundred files. All
on this machine, with a link of a set length between the agent and the relay
and another between the relay and the browser (`link.mjs`): a proxy that holds
what it carries for so long each way, and sends no faster than so much.

| Profile | The host's link | The guest's link | |
|---|---|---|---|
| `near` | none | none | this machine's loopback: what the code costs |
| `office` | 32 ms each way, 50 Mbit/s | the same | the maintainer's office to the relay in Mumbai, 19 November: a 65 ms round trip |
| `abroad` | 32 ms, 20 Mbit/s | 120 ms, 20 Mbit/s | a guest a continent away |
| `live` | production | production | this tree's agent through `ajar.rishwanth.dev`, once |

**A time is taken where the thing happened and where it was seen.** Seen is
in the page: an observer on the page's own document notes the moment a row is
in the file list, a word is in the editor, a character is in the terminal.
Happened is the page's last key or click, by the same clock — or, for a file
written on the host's disk, this process's clock, which is set against the
page's first (a dozen asks; the one that waited least). Each kind of thing is
done eight to forty times in a run, at intervals that are not regular — the
agent gathered changes on a tick, and a steady beat would have met the same
part of it every time — and a run is done three times: the median of each
number is kept.

**Three things the lab got wrong on the way**, each of which made a number
quietly meaningless:

- **A cached file counted as a request.** Playwright says a request finished
  for one answered from the browser's cache, and gives it its headers' size:
  a return visit that fetched one file was thirteen requests. Counted now by
  the browser's network stack (`Network.loadingFinished`): bytes that crossed
  the wire.
- **The first start after a build took a second.** A Mac looks a new binary
  over the first time it runs. Each binary is run once before anything is
  timed.
- **Yesterday's numbers were not today's.** The same commit's shell took
  0.5 s to start one day and 0.25 the next. A before and an after are measured
  in one sitting: `AGENT`, `RELAY_BIN` and `WEB_DIST` point the lab at a
  worktree's build of the commit before.

**What the lab is not.** Each side's TCP ends at the link, so what depends on
the far end's acknowledgements — Nagle's algorithm holding a small write
back — is not in its numbers; production's are (`live`). The shell is this
machine's, with its owner's start-up files. And it is one machine: a
terminal's burst and a transfer are as fast as this Mac's loopback.

## The numbers

Before → after, the median of three runs; bold where it is better past the
tolerance below.

### Starting, and joining

A host's command to a link that works; and a guest in a browser that has never
been here, from the link to the page asking a name, and from the name given
to the file list and to a terminal at its prompt.

| | near | office | abroad |
|---|---:|---:|---:|
| `ajar` to a link that works | 94 ms → 83 ms | | |
| …in a folder of 5,000 files | 306 ms → 269 ms | | |
| The link, to the page asking a name | 45 ms → 42 ms | 284 ms → 260 ms | 1065 ms → 1042 ms |
| The name given, to the file list | 62 ms | 235 ms → 233 ms | 624 ms |
| **…to a terminal at its prompt** | 250 ms → **183 ms** | 566 ms → **467 ms** | 1133 ms → 1086 ms |
| Bytes to get there | 531 KB → **123 KB** | 531 KB → **123 KB** | 531 KB → **123 KB** |
| …and with what the page then fetches unasked | 942 KB | 942 KB | 942 KB |
| Requests to get there | 6 | 6 | 6 |
| Main thread blocked | 0 ms | 0 ms | 0 ms |
| A folder of 5,000 files: the name given, to its list | 79 ms → 72 ms | | |

### Opening files

A click on a file, to its text on screen: the first, which used to bring the
editor with it; then a small one, a megabyte, and a megabyte of picture.

| | near | office | abroad |
|---|---:|---:|---:|
| **The first file** | 167 ms → **141 ms** | 865 ms → **270 ms** | 2.04 s → **443 ms** |
| …bytes fetched for it | 4.25 MB → **64 KB** | 4.25 MB → **64 KB** | 4.10 MB → **64 KB** |
| A small file | 32 ms → 30 ms | 156 ms → 164 ms | 345 ms → 332 ms |
| A 1 MB file | 66 ms → 57 ms | 514 ms → 521 ms | 1184 ms → 1186 ms |
| A 1 MB picture | 45 ms → 47 ms | 355 ms → 358 ms | 821 ms → 824 ms |

### A terminal

| | near | office | abroad |
|---|---:|---:|---:|
| A key, to its echo (p50) | 29 ms → 31 ms | 149 ms → 148 ms | 324 ms → 326 ms |
| …p95 | 35 ms → 34 ms | 162 ms → 157 ms | 340 ms → 347 ms |
| Enter, to a command's output | 30 ms → 25 ms | 149 ms → 145 ms | 325 ms → 323 ms |
| 100,000 lines, to the last | 903 ms → 886 ms | 1006 ms → 895 ms | 1493 ms → **1142 ms** |
| **The slowest key while the folder's copy is made** (5,000 files) | 482 ms → **34 ms** | | |
| **The slowest key while the copy is sent** (1.6 MB of it) | | 387 ms → **165 ms** | 884 ms → **339 ms** |

The last two rows are the same thing seen twice. Five seconds after any
change to the folder the agent makes a copy of its text files for the relay
to keep, and sends it. Made on the agent's one loop, and sent as one frame
down the one socket, it stopped every terminal and every edit both times: for
as long as five thousand files took to read, and then for as long as the
host's uplink took to carry it — which for the lab's 1.6 MB is a fifth of a
second on `office`, and for 10 MB at 10 Mbit/s would be eight.

A key's echo crosses both links twice — 128 ms on `office` before anything
is done with it. On `near` it is two frames of the browser's: after a key the
browser draws before it takes what the network brought, and the terminal
draws on the frame after that. The guest beside them, who pressed nothing,
sees the same key a frame sooner.

### The host's disk, to a guest's page

A file saved on the host — written in place, and written beside itself and
renamed over, as editors do — to its text in the guest's open editor; a file
made or deleted, to the file list; fifty files at once and three thousand;
and what a guest's own command does, as that guest sees it.

| | near | office | abroad |
|---|---:|---:|---:|
| **A file saved, to the editor** (p50) | 108 ms → **35 ms** | 213 ms → **100 ms** | 376 ms → **189 ms** |
| …p95 | 259 ms → **51 ms** | 330 ms → **163 ms** | 606 ms → 588 ms |
| Saved by rename (p50) | 116 ms → **34 ms** | 213 ms → **99 ms** | 322 ms → **185 ms** |
| …p95 | 239 ms → **47 ms** | 314 ms → **113 ms** | 394 ms → **200 ms** |
| **A file made, to the list** (p50) | 171 ms → **31 ms** | 261 ms → **97 ms** | 317 ms → **184 ms** |
| …p95 | 235 ms → **35 ms** | 331 ms → **99 ms** | 372 ms → **186 ms** |
| A file deleted, from the list | 162 ms → **32 ms** | 176 ms → **95 ms** | 327 ms → **183 ms** |
| 50 files at once | 77 ms → **45 ms** | 183 ms → **113 ms** | 364 ms → **201 ms** |
| 3,000 files at once | 1245 ms → 1416 ms | 1459 ms → **642 ms** | 1524 ms → **666 ms** |
| `touch` in the guest's terminal, to the list | 160 ms → **41 ms** | 334 ms → **169 ms** | 450 ms → **346 ms** |
| `echo >>` in the guest's terminal, to the editor | 167 ms → **50 ms** | 174 ms → 170 ms | 409 ms → 353 ms |

The links alone are 64 ms of every `office` number here and 152 of every
`abroad` one. What a guest's own command does crosses them three times: the
Enter going, and the change coming back.

Three thousand files at once is one of two numbers, by which side of the
agent's first look the burst's end falls: a little over half a second, or a
second and a half — the tree is rebuilt whole at most once a second, and a
burst that is still going when it is first rebuilt waits for the next. It
was always the longer. A p95 here is the slowest of a dozen: `abroad`'s for
a file saved in place has one slow sample, before and after.

### A guest's page, to the host's disk

| | near | office | abroad |
|---|---:|---:|---:|
| A key in the editor, to the frame that shows it (p50) | 2 ms | 2 ms → 3 ms | 2 ms |
| …p95 | 11 ms → 14 ms | 11 ms → 14 ms | 9 ms → 8 ms |
| **The last key of a word, to the file on the host** (p50) | 527 ms → **264 ms** | 585 ms → **327 ms** | 681 ms → **416 ms** |
| …p95 | 662 ms → **268 ms** | 683 ms → **335 ms** | 778 ms → **419 ms** |

A quarter of a second of that is on purpose: the host writes when the typing
pauses, so that a word is one write and not seven.

### Two guests

| | near | office | abroad |
|---|---:|---:|---:|
| A key in one editor, to the other's (p50) | 8 ms → 7 ms | 137 ms → 141 ms | 316 ms → 315 ms |
| …p95 | 11 ms → 9 ms | 186 ms → **153 ms** | 595 ms → **321 ms** |
| A key in a terminal, to the other's | 10 ms → 11 ms | 141 ms → 140 ms | 318 ms → 317 ms |

Each crosses four links: a guest's edit goes to the host, and from the host
to everyone.

### What the host does for a guest, a dropped line, and coming back

| | near | office | abroad |
|---|---:|---:|---:|
| A search of 500 files' contents, typed to listed | 306 ms → **215 ms** | 482 ms → **369 ms** | |
| New file, Enter to its editor | 30 ms → 31 ms | 293 ms → 288 ms | |
| An upload of 10 MB | 97 MB/s → 96 MB/s | | |
| A download of 20 MB | 64 MB/s → 61 MB/s | | |
| The host's line cut for 10 s: its return, to "back" on the page | 5.75 s → **761 ms** | 5.86 s → **876 ms** | |
| The link opened again: to a terminal | 128 ms → 137 ms | 367 ms → 364 ms | 831 ms → 826 ms |
| …requests | 12 → **2** | 1 → 2 | 1 → 2 |
| …bytes | 2 KB → **336 B** | 143 B → 336 B | 143 B → 336 B |
| …and a file opened | 35 ms → 34 ms | 156 ms → 147 ms | 336 ms → 322 ms |

A search waits 150 ms of that for the typing to stop, in the page.

### The agent itself

With a session open, a guest in it and nothing happening.

| | near | office |
|---|---:|---:|
| **CPU** | 2.7% → **0.9%** | 2.3% → **0.8%** |
| Memory | 18.8 MB → **12.0 MB** | 18.4 MB → 16.2 MB |
| The binary | 7.1 MB → 7.2 MB | |

### Production

One session through `ajar.rishwanth.dev`, this tree's agent, from the
maintainer's network: before on 20 November at 03:00 IST, after at 19:45 the
same day, once the deploy was live. Sixteen hours apart is not the same
network, so only what moved by more than a link's worth is a change — and a
p95 that is one slow key in forty, as the echo's is, is that key.

| | before | after |
|---|---:|---:|
| The link, to the page asking a name | 325 ms | 335 ms |
| The name given, to a terminal at its prompt | 774 ms | 508 ms |
| Bytes to get there | 145 KB | 123 KB |
| The first file opened | 450 ms | 198 ms |
| A key, to its echo (p50 / p95) | 67 ms / 75 ms | 66 ms / 119 ms |
| Enter, to a command's output | 90 ms | 66 ms |
| A file saved on the host, to the editor (p50 / p95) | 206 ms / 291 ms | 56 ms / 70 ms |
| A file made, to the list (p50 / p95) | 157 ms / 276 ms | 52 ms / 61 ms |
| `touch` in the guest's terminal, to the list | 186 ms | 86 ms |
| The last key of a word, to the host's disk (p50) | 600 ms | 289 ms |
| A key in one editor, to the other guest's (p50) | 60 ms | 55 ms |
| The link opened again: requests, and to a terminal | 13, 330 ms | 2, 338 ms |

## What was changed, 20 November

Each found by a number above, and each measured against all of them.

**In the agent** — which reaches a host only with a release (0.0.10):

- **A change on the host's disk is sent when it has settled, not at the next
  tick.** The watcher gathered changes and flushed four times a second, so a
  file saved waited an eighth of a second on average and a quarter at worst
  before the network had it. A change out of quiet now goes twelve
  milliseconds after its last event (a save is several), fifty at most;
  flushes keep a beat of a tenth of a second, and a quarter after a burst,
  so a build is still a few patches a second and an install still one tree.
  A file saved, to the editor: 108 ms → **35 ms** on `near`,
  213 ms → **100 ms** on `office` — of which 64 ms is the
  links. A file a guest's own command makes, to their list:
  334 ms → **169 ms**.
- **Typing is written when it is due, and sooner.** It was written once it
  had paused 400 ms — looked for by a tick four times a second, so up to 250
  more — and typing that did not pause was not written at all until it did.
  Now a quarter of a second after the last key, at that moment, and after two
  seconds whatever the typing is doing. The last key of a word, to the host's
  disk: 527 ms → **264 ms**.
- **Enter in a terminal writes every open file first.** What a command reads
  is what the page shows: a guest who edits a file and runs it at once used
  to run what was on disk before. No number here measures it; the lab's
  `echo >>` into an open file would lose to it otherwise.
- **A shell is kept started for the next terminal.** A shell takes half a
  second to start, two with a framework in its start-up files, and a guest
  who joined looked at an empty terminal for that long. The name given, to a
  prompt: 250 ms → **183 ms** on `near`, 566 ms → **467 ms** on
  `office`. Not for a terminal narrower than 80 columns, which starts its
  own as before ([agent.md](agent.md), "Terminals").
- **The folder's copy for the relay is made off the agent's loop.** Five
  seconds after every change the agent read every text file in the folder,
  wrote them out as one and sealed it — on the one loop that carries every
  key and every edit. For five thousand small files that was 0.45 s in which
  nothing moved: 482 ms → **34 ms** for the slowest key
  typed across it.
- **The copy is sent a piece at a time.** One frame of up to 25 MB, down the
  socket that carries every key's echo, held all of it back until the
  uplink had carried it. Now 32 KB pieces, each acknowledged by the relay,
  never more than 128 KB ahead ([protocol.md](protocol.md), "The folder's
  copy, to the relay"): 387 ms → **165 ms** for the slowest key typed
  across it on `office`, 884 ms → **339 ms** on `abroad`. It needs
  the relay's half, which is live with the deploy; with an older relay the
  copy goes whole, as before.
- **A search opens each folder once, and makes its pattern once.** Every file
  was found from the top of the shared folder a part of its path at a time —
  what keeps a path from leading out of it, and a dozen system calls a part
  on a Mac — and the pattern was compiled again for each: a fifth of a
  millisecond a file, a tenth of a second for five hundred small ones, four
  seconds for twenty thousand. Typed to listed, with the 150 ms the page
  waits: 306 ms → **215 ms**.
- **An idle agent is idle.** Every second it asked every process on the
  machine for everything about it — command line, environment, open files —
  to show what the terminals were running. Now it asks who is whose child
  when a terminal has been used, and what only the terminals' own processes
  are using. 2.7% → **0.9%** of a core.
- **A lost connection is tried again every second for half a minute** before
  the wait starts doubling; it doubled from the start, to eight seconds, so
  the longer a line had been down the longer it stayed down once it was
  back. The host's line back after ten seconds, to "back" on the page:
  5.75 s → **761 ms**.
- **A fast terminal's output goes in fuller frames.** It is read 8 KB at a
  time and each read was a frame; what is already waiting from the same
  terminal now goes with it, up to 64 KB. 100,000 lines, to the last, on
  `abroad`: 1493 ms → **1142 ms**.
- **Nagle's algorithm is off on the agent's socket.** Not in the lab's
  numbers, whose links end each side's TCP: on production, Enter to a
  command's output was a round trip slower than a key's echo, behind its
  own first frame.

**In the relay and the page** — live with a deploy:

- **The page's files are sent compressed and kept.** The relay sent them
  whole and said nothing of how long to keep them: a front compressed them on
  the way through, and a browser asked about every one again on every visit.
  Now a brotli or gzip copy made at the build is sent, and everything named
  for its contents is kept for a year. The link opened again:
  12 → **2** requests.
- **The editor is fetched before it is asked for.** A megabyte compressed,
  it was the wait before the first file showed. The page fetches it — and
  compiles it, without running it — when it is next idle after the first
  terminal has printed, unless the browser says the link is slow or in data
  saver. The first file: 865 ms → **270 ms** on `office`,
  2.04 s → **443 ms** on `abroad`.

**Two trades**, which the scorecard marks as worse and which were made on
purpose:

- **A guest who never opens a file has fetched the editor anyway**:
  942 KB once the page has settled, where getting to
  a terminal takes 123 KB. Nearly every guest opens a file;
  one on a metered or slow link is spared it.
- **The link opened again waits a round trip before the page shows**:
  32 ms → 98 ms on `office`, 34 ms → 287 ms on `abroad`.
  The page is now asked about each time, where a browser used to guess
  whether it had changed — and so could show, after a deploy, a page naming
  scripts the deploy had removed. Everything the page then loads comes from
  the browser's cache with no asking at all.

## What the scorecard caught on the way

- **Search.** It was on the list as a number to record; the tenth of a
  second for five hundred files was not expected, and was the path
  resolution and the pattern.
- **The copy's freeze.** Not on the list at all: found reading the loop for
  what could delay a change by a quarter of a second once in a while, and
  given a scenario of its own.
- **The first shell kept ready replayed wrongly on a phone** — a line of its
  own above the prompt, zsh's mark for an unfinished line wrapped — which is
  why a narrow terminal starts its own.
- **A test that held by luck**: "a child started since is counted" counted
  everything under the test process, where the tests beside it start and end
  shells. It has a shell of its own.

## Worse counts as worse past

As [performance.md](performance.md#worse-counts-as-worse-past) has it — a
time 15% and 40 ms slower, bytes 2% and 4 KB more, a key reaching another
browser 50% and 100 ms — and for what only a session has:

| Kind | Worse when |
|---|---|
| The agent's idle CPU | half as much again, and a point |
| Its memory | 15% and 5 MB more |
| Its binary | 5% bigger |
| Requests | more than one more |
| MB/s | 10% fewer |

A p95 here is over a dozen samples: one slow one moves it. Two runs that
differ only there are the same.

## What it does not cover, and what is left

- **A key between two guests crosses four links, not two.** A guest's edit
  goes to the host and from the host to everyone, which is what makes the
  host the one place a document is; the relay could pass it to the other
  guests as it passes it to the host. Each is sealed for the direction it
  travels, so that is a change to the protocol and to what the seal covers,
  not to a timer. 137 ms → 141 ms on `office`, of which
  128 is the links.
- **The first terminal still waits for the page to ask for it**: a round
  trip, 128 ms on `office`. The host could open it as the guest joins.
- **A megabyte of file is a megabyte on the wire.** What is sealed cannot be
  compressed by anything after it; compressing before sealing would make a
  megabyte of text a fifth of that. 514 ms → 521 ms on `office`.
- **The editor's first run is a tenth of a second of the page's thread**,
  at the first file opened; it could run while the page is idle too, at the
  cost of that tenth then.
- **The lab's shell and CPU are this machine's**; its links carry bytes, not
  TCP. Firefox and Safari: Chromium only. CI runs none of it.

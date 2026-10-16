# The pad store

How the relay keeps pads on disk, since 11 October 2026. It replaced one JSON
document per pad, which every save read, parsed and wrote back whole.

## Why it changed

Measured on 11 October in a Linux container held to the unit's 512 MB, with a
release build, saving one small file into a pad of each size:

| Pad | One small save | Relay's peak memory |
|---|---|---|
| 5 MB | 7 ms | 29–49 MB |
| 25 MB | 35 ms | 150 MB, 275 MB after a few such pads |
| 60 MB | 130 ms | 262 MB fresh; killed after other large pads before it |

Every keystroke's save cost about four times the whole pad in memory and
rewrote all of it, and the allocator did not give the memory back quickly
enough: a relay that had already saved a few large pads was killed by its own
cgroup on the next. The 60 MB cap raised on 7 October could take the relay
down, with every session on it.

And after, measured the same way — three 60 MB pads in turn in one relay, the
sequence that killed it before:

| Pad | One small save | Relay's peak memory | Full read |
|---|---|---|---|
| 5 MB | 1 ms | 15–25 MB | 87 ms |
| 25 MB | 1 ms | 53 MB | 336 ms |
| 60 MB, three in turn | 1 ms | 58–82 MB, flat | ~780 ms |

A save costs the files it names; a read is streamed, as it was. A keystroke in a
300 KB file, sent as the edit, is a 165-byte request (`pair-check`).

### One large file

Those pads were many 2 MB files. Later the same day, one large file and twenty
one-character saves into it, the way the browser sends them, told a different
story:

| File | One save | Relay's peak memory | On disk after twenty saves |
|---|---|---|---|
| 25 MB | 188 ms | 170 MB | 535 MB |
| 60 MB | 307 ms | 274 MB; killed when it followed the 25 MB one | 1.3 GB |

An edit was applied by reading the stored file whole, decoding it, rebuilding
it and encoding it again: three copies of the file at once. And a blob is never
changed, so every save made a new one, while the one it replaced stayed ten
minutes or more, uncounted by the ceiling. So now ([below](#a-save)) an edit is
streamed from one blob to the next, a replaced blob goes at once, and a request
is at most 24 MiB. The same run after, in one relay, one file after another:

| File | One save | What a save adds to memory | On disk after ten saves |
|---|---|---|---|
| 25 MB | 92 ms | nothing | 26 MB, one copy |
| 60 MB | 220 ms | nothing | one copy |
| 99 MB | 370 ms | nothing | one copy |

What is left is the uploads: each part is a request the relay holds with the
text parsed out of it, and glibc kept what those used — 261 MB after files of
25, 60 and 99 MB, none of it in use. With its mmap threshold fixed at 1 MiB
(`MALLOC_MMAP_THRESHOLD_` in `deploy/ajar-relay.service`) the same run peaked at
122 MB and held 59 afterwards.

A save in a large file still copies it on disk, about 370 ms for 99 MB. Keeping
a file in pieces, so that a save copies only the piece it changes, would end
that; nothing has needed it yet.

## What is on disk

```
pads/
  store.db        SQLite: which pads exist, their files, their leases
  blobs/ab/<hash> each file's text, stored once, as the JSON string it is sent as
  legacy/         the one-document-per-pad files, kept after they were imported
```

- **`pads`**: name, sequence, created, updated, last touched (the lease), the
  pad's size as the caps count it.
- **`files`**: pad, path, the blob it holds, its encoding, the sequence it last
  changed at, its size.
- **`blobs`**: hash, size on disk, how many files hold it, and since when none
  has.

A blob is named by the SHA-256 of its encoding and contents, so the same text
is stored once however many pads hold it — a starter file, a copied pad, an
imported zip. It is written before the transaction that refers to it and never
changed after.

## A save

1. Each changed file's next blob is written beside the store, without the
   store's lock: a large one takes a while, and every pad's reads and saves
   wait on that lock. Text that is already stored is not written again. An
   edit is applied by streaming the blob it names into the new one.
2. Under the lock, the blobs are renamed into place, and one transaction moves
   the paths onto them, counts references, advances the sequence and checks the
   caps. It either happens whole or not; if not, the blobs it put in place are
   deleted.
3. A blob nothing refers to any more is deleted then, unless something is
   using it: a read still sending it, or an edit being applied to it. Those are
   marked while they run, and what they kept goes at the next write, or the
   hourly sweep.

What a save costs is the files it changes. The rest of the pad is not read.

## A read

The response is the same JSON as before. It is assembled as it is sent: the
pad's fields, then each file's fixed parts around its blob, read from disk a
chunk at a time. Its length is known before the first byte, from the blobs'
sizes. Memory is a chunk, whatever the pad's size.

## A save that sends only what changed

A browser saving a file it already holds can send the edit rather than the file:
the stored file's hash, and what to remove and insert where, in UTF-16 code
units, as a browser counts. The relay applies it only to the version it names,
of the encoding it names; if the stored file has moved on, the whole write is
refused with 409 and the browser sends the full file instead. Reads and writes
return each file's hash so the browser knows what it has.

The edit is applied without loading the file (`pad/splice.rs`): the stored JSON
string is read in 64 KiB pieces and copied through, the edit put in where it
falls, and the result hashed on the way. Edits to one file go in order, and a
file is edited in a request of its own.

## A write bigger than one request

A browser sends at most 24 MiB of JSON a request (`REQUEST_BYTES` in
`pad/src/store.ts`) and the relay reads at most 33 MiB (`MAX_PAD_HTTP_BODY`).
Small changes go together while they fit. A file bigger than that goes as its
first part, then each next part as an edit adding it to the end, against the
hash the answer before gave for it; a paste bigger than that, the same way from
where it was made. An upload of a full 100 MB pad is five requests or so.

The parts are separate writes. If one fails, the ones before it have landed,
and a file sent in parts holds only those until it is saved again.

Working out the requests is measured, not walked: `JSON.stringify` and a check
for anything that is not ASCII, and a piece's length guessed from the bytes per
character so far, then measured. Walking every character in script cost 175 ms
for 58 MB of files and 385 ms for one 58 MB file, on the page's main thread;
now 88 ms for either, about what serialising the request costs anyway. A write
that would fit in one request even at six bytes a character — every save, and
nearly every command — is not measured at all.

## Old against new, 11 October

Every case measured before, run again on the release before these changes
(`e2b7015`) and after them, on one machine in one session, so nothing is
compared with a number from another day. The relay in a Linux container held
to 512 MB, three runs of each case; the page in headless Chromium against a
local relay, in the order old, new, new, old. Where the ranges overlap, there
is no difference to report.

| Relay | Before | After, as deployed |
|---|---|---|
| 58 MB pad of 2 MB files: a small save | 1–2 ms | 1 ms |
| the same pad: read whole | 723–750 ms | 798–832 ms |
| the same pad: relay's peak memory | 66–83 MB | 45–50 MB |
| 12 reads of a 24 MiB pad at once | 1026–1152 ms, peak 56–66 MB | 1038–1359 ms, peak 30–42 MB |
| one 25 MB file: a one-character save | 175 ms, peak 193 MB, 301 MB on disk | 97 ms, peak 27 MB, 26 MB on disk |
| one 60 MB file | the relay was killed | 268 ms, peak 45 MB |
| upload 58 MB as 2 MB files, the page's own code | 961–1670 ms, peak 132–183 MB | 1034–1040 ms, peak 79–81 MB |
| upload one 58 MB file | 1026–1814 ms, peak 239–290 MB | 1374–1597 ms, peak 122–125 MB |
| upload one 98 MB file | over the cap | 3.6 s, peak 137 MB |

| Page, a pad of 2 MB files | Editor ready | Terminal answering | A 30 MB file a command made, stored |
|---|---|---|---|
| 5 MB | 0.3–0.5 s → 0.3–0.4 s | 3.0–4.0 s → 3.1–3.2 s | 1.2 s → 1.2–1.3 s |
| 60 MB | 0.8 s → 0.8 s | 3.6–4.7 s → 3.7 s | 1.5–1.6 s → 1.4–1.5 s |
| 100 MB | 1.2 s → 1.2–1.3 s | 4.1–4.3 s → 4.2–4.3 s | 1.7 s → 1.6–1.8 s |
| 200 MB | 2.2 s → 2.1 s | 5.8–5.9 s → 5.6–5.7 s | 2.3–2.5 s → 2.2–2.4 s |

A command's small change was stored 0.0–0.2 s after Enter in both, at every
size. In one large file: opening it, typing forty characters and the save after
were the same; switching back to it took a median of 102 ms before and 88 ms
after at 10 MB, 71 ms both at 20 MB; a 30 MB file, live before, now opens
read-only in 30–70 ms.

What it found, and what was done:

- **Working out the requests** was the slower path — above.
- **Switching back to a 20 MB file was 18 ms slower**, every time: counting
  its bytes, to decide whether it can be live, encoded the whole text once, and
  every later rebinding of that file's document was slower for it. The bytes
  are now counted a line at a time (`utf8Of` in `editing.ts`), and the gap is
  gone.
- **One large file uploads more slowly** than when it went in one request —
  about 0.4 s at 58 MB — because each part after the first is added by copying
  the file so far. That is what holds the relay to half the memory, and it is
  left as it is: a 32 MiB part would save a tenth of a second.

## Upgrading, and going back

On startup, every `<name>.json` in the pad directory is imported — files,
sequences, timestamps and lease — and moved into `legacy/`. A crash part-way
leaves pads already imported marked so; the next start finishes the rest.

`ajar-relay --export-pads <dir>` writes every pad back out in the old format,
which the relay before this change can read: the way back is that, and the old
binary.

## What it does not change

The HTTP API, the leases, owned pads, and the store's ceiling, which now counts
each blob once.

The caps went up after it, on 11 October, once the measurements above held: a
pad from 60 MB to 100 MB, what an address may add in a day from 256 MiB to 512,
and an account's room from 100 MB to 250.

## History

Since 16 October a pad keeps earlier versions of itself. A version is the
pad's manifest, path to blob, at a moment:
- `versions` holds one row each, with when it was kept, the `seq` it was at,
  and how many files and bytes it named.
- `version_files` holds its files.

Each file holds its blob the way a current file does, by a count in `blobs`.
So a version costs nothing for the files it shares with the pad or with
other versions. What it does cost is counted by `used` and held to the
ceiling like any file.

**When.** In the save's own transaction, before the save changes anything,
the pad as it stood is kept if the newest version is at least
`VERSION_EVERY` old, ten minutes. That gives:
- the way it was left, for the first save after a pause
- one every ten minutes, through a long session

Making a pad is not a version of it. `POST /api/pad/<name>/history` keeps
the pad as it is now (`keep_now`), unless the newest version already names
the same blobs. The page asks for it before a restore, so a restore can be
undone the same way.

**How many.** At most `VERSIONS_KEPT`, 30, naming at most `HISTORY_BYTES`,
200 MB, between them, and nothing older than `VERSION_AGE`, 30 days. The
oldest go first, and the newest always stays. Deleting a pad, or its lease
lapsing, lets go of its history with it. The tests of how blobs are let go
run on a store with history off, because a version would hold the very blob
they watch go.

**Reading.**
- `GET /api/pad/<name>/history` lists the versions, for anyone who may read
  the pad.
- `GET …/history/<id>` gives one version's files, in the shape a read gives a
  pad's.
- Keeping one with `POST` needs edit.

**Restoring is the page's, not the store's.** Open documents hold the live
text, so a rewrite in the store would be saved over by the next keystroke.
The page writes the version's files into the sandbox behind its own back, as
a command copying them would. It then publishes them the way a command's
changes are published: open documents, everyone else on the pad and the store
all take them, and typing meanwhile is kept (`restoreVersion` in app.ts).
`pair-check.mjs` restores from one place and checks that the other place's
open document, the store and the history all agree.


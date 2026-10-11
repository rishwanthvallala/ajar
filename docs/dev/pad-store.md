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

1. Each changed file's blob is written if no blob of that hash exists.
2. One transaction moves the paths onto their new blobs, counts references,
   advances the sequence and checks the caps. It either happens whole or not.
3. A blob nothing refers to any more is deleted ten minutes later by the
   sweeper, not at once: a read already streaming it keeps its file.

What a save costs is the files it changes. The rest of the pad is not read.

## A read

The response is the same JSON as before. It is assembled as it is sent: the
pad's fields, then each file's fixed parts around its blob, read from disk a
chunk at a time. Its length is known before the first byte, from the blobs'
sizes. Memory is a chunk, whatever the pad's size.

## A save that sends only what changed

A browser saving a file it already holds can send the edit rather than the file:
the stored file's hash, and what to remove and insert where, in UTF-16 code
units, as a browser counts. The relay applies it only to the version it names;
if the stored file has moved on, the whole write is refused with 409 and the
browser sends the full file instead. Reads and writes return each file's hash
so the browser knows what it has.

## Upgrading, and going back

On startup, every `<name>.json` in the pad directory is imported — files,
sequences, timestamps and lease — and moved into `legacy/`. A crash part-way
leaves pads already imported marked so; the next start finishes the rest.

`ajar-relay --export-pads <dir>` writes every pad back out in the old format,
which the relay before this change can read: the way back is that, and the old
binary.

## What it does not change

The HTTP API, the caps, the leases, owned pads, the per-address and per-account
allowances, and the store's ceiling, which now counts each blob once.

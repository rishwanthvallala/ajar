# The relay

`crates/ajar-relay`. It routes frames, owns session lifecycle, meters
addresses, and — for the pad only — keeps folders on disk.

It parses nine bytes of each frame and forwards the rest. See
[protocol.md](protocol.md) for why that matters and what it buys.

## Backpressure

Every connection has a bounded outbox, and one that falls too far behind is
**closed rather than fed a lossy stream**. Terminal output with holes in it is
worse than a clean disconnect: a client would render a corrupted screen with
no way to know. Dropping the socket puts it on the reconnect-and-replay path,
which is already tested.

| | |
|---|---|
| Accumulation cap | 8 MB, or 2,048 frames |
| One large frame | Always allowed when the queue is empty — a snapshot is legitimately megabytes |
| Inbound frames | Capped at 32 MB, above the 25 MB the store accepts |

The cap governs *accumulation*, not the size of any single frame. Refusing a
snapshot to defend against a problem snapshots do not cause would break a
working feature for nothing.

The first version had a bug worth remembering: signalling overflow with
`notify_waiters` alone wakes only tasks that are *already parked*, so an
overflow landing while the writer was mid-send vanished and the connection
limped on. It latches a flag now, checked before parking. There is a test
named after that failure.

## Reconnect keeps unsealed frames

Frames parked for a reconnecting socket are stored **unsealed** and sealed on
the way out. Sealing before parking binds each frame to a nonce and a header
that may no longer be correct by the time it is actually sent, and the result
was dropped keystrokes after a reconnect.

## The pad store

`crates/ajar-relay/src/pad.rs` is the one durable thing in a binary whose
whole design is that a restart losing everything is correct. It exists because
the pad has no agent, so the files have to live somewhere.

### Concurrent writes

`Store::write` is read-modify-write. Without a lock, two browsers writing at
once did not merely lose an update — they **failed outright**, because both
wrote to a shared temp filename and whichever renamed first destroyed the
other's file in progress, leaving `No such file or directory`.

Two fixes together: 64 striped `parking_lot::Mutex` locks keyed by name, and a
per-call atomic counter in the temp filename. Either alone is insufficient —
the stripe serialises writers to one pad, the counter stops unrelated writers
colliding on the temp path.

### Reads are streamed from the file

A pad read does not load the pad. `Store::open_for_read` checks the lease with a
parse that keeps only `updated_ms`, then hands back the open file positioned
past its opening brace, and the handler sends `{"exists":true,` followed by the
file. The stored document already is the response; the only difference was
that one field. One descriptor serves the check and the bytes, so they are the
same version even if a write renames a new file into place meanwhile.

It used to parse, rebuild and re-serialise the whole pad per read — three copies
in memory at once — and twelve concurrent reads of a 24 MiB pad grew the relay
by 647 MiB. See [security.md](security.md#what-bounds-an-anonymous-caller).

### Reserved names

A pad name becomes a path on the origin, so anything the site already serves
must be refused: `packages`, `sw`, `index`, `public`, `dist`, `api`, `assets`
and friends. A pad called `sw` would sit underneath `/sw.js` with no way to
recover the name — and since **a name is never reused**, the loss is permanent.

The test reads the routes out of `deploy/Caddyfile` and asserts each one is
reserved. It used to say that and not do it: the list was written by hand in
the test, so it asserted a property it was not measuring. That drifted the
first time it mattered — `/wisp` and `/dns-query` were added to this origin in
September 2026 and neither the constant nor the test noticed, leaving `wisp`
claimable as a pad name and shadowed by the route.

It now parses the pad origin's block, so a route added to the Caddyfile fails
the test until the name is reserved. Scoped to that block on purpose: the
preview origin serves `/wasmer-host.js`, which is a different hostname and not
a name a pad could collide with. Both directions are checked — removing a
reserved name fails, and adding an unreserved route fails.

### Lifetime

A folder untouched for a week is deleted. **The name is never reused**, so a
link shared in a tutorial can never later resolve to a stranger's files.

## Session shapes

See [protocol.md](protocol.md#session-shapes). The relay is where the rule is
enforced: `join_peer` refuses a hosted session and the hosted join path refuses
a peer, both with `wrong_shape`.

## What the relay serves

Besides `/ws`:

| Path | What |
|---|---|
| `/` | The landing page |
| `/j/<session>` | The session client |
| `/install.sh`, `/run.sh` | Compiled into the binary, rewritten to point at this relay |
| `/api/pad/*` | The pad store |
| `/packages/*` | Mirrored WASIX packages, pre-compressed |
| `/healthz` | Liveness |

`install.sh` is compiled in rather than deployed alongside, so the published
installer cannot drift from the binary that was built. The relay rewrites the
address in it before serving, so a self-hosted relay hands out a one-liner for
*its* address.

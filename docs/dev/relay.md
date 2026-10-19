# The relay

`crates/ajar-relay`. It routes frames, owns session lifecycle, meters
addresses, and — for the pad only — keeps folders and the accounts database on
disk.

It parses nine bytes of each frame and forwards the rest, apart from the
control channel and the stored copy's envelope, which it has to read. See
[protocol.md](protocol.md) for why that matters and what it buys. One more
exception, since 4 October: from a viewer in an account pad's room it reads
the first byte of a doc payload, to let through only a request for a
document's state.

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
| Inbound frames | Capped at 32 MB, above the 25 MB a workspace snapshot may be (`MAX_SNAPSHOT_BYTES`) |
| A socket's first frame | 256 KiB (`MAX_HELLO_BYTES`); a bigger one is refused unread with `hello_too_big`, since 18 October |

A frame is shared between the queues it sits in, not copied into each
(`Bytes`): until 18 October a broadcast to a room of twenty held twenty
copies of every frame. Each queue still counts the whole frame against its
own 8 MB.

Every socket is pinged every 20 s, and one silent for 60 s — pongs count — is
treated as gone. Without it a socket dead without either end being told, a
laptop closed on one network and opened on another, stayed "connected" for
ever: a host's guests were never told it was away.

The cap governs *accumulation*, not the size of any single frame. Refusing a
snapshot to defend against a problem snapshots do not cause would break a
working feature for nothing.

The first version had a bug worth remembering: signalling overflow with
`notify_waiters` alone wakes only tasks that are *already parked*, so an
overflow landing while the writer was mid-send vanished and the connection
limped on. It latches a flag now, checked before parking. There is a test
named after that failure.

## Reconnect keeps unsealed frames

The relay never seals anything; this is its client's half of a reconnect. The
session client (`web/src/connection.ts`) parks frames for a reconnecting
socket **unsealed** and seals them on the way out. Sealing before parking binds each frame to a nonce and a header
that may no longer be correct by the time it is actually sent, and the result
was dropped keystrokes after a reconnect.

## The pad store

`crates/ajar-relay/src/pad.rs` and `accounts.rs` — and, since 17 October,
`usage.rs`'s counts for the operator's view — are the durable things in a
binary whose whole design is that a restart losing everything is correct. The
store exists because the pad has no agent, so the files have to live
somewhere; the accounts database because owning a pad has to outlive a
restart.

### What is on disk

Since 11 October 2026: `store.db`, a SQLite file of pads, their files,
leases, kept versions and last runs, and `blobs/`, each file's text once, as
the JSON string it is sent as, named by the SHA-256 of its encoding and
contents. A save writes the blobs of the files it changes and then one
transaction; a read sends the pad's fields and each file's blob in turn.
[pad-store.md](pad-store.md) has the design and the measurements behind it.

Since 18 October a save that was answered outlasts a power cut: each blob's
bytes are synced before it is renamed into place, its directory after (and
`blobs/`, when the directory is new), and only then does the row naming it
commit, with the database at `synchronous = FULL`. It was `NORMAL`, and
nothing synced a blob (audit B07).

It was one JSON document per pad, and every save — every keystroke's, every
half-second — read, parsed and wrote back the whole of it under a lock. On 11
October, saving one small file into a 60 MB pad took 130 ms and four times the
pad in memory, and a relay that had already saved a few large pads was killed
by its own `MemoryMax` on the next.

### Concurrent writes

One SQLite connection, and every change to the store under it: a write reads
the pad's rows, checks the caps and the file-or-directory rule on the result,
and commits, as one step. Two writes to one pad cannot both start from the same
version. A write's blobs are written before that, off the lock, so a large file
does not hold up every other pad; an edit applied meanwhile to a file another
write moved on is refused as stale when the write takes the lock. (The one-document store needed 64 striped locks and a unique temp name
per call for the same thing: without them two saves failed with `No such file
or directory` as each renamed the other's file away.)

### Reads are streamed from the blobs

A pad read does not load the pad. `Store::open_for_read` checks and renews the
lease, takes the list of files, and hands back the response as pieces — fixed
bytes, and the blob each file holds — with its length worked out from the
blobs' sizes. The handler sends `{"exists":true,"access":{…},` and then the
pieces, opening each blob only when it reaches it. Blobs never change, and the
read marks the ones it is sending as in use until its body is sent or dropped,
so it sends the version it looked at even if a write lands meanwhile. Any other
blob nothing holds is deleted as soon as a write lets go of it.

A read that sends `X-Pad-Seq`, the sequence it already has, is answered with
`"unchanged":true`, who the reader is to the pad and no files when the pad has
not moved past it (18 October). The page reads again on every welcome to its
room and every join or leave, and for a 78 MB pad each was 9 MB more to
download. A page opening the pad (`X-Pad-Open`) is always sent it whole.

Each file in a read carries its `hash`, which is what a browser sends edits
against. It used to parse, rebuild and re-serialise the whole pad per read —
three copies in memory at once — and twelve concurrent reads of a 24 MiB pad
grew the relay by 647 MiB. See
[security.md](security.md#what-bounds-an-anonymous-caller).

### A save can be the edit, not the file

A write may name a file's stored `base` hash and `edits` — what to remove and
insert where, in UTF-16 code units — instead of its `content`. The relay
applies them only to the version that hash names, and refuses the whole write
with 409 if it holds anything else; the browser then sends the files whole. A
browser computes the hash of the text it believes is stored, so the relay
applying an edit means the edit was measured against exactly that text. A
keystroke in a 300 KB file is a 165-byte request. The relay streams the edit
from one blob to the next rather than loading the file: memory stays flat
whatever the file's size ([pad-store.md](pad-store.md#one-large-file)).

### Writes are read whole, and stored two at a time

A write is the opposite case: its body is read off the wire before anything
can be checked, so its size is what it costs. The limit is
`MAX_PAD_HTTP_BODY`, 33 MiB. It was twice `pad::MAX_BYTES` plus 1 MiB — 121 MiB
at a 60 MiB cap — while a write could carry a whole pad; since 11 October a
browser sends at most 24 MiB a request, and a pad of up to 100 MiB, or one file
that big, in several ([pad-store.md](pad-store.md#a-write-bigger-than-one-request)).
Bodies being read share `PAD_BODY_BUDGET`, two whole bodies (66 MiB), taken
as their bytes arrive; one that sends nothing for 20 s, or is not in after ten
minutes, is refused with 408. `MAX_CONCURRENT_PAD_WRITES`, two, bounds how
many are parsed and stored at once, and the permit is taken once the body is
in. Waiting for room or for a permit is bounded at 20 s, then 503. Until 18
October the permit was taken before the body was read and held while it
arrived, so two uploads that stopped part-way held up every save (audit B04).
The two numbers only mean something together: a write holds its body and the
text parsed from it, and `main.rs` asserts that twice the budget — the body
times two, times two — 132 MiB, stays under 256 MiB, which leaves the rest of
the unit's `MemoryMax=512M` for sessions. Raising either past that does not
compile. One request may make at most 2,000 changes, 1,000 edits in one change
and 10,000 in all (`pad::MAX_WRITES`, `MAX_EDITS`, `MAX_EDITS_PER_REQUEST`),
counted as it is parsed, or it is refused with 413. See
[security.md](security.md#what-bounds-an-anonymous-caller).

### Reserved names

A pad name becomes a path on the origin, so anything the site already serves
must be refused: `packages`, `sw`, `index`, `public`, `dist`, `api`, `assets`
and friends. A pad called `sw` would sit underneath `/sw.js`, where nobody could
ever open it — its contents stranded until the lease ran out.

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

A folder nobody opens or writes to for **90 days** is deleted, and **its name
is free again**: whoever opens it next starts an empty folder there. Reads check
the lease too, so a lapsed pad is never served while it waits for the hourly
sweep. Its kept versions and last run go with it, and since 18 October are not
served before the sweep either, nor inherited by a new pad of that name.

The lease is the pad's `touched_ms`. A write sets it; opening a pad renews it,
at most once a day (`RENEW_EVERY`). It was the file's modification time while a
pad was one file. It was seven days and counted writes only, which deleted
exactly the pads people share — a demo opened daily and edited once a
fortnight.

A long lease is only safe with a per-address limit on growth, or one address
could fill the store and keep it full for a season: see
[security.md](security.md#what-bounds-an-anonymous-caller).

Only the sweeper deletes, and it decides under the store's lock by looking at
the pad as it is at that moment. Deciding from an earlier look would remove a
pad a write had just made fresh — somebody's new folder. The sweeper also
deletes blobs a read kept past the write that let go of them, and blob files
the table has not known for ten minutes (`GRACE`) — left by a relay that
stopped between writing a blob and recording it.

**A pad that belongs to an account never lapses.** The relay reads the owned
names from the accounts database at start and pins them in the store, and a
new one is pinned as it is made; the sweeper and the read path both skip a
pinned name. Deleting an account pad removes its rows at once and keeps the
name's row, so the name stays retired — nobody can take it over anonymously.
See [accounts](accounts.md).

It was the opposite until September 2026: a lapse left a `<name>.tomb`, and the
name answered 410 "will not be reused" forever, so that a link in a tutorial
could never later show a stranger's files. The cost fell on exactly the names
people use — `/demo` became a page that could only refuse — and the tombstones
were an unbounded count nobody could reclaim. The trade was reversed
deliberately: an old link now opens an empty folder, or somebody else's newer
one. Opening the store deletes any tombstones the old policy left.

## Accounts

`accounts.rs` is the database: SQLite in WAL mode beside the pad store, opened
once, every call a few rows by key behind one mutex and run off the async
workers. `auth.rs` is sign-in (OAuth with PKCE, blocking `ureq` calls off the
workers too), and `http_accounts.rs` the routes: `/auth/{provider}/start`,
`/auth/{provider}/callback`, `/auth/logout`, `/api/me` (`DELETE` deletes the account),
`/api/my/names/{name}` and `/api/my/pads…`.

Who you are to a pad is `Accounts::access(name, user, code)`, and what asks
is every `/api/pad/…` route in `main.rs` — a read, a write, the history, a
version, the last run — and the link preview, as nobody; and in `ws.rs` the
peer join, and the host or guest join, to refuse an owned pad's name. A pad
with no row is anonymous and everyone is an editor, as before. A lookup that
fails grants nothing: a 503 over HTTP, `unavailable` on the socket (since 18
October; it was read as no row). On a relay with a public origin the sign-in
cookie counts only from our own pages, since the same day: with no `Origin`, an `Origin` in `AJAR_PUBLIC_ORIGIN` or
`AJAR_TRUSTED_ORIGINS`, or `Sec-Fetch-Site: same-origin`
(`Auth::trusts_cookie_from`). In the room, a viewer's frames are dropped
unless they ask for a document's state or say they have none.

`http_admin.rs` is `/api/admin/stats`, for the people named in `AJAR_ADMINS`
and a 404 to everyone else. Its figures are `usage.rs`'s, counted as things
happen and kept in `usage.db` beside the accounts database.

When who may open a pad changes — a setting, a revoked or reset link —
everyone in its room but its owners is closed with a `closed` notice and
rejoins on what they hold now (`Registry::evict_peers`); when the pad or its
account is deleted, everyone is, owners too, and rejoining finds it gone.
Signing out closes every room connection that sign-in made an owner: the room
keeps owners by their session's hash (`Registry::evict_session`). Since 18
October an owner is let in only if its sign-in is still live, asked under the
room's lock (`Registry::join_peer_checked`, `signed_out` otherwise), and is
let go the same way when that sign-in runs out (`Registry::evict_peer`).

The rest is in [accounts](accounts.md) and
[security.md](security.md#pads-that-belong-to-an-account).

## Session lifecycle

What the relay does when a host or guest drops, comes back or is locked out is
in [protocol.md](protocol.md#what-survives-what). In short: a dead host socket
is replaced by the agent holding the session's key, not refused as
`host_taken`. A host coming back is metered as a join, not as a new session. A
guest who arrives while the host is away is told `host_away` with the time
left. A locked session takes back the guests it let in, by the hash of their
`resume` secret, until one is kicked; after a relay restart the agent's
`admitted` list restores them.

## Session shapes

See [protocol.md](protocol.md#session-shapes). The relay is where the rule is
enforced: `join_peer_checked` refuses a hosted session and the hosted join
path refuses a peer, both with `wrong_shape`. A host or guest naming a pad
that belongs to an account is refused the same way before anything is created,
so nobody can hold an owned pad's room shut. A pad page refused this way shows **Not live**
and keeps retrying, backing off to 8 s.

## What the relay serves

Besides `/ws`:

| Path | What |
|---|---|
| `/` | The landing page; its one-liner names the origin it was served from |
| `/j/<session>` | The session client |
| `/install.sh`, `/run.sh` | Compiled into the binary. `run.sh` is rewritten to point at this relay; `install.sh` is served as written |
| `/api/pad/<name>` | The pad store: a pad (`GET`, `PUT`), its history and versions (`/history`, `/history/<id>`), its last run (`/run`) |
| `/api/unfurl/<name>` | A page of Open Graph tags for a pad link, which Caddy sends chat apps' link-preview fetchers to |
| `/api/usage/run` | A run counted, for the operator's view — 60 a minute per address |
| `/auth/*` | Signing in and out |
| `/api/me`, `/api/my/names/<name>`, `/api/my/pads…` | The signed-in account, whether a name is free, and its pads |
| `/api/admin/stats` | The operator's view |
| `/healthz` | Liveness: `ok`. With `?deep=1`, whether the pad can be used: both databases asked for a row within 5 s, `ready` or 503 and why. The deploy waits for that one |

Any other path under `/api/` is a 404; until 18 October it fell through to the
web client and answered 200 with its page. There is no CORS layer, since the
same day: nothing of ours calls this API from another origin.

The mirrored WASIX packages, `/packages/*`, are not the relay's: Caddy serves
them off disk, pre-compressed.

Both scripts are compiled in rather than deployed alongside, so what is
published cannot drift from the binary that was built. `run.sh` is the one
that names a relay, and the relay rewrites that address to the origin that
served it (from `Host` and `X-Forwarded-Proto`), so a self-hosted relay hands
out a one-liner that dials *it* rather than quietly sending someone's session
to ours. `install.sh` names no relay — it fetches the agent from GitHub
releases — so it is served unchanged. The landing page's command is built
from `location.origin` for the same reason: it names the origin the page came
from. It used to name `ajar.sh`, a domain nobody owns.

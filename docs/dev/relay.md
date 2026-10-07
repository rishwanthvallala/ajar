# The relay

`crates/ajar-relay`. It routes frames, owns session lifecycle, meters
addresses, and — for the pad only — keeps folders and the accounts database on
disk.

It parses nine bytes of each frame and forwards the rest. See
[protocol.md](protocol.md) for why that matters and what it buys. One
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

`crates/ajar-relay/src/pad.rs` and `accounts.rs` are the durable things in a
binary whose whole design is that a restart losing everything is correct. The
store exists because the pad has no agent, so the files have to live
somewhere; the accounts database because owning a pad has to outlive a
restart.

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

A pad read does not load the pad. `Store::open_for_read` checks the lease from
the file's modification time, then hands back the open file positioned past its
opening brace, and the handler sends `{"exists":true,"access":{…},` followed
by the file. The stored document already is the response; the only difference
is those two fields — `access` is who the caller is to the pad. One descriptor serves the check and the bytes, so they are the
same version even if a write renames a new file into place meanwhile.

It used to parse, rebuild and re-serialise the whole pad per read — three copies
in memory at once — and twelve concurrent reads of a 24 MiB pad grew the relay
by 647 MiB. See [security.md](security.md#what-bounds-an-anonymous-caller).

### Writes are read whole, two at a time

A write is the opposite case: its body is read off the wire before anything
can be checked, so its size is what it costs. The limit is
`MAX_PAD_HTTP_BODY`, twice `pad::MAX_BYTES` plus 1 MiB — 121 MiB since a pad
went to 60 MiB on 7 October — because JSON escaping doubles quotes, backslashes
and newlines. `MAX_CONCURRENT_PAD_WRITES`, now two (it was four at 25 MiB),
bounds how many are read at once. The permit is taken before the body is read,
so a queued write costs a connection rather than 121 MiB. The two numbers only
mean something together: `main.rs` asserts their product, 242 MiB, stays under
256 MiB, which leaves the rest of the unit's `MemoryMax=512M` for sessions.
Raising one alone does not compile. See
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
sweep.

The lease is the file's **modification time**, not a field in the document. A
write renames a new file into place, which sets it; opening a pad renews it,
at most once a day (`RENEW_EVERY`), with a metadata update rather than a
rewrite. Neither path has to parse the pad, and the sweeper only `stat`s each
file. It was seven days and counted writes only, which deleted exactly the pads
people share — a demo opened daily and edited once a fortnight.

A long lease is only safe with a per-address limit on growth, or one address
could fill the store and keep it full for a season: see
[security.md](security.md#what-bounds-an-anonymous-caller).

Only the sweeper deletes, and it decides under the pad's lock by looking at the
file as it is at that moment. Deciding from an earlier read and deleting by path
would remove whatever a write had just renamed onto that path — somebody's new
folder.

**A pad that belongs to an account never lapses.** The relay reads the owned
names from the accounts database at start and pins them in the store, and a
new one is pinned as it is made; the sweeper and the read path both skip a
pinned name. Deleting an account pad removes its file at once and keeps the
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
`/auth/{provider}/callback`, `/auth/logout`, `/api/me` (`DELETE` deletes the account) and `/api/my/pads…`.

Who you are to a pad is `Accounts::access(name, user, code)`, and the two
places that ask are `read_pad`/`write_pad` in `main.rs` and the peer join in
`ws.rs`. A pad with no row is anonymous and everyone is an editor, as before.
In the room, a viewer's frames are dropped unless they ask for a document's
state or say they have none.

`http_admin.rs` is `/api/admin/stats`, for the people named in `AJAR_ADMINS`
and a 404 to everyone else.

When who may open a pad changes — a setting, a revoked or reset link —
everyone in its room but its owners is closed with a `closed` notice and
rejoins on what they hold now (`Registry::evict_peers`); when the pad or its
account is deleted, everyone is, owners too, and rejoining finds it gone.
Signing out closes every room connection that sign-in made an owner: the room
keeps owners by their session's hash (`Registry::evict_session`).

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
enforced: `join_peer` refuses a hosted session and the hosted join path refuses
a peer, both with `wrong_shape`. A host or guest naming a pad that belongs to
an account is refused the same way before anything is created, so nobody can
hold an owned pad's room shut. A pad page refused this way shows **Not live**
and keeps retrying, backing off to 8 s.

## What the relay serves

Besides `/ws`:

| Path | What |
|---|---|
| `/` | The landing page; its one-liner names the origin it was served from |
| `/j/<session>` | The session client |
| `/install.sh`, `/run.sh` | Compiled into the binary. `run.sh` is rewritten to point at this relay; `install.sh` is served as written |
| `/api/pad/*` | The pad store |
| `/auth/*` | Signing in and out |
| `/api/me`, `/api/my/pads…` | The signed-in account and its pads |
| `/api/admin/stats` | The operator's view |
| `/healthz` | Liveness |

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

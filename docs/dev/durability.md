# Keeping the data: durability options

What pad holds, what can lose it, the ways to keep it, and what each costs in
money, work and fragility — for a service that should run for years with
nobody watching it, for free. Written 17 October 2026, before any of it is
built; the recommendation at the end is a proposal, not what runs.

Today nothing is copied anywhere. Every pad, every account and every share
link lives on one EBS volume in Mumbai.

## What there is to keep

All of it is under `/var/lib/ajar` on the relay, plus a few secrets in
`/etc/ajar`.

| What | Path | Changes | If lost | Copy it how |
|---|---|---|---|---|
| Accounts: people, sign-ins, who owns which pad, share links (as hashes and sealed copies), chosen names | `accounts.db` (SQLite, WAL) | on every sign-in, new pad, setting | every owned pad becomes nobody's; every edit link stops working | as SQLite (below), never as a plain file copy |
| The key that opens the sealed copies of links, so the dashboard can show a link again | `accounts.key` (32 bytes) | never, after the first start | the dashboard cannot show existing links again; **the links themselves keep working** | once, by hand, into a password manager — and *not* with the database (together they are every edit link) |
| The pads: which exist, their files, leases, history, last runs | `pads/store.db` (SQLite, WAL) | on every save — half a second after typing stops | every pad | as SQLite |
| The files' contents | `pads/blobs/ab/<sha-256>` | added on save; never changed; deleted when nothing holds them | the pads' text | as files: content-addressed and immutable, so copying only new ones is enough |
| Pads from before 11 October, as imported | `pads/legacy/` | never | nothing current | once |
| Usage counts for `/admin` | `usage.db` (SQLite) | every 30 s | the history of the charts | as SQLite; optional |
| Secrets: OAuth client ids and secrets, `AJAR_ADMINS`, `AJAR_PUBLIC_ORIGIN` | `/etc/ajar/relay.env`, the wisp unit's env | when a secret is rotated | sign-in stops until re-entered | once, by hand, into a password manager |

How big: the store has a ceiling of **4 GiB** (`pad::MAX_STORE_BYTES`),
history included, so a full copy of everything is under 5 GB however busy
pad gets. The real figure is on `/admin` (Storage) or:

```sh
! ssh ajar-relay 'sudo du -sh /var/lib/ajar/*.db /var/lib/ajar/pads/store.db /var/lib/ajar/pads/blobs /var/lib/ajar/pads/legacy'
```

**Not worth keeping:** Caddy's certificates (Let's Encrypt issues new ones on
the first start), logs, the deployed binaries and the site (all built from
git). **Worth one copy:** the pad's runtime packages, `/srv/ajar/pad/packages`,
1 GB — rebuildable, but the Java one takes containers and most of an hour, and
today it exists only on the relay, the laptop and CI's evictable cache.

### Why "as SQLite"

A SQLite database in WAL mode is two files that change together. Copying
`store.db` while the relay writes can catch it half way: a copy that will not
open, or one that opens and is subtly wrong. A copy has to come from SQLite
itself — `VACUUM INTO`, the backup API, or a tool that reads the WAL the way
SQLite does (Litestream).

### Why the blobs need care too

`store.db` names blobs; the blobs are files beside it. A copy of the database
from 12:00:00 needs every blob it names, so the blobs must be copied *no later*
than the database, and a blob the live store has since deleted must still be
in the copy. Two rules make that hold: copy blobs without ever deleting in the
copy at the same moment, and keep deleted ones for as long as the oldest
database copy you might restore.

## What can go wrong

| | Example | What protects against it |
|---|---|---|
| The disk or the machine dies | EBS failure, instance retired | any copy off the volume |
| We break it | a migration bug, a bad deploy, a wrong `rm` | copies from *before* — point-in-time history, not just the latest |
| The account goes | AWS Free plan ends 25 February 2027, or credits run out; a future free host suspends us | a copy **with another provider** |
| The server is broken into | an attacker deletes the data and then the backups | a backup the server **cannot delete** |
| The backup quietly stops | an expired key, a full bucket, a changed free tier | **an alarm when it stops**, and a restore that is tested |
| One backup provider goes | free tier withdrawn, account closed | a second, independent copy |

The last two are what decide whether "unattended for years" is real. Every
backup works the day it is set up; the ones that fail are the ones nobody
noticed stopping.

## The ways to keep it

### A. Disk snapshots (EBS, with Data Lifecycle Manager)

AWS copies the whole volume on a schedule, at one instant — the databases and
the blobs consistent with each other for free.

- **Loses at most:** the interval; hourly at best in practice.
- **Good:** no code, no tools on the server; restore is "make a volume from the
  snapshot". Consistent by construction.
- **Bad:** inside the same AWS account — gone with it, and with an attacker
  who has the account. Hourly is the floor. Cents a month, from the credits.
  Meaningless after a move off AWS.
- **Verdict:** a fine *extra* layer while on AWS. Not the answer.

### B. Periodic copies (every few minutes)

A timer on the server: copy new blobs, then `VACUUM INTO` each database, then
upload the snapshot — to any storage, with rclone.

- **Loses at most:** the interval, 5–15 minutes.
- **Good:** two well-known tools (sqlite3, rclone), easy to read, easy to
  restore by hand. Works with any destination, including your own machine.
- **Bad:** a full database snapshot each time (small now — MBs — but every
  time). The interval is the loss.
- **Verdict:** the simplest thing that works; good as the *second* copy.

### C. Continuous: Litestream for the databases, blobs as they are written

Litestream runs beside the relay, reads each database's WAL and ships every
change within a second; it keeps periodic full snapshots so a restore is
"latest snapshot + changes since", to any moment in its retention.
The blobs, immutable, are copied by rclone every minute (or faster).

- **Loses at most:** about a second of database, about a minute of blobs.
  A save in the last minute before total loss can come back as that one file
  missing its newest text — the restore check names any such file.
- **Good:** point-in-time restore ("the pads as they were at 14:32 yesterday"),
  so it also undoes our own mistakes. One static binary, no change to the
  relay. The restore is also the way to move to another host.
- **Bad:** one more daemon to keep running (systemd does). Litestream 0.5 is
  young (March 2026) — pin a later 0.5.x and test restores. In 0.5 it keeps
  one replica per database, so a second copy is a separate job.
- **Verdict:** the right core for "not a day, not even an hour".

### D. The relay copies blobs itself as it writes them

The same as C, with the minute closed: each new blob uploaded by the relay
before the save is answered.

- **Loses at most:** about a second of everything.
- **Bad:** code in the relay, an S3 client in it, and every save waiting on
  the network — a slow bucket becomes a slow pad.
- **Verdict:** only if C's minute ever matters in practice.

### E. Blobs inside SQLite

Put file contents back into `store.db` (SQLite handles blobs well), and
Litestream alone covers everything, consistently.

- **Bad:** undoes the October 11 redesign that made large files cheap to save;
  a big refactor for a minute's window. **Verdict:** no.

### F. A standby server

A second relay kept in step, ready to take over. Durability *and* uptime,
twice the machines, and "free" twice over. **Verdict:** out of scope.

| | Loses at most | Undo our own mistakes | Survives the account | Moving parts | Fits "free, unattended" |
|---|---|---|---|---|---|
| A. snapshots | 1 h | yes, hourly | **no** | none | only while on AWS |
| B. periodic | 5–15 min | yes, per copy | yes (other provider) | sqlite3, rclone, a timer | yes |
| C. Litestream + blobs | ~1 s / ~1 min | yes, any moment | yes | litestream, rclone, a timer | yes |
| D. write-through | ~1 s | with C | yes | relay code | needs care |
| E. blobs in SQLite | ~1 s | yes | yes | refactor | — |
| F. standby | ~0 | no | maybe | a second server | no |

## Where to keep the copies, for free, for years

Nothing free is promised for ten years. In 2026 alone Oracle halved its free
ARM machines; earlier, Heroku ended free dynos and Storj its free tier. So the
question is not which provider lasts, but how losing one stops being losing
the data: **two independent copies, and an alarm** that says when either
stops.

| | Free | Card | Over the limit | API | Can the server be kept from deleting? | Notes |
|---|---|---|---|---|---|---|
| **Backblaze B2** | 10 GB storage; uploads and listing free; downloads up to 3× storage | page silent; historically not needed for the free 10 GB — check at sign-up | without a card: refused (backups stop → alarm); with one: cents | S3 | **yes**: a key with `writeFiles` but not `deleteFiles` can only hide, and a lifecycle rule purges hidden files after N days | 10 GB free since 2015; the best fit |
| **Cloudflare R2** | 10 GB-month, 1 M writes, 10 M reads a month, no egress fees | **required** to enable R2 | billed ($0.015/GB) | S3 | partly: bucket lock rules | Litestream's per-second uploads can pass 1 M writes in a busy month unless slowed to 10 s |
| **Your NixOS machine** | your disk | no | your disk | SFTP / rsync | yes, if it pulls (the server never holds a key to it) | independent of every cloud; only as reliable as the machine, its power and its link; needs a path in (Tailscale, free for personal use) |
| **Oracle Object Storage** (Always Free) | 20 GB | at sign-up | refused | S3 | — | only 50,000 requests a month: a nightly copy, never continuous; same provider if pad moves to Oracle |
| **GitHub** (a private repo) | repo ~1–5 GB soft | no | — | git | yes, by branch protection | good for small database snapshots, not 4 GB of blobs; scheduled workflows in a public repo pause after 60 days without commits |
| **Google Drive** | 15 GB | no | — | rclone | — | sign-in tokens expire for unpublished apps; fragile unattended |
| **AWS S3, same account** | — | — | — | S3 | — | dies with the account: not a second copy |

## Making it run by itself

What turns "a backup" into "a backup that is still working in 2030":

1. **An alarm.** Each job, on success, pings a dead man's switch —
   [healthchecks.io](https://healthchecks.io) has a free plan of 20 checks,
   unchanged for years — which emails if a ping is late. A stopped backup, a
   full bucket, a revoked key or a changed free tier all end as an email
   within a day, not a discovery during a disaster.
2. **A restore test, by itself.** Weekly on the server: restore the latest
   copy into a scratch directory, `PRAGMA integrity_check` each database, and
   check that every blob `store.db` names is in the bucket. The alarm only
   hears from it when it passes. A backup never restored is a hope.
3. **Nothing that expires.** Keys that do not rotate on their own; no OAuth
   tokens; no scheduled CI that GitHub pauses for inactivity.
4. **Pinned, boring tools.** Litestream and rclone are single static binaries:
   pinned versions, installed by `deploy.sh`, upgraded only on purpose.
   SQLite files and plain blob files restore with standard tools — no format
   of our own to keep alive.
5. **Bounded size by itself.** Retention in the tools and lifecycle rules in
   the bucket: 30 days of history, then gone, so the free tier is never
   outgrown by accumulation.
6. **The secrets once, by hand.** `accounts.key` and the env files in a
   password manager. They do not change, so they need no job.
7. **One page that says how to restore** — the runbook, in this repository,
   with the commands; and once a year, ten minutes reading the alarm's
   history.

## Recommendation

For a loss of seconds, two providers, nothing paid and nothing to tend:

1. **Litestream → Backblaze B2**, all three databases, retention 30 days, with
   a write-only key and a lifecycle rule that purges hidden files after 30
   days. Point-in-time restore; loses about a second.
2. **Blobs → the same bucket, every minute**, with rclone, copying only — the
   live store's deletions become hidden files, purged after the same 30 days.
3. **A nightly second copy elsewhere**: a consistent snapshot (B above) to
   your NixOS machine over Tailscale, which pulls it — or to Cloudflare R2 if
   a card is acceptable there. Different provider, different failure.
4. **The alarm and the weekly restore test** (healthchecks.io), for both.
5. **The key and the env files** into a password manager, once.
6. **While on AWS**, daily EBS snapshots kept a week as a free extra — dropped
   on leaving.

When pad moves off AWS, the move *is* a restore: start the relay on the new
machine from the B2 copy, point DNS, and the old box can go. The backup is
then tested by the migration itself.

Still to decide: which second copy (NixOS or R2), and the sizes above, which
set how much room the free tiers have.

## If pad moves in February

The design above does not care where the relay runs; these are the free
places it could, as of October 2026.

- **AWS, extended.** If the Free plan is extended, nothing changes but the
  date. If it is upgraded to Paid, billing is on and has no hard cap.
- **Oracle Cloud, Always Free.** ARM, which the relay already builds for:
  now 2 OCPUs and 12 GB (halved in 2026), 200 GB of disk, 10 TB of outbound
  traffic a month — the last is what pad's 19 MB first visits need. The catch
  is reclaiming: a machine under 20% CPU, network and memory for a week can be
  stopped as idle, and pad is mostly idle. Keep the backups off Oracle.
- **Your NixOS machine, behind Cloudflare Tunnel** (free). Free for as long as
  the machine runs; the wisp egress then leaves from your home address, to
  PyPI and the few hosts it allows.
- **Not**: Google's free e2-micro (1 GB of free egress a month — fifty first
  visits), Fly.io (no free tier for new accounts), free web hosts that sleep
  and have no disk.

Whichever it is, the move is `litestream restore` on the new machine, the
blobs copied down, `deploy.sh` pointed at it, and DNS.

## Sources

- Backblaze B2 pricing: <https://www.backblaze.com/cloud-storage/pricing>
- Backblaze key capabilities: <https://www.backblaze.com/docs/cloud-storage-application-key-capabilities>
  and lifecycle rules: <https://www.backblaze.com/docs/cloud-storage-lifecycle-rules>
- Cloudflare R2 pricing: <https://developers.cloudflare.com/r2/pricing/>
- Oracle Always Free resources: <https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm>
- Litestream: <https://litestream.io/guides/s3-compatible/>, <https://litestream.io/reference/vfs/>,
  <https://fly.io/blog/litestream-v050-is-here/>
- healthchecks.io plans: <https://www.capterra.com/p/249957/Healthchecksio/pricing/>

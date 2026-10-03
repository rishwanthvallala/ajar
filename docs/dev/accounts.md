# Accounts and pad links

*Designed 3–4 October 2026. **Not built.** Decisions marked "decided" were made
by the owner; the rest are recommendations, open until the build starts.*

## What it is

Signing in gives you pads you own. Each has a three-word name, a dashboard
entry, and two kinds of link: one to view and one to edit. You decide who
gets which.

Anonymous pads do not change, and neither does the north star: open the site
and you are typing.

| | Anonymous pad | Account pad |
|---|---|---|
| Made by | Anyone, no sign-in | A signed-in user, from the dashboard or the page |
| Name | `rustic-notch-5292`, as now | Three words: `amber-falcon-river` |
| Who edits | Anyone with the link — **decided**: open, not meant to be safe | You choose |
| Who views | Anyone with the link | You choose |
| Lifetime | 90 days unopened, as now | As long as the account |

## Names

Three words from the EFF large wordlist (7,776 curated words): about 39 bits,
against about 22 for today's `adjective-noun-1234` — 24 adjectives, 24 nouns
and 9,000 numbers. Minted server-side, checked
against every name ever issued — tombstones included, since names are never
reused — and immutable once minted.

**A name is an address, not a secret.** 39 bits is enough that nobody stumbles
onto a pad, and not enough to keep a pad private against someone guessing at
scale. Privacy comes from codes, below, and the interface says which a link
is.

## Who can do what

**Decided:** each account pad has two settings, set from the dashboard or the
page's share dialog.

| Who can view | Who can edit |
|---|---|
| **Anyone with the link** (default) | **Anyone with an edit link** (default) |
| Only people with a view link | Only you |
| Only you | |

Editing implies viewing, so an edit link always opens the pad. "Only you"
switches every link of that kind off at once, without forgetting them — so
locking a pad and unlocking it later brings the same links back.

The roles, from most to least:

| Role | How you get it | Can |
|---|---|---|
| Owner | Signed in as the owner | Everything, including settings, links and delete |
| Editor | An edit link | Edit, run, add and delete files — live with everyone else |
| Viewer | A view link, or the bare name when viewing is open | Watch live, run, change things locally — see below |
| None | Anything else | Told the pad is private, nothing more |

### Links carry a code after the `#`

```
code.rishwanth.dev/amber-falcon-river                 the bare name
code.rishwanth.dev/amber-falcon-river#Kq3x…           a view or edit link
```

The code is 128 random bits, base64url — 22 characters. The server keeps which
role each code grants; the URL does not say.

**After the `#` because browsers never send it.** It reaches no server log, no
`Referer`, and no link unfurler: Slack and iMessage fetch the URL without it,
so a preview bot only ever gets what the bare name gets.

**The page sends it.** It reads the code from the address bar, then presents
it with every store request (`X-Pad-Code`) and in its relay `hello`. The server
compares SHA-256 hashes — a fast hash is right for a 128-bit random secret.

**The address bar drops it after loading.** People share by copying the
address bar, and an edit link copied that way hands out edit access. The page
keeps the code for that pad in local storage and replaces the URL with the bare
name, so a casual copy gives what the bare name gives. Sharing is explicit
instead: the share dialog has **Copy view link** and **Copy edit link**, and
says what each grants.

**One code per link, many links per pad.** v1 shows one view link and one edit
link, but the data model holds any number, each with a label — "for Priya" — so
revoking one person's access later needs no migration.

### Enforcement is the server's, in two places

The lesson of the read-only fix on 2 October: a rule the client keeps is a
suggestion. Both places a pad can change must check the role.

1. **The store API** (`pad.rs`, behind `/api/pad/{name}`). Reads need viewer
   or better; writes need editor or owner. The owner is recognised by the
   session cookie, everyone else by `X-Pad-Code`.
2. **The relay's peer room** (`ws.rs`, `session.rs`). Today every peer is
   equal, and a browser applies whatever another sends. The `hello` carries the
   code, and the WebSocket upgrade carries the cookie; the relay resolves a role
   and stamps it on the connection. Pad frames are plaintext, so it can read
   the first byte of a doc payload. From a **viewer** it forwards requests for
   state (`DOC_WANT`) and nothing that changes anything: no `DOC_UPDATE`, no
   `moved`. Viewers answer `DOC_NONE` to requests, so a newcomer never takes a
   document from someone who could not have written it.

**Revoking a link or rotating a code** closes every live connection that
joined with it — the relay records which link each connection used.

## Viewers watch live, and can still run

**Decided:** viewers see edits as they happen.

Running is the whole point of a pad, and it is already harmless: code runs in
the viewer's own tab, in its own sandbox. What a viewer must not do is change
the pad. So a viewer gets **local scratch**:

- They can type, run, and make files. Nothing is saved or sent.
- A banner that does not go away: *Viewing — your changes stay in this tab*.
- **Copy-on-write per file.** Touching a file detaches it from live updates —
  *You're editing your own copy of main.py · Discard my changes* — so their
  edits never fight the owner's. Files they have not touched keep updating.
- Files their commands write are marked as local in the tree.
- Leaving with local changes asks: *3 local changes — save them as your own
  copy?*

### Save as my copy

**Decided** as the only way back for v1. The viewer's current files — the pad
plus their local changes — become a new pad: an account pad if they are signed
in, an anonymous open pad if not. They send that link to whoever they like.
Suggestions and edit requests are later — see
[open points](../open-points.md#designed-not-started).

## Signing in

**Decided:** Google and GitHub. No passwords stored, no email sent.

- **Full-page redirects, never popups.** The pad's origin is cross-origin
  isolated, and `Cross-Origin-Opener-Policy: same-origin` severs a popup's
  `window.opener`, so a popup flow cannot report back.
- OAuth with `state` and PKCE. Google through OIDC; GitHub through an OAuth
  app. A user is the pair (provider, provider's user id); the email is stored
  for display only, and two providers are two users until linking is built.
- The session is a `__Host-` cookie: `HttpOnly`, `Secure`, `SameSite=Lax`,
  30 days, stored hashed. State-changing requests also need a custom header,
  which a cross-site form cannot send.
- `Cross-Origin-Embedder-Policy: require-corp` blocks cross-origin images, so
  avatars from Google or GitHub need to be served from our origin, or left out.

## Storage

**Recommended: SQLite on the box, WAL mode, replicated continuously to S3 with
Litestream.**

The constraints decide it: one 1.8 GB instance, an AWS account on credits that
close it when spent, and a relay with no database today. SQLite is a file and a
library — no process, little memory, transactions and indexes for the
dashboard — and Litestream turns it into a backup costing cents. Postgres on the
box costs hundreds of megabytes for nothing at this scale; a managed database
spends the credits or adds a dependency; JSON files per account have neither
transactions nor indexes.

Pad contents stay in the file store. The database holds only metadata:

```sql
users     (id, provider, provider_id, email, name, created)
sessions  (token_hash, user_id, created, expires)
pads      (name, owner_id, view, edit, created, opened, bytes, files)
links     (id, pad, role, code_hash, code_sealed, label, created, revoked)
```

`view` is `link | code | owner`, `edit` is `code | owner`.

**Codes are stored twice.** As a hash, for checking. And sealed with a server
key kept outside the database and its backups, so the dashboard can always copy
a link again. Hash-only would mean the only way to share an edit link a second
time is to mint a new one — revoking the first. The cost is that the database
plus that key is every edit link; the key never goes to S3.

## The dashboard

`code.rishwanth.dev/dashboard`, signed in. One row per pad: name, last opened,
size, the two settings, and copy-view-link and copy-edit-link. From there you
can make a link, revoke one, change a setting, or delete the pad. New pad is the
first button on the page.

## Limits and lifecycle

- **Per account:** 20 pads, 100 MB in all, and 25 MB / 500 files each as now.
  The disk has 15 GB free; these are the numbers to revisit, not a promise.
- **No expiry** while the account exists. Deleting a pad deletes its files and
  retires its name, as anonymous expiry already does.
- **Deleting an account** deletes its pads. A read-only archive is the
  alternative, and costs storage for people who have left.
- **Abuse.** Accounts make it attributable, which means a way to take a pad
  down and to ban an account. Files are still never served as HTML — the rule
  that keeps a pad from becoming a page on this domain.

## What changes in the code

| Where | Change |
|---|---|
| `crates/ajar-relay` | SQLite and its migrations; OAuth routes and sessions; roles in the store API and the peer room; dashboard API |
| `pad/src` | Code handling and URL stripping; the share dialog; the viewer's banner, local scratch and copy-on-write; Save as my copy |
| New page | The dashboard, on the pad's origin |
| `deploy/` | Litestream unit; the server key; OAuth secrets |

## Build order

Each step ships on its own.

1. **Accounts.** SQLite, sign-in, sessions, the dashboard listing your pads,
   New pad with a three-word name. Every account pad starts as view-by-link,
   edit-by-link.
2. **Links and roles.** Codes, the share dialog, URL stripping, enforcement in
   the store API and the relay, revoke and rotate.
3. **Viewers.** Live view, local scratch, copy-on-write, Save as my copy.
4. **Settings.** Private viewing, only-me editing, quotas.

## Still open

- **Private pads could be encrypted.** As designed, "only people with a view
  link" is enforced by the server, which can still read the pad. A view code
  that also encrypts would make the server blind, the way ajar's sessions are —
  and needs edit links to carry the key too, and sealed traffic in the room.
- Whether editors see viewers in the presence count.
- What happens to an anonymous pad its maker wants to keep. Claiming it would
  take edit away from everyone else, so it is a copy into the account, not a
  seizure.

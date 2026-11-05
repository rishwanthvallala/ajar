# Cloudflare in front of the box

Written 5 November 2026. **A proposal, except the one part already built:**
Caddy counts every visitor by `{client_ip}`, and takes it from Cloudflare's
`CF-Connecting-IP` only from loopback, which is ready for Cloudflare Tunnel
and changes nothing until a tunnel exists (below, "Built").

It answers three things together:
- what the bandwidth will cost once AWS's credits end;
- the scaling review's item 6 ([scaling.md](scaling.md), a CDN for the
  static files);
- part of where the backups go ([durability.md](durability.md)).

Cloudflare's limits and prices here are as remembered on that date, not
re-read from its pages; check each against Cloudflare's documentation before
relying on it.

## In short

1. **Phase 1, Cloudflare Tunnel.** Cloudflare's network faces the internet and
   the box faces only Cloudflare. DNS for `rishwanth.dev` moves to Cloudflare,
   `cloudflared` on the box dials out to it, and the security group closes
   80 and 443, as it closed 22 in September. Cloudflare's edge keeps the
   files that never change (`/assets`, `/vendor`, `/packages`), and serves
   them without charging for the bandwidth. Everything else runs on the box
   as it does now. A day or two of work, most of it in Cloudflare's
   dashboard, and reversible.
2. **Phase 2, backups to R2.** Litestream and the blobs, as
   [durability.md](durability.md) designs them, to Cloudflare R2: 10 GB
   free, no charge to read it back, and the 4 GiB store fits. Independent of
   phase 1. Hours.
3. **Phase 3, the relay on Workers and Durable Objects.** Possible, a
   rewrite, and not proposed now. Decide at the end of AWS's free plan, 25
   February 2027, beside the other ways off it in durability.md.

## What it would save

On 2 November (operations.md, "The AWS account"):
- **The box itself:** a t4g.small, $0.0112 an hour; a 20 GB disk at $0.0912
  a GB-month; and a public IPv4 at $0.005 an hour. About $14 a month, paid
  from credits ($87.01 left) until 25 February.
- **Bandwidth out:** $0.1093 a GB past 100 GB a month.

Bandwidth out is the cost that grows with use. A first visit fetches about
19 MB, and 36 MB if the visitor types ([scaling.md](scaling.md), item 6):
1,000 new typists are about $4. That is nothing at today's numbers, and
unbounded at a better day's.

Behind Cloudflare, what its edge serves from its cache costs nothing to
send, and the box sends each file once per edge location. Not removed:
- **The box**, which phase 1 keeps.
- **Its IPv4.** It still has to reach out: SSM, PyPI for the sandbox,
  Google, GitHub, Razorpay. Without the address it would need a NAT gateway,
  which costs more.
- **What is not cacheable:** pads, sockets, the API. They are small next to
  the runtime.

## Why a tunnel, and not Cloudflare's proxy alone

The plain way is to turn on Cloudflare's proxy for the three hostnames (the
"orange cloud") and leave the box listening. Three things are wrong with it.

- **Visitors' addresses.** Every request arrives from one of Cloudflare's
  addresses. Caddy's rate limits, the relay's quotas (the daily growth per
  address, joins) and wisp's eight tunnels per address all count by address,
  so behind the proxy everyone would be one visitor, refused together. The
  fix is to believe Cloudflare's `CF-Connecting-IP` from Cloudflare's
  published ranges.
  **WARP**, Cloudflare's free VPN, leaves from those same ranges. Anyone using
  it could connect to the box directly, send any `CF-Connecting-IP` they like,
  and be a new address on every request. Every per-address limit would then
  be a formality.
- **The box stays reachable** at 13.207.222.42. Locking 80 and 443 to
  Cloudflare's ranges has the same WARP hole. Cloudflare's Authenticated
  Origin Pulls closes it, with a client certificate per site in Caddy — more
  configuration, to guard a door the tunnel does not have.
- **Cloudflare's ranges change**, and a list in a security group or a
  Caddyfile goes stale without saying so.

With a tunnel, `cloudflared` on the box connects out to Cloudflare and
carries requests back in. Nothing on the internet can reach Caddy: the
security group allows nothing in, as for SSH since 14 September. Requests
reach Caddy from loopback, and `CF-Connecting-IP` — set by Cloudflare's edge
over anything the visitor sent — is the visitor. Trusting it from loopback
only is what is built.

## What has to hold behind it

What the pad and ajar need, and what Cloudflare does in its path:

- **The headers pass through untouched**: COOP, COEP, CORP, the CSP with the
  import map's hash, `Service-Worker-Allowed`. Cloudflare does not add to
  them unless a feature that edits pages is on (below).
- **WebSockets**: on by default, on every plan. Cloudflare closes one idle for
  100 seconds.
  - Every socket the relay serves — agents, ajar's guests, pad pages — is
    pinged every 20 seconds since 7 October (`PING_EVERY` in `ws.rs`), so
    none is idle. The warning against Cloudflare in operations.md, from 14
    September, predates the pings.
  - **wisp's tunnel is not pinged** (`deploy/wisp-server.mjs` hands the
    socket to wisp-js). A sandbox that installed something and then sat for
    two minutes may find it closed. **Check at cutover**: install, wait three
    minutes, install again.
  - Cloudflare also restarts its edge servers now and then, which drops
    sockets. Pages and the agent reconnect, as after a relay restart.
- **Request bodies**: up to 100 MB on the free plan. The relay takes at most
  33 MiB in one request (`MAX_PAD_HTTP_BODY`); a pad's write sends only what
  changed.
- **Cached files**: up to 512 MB each on the free plan. The largest package
  is 273 MB.
  - Cloudflare caches by file extension by default, and `.webc` is not one,
    so a Cache Rule is needed (step 4).
  - Caddy serves the packages precompressed, zstd or gzip, by the
    `Accept-Encoding` it is asked with. **Measure at cutover** which one
    reaches a browser through Cloudflare: if its edge asks for gzip only, a
    cold visit grows by the difference — 45 MB against 65 MB for the
    largest package.
- **`/cdn-cgi/`** is Cloudflare's on every proxied site. Reserved as a pad
  name on 5 November (`RESERVED` in `pad.rs`); none existed.
- **Sign-in and payments keep their addresses.**
  - Google's and GitHub's redirect URIs and Razorpay's callback and webhook
    are the same hostnames.
  - The Razorpay webhook is a server calling, not a browser, and Cloudflare's
    bot features would challenge it.
  - So would anything without a browser's manners, like the ajar agent and
    `install.sh`.
- **Logs**: Caddy's access logs gain the visitor as `client_ip`; `remote_ip`
  becomes 127.0.0.1.

## The cutover

The maintainer's accounts throughout: Cloudflare's, the registrar's, NS1's
and the AWS security group. An agent can prepare files, and cannot make any
of these changes.

1. **Cloudflare, free plan**: add the zone `rishwanth.dev`.
   - Compare the records it imports against an export from NS1, every one:
     MX and the mail's TXT (SPF, DKIM) if the domain has mail, Google's site
     verification TXT (the OAuth consent screen depends on it), the apex and
     any other subdomains.
   - Set every record **DNS only** (grey) to begin with, so moving the
     nameservers changes nothing but who answers.
2. **The registrar**: turn DNSSEC off if it is on (the old keys would make
   the new answers look forged), then set Cloudflare's two nameservers. Wait
   until Cloudflare says the zone is active. Lowering NS1's TTLs a day ahead
   makes this quicker.
3. **Settings that must be off.** Each edits pages or turns away programs:
   - Email Obfuscation: it rewrites the `mailto:` on `/privacy` and `/terms`
     and adds a script the CSP refuses.
   - Rocket Loader.
   - Web Analytics' automatic injection.
   - Bot Fight Mode: it challenges the Razorpay webhook, the agent and
     `install.sh`.

   Settings that should be on:
   - SSL/TLS **Full (strict)**.
   - **Always Use HTTPS**.
   - A minimum TLS of 1.2.
   - WebSockets, which are on by default.
4. **A Cache Rule** for `code.rishwanth.dev` with the path starting
   `/assets/`, `/vendor/` or `/packages/`: eligible for cache, edge TTL
   *use the origin's Cache-Control*. Caddy already marks those immutable for
   a year, except `/packages/*.json` (`no-cache`). Nothing else is cached:
   pages are `no-cache` and the API answers `no-store` or nothing.
5. **The tunnel**: *Zero Trust → Networks → Tunnels → Create*, `cloudflared`,
   free. Install `cloudflared` on the box with the tunnel's token as a
   systemd service. Then add a *public hostname* for each site:
   - `code.rishwanth.dev`, `ajar.rishwanth.dev` and
     `preview.rishwanth.dev`, each to the service
     `https://localhost:443`;
   - with *Origin Server Name* set to that same hostname, so Caddy answers
     with that site's certificate and `cloudflared` checks it.

   Cloudflare replaces the three DNS records with proxied CNAMEs to the
   tunnel. This is the moment traffic moves; until now nothing had.
6. **Check through Cloudflare**, before closing anything:
   - `healthz?deep=1`, and `app-check` once, against production;
   - signing in, a pad shared between two browsers, `/pricing`;
   - an agent session, a pip install, then three idle minutes and another;
   - in Caddy's log, your own address as `client_ip`;
   - which encoding the largest package arrives in.
7. **Close the box**: remove the security group's rules for 80 and 443.
8. **Certificates, within 60 days of step 7.** Caddy renews by answering
   Let's Encrypt on 80 or 443, which it can no longer be reached on. Move it
   to the DNS challenge, through Cloudflare's API:
   - `github.com/caddy-dns/cloudflare` in `deploy/caddy/go.mod`, beside the
     rate-limit plugin;
   - a Cloudflare token allowed only to edit `rishwanth.dev`'s DNS, in
     Caddy's environment on the box;
   - `acme_dns cloudflare {env.CF_API_TOKEN}` in the global options.

   Caddy then keeps real certificates, so going back stays a DNS change.
   The other way, Cloudflare's Origin CA certificates (fifteen years, trusted
   only by Cloudflare), never renews and cannot be gone back from without new
   ones.

**Going back**, at any point:
- reopen 80 and 443;
- in Cloudflare, point the three records back at 13.207.222.42 as DNS-only
  A records;
- stop `cloudflared`.

Caddy's `{client_ip}` is then the connection's own address again, with no
change to the Caddyfile.

## Phase 2: backups to R2

[durability.md](durability.md) is the design: Litestream for the three
databases, the blobs copied every minute, an alarm when either stops, and a
weekly restore test. It chose Backblaze B2 first and R2 or the NixOS machine
second. With Cloudflare already holding the domain, R2 is the natural first:
- 10 GB of storage free;
- no charge to read it back, so a restore or a restore test costs nothing;
- S3's API, which Litestream speaks.

R2 asks for a card on file, even inside the free tier.

## Phase 3: all of it on Cloudflare

What each part would become, so the February decision can be made with it
in view:

| Today | On Cloudflare | What it takes |
|---|---|---|
| The pad page, ajar's client, the preview origin | Workers static assets, and R2 for files over its 25 MiB a file (the packages) | Little; the headers move into a `_headers` file or a Worker |
| A pad's room and its store (SQLite and blobs) | A Durable Object per pad, holding its room's sockets and its rows (SQLite in the object); the blobs in R2 | The store's logic carried over, its I/O rewritten. It also ends the one lock every pad shares (scaling.md) |
| ajar's sessions | A Durable Object per session | The routing and backpressure (`outbox.rs`) rewritten for objects that sleep |
| Accounts, sign-in, billing | D1, Cloudflare's SQLite, and a Worker | Rewritten; D1 keeps 30 days of point-in-time recovery |
| wisp, the sandbox's way to PyPI | A Worker with outbound TCP (`connect()`) | A wisp server for Workers; or nothing, if pip could fetch through the browser as `curl` already does, since PyPI answers CORS |

It would mean:
- **no server to look after**, the data kept by Cloudflare with
  point-in-time recovery, and probably $0–5 a month (Workers Paid, if the
  free plan's daily requests run out);
- **about 15,000 lines of Rust** on a runtime that has none of tokio, axum
  or rusqlite — weeks, not days;
- **limits the relay does not have today**: 128 MB of memory per object, a
  CPU-time allowance per request, and message and body size limits to be
  measured against the protocol;
- **lock-in**: Cloudflare would be the only place it runs.

Phase 1 does not stand in its way: the hostnames, DNS and cache it sets up
are what phase 3 would use too.

## Built, 5 November

- **`deploy/Caddyfile`**:
  - Global `servers` options: `trusted_proxies static 127.0.0.1/32 ::1/128`
    and `client_ip_headers CF-Connecting-IP`.
  - Every rate-limit key and every `X-Forwarded-For` to the relay and wisp is
    `{client_ip}`, where it was `{remote_host}`.

  Until a tunnel runs, nothing outside the box reaches Caddy over loopback,
  so `{client_ip}` is what `{remote_host}` was, and nothing behaves
  differently.
- **`deploy/caddy/check.sh`**, against the real Caddy:
  - Through "the tunnel" (127.0.0.1 with the header), a visitor has a budget
    of their own, spends it, and does not share it with another visitor.
  - An IPv6 visitor is counted by their /64, as one connecting directly is.
  - From any other address the header is ignored: twenty claimed addresses
    buy no lookup.
  - Proved by two mutations: the keys put back on `{remote_host}` fail three
    of the checks; trusting all of 127.0.0.0/8 fails the last.
- **`cdn-cgi`** reserved as a pad name.

## To decide

1. Phase 1 at all, and when. It needs a Cloudflare account and the domain's
   DNS moved to it.
2. The certificate route after the ports close: the DNS challenge
   (recommended) or Origin CA.
3. Phase 2's destination: R2 first, or B2 first as durability.md had it.
4. Phase 3, at the February decision.

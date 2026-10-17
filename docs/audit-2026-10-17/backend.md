# Pad backend, security, and operations audit — 17 October 2026

This is an audit of the checked-out source and deployment configuration, with controlled local backend probes where noted. It is not proof that the live server runs precisely these bytes. No production data was changed and no load, corruption, slow-request, or authorization attack was run against production. The two existing September review documents were not edited.

## Assessment

The backend has substantial thoughtful engineering: an explicit role model, random bearer links, hashed sessions, PKCE, a separate preview origin, bounded normal read/write paths, transactional file manifests, content-addressed blobs, stale-edit detection, bounded WebSocket outboxes, and a sizeable regression suite. It is nevertheless not ready for a claim of zero errors, complete isolation, or assured durability. Several newer paths bypass older safeguards, and the distinction between "permission lookup failed" and "anonymous public pad" is currently unsafe.

Backend ratings, before any fixes: authorization/security **5/10**, resilience under hostile/failed clients **4/10**, persistence/recovery **3/10**, deployment/operations **4/10**, implementation/test discipline **7/10**. The plausible target after addressing the findings and proving recovery is **8–9/10**; a numeric maximum would still not establish universal correctness.

## Findings

### B01 — High: account-database lookup failures grant anonymous editor access

`crates/ajar-relay/src/accounts.rs:943–956` converts every SQL error from the pad ownership query to `None` using `.optional().ok().flatten()`, then returns `Access::anonymous()`. That role is `Editor`, with no owner, and it is used by the pad HTTP read/write endpoints and WebSocket joins. An I/O, corrupt-database, schema, or decoding failure can therefore turn a private pad into a publicly readable and writable pad. This is a fail-open authorization defect; it does not require an attacker to possess an edit link once the server is in the failed state.

The local probe deliberately renames only its disposable account table to induce the SQL error. This is fault injection, not evidence that the production database is currently corrupt. Remediation: represent storage failure separately from missing row, return a service error and deny access; retain observable error context. Audit `owned_names`, `room_for`, and `record_size` for similarly silent failures.

### B02 — High: cookie-authenticated WebSockets accept arbitrary Origin

`main.rs:1205–1239` derives the owner from the request cookie and upgrades without validating the `Origin` header. `ws.rs:188–218` grants owner privileges from that identity. This matters particularly because `preview.rishwanth.dev` and `code.rishwanth.dev` are sibling origins on the same site. The preview iframe allows scripts and same-origin (`pad/src/preview.ts:427`), and generated preview HTML gets `frame-ancestors` but no outbound-connect restriction (`pad/preview/sw.js:257`). SameSite=Lax is not a same-origin boundary.

A script running in an untrusted preview can therefore attempt a credentialed WebSocket to the pad origin. A known pad name and the victim's valid owner session can grant access to its live room. The demonstrated backend behavior is acceptance and forwarding with a foreign Origin plus a test owner cookie. That is not, by itself, proof of a complete browser exploit against a deployed account. The browser cookie-delivery step and exact live headers should be verified independently. The impact is live document confidentiality/integrity; this does not automatically imply direct access to the dashboard or all stored private files.

Remediation: validate the browser WebSocket origin against the configured Pad origin before using cookie authentication; preserve explicitly required non-browser/agent flows separately. Test an untrusted preview against an owned room in a real browser.

### B03 — High: historical-version reads bypass the memory/concurrency protections

Normal pad reads claim a per-address read slot and a global semaphore, and stream file blobs. The version endpoint (`main.rs:698–722`) does neither. `Store::version` (`pad.rs:1198–1231`) reconstructs every file as an in-memory String, and the handler then constructs a `serde_json::Value` and serializes the full response. A saved version may be up to 100 MiB. Several concurrent history reads can consume the relay's 512 MiB service budget and terminate the process, disrupting both Pad and ajar sessions.

This is a separate code path from the normal read-memory regressions covered by the existing abuse suite. Fix by sharing the streamed response implementation and retaining the same read permits until response completion. Test history reads under the deployed cgroup memory ceiling, including slow clients, binary encodings, and JSON escaping. The audit probes use only four 8 MiB reads locally, not production stress.

### B04 — High: two unfinished request bodies can block every save

`main.rs:1000–1016` acquires one of only two global write permits before reading the body; `write_pad` holds that permit while the `Json` extractor waits. There is no body-read deadline, minimum receive rate, or per-address write cap. The deployment config does not set a client-body deadline either. Two clients that send valid headers and only part of the body can retain both permits, while every user's save waits behind them. The stalled-peer TCP option is about unacknowledged outbound data and does not solve a client that simply withholds the rest of an upload.

The bounded local probe opens two incomplete uploads, demonstrates an unrelated small save remains pending, then releases both sockets and demonstrates the save completes. It does not leave sockets running or attempt this on production. Remediation: timed body reads, a bounded wait for a permit, per-address admission, and appropriate reverse-proxy timeouts; preserve normal slow-network uploads.

### B05 — Medium: view/edit bearer codes are copied into access logs

The browser transmits link secrets in `X-Pad-Code`; `http_accounts.rs:96–104` reads that header. The code origin's Caddy log is unfiltered JSON (`deploy/Caddyfile:305–311`). Caddy's default sensitive-header redaction covers Cookie, Set-Cookie, Authorization, and Proxy-Authorization, not this custom header. Consequently the checked-in logging configuration records these bearer codes in plaintext whenever the API is used with a coded link, despite the design's emphasis on storing codes hashed and sealed and keeping URL fragments out of logs.

This is a configuration finding, not a claim that logs are publicly accessible or that production log records were inspected. Redact/delete the header in logging, review existing retention/access, and decide whether existing links require rotation. Caddy's documented defaults: [access logging](https://caddyserver.com/docs/caddyfile/directives/log).

### B06 — Medium: cached owner permissions survive expiry and a delayed join can bypass logout eviction

`Accounts::session` checks expiry (`accounts.rs:457–475`), but only the WebSocket upgrade calls it. The socket subsequently relies on its cached owner status and registry membership (`ws.rs:191–217`, `ws.rs:320–334`, `ws.rs:410–435`). No expiry timestamp is carried in `Gate`, and no recurring revalidation is present. Explicit logout evicts registered owner connections; passive expiry does not. A client keeping its socket alive may continue receiving and sending private live document traffic after the same cookie is rejected by the HTTP API.

The local probe expired the temporary session row after owner sockets joined: HTTP returned 403 while document frames continued to forward. A second probe upgraded a socket while the cookie was valid, called logout before sending Hello, and then joined the room with the cached owner grant. HTTP again returned 403, but the delayed socket joined and forwarded a document frame. Logout evicts registered connections, so a socket not yet registered escapes that eviction. Revalidate the session at room admission and use server-side expiry/revocation for the whole socket lifetime; test both passive expiry and logout between upgrade and Hello.

### B07 — Medium: saves are acknowledged without crash-durable blob/manifest ordering

`pad.rs:683` sets SQLite WAL synchronous=NORMAL. Blob writes flush userspace buffers but do not call `sync_data`/`sync_all` (`pad.rs:598–604`); renamed blob files/directories are also not synced before the database commit (`pad.rs:1804–1830`, `pad.rs:1728`). The code therefore provides clean-process persistence but not a demonstrated power-loss-safe commit protocol. A host/OS crash can lose acknowledged transactions, and independent blob/directory persistence can leave database references whose file was not durably installed.

No real host crash or power-failure injection was performed. SQLite explicitly distinguishes NORMAL WAL durability from FULL: [synchronous pragma](https://www.sqlite.org/pragma.html#pragma_synchronous). Establish a documented durability promise, fsync ordering and recovery verification consistent with it, and test fault injection around blob placement/transaction commit/old-blob collection. Do not equate a process restart unit test with a power-loss test.

### B08 — High operational gap: no verified backup or restore path for user data

The current operations documentation states that the stored data and account database are not backed up (`docs/dev/operations.md:307`, `:317`), and `docs/dev/durability.md` dated 17 October confirms the same gap. The accounts design still lists Litestream as not built. The deployment service keeps the only documented copy on the instance. Version history lives in the same store and on the same disk; it is not a disaster-recovery backup.

This is documented project state; no cloud control plane, actual production backup inventory, or restore execution was inspected. If off-repository backups now exist, replace this finding with their measured recovery evidence. Before relying on Pad for durable work, implement and rehearse a consistent recovery of both databases and blobs, with a separately handled link-sealing key, and define RPO/RTO. Monitor failed backups and prove a restore to an isolated instance.

### B09 — Medium: the global storage ceiling excludes database-resident content/metadata

The store's accounting sums referenced blob sizes (`pad.rs:786–800`), while saved run output is stored directly in `last_runs` (`pad.rs:1406–1439`). `set_last_run` neither checks nor charges the global store ceiling. Empty `writes: []` also creates a pad row while its blob growth is zero (`pad.rs:1718–1728`), and HTTP creation has no pad-count/rate admission. Database rows, names/paths, last-run output, and database/WAL overhead can grow beyond the supposedly global storage cap.

The small local probe sets a 1 KiB store ceiling, creates a zero-file anonymous pad, and writes 32 KiB of saved output successfully. That proves the accounting mismatch, not disk exhaustion. The per-address daily output allowance remains a partial bound, but metadata-only pad creation is not charged and the global ceiling cannot serve as a disk-full backstop. Include database-resident bytes/counts and physical disk reserve in capacity protection.

### B10 — Medium: arbitrary write-operation count reaches quadratic work

`pad.rs:1597–1599` scans the suffix of the request for every write to decide whether the path appears later. There is no request operation-count bound. The 500-file limit is checked only on the final stored result (`pad.rs:1681`), so a request with thousands of unique deletions of nonexistent files remains valid and produces quadratic comparisons while holding a scarce global write permit. The 33 MiB body ceiling permits far more operations than an ordinary 500-file pad needs.

The local probes exercise only 2,000/4,000/8,000 deletions, measure scaling, and store no file content. Fix with a linear reverse scan/set or map, and an explicit sensible operation-count limit; cover maliciously large deletion batches and duplicate paths.

### B11 — Low/medium: an expired anonymous pad's history remains readable until sweep

`Store::history`, `Store::version`, and `Store::keep_now` (`pad.rs:1179`, `:1198`, `:1236`) check syntax but not the pad's lease. Ordinary reads correctly return a free/nonexistent pad once its lease expires, while history routes can still enumerate and return its old files until the hourly sweep removes the rows. This contradicts the documented rule that lapsed pads are never served while waiting for sweep, and gives inconsistent expiry behavior across UI/API paths.

The local probe ages its temporary pad's `touched_ms` directly after creating a version, then compares ordinary read with history/version results. Fix by sharing an authoritative lifecycle check across all content reads and keep-version operations.

### B12 — Medium operational gap: release swap/health checks do not prove the Pad is usable

`deploy/deploy.sh:298–300` rsyncs directly into the live asset directories with deletion, so a deployment can expose an inconsistent set of old/new HTML, scripts, assets, and packages while files are changing. The final check (`:349–360`) checks only the ajar relay's `/healthz` status; the handler (`main.rs:419`) returns a constant and does not verify databases, Pad assets, OAuth routing, preview, or runtime packages. The script records the deployed commit before those checks and has no automatic rollback in this flow.

These are source-confirmed deployment failure windows, not observed current production downtime. Use release directories and an atomic activation strategy, retain assets needed by already-open clients, smoke-test the actual Pad/preview/runtime paths after activation, distinguish readiness from liveness, and rehearse rollback.

## Other source risks worth targeted follow-up

- **Write/permission races:** write authorization is resolved before awaiting the account write mutex (`main.rs:1030–1058`). Deleting one pad does not take that mutex (`http_accounts.rs:491–508`); deleting an account takes it, but a queued write does not re-check access after acquiring it. A previously authorized in-flight write can therefore land after deletion or permission change and recreate hidden store content. This is a source-derived interleaving; a deterministic race reproduction is still needed.
- **Anonymous-name claim race:** account name creation checks the separate pad store and then creates an ownership row. An already-authorized anonymous write can stage/commit after that check; there is no shared atomic ownership reservation across the two databases.
- **Cross-database quota consistency:** pad content is committed and then account `bytes/files` metadata is updated. `record_size` ignores SQL errors (`accounts.rs:806–811`). Crash/error between those steps can leave quota/dashboard data stale, with no startup reconciliation shown.
- **Handshake input size:** WebSocket `Hello.session` is not checked against Pad name syntax/length before being retained as a session map key; the general 32 MiB message cap is much larger than reasonable handshake data. The unbounded admitted-list/string deserialization also precedes quota admission. Validate small handshake-specific bounds separately from large document frames.
- **Per-address maps / IPv6:** the core quota uses exact `IpAddr` values and has no global socket/memory reservation; the Caddy DNS/WISP zones deliberately group IPv6 /64s, but the relay does not. The per-socket cap is not a global memory guarantee.
- **No operator moderation/recovery tooling:** the project explicitly lists account linking, backup, and abuse takedown tooling as unfinished. These are product/operations gaps rather than unexpected implementation failures.

## What is already good

- Random 128-bit share codes are hashed for authorization and AES-GCM sealed for re-display; account session tokens are 256-bit and hashed.
- Production cookies are host-only, Secure, HttpOnly, SameSite=Lax; OAuth uses state and PKCE, bounded provider calls, and constrained return paths.
- Viewer document mutation frames are rejected server-side, and sender IDs are checked; client-only read-only controls are not the sole boundary.
- Permission updates, link revocation/reset, deletion, and explicit sign-out trigger eviction of registered rooms; B06 documents the gap before room registration.
- Path traversal and file/directory conflicts are rejected before commit; edits are based on stored hashes and return conflicts on stale versions.
- Normal pad reads stream immutable blobs with read-lifetime pinning and per-address/global admission; normal writes have a body cap and pre-body concurrency permits.
- The service binds loopback, runs unprivileged with systemd hardening and resource ceilings; Caddy replaces the client address forwarded to the relay.
- WISP is explicitly restricted to a small package host allowlist, TLS port, no raw/private/loopback IPs, no UDP, and bounded tunnels/streams.
- Existing test and CI structure is unusually broad for this product size. Passing these tests would still not cover the new failure paths identified above.

## Verification ledger

`cargo test -p ajar-relay --offline` against the current checkout completed in WSL: **153 passed, 0 failed, 0 ignored**, with test execution taking 15.58 seconds. Full output: `backend-unit-tests.txt`. Compilation required fetching missing dependencies and two bounded attempts on the slow mounted Windows filesystem; the executable present at the start of the audit was from September and was not used as current-code evidence.

The current-source relay was also built successfully. Bounded local probes produced these results in `backend-probe-results.jsonl`:

| Finding | Observed local result |
|---|---|
| B01: permission-store SQL fault | Anonymous read returned 200, role editor and the synthetic private text; anonymous write returned 200. |
| B02: foreign Origin | Without a cookie HTTP returned 403; a sibling-Origin WebSocket with a synthetic owner cookie received welcome and forwarded a document frame. |
| B03: history memory | Four concurrent 8 MiB version reads all returned 200; relay RSS rose from 16.0 MiB to 86.1 MiB, a 70.1 MiB increase. This is a small local sample, not a measured production crash. |
| B04: unfinished bodies | Two incomplete bodies held an unrelated save pending for 2,307 ms; releasing them allowed HTTP 200. |
| B06: cached permissions | Both passive expiry and logout-before-Hello produced HTTP 403 alongside continued/new live document forwarding. |
| B09: accounting | With a 1 KiB blob ceiling, an empty pad was created and 32 KiB of last-run output accepted with 204. |
| B10: operation scaling | 2,000 / 4,000 / 8,000 nonexistent deletions all returned 200, taking 93 / 512 / 1,528 ms respectively. The source establishes quadratic work; timings are environment-sensitive. |
| B11: history expiry | Ordinary read reported exists=false while history and a retained version both returned 200. |

These are 11 output records across nine scenarios (the scaling scenario emits three records). The harness then attempted an additional missing-account-database restart experiment; the local relay did not become ready, so that experiment is **inconclusive** and the overall harness exited 1. No finding claims that the extra experiment succeeded. Its error is preserved in `backend-probe-stderr.txt`; the preceding observations remain valid.

Reproduction source: `backend-probes.mjs`; SQLite fault-injection helper: `db-tool.rs`. The probes operated only on a newly created temporary directory and localhost port 18897, and their finally block stopped their relay/sockets and removed their temporary data. No production database or permission state was altered.

Not exercised in this backend sub-audit: production accounts/authenticated owner workflows, real OAuth provider failures, production server journals/metrics, cloud backup configuration, actual host crash/recovery, real multi-user load, billing/egress limits, or a browser exploit with a real user's cookie. These must remain explicit gaps rather than be counted as passed.

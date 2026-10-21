# End-to-end code review — updated 28 September 2026

Reviewed commit: `1a3bdbfe3d28fee66b33614c229f5f1e1ef0fa5a`. The working tree was clean before review.

This is the current actionable review. Resolved September 16 comments have been removed; their implementation history remains in [the fix ledger](code-review-fixes-2026-09-16.md), and the original report is in Git history. IDs are not reused: F23 was already assigned in the ledger. F22 remains open for the narrower persistence failure below.

**21 open findings: 13 new (F24–F36), one partially resolved original finding (F22), and seven previously documented issues rechecked from `open-points.md` (K01–K07).** The K entries are not new discoveries. Deliberate product limits are excluded.

## Scope and evidence

The review followed hosted startup → sandbox/PTY → relay → encrypted browser → collaborative editing → disk, and Pad load → peer documents → editor/runtime → HTTP persistence. It also examined reconnect/shutdown, snapshots, store quotas, shared workspace UI, build/CI, Docker, deployment, caching, service-worker vendoring and WISP configuration. Python command shims were inspected selectively; their full command/option matrix was not executed.

**Reproduced** means checked-in TypeScript classes or an extracted unchanged source block were executed with controlled HTTP, filesystem, timer or UI doubles. This is not a Rust/WASIX end-to-end reproduction. **Source** identifies a concrete path with a proposed regression that was not run. **Check failure** is an observed repository command failure. Locations refer to the commit above.

P1 marks a security/control boundary or substantial data-loss defect. P2 marks a functional, reliability or verification defect. Passing builds and UI checks do not establish the persistence/security properties below.

| Area | Review result |
|---|---|
| Protocol/encryption | Directional authenticated headers agree across Rust/browser/Node; reflection regression passes. No new cryptographic finding asserted. |
| Agent/sandbox/PTY/workspace | Original policy and Cargo-home fixes are present. Open issues concern read-only enforcement, persistence/reconciliation, ignore rules and host controls. Kernel confinement was not exercised. |
| Relay/store | Reviewed role filtering, membership, queues, registration, expiry, locking and HTTP quotas. Cleanup races, admission gaps and snapshot delivery remain. |
| Hosted browser | Reviewed encryption, reconnect, document binding, terminal handling and offline viewing. Offline replay can corrupt concurrently changed text. |
| Pad | Reviewed editor/CRDT/runtime/store ownership, routing, autosave, commands and lifecycle. Multiple data-loss paths reproduced. |
| Shared UI | Typechecking and real-browser layout/boot checks pass. |
| Delivery | Both production clients build on Windows. Original Docker COPY/state-directory fixes are present. Mutable vendor URLs conflict with immutable caching. |
| Tests | Focused review suite fails on a stale double and is absent from the main gate. Native/runtime suites remain unverified here. |

## Findings index

| ID | Priority | Finding | Evidence |
|---|---|---|---|
| F22 | P1 | Failed final document write loses retry state | Source; original fix incomplete |
| F24 | P1 | Local save advances past remote revisions never applied | Reproduced |
| F25 | P1 | Concurrent refreshes replace newer runtime state with an older snapshot | Reproduced |
| F26 | P1 | Inactive Pad models/documents diverge and overwrite saved edits | Reproduced |
| F27 | P1 | Hosted reconnect applies offline edits at obsolete offsets | Reproduced source block |
| F28 | P2 | Valid filenames collide on a document stream | Reproduced |
| F29 | P1 | Watcher resync skips open-document reconciliation | Source |
| F30 | P2 | Run treats filenames as shell expressions | Source |
| F31 | P2 | New empty Pad files are not scheduled for saving | Reproduced |
| F32 | P2 | Closed browser connections still run scheduled reconnects | Reproduced |
| F33 | P2 | Registry cleanup can remove a newly active session | Source |
| F34 | P2 | Concurrent writes exceed the configured global store ceiling | Source |
| F35 | P2 | Review suite fails before six of its eight regressions | Check failure |
| F36 | P2 | Unversioned runtime assets are immutable for a year — the lists and the SDK fixed 12 and 21 October; wisp open | Source |
| K01 | P1 | Read-only mode accepts document writes | Source; previously recorded |
| K02 | P2 | Awareness IDs can inject stylesheet rules | Source; previously recorded |
| K03 | P2 | Valid large snapshots can overflow the recipient outbox | Source; previously recorded |
| K04 | P1 | Pre-hello sockets have no quota or deadline | Source; previously recorded |
| K05 | P2 | Watcher/scanner ignore rules disagree | Source; previously recorded |
| K06 | P2 | Panel cannot kick multi-digit guest IDs | Source; previously recorded |
| K07 | P2 | Checkpoint omits untracked work and misattributes changes | Source; previously recorded |

## Persistence and collaboration

### F22 — Retain closing documents until the final write succeeds

**Locations:** [docs.rs](../crates/ajar/src/docs.rs), lines 151–159; [main.rs](../crates/ajar/src/main.rs), lines 734–739 and 1147–1155.

The timer now acknowledges writes only after success, resolving the original timer defect. But `Docs::close` removes the document and path index before attempting final persistence. Both explicit close and `forget` ignore `write_back` failure. If the last guest switches files or disconnects during a filesystem error, the only unsaved contents are discarded; neither the next timer tick nor shutdown can retry them.

**Fix:** retain pending content independently of reader membership until persistence succeeds or recovery is explicitly handled. The ledger's blanket Fixed status needs narrowing.

**Regression:** inject one write failure, close the last reader, restore filesystem writes, and require the exact pending text to reach disk without reopening the document.

### F24 — Separate write acknowledgements from applied snapshot revisions

**Locations:** [app.ts](../pad/src/app.ts), lines 221, 563–566 and 913–915.

`saveEdits`/`publish` advance `storeSeq` to the new global server revision while applying only this tab's changes. `refresh` then ignores a GET at that revision. Example: A knows revision 1; B adds `b.txt` at 2; A saves `a.txt` and receives 3 before applying B's nudge. A's GET contains both files at 3 but is discarded. B's file remains absent until a later revision or reload. With an existing file, A's stale runtime can later overwrite B's saved edit.

**Evidence:** actual `saveEdits` → `refresh` left remote `b.txt` absent despite a successful GET containing it.

**Fix/regression:** track the last fully applied folder revision separately from local acknowledgements and reconcile overlapping changes. Test another tab's addition, edit and deletion between A's GET and PUT, including changes deferred during Run.

### F25 — Serialize snapshot application with runtime/store mutations

**Location:** [app.ts](../pad/src/app.ts), lines 210–247.

Peer events can enter `refresh` concurrently. Its revision check precedes asynchronous runtime startup/writes, and it does not use `writeChain`. An older refresh can pass, pause, let a newer refresh finish, then replace its runtime files, `known` and `storeSeq`. The shared `applyingRemote` boolean also stops representing which operation owns model changes.

**Evidence:** delaying revision 2's runtime write until revision 3 finished regressed `storeSeq` from 3 to 2 and runtime contents from `newest` to `older`.

**Fix/regression:** apply each snapshot as one ordered operation alongside writes/publication; revalidate its revision when the operation begins. Reorder GETs and delay runtime writes; applied revision and contents must never move backwards.

### F26 — Synchronize inactive models with retained documents

**Locations:** [app.ts](../pad/src/app.ts), lines 340–355, 435–447, 848–851 and 908–925; [editing.ts](../pad/src/editing.ts), lines 151–160.

Switching files unbinds the old model but retains its document. A remote update changes that document and runtime while the inactive model stays old. Run writes every model into the runtime before publication. Open A, switch to B, receive a remote edit to A, then Run B: A's stale model can overwrite its saved remote edit.

The reverse also fails: shell publication changes an inactive model through `setFile`, but its retained Y.Doc stays old. Returning to the file binds the old document over the new model. Its model listener does not mark that dirty because a document exists.

**Evidence:** actual `App.run` on `b.py` published `old` for `a.txt` after its remote document, runtime and durable snapshot held `new`. A separate publication check left an inactive model at `shell edit` and its document at `old`.

**Fix/regression:** synchronize content independently of the active editor, fold command changes into existing documents, and run authoritative document contents. Cover both directions with two files/tabs.

### F27 — Rebase offline edits against the new host text

**Location:** [main.ts](../web/src/main.ts), lines 738–762.

Reconnect computes a prefix/suffix splice between the old base and offline text, then applies those numeric offsets directly to the new host document. An unrelated insertion/deletion before the edit shifts its intended position. Clamping prevents an exception but does not identify the correct characters.

**Evidence:** executing the unchanged splice block with base `abc`, local `aXc`, and current host `ZZabc` produced `ZXabc`; preserving both independent changes requires `ZZaXc`.

**Fix/regression:** use a three-way merge or a state exchange preserving CRDT history; surface conflicts when safe merging is impossible. Test host insertions/deletions before the offline edit and overlapping edits.

### F28 — Resolve stream collisions before routing document updates

**Locations:** [peers.ts](../pad/src/peers.ts), `streamFor`; [app.ts](../pad/src/app.ts), lines 271–282 and 340–345.

A 32-bit path hash is treated as a unique document identity. `byStream.set` silently replaces an existing path. The accepted filenames `fjgtmix.txt` and `f173u6yd.txt` both hash to `2283973650`. Opening both routes the first file's edits/state/awareness to the second file's document.

**Evidence:** an update containing `intended for first file` left the first document empty and inserted the text into the second. This deterministic collision does not imply ordinary small pads frequently collide.

**Fix/regression:** include and verify the path/document identity in the envelope or negotiate collision-safe IDs. Keep this filename pair in a regression requiring independent document state.

### F29 — Reconcile open documents after a filesystem rescan

**Locations:** [watch.rs](../crates/ajar/src/workspace/watch.rs), `classify`; [main.rs](../crates/ajar/src/main.rs), lines 1261–1302.

More than 500 touched paths become `FsEvent::Resync`. The touched-path branch calls `reconcile_docs`; `flush_resync` only rebuilds/broadcasts the tree and invalidates the snapshot. A bulk checkout/generator changing an open file leaves its CRDT at the previous contents. The next edit, or even the last reader closing, can write that stale document over the external change.

**Fix/regression:** reconcile all open documents after successful rescan, including missing/binary/oversized transitions. Change an open file in a batch exceeding 500 paths, then verify browser text and subsequent write-back retain the external change. Native reproduction remains to be run.

## Pad commands and lifecycle

### F30 — Quote Run filenames for the shell

**Location:** [app.ts](../pad/src/app.ts), line 861; admission in [pad.rs](../crates/ajar-relay/src/pad.rs), `check_path`.

`JSON.stringify(this.active)` is JSON quoting, not shell quoting. Accepted `price$USD.py` expands a variable; backticks and `$()` execute substitutions inside the generated double quotes. Newlines become JSON escapes. Run may execute something other than the literal selected filename. This is execution inside the Pad sandbox, not a demonstrated host escape.

**Fix/regression:** pass a literal argument without shell evaluation where possible, or use POSIX quoting and an unambiguous relative path. Test dollar signs, quotes, substitutions, newlines and leading dashes reaching Python unchanged.

### F31 — Persist new empty files

**Location:** [app.ts](../pad/src/app.ts), lines 471–480 and 396–425.

New file creates/opens an empty model and writes the runtime, but never marks the file dirty or schedules a save. Model creation precedes its change listener, and document seeding deliberately does not mark it dirty. Creating an empty module/package marker then reloading loses it; peers never see it unless later typing/publication persists it. The store supports empty files; this is distinct from the deliberate empty-directory limit.

**Evidence:** `addFile` followed by `saveEdits` issued zero store writes although `empty.py` existed in the model/runtime.

**Fix/regression:** enqueue creation explicitly. Create an empty file without typing or running anything, wait for saving, reload and open a second tab; both must retain it.

### F32 — Cancel retries when closing browser connections

**Locations:** [connection.ts](../web/src/connection.ts), lines 56, 125 and 205–207; [peers.ts](../pad/src/peers.ts), lines 137, 178 and 253–255.

Both clients schedule an untracked reconnect timer. Close after socket loss but before that timer fires finds no socket to close. The callback then calls `open`/`connect`, which never checks the permanent-close flag. A disposed workspace can rejoin, occupy a connection slot and call into disposed UI/documents.

**Evidence:** controlled timers for both actual classes created another WebSocket after `close`.

**Fix/regression:** cancel the retry timer and check permanent closure before creating any socket. Disconnect, close during backoff, advance timers, and require no new socket/callbacks.

## Relay and delivery

### F33 — Remove registry entries conditionally under their lock

**Location:** [session.rs](../crates/ajar-relay/src/session.rs), lines 292–302 and 413–424.

`drop_peer` checks emptiness, releases the entry guard, then removes by name. A peer joining between those operations loses its live room. `reap` collects expired names and later removes them without rechecking whether a host resumed meanwhile. That race deletes a recovered hosted session. Surviving sockets fail membership checks or send into a missing registry entry.

**Fix/regression:** atomically recheck emptiness/expiry and identity when removing. Exercise last-peer departure versus join and expiry selection versus host resume with controlled interleavings. These Rust paths were traced, not executed here.

### F34 — Reserve global store space before concurrent writes

**Location:** [pad.rs](../crates/ajar-relay/src/pad.rs), lines 600–628.

The global disk ceiling uses a separate `used.load` check and post-write `fetch_add`. Different pad stripes let concurrent writes pass against the same remaining disk space. With 1 MiB free, two concurrent 0.75 MiB additions can both pass and save. Four write permits bound the overshoot but do not enforce `--max-store-bytes`, especially on smaller configured stores. This finding concerns the global disk ceiling; `quota.rs` explicitly accepts bounded overshoot for the separate per-address growth allowance, which is not counted as a new defect here.

**Fix/regression:** reserve global growth atomically and refund failed writes. With disk allowance for one request, synchronize two writes on different stripes; exactly one may succeed and stored bytes must stay within the configured ceiling.

### F35 — Repair and gate the focused review suite

**Locations:** [review-repros.cjs](../scripts/review-repros.cjs), lines 76 and 82–92; [console.ts](../pad/src/console.ts), lines 479–490; [check.sh](../scripts/check.sh).

`npm run test:review` passes two cases then throws `TypeError: this.shell?.interrupt is not a function`. Its shell double supplies `close`, and Console construction still uses the old positional callbacks. Six regression cases are never reached. CI runs `check.sh`, which omits `test:review`, so its failure is invisible to the normal gate.

**Evidence:** reproduced. Replacing only the fake shell's `close` with `interrupt` in memory allowed all eight cases to complete; no repository test was changed. That diagnostic does not make the checked-in command pass.

**Fix/regression:** update doubles to `ConsoleHooks` and current shell interfaces, assert interrupt/input behavior, and include this suite in the gate. Require all eight unmodified cases to complete.

### F36 — Version vendor URLs or allow revalidation

**Locations:** [Caddyfile](../deploy/Caddyfile), lines 84–88; [vite.config.ts](../pad/vite.config.ts), lines 41 and 64–77; [runtime.ts](../pad/src/runtime.ts), `sdk`; [sw.js](../pad/public/sw.js), `MANIFEST`.

Production marks `/vendor/*` and `/packages/*` immutable for a year. But SDK/WISP assets are overwritten at fixed paths such as `/vendor/wasmer/dist/index.js` and `/vendor/wisp/src/compat.mjs`; the manifest is always `/packages/manifest.json`. They have no versioned URL despite the config comment. After an update, returning browsers may run new application code against the old SDK/manifest, with previously uncached workers fetched from a different version.

**Fix/regression:** version the whole vendor directory, preserving relative imports, and revalidate the mutable manifest. Keep immutable caching for content-addressed assets. Test two deployments in one browser profile without clearing HTTP cache; the second must use its SDK and manifest.

**Mostly fixed.** The manifest and the registry's recorded answers revalidate since 12 October. The SDK is under a folder named for a hash of its files since 21 October, after a browser holding the SDK from before 0.18 ran 0.18's WebAssembly against the old glue and could start no runtime; the page itself is served `no-cache`. Wisp is still at a fixed path: the page's import map names it, and the Content-Security-Policy pins that map by its hash, so versioning it broke the live pad for half an hour that day. See "The vendored SDK is in a folder named for what is in it" in [dev/pad.md](dev/pad.md).

## Previously recorded issues still open

These were already in [open-points.md](open-points.md). They remain actionable after source rechecking and are included for one consolidated open list.

### K01 — Enforce read-only on document mutations (P1)

[main.rs](../crates/ajar/src/main.rs), lines 714–718, gates raw PTY input only; lines 744–760 apply document updates regardless. [main.ts](../web/src/main.ts), line 769, enables editor writes unconditionally. A normal guest can persist edits while the host says read-only. Gate mutation at the host and update open editors. Test browser typing and raw document updates while read-only is active.

### K02 — Validate awareness IDs before generating CSS (P2)

[web/editing.ts](../web/src/editing.ts), line 203, and [pad/editing.ts](../pad/src/editing.ts), line 248, interpolate remote `user.id` into selectors. TypeScript's number annotation does not validate awareness JSON. A string with rule delimiters can introduce CSS; escaping the name does not protect the ID. Require bounded numeric IDs or internal safe classes. Test crafted IDs create no extra rules. Script execution/data exfiltration was not demonstrated.

### K03 — Preserve large-snapshot admission when sending its envelope (P2)

[ws.rs](../crates/ajar-relay/src/ws.rs), lines 233–247, queues metadata then the blob. [outbox.rs](../crates/ajar-relay/src/outbox.rs), lines 96–105, admits an oversized frame only when no bytes are queued. A valid snapshot above roughly 8 MiB is refused if its metadata is still queued, although storage accepts 25 MiB. This depends on writer scheduling. Test a paused writer and 9 MiB snapshot; deliver the entire response without disconnecting.

### K04 — Account for sockets before waiting for hello (P1)

[ws.rs](../crates/ajar-relay/src/ws.rs), line 56, waits indefinitely before quota claim at line 90. An upgraded socket sending no hello retains connection/task resources without spending quota, bypassing the join limits. Claim a preliminary budget at admission and impose a handshake deadline. Test idle/malformed pre-hello clients, timely closure and slot release.

### K05 — Unify live scanner/watcher ignore rules (P2)

[filter.rs](../crates/ajar/src/workspace/filter.rs), lines 46–53, captures only root `.gitignore`/`.ignore` at construction; [mod.rs](../crates/ajar/src/workspace/mod.rs), lines 55–61, also uses nested/global/Git excludes. Watch events can publish initially excluded paths, and changed ignore files leave the filter stale. Use consistent rules with invalidation. Test nested exclusions and rule changes during a session. Ignoring a file is not a confidentiality boundary against the guest's shell.

### K06 — Support multi-digit IDs in the kick panel (P2)

[ui.rs](../crates/ajar/src/ui.rs), lines 257–262, converts one digit to a target. [session.rs](../crates/ajar-relay/src/session.rs), lines 95–98, allocates ever-increasing IDs, including reconnects. The panel cannot select guest 10 or higher although the relay supports them. Use full numeric input or guest selection. Reconnect past ID 9 and remove that exact participant from the panel.

### K07 — Make checkpoint coverage and change attribution accurate (P2)

[checkpoint.rs](../crates/ajar/src/checkpoint.rs), line 61, uses `git stash create`, omitting pre-existing untracked files. Restore cannot recover them after guest overwrites. `changed_since`, lines 76–87, reads current porcelain status rather than comparing with the checkpoint, attributing the host's earlier edits to the session. Preserve initial untracked contents or explicitly describe them as unprotected before sharing; compare changes with the real baseline. Test a dirty repository with an existing untracked file and a session making no edits.

## Validation performed on 28 September

| Check | Result |
|---|---|
| Baseline | Clean at reviewed commit |
| `npm run typecheck` | Passed shared UI, hosted web and Pad |
| `npm run build` | Both clients passed on Windows; bundle-size/dynamic-import warnings remain |
| `node scripts/test-ui.cjs` | Both layout suites and page boots passed, including four viewports, resizing, focus, preferences and disposal |
| `npm run test:review` | Failed after two passing cases: stale interrupt double (F35) |
| Review suite with one in-memory fixture substitution | All eight passed; diagnostic only |
| New focused checks | Reproduced F24, F25, both F26 directions, F27's exact splice block, F28's filename collision, F31, and F32 in both clients |
| Rust fmt/clippy/tests and agent/relay smokes | Not run: Cargo/rustc unavailable on this session's PATH; no toolchain installed |
| Linux/macOS confinement and full WASIX/network/preview suites | Not run; component doubles/UI boot checks do not exercise them |
| Docker and production | No image build, deployment or production probes |

New checks reused the TypeScript loader/in-memory fixtures at the start of `scripts/review-repros.cjs` without editing it. Each finding records its sequence and observed values. Application code, manifests and lockfiles were not edited.

## Follow-through

Prioritize controls and data preservation: K01/K04, F22 and F24–F29. Add regressions failing on this version before implementing fixes. Then address relay cleanup/quotas and caching, repair the focused gate, and complete supported-platform native/browser-runtime suites.

Deliberate limits remain in `open-points.md`: anonymous plaintext pads, 90-day expiry/name reuse, empty-directory persistence, publication at command completion, restricted egress and known runtime/package limitations. Key-holding socket reachability, slow-reader availability and recorded flakes also remain there; this review does not call them new findings or claim they were resolved.

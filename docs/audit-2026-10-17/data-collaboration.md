# Pad audit: data integrity, collaboration, imports and previews

Audit date: 17 October 2026. Scope: current checkout of Pad, plus deployed JavaScript supplied by the main audit. No application changes or production attack traffic were made by this workstream.

## Evidence and limits

`data-pure-repros.mjs` executes the current TypeScript modules using Node 24's type transformation. It exercises actual Store/ZIP/carry/path functions and actual App methods with in-memory HTTP, editor, filesystem and confirmation doubles. The App probes do not constitute browser E2E tests; they isolate application logic deterministically. Nine probes completed successfully, reproducing defects rather than asserting that the product is healthy. Results are in `data-pure-repros.json`. The supplementary `data-collaboration-repros.cjs` also completed all eight probes using the real App and Yjs modules, including actual wrong-file document updates and divergent seeded documents (`data-collaboration-repros.json`).

`preview-session-repros.cjs` executes the actual service worker in a VM with browser/SDK message doubles. Both probes completed. Results are in `preview-session-repros.json`. The main audit fetched the deployed preview worker and found normalized source equality with this checkout (`deployment-parity.json`, `live-preview-sw.js`). Thus its routing and sender-check defects exist in deployed code; an end-to-end browser exploit was not attempted here.

The deployed `live-bootstrap-BYCpXIlo.js` was inspected: its `saveEdits`, `move`, document mapping and `beforeunload` methods contain the same relevant control flow as this checkout. Its live helper chunk `live-problems-CVQixfdG.js` also contains the same ZIP inflation and request-deadline logic. The actual merge and both hash functions were extracted from that deployed asset and executed: they reproduced the identical corrupted merge and collisions. Evidence: `data-source-parity.json`, `deployed-data-functions.cjs`, `deployed-data-functions.json`. Full build equivalence was not established; these are specific deployed-code matches, not claims that every local file is deployed.

Specific deployed helper fingerprints (character offsets in the saved asset): merge `fi` at 4,371; seed hash `Fl` at 87,803; document-path hash `hh` at 99,766; request timeout diagnostic at 96,728 followed by `finally{clearTimeout(r)}`; ZIP decompression at 139,543 preceding its size check at 139,653. Both hash functions contain `Math.imul(t,16777619);return t>>>0||1`. These offsets are tied to the saved hashed asset, not source line numbers.

No finite suite proves “zero errors for any action.” In particular, actual browser eviction/offline recovery, hostile ZIP memory exhaustion, cross-browser service-worker behavior and every authenticated access transition were not exhaustively exercised by this workstream.

Severity here: P1 = material data loss or isolation failure requiring prompt correction; P2 = significant correctness/reliability issue with a narrower trigger. Confidence and observed behavior are stated separately from potential impact.

## Findings

### DC-01 — P1: ZIP replacement can be silently undone by another editor

**Confirmed locally through actual `App.importZip`, `App.refresh`, and `App.saveEdits` methods.** Source: `pad/src/app.ts:3110`, `pad/src/app.ts:3139`, `pad/src/app.ts:635`.

Reproduction:

1. Both clients know `target.txt = old`. Client A has another file open and no live document for `target.txt`. Client B has `target.txt` open.
2. A imports a ZIP replacing `target.txt` with `IMPORTED` and confirms replacement. The store contains `IMPORTED`; A reports “added 1 file from audit.zip”.
3. B refreshes after the change notification. Its `known` copy advances, but its live document still contains `old`, because refresh intentionally treats existing CRDT documents as authoritative.
4. B types. Its next save stores `old plus next edit`, losing `IMPORTED`.

Import changes only documents already open in the importing client. It does not join a document held by another client. In contrast, `publish` explicitly joins remote documents before applying command changes (`app.ts:2710`). Import should use an equivalent shared-document transaction, or a versioned replacement protocol. The same class of problem warrants regression coverage for moves that replace a destination open elsewhere.

### DC-02 — P1: moving a nested folder into its ancestor deletes a moved descendant

**Confirmed locally through actual `App.move`. Relevant method matches deployed bootstrap.** Source: `pad/src/app.ts:3228`, `pad/src/app.ts:3233`, `pad/src/app.ts:3286`; UI route: `pad/src/files.ts:66`, `pad/src/files.ts:504`; server last-write rule: `crates/ajar-relay/src/pad.rs:1595`.

Start with:

```text
a/a/x.txt       = first
a/a/a/x.txt     = second
```

Drag `a/a` to the root, merging it into `a`. This is allowed by the drag guard. Expected:

```text
a/x.txt         = first
a/a/x.txt       = second
```

Observed: only `a/x.txt = first` remains in the store and models, while the UI reports “moved a/a to a”. New paths are written first, then every old path is deleted. Here a destination is also a source path; the later deletion wins. Local model cleanup repeats the loss. Filter cleanup against final destination paths and make the move atomic, with overlap tests.

### DC-03 — P1: stale-save recovery overwrites the concurrent version

**Confirmed locally through actual `App.saveEdits`; same fallback observed in deployed bootstrap.** Source: `pad/src/app.ts:1504`, `pad/src/app.ts:1511`.

A client knows a 17,000-character baseline and adds `MINE` at the start. The server has already accepted another client's `THEIRS` at the end. The first client sends a hash-conditional edit. The server rejects it with 409, correctly detecting the conflict. The page immediately retries an unconditional full-file replacement without reading or merging the newer version. Observed: `MINE` survives, `THEIRS` disappears, status says “saved”.

This trigger matters when HTTP works while collaboration is disconnected, blocked or delayed, or the live room is unavailable. Normal healthy CRDT operation may avoid it; the HTTP fallback does not preserve the safety of its conflict detection. On 409, fetch/rebase or surface a recoverable conflict instead of overwriting the version that caused rejection.

### DC-04 — P1: failed quota saves are removed from unsaved bookkeeping

**Confirmed locally through actual `App.saveEdits`; same branch observed in deployed bootstrap.** Source: `pad/src/app.ts:1480`, `pad/src/app.ts:1528`.

With a model containing `unsaved work`, durable value `old`, and a 507 rejection, the result is:

```json
{"dirty":0,"retry":null,"model":"unsaved work","durable":"old"}
```

The page does display “storage full — this is not being saved”, which is a useful warning. However, it clears the dirty set before sending, then returns from the 413/507 branch without restoring it. Freeing capacity or saving another file does not by itself retry this file. Later access-loss preservation also relies on the dirty set and can miss it. Keep unsaved state distinct from retry eligibility; permanent quota failure should stop automatic retries without pretending no unsaved work exists.

### DC-05 — P1: editors have no durable recovery or leave warning for unsaved work

**Source-confirmed design gap; actual offline close/reload loss was not browser-tested by this workstream. Deployed `beforeunload` condition matches.** Source: `pad/src/app.ts:2499`, `pad/src/app.ts:1450`, `pad/src/app.ts:1553`; `pad/src/store.ts:409`.

The leave prompt protects only viewers with `local.size > 0`. Editors with dirty data, failed requests or requests queued behind an in-flight save receive no corresponding prompt. Data lives in models/documents and the write queue, without a persistent IndexedDB/local draft journal in this path. `pagehide` attempts a save, but only requests under 60,000 bytes use `keepalive`, and queued work or an offline network cannot be made durable by that call. Browser termination or closing the sole editing tab can lose the only copy.

This is especially consequential after DC-04 or DC-07. Preserve an acknowledged/unacknowledged journal locally and show a persistent save state; use a leave guard as a secondary protection, not as the sole recovery mechanism.

### DC-06 — P2: coarse three-way merge duplicates source text under disjoint edits

**Confirmed by the actual `carryOver` function and the equivalent function extracted from the deployed asset.** Source: `pad/src/carry.ts:44`, `pad/src/carry.ts:65`; callers include `pad/src/app.ts:2655` and `pad/src/app.ts:2749`.

Input strings:

```text
baseline:     A\nB\nC\n
local result: a\nB\nc\n
other result: A\nB!\nC\n
expected:     a\nB!\nc\n
observed:     a\nB\ncA\nB!\nC\n
```

The function reduces all local changes to one contiguous replacement. When a collaborator changes text inside that span, its fallback inserts the whole replacement without removing originals. Commands modifying two separated regions, and reconnect rebasing, can therefore duplicate old code/data. This preserves bytes but does not preserve a valid program or the intended edit. Use a proper multi-hunk three-way merge with conflict handling; include nonadjacent edits in race tests.

### DC-07 — P2: the network deadline stops at response headers, allowing a permanent save-queue stall

**Confirmed by the actual `Store.write`; corresponding early timer cleanup observed in deployed helper code.** Source: `pad/src/store.ts:274`, `pad/src/store.ts:285`, `pad/src/store.ts:412`; queue impact: `pad/src/app.ts:1553`.

A mock server returns HTTP 200 headers immediately, then leaves the JSON response body open. With a 20 ms configured deadline, the write remained pending and its AbortSignal remained un-aborted beyond 1,000 ms in a probe. The fixture was then completed to clean up. `request()` clears the timer as soon as `fetch()` yields a Response; `res.json()` runs afterward outside the deadline. With no body completion, every subsequent write serialized behind this operation also waits indefinitely.

Carry the abort/deadline through body consumption, and test slow/truncated bodies separately from a server that never sends headers.

### DC-08 — P2: ZIP's advertised inflation safety check happens after full allocation

**Confirmed by the actual `readZip`; controlled 16 MiB local fixture, no memory-exhaustion attack. Same allocation/check ordering observed in deployed helper code.** Source: `pad/src/zip.ts:64`, `pad/src/zip.ts:214`, `pad/src/zip.ts:216`.

A 16,425-byte ZIP whose directory declares one uncompressed byte was passed a 1,024-byte limit. The parser fully decompressed and allocated 16,777,216 bytes, then rejected the inconsistent size. `through()` calls `Response.arrayBuffer()` on the entire decompressed stream. The file-level and total limits are checked only afterward, despite the header comment claiming checks while inflating.

An untrusted ZIP can therefore greatly exceed the 100 MiB pad limit in the browser before rejection; tab memory exhaustion and lost unsaved work are plausible consequences, not outcomes attempted here. Consume the stream with a running byte limit, cancel at the threshold, bound compressed input/entry metadata too, and keep decompression off the editing thread where practical.

### DC-09 — P2: distinct paths collide in the collaborative document routing key

**Actual hash collision and wrong-file update confirmed using App and real Yjs documents. Both hash functions extracted from the deployed helper produce the same collision.** Source: `pad/src/peers.ts:66`, `pad/src/app.ts:723`, `pad/src/app.ts:805`.

These two valid names both yield stream ID `1802545438`:

```text
file-1ezsubx.txt
file-6yp6oj.txt
```

`byStream` stores one path per 32-bit hash. Opening the second overwrites the mapping, so subsequent frames for either file are looked up as the second file. Closing one also deletes the shared mapping. In the real-Yjs probe, both started with `same`; an update intended for the first left it unchanged and changed the second to `same WRONG-FILE`. The collision was found in a modest deterministic name search. It is uncommon accidentally in a small pad, but requires no cryptographic attack and is avoidable.

The seed ID also uses the same 32-bit FNV function (`editing.ts:99`). Using these two strings as contents, the real-Yjs probe exchanged updates and still had divergent text (`file-1ezsubx.txt` versus `file-6yp6oj.txtt`), while foreign-root detection returned null. Different seeded contents can consequently share a Yjs client ID, undermining the logic that assumes seed IDs identify distinct initial histories. Use an explicit collision-resistant document identity or a negotiated mapping and validate path ownership on messages; avoid derived Yjs identity collisions.

### DC-10 — P1: preview navigation can enter another open pad's server

**Confirmed in actual service-worker VM; deployed worker matches the audited source. Browser exploit chain not attempted.** Source: `pad/preview/sw.js:155`, `pad/preview/sw.js:156`.

Register session A and navigate its page: response is from A. Register/open session B, making it active. Navigate with A's existing client ID: response is from B. The handler explicitly ignores the per-document map for navigations (`navigation ? null : documents.get(event.clientId)`) and falls back to global `active`.

Normal in-app focus events may reset `active` for many interactions, but pop-out windows, two visible previews, scripted navigations and timing between tabs are exposed. This violates the claim that each pad's routes and cookies are kept apart; a form could be submitted to the wrong server, and content can cross sessions in the same browser. Bind each navigation to its owning session without a global fallback; test two independent previews, pop-outs, nested frames and redirects.

### DC-11 — P2: untrusted preview pages can speak the worker's control protocol

**Confirmed in actual service-worker VM; deployed worker matches.** Source: `pad/preview/sw.js:65`, `pad/preview/sw.js:84`, `pad/preview/sw.js:111`, `pad/preview/sw.js:504`.

An ordinary preview client sent `pad-preview:front` for a known session. The worker changed that session's `control` recipient from `control-a` to `untrusted-page`. The worker assumes these messages came through the trusted control page but does not check the sender's URL/client identity. Every HTML preview is given its own session ID in the injected script tag, so an untrusted page can obtain the identifier for its own session.

This lets preview content interfere with route/control state and the destination of diagnostics. Cross-session exploitation requires access to the other session ID or another isolation flaw; it was not proven here. Authenticate the control client once, reject subsequent rebindings and arbitrary route registration, and keep guest-page messages distinct from trusted pad-control messages.

### DC-12 — P2: a runtime read error becomes a durable deletion

**Confirmed by the actual `sync.diff` with a fault-injected runtime.** Source: `pad/src/sync.ts:157`, `pad/src/sync.ts:158`, `pad/src/sync.ts:178`; caller: `pad/src/app.ts:2690`.

The runtime listing contains `existing.txt`; its previous known content is `important data`. `readBytes` throws a temporary read error. The resulting outgoing change is `{path:"existing.txt",content:null}`. The diff skips unreadable entries, then deletes every previously known path absent from its new map. Publishing this diff therefore deletes a file that was listed as present. A genuine disappearance and an unreadable file require different handling. Abort the diff on unexpected read errors, or preserve the known value for unreadable paths. This is a deterministic fault-injection result; frequency of native/WASIX filesystem read failures was not measured.

## Additional limitations and follow-up coverage

- **Viewer-generated binary artifacts:** `keepLocally` deliberately skips binary changes (`app.ts:3425`); `collect` and `saveCopy` use stored binary maps rather than the viewer's sandbox (`app.ts:3022`, `app.ts:3510`). A viewer can run code, but generated images/data do not get the same visible preservation/export/copy path as text. This is a source-confirmed product limitation, not claimed as an accidental regression. Test it explicitly and make the limitation visible, or support export of the viewer's full sandbox.
- **Large multi-request operations are not atomic:** Store splits an oversized file/import into separate writes. Its own documentation acknowledges that a failure can leave a truncated file/partial import. Test interruption at every part, quota rejection after a first accepted chunk, another editor changing the file between chunks, and reload before retry. Prefer staging plus final commit for replacement operations.
- **Deletion racing unsaved edits:** refresh deletes a model/doc and clears dirty state when the server removes a file (`app.ts:642`). A colleague deleting while another person types needs a recovery copy and explicit conflict behavior; not separately reproduced here.
- **Browser coverage:** CI browser setup installs Chromium only (`.github/workflows/ci.yml:118`, `:145`). WebKit/Firefox/mobile Safari, restricted storage, disabled third-party cookies and mobile lifecycle need separate validation before any broad compatibility claim.

## What is already sound

The implementation addresses many real integration pitfalls: serialized writes, hash-conditional large-file edits, UTF-8/binary separation, surrogate-pair-safe edits, bounded websocket pending frames, reconnect state exchange, deterministic seeding for identical text, chunked uploads, explicit access-loss recovery, ZIP CRC verification and path filtering, and markdown sanitization. Preview pages use a separate origin, sandboxed frames and textContent for logs. These are meaningful foundations; the findings above mostly arise where those protections interact or where exceptional states bypass them.

Existing `pair-check.mjs` covers shared typing, reconnects, large files and history restoration. It is useful evidence of engineering care, but these newly reproduced cases explain why happy-path and previously fixed regression coverage do not establish end-to-end integrity.

## Ratings for this workstream

These are engineering judgments based on reviewed scope, not statistical reliability measurements. Potential assumes the identified classes are corrected and verified across real browsers.

| Dimension | Current | Attainable | Reason |
|---|---:|---:|---|
| Data integrity under ordinary single-client editing | 7/10 | 9/10 | Good save serialization; gaps emerge under conflicts and failures. |
| Collaboration integrity across imports, commands and moves | 4/10 | 9/10 | Several deterministic silent-loss/corruption paths remain. |
| Offline/failure recovery | 3/10 | 9/10 | No durable unsaved journal; quota and stalled responses weaken recovery further. |
| Import/export robustness | 5/10 | 9/10 | Useful ZIP, binary and path handling; collaboration, memory bounds and atomicity need work. |
| Preview isolation and multiple-session correctness | 4/10 | 9/10 | Separate origin is good; global routing and unauthenticated control messages undermine isolation. |
| Maintainability/testability of these subsystems | 7/10 | 9/10 | Clear rationale and targeted tests; App coordinates many intertwined asynchronous states. |

Priority order: prevent silent data loss (DC-01–04), correct preview session/control boundaries (DC-10–11), add durable recovery (DC-05), then cover merge granularity, complete response deadlines, bounded inflation, document identity and filesystem faults (DC-06–09, DC-12). Each needs a regression test that asserts user-visible content and durable content remain consistent, including a fresh reload after the operation.

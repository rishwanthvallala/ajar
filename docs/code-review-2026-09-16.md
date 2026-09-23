# End-to-end code review — 16 September 2026

> This report records the original findings. Their implementation status and
> verification are tracked in
> [code-review-fixes-2026-09-16.md](./code-review-fixes-2026-09-16.md).

Reviewed commit: `08419bb44fe70bcfb5fcfa284e458e4d1c41a909`.

## Assessment

The separation between the host agent, opaque relay, and browser workspace is clear. The highest-risk defects are at their boundaries: enforcing host controls, authenticating message direction, restoring state after disconnects, and keeping the pad's CRDT, editor, runtime, and durable store consistent.

This review identifies **22 actionable findings**. Eight existing focused reproductions still demonstrate defects in the current application classes. A Windows build failure was also reproduced. The remaining findings follow from source paths described below; they have not been exercised against a running Rust agent or relay here. This is a broad architecture and correctness review, not a claim that every line, command shim, or platform has been exhaustively tested.

Only this report was added. Application code, dependencies manifests, and the lockfile were not changed.

### Evidence labels

- **Reproduced:** executed against the actual TypeScript classes with controlled UI, HTTP, or filesystem doubles. These are not browser/WASIX or Rust end-to-end tests.
- **Build reproduced:** observed by running the repository build on Windows.
- **Source:** a concrete failure path identified in the checked-in code; the proposed regression remains to be run.

P1 means a security boundary, data integrity, or deployment blocker that should be addressed promptly. P2 means a significant functional or reliability defect.

## Project map

| Component | Responsibility and flow |
|---|---|
| `crates/ajar-proto` | Nine-byte frame header, typed control messages, AES-GCM sealing, snapshot envelopes. The browser maintains a corresponding TypeScript codec. |
| `crates/ajar` | Validates the shared directory, captures a Git checkpoint, scans for secrets, prepares OS confinement and process limits, connects outward to the relay, and owns PTYs, filesystem watching, Yrs documents, the host panel, and encrypted snapshots. |
| `crates/ajar-relay` | Registers hosted or peer sessions, assigns participant IDs, routes frames, meters session creation, bounds outgoing queues, holds hosted snapshots, and exposes the durable pad HTTP API. |
| `web/src` | Hosted-session UI: join key from the URL fragment, encrypted WebSocket connection, shared xterm terminals, file tree, lazy Monaco viewer/editor, Yjs binding, presence, and offline snapshot viewing. |
| `pad/src` | Browser workspace: loads the durable folder, joins a peer room, edits through Yjs/Monaco, runs a WASIX sandbox, and writes text files back through HTTP. Peer frames announce changes or carry document updates. |
| `pad/src/shell.ts`, `console.ts`, `tools/` | Persistent bash process, output completion sentinel, terminal line editor/input forwarding, and Python implementations of commands missing from the shipped binaries. |
| `pad/public/sw.js`, Vite configuration | Mirror Wasmer downloads and preserve the SDK worker/module directory structure. |
| `deploy/` | Three Caddy origins, systemd services, deployment script, PyPI-only WISP egress, and DNS forwarding. Preview execution is separated from the pad's origin. |
| `scripts/`, CI | Rust checks, frontend compilation, UI/layout checks, protocol smoke tests, acceptance checks, and separate browser-runtime/network probes. |

### The flows that matter

1. **Hosted session:** host startup checks → relay registration → fragment-key link → guest handshake → sealed presence/content → agent-owned terminal or document → broadcast output/change → filesystem persistence.
2. **Hosted reconnect:** the relay retains a dropped host for 45 seconds; a returning agent re-announces terminals. A relay restart discards the registry. A guest reconnect receives a new participant ID. These are different recovery cases and currently restore different, incomplete sets of state.
3. **Pad editing:** HTTP snapshot → model/document → peer CRDT updates → debounced HTTP write → peer change notification → HTTP refresh. The runtime is a separate copy of the folder, so updating the document does not itself update the files executed by bash.
4. **Pad execution:** seed sandbox → initialize shell/shims → execute command → detect completion → diff runtime files against `known` → HTTP write → notify peers. Run-button commands and typed commands currently use different input/busy-state paths.
5. **Deployment:** build Rust and both frontends → mirror/vendor runtime assets → copy files and units → restart services → apply Caddy configuration → health check. Docker is a separate delivery path and has drifted from the relay's startup requirements.

## Findings index

| ID | Priority | Finding | Evidence |
|---|---|---|---|
| F01 | P1 | A macOS guest can rewrite the sandbox profile used for subsequent terminals | Source |
| F02 | P1 | An unencrypted malformed control message can terminate the host agent | Source |
| F03 | P1 | Host terminal ciphertext authenticates in the opposite direction | Reproduced at crypto layer; execution path traced |
| F04 | P1 | Kick removes registry membership without stopping the guest socket | Source |
| F05 | P1 | A locked session becomes unlocked after a relay restart | Source |
| F06 | P1 | Linux grants access to Cargo credentials through the cache root | Source |
| F07 | P1 | Hosted document editing is not reattached after guest reconnect | Source |
| F08 | P1 | Remote pad edits leave stale runtime files that overwrite the durable store | Reproduced |
| F09 | P1 | Remote pad deletions are undone by the next local command | Reproduced |
| F10 | P1 | Overlapping autosaves can persist older text last | Reproduced |
| F11 | P1 | A file that grows past the editor limit can later be truncated on save | Source |
| F12 | P2 | A valid empty CRDT state is mistaken for an unanswered state request | Reproduced |
| F13 | P2 | Run-button programs cannot receive console input or Ctrl-C correctly | Reproduced |
| F14 | P2 | Arrow keys insert escape-sequence fragments into commands | Reproduced |
| F15 | P2 | Accepted file/directory path conflicts crash the pad tree | Reproduced in renderer; API acceptance traced |
| F16 | P2 | Pad reconnect does not reload durable folder changes missed offline | Source |
| F17 | P2 | The HTTP body limit is much smaller than the advertised pad capacity | Source and framework documentation |
| F18 | P2 | The pad build fails on Windows during WISP vendoring | Build reproduced |
| F19 | P1 | Docker cannot compile the relay because `run.sh` is absent | Source |
| F20 | P1 | The default Docker runtime cannot create the pad store | Source |
| F21 | P2 | Same-length edits do not invalidate the hosted offline snapshot | Source |
| F22 | P2 | Document writes are marked persisted before disk writes succeed | Source |

## Security and host controls

### F01 — Keep the macOS sandbox policy outside guest-writable storage

**Locations:** [profile creation](../crates/ajar/src/sandbox.rs) (line 331), [temporary-directory grants](../crates/ajar/src/sandbox.rs) (line 287), [launch wrapper](../crates/ajar/src/sandbox.rs) (line 116).

The agent writes its Seatbelt profile into `std::env::temp_dir()`. The profile grants guest writes to `/tmp`, `/private/tmp`, and the macOS per-user temporary-directory roots. Every later terminal invokes `sandbox-exec -f` with that same file.

A guest can change the policy file from an existing terminal and then request another terminal. The agent starts the new process using the changed policy, allowing it to run without the restrictions originally shown to the host. The original terminal does not need to escape its own policy to perform this change.

**Fix:** retain the policy in agent memory and pass it without a mutable guest-writable file, or place it in a location that guests cannot modify, replace, or unlink. Protect the parent directory as well as the file.

**Regression:** on macOS, create a session, attempt to alter the policy from its first confined terminal, then open another terminal and verify the original outside-write and credential-read restrictions still hold. This platform test was not run here.

### F02 — Reject guest control traffic and isolate parse failures

**Locations:** [guest forwarding](../crates/ajar-relay/src/ws.rs) (line 190), [host control parsing](../crates/ajar/src/main.rs) (line 570), [fatal propagation](../crates/ajar/src/main.rs) (line 431).

After joining an unlocked hosted session, a guest can send a Control-channel frame with target zero. The relay forwards it to the agent without validating its payload. Control frames are unencrypted, and `handle_frame` propagates a failed `parse_json::<Control>()` through the main event loop.

A valid frame header followed by malformed JSON, or a JSON object with an unknown control variant, therefore terminates the agent. The sender needs the session ID but not the encryption key. The error path also bypasses the normal final document flush. Valid forged membership messages are another consequence of allowing guest-supplied relay notices through this path.

**Fix:** enforce role-specific control-message allowlists at the relay. Treat malformed remote messages as connection/message errors, not errors that unwind the host process.

**Regression:** join using only a session ID, send malformed Control JSON, and assert that the agent remains alive, legitimate clients still work, and pending document changes persist.

### F03 — Authenticate message direction, not only the existing header

**Locations:** [authenticated header](../crates/ajar-proto/src/lib.rs) (line 90), [browser sealing/opening](../web/src/sealed.ts) (line 45), [targeted terminal replay](../crates/ajar/src/main.rs) (line 1116), [terminal input handler](../crates/ajar/src/main.rs) (line 645).

The target field means destination on host-to-guest traffic and sender on guest-to-host traffic. A host output frame for guest 2 and an input frame from guest 2 therefore have identical authenticated headers for the same PTY. Both directions use the same key.

The existing reproduction seals a targeted PTY output frame and successfully opens the unchanged ciphertext as an incoming frame. Source tracing shows that the host input handler would write its plaintext into the PTY. A relay capable of reflecting a targeted replay frame can thus turn previously emitted terminal bytes into terminal input without knowing the key. Whether particular reflected output forms an executable command depends on those bytes; the reproduction verifies the missing direction separation, not an end-to-end command execution exploit. The received-nonce cache does not record frames merely sent by the host.

**Fix:** use direction-specific derived keys or authenticated domain/direction information, with a protocol version that cannot silently fall back to the old format. Include the session context in the authenticated protocol design.

**Regression:** intercept an actual targeted host replay and reflect it toward the agent; require rejection before PTY input. Retain normal cross-language encryption round-trip tests.

### F04 — Kick must cancel the connection and revoke its routing authority

**Locations:** [kick](../crates/ajar-relay/src/ws.rs) (line 384), [registry removal](../crates/ajar-relay/src/session.rs) (line 336), [guest route](../crates/ajar-relay/src/ws.rs) (line 190).

Kick sends a `Closed` notice and removes the guest from the map. The socket handler still owns its sender, writer task, and fixed `me` identity. Its receive loop does not check that the participant remains a member. A modified client can ignore the notice and continue sending correctly stamped encrypted input to the host.

The standard browser closes voluntarily, which hides the missing server-side revocation. The guest can also continue requesting the stored snapshot through the existing socket.

**Fix:** associate cancellation with each connection; kicking must stop both socket directions. Reject frames from removed identities and perform the usual host/guest departure cleanup.

**Regression:** use a raw client that ignores `Closed`; after kick, verify PTY input, document updates, and snapshot fetches cannot succeed on that socket.

### F05 — Restore the lock before accepting joins after reconnect

**Locations:** [reconnect handler](../crates/ajar/src/main.rs) (line 384), [new session defaults](../crates/ajar-relay/src/session.rs) (line 73), [lock action](../crates/ajar/src/main.rs) (line 473).

The host retains `state.locked`, but a restarted relay creates a new session with `locked: false`. The agent's connection handler does not resend its current lock state. The panel can continue showing a locked session while new guests are admitted.

This also affects a lock toggled while the host is offline, since outbound traffic can be dropped during reconnect.

**Fix:** restore host controls as part of registration/recovery. To avoid a join window, the initial lock should be carried in the registration transaction rather than only a later frame.

**Regression:** lock, restart the relay, reconnect the agent, and immediately attempt a new guest join. Repeat with a lock change during an outage.

### F06 — Linux cache grants include a credential location

**Locations:** [cache roots](../crates/ajar/src/sandbox.rs) (line 25), [Linux grants](../crates/ajar/src/sandbox.rs) (line 496), [macOS credential exclusions](../crates/ajar/src/sandbox.rs) (line 77).

Linux grants read/write access to the entire `~/.cargo` directory. That includes `~/.cargo/credentials.toml`, which this same module explicitly identifies and denies on macOS. Landlock's additive grants do not contain an equivalent exclusion. A Linux host with Cargo credentials can expose them even though the sandbox is presented as withholding home-directory credentials.

The need to create cache directories on fresh machines is real, but it does not make the credential file a cache.

**Fix:** prepare and grant the necessary cache/toolchain subdirectories, or use a separate guest cache/home layout that excludes credentials. Audit the other broad roots for the same mixture of cache, executable, and secret data.

**Regression:** use a fake home outside writable temp with a sentinel Cargo credential; builds should work while reading the sentinel fails. Not run on Linux here.

## Hosted editing and recovery

### F07 — Reopen documents when a guest connection gets a new identity

**Locations:** [browser welcome handler](../web/src/main.ts) (line 329), [host leave cleanup](../crates/ajar/src/main.rs) (line 572), [host join initialization](../crates/ajar/src/main.rs) (line 1037), [document lifetime](../crates/ajar/src/docs.rs) (line 151).

When the only reader disconnects, the host flushes and drops that document. The browser reconnects with a new participant ID but retains its old `DocSession` and document ID. Welcome sends only a presence introduction; host join initialization sends the tree, PTYs, and roster, not a reopened document.

Subsequent browser edits are addressed to the old document ID. The host rejects them as an unknown document while the browser still shows an editable file. With other readers present the document may survive, but the returning participant is still not registered as its reader.

**Fix:** explicitly restore active document subscriptions and exchange CRDT state after connection recovery. Preserve and reconcile edits made during the outage rather than discarding the local document blindly.

**Regression:** edit a file as its sole reader, disconnect only the guest socket, reconnect the same browser instance, edit again, and assert disk persistence and convergence with a second guest.

### F11 — Refuse truncated reads during external document reconciliation

**Locations:** [reconciliation](../crates/ajar/src/main.rs) (line 997), [read truncation](../crates/ajar/src/workspace/mod.rs) (line 171), [initial edit eligibility](../crates/ajar/src/main.rs) (line 756).

Initial document opening correctly refuses files over 1 MB. Later, `reconcile_docs` accepts any nonbinary `Fs::Content` and ignores its `truncated` field.

Open a small file, then replace it from the host or terminal with a text file larger than the limit. The reconciler loads only its prefix into the CRDT. The next guest edit writes that shortened document over the full file, losing the tail.

**Fix:** apply the same size/binary eligibility checks on every reconciliation and suspend editing with an explicit reason when a file stops being eligible.

**Regression:** externally grow an open document past the cap, attempt an edit, and verify a sentinel beyond the cap remains on disk.

### F21 — Content changes must invalidate snapshots even when metadata is equal

**Locations:** [metadata comparison](../crates/ajar/src/workspace/mod.rs) (line 120), [snapshot scheduling](../crates/ajar/src/main.rs) (line 1053), [snapshot generation](../crates/ajar/src/main.rs) (line 813).

Workspace entries contain path, kind, and size. A same-length file rewrite compares equal, so `Workspace::apply` emits no patch. `on_fs_event` schedules a new snapshot only when a patch exists.

After an initial snapshot settles, replacing `old` with `new` leaves the relay's offline copy unchanged indefinitely unless another change invalidates it. Guests falling back after a host disconnect can see obsolete source despite the copy indicator appearing healthy.

**Fix:** invalidate content snapshots on relevant file-touch events independently of whether the visible tree metadata changed.

**Regression:** capture a snapshot, rewrite one file with equal-length content, wait beyond the debounce, disconnect the host, and inspect the offline copy.

### F22 — Acknowledge persistence only after the write succeeds

**Locations:** [due writes](../crates/ajar/src/docs.rs) (line 226), [pending shutdown writes](../crates/ajar/src/docs.rs) (line 249), [write-back](../crates/ajar/src/main.rs) (line 888).

`due_for_write` clears `dirty` and sets `written` before `write_back` attempts the filesystem operation. Write-back only logs failure and returns no success result. A transient write/rename error therefore stops timer retries, and shutdown can also skip the content because it already equals `written`.

The last-reader close path may make another write attempt, but a later close is not a reliable retry strategy for a document that stays open.

**Fix:** separate selecting pending writes from acknowledging successful writes. Retain dirty state and retry or surface a persistent unsaved state after failure.

**Regression:** inject one failed write, restore disk availability without another edit, and verify the pending content is eventually persisted, including during orderly shutdown.

## Browser workspace data integrity

### F08 — Propagate remote document changes into the execution filesystem

**Locations:** [remote updates](../pad/src/app.ts) (line 310), [refresh exclusion](../pad/src/app.ts) (line 205), [dirty-only model flush](../pad/src/app.ts) (line 534), [publish](../pad/src/app.ts) (line 763).

Remote CRDT updates alter the document but do not mark local edits dirty or update the runtime file. The following HTTP refresh skips any file with a live document, while replacing `known` with the newly saved server content. Publishing after a typed command then compares an old runtime file with that newer baseline and uploads the old text as a change.

The reproduction changes a document from `old` to `new` remotely, refreshes the store, and observes the next publish writing `old` back. A read-only command can trigger this; the command does not need to edit the file.

**Fix:** define an explicit reconciliation policy for document-to-runtime changes, including inactive documents and updates arriving during execution. A command diff should represent changes made relative to that command's synchronized starting state.

**Regression:** two peers, both with the file open and runtime started; A edits and saves, B executes a read-only command, and all copies must retain A's text.

### F09 — Remove remotely deleted files from the runtime and document registry

**Locations:** [remote removal](../pad/src/app.ts) (line 211), [document cleanup helper](../pad/src/app.ts) (line 296), [publish](../pad/src/app.ts) (line 763).

Refresh disposes the deleted file's Monaco model and removes it from `known`, but leaves the file in the runtime. It also does not call `closeDoc`, so live document state may remain subscribed. The next runtime diff treats the surviving file as newly created and sends it back to the store.

The reproduction confirms a remotely deleted file is uploaded again after refresh and publish.

**Fix:** reconcile deletion across the runtime, model, document, stream, dirty-save, and active-file state. Define conflict behavior when deletion meets unsaved local changes.

**Regression:** A deletes a file; B refreshes and executes a read-only command. Assert the file stays deleted in the store and B's sandbox, and its document subscription is gone.

### F10 — Serialize autosaves and command publication

**Locations:** [save debounce](../pad/src/app.ts) (line 477), [autosave](../pad/src/app.ts) (line 482), [command publication](../pad/src/app.ts) (line 763).

The debounce coalesces pending timers but does not serialize in-flight HTTP writes. `saveEdits` clears `dirty` before awaiting its request, so another save can start while the first is pending. The server uses arrival order and receives no client revision or compare-and-swap condition.

The reproduction resolves a newer save before an older save; durable content ends as `first`, the editor shows `second`, and nothing remains dirty. Reordering the responses also moves the local `known` and runtime state backward. Command publication uses the same store through a separate path.

**Fix:** serialize writes from each tab and keep changes made during a request pending for the next write. Coordinate refresh/publication with that queue; use server revision/conflict handling where multiple sources overwrite whole files.

**Regression:** control request completion/arrival order, edit during an outstanding save, and interleave a command publication. Require newest content and an accurate unsaved indicator.

### F12 — Distinguish an empty document from no response

**Locations:** [state request fallback](../pad/src/app.ts) (line 276), [seed](../pad/src/editing.ts) (line 136).

After waiting for peer state, `readyDoc` uses `doc.length === 0` to decide nobody answered. An empty document is a valid result, particularly just after someone deletes all text and before the HTTP debounce saves it. Seeding the stale stored text then revives the deleted content.

The reproduction applies a complete CRDT deletion state and shows that the subsequent seed restores the old text.

**Fix:** track whether a valid state response arrived separately from its visible text length. Seed only an uninitialized document, not an initialized empty one.

**Regression:** A deletes all text; B joins before the durable save. Both must converge to empty without reinserting the previous content.

### F15 — Reject conflicting file and directory paths

**Locations:** [store path validation](../crates/ajar-relay/src/pad.rs) (line 208), [write application](../crates/ajar-relay/src/pad.rs) (line 347), [tree construction](../pad/src/files.ts) (line 35).

The API validates individual paths but accepts a folder containing both `a` and `a/b`. The tree inserts `a` as a file with `children: null`, then dereferences its children while placing `a/b`. The renderer reproduction throws before drawing the folder.

A normal rename/create interaction or a direct API write can leave a pad that fails to render for subsequent visitors. The WASIX filesystem cannot represent the conflicting paths either.

**Fix:** validate the resulting path set atomically on the server and reject file/ancestor conflicts. Add a defensive client error state for previously stored invalid trees.

**Regression:** submit both orders of conflicting writes, including separate requests; reject them without changing the existing valid pad.

### F16 — Re-read the store on peer reconnect

**Locations:** [presence/rejoin callback](../pad/src/app.ts) (line 157), [peer welcome](../pad/src/peers.ts) (line 198).

Reconnect asks for state for documents already open, but never calls `refresh` to recover missed folder changes. Files added, removed, or changed without an open document while the socket was down stay stale until another peer happens to send a later `moved` message. A failed refresh is also silently abandoned without retry.

The state-vector exchange cannot recover files the browser does not yet know exist.

**Fix:** refresh the authoritative HTTP snapshot after reconnect and retry transient refresh failures. Use sequence numbers to avoid applying older overlapping reads.

**Regression:** disconnect B's peer socket, let A add/delete a file, reconnect B, then stop all further edits. B must converge without waiting for another notification.

## Terminal behavior

### F13 — Run-button execution must own console foreground state

**Locations:** [Run path](../pad/src/app.ts) (line 703), [announcement](../pad/src/console.ts) (line 242), [input routing](../pad/src/console.ts) (line 71).

The Run button calls `announce` and `sh.run` directly. `announce` only prints; it does not set `Console.running`. As a result, a Run-launched program waiting for input receives none: keystrokes edit the next command line instead. Ctrl-C clears that line rather than terminating the running program.

The focused reproduction confirms Ctrl-C after `attach`/`announce` never calls the shell's close method. A Run-launched input loop or server can leave the Run flow waiting indefinitely.

**Fix:** use one foreground-command lifecycle for both Run and typed commands, including input, interrupt, busy state, completion, and post-command sync.

**Regression:** Run a Python program that reads input, supply a line, then Run a long-lived program and interrupt it. Verify the console accepts a subsequent command.

### F14 — Parse terminal escape sequences before splitting text

**Locations:** [input loop](../pad/src/console.ts) (line 104), [arrow cases](../pad/src/console.ts) (line 122).

`handle` loops over individual characters and passes each to `key`. The arrow cases in `key` compare against complete three-character escape sequences, so they cannot match. Escape is ignored and `[D`, `[A`, and similar fragments are inserted as ordinary text.

The reproduction types `abc`, Left, and `X`; the command becomes `abc[DX` rather than `abXc`. History navigation is affected too.

**Fix:** decode recognized sequences before processing printable text, retaining incomplete sequences between input chunks.

**Regression:** exercise arrows in one chunk and split across chunks, history navigation, and ordinary pasted text.

## API and deployment

### F17 — Align the HTTP write limit with the pad's capacity

**Locations:** [route setup](../crates/ajar-relay/src/main.rs) (line 138), [JSON extractor](../crates/ajar-relay/src/main.rs) (line 220), [25 MB store limit](../crates/ajar-relay/src/pad.rs) (line 27).

The pad route uses `Json<WriteBody>` without overriding Axum's default body limit. Axum 0.8.9 applies a default 2 MB limit to this extractor, so a valid pad update with a larger JSON body is rejected before the 25 MB store check runs. This affects single large files and batches of otherwise valid files. The browser treats 413 as a permanent save failure. [Axum's version-specific documentation](https://docs.rs/axum/0.8.9/axum/extract/struct.DefaultBodyLimit.html) confirms the extractor behavior.

**Fix:** set an explicit bounded request limit that accounts for JSON encoding overhead, or implement bounded batches/chunks with clearly defined atomicity. Keep the store's aggregate limit separately enforced.

**Regression:** exercise the HTTP endpoint, not only `Store::write`, with requests above 2 MB but below the supported capacity, and with an actually oversized pad. No HTTP/Rust reproduction was run here.

### F18 — Use platform-aware package paths in the pad build

**Locations:** [WISP root calculation](../pad/vite.config.ts) (line 62), [Rollup input paths](../pad/vite.config.ts) (line 109).

On Windows, `createRequire().resolve()` returns a path containing backslashes. Searching it for the forward-slashed string `@mercuryworkshop/wisp-js` returns `-1`. The slice then produces an unrelated prefix rather than the package root.

`npm run build` reproduced this failure:

```text
[vendor-wasmer-sdk] ENOENT: no such file or directory,
lstat 'D:\ajar\ajar\node_modul\src'
```

The config also passes URL `.pathname` values directly to Rollup, which should be audited when fixing Windows paths.

**Fix:** derive package roots with `node:path` or normalized path components and convert filesystem URLs with `fileURLToPath`. Avoid substring arithmetic on native filesystem paths.

**Regression:** build and start the pad from a clean locked install on Windows, including a checkout path containing spaces.

### F19 — Include the relay's embedded runner in the Docker build

**Locations:** [Rust image inputs](../Dockerfile) (line 18), [embedded runner](../crates/ajar-relay/src/main.rs) (line 243).

The Rust Docker stage copies the Cargo files, crates, and `install.sh`, but not `run.sh`. The relay compiles `../../../run.sh` with `include_str!`, which resolves to `/src/run.sh` in that stage. The file does not exist, so a clean container build cannot compile.

The current gate checks that listed COPY sources exist; it cannot detect a required source that is missing from the COPY list.

**Fix:** copy all compile-time embedded resources and add an actual container build check.

**Regression:** build the Docker image from a clean context. The failure is established by source inspection; Docker was not built during this review.

### F20 — Give the Docker relay a writable persistent pad directory

**Locations:** [runtime image](../Dockerfile) (line 23), [entrypoint](../Dockerfile) (line 33), [store startup](../crates/ajar-relay/src/main.rs) (line 79).

After fixing F19, the default image still runs as the unprivileged `ajar` user with no writable working directory or explicit `--pad-dir`. The final Alpine stage defaults to `/`, so the default `./ajar-pads` resolves beneath the root directory. Store initialization runs unconditionally before the listener and fails when it cannot create that directory.

The systemd deployment already solves the equivalent requirement through `StateDirectory` and an absolute store path; the container path does not.

**Fix:** create and assign ownership of a state directory in the image, pass it explicitly, and document/mount a persistent volume for it.

**Regression:** run the image with its default command as its configured user; require health to become ready and a pad write to survive a container replacement with the same volume.

## Validation performed

| Check | Result |
|---|---|
| Working-tree status before review | Clean |
| Locked dependency installation | `npm ci --ignore-scripts --no-audit --no-fund` succeeded after approval to access npm's cache; manifests and lockfile unchanged |
| `npm run typecheck` | Both workspaces passed |
| `npm run build` | Ajar web succeeded; pad failed with F18 |
| `node scripts/review-repros.cjs` | Fails before running assertions because its CommonJS loader leaves `import.meta.env` in the transpiled code |
| Same existing reproduction script with an in-memory environment substitution | All eight defect reproductions completed successfully |
| Rust fmt, clippy, unit tests, relay/agent smoke suites | Not run: Cargo/rustc unavailable on the current Windows PATH; no toolchain installed for this review |
| Full UI, WASIX runtime, sandbox, preview and egress suites | Not run; the pad production build is blocked, and the runtime/platform services were not established |
| Production service changes or probes | None |

### Reproduce the eight focused findings

The pre-existing `scripts/review-repros.cjs` predates the Vite environment reads now present in `app.ts`. This Node command substitutes only those build-time environment lookups while loading TypeScript into the existing harness. It changes no files. Run from the repository root after installing dependencies:

```js
node -e 'const fs=require("node:fs"); const read=fs.readFileSync; fs.readFileSync=function(p,...a){const v=read.call(this,p,...a);return String(p).endsWith(".ts") && typeof v==="string" ? v.replaceAll("import.meta.env","({})") : v;}; require("./scripts/review-repros.cjs");'
```

Its eight cases cover F03, F14, F13, F09, F08, F10, F12, and F15. The assertions deliberately demonstrate broken behavior; a successful run is evidence that those defects remain, not a passing regression gate. The harness uses actual application classes but doubles for HTTP/runtime/UI dependencies, and F03 tests the cryptographic acceptance rather than a running Rust PTY.

## Existing limits and test gaps

The following already appear in `docs/open-points.md` and are not counted as newly discovered defects: plaintext anonymous pads, no accounts/locks for pads, week-long expiry, empty-directory persistence limitations, no sync from commands that never finish, PyPI-only egress, missing ajar preview URLs, the multi-dependency pip/runtime failure, and WISP's lack of connection rate limiting.

Additional coverage work should accompany the fixes:

- Repair or replace the focused reproduction loader and convert each defect assertion into an expected-behavior regression as its fix lands.
- Add real browser tests for reconnect with an open editor, remote deletion followed by a command, delayed autosaves, and Run-button stdin/interrupt behavior. The current component/layout checks do not establish these invariants.
- Exercise Rust security controls using clients that do not cooperate with UI notices, including malformed control traffic, ignored kick notices, ciphertext reflection, and lock restoration.
- Test HTTP limits and Docker boot separately from direct store unit tests and COPY-source existence checks.
- Add Windows frontend build coverage if this checkout is expected to remain usable natively on Windows; the current CI matrix covers Linux/macOS only.
- Keep Linux/macOS sandbox tests on their real kernels. Source analysis of F01/F06 is not a substitute for the proposed platform regressions.

Other areas worth a dedicated follow-up, without treating them as verified exploits here: inherited host environment/agent sockets, filesystem symlink races, the intentionally bounded replay cache, handshake/connection resource limits, pad API aggregate disk quotas, the unsynchronized expiry/read/write paths in the durable store, and command-shim fidelity. The Python tool suite was not exhaustively executed in this review.

## Suggested order of work

1. Address F01–F06 first: sandbox policy integrity, control-message validation, directional authentication, kick revocation, lock recovery, and credential grants.
2. Repair persistence and recovery together: F07–F12, F16, F21, and F22. Establish explicit ownership and synchronization rules across each product's copies of state before patching individual symptoms.
3. Restore reproducible delivery with F17–F20, then fix terminal input and invalid-tree handling in F13–F15.
4. Run the complete gate on supported host platforms and the separate pad browser/runtime suites, followed by a two-person session that includes an intentional network interruption.

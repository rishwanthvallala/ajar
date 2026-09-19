# Code review fix ledger — 2026-09-16

This ledger records the implementation made against each finding in
[`code-review-2026-09-16.md`](./code-review-2026-09-16.md). The deliberate product
constraints in [`open-points.md`](./open-points.md) remain outside this work.

## Status

| ID | Status | Fix |
|---|---|---|
| F01 | Fixed | The macOS Seatbelt policy is passed directly with `sandbox-exec -p`; no policy file exists in guest-writable temporary storage. |
| F02 | Fixed | The relay drops post-handshake guest/peer control frames, and the agent treats malformed control JSON as a dropped frame instead of unwinding the session. |
| F03 | Fixed | AES-GCM authenticated data now includes a host-to-guest or guest-to-host direction byte in Rust, the browser, and the shared Node smoke client. Reflected ciphertext fails authentication. |
| F04 | Fixed | Kick removes membership, queues one final `Closed` notice, rejects later sends, drains the notice, and closes the WebSocket. Every received frame also rechecks membership. |
| F05 | Fixed | Host `Hello` carries the live lock state on every connection. The relay applies it while registering the host, before a guest can join. |
| F06 | Fixed | `~/.cargo` is no longer a writable Linux cache grant. Only `~/.cargo/bin` is readable, while `CARGO_HOME` is redirected to `~/.cache/ajar/cargo`. |
| F07 | Fixed | A reconnecting hosted client reopens its active document under the new participant identity and replays the local offline splice over the host's current text. Old document frames are discarded at the new welcome. |
| F08 | Fixed | Remote pad CRDT updates are written into the WASIX runtime, and refresh keeps a live document's contents authoritative there. |
| F09 | Fixed | A remote deletion closes the document, disposes its model, clears dirty state, and removes the runtime file before later publication. |
| F10 | Fixed | Pad autosaves and command publication share one ordered write chain. An older completion cannot copy stale text back into the runtime. |
| F11 | Fixed | External reconciliation rejects truncated files. Write-back rechecks the live file and refuses binary, missing, or oversized targets. |
| F12 | Fixed | Document state waits resolve with an explicit `answered` boolean, so a valid update whose resulting text is empty is not mistaken for a timeout. |
| F13 | Fixed | Run-button commands enter console foreground mode and always leave it in `finally`; input and Ctrl-C now reach the running shell. |
| F14 | Fixed | Console input buffers and parses complete arrow escape sequences, including sequences split across callbacks. |
| F15 | Fixed | The pad store atomically rejects any resulting tree where a path is both a file and a directory. The renderer also handles legacy conflicting data defensively. |
| F16 | Fixed | Each peer welcome triggers a durable-store refresh keyed by the latest applied sequence, recovering nudges missed while disconnected. |
| F17 | Fixed | The pad PUT route has an explicit body limit sized for the 25 MiB content cap plus JSON escaping overhead. |
| F18 | Fixed | Vite derives package roots and Rollup inputs with file-URL utilities, so Windows drive-letter paths work. |
| F19 | Fixed | `run.sh`, which is embedded by the relay build, is copied into the Rust Docker build stage. |
| F20 | Fixed | The final image creates and owns `/var/lib/ajar/pads`, declares `/var/lib/ajar` as a volume, and passes the pad directory explicitly. |
| F21 | Fixed | Every relevant filesystem touch invalidates the offline snapshot, even when the visible tree metadata is unchanged. |
| F22 | Fixed | Pending document writes remain dirty until `atomic_write` succeeds; only then does `mark_written` acknowledge the exact content. Failed timer writes are retried. |

## Implementation notes

### Trust and session boundaries (F01–F06)

The frame wire format remains a nine-byte routing header, but encrypted payloads
now authenticate a tenth, non-transmitted direction byte. Both endpoints use the
same constants: `0xa1` for host-to-guest and `0xa2` for guest-to-host. This is a
wire-compatibility change for encrypted content, so the agent and browser need to
be deployed together. The shared Node wire client used by the end-to-end smoke
suites was updated at the same time: outbound guest frames authenticate `0xa2`,
and inbound host frames authenticate `0xa1`. Without that harness update, the
agent correctly discarded the smoke client's old-format PTY-open request and CI
timed out waiting for a terminal.

The relay's outbound queue now distinguishes an immediate abort caused by
backpressure from an orderly finish. Kick uses the orderly path so the browser
receives its reason before the socket closes. Registry membership is removed
before that drain begins, so a malicious client cannot use the closing interval.

The lock bit is part of `Control::Hello` with a Serde default for older browser
hellos. The agent reads an atomic lock value for each reconnect instead of
reusing the value from process startup.

### Hosted and pad state ownership (F07–F12, F16, F21–F22)

Hosted document reconnect records the text at disconnect and the text at the
new welcome. After the newly opened host document receives its initial state,
the browser applies only the local prefix/suffix splice. This keeps changes made
elsewhere outside that splice while preserving typing performed offline.

The pad now tracks the latest applied store sequence. HTTP writes, peer nudges,
CRDT updates, the Monaco model, and the WASIX filesystem converge through an
ordered write queue. Deletions propagate through all four layers.

Host document persistence is a two-step operation: select pending content, then
acknowledge it after a successful atomic write. The selection step no longer
mutates `written` or clears `dirty`, so transient failures remain eligible for
the next timer tick and orderly shutdown.

### Input, validation, and delivery (F13–F20)

The console owns foreground state for commands started from either the prompt or
the Run button. Its escape parser retains incomplete control sequences and
handles arrows as one logical key.

Pad path validation runs after all writes/removals have been applied to a copy of
the pad and before the JSON file is saved. A rejected mixed file/directory tree
therefore leaves the prior pad unchanged.

The Docker image now contains every compile-time asset and starts with a writable,
persistent pad store while retaining the unprivileged runtime user.

## Verification

- `npm run typecheck` — passed for `ajar-web` and `ajar-pad`.
- `npm run build` — passed for both production clients on Windows; WISP vendoring and all five pad Vite HTML entries completed.
- `npm run test:ui` — passed workspace lifecycle/resizing/focus checks at four viewports; both Ajar and Pad booted without page errors.
- `npm run test:review` — passed all eight focused regressions for F03, F08–F10, F12–F15.
- `node --check scripts/lib/wire.mjs` — passed after synchronizing the smoke client's directional authenticated header with Rust and the browser.
- `cargo test -p ajar-proto -p ajar-relay` — passed 75 tests (21 protocol, 54 relay).
- `cargo test --workspace` — compiled all three crates and passed 78 of 82 agent tests plus all protocol/relay tests. The four agent failures are existing Windows-environment assumptions (`/bin/echo`, Unix process-limit wording, and a PATH without `git`), outside the changed paths; the supported agent targets remain Linux/macOS.
- `cargo clippy -p ajar-proto -p ajar-relay --all-targets -- -D warnings` — passed.
- `cargo fmt --all -- --check` — passed after formatting.
- `git diff --check` — passed.
- Docker image construction could not run because the installed Docker Desktop service is unavailable to this session. Linux/macOS sandbox behavior still needs its normal kernel-specific CI coverage.

## Post-review UI follow-up

The Pad preview pane carried the HTML `hidden` attribute at startup, but its
author CSS set `.preview { display: flex; }`. That display declaration overrode
the hidden state and made CSS Grid allocate a blank third row between Monaco and
the terminal. `.preview[hidden]` now explicitly uses `display: none`, and the UI
boot check asserts that the pane consumes no layout space until a server preview
is opened.

The subsequent shared-workspace implementation retained that regression check
while replacing Pad's fixed grid with the same shell, resizers, narrow-screen
drawer, focus behavior, and panel styling used by Ajar. Detailed ownership,
fixture states, bundle measurements, and validation evidence are recorded in
[`dev/workspace-ui.md`](./dev/workspace-ui.md).

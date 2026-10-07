# ajar review — 7 October 2026

Four reviews of ajar, run the way the pad's were: security, parity with what
the pad had already fixed, the guest's experience (UX, accessibility, design,
copy), and end-to-end flows with edge cases and test gaps. Every finding below
was reproduced against built binaries unless it says otherwise. This file is
the ledger: what was found, what was done about it, and how it is checked.

Status: **fixed** (committed, with a check that fails without the fix),
**next** (planned, in the order below), **open** (not yet planned).

## Security

| | Finding | Status |
|---|---|---|
| S1 | A guest could take the host's place in the 45 s after the host's socket dropped, then send the other guests anything, sealed with the shared key; the real agent was refused and quit | fixed `58fbdbe` — `smoke-hostdrop` |
| S2 | A read by name returned what the tree hides: `.git/config`, gitignored files, through symlinks too, to read-only guests as well | fixed `58fbdbe` — `smoke-workspace`, unit test |
| S3 | A guest could open every file in the folder as a document, a megabyte of host memory apiece | fixed `58fbdbe` — unit test |
| S4 | The landing page and `install.sh` told people to pipe `https://ajar.sh/…` to `sh`; nobody owns `ajar.sh` | fixed `0574a0c` |

## Losing work

| | Finding | Status |
|---|---|---|
| W1 | A change on disk to an open file deleted everything typed since the last write, for everyone, and threw a cursor at the top to the end. A log being appended to lost every keystroke between appends | fixed — the disk's change is made on a shadow replica held at the last write and merged as a concurrent edit; unit tests, `smoke-editing` |
| W2 | Editing a file with a byte-order mark, mixed or bare-CR line endings put every edit one character early on disk; a Latin-1 file had its accents replaced on the first keystroke | fixed — the agent refuses to edit them (`Workspace::editable`), and the page refuses to bind when the editor's text is not the document's; unit test, `smoke-editing`, `check-guest` |
| W3 | Read-only toggled while someone typed left their later edits pending on the host for ever, the page and disk silently out of step | fixed — the page reopens the file from the host's copy whenever read-only flips; `check-guest`, pressing the panel's `l` through a real terminal with a guest 250 ms away |
| W4 | An open file deleted, moved, turned binary or grown past 1 MB stayed editable; every keystroke went nowhere and the host log said so four times a second | fixed — the document closes for its readers with the reason, said once, and the page keeps the text on screen, read-only, to copy; `smoke-editing`, `check-guest` |
| W5 | Switching files while the host was away discarded what had been typed in the first one | fixed — kept, off screen, and handed back when the host returns; `check-guest` |
| W6 | Closing the tab with typing that had not reached the host lost it without a word | fixed — the page asks first, only while something is unsent; `check-guest` |

## Staying connected

| | Finding | Status |
|---|---|---|
| C1 | Back to the session page showed a dead page, and its socket reconnected as a nameless "…" in everyone's roster; New terminal opened real shells nobody could see | fixed — not torn down when going into the back/forward cache; a fresh socket on the way back; `check-guest` with the cache on |
| C2 | A relay restart ejected for good every guest whose browser got back before the agent ("no such session") | fixed — once in, that refusal and `rate_limited` are waited out; `check-guest` |
| C3 | The agent quit, ending every terminal, on `host_taken` (a half-open socket the relay still held) or `rate_limited` (a flaky network); there was no keepalive on either side | fixed — the agent retries both and pings the relay, dropping a connection silent for 45 s; the relay pings every socket, lets the session's own key replace a stale host socket, and meters a resume as a join; `smoke-hostdrop`. Checked by hand: an agent from before this answers the relay's pings, idle for 95 s |
| C4 | Locking the session evicted existing guests at their first blip, and after a relay restart | next — a resume token, so those already in stay in |
| C5 | A guest joining while the host was away was told nothing: connected, no files, no terminals | fixed — the relay tells them, with the time left; `check-guest` |
| C6 | A file opened while the host was away hung for good if the saved copy did not have it; one from the saved copy was unlabelled, and stayed stale and read-only after the host returned | fixed; `check-guest` |
| C7 | With the host away the status said "open", and the countdown never moved | fixed; `check-guest` |
| C8 | Terminal typing while the host was away vanished | fixed — the terminal takes no input while the host is away |
| C9 | The backoff reset when the socket opened, so a relay refusing the hello was asked again every 250 ms | fixed — it resets on `welcome` |
| C10 | "Session ended" was a dead end, though the same link later worked | fixed — a Rejoin button, and a line saying so |
| C11 | The agent logged "cannot reach the relay — the link will not work" on ordinary reconnects | fixed |

## The editor and the terminals

| | Finding | Status |
|---|---|---|
| E1 | Switching files, or any reconnect, put the reader back at line 1; after a blip the next keystroke landed there | fixed — view state kept per file, the model reused on reconnect, and the document bound only once its state has arrived; `check-guest` |
| E2 | A binary or unreadable file's title lost its reason | fixed; `check-guest` |
| E3 | A departed guest's cursor stayed, with their name on it | fixed; `check-guest` |
| E4 | A terminal stayed the smallest guest's size after they left | fixed — the page no longer reports the host's size as its own, and reports its own after a reconnect; `check-guest` |
| E5 | A terminal that ended while a guest was disconnected stayed as a tab | fixed; `check-guest` |
| E6 | A refused terminal (the limit) was silent | fixed; `check-guest` |
| E7 | A paste into a terminal whose program was not reading froze the whole agent, ctrl-c included | fixed — each terminal's input has its own writer thread and a bounded queue, and an interrupt drops what is queued ahead of it; unit tests, `smoke` |
| E8 | Read-only guests could open terminals | fixed; `smoke-control`. That a read-only session drops keystrokes into a terminal already open moved to `check-guest`, which can press `l` |
| E9 | A folder renamed or moved in appeared empty, and the old name's contents stayed listed and counted | fixed; unit test, `smoke-workspace` |

## Next, in order

1. C4, the lock.
2. The host's panel: the link cut at 80 columns, hidden warnings, the kick
   prompt's digits, terminals credited to "you", directories counted as files.
3. Accessibility: the terminal's keyboard trap, an ARIA tree for the files,
   landmarks, live regions, contrast.
4. Design and copy: pad-style dead-end screens, read-only and locked
   explanations, presence dots, the editor and terminal following the theme,
   the landing page's header, status and error wording.
5. Downloading a file, folder or the whole workspace.
6. Tests: the panel's other keys through the pty runner (lock, kick, quit),
   fail fast when a port is already taken, and repeat failures at the end of
   each suite.

## Verification of this batch

Each fix was broken on purpose, one at a time, and its check run: every one
failed, except that Back out of the cache still works without the page
replacing its socket at `pageshow` — the old socket's close arrives on the way
back and the ordinary reconnect takes over. The replacement stays, because it
saves a quarter-second of "reconnecting", and has no check of its own.

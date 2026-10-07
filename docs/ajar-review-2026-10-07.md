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
| C4 | Locking the session evicted existing guests at their first blip, and after a relay restart | fixed — a per-tab secret the relay remembers, revoked by a kick, and vouched for by the agent to a restarted relay; unit tests, `smoke-control`, `check-guest` (a locked session through a relay restart) |
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

## The host's panel

| | Finding | Status |
|---|---|---|
| P1 | At 80 columns the link was cut, losing the end of its key | fixed — it wraps, gets its rows first when the terminal is short, and `[c]` copies it (OSC 52); render tests at 80×24 |
| P2 | Only the first two warnings were ever shown — the credentials one never | fixed — the box is as tall as what it holds; render test |
| P3 | The sandbox and copy shared one line, and `[d] stop` was always the part cut off | fixed — the copy has its own line, `[d]` is in the keys row |
| P4 | The kick prompt's digits fell off the end at 80 columns | fixed — the number comes first; render test |
| P5 | Terminals of a guest who had left were credited to "you" | fixed — "dana (left)" |
| P6 | Guests whose page could not read the session showed as "…" | fixed — after a few seconds, "someone with an incomplete link" |
| P7 | "18 files shared" counted folders | fixed, on the panel and in the page |
| P8 | Every reconnect logged the transport's error text | fixed — "lost the relay — reconnecting; terminals keep running" |

## The page

| | Finding | Status |
|---|---|---|
| G1 | A link with its key cut short, missing or wrong opened a session that never worked | fixed — a card that says so, before joining or once the first frames will not open; `check-guest` |
| G2 | A host whose laptop was asleep looked like an empty, working session | fixed — "waiting for the host", New terminal off, and after ten seconds a line saying it connects when they wake; `check-guest` (the agent stopped with SIGSTOP) |
| G3 | Dead ends were bare text: "Can't join", "Session ended", the version pages | fixed — the pad's card: what happened, the session's name, one action, the page's title and focus; relay codes and end reasons in words |
| G4 | The landing page: a leaked `header` rule boxed its title, prose was monospace, information was red, and it said nothing is kept | fixed |
| G5 | Lock and read-only were bare badges | fixed — said in a toast as they change, and on the badge |
| G6 | xterm's black viewport showed under a smaller window's rows in the light theme; the editor and terminal were not the page's colours | fixed |
| A1 | The terminal was a keyboard trap | fixed — F6 leaves it, Shift+F6 to the editor, and it says so; `check-guest` |
| A2 | The file tree could not be reached past its first screenful by keyboard | fixed — an ARIA tree with one roving stop, levels, arrows, Home/End; `check-guest` |
| A3 | End screens set no title and no focus | fixed |
| A4 | Announcements came from a live region that started hidden | fixed — toasts come from one that is always there |
| A5 | People were a span with an ignored label; "you" was an invisible outline | fixed — a list, "(you)" and "(host)" in words; `check-guest` |
| A6 | The name field had only a placeholder, and a border at 1.24:1 | fixed — a label, and a 3:1 border |
| A7 | No main landmark or heading; tab names ran into watchers' names | fixed |
| A8 | Remote cursors were 1.9–3.1:1 in dark mode | fixed — a dark palette, following the theme |
| A9 | The status re-announced every retry countdown | fixed — the countdown sits beside the live region |

## Downloads

| | Finding | Status |
|---|---|---|
| D1 | A guest could not take anything away but by copying it out of an editor | added — a file, a folder or the whole workspace; built off the agent's loop, sent a window at a time against acknowledgements, never anything the tree hides; unit tests, `check-guest` (a 3 MB file in the zip, checked with `unzip -t`) |

## Finishing touches

| | Finding | Status |
|---|---|---|
| F1 | Presence did not match the cursors, and pushed the header to three rows on a phone | fixed — a dot per person in their cursor's colour; on a phone, dots and a count; `check-guest` |
| F2 | An open empty folder showed nothing, like one still loading | fixed — an "empty" row; `check-guest` |
| F3 | The landing page had no theme switch and no icon; the tree's chevrons were 11 px glyphs | fixed |
| T1 | The panel's keys were never pressed by any test | fixed — `check-guest` presses `l`, `x`, `k` and `q` through `scripts/lib/ptyrun.py` |
| T2 | A suite's relay that died at start, its port taken, passed for a working one | fixed — `wire.mjs` notices and says so |
| T3 | CI's annotation showed only a log's tail, often not the failure | fixed — every suite says its failures again at the end |
| T4 | Acceptance #7 recorded "nothing re-ran" without looking; check-host-drop waited on a class Monaco never sets | fixed |

## Not done, on purpose

- Creating, renaming and deleting files from the tree. The shell does all of
  it, and a second way to change the host's disk is a second thing to secure.
- Uploading files from the browser, for the same reason.
- Printing the link before the panel takes the screen: the link now wraps and
  `[c]` copies it, which serve the same need while the panel is up.

## Shipped

| | Commit | Live |
|---|---|---|
| Security (S1–S3) | `58fbdbe` | 7 October, with the batch below |
| The installer's domain (S4) | `0574a0c` | 7 October |
| Losing work, staying connected, the editor and terminals | `e7d4c23` | relay and page 7 October; the agent's half needs a release |
| The lock, the panel, the page, downloads, finishing touches | `1093ca9` | relay and page 7 October; the agent's half needs a release |

## Verification of the first batch

Each fix was broken on purpose, one at a time, and its check run: every one
failed, except that Back out of the cache still works without the page
replacing its socket at `pageshow` — the old socket's close arrives on the way
back and the ordinary reconnect takes over. The replacement stays, because it
saves a quarter-second of "reconnecting", and has no check of its own.

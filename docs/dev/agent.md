# The agent

`crates/ajar`. It owns the folder, the terminals, the documents and the key,
and it is the only authority in a hosted session.

## Startup order, and why it is that order

Two things run **before** the link is minted, because both are about what the
host is agreeing to before anyone can arrive.

**A checkpoint.** A commit object built from the working tree through a
temporary index, *without touching the working tree or the host's index* —
plain `git stash` would disturb what the host is looking at, at the exact moment
they are deciding whether to trust this. Untracked files are in it, ignored ones
are not; until 2 October it was `git stash create`, which leaves untracked files
out. On the way out the agent says what changed since the checkpoint — not since
HEAD, which counted the host's own earlier edits — and how to undo it. Undoing
puts back every file the checkpoint holds; anything a guest newly created stays
put, because deleting unknown files on someone's behalf is not a favour.

**A credential scan.** See [security.md](security.md#the-credential-scan-is-a-warning-not-a-boundary).

Then the sandbox posture is printed, *then* the link. The order is asserted by
`smoke.mjs`: a host must know what a guest can reach before they have
something to send.

### The banner waits for the relay

The link is printed only once `RelayEvent::Connected` arrives. Printed any
earlier it advertises a link that is refused for the next few hundred
milliseconds — invisible over loopback, where the gap is about a millisecond,
and reliably wrong over a real network. A two-second deadline stops it waiting
forever: if the relay never answers the banner prints anyway, reading
`state.status.label()` rather than a hardcoded "open", so it says what is
true.

This is also why `banner()` renders from `ui::State` rather than taking the
same values a second time. It used to hardcode `open` *and* read
`state.sync` before that field was assigned, so the line that exists to say a
copy is being kept printed blank.

## Terminals

Per-terminal figures cover the shell's **whole process subtree**, not just the
shell — a guest running a build should show as a guest running a build.

The panel degrades to plain lines when stdout is not a terminal. Nobody wants
ANSI escapes in a log file, and the smoke tests depend on it.

Input is written by a thread per terminal, through a queue capped at 1 MB. A
pty takes only so much before the program on it reads — about a kilobyte on
macOS — and a write past that blocks; written from the agent's one loop, a
paste into a terminal running `sleep` or `tail -f` stopped every terminal,
every document, the panel and ctrl-c. Now only that terminal waits, as in any
terminal emulator. A ctrl-c, ctrl-\\ or ctrl-z drops whatever is still queued
ahead of it. What a program prints fast goes out in frames of up to 64 KB:
it is read 8 KB at a time, and each read used to be a frame, sealed, sent
and drawn by itself. A read-only session opens no terminals for guests: a shell nobody
may type into is a process for nothing.

**One shell is kept started that nobody has asked for yet** (since
20 November; `PtyRegistry::warm`). A shell takes a while to start — half a
second for a plain zsh, two for one with a framework in its start-up files —
and a guest who joined, or pressed New terminal, looked at an empty box for
that long. The next terminal opened is the one kept ready, at its prompt,
and another is started behind it.

| | |
|---|---|
| Not a terminal | Until it is opened it is in no list, counts against no limit and is sampled by nothing; what it prints waits in its ring, sent with the news of the terminal when it becomes one |
| Not for a narrower terminal | It starts at 80 columns, and what a shell prints as it starts is laid out for that width. A phone's terminal starts a shell of its own, as before |
| Not when the host has started a great deal since | Its process limit is what the host was running when it started, plus the allowance. If that has grown by more than half the allowance, it is dropped and the terminal starts one now |
| Not in a session that begins read-only | Nobody there may open a terminal |
| If it ends by itself | Nobody is told a terminal closed: nobody was told of one |

What a shell says as it dies, after its terminal was closed and everyone told
so, is no longer sent: bytes for a terminal nobody has. A page dropped them;
the suites' stand-in guest took them for the terminal back again
([testing.md](testing.md), "Checks that passed for the wrong reason").

The panel's figures are read when something may have changed, not every
second. Finding what a terminal is running means asking every process on the
machine for its parent; done each second, with each one's command line and
environment read as well, it was a fortieth of a core for as long as a
session stood open — most of what an idle agent did. Now the processes under
a terminal are looked up when it has been typed into or has printed since
the last look, when a terminal is new, and every ten seconds otherwise; in
between only those already known are asked what they are using, and with no
terminal open nothing is.

### A hazard worth knowing about

A shell that is still starting can swallow the first characters typed at it,
and that is not harmless: `printf x > f` arriving as `rintf x > f` still
performs the redirect, truncating the file before failing. Real terminals
behave the same way, but a guest has less context — they did not start this
shell and cannot see how long ago it began. The harness sends a sentinel and
requires it back before trusting a terminal.

## The file tree

Ignore rules are shared by the scanner and the watcher because they have to
agree: if the watcher let `node_modules` through, a dependency install would
flood every guest with churn the scanner never showed them.

| | |
|---|---|
| Always skipped | `.git`, `node_modules`, `target`, `dist`, `build`, `.venv`, `__pycache__` and the other build and cache directories in `ALWAYS_SKIP` (`workspace/filter.rs`) — generated by definition, `.gitignore` or not |
| Also skipped | Anything the project's `.gitignore` or `.ignore` files match — nested ones too, and those above the folder up to the repository's top — plus `.git/info/exclude` and git's global excludes. The scanner and the watcher apply the same rules |
| Shown | Dotfiles. A shared project usually wants its `.gitignore` visible |
| Never sent | Binary content — flagged, not shipped. Over 1 MB is truncated |
| Never read | Anything the two rows above leave out, asked for by path — refused as "not shared", read-only guests or not, through a symlink or not |
| Refused | Any path escaping the workspace, including through a symlink |

**A change that comes out of quiet is sent as soon as what came with it
has** — twelve milliseconds after its last event, fifty at most — not at the
next beat of a clock (`workspace/watch.rs`, since 20 November). One save is
several events, the file emptied and then written or one written beside it
and renamed over it, a moment apart; the wait is for those. Until then every
change waited for a tick four times a second: a file saved on the host
reached a guest's page a quarter of a second late at worst and an eighth on
average, before the network had carried it anywhere, and so did a file a
guest's own command made. Flushes are at least a tenth of a second apart, and
a quarter after one that carried more than 32 paths: a build still arrives as
a `patch` a few times a second. Past ~500 touched paths in
one flush the host sends a fresh `tree` instead — rebuilding is cheaper than
shipping fifty thousand entries, and far cheaper than a client that falls
behind forever. There is no separate "resync" message: a `tree` already means
*replace everything you know*.

Rebuilds are rate-limited to one a second and **deferred rather than
dropped**. A dropped one would leave the tree permanently stale once a burst
ended and no further events arrived.

A folder that arrives whole — renamed, moved in, unpacked — is walked by the
same rules as a full scan and sent with everything in it, up to the
20,000-entry limit. The watcher reports the folder, not its contents, so it
used to appear empty for good. A folder that goes takes everything listed
under it; those entries used to stay in the tree, and in the file count, under
a name that no longer existed.

## Editing

Only open files get a CRDT. Twenty thousand documents for a repository nobody
is reading would be absurd; the interesting state is whatever somebody has on
screen. The agent holds the canonical document, guests sync to it, and updates
are forwarded verbatim — Yjs updates are idempotent and commutative, so the
host never interprets one to relay it.

The hard part is that the disk is not the document's private property:

| Event | What happens |
|---|---|
| Someone types | Update reaches the host, is applied, fans out. Written back once typing stops for a quarter of a second, or after two seconds of typing that does not stop — at that moment, the loop woken for it, not at the next tick of four a second (20 November: it was 400 ms and then up to 250 more, and steady typing was never written) |
| Someone presses Enter in a terminal | Every open document that has not been written is, first: what the command reads is what the page shows. Someone who edits a file and runs it at once used to run what was there before |
| A terminal rewrites the file | The watcher reports it, and the change is merged into the document as an edit of its own: typing not yet written survives it, cursors too |
| Our own write comes back | Ignored — compared against *what we last wrote*, not what the document says now |
| A binary or oversized file | Refused with a reason; falls back to read-only rather than being corrupted |
| Not UTF-8, a byte-order mark, mixed or bare-CR line endings | Refused with a reason, read-only instead. The browser's editor would change bytes nobody typed |
| The open file is deleted, moved, stops being shared, turns binary, outgrows 1 MB or stops being text the editor keeps byte for byte | The document closes for everyone who has it (`Doc::Closed`), with the reason; the page keeps the text on screen, read-only, to copy. Checked when the watcher reports the file and before every write, and said once in the log — it used to stay open, and every keystroke went nowhere while the log said so four times a second |
| A write fails — a full disk, say | The document stays open and the write is tried again on the next tick; said once, not on every try |

The third row is subtler than it looks. The watcher reports a write only after
it lands, by which time the next keystroke has usually arrived — so comparing
the document to the file would treat your own typing as an external change and
silently undo it.

External changes are folded in with a prefix/suffix diff rather than a
wholesale replacement. Replacing the text would delete and reinsert every
character, throwing away every cursor in the session; keeping the common ends
means a formatter touching one line disturbs one line.

The diff is taken against **what was last written**, not against the
document, and made on a second replica held at that write — the *shadow* —
then merged in like any guest's edit. Until 7 October it was a diff from the
document to the disk, which made the two equal: whatever had been typed in the
400 ms before the next write was deleted, for everyone, and a log being
appended to while someone had it open lost every keystroke between appends.
Now the disk's change and the typing are concurrent edits, and both stay; the
merged text is written back once things go quiet. If the shadow has lost track
of the disk — a write that failed halfway — the old rule applies and the disk
wins.

The Monaco binding is written here rather than taken from `y-monaco`, which
has not been published since 2024 and predates this Monaco by several major
versions.

## Downloads

A guest can download the open file, a folder, or the whole workspace. A file
comes as itself; a folder as a zip named after it, which unzips to that one
folder. What goes in is the tree's own list, each file read through the same
rule as any guest read, so nothing the ignore rules hide is in it.

| | |
|---|---|
| Built | Off the agent's loop, so reading a large folder freezes no terminal |
| Format | Stored, not compressed — written by hand in `archive.rs`; deflating costs the host's CPU, which is busy with other things |
| Limits | 100 MB and 20,000 files; past either it is refused with the reason |
| Sent | In 128 KB pieces, never more than 1 MB ahead of what the guest has acknowledged. The relay closes a guest whose queue passes 8 MB, and a download sent all at once to a slow connection did that |
| One at a time | Per guest: asking again replaces the last, whether it is being sent or still being read |
| Read-only | Allowed — it is reading |
| Leaving | A guest who goes takes their downloads with them |

## What a guest's page asks to be done

Since 0.0.9 the agent does to the folder what a guest's page asks: makes a
file or a folder, renames or moves one, removes one, writes an upload,
searches every file's text, replaces what was found, and sends a file's bytes
to look at ([protocol.md](protocol.md), "What a guest asks the host to do to
the folder"). `fileops.rs` is each of them against the folder; `main.rs`
(`on_file_op`) is what the host allows, and what it says.

| | |
|---|---|
| Where | The folder, opened as a `cap-std` directory: every path is resolved beneath it, a component at a time. See [security.md](security.md), "What a guest's page can change" |
| What | Only what the tree shows: a path the ignore rules hide is refused, and so is one that goes through a link |
| Read-only | Refuses every one that changes anything, and an upload part-way through. Searching and looking are reading, and carry on |
| Said | Each is a line in the activity pane: who made, moved, deleted, uploaded, replaced in or looked at what |
| The tree | Told at once — the changed paths go through the same door as the watcher's — so a file made from the page is in the page's tree as the answer arrives |
| Open documents | What is typed and not yet on disk is written before a rename or a replace touches the file; after a replace the document takes the change as it takes any change on disk; after a rename it is closed under its old name and every page told where the file went |
| Uploads | Held in memory until whole — 50 MB at most, one at a time from each guest — then written beside the file under a name of their own and renamed over it |
| Search and replace | Off the agent's loop, like a download: a large folder freezes no terminal. A search overtaken by the same guest's next is dropped when it comes back |
| A file to look at | 5 MB at most, sent in one go |

It says so in the roster (`can`), which is how a page knows to offer any of
it. The panel has no switch for it beyond read-only: a guest's shell could
always do all of this.

## The copy kept for when you drop

Losing wifi used to make the folder go dead for everyone reading it. The agent
keeps a sealed copy on the relay and a guest falls back to it when the host
goes away.

| | |
|---|---|
| What is stored | Source files only — the same ignore rules, nothing binary or oversized |
| Who can read it | Anyone with the link, because it is sealed with the session key. **Not the relay** |
| When it is used | Only while the host is away, and only read-only |
| When it is offered | After the folder has been still for five seconds, and again after a relay restart, which loses it |
| Sent | A piece at a time since 0.0.10, each acknowledged by the relay, never more than 128 KB ahead: sent whole it held every key's echo and every edit behind it for as long as the uplink took — see [protocol.md](protocol.md), "The folder's copy, to the relay". A copy part way there when the connection drops is made and offered again |
| Made | Off the agent's loop since 20 November: every text file read, written out as one and sealed. Made on the loop, it stopped every terminal and every edit for as long as it took — 0.45 s for five thousand small files, five seconds after each change |
| Limits | 25 MB and 5,000 files. Over either, sync switches off and says so |
| Lifetime | It dies with the session |

The read-only part is the invariant, not a limitation: **the host is
authoritative whenever it is online**, so a store nobody can write to can never
disagree with it. That is why this design has no merge problem to solve.

Refusing loudly matters: a store that quietly kept the first 25 MB would hand
guests a workspace silently missing files, which is worse than no copy at all.

Still deferred: surviving a relay restart needs stable identity — a device key
the content key can be wrapped to. The whole snapshot is re-sent rather than
diffed, which is fine at 25 MB.

## The host's controls

A key that is drawn but does nothing is worse than one not drawn at all, so
each is enforced where it cannot be argued with:

| Control | Enforced by | Why there |
|---|---|---|
| kick | the relay | it owns the socket; the guest's resume secret goes too, so a locked session does not take them back |
| lock | the relay | it is the only thing that sees a connection *before* the host does |
| read-only | the agent | a client that ignores the flag still gets its keystrokes and its edits to open files dropped, and is refused a new terminal; only cursors pass |

Locking seals the room without evicting anyone already in it, and everyone is
told it happened. Someone already in whose connection drops, or who reloads,
is let back in — see [security.md](security.md#locking-and-who-it-lets-back-in).

## The panel

Rows go to what matters most first: the link and the keys, then the warnings,
then the status lines, then who is here, and the activity log gets what is
left. A terminal too short for everything loses the log before it loses a
character of the link.

The link wraps rather than being cut. At 80 columns, Terminal.app's default,
it used to lose the end of its key, and a guest given that link got a page
that never worked and never said why. `c` puts it on the clipboard through
OSC 52 where the terminal allows that; Terminal.app does not.

Every warning is shown, in a box as tall as they need. It used to be two lines
whatever it held, so the credentials warning, third in the list, was never
seen. The copy kept on the relay has its own line, and `d` turns it off or on.
While a kick is being typed the number comes first on the line, because the
end is what 80 columns cut.

A guest who has not introduced themselves five seconds after joining is shown
as "someone with an incomplete link": their page cannot read the session,
which is nearly always a link cut short. A terminal keeps its opener's name
after they leave, as "dana (left)" — it used to say "you", though the host
opens no terminals here.

## Staying connected

The agent redials after 250 ms, 500 ms, then a second at a time for half a
minute, and only then doubling to 8 s (`backoff`, `client.rs`) — and starts
again from 250 ms each time the relay lets it in. Until 20 November it
doubled from the start, so a connection back after ten seconds was not tried
again for up to six more. A guest's page keeps the same beat
(`retryDelay`, `connection.ts`). The agent's socket has Nagle's algorithm
off: what it sends is small and wanted now. It pings every 15 s and gives up
on a connection silent for 45 s, since a socket can die with neither end told;
the next hello carries the host key, which takes its place back from its own
stale socket. `host_taken`, `rate_limited` and `unavailable` — a relay that
cannot check its accounts just now, which refuses rather than guesses — are
waited out, at least two seconds; any other refusal ends the session.
`unavailable` is waited out since 18 October, in v0.0.9: v0.0.8 and older
end the session on it. See
[protocol.md](protocol.md#what-survives-what).

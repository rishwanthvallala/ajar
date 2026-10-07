# The wire protocol

Every message is one binary WebSocket frame.

```
byte  0      channel    u8   CONTROL | PTY | FS | PRESENCE | DOC | STORE
bytes 1..5   stream_id  u32  LE   pty or document id, or 0 for channel JSON
bytes 5..9   target     u32  LE   destination, or the authenticated sender
bytes 9..    payload    opaque to the relay
```

**The relay reads the header and nothing else.** This is the invariant the
whole design rests on. It was there from the first commit, and the payoff
arrived later: adding end-to-end encryption required no relay changes at all.

Two exceptions, both readable by design. The relay reads the `Store`
channel's envelope, to count an offered copy's bytes against a limit before
accepting it — the copy itself is sealed. And from a viewer in an account
pad's room it reads the first byte of a `Doc` payload, which a pad leaves
unsealed, to forward only a request for a document's state.

Keep it. Anything that makes the relay parse a payload — a "smarter" routing
rule, a server-side feature, a metric that needs to know what a frame contains
— trades this away, and it does not come back.

## Channels

| Channel | Carries | Sealed |
|---|---|---|
| `Control` 0x01 | Handshake, join/leave, lock, close, errors | No — the relay routes on it |
| `Pty` 0x02 | Terminal input and output | Yes |
| `Fs` 0x03 | The file tree, file contents, reads | Yes |
| `Presence` 0x04 | Names, who is watching which terminal | Yes |
| `Doc` 0x05 | Yjs document updates and awareness | Yes |
| `Store` 0x06 | The sealed offline copy | The copy, not its envelope |

The control channel is readable by design. The relay has to know who is
joining what, and pretending otherwise would mean the relay could not route.
In a hosted session everything with content in it is sealed; a pad's peer
frames are not, since a pad has no key — the server holds its files anyway.

## Routing

Hosted sessions are four cells and stay four cells:

| From | `target = 0` | `target = N` |
|---|---|---|
| guest | → host only | rejected |
| host | → every guest | → that participant |

Peer sessions are one rule: a peer must stamp its own participant id on every
frame, and the relay broadcasts to everyone else. A frame that is not stamped
with the sender's own id is dropped — a peer cannot address anyone, so a
target that is not itself is either a bug or an attempt. A peer's control
frames are dropped too, and a viewer of a pad that belongs to an account may
send only a request for a document's state, or say it has none.

## Session shapes

`Shape::Hosted` and `Shape::Peer` are fixed when the session is created and
never change. Hosted sessions start numbering participants at 2 because 1 is
the host; peer sessions start at 1 because there is no host.

A join whose role does not match the session's shape is refused with
`wrong_shape`. This is enforced in both directions and tested against the
deployed relay, not just locally. A host or guest naming a pad that belongs
to an account is refused with `wrong_shape` too, before any session exists.

A host's `hello` carries `host_key`, a secret the agent made at startup: the
relay keeps its hash from the hello that opened the session and lets only that
key back into the host's place after a dropped socket (`not_the_host`
otherwise). Guests and older agents leave it off. See
[security.md](security.md#the-hosts-place-belongs-to-the-agent-that-opened-the-session).

A guest's `hello` may carry `resume`, a secret its page makes and keeps for
the tab. The relay remembers who it has let in by its hash, so a locked
session takes them back after a blip; a kick forgets it. The guest also puts
it in its sealed `iam`, and the agent sends the hashes of everyone it has met,
less anyone kicked, as `admitted` in every hello — so a restarted relay, which
knows nobody, still knows whom the lock is not for. Both are left off the wire
when empty.

A peer's `hello` may carry `code`, the part of a pad link after the `#`, left
off the wire when there is none. The relay refuses a peer with `private` when
the pad's settings and that code give it nothing, and with `gone` when the
pad was deleted.

## What survives what

| Event | What happens |
|---|---|
| Guest's socket drops | Reconnects with backoff, reset only by a `welcome`; the host re-announces every terminal and replays its ring buffer, and the page closes any tab it did not name. The open file is reopened and what was typed meanwhile replayed onto it, the view where it was |
| Guest's page goes into the back/forward cache | Kept as it is. Coming back, it opens a fresh socket at once — the one it had died while it was frozen |
| Host's socket drops | Session held 45s. Terminals keep running — the agent process never noticed. Guests see "host away" |
| Host returns in the grace | `host_back`. The agent reconciles its guest list with the relay's, then resends the tree, every terminal and its replay, every open document's state and the roster. Each guest resends its name and its document's state |
| A guest arrives while the host is away | The relay sends them `host_away` with the time left, after `welcome` |
| Host's socket is dead but nobody was told | Both ends ping: the agent every 15 s, dropping a connection silent for 45 s; the relay every 20 s, treating 60 s of silence as the socket gone. The agent's next hello carries the session's key, and the relay lets it replace its own stale socket rather than refusing it as `host_taken`. That socket's end, when it comes, is not the host leaving |
| Host never returns | The relay reaps the session and tells guests why |
| Host presses ctrl-c | `Control::Close` — immediate, no grace |
| Relay process dies | The agent dials back in and re-opens the same session id. Guests who get back first are refused `no_such_session`; a page that has been in the session waits that out, and `rate_limited`, rather than giving up |
| The agent is refused `host_taken` or `rate_limited` | It waits and tries again: both are about the moment. Every other refusal ends it. A host coming back to a session the relay still has is metered as joining, not as starting a session |
| Who may open a pad changes | Everyone in its room but its owners gets `Closed`, rejoins, and is let in on what they hold now; deleting the pad closes everyone. Signing out closes the room connections that sign-in made owner |

Frames the agent tries to send while disconnected are **dropped, not queued**.
The ring buffers already hold the terminal output a guest needs, and queueing
here would replay it twice.

That is only safe because everything else is *resent whole* afterwards, and
until September 2026 it was not. A host blip inside the grace period lost, for
good: patches for files made during it, document updates from the disk
changing, the introduction of anyone who joined, the departure of anyone who
left — and, worst, whatever a guest typed, which went to a host that was not
connected. Every later keystroke from that guest depended on the lost ones, so
Yjs parked them as pending on the host and the file never changed again while
the editor showed the text as typed. `smoke-hostdrop.mjs` cuts only the host's
socket, through a proxy, and checks each of those; `check-host-drop.mjs` does
the typing part in the real browser client.

None of the resends is incremental, and none needs to be: a tree already means
*replace everything*, and a Yjs state is idempotent to apply.

## Downloads

`Fs::Download { path }` asks for a file, a folder, or with `""` everything.
The host answers `Archive { id, path, name, bytes, files }` and sends the
bytes as stream frames on the Fs channel with `id` as their stream, sealed
like everything else on it. The guest acknowledges with
`Received { id, received }` and the host keeps no more than a megabyte
unacknowledged in flight — the relay's queue for a slow guest would otherwise
fill and the guest be cut off. `DownloadError { path, message }` says why
not. An agent from before downloads ignores the request; the page says so
after twenty seconds without an answer.

## Versions, because the agent is not ours to deploy

`PROTOCOL_VERSION` in `ajar-proto` is what a build speaks on the content
channels. It is bumped when a change makes an older peer's frames unreadable —
version 1 is the direction byte in the sealed frame's authenticated data.

This exists because of how the failure looks without it. Both ends drop what
they cannot decrypt, and neither says anything: the agent logs at `debug!`, the
browser has no branch for it at all. A guest joining an agent from the wrong
side of that change gets a session that connects, draws a terminal, and
silently discards every frame in both directions. It reads as the product being
broken.

The web client we deploy; **the agent lives on other people's machines** until
they choose to reinstall, so old ones are permanently in the field. That makes
this a normal condition rather than a migration window.

The host sends `protocol` in its `Hello` on every handshake — every reconnect,
for the same reason the lock bit is re-sent: after a relay restart the stored
value has to come from the agent connected now. The relay keeps it on the
session and returns it to each guest as `host_protocol` in `Welcome`. Both are
on the **cleartext control channel**, so the notice survives exactly the
mismatch it reports.

Absent and zero mean different things, and the client distinguishes them:

| `host_protocol` | means | the guest |
|---|---|---|
| missing | a relay from before this field — it cannot tell | joins normally |
| `0` | a current relay reporting an agent from before versioning | is told to ask the host to update, with the command |
| anything else ≠ ours | a genuine mismatch either way | is told which side is behind |

Treating a missing field as "old" would refuse working sessions whenever the
relay lagged a deploy, which is why it is not.

## Refusals have to arrive

`send_error` used to queue a frame on the writer task and then call
`writer.abort()`, killing the task before it could flush. Every refusal —
wrong session, host already taken, session locked — reached the client as a
connection that simply timed out.

The fix is to drop the sender and *await* the writer rather than aborting it,
so the channel drains first. A test joins a session that does not exist and
requires an explanation rather than silence.

This is worth remembering as a shape of bug, not just an incident: a queued
message and an immediate shutdown are a race, and the shutdown usually wins.

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
| `Store` 0x06 | The sealed offline copy | Yes |

The control channel is readable by design. The relay has to know who is
joining what, and pretending otherwise would mean the relay could not route.
Everything with content in it is sealed.

## Routing

Hosted sessions are four cells and stay four cells:

| From | `target = 0` | `target = N` |
|---|---|---|
| guest | → host only | rejected |
| host | → every guest | → that participant |

Peer sessions are one rule: a peer must stamp its own participant id on every
frame, and the relay broadcasts to everyone else. A frame that is not stamped
with the sender's own id is dropped — a peer cannot address anyone, so a
target that is not itself is either a bug or an attempt.

## Session shapes

`Shape::Hosted` and `Shape::Peer` are fixed when the session is created and
never change. Hosted sessions start numbering participants at 2 because 1 is
the host; peer sessions start at 1 because there is no host.

A join whose role does not match the session's shape is refused with
`wrong_shape`. This is enforced in both directions and tested against the
deployed relay, not just locally.

## What survives what

| Event | What happens |
|---|---|
| Guest's socket drops | Reconnects with backoff; the host re-announces every terminal and replays its ring buffer |
| Host's socket drops | Session held 45s. Terminals keep running — the agent process never noticed. Guests see "host away" |
| Host returns in the grace | `host_back`, terminals re-announced and replayed |
| Host never returns | The relay reaps the session and tells guests why |
| Host presses ctrl-c | `Control::Close` — immediate, no grace |
| Relay process dies | The agent dials back in and re-opens the same session id |

Frames the agent tries to send while disconnected are **dropped, not queued**.
The ring buffers already hold the terminal output a guest needs, and queueing
here would replay it twice.

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

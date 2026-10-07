# Architecture

Two products, one relay, and almost nothing else in common.

## The conservation law

**The relay is dumb because the agent is smart.** Take the agent away and the
server has to become smart — that is a conservation law, not a design choice,
and it is the single most useful idea for understanding why these two products
are shaped so differently.

`ajar` puts a process on the host's machine. It owns the folder, the
terminals, the documents and the key. The relay is left with nothing to do but
forward bytes it cannot read: for a hosted session it keeps nothing on disk
and sees no plaintext, and a restart that drops every session is *correct*
rather than merely tolerable.

The pad has no agent. Nobody lends a machine, so the compute moved into each
visitor's tab — and everything the agent used to own had to go somewhere. The
files went to the server, which means the relay grew durable state — the pad
store, and since 4 October the accounts database that says who owns which
pad — plus an origin, cross-origin isolation headers, and 66.5 MB of mirrored
WebAssembly (15.1 MB compressed) for the web server in front of it to serve.

That is the trade, stated plainly: the pad is easier to use and the server
does more work and can read your files.

## ajar: sharing a machine

```
  host machine                    relay                    guest browser
  ┌──────────────┐                                         ┌────────────┐
  │ agent        │  sealed frames  ┌──────────┐  sealed    │ web client │
  │  pty ×N      │ ───────────────▶│  routes  │───────────▶│  xterm     │
  │  file tree   │ ◀─────────────── │ 9 bytes │◀───────────│  Monaco    │
  │  documents   │                 └──────────┘            │  tree      │
  │  the key     │                                         └────────────┘
  └──────────────┘
```

The agent holds every authority. It made the key, and only it and whoever
holds the link can decrypt — never the relay. It is the only one that knows
anyone's name, the only one that can write to the folder,
and the only one that decides what a guest is allowed to do. The relay routes
on nine bytes of header and forwards the rest untouched.

That constraint was there from the first commit and it paid: **turning on
end-to-end encryption required zero changes to the relay.** It holds no
session key and has no code that opens a frame. The cryptography it does
carry is hashing: since 4 October, for accounts — sealed link codes and hashed
session tokens; since 7 October, the SHA-256 of the host's key, to know which
agent opened a session, and of each guest's resume secret, to know whom a
locked session already let in.

## pad: sharing a folder

```
  browser A                       relay                    browser B
  ┌──────────────┐                                         ┌────────────┐
  │ WASIX runtime│   file writes  ┌──────────┐             │ WASIX      │
  │  bash python │ ──────────────▶│  store   │◀────────────│ runtime    │
  │  Monaco      │   Yjs updates  │  + peer  │   Yjs       │ Monaco     │
  │              │ ◀─────────────▶│ broadcast│◀───────────▶│            │
  └──────────────┘                └──────────┘             └────────────┘
```

Each browser runs its own copy of bash, python and coreutils compiled to
WebAssembly. Nothing executes on the server. The server keeps the files, and
the relay carries two kinds of change between browsers — see
[the two layers](#how-a-change-travels) below.

## Why the relay has two shapes

One relay serves both, and the routing differs because the topologies do.

| | Hosted (`ajar`) | Peer (`pad`) |
|---|---|---|
| Centre | The agent | None |
| A guest may reach | The host only | Everyone |
| A guest's `target` is | its own id, checked; the frame goes to the host | its own id, checked; the frame goes to everyone else |
| Session created by | The agent connecting | The first browser to open the name |
| Restart | Agent re-opens the same id, and its hello restores the lock, the protocol version and whom the lock lets back in | Files survive; the room does not |

**One session id is one shape for its whole life.** A peer walking into a
hosted session would receive broadcast frames from an agent that believes it
is talking to a guest, so the relay refuses the mismatch with `wrong_shape` —
in both directions.

In a hosted session, guests never address each other. Anything a guest needs
from another guest — presence, who is here — goes through the host, which is
the authority on session state. Every guest and peer stamps its own
participant id on what it sends, and the relay checks it: a guest's frame goes
to the host, a peer's to everyone else. A pad that belongs to an account is the exception: the relay
asks the accounts database who may come in and as what, and drops everything
a viewer sends except asking for a document's state, or saying it has none.

## Three origins, and why none of them can merge

| | |
|---|---|
| `ajar.rishwanth.dev` | The relay and the session client |
| `code.rishwanth.dev` | The pad, its dashboard and sign-in |
| `preview.rishwanth.dev` | What somebody is running in their folder |

The pad cannot be a path under the session client: WASIX threads need
`SharedArrayBuffer`, which needs cross-origin isolation, which is a property of
a whole document — put it on the session client's origin and everything that
client loads has to opt in or vanish silently.

The preview cannot be a path under the pad: what it serves is **somebody
else's code**, and from the pad's origin it could script the page, read its
storage and reach its service worker. The SDK refuses to route anywhere but a
separate origin, which is the right refusal.

Both separations are forced by the platform rather than chosen, and both are
load-bearing. See [operations.md](operations.md#the-three-origins).

Two paths on the pad's origin are not the pad. `/wisp` is the egress endpoint
and `/dns-query` forwards DNS, both proxied by Caddy to processes on loopback.
(`/api` and `/auth` go to the relay — the store and signing in — and
`/privacy` is a static page; those are the pad's own.)
They live on this origin rather than a fourth one for the same reason the
preview cannot: the page's own `connect-src 'self'` has to reach them, and
widening that policy to admit somebody else's host is the thing being avoided.
Neither serves the pad's content and neither can be reached by what a visitor
runs — the sandbox talks to them through the SDK, not through the folder.

## How a change travels

Both products separate *text in an open file* from *everything else*, and the
split matters.

**Text in an open file** is a CRDT. Yjs updates are idempotent and
commutative, so they are forwarded verbatim and never interpreted in transit.
Two people can type in one file at once.

**Everything else** — a file a script wrote, a file somebody added — goes
through the authority. In ajar that is the agent, which watches the folder and
sends patches. In the pad there is no agent, so a peer broadcasts only that
something *moved* and everyone re-reads from the store.

A disk change to a file someone has open crosses over: the agent turns it into
an edit of its own, made against what it last wrote, so typing and the disk's
change both stay — see [agent.md](agent.md#editing).

Shipping file contents over the peer channel would make the broadcast and the
store two copies of one truth, and a frame dropped or arriving mid-reconnect
would leave a browser confidently out of step with no way to notice.

## Where the code lives

| | |
|---|---|
| `crates/ajar-proto` | Frame codec, channels, roles, sealing. Shared by agent and relay |
| `crates/ajar` | The agent. Terminals, workspace scanning, documents, downloads, the checkpoint and credential scan, sandbox, panel |
| `crates/ajar-relay` | Routing, session lifecycle, rate limits, backpressure, the pad store, accounts and sign-in, the operator's view |
| `web/src` | The session client |
| `pad/src` | The browser tier, including the WASIX runtime and the shell |
| `packages/workspace-ui` | `WorkspaceShell` and the theme both products' layouts are built from |

**One shared package, and it is a narrow one.** `@ajar/workspace-ui` exports a
`WorkspaceShell` — the panel arrangement, the resizing, the drawer, the theme
tokens — plus the theme switch, the one `languageFor`, and CSV/TSV
highlighting. Both `web/src/workspace.ts` and `pad/src/workspace.ts` build on
it: `web/src/workspace.ts` went from 262 lines to 84 (88 now), and the pad's
equivalent is 159 where it previously had none of its own.

It is worth being precise about how this differs from the shared package that
was tried and reverted, because the earlier attempt is still on record in
[history/unified-ui-plan.md](../history/unified-ui-plan.md): that one was React,
and it took the pad's entry chunk from 18 KB to 235 KB to render a placeholder
into a hidden div. This one is plain TypeScript and shares layout, not
rendering. The pad's entry stayed small — the two applications still ship
separate editor, terminal, shell, sync and runtime chunks, and neither pulls in
the other's.

`web/src/editing.ts` and `pad/src/editing.ts` remain deliberate near-duplicates:
the pad's was lifted from ajar's and they have diverged only where the products
differ. Sharing the *shell* did not mean sharing those, and the reasons in the
history document still hold.

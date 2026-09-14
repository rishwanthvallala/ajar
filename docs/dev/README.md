# Working on ajar

These documents explain *why*, not *what*. The code says what it does and is
commented where the reason is local; these cover the reasons that span files,
the decisions that look arbitrary until you know what was tried, and the
mistakes worth not repeating.

Read [architecture](architecture.md) first. After that, follow whatever you
are touching.

| | |
|---|---|
| [architecture.md](architecture.md) | The two products, the one relay, and why the split is shaped this way |
| [protocol.md](protocol.md) | The wire format, routing, and session shapes |
| [security.md](security.md) | The sandbox, end-to-end encryption, resource limits, rate limits |
| [agent.md](agent.md) | The agent: terminals, the file tree, editing, the offline copy |
| [relay.md](relay.md) | The relay: sessions, backpressure, the durable pad store |
| [pad.md](pad.md) | The browser tier: WASIX, the shell, what this runtime does that nothing documents |
| [testing.md](testing.md) | The gate, what each suite actually proves, and how checks lie |
| [operations.md](operations.md) | Deploying, reaching the server, cutting a release |
| [networking.md](networking.md) | Whether the pad can have a network. Measured, not built |
| [../open-points.md](../open-points.md) | What is unfinished, and what is deliberately absent |
| [../history/](../history/) | Design records. Superseded, kept because the reasoning is still useful |

## The one thing to read if you read nothing else

**Checks in this project have a habit of passing for the wrong reason.** At
least nine have, and the pattern is always the same: the thing under test
could produce the passing evidence by accident.

A sandbox fixture wrote to a deliberately-writable directory. An encryption
wiretap searched a masked stream. A fork-bomb test read an exit status from a
shell that exits 0 on failure. A peer check watched for a file the browser had
already made itself. A reconnect test built a fresh client where the browser
reuses one. A network log attributed mirrored downloads to the CDN they were
mirroring. A CSS-injection check counted stylesheet rules, which cannot see
the escape it was testing for.

The habit that catches them: **revert the fix, watch the check fail, restore
it.** If it passes either way it proves nothing, and a check that proves
nothing is worse than no check — it stops anyone looking again.

## Conventions

Comments explain why, not what. If a line needs a comment to say what it does,
the line is usually the problem.

A claim in an interface must be true. The panel saying "512 processes" while
the cap silently failed to apply shipped in v0.0.1, and the lesson is written
into [security.md](security.md): say what is actually enforced, or say plainly
that nothing is.

Commit messages say why the change exists and what it cost to find. They are
the only place some of this survives.

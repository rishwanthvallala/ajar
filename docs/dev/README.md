# Working on ajar

These documents explain *why*, not *what*. The code says what it does and is
commented where the reason is local; these cover the reasons that span files,
the decisions that look arbitrary until you know what was tried, and the
mistakes worth not repeating.

Read [architecture](architecture.md) first. After that, follow whatever you
are touching.

An agent, or anyone new to running it: [AGENTS.md](../../AGENTS.md) has the
facts — the server and how to reach it, deploying, CI, the suites, the
settings and the conventions — in one place.

| | |
|---|---|
| [architecture.md](architecture.md) | The two products, the one relay, and why the split is shaped this way |
| [protocol.md](protocol.md) | The wire format, routing, and session shapes |
| [security.md](security.md) | The sandbox, end-to-end encryption, resource limits, rate limits |
| [agent.md](agent.md) | The agent: terminals, the file tree, editing, the offline copy |
| [relay.md](relay.md) | The relay: sessions, backpressure, the durable pad store, accounts |
| [pad-store.md](pad-store.md) | How the relay keeps pads on disk since 11 October: rows in SQLite, contents by hash, saves that send only what changed, history, the last run |
| [durability.md](durability.md) | What the server holds, what can lose it, and the ways to keep copies of it, for free — a proposal, not yet built |
| [pad.md](pad.md) | The browser tier: WASIX, the shell, what this runtime does that nothing documents |
| [accounts.md](accounts.md) | Accounts and pad links, as designed and as built: three-word names, view and edit links, roles, the dashboard, Google and GitHub sign-in, deleting an account, the operator's view and the usage counts it shows |
| [networking.md](networking.md) | How the sandbox reaches PyPI and nothing else, the preview, and the measurements behind both |
| [workspace-ui.md](workspace-ui.md) | The shell both clients share — layout, theme, languages and landmarks — the bundle measurements behind it, and what each product keeps for itself |
| [testing.md](testing.md) | The gate, what each suite actually proves, and how checks lie |
| [scaling.md](scaling.md) | Where it breaks first as people, pads and rooms grow, on the one server — ranked, measured where it could be, with the load test and what was fixed on 30 October |
| [operations.md](operations.md) | Deploying, signing in and its secrets, reaching the server, setting up a new machine, the AWS account, cutting a release |
| [../open-points.md](../open-points.md) | What is unfinished, and what is deliberately absent |
| [../code-review-2026-09-16.md](../code-review-2026-09-16.md) | A review of the whole tree on 16 September, refreshed on 28 September to the 21 findings then open, and [what was done about the first 22](../code-review-fixes-2026-09-16.md) |
| [../ajar-review-2026-10-07.md](../ajar-review-2026-10-07.md) | Four reviews of ajar on 7 October — security, parity with the pad, the guest's page, end-to-end flows — and what was done about each finding, with the check that holds it |
| [../audit-2026-10-17/](../audit-2026-10-17/README.md) | An audit of the pad on 17 October — data and collaboration, the backend, the runtime, the live site — with its evidence, and [where each finding stands](../audit-2026-10-17/STATUS.md) |
| [../history/](../history/) | Design records. Superseded, kept because the reasoning is still useful |

## The one thing to read if you read nothing else

**Checks in this project have a habit of passing for the wrong reason.**
Thirty-one have — [testing.md](testing.md#checks-that-passed-for-the-wrong-reason)
keeps the list — and the pattern is always the same: the thing under test
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

Run `cargo fmt --all` before committing; the gate refuses unformatted code, and
finding out at the end of a ten-minute run is the expensive way.

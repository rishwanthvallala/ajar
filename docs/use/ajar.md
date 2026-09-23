# Sharing a machine

You have something on your machine that is hard to show: a bug that only
happens here, a toolchain nobody else has set up, a half-finished thing you
want a second pair of hands on. `ajar` turns the folder you are standing in
into a live workspace and gives you a link. Whoever opens it gets a real
terminal on your machine, in that folder.

Nothing to install on their side. No account, no port forwarding.

## Start

From the folder you want to share:

```sh
curl -sSf https://ajar.rishwanth.dev/run.sh | sh
```

That installs `ajar` if it is missing, reuses it if not, and prints a link.
Send the link. That is the whole thing.

To install once and use the command directly:

```sh
curl -sSf https://ajar.rishwanth.dev/install.sh | sh
ajar                      # shares the current folder
ajar ~/some/project       # shares that one
```

**To update, run the install command again.** `run.sh` reuses whatever `ajar`
it finds, so it will never move you off an old one — that is deliberate, since
it is also what makes starting a session fast. `install.sh` always fetches the
current release and replaces what is there.

This matters more than it sounds. A guest opening your link needs a version
that can talk to theirs, and if yours is too old they are told so and given
this command. Nothing breaks silently, but nothing updates on its own
either.

One static binary, nothing to configure. On Windows use WSL2 and keep the
project inside the WSL filesystem.

## Read this before you send the link

**A guest gets a real shell on your real machine.** They have your toolchain,
your network, and whatever the shared folder can reach.

`ajar` confines them: they cannot write outside the shared folder, and they
cannot read your ssh keys, cloud credentials or browser profiles. That stops
the ordinary accident — a stray `rm -rf`, an idle look through `~/.ssh`.

It is **not** a virtual machine. It does not make a determined person
harmless. Share with people you have some reason to trust.

Before it prints the link, `ajar` tells you exactly what is and is not covered
on your machine, warns about credential files sitting in the folder, and saves
a checkpoint you can roll back to.

## While it is open

The terminal you started it in becomes a live panel: who is connected, what
they are running, and what it costs.

```
● open  api  /Users/you/projects/api
  412 files shared

  https://ajar.rishwanth.dev/j/quiet-ember-4417   ← send this

┌ here ──────────────────┐┌ running on your machine ─────────────────┐
│ 2  priya  3m · 2 term  ││ 1  priya   7% cpu   184M · 3 proc        │
└────────────────────────┘└──────────────────────────────────────────┘
 [k] kick   [x] lock   [l] read-only   [d] stop copy   [q] close
```

| Key | What it does |
|---|---|
| `k` | Disconnect a guest |
| `x` | Lock the session — nobody new can join, people already in stay |
| `l` | Read-only — guests can look, not type |
| `d` | Stop keeping the offline copy, and forget the one already stored |
| `q` | Close — ends every terminal and kills the link |

Useful flags: `--read-only` to start that way, `--no-network` to cut the
guest's network off, `--no-sync` to keep no copy.

## What guests can do

Open terminals, browse the file tree, open files, and edit them. Two people
can type in the same file at once, and edits survive a terminal rewriting the
file underneath them.

If your laptop sleeps or your wifi drops, guests keep a read-only view of the
files rather than losing the session. When you come back, everything resumes —
the terminals never stopped running.

## When you close it

`ajar` tells you what changed while the session was open and how to undo it:

```
  2 files changed: src/main.rs, guest-file.txt
  to undo everything from before the session:
      git restore --source=a98a3195 --worktree -- .
```

It restores tracked files only. Anything a guest created is left where it is —
deleting unknown files on your behalf is not a favour.

## Running your own relay

The link points at `ajar.rishwanth.dev` by default. That relay routes
encrypted frames and cannot read them, but you can run your own:

```sh
ajar --relay https://relay.example.com
```

See [operations](../dev/operations.md) for deploying one.

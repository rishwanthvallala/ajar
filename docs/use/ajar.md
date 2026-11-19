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

Run it in the project, not in a new terminal's home folder: `ajar` will not
share your whole home, and says so. A machine with wget and no curl — a fresh
Debian or Ubuntu often is one — can use
`wget -qO- https://ajar.rishwanth.dev/run.sh | sh` instead.

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

This matters more than it sounds. When your `ajar` is too old for a guest's
page to talk to at all, the page says so and gives them this command. Short
of that, nothing tells either of you: a release that changes only the agent
reaches you when you run the install command again, and not before. 0.0.7
(7 October) is one. It stops a guest taking your place in the session while
your connection is down, keeps files the tree hides out of reach of the page,
refuses to edit text it would corrupt, keeps typing that a change on disk
used to delete, keeps locked-in guests in through a relay restart, and adds
downloads and the panel's `c`. On an older `ajar` a guest who presses
Download waits a minute and is told it may be too old. 0.0.8 (8 October) is
the first Linux build that runs on any distribution; it also stops `ajar`
using a whole CPU core when run without a terminal, says why when the relay
cannot be reached, and keeps the folder's copy on the relay after the relay
restarts. 0.0.9 (19 November) is what lets a guest's page make, rename,
delete and upload files, search inside them and open an image (below): with
an older `ajar` the page offers none of that, rather than buttons that do
nothing. It also
fixes `ajar ~/some/project` dying at start — "path is expected to be under
the root" — on a machine with a global gitignore, when run from anywhere
but inside that project.

One binary, nothing to configure, for macOS and Linux on x86_64 or arm64. On
Linux it is static, so it runs on any distribution, glibc or musl, old or
new. Releases before 0.0.8 were not: they needed a glibc as new as Ubuntu
24.04's and would not start on Ubuntu 22.04, Debian 12 or RHEL 9.

It installs to `~/.local/bin` (or `AJAR_BIN_DIR`), runs it once to be sure it
works on this machine, and if that folder is not on your `PATH`, prints the
line that adds it for the shell you use — `~/.zshrc` for zsh, `~/.bashrc` for
bash on Linux and `~/.bash_profile` on a Mac, `fish_add_path` for fish — and
the one for the terminal you are in. `run.sh` finds it there either way. To
install a particular release, `AJAR_VERSION=v0.0.6` before `sh`. On Windows
use WSL2 and keep the project inside the WSL filesystem.

## Read this before you send the link

**A guest gets a real shell on your real machine.** They have your toolchain,
your network, and whatever the shared folder can reach.

`ajar` confines them: they cannot write outside the shared folder, apart from
temp directories and build caches (otherwise nothing compiles), and they
cannot read your ssh keys, cloud credentials or browser profiles. That stops
the ordinary accident — a stray `rm -rf`, an idle look through `~/.ssh`.

It is **not** a virtual machine. It does not make a determined person
harmless. Share with people you have some reason to trust.

Before it prints the link, `ajar` tells you exactly what is and is not covered
on your machine, warns about credential files sitting in the folder, and — if
the folder is in a git repository — saves a checkpoint you can roll back to.
Outside one it says there is nothing to roll back to.

## While it is open

The terminal you started it in becomes a live panel: the link, every warning,
who is connected, what they are running, what it costs, and a log of what
happened.

```
● open  api  /Users/you/projects/api
  412 files shared
  sandboxed with seatbelt — writes confined to the shared folder, temp and build caches, …
  keeping a sealed copy on the relay, 3.1M in 412 files, so guests can read while you are away
  https://ajar.rishwanth.dev/j/quiet-ember-4417#k=XrlugaMUbs_Cy0hUdWNczbHNS5SW1R-NM0123456789a
  ← send this whole link, all of it after the #   [c] copies it
┌──────────────────────────────────────────────────────────────────────────────┐
│a guest has your toolchain, confined to this folder — not a virtual machine   │
│!  1 credential in this folder — .env. Readable by a guest, since they are    │
│inside the shared folder                                                      │
└──────────────────────────────────────────────────────────────────────────────┘
┌ here ────────────────────────┐┌ running on your machine ─────────────────────┐
│2  priya  3m ago · 2 term     ││1  priya     7% cpu   184M  ·  3 proc         │
└──────────────────────────────┘└──────────────────────────────────────────────┘
┌ activity ────────────────────────────────────────────────────────────────────┐
│priya joined                                                                  │
│priya opened terminal 1                                                       │
└──────────────────────────────────────────────────────────────────────────────┘
 [k] kick   [x] lock   [l] read-only   [d] stop the copy   [c] copy link   [q] close — ends every terminal and stops the link
```

Send the whole link: everything after the `#` is the key that decrypts the
session, and the relay never sees it. A terminal a guest opened keeps running
after they leave, listed as theirs with "(left)" after the name; `q` ends it
with the rest. Someone whose link was cut short shows as "someone with an
incomplete link".

| Key | What it does |
|---|---|
| `k` | Disconnect a guest — type the number beside their name, then Enter; Backspace takes a digit back, any other key cancels. Someone you disconnect can join again unless the session is locked, so lock it first to keep them out |
| `x` | Lock the session — nobody new can join. People already in stay, through a dropped connection, a reload or the relay restarting; a new tab, even one of theirs, counts as someone new. Guests are told when you lock or unlock |
| `l` | Read-only — guests can look, search and download, but not type in a terminal, open or close one, edit a file, or make, rename, delete or upload one. Their pages say so when it changes, and the buttons for those go grey, saying why |
| `d` | Stop keeping the offline copy, and forget the one already stored; press it again to keep one again. The line under the sandbox's says what is being kept |
| `c` | Copy the link to the clipboard, where the terminal allows it: kitty, WezTerm and Windows Terminal do; iTerm2 once "Applications in terminal may access clipboard" is on; tmux with `set -g set-clipboard on`; Terminal.app never. The link wraps rather than being cut, so it can always be selected whole |
| `q` | Close — ends every terminal and kills the link. Ctrl-C does the same |

Useful flags: `--read-only` to start that way, `--no-network` to cut the
guest's network off, `--no-sync` to keep no copy, `--name` for the name guests
see you by (your login name otherwise), and `--max-terminals` (12 unless you
say). A folder with more than 20,000 files once the ignore rules are applied
is refused unless you add `--force`. `ajar --help` lists the rest. Through
`run.sh`, flags go after `sh -s --`:

```sh
curl -sSf https://ajar.rishwanth.dev/run.sh | sh -s -- --read-only
```

## What guests can do

Open terminals, browse the file tree, open files, and edit them. Two people
can type in the same file at once, and their typing survives a terminal
rewriting or appending to the file underneath them. Each file opens where you
last left it, and stays there through a dropped connection.

Since 19 November their page has what the [pad's](pad.md) has, wherever your
machine's own tools are not already the better way — the same file list,
search and editor.

**The file list.** A bar of buttons above it, and each row's own at its end,
shown as the pointer comes to it:

- **New file** and **New folder** open a row in the list where the thing
  will be — in the folder the list is on, or beside the open file — and its
  name is typed there. Enter makes it, Escape does not, and a name that is
  taken or will not do is said under it as it is typed. A `/` in the name
  makes the folders on the way (`src/app.py`).
- **Rename** — the pencil on a row, or F2 — turns the row into its name,
  ready to type over. Dragging a row onto a folder moves it there. A tab open
  on what moved follows it, with what was typed.
- **Delete** — the bin, or the Delete key — asks first. There is no bin to
  take it back out of: in a git repository the checkpoint `ajar` made when
  the session opened is what puts it back (below) — all of it but what git
  ignores, which no checkpoint has.
- **Upload** takes files from their computer into the folder the list is
  on, and so does dropping files on the list — up to 50 MB each, as they
  are: a zip stays a zip, for `unzip` in the terminal.
- **Download**, the down arrow: in the bar, the whole workspace as a zip, or
  the folder the list is on; on a row, that file as it is, or that folder as
  a zip.

A right click on a row, or Shift+F10, has the same as a menu. Everything a
guest does this way happens on your disk, inside the shared folder and
nowhere else. What the file list hides cannot be named to be changed —
nothing your ignore files name, no `.git`, none of the generated folders —
and nothing is done through a symlink. One thing to know: a folder deleted
or moved goes whole, with whatever is hidden inside it — its `node_modules`,
and a gitignored `.env` — as it would for `rm -r` or `mv` in a terminal; the
guest is told so before they confirm. Your panel's activity log says who
made, moved, deleted, uploaded or looked at what.

**Search.** The magnifying glass beside **Files** searches the folder:
**File names** for a file by its name or path, **File contents** for text in
the files, which is run on your machine, over every text file the list shows
up to 1 MB each. **In folder** keeps it to one folder; **Match case** and
**Whole word** narrow it. It is literal text on one line, never a pattern.
A result opens its file at that line. Ctrl-P and Ctrl-Shift-F (⌘P and ⌘⇧F on
a Mac) open it from the keyboard; in a terminal off a Mac those keys stay
the shell's. **Replace** previews each changed line before **Apply
replacements** changes the files, on your disk, for everyone; a file that
changed since the preview is left alone and named.

**The editor.** Beside **Colours**, above it:

- **Format** formats the file — Python with Ruff, C, C++ and Java with
  clang-format, Go with gofmt, JavaScript, TypeScript, CSS and HTML with
  Biome's formatters, and JSON, SQL, YAML, TOML, Markdown, shell, PHP and
  Lua. Shift-Alt-F does the same, and so does Format Document in the
  right-click menu. The formatter runs in the guest's browser, not on your
  machine, and what it changes arrives as typing does.
- **Preview**, for a Markdown file (or ⇧⌘V, Ctrl-Shift-V off a Mac), shows it
  formatted as GitHub would — beside the text where the editor is wide
  enough, in place of it where it is not — with its pictures, and its links
  to other files opening them.
- **Spaces: 4** is how much an indent is; click it for 2. Each guest's own.
- **Suggest**, where the relay has the suggestion model to serve: the rest
  of the line in grey as they type, Tab to take it, from a small model that
  runs in their tab — your code is not sent anywhere for it. 17 MB, fetched
  the first time code is typed. `ajar.rishwanth.dev` has it; a relay of your
  own has it only if the pad's packages are served beside it.

An empty file of a kind there is a starter for offers one on its first line.
An image — PNG, JPEG, GIF, WebP and the like, up to 5 MB — opens as a
picture rather than as a file that will not open. Ctrl-F finds and replaces
within a file, and the editor has its own right-click menu, comment
toggling, folding and several cursors, as the pad's has.

**Editor tabs and groups.** Opening a file keeps a tab in the focused editor
group. Use the split icon for another pane beside it, or the **⋯** menu for
**Split down**. Each group has its own tabs; the same file can appear in more
than one, sharing edits and undo history while keeping separate cursors and
scroll positions. Drag tabs to reorder them, move them between groups, or drop
one at a pane's right or bottom edge to split. The menu also offers moves and
closing other tabs, all tabs, or a group. Layout and open tabs are remembered
for this workspace in this browser. On a phone, the group picker shows one
pane at a time.

While focus is in an editor group, **⌘W** closes its current tab on macOS
(**Ctrl-W** on Windows/Linux); `⌘\` splits right (`Ctrl-\`), and adding
Shift splits down. **⌘1–9** focuses a group (**Ctrl-1–9**).
**Ctrl-PageUp/PageDown** cycles tabs on every OS. A tab strip also supports
arrows, Home, End, Delete, and Shift-F10 for its menu. Terminal keys stay with
the terminal.

**The terminals.** The top bar lists who is here, with "(host)" and "(you)"
beside the names and a dot in the colour of each person's cursor; on a phone,
just the dots and a count. A terminal's tab names whoever else is looking at
it, **Split** shows two terminals side by side, and the cross on a tab
closes that terminal — for everyone, so it asks first. A file and line in
what a program printed — a Python traceback's, a compiler's error, a stack
frame's — is a link: click it and the file opens at that line. **Screen
reader**, beside New terminal, lets a screen reader read what the terminals
print. On a phone or a tablet, whose keyboard has none of Tab, Ctrl or the
arrows, a row of them sits under the terminal's header: Tab, Ctrl-C, ↑ ↓ ← →,
Esc and Ctrl-D; and a phone on its side shows the editor and the terminal
side by side.

Everything works from the keyboard. The file tree is one stop: the arrow
keys move through it, Home and End go to the first and last row, → and ← open
and close folders, Enter opens a file, F2 renames, Delete deletes and
Shift+F10 opens the row's menu. A terminal takes every key, so **F6** leaves
it: F6 and Shift+F6 go round the parts of the page — the header, the files,
the editor, the terminal.

A download is only what the file tree shows: nothing your ignore files hide,
no `.git`, and none of the generated folders `ajar` always leaves out, such
as `node_modules`, `target`, `dist` and `.venv`. One over 100 MB or 20,000
files is refused, with the reason. Read-only guests can download, search and
look too.

A link that is cut short — everything after the `#` is the key that decrypts
the session — says so rather than opening a session that cannot be read, and
so does a link whose key belongs to a different session. Either way the guest
is asked for the whole link again; `c` on your panel copies it.

A few files open read-only, with the reason beside the name: files over 1 MB,
of which the first megabyte is shown, and text the browser's editor would
quietly change — not UTF-8, a byte-order mark, mixed line endings, or a
carriage return on its own. A binary file that is not an image shows only
that it is one. If a file you have open is deleted, moved by a command,
turned binary or grows past 1 MB on the host, it stays on screen, read-only,
with the reason, so nothing you typed is lost to you.

Files are coloured by language — about eighty of them, plus CSV and TSV with
each column in its own colour. **Colours** above the editor switches that off
for plain text. The button at the end of the top bar picks the theme: System
(follow the device), Light, or Dark. Each guest's browser keeps its own choice.

This guide is on the site too, at `ajar.rishwanth.dev/help`.

If your laptop sleeps or your wifi drops, guests keep the session rather than
losing it. Once the relay notices you have gone — at once if the connection
closes, within about a minute if it simply goes quiet, as a sleeping laptop's
does — their page says the host is away and counts down the 45 seconds the
relay will wait. The terminals never stop running on your machine, but take
no typing until you are back. A file a guest already had open stays editable:
what they type is kept and sent when you return, and closing the tab before
then asks first. Other files open read-only from the copy the relay keeps,
labelled as the saved copy — unless you turned the copy off with `d` or
`--no-sync`, in which case they wait for you. The copy holds only text files
under 1 MB, and none at all past 25 MB or 5,000 files; the panel says so when
that happens.

When you come back, everything resumes. If you are gone longer than the relay
waits, guests see that you have been away too long, with a **Rejoin** button:
the same `ajar`, still running, takes the same link back when your machine
reconnects, and Rejoin lets them in again. Starting `ajar` afresh makes a new
link.

A guest who opens the link while your machine is asleep sees "waiting for the
host" and, after ten seconds, a line saying it connects when the machine
wakes. If the relay itself restarts, pages already in wait for your `ajar` to
reconnect rather than giving up.

## When you close it

If the folder is in a git repository, `ajar` tells you what changed while the
session was open and how to undo it:

```
  2 files changed: src/main.rs, guest-file.txt
  to undo everything from before the session:
      git restore --source=a98a3195c0de --worktree -- .
```

It puts back every file that was there when the session started, committed
or not, except ones git ignores. Anything a guest created is left where it
is — deleting unknown files on your behalf is not a favour.

## Running your own relay

The link points at `ajar.rishwanth.dev` by default. That relay routes
encrypted frames and cannot read them, but you can run your own:

```sh
ajar --relay https://relay.example.com
```

See [operations](../dev/operations.md) for deploying one.

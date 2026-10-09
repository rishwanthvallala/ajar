# The browser workspace

A folder you can open, edit and run in a browser tab, with nobody's machine
involved but the one you are sitting at.

Live at **[code.rishwanth.dev](https://code.rishwanth.dev)**.

## Start

Open the site. You get a folder with a name nobody had, a file in it, and a
terminal. Paste something, press Run, send someone the link. They see the same
folder and can carry on from where you left off.

Or pick your own name — `code.rishwanth.dev/my-experiment` — and if nobody
took it, a new open pad starts there: like any open pad, it is anyone's who
has the address. A pad that is only yours comes from signing in (below).

## What you can do

Make files and folders, edit them, and run shell commands. A new file or
folder is saved as soon as you make it, empty or not, and so is an empty
folder a command makes. The bin icon beside a file deletes it, and beside a
folder deletes the folder and everything in it — for everyone with the link. The editor colours Python and
over fifty other formats (JavaScript, TypeScript, HTML, CSS, Markdown, JSON,
YAML, SQL, shell, Java, C and C++, Go, Rust and more), with each column of a
CSV or TSV in its own colour, and Ctrl-F finds and replaces.

**Where you were stays where you were.** Switch to another file and back, and
each opens where you left it — scrolled to the same place, the cursor where it
was, folds as they were — even if somebody else or a command changed it
meanwhile.

**Moving files.** Drag a file or a folder in the file list onto a folder to
move it inside, onto a file to put it beside that file, or onto the empty
space below to bring it to the top. With the keyboard, F2 on a file or folder
asks for its new path, which also renames it. A move is for everyone on the
pad, takes typing you have not saved yet with it, and asks first if it would
replace a file that is already there. People viewing a pad cannot move
anything, or import a zip.

**Zips in and out.** Above the file list, the down arrow downloads the whole
pad as `<pad-name>.zip`, its files in a folder of that name. On a folder's row
it downloads that folder as a zip; on a file's row, that file as it is. The up
arrow — or dropping a `.zip` on the file list — adds a zip's files to the pad,
for everyone on it:

- Every file comes in, images and other binary files too; those are listed
  in italics and are not opened in the editor.
- A zip that is all one folder — `my-project/…`, as GitHub's **Download ZIP**
  and macOS's **Compress** make — comes in without that folder, so the files
  land at the top. A pad's own zip goes back in exactly as it was.
- `__MACOSX`, `.DS_Store` and the rest of what zipping leaves behind stay out.
- If a file in the zip would replace a different one already here, you are
  asked first. On a new pad, the starter `main.py` makes way.
- 500 files and 60 MB, the same as any pad. Password-protected zips are
  refused.

**Colours** above the editor turns the colouring off, for every file, and
shows plain text. The button at the end of the top bar picks the theme: System
(follow the device), Light, or Dark. Both are remembered by your browser, not
shared with the people you sent the link to.

There are about 140 shell commands, and these are the ones people reach for:

```sh
ls cat cp mv rm mkdir touch head tail wc sort uniq cut tr tee seq echo printf
grep sed awk find diff patch cmp xargs tree stat du split which rev
tar gzip gunzip zip unzip bzip2 xz         archives
sha256sum md5sum sha1sum hexdump xxd       checksums and bytes
python3 pip qjs jq                         scripting and data
nano                                       an editor in the terminal
```

Pipes, globs, redirection, loops and command substitution all work, because it
is a real bash.

```sh
python3 transform.py < input.csv > out.csv
grep -c ERROR *.log | sort -n
for f in *.txt; do echo "$f: $(wc -l < "$f")"; done
diff old.txt new.txt > changes.patch
find . -name '*.py' -exec wc -l {} +
pip install six
grep -rn TODO . > todo.txt
```

Whatever a command writes appears in the folder, for you and for everyone
else with the link. A file that is not text — an image, a chart a script
saved, a `.zip` — is listed in *italics*: it is in everyone's terminal folder
and you can download, move or delete it, but the editor does not open it.

### The keys

The terminal's keys are bash's:

| | |
|---|---|
| ↑ ↓ | earlier and later commands; ↓ past the newest gives back what you were typing |
| Tab | completes a command or a file name; a second Tab lists the choices |
| Ctrl-R | searches earlier commands; Enter runs the match, Ctrl-G gives up |
| Ctrl-A, Ctrl-E, Home, End | start and end of the line |
| Ctrl-←, Ctrl-→, Alt-B, Alt-F | a word back, a word forward — on a Mac, Option-← and Option-→ |
| Ctrl-U, Ctrl-K, Ctrl-W, Ctrl-Y | cut to the start, cut to the end, cut a word, paste it back |
| Ctrl-L, `clear` | clear the screen |
| Ctrl-C | abandon the line, or stop a running command — so does **Stop**, which Run becomes while anything runs |
| Ctrl-D | end the input a program is waiting for: `input()` raises `EOFError`, `cat > notes.txt` finishes |
| Ctrl-S | nothing to do: every change is saved as you type |

Pasting several lines runs them one after another, as if typed.

What does not run here is anything that takes over the whole screen — vim,
less, top. `python3` on its own gives you its prompt, and `nano` is below.

### Running a server

Start something that listens and a **Preview** button appears in the header.
Press it and the editor is replaced by whatever your server is serving; press
it again to go back.

```sh
python3 serve.py          # anything that listens on a port
```

Only you can see it. The address is not a public link — it works in your
browser and nowhere else, so it is for looking at what you just started, not
for showing somebody.

One thing that will bite: **`python3 -m http.server` does not work here.** It
crashes the runtime when a request arrives. Write a small server with `socket`
instead, or use anything that is not that module.

### Editing in the terminal

`nano file.txt` opens an editor in the terminal, with nano's keys — `^O` to
save, `^X` to leave, `^K` to cut a line, `^W` to search.

It is not nano: no syntax highlighting, no undo, no multiple files at once. The
editor in the main window is better for real work; this is for when your hands
are already in the terminal.

**Ctrl-C does nothing in it** — `^X` is the way out. The **Stop** button ends
it, and anything it had not saved.

## Working together

Send the link and you are both in the same folder. The top right shows a dot
for each person here, yours ringed, with a count beside them — nothing shows
while you are the only one there — and each person's cursor in the editor is
the colour of their dot.

Two people typing in the same file both get their changes — the text merges
rather than one overwriting the other. Files a command creates show up for
everyone once it finishes.

A file whose lines end in a mix of styles — some Windows `\r\n`, some `\n`,
as a CSV can when a script wrote part of it and something else the rest — is
given one style when it is opened, the one most of its lines already have,
and saved that way. The editor can only hold one, and editing a file with
both put changes in the wrong place: a value pasted into one cell came out
in everyone else's copy with part of the old value still beside it.

**Not live**, in place of the dots, means an `ajar` session is using the
pad's name, and a pad cannot share its live room with one. Your changes still
save, but other people's show only when you reload. It goes back to live by
itself once that session ends.

## Pads you control

A pad anyone opens is anyone's: whoever has the link can change it. To decide
who can, sign in — **Your pads**, top right, or `code.rishwanth.dev/dashboard`
— with Google or GitHub. No password, and nothing is sent to your inbox.

**New pad** makes one with a three-word name, like `amber-falcon-river`, and
opens it. It is yours for as long as your account is: it never expires.
**Import a zip**, beside it, does the same with a zip's files in the new
pad instead of the starter. **Copy a pad** does it with another pad's files:
paste the link of any pad you can open — an open pad someone sent you, a
private one with the code after its `#`, or one of your own — and the new pad
gets its files as they were last saved. The original is not changed, and the
code in the link is used for that one copy, not kept. Before you have any
pads, the three are **Make your first pad**, **Start from a zip** and **Copy
a pad**.

Each pad has two settings, on its row in Your pads or under **Share** in the
pad:

| Who can view | Who can edit |
|---|---|
| Anyone with the link | Anyone with an edit link |
| Only people with a view link | Only you |
| Only you | |

**Share** gives you the links. An edit link has a code after the `#` — that
code is the permission, so send it only to people you want editing. The view
link is the plain address while anyone with the link can view. Your address
bar never shows a code, even after you open an edit link, so copying it out of
the address bar never hands out editing by accident.

**Reset** makes a new link and stops the old one working for everyone using
it, straight away — for a link that went further than you meant. Changing a
setting takes effect straight away too, for people already in the pad.

**Delete** removes the pad and its files for everyone, and its name is never
used again.

An account holds 20 pads and 100 MB across them.

**Delete account**, at the bottom of Your pads, deletes your account and every
pad in it, for everyone, straight away — after you type `delete` to confirm.
Their names are never used again. Signing in later starts a new, empty
account. Signing out, by contrast, keeps everything; a pad you had open as its
owner in another tab drops to what anyone with its link could do.

### Opening someone else's pad to view

You can watch it change as they type, and **run it** — running happens in your
own browser, as always. You can type and run commands too, but nothing you do
reaches anyone else: a bar across the top says so. The file you change becomes
**your own copy** — marked *local* in the file list — and stops following
theirs. **Discard my changes** puts theirs back, live again.

**Save as my copy** makes a new pad of everything you are looking at, your
changes included: yours if you are signed in, an open pad if not. Leaving with
changes you have not saved asks first.

A private pad you have no link for says so, and nothing more.

## The things it cannot do

**It runs on your computer, not a server.** Your browser downloads the tools
the first time — about 19 MB — and runs everything locally. That means it is
private, and it means there is no machine to reach.

**`pip install` works. Nothing else reaches the internet.** Packages come from
PyPI and that is the only place a pad can reach — no `git clone`, no `curl`, no
connecting to your own servers. Installs land in a `.deps` folder beside your
files, so they stay after a reload and whoever opens the link has them too.

Pure-python packages are what this is for: `pip install requests` takes a few
seconds, dependencies and all. Anything that needs compiling, like `numpy`, is
not available.

**No threads.** Starting one says so with an error rather than freezing the
program, which is what the runtime underneath does. `asyncio` and `subprocess`
both work.

A server you start can be previewed by you, but it is not reachable from
anywhere else.

**No `git`, `make`, or compilers.** It is for scripts and text, not builds.

**No `ssh`, `vim` or `less`.** `nano` is there; the other two are not.

**Nothing is private** in a pad anyone opens: anyone with the link can read
and change the folder. Pads you control decide who can, but every pad is
stored in the clear on the server. Do not put anything sensitive in one.

**A folder nobody opens or edits for 90 days is deleted** — unless it is one
of yours. Opening the link
counts, so a folder people keep visiting stays. Once one is deleted its name is
free, so an old link opens an empty folder — or whatever somebody else has
started there since. Keep anything you care about somewhere else too.

**A pad holds 500 files and 60 MB.** A change that would take it past either
is not saved, and the line under the editor says so.

One address can add about 256 MB a day to the server. Editing what is already
there never counts against that — only growing it does.

## If a command hangs

Ctrl-C stops it, or press **Stop**. The shell carries on where it was.

If Ctrl-C was not enough — bash's own `read`, or a program that ignores it —
the shell restarts after a moment instead, so you are back in the folder root
and any variables you set are gone. Ctrl-D, which ends a program's input, does
the same once the program finishes.

The first command is slow — that is the 19 MB arriving. After that it is
instant, and a later visit is free.

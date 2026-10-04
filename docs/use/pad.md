# The browser workspace

A folder you can open, edit and run in a browser tab, with nobody's machine
involved but the one you are sitting at.

Live at **[code.rishwanth.dev](https://code.rishwanth.dev)**.

## Start

Open the site. You get a folder with a name nobody had, a file in it, and a
terminal. Paste something, press Run, send someone the link. They see the same
folder and can carry on from where you left off.

Or pick your own name — `code.rishwanth.dev/my-experiment` — and it is yours
if nobody took it.

## What you can do

Make files and folders, edit them, and run shell commands. The bin icon beside
a file deletes it — for everyone with the link. The editor colours Python and
over fifty other formats (JavaScript, TypeScript, HTML, CSS, Markdown, JSON,
YAML, SQL, shell, Java, C and C++, Go, Rust and more), with each column of a
CSV or TSV in its own colour, and Ctrl-F finds and replaces.

**Zips in and out.** Above the file list, the down arrow downloads the whole
pad as `<pad-name>.zip`, its files in a folder of that name. On a folder's row
it downloads that folder as a zip; on a file's row, that file as it is. The up
arrow — or dropping a `.zip` on the file list — adds a zip's files to the pad,
for everyone on it:

- Only text files come in. Images and other binary files are left out, and
  the status line says how many: a pad holds text.
- A zip that is all one folder — `my-project/…`, as GitHub's **Download ZIP**
  and macOS's **Compress** make — comes in without that folder, so the files
  land at the top. A pad's own zip goes back in exactly as it was.
- `__MACOSX`, `.DS_Store` and the rest of what zipping leaves behind stay out.
- If a file in the zip would replace a different one already here, you are
  asked first. On a new pad, the starter `main.py` makes way.
- 500 files and 25 MB, the same as any pad. Password-protected zips are
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
zip -r backup.zip .
```

Whatever a command writes appears in the folder, for you and for everyone else
with the link.

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
for each person here, yours ringed, and each person's cursor in the editor is
the colour of their dot.

Two people typing in the same file both get their changes — the text merges
rather than one overwriting the other. Files a command creates show up for
everyone once it finishes.

## Pads you control

A pad anyone opens is anyone's: whoever has the link can change it. To decide
who can, sign in — **Your pads**, top right, or `code.rishwanth.dev/dashboard`
— with Google or GitHub. No password, and nothing is sent to your inbox.

**New pad** makes one with a three-word name, like `amber-falcon-river`, and
opens it. It is yours for as long as your account is: it never expires.
**Import a zip**, beside it, does the same with a zip's text files in the new
pad instead of the starter.

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

**Empty folders disappear on reload.** A folder needs something in it to
survive.

**Nothing is private** in a pad anyone opens: anyone with the link can read
and change the folder. Pads you control decide who can, but every pad is
stored in the clear on the server. Do not put anything sensitive in one.

**A folder nobody opens or edits for 90 days is deleted** — unless it is one
of yours. Opening the link
counts, so a folder people keep visiting stays. Once one is deleted its name is
free, so an old link opens an empty folder — or whatever somebody else has
started there since. Keep anything you care about somewhere else too.

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

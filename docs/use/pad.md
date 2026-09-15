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

Make files and folders, edit them, and run shell commands. There are about
140, and these are the ones people reach for:

```sh
ls cat cp mv rm mkdir touch head tail wc sort uniq cut tr tee seq echo printf
grep sed awk find diff patch cmp xargs tree stat du split which rev
tar gzip gunzip zip unzip bzip2 xz         archives
sha256sum md5sum sha1sum hexdump xxd       checksums and bytes
python3 pip qjs sqlite3 jq                 scripting and data
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

**Ctrl-C does not reach it**, or any running command — it stops the shell
instead. `^X` is the way out.

## Working together

Send the link and you are both in the same folder. You will see how many
people are here.

Two people typing in the same file both get their changes — the text merges
rather than one overwriting the other. Files a command creates show up for
everyone once it finishes.

## The things it cannot do

**It runs on your computer, not a server.** Your browser downloads the tools
the first time — about 19 MB — and runs everything locally. That means it is
private, and it means there is no machine to reach.

**`pip install` works. Nothing else reaches the internet.** Packages come from
PyPI and that is the only place a pad can reach — no `git clone`, no `curl`, no
connecting to your own servers. Installs land in a `.deps` folder beside your
files, so they stay after a reload and whoever opens the link has them too.

Small pure-python packages are what this is for. Anything that pulls several
dependencies at once currently stops the sandbox and you have to reload.

A server you start can be previewed by you, but it is not reachable from
anywhere else.

**No `git`, `make`, or compilers.** It is for scripts and text, not builds.

**No `ssh`, `vim` or `less`.** `nano` is there; the other two are not.

**Empty folders disappear on reload.** A folder needs something in it to
survive.

**Nothing is private.** Anyone with the link can read and change the folder,
and the files are stored in the clear on the server. Do not put anything
sensitive in it.

**A folder nobody touches for a week is deleted.** The name is never reused,
so an old link can never quietly turn into a stranger's files.

## If a command hangs

Ctrl-C stops it. That also restarts the shell, so you will be back in the
folder root and any variables you set are gone.

The first command is slow — that is the 16 MB arriving. After that it is
instant, and a later visit is free.

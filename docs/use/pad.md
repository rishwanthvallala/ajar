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

Make files and folders, edit them, and run shell commands:

```sh
ls  cat  wc  head  tail  sort  uniq  cut  tr  sed  grep  awk  find
cp  mv  rm  mkdir  touch  echo  printf  seq  tee  du  df  stat
python  bash
```

Pipes, globs, redirection and loops all work, because it is a real bash.

```sh
python transform.py < input.csv > out.csv
grep -c ERROR *.log
for f in *.txt; do wc -l "$f"; done
```

Whatever a command writes appears in the folder, for you and for everyone else
with the link.

## Working together

Send the link and you are both in the same folder. You will see how many
people are here.

Two people typing in the same file both get their changes — the text merges
rather than one overwriting the other. Files a command creates show up for
everyone once it finishes.

## The things it cannot do

**It runs on your computer, not a server.** Your browser downloads the tools
the first time — about 16 MB — and runs everything locally. That means it is
private, and it means there is no machine to reach.

**No internet from inside.** No `pip install`, no `git clone`, no `curl`.
Whatever is in the list above is what you get.

**No `git`, `make`, or compilers.** It is for scripts and text, not builds.

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

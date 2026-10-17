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
folder a command makes.

**Making a file.** New file, above the file list, opens a row in the list
where the file will be, and you type its name there: in the folder you clicked
last, or beside the file that is open. Enter makes it, Escape does not, and a
name that is taken or will not do is said under it as you type. A `/` in the
name makes the folders on the way (`src/app.py`); one at the start means from
the top of the pad. New folder works the same way.

**Starting from something.** An empty file of a kind the pad knows — Python,
Java, C, C++, Go, JavaScript, TypeScript, PHP, shell, HTML, CSS, JSON, SQL,
Markdown, YAML, TOML — offers a starter on its first line: a few lines that
run and print, the way an online compiler opens. A Java one is a class named
after the file. Click it, or Insert Starter Code in the editor's right-click
menu; one undo takes it out again. Typing anything instead makes the offer go.

**Formatting.** Format, above the editor, formats the file — Python with Ruff,
C, C++ and Java with clang-format, Go with gofmt, JavaScript, TypeScript, CSS
and HTML with Biome's formatters, and JSON, SQL, YAML, TOML, Markdown, shell,
PHP and Lua. Shift-Alt-F does the same, and so does Format Document in the
right-click menu. Each formatter is fetched the first time a file of its kind
is formatted, under a second on most connections. A file that will not parse
is left as it is, and the status says which line. One undo takes the
formatting back.

**Markdown, as it will look.** A `.md` file has **Preview** beside Format
(or ⇧⌘V, Ctrl-Shift-V off a Mac): the file formatted as GitHub would show it —
headings, lists, tables, task lists, quotes, code in the editor's colours.
Beside the text where the editor is wide enough, in place of it where it is
not, as on a phone; it changes as anyone types. A picture named
relative to the file (`![plot](figure-1.png)`) is the pad's own file, and a
new one from a run shows as it is made. A link to another file opens it here,
formatted if it is Markdown and at the heading the link names; `#a-heading`
scrolls to it; a link to a website opens in a new tab. Pictures from other
websites do not load here — each shows as a link to it instead. The HTML a file
may hold is shown as far as it is a document's: anything that would run or
submit, and any styling, is left out. Preview again goes back to the text.

**4 spaces, or 2.** Spaces: 4, beside Format, is how much an indent is: what
Tab types, what Format indents by, and what a starter is written with. Click
it for 2, and again for 4. It is your browser's, like the theme, and what is
written already keeps its indent until you format it. Go and Makefiles are
indented with tabs whatever it says, as gofmt and make want. The bin icon beside a file deletes it, and beside a
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
turns its row into its name, ready to type over: a `/` in the new name moves
it into a folder, and one at the start moves it from the top. A move is for
everyone on the pad and takes typing you have not saved yet with it. Renamed,
a file cannot take a name that is taken; dragged onto a file of the same name,
it asks first whether to replace it. People viewing a pad cannot move
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
- 500 files and 100 MB, the same as any pad. Password-protected zips are
  refused.

**Colours** above the editor turns the colouring off, for every file, and
shows plain text — Format still works. The button at the end of the top bar picks the theme: System
(follow the device), Light, or Dark. Both are remembered by your browser, not
shared with the people you sent the link to.

There are about 140 shell commands, and these are the ones people reach for:

```sh
ls cat cp mv rm mkdir touch head tail wc sort uniq cut tr tee seq echo printf
grep sed awk find diff patch cmp xargs tree stat du split which rev
tar gzip gunzip zip unzip bzip2 xz         archives
sha256sum md5sum sha1sum hexdump xxd       checksums and bytes
python3 pip qjs jq curl wget              scripting, data and fetching
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

### More than one terminal

**New terminal**, above the terminal, opens another: its own shell, in the
same folder, so a server can run in one while you type in the other — `curl`
at it, run the tests, edit with `nano`. Once there are two, each has a tab,
with a dot on any that has something running; **Split** puts two side by side.
Run and Stop are for the terminal in front. Closing one stops what runs in it
first. They are yours: the others on the pad have their own.

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

On a phone or a tablet, whose keyboard has none of Tab, Ctrl or the arrows,
a row of them sits under the terminal's header: Tab, Ctrl-C, ↑ ↓ ← →, Esc and
Ctrl-D. Pressing one leaves the keyboard up.

What does not run here is anything that takes over the whole screen — vim,
less, top. `python3` on its own gives you its prompt, and `nano` is below.

### Running a server

Start something that listens and a **Preview** button appears in the header.
Press it and the editor is replaced by a small browser showing your server;
press it again to go back. Above the page:
- back, forward and reload
- which server, if more than one is running: each port something listens on
- the address: type a path, `/about`, or another server's,
  `localhost:5000/api`
- ↗, the page in a tab of its own, for as long as the pad is open

**Requests**, under the page, lists every request it made: method, path,
status and time. Click one for what was sent and what came back. **Console**
shows what the page logged, and its errors. Your server's side of the same
requests is in the terminal running it.

It behaves as a browser at localhost would:
- a sign-in's cookie lasts
- a page on one port can call an API on another by its address
  (`fetch("http://localhost:5000/api")`), with the same CORS rules as at
  localhost
- a server you stop says so over its page; start it again and the page
  reloads

```sh
python3 -m http.server    # the folder, as a website
python3 serve.py          # or anything else that listens on a port
```

Flask works: `pip install flask`, then `python app.py` or `flask --app app
run`. Debug mode works too, with its debugger, but without the reloader that
restarts the server when a file changes — it needs a thread, so after a change,
press Ctrl-C and run it again. The server says so when it starts.

From another terminal, `curl localhost:5000`, or Python's `urllib` or
`requests` at `http://localhost:5000`, reaches the same server. localhost in a
pad is the folder's servers, not your computer.

Only you can see it. The address is not a public link — it works in your
browser and nowhere else, so it is for looking at what you just started, not
for showing somebody. WebSockets do not reach it, so a dev server's live
reload does not either: reload by hand.

A server answers one request at a time here, since nothing can start a thread;
`http.server` does that by itself in the pad. One that you write with `socket`
should set `SO_REUSEADDR`, or its port stays taken after Ctrl-C until the page
is reloaded — "Address in use" — and the next one needs another port.

### Fetching from the internet

`curl` and `wget` work, and so do python's `urllib.request` and `requests`
(after `pip install requests`). Your browser makes the request, the way any
web page asks a site for something, so the answer comes back from wherever you
asked:

```sh
curl -s https://pypi.org/pypi/requests/json | jq .info.version
curl -s -X POST -H 'Content-Type: application/json' -d '{"a": 1}' https://httpbin.org/anything
curl -s -o data.csv https://raw.githubusercontent.com/<user>/<repo>/main/data.csv
python3 -c "import requests; print(requests.get('https://api.ipify.org').text)"
```

Because it is your browser asking, the browser's rules apply:

- **Only sites that let web pages read them.** Most APIs do, and so do
  raw.githubusercontent.com, PyPI and npm's registry. Ordinary websites
  mostly do not — `curl https://example.com` is refused with a message
  saying so (CORS), not a hang.
- **https only.** An `http://` address is refused; try its `https://` one.
- **Some headers are the browser's own** — `Host`, `Cookie`, `Referer`,
  `User-Agent` — and you cannot set them; `curl -v` names the ones it left
  out. A response shows only the headers the site lets a page see.
- **No cookies or sign-ins of yours** go with a request, and nothing is sent
  to this site itself.
- **Redirects are always followed**, as with `curl -L`. From `localhost` — your
  own servers — `curl` follows them only with `-L`, as curl does.

Other ways of reaching the network — `git clone`, `ssh`, a database, `httpx`
or `aiohttp`, node's `fetch` — still use the sandbox's own connection, which
reaches PyPI alone.

### Editing in the terminal

`nano file.txt` opens an editor in the terminal, with nano's keys — `^O` to
save, `^X` to leave, `^K` to cut a line, `^W` to search.

It is not nano: no syntax highlighting, no undo, no multiple files at once. The
editor in the main window is better for real work; this is for when your hands
are already in the terminal.

**Ctrl-C does nothing in it** — `^X` is the way out. The **Stop** button ends
it, and anything it had not saved.

## Working together

Send the link and you are both in the same folder. Pasted into Slack,
WhatsApp, iMessage, Discord and the like, it unfurls into a card with the
pad's name, its files and the first lines of its main file. A pad only people
with a link code may view shows only that it is private.

The top right shows a dot
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

**History**, the clock above the file list, shows the pad's earlier
versions. One is kept when the pad is changed after a pause of ten minutes or
more, and every ten minutes while it is being changed, up to 30 of them, for
30 days. Pick one to see each file against the pad as it is now: changed
since, added since, deleted since. **Restore this version** puts every file
back the way it was, for everyone on the pad. What was there is kept as a
version first, so a restore can be undone the same way. Anyone who can view
the pad can look; restoring needs edit.

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

**Names of your own.** Each of those asks for a name first. Leave it blank
for three words, or type one of your own, like `notes` or `flask-demo`, for
up to three of your pads. The field says as you type whether the name is
free. A name is first come, first served, and kept for good once used:
deleting the pad frees your place for another name, not the name itself.

**Make a copy**, under **Share** in any pad you can open, does the same from
inside it: a new pad of yours with this one's files, under a name of your
own if you like. Not signed in, the copy is an open pad.

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

An account holds 20 pads and 250 MB across them.

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

**`pip install` works, and `curl` reaches sites that let web pages read them.**
Packages come from PyPI. `curl`, `wget`, `urllib` and `requests` go through
your browser — see [Fetching from the internet](#fetching-from-the-internet) —
and anything else that opens a connection reaches PyPI alone: no `git clone`,
no `ssh`, no connecting to your own servers. Installs land in a `.deps` folder
beside your files, so they stay after a reload and whoever opens the link has
them too.

A `requirements.txt` at the top of the folder is installed by itself, before
the first thing that runs Python — Run, or `python`, `flask` or `pytest` typed —
and again when it changes, so a link to a Flask app runs for whoever opens it.
What it was installed for is kept in `.deps` with the rest, so the next person
to open the pad fetches nothing. A package that will not install is said, the
program runs anyway, and it is tried again when the file changes.

`pip install requests` takes a few seconds, dependencies and all. **numpy,
pandas and matplotlib** install too, from Wasmer's own builds for this
runtime: `pip install numpy pandas matplotlib`, about a minute the first time
and kept in `.deps` after. Pillow and the rest of what those need come with
them. A package that only exists as source code to compile, which is rare, does
not install.

**Plots show over the editor.** `plt.show()` saves each figure as
`figure-1.png`, `figure-2.png`… beside your program and opens it in place of the
editor; **Back to editor** returns. Any image file in the tree opens the same
way. `plt.savefig()` works as anywhere.

**No threads.** Starting one says so with an error rather than freezing the
program, which is what the runtime underneath does. `asyncio` and `subprocess`
both work, and a server built on Python's `socketserver` — `http.server`
among them — serves its requests one after another instead.

A server you start can be previewed by you, but it is not reachable from
anywhere else.

**C, Go, Java, JavaScript and PHP come the first time you use them.** Type
`clang`, `go`, `java`, `node` or `php` — or press Run on a `.c`, `.go`, `.java`,
`.js` or `.php` file — and the terminal says it is fetching that language, how
big it is, and then runs your line: about 106 MB for C, 273 MB for Go, 66 for
Java, 75 for Node and 82 for PHP before compression, the first time a tab uses
it — so nobody who only writes Python pays for them. The terminal
starts a fresh shell when one arrives; you stay in the same folder, with what
you exported. Common Lisp is there the same way, as `repl`.

Each has its limits. `gcc`, `g++` and `cc` are clang under those names. C++
compiles, but not `#include <iostream>` — it never finishes; use `<cstdio>` and
`printf`. Go runs a single file with `go run`, not a module —
`go mod init` does not work — a Go program opens files by their full path
(`/workspace/data.txt`), and a program `go build` makes runs only once, so use
`go run`. Lisp runs expressions and its REPL, not files.

Java is Java 25 — the real class library, run by a JVM built for this sandbox.
`javac Main.java` then `java Main` works, and so does `java Main.java` on its
own, which is what Run does. Compiling takes a tenth of a second or so, and
running a compiled class under one. In a browser too old for the fast compiler
(before Chrome 137, Firefox 131 or Safari 18.4) the terminal says so, and
compiling takes several seconds instead. Programs read input with `Scanner` as
usual. There is no `jshell`, and nothing that opens a window.

**No `gcc`, no Ruby, no `git` or `make`.** There is no `gcc` for this kind of
sandbox at all; C is clang. Ruby and Zig exist but do not work well enough yet.

**No `ssh`, `vim` or `less`.** `nano` is there; the other two are not.

**Nothing is private** in a pad anyone opens: anyone with the link can read
and change the folder. Pads you control decide who can, but every pad is
stored in the clear on the server. Do not put anything sensitive in one.

**A folder nobody opens or edits for 90 days is deleted** — unless it is one
of yours. Opening the link
counts, so a folder people keep visiting stays. Once one is deleted its name is
free, so an old link opens an empty folder — or whatever somebody else has
started there since. Keep anything you care about somewhere else too.

**A pad holds 500 files and 100 MB.** A change that would take it past either
is not saved, and the line under the editor says so.

**A text file over 24 MB opens read-only.** It is too large to edit together
live. Change it from the terminal — `sed`, `python`, a script of your own — and
everyone gets the change once it is saved.

One address can add about 512 MB a day to the server. Editing what is already
there never counts against that — only growing it does.

## If a command hangs

Ctrl-C stops it, or press **Stop**. The shell carries on where it was.

If Ctrl-C was not enough — bash's own `read`, or a program that ignores it —
the shell restarts after a moment instead, so you are back in the folder root
and any variables you set are gone. A program that started another program
that is still running cannot be stopped from the terminal at all: Ctrl-C
reaches the other one. The terminal says so, and the program goes on — a
server keeps its port ("Address in use" next time) — until you reload the
page. Ctrl-D, which ends a program's input, does
the same once the program finishes.

The first command is slow — that is the 19 MB arriving. After that it is
instant, and a later visit is free.

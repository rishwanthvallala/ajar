# The browser workspace

A folder you can open, edit and run in a browser tab, with nobody's machine
involved but the one you are sitting at.

Live at **[code.rishwanth.dev](https://code.rishwanth.dev)**, and this guide is
there too, at [code.rishwanth.dev/help](https://code.rishwanth.dev/help).

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

**Making a file.** New file, above the file list, opens a row in the list
where the file will be, and you type its name there: in the folder you clicked
last, or beside the file that is open. Enter makes it, Escape does not, and a
name that is taken or will not do is said under it as you type. A `/` in the
name makes the folders on the way (`src/app.py`); one at the start means from
the top of the pad. New folder works the same way.

**Starting from something.** An empty file of a kind the pad knows — Python,
Java, C, C++, Go, JavaScript, TypeScript, PHP, shell, HTML, CSS, JSON, SQL,
Markdown, YAML, TOML — offers a starter on its first line: a few lines to
start from. For the kinds Run runs — Python, Java, C, C++, Go, JavaScript and
PHP — it is a program that runs and prints, the way an online compiler opens;
for the rest, a page, a query, a document to fill in. A Java one is a class
named after the file. Click it, or Insert Starter Code in the editor's right-click
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

**Errors point at your code.** When a program fails, the file and line in its
error — a Python traceback, a C, C++, Go or Java compiler's error, a Java or Node
stack, PHP's — are links in the terminal: click one and the file opens at that
line. And the run's errors are marked in the editor, a squiggle under each line
with what it said on hover (F8 steps through them). The marks follow the text
as you edit, and the next run replaces them; a command that is not a program
— `ls`, `pip install` — leaves them be. A JavaScript error is marked in the
file `node` ran, though it is not a link: Node here names that file
`<anonymous>`, at the right line.

**The last run is kept with the pad.** What Run last printed — and which file,
how it ended, when — is saved with the pad, so whoever opens the link next sees
it in the terminal before running anything, its errors marked as they were.
It is the pad's, not a file in it: not in the file list, the zip or the
history, and gone with the pad. Only someone who can edit the pad saves it; up
to 32 KB, the end of what it printed.

**Where you were stays where you were.** Switch to another file and back, and
each opens where you left it — scrolled to the same place, the cursor where it
was, folds as they were — even if somebody else or a command changed it
meanwhile.

**Search the folder.** The magnifying glass beside **Files** opens Search —
beside the Files button at the top on a phone. Choose **File names** to find
a file by its name or path, or **File contents** to search the text in the
pad. **In folder** searches just that folder and everything inside it; leave
it at **Entire pad** to search everywhere. Text search has **Match case** and
**Whole word** switches. It searches literal text on one line, including
typing not saved yet. It runs in your browser, without uploading a query.

On Windows and Linux, **Ctrl-P** finds files and **Ctrl-Shift-F** searches
contents; on a Mac, **⌘P** and **⌘⇧F**. In the terminal on Windows and Linux
those keys stay the terminal's — Ctrl-P is the shell's previous command — so
click in the editor or the files first. The magnifying glass works where the
browser or OS reserves a shortcut. Up and Down select results, Enter opens
one at the matching line, and Escape leaves Search (or closes the phone's
drawer first). **Back to files** returns to the tree without losing the
search. Ctrl-F still searches inside the editor's current file.

**Replace**, in content search, is for people who can edit the pad. Enter the
replacement, or leave it empty to remove matches, and choose **Preview
replacements**. Each file's **Replace…** previews just that file. The preview
shows changed lines before **Apply replacements** changes them for everyone.
Files changed since the preview are skipped, as are text files too large to
edit here. Replacements save as typing does; check the status if saving
fails. There is no project-wide undo, and files apply individually. Search
shows at most 5,000 matches; narrow the query or folder before replacing if
it reaches that limit. Binary filenames can be found, but their contents
cannot be searched or replaced.

**Moving files.** Drag a file or a folder in the file list onto a folder to
move it inside, onto a file to put it beside that file, or onto the empty
space below to bring it to the top. **Rename** (the pencil beside a file or
folder, or F2 on it) turns its row into its name, ready to type over: a `/` in
the new name moves it into a folder, and one at the start moves it from the
top. A move is for
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

`awk` is The One True Awk — the awk on a Mac — with `system()`, pipes to and
from commands, and `getline`. `sort`, `tail`, `diff`, `patch`, `find`, `xargs`
and the rest from `diff` on behave as GNU's do, checked against them; what one
cannot do here it refuses by name rather than ignoring.

Pipes, globs, redirection, loops and command substitution all work, because it
is a real bash.

```sh
python3 transform.py < input.csv > out.csv
grep -c ERROR *.log | sort -n
for f in *.txt; do echo "$f: $(wc -l < "$f")"; done
diff -u old.txt new.txt > changes.patch
find . -name '*.py' -exec wc -l {} +
pip install six
grep -rn TODO . > todo.txt
```

Whatever a command writes appears in the folder, for you and for everyone
else with the link. A file that is not text — an image, a chart a script
saved, a `.zip` — is listed in *italics*: it is in everyone's terminal folder
and you can download, move or delete it, but the editor does not open it.

### Suggestions as you type

While you type, the editor suggests the rest of the line in grey, reading the
code above the cursor and below it. **Tab** takes it; keep typing, or press
**Escape**, to leave it. Nothing else takes it: Ctrl+Right (Cmd+Right on a
Mac) moves the cursor as it always does. It is shown only when it is likely to be right —
about seven times in ten it is exactly what you would have typed — so on many
lines it stays quiet.

The suggestions come from a small model that runs in your tab: your code is
not sent anywhere for them. The model is a 17 MB download the first time you
type in a pad, once per browser, and the **Suggest** switch beside Format
turns it off. It does not load on a phone, or with your browser's data saver
on. They are yours alone: nobody else on the pad sees your grey text, only
what you take.

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
| Ctrl-Enter (⌘⏎ on a Mac) | Run, from anywhere on the page — the editor and the terminal too |
| F6, Shift-F6 | to the next part of the page and back — the header, the files, the editor, the terminal: the way out of the terminal by keyboard, where Tab completes; the terminal says so under the first command you type |
| Ctrl-D | end the input a program is waiting for: `input()` raises `EOFError`, `cat > notes.txt` finishes |
| Ctrl-S | nothing to do: every change is saved as you type |

Pasting several lines runs them one after another, as if typed.

On a phone or a tablet, whose keyboard has none of Tab, Ctrl or the arrows,
a row of them sits under the terminal's header: Tab, Ctrl-C, ↑ ↓ ← →, Esc and
Ctrl-D. Pressing one leaves the keyboard up. On a phone the files are behind
**Files**, at the start of the top bar, and the editor sits above the
terminal; turned on its side, the editor and the terminal are side by side,
each the height of the screen.

**Screen reader**, beside New terminal, lets a screen reader read what the
terminals print. Your browser remembers it, as it does the theme.

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
pad's name, its files, the first lines of its main file and the first lines
of what Run last printed. A pad only people
with a link code may view shows only that it is private.

The top right shows a dot
for each person here, yours ringed, with a count beside them — nothing shows
while you are the only one there — and each person's cursor in the editor is
the colour of their dot. **Offline** there means this page has lost its live
connection: your typing still saves, but you do not see other people's until
it is back, which it tries for on its own.

Two people typing in the same file both get their changes — the text merges
rather than one overwriting the other. Files a command creates show up for
everyone once it finishes. A file renamed or moved while you type in it takes
you along, with what you typed. One thing does not merge: typing in a file
while a program is still writing to it — a log it appends to, say — keeps the
typing and loses the program's new lines. Watching a file grow is fine; edit
it once the program is done.

**If saving fails** — the connection drops, the pad is full — the status line
says so, and what you typed is kept in this browser until it can be saved.
Leaving the page then asks first. If the tab closes anyway, the next time you
open the pad in this browser your typing comes back, merged into whatever was
saved since, and the status line says which files — each tab's, if you had
the pad open in more than one. A save made from an older
copy than the store has — two places editing without the live connection — is
merged into the newer one, never written over it.

**If someone removes a file you have unsaved typing in**, it stays open for
you, read-only, with **Save local copy** and **Discard local changes** above
it. If the file is made again, the new one takes its name and yours moves
beside it as *name (kept)*, still only in your browser.

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
that is not saved with the pad — numpy alone is over a thousand files — so
**a typed `pip install` adds what it installed to `requirements.txt`**, and
the terminal says so. That file is what reaches whoever opens the link.

A `requirements.txt` at the top of the folder is installed by itself, before
the first thing that runs Python — Run, or `python`, `flask` or `pytest` typed —
and again when it changes, so a link to a Flask app runs for whoever opens it:
each visitor's own sandbox fetches the packages, in seconds. If a line will
not install, the others still do — each is tried on its own — the program runs
anyway, and the ones that failed are named and tried again when the file
changes.

`pip install requests` takes a few seconds, dependencies and all. **numpy,
pandas and matplotlib** install too, from Wasmer's own builds for this
runtime: `pip install numpy pandas matplotlib` takes 10 to 20 seconds each
time a sandbox starts without them. Pillow and the rest of what those need
come with them. A package that only exists as source code to compile, which is
rare, does not install. `pip list` shows only pip itself — the packages are in
`.deps`, which `pip list --path .deps` lists — and `pip uninstall` is refused;
take the line out of `requirements.txt` instead, and `rm -r .deps` to start
over. Installing pandas after numpy says "Target directory … already exists"
for numpy, which is harmless.

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

**C, C++, Go, Java, JavaScript and PHP come the first time you use them.** Type
`clang`, `g++`, `go`, `java`, `node` or `php` — or press Run on a `.c`, `.cpp`,
`.go`, `.java`, `.js` or `.php` file — and the terminal says it is fetching that
language, how big it is, and then runs your line: about 106 MB for C, 20 for
C++, 273 MB for Go, 66 for Java, 75 for Node and 82 for PHP before compression,
the first time a tab uses it — so nobody who only writes Python pays for them. The terminal
starts a fresh shell when one arrives; you stay in the same folder, with what
you exported. Common Lisp is there the same way, as `repl`.

Each has its limits. `gcc` and `cc` are clang under those names, for C.
**C++ is clang 22 with libc++**, as `g++`, `c++` or `clang++`: the standard
library — `<iostream>`, `<vector>`, `<string>`, `<map>`, `<algorithm>` and the
rest — and exceptions, try and catch included; an exception nothing catches
says what it was and ends the program, as it would anywhere. What it builds
is a WASI program, run as `./a.out`; there are no threads in it, and a large
exit status (100, say) comes back as 79. JavaScript errors show
your program's frames as `<anonymous>:line:column`, without a file name, which
this runtime's node does not give. Go runs a single file with `go run`;
`go mod init` works, but a module does not run (`go run .` fails). A Go
program opens files by their full path (`/workspace/data.txt`) — a relative
one fails with "Math result not representable" — and a program `go build`
makes runs only once, so use `go run`. The first `go run` fetches
273 MB and takes about 24 seconds. Lisp runs expressions and its REPL, not
files.

Java is Java 25 — the real class library, run by a JVM built for this sandbox.
`javac Main.java` then `java Main` works, and so does `java Main.java` on its
own, which is what Run does. Compiling takes a tenth of a second or so, and
running a compiled class under one. In a browser too old for the fast compiler
(before Chrome 137, Firefox 131 or Safari 18.4) the terminal says so, and
compiling takes several seconds instead. Programs read input with `Scanner` as
usual. There is no `jshell`, and nothing that opens a window.

**No `gcc`, no Ruby, no `git` or `make`.** There is no `gcc` for this kind of
sandbox at all; C is clang. Ruby and Zig exist but do not work well enough yet.
A Makefile is kept and indented with tabs, but nothing here runs it.

**`ls` lays out columns even into a pipe** here, so `ls | wc -l` counts rows
of names, not names; `ls -1` gives one a line.

**What a pad keeps.** At most 500 files and 100 MB. A file a command makes
that the pad cannot keep — past the 500, or with a name it cannot hold, a
backslash in it (what a script written for Windows makes) or a tab — is named
in the status line and above the prompt, and left out; everything else the
command made is saved as usual. Links made with `ln` are not kept, and nor is
what tools leave behind: `__pycache__` and `.pyc` files, `node_modules`, a
`.git` folder, and `.deps`, where pip installs. `~` is a
folder under `/tmp`, `$HOME`, which is the sandbox's and gone after a reload;
so is `/tmp`.

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

**A pipeline can hang.** Now and then a command piped into another —
`pip install numpy 2>&1 | tail -2`, `cat poem.txt | grep two` — finishes its
work and never ends: the runtime underneath does not always tell the second
program the first one is done. Most of the time for a long pip install piped
into `tail`, rarely for short commands. Ctrl-C brings the prompt back and no
file is lost, but Python in that page may not answer again until you reload
it. To avoid it, write to a file, then read it — two commands:
`pip install numpy > log.txt 2>&1`, then `tail -2 log.txt`. The install is
added to `requirements.txt` as a plain one is; joined with `;` or a pipe it is
not, because the line's result is then `tail`'s, not pip's.

The first command is slow — that is the 19 MB arriving. After that it is
instant, and a later visit is free. Run pressed while the pad is still
opening is not lost: the status line says so, and the file runs once the pad
is open.

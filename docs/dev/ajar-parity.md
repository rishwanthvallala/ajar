# The guest's page, feature for feature with the pad

What the pad's page does that a guest's page in an `ajar` session did not,
and what was done about each. Begun 19 November 2026, when the two had
drifted for a month: every change to how a pad looks or works since
7 October had gone to `pad/` alone, and the guest's page still had the tree
and the editor it had then.

The two are different products with one shell (`packages/workspace-ui`).
The pad runs in the browser and keeps its files on the relay; an `ajar`
session is somebody's real folder on their real machine, with the page a
guest of it. So each thing the pad does is one of four:

- **had** — the guest's page did it already;
- **page** — brought over in the page alone, and works with any host;
- **host** — needs the host's `ajar` to do something new: the page asks, the
  agent does it on the disk. Works once the host runs a release that has it,
  and is not offered before (below, "What the host says it can do");
- **not ajar's** — a thing of the pad's own nature: its runtime, its store,
  its accounts.

## The list

| The pad | The guest's page |
|---|---|
| The shell: header, files, editor over terminal, the two separators, the files as a drawer on a phone | had |
| Theme (System, Light, Dark), Colours on and off, CSV columns | had |
| Editor tabs and groups: split right and down, drag between, the keys | had |
| A file opens where it was left | had |
| A dot per person in their cursor's colour | had |
| More than one terminal, Split | had (shared ones, the host's) |
| Download a file, a folder, everything | had; **page**: the arrow on each row, and an icon in the tree's bar, as the pad has them |
| File and folder icons in the tree, a bar of icon buttons above it | **page** |
| Search, file names: the magnifier, Ctrl/⌘-P | **page** |
| Search, file contents, and Replace: Ctrl/⌘-Shift-F | **host** — the search runs on the host's disk |
| New file, New folder, typed into the tree | **host** |
| Rename (the pencil, F2), move by dragging | **host** |
| Delete a file or a folder | **host** |
| Upload: a zip's files, or files dropped on the list | **host** — files, as they are: a zip stays a zip, for the host's own `unzip` in the terminal |
| Format, Shift-Alt-F, Format Document in the menu | **page** |
| The editor's own: Ctrl-F, its right-click menu, comment toggling, folding | **page** — the session's Monaco did not load them (below) |
| Spaces: 4 or 2 | **page** |
| A starter for an empty file | **page** |
| Markdown Preview, beside the text or over it; links between files | **page**; its pictures **host** |
| Suggestions as you type, and the Suggest switch | **page**, where the relay's front serves the model: `ajar.rishwanth.dev` does |
| An image opens to view | **host** — the bytes come from the host |
| A file and line in the terminal's output is a link | **page** |
| A phone's missing keys under the terminal's header | **page** |
| Screen reader, for the terminals | **page** |
| F6 and Shift-F6 between the parts of the page | **page** (it left the terminal only) |
| A terminal's tab closes it | **page** — the protocol always could |
| A phone on its side: editor and terminal side by side | **page** |
| Toasts that say whether it worked; a dialog that asks first | **page** |
| The guide at `/help` | **page** |
| Run and Stop, the languages, `pip`, requirements, the last run kept, errors marked in the editor | not ajar's: the host's own toolchain runs in the host's own terminal |
| The server Preview, `curl` through the browser | not ajar's: there is no sandbox to look into |
| History and Restore | not ajar's: the host's git is the history, and `ajar` says how to go back when it closes |
| Share, Your pads, plans, link previews | not ajar's: the link is the host's, and sealed |
| A viewer's own copy, Save as my copy | not ajar's: read-only is the host's `l` |

## Where it is

- The page: `web/src/` — `tree.ts` (the list), `workspace.ts` and `viewer.ts`
  (the editor and its tools), `ops.ts` (what it asks of the host),
  `terminal-extras.ts`, `help.ts`, `session.css`.
- What both products share: `packages/workspace-ui`
  ([workspace-ui.md](workspace-ui.md), "What the page is built from").
- The host: `crates/ajar/src/fileops.rs`, and `on_file_op` in `main.rs`
  ([agent.md](agent.md), [protocol.md](protocol.md)).
- Checked by `scripts/check-guest-tools.mjs` in a browser, under the
  Content-Security-Policy production's front sends, with the folder
  read off the host's disk after each step; `scripts/smoke-files.mjs` on
  the wire; `fileops`' unit tests; and, for a host that says nothing of what
  it can do, `scripts/check-editor-documents.cjs`.

## Live

Deployed by CI on 19 November, 04:27 IST (`8f48ea4`), and checked against
production once: this tree's `ajar` — the one that says what it can do —
sharing a scratch folder through `ajar.rishwanth.dev`, and a browser
joining it. New file and Upload offered, and a file named in the tree made
on the host's disk; Format, under the site's real policy; the editor's own
find; a search of contents answered by the host; a Markdown file formatted
with its picture drawn; Suggest offered, its model loaded from ajar's site
in three seconds, and grey text; the guide at `/help`; no page errors and
nothing the policy refused. Eleven checks, all passed.

Not checked live: a host on a released `ajar`, 0.0.8 or older, which is
every host there is until 0.0.9 is cut ([open-points.md](../open-points.md)).
That such a host is offered none of the host's half is held by
`check-editor-documents.cjs`, against a roster that says nothing.

## Found on the way

- **`ajar <folder>` died at start on a machine with a global gitignore**,
  unless started from inside that folder: every release up to 0.0.8. No
  suite that starts an agent on a temporary folder could run on the
  maintainer's Mac, which had gained a `~/.config/git/ignore` ten days
  before. Fixed in `Filter::build` (`4ef2aec`).
- **The session's editor had none of Monaco's own features** — no Ctrl-F, no
  right-click menu, no folding. The pad's Monaco loads them with any
  language; the session's, a version on, does not. Asked for by name now.
- **A read-only guest could close a terminal.** The agent closed one for
  anyone who asked; no page asked until this one offered the cross on a tab.
  Refused when read-only now.
- **The tree's keys acted on the row it thought had the focus**, which was
  not always the one that did: Delete pressed on a row reached by anything
  but the arrows or a click asked about another row. Whatever row has the
  focus is the tree's stop now.

## What the host says it can do

A guest's page is served by the relay and is always the newest; the host's
`ajar` is whatever they installed. So nothing here changed what an old agent
is sent or must understand:

- Every new request is a new `Fs` message. An agent that does not know one
  drops it (`Channel::Fs`'s `_ => {}`), as it always has.
- The host says what it can do in the roster it already sends:
  `Presence::Roster { can: [...] }`, absent from an older agent. The page
  offers New file, Rename, Delete, Upload, content search and image viewing
  only when the host has said it can — never a button that does nothing.
- `PROTOCOL_VERSION` stays 1.

## What it cost the page

The guest's page is bigger for it: its first script went from 399 KB to
464 KB (105 to 125 KB compressed) and its stylesheet from 29 to 49 KB (6 to
10 compressed). The editor's own features, which it had been without, are in
the editor's chunk, fetched with the first file opened as before. The
formatters, the Markdown renderer and the suggestion model are each fetched
when first used, and not before.

## What reverses a decision

The review of 7 October left out, on purpose, "creating, renaming and
deleting files from the tree" and "uploading files from the browser": the
shell does all of it, and a second way to change the host's disk is a second
thing to secure. Both are in now, because the pad has them and the guest's
page is to have what the pad has. What that costs, and what holds it:

- The agent itself is not in the sandbox the guest's shell is in, so each of
  these is the agent writing to the host's disk on a guest's word. Every path
  goes through one gate (`fileops::checked`) and is then used only beneath
  the folder, opened as a `cap-std` directory: inside the shared folder as
  written and as it resolves, through no symlink at all, and never anything
  the tree hides — `.git`, what the ignore files name, the generated
  folders. [security.md](security.md), "What a guest's page can change".
- Read-only refuses all of them, at the agent, as it refuses typing.
- Each is a line in the host's activity pane, with who did it.
- A delete is a delete: there is no bin. In a git repository `ajar`'s
  checkpoint puts back what was there when the session opened, as it does
  for anything else a guest changes.

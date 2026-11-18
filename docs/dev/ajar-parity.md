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
| Upload: a zip's files, or files dropped on the tree | **host** |
| Format, Shift-Alt-F, Format Document in the menu | **page** |
| Spaces: 4 or 2 | **page** |
| A starter for an empty file | **page** |
| Markdown Preview, beside the text or over it; links between files | **page**; its pictures **host** |
| Suggestions as you type, and the Suggest switch | **page** |
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

## What reverses a decision

The review of 7 October left out, on purpose, "creating, renaming and
deleting files from the tree" and "uploading files from the browser": the
shell does all of it, and a second way to change the host's disk is a second
thing to secure. Both are in now, because the pad has them and the guest's
page is to have what the pad has. What that costs, and what holds it:

- The agent itself is not in the sandbox the guest's shell is in, so each of
  these is the agent writing to the host's disk on a guest's word. Every path
  goes through one gate (`Workspace::place`): inside the shared folder as
  written and as it resolves, through no symlink out of it, and never
  anything the tree hides — `.git`, what the ignore files name, the
  generated folders.
- Read-only refuses all of them, at the agent, as it refuses typing.
- Each is a line in the host's activity pane, with who did it.
- A delete is a delete: there is no bin. In a git repository `ajar`'s
  checkpoint puts back what was there when the session opened, as it does
  for anything else a guest changes.

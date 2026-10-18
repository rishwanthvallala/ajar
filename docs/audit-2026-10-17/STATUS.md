# Where each finding stands

What was done about each finding in [README.md](README.md), as of
18 October 2026. "Closed" means fixed, with a check that fails without the fix;
*still open* is what the fix leaves, said as plainly as the finding was. The
details of each are in the docs named, mostly
[security.md](../dev/security.md) under what was closed on 17 and 18 October.

| ID | State | Commit | Still open |
|---|---|---|---|
| DC-01 | Closed | 6778287 | |
| DC-02 | Closed | 6778287 | |
| DC-03 | Closed | 6778287 | |
| DC-04 | Closed | 6778287 | |
| DC-05 | Closed | 6778287 | A journal in the tab's storage (512 KiB) and a leave warning, not a server-side draft. |
| DC-06 | Closed | 86164b0 | A stretch too long to compare, with no line found once on each side, changed on both sides, can still show base text twice. |
| DC-07 | Closed | 6778287 | |
| DC-08 | Closed | 6778287 | |
| DC-09 | Closed | 8822d3f, 39a3573 | While pages from before are still open, one holding both of two colliding files can still misroute; it ends as they reload. |
| DC-10 | Closed | 4f86896 | With two pads' previews open in one browser, a frame or window a preview page makes itself is refused rather than guessed. |
| DC-11 | Closed | 4f86896 | |
| DC-12 / R8 | Closed | 6778287 | |
| B01 | Closed | 556b8df | |
| B02 | Closed | 556b8df, 3f16c46 | |
| B03 | Closed | f0093ed | |
| B04 | Closed | ed85b72 | Room is taken as bytes arrive, so a fast upload of nearly two bodies and then a trickle can hold the budget for up to ten minutes at a time. |
| B05 | Closed | 8f1cc11 | Logs written before it may hold codes: delete them on the server ([operations](../dev/operations.md#what-is-on-disk)). |
| B06 | Closed | c30c534 | Only an owner's place comes from a sign-in; a link's viewer or editor keeps its place until the link is revoked. |
| B07 | Closed | 7a55d0e | No real power cut was made; a test holds the setting and the order. |
| B08 | **Open** | — | Options, costs and what to keep are in [durability.md](../dev/durability.md); waiting on choosing where the copies go. |
| B09 | Closed | 6c551f3 | The databases' own rows and WAL are outside the ceiling. |
| B10 | Closed | ed85b72 | |
| B11 | Closed | f0093ed | |
| B12 | Partly | 6bcde2d, c060908 | `/healthz?deep=1` exists and the deploy waits for it; the deploy still copies into the live directories, with no release swap or rollback. |
| R1 | Closed | 6778287 | |
| R2 | Closed | 8108765 | |
| R3 | Closed | 6778287 | |
| R4 | Closed | 6778287 | |
| R5 | Closed | 6778287 | |
| R6 | Closed | 6778287 | |
| R7 | Closed | 8108765 | |
| R9 | Closed | 8108765 | |
| UX1 | Closed | 8108765 | A screen-reader mode, off by default and turned on with the terminal's Screen reader button: in it xterm takes no plain text input, which is what a phone's keyboard and a pasted "ï" send. No session with a real screen reader yet. |
| UX2 | Closed | 6778287 | |

`preview-session-repros.cjs` asserts the behaviour from before DC-10 and
DC-11, with sources that have no `url` or `frameType`, so it now fails its
asserts, which is the fix showing; the checks that hold the fix are the seven
added to `pad/scripts/preview-check.mjs`.

The follow-ups the README does not count as defects — deletion and permission
races, quota reconciliation, name-claim races, viewer binary export, partial
multi-request imports, handshake memory, aggregate socket limits, many
terminals — were not taken up, apart from a first frame too big to be a hello
being refused unread (eee83b6).

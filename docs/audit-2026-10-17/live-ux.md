# Pad live browser and product audit — 17 October 2026

This is a record of observed behavior, with implementation review where explicitly identified. Tests used synthetic content in anonymous pad `solar-meadow-3820`. No existing user's pad or signed-in account was modified. The browser was Chromium 155 on Windows, with approximately 654×612 and 1280×720 views. A narrow desktop viewport is not an iOS/Android test.

## Observed live journeys

| Journey | Result | Evidence and limits |
|---|---|---|
| Open the deployment at `/` | Pass | Redirects in-place to a newly minted pad and shows the Python starter, editor, terminal and file controls. |
| Replace starter and run Python | Pass | `print("Pad audit 2026-10-17: hello")` prints the expected message. `live-python.png`. |
| Save and open the same pad in a second page | Pass | Original Python text and nested JS file are present. The later page displays the saved previous JavaScript run before starting another program. |
| Presence | Pass for two pages | Both pages show `2 here`. This alone does not establish all concurrent-edit behavior. |
| Nested file creation | Pass | Creating `src/audit.js` creates the folder and file, and updates the tree. |
| Empty-file starter | Pass | JavaScript and Python starter affordances appear and insert runnable code. |
| JavaScript execution | Pass | Node starter prints Hello and squares 1, 4, 9. Terminal reports initial Node installation took 18 seconds in this session. This is one observation, not a latency distribution. |
| Python format | Pass for a valid starter | Ruff loads and reports the already-formatted file accurately. Invalid syntax, every formatter and formatter cancellation were not covered in this manual pass. |
| Share anonymous pad | Pass | Opens a dialog and copies the address. Text explains that anyone with it can edit. No edit/view code is needed for an anonymous open pad. |
| Accepted filename containing `$` | **Fail** | `cash$HOME.py` accepts the standard Python starter, but Run tries `/workspace/cash.py` and exits 2. `live-filename-failure.png`. |
| awk arithmetic | **Fail** | `printf '3 4\n' \| awk '{print $1 + $2}'` prints `34` and succeeds instead of printing `7`. `live-awk-failure.png`. |
| Python HTTP server | Pass | `python3 -m http.server 8000` starts and exposes Preview. |
| Preview | Pass for basic render | Directory listing renders on the separate preview origin; expected files are present. |
| Preview request inspector | Pass | Shows GET `/`, status 200, headers, response body and timing. `live-preview.png`. |
| Stop server | Pass for this process | Stop ends the command; preview says the server stopped and should reload on restart. This is not a proof that every process tree terminates. |
| Second terminal | Pass | New Terminal opens an independent shell and prints `second terminal alive`. |
| Split terminal | Pass | Both terminal panes are visible and terminal selection is retained. |
| Dashboard signed out | Pass | Offers Google, GitHub and anonymous usage; explains anonymous permissions and 90-day inactivity expiry. |
| Public account API | Pass | `/api/me` says signed out, lists both providers and limits; `/api/my/pads` returns 401. `live-http.json`. |
| Deployment headers | Pass for observed headers | HTTPS responses include COOP same-origin, COEP require-corp, CSP, nosniff and no-referrer. This does not certify all security boundaries. |

The existing automated live suite is documented separately in `runtime-quality.md`. It failed during its first runtime start after four preliminary checks passed. Manual successes and that cold-start failure must both be retained; neither cancels the other.

Browser-automation failures resolving Monaco's editable accessibility node and clicking links inside the cross-origin preview frame were treated as tool limitations, not as product defects. Typing via the focused editor worked. The preview worker's cross-session defects were reproduced separately against its real code, not by claiming the unsuccessful UI clicks demonstrated them.

## UX1 — P1 for affected users: terminal output is not exposed to screen readers

The live accessibility snapshots contain `Terminal input` but omit the visible program output, including the success messages and error text. See `live-accessibility.txt` alongside the screenshots. `pad/src/app.ts:2227` constructs xterm with font size, EOL conversion and theme, and never enables `screenReaderMode`. Repository search finds no subsequent activation.

The installed dependency is xterm 5.5; [its versioned defaults](https://raw.githubusercontent.com/xtermjs/xterm.js/5.5.0/src/common/services/OptionsService.ts) set `screenReaderMode: false`. The [official option documentation](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/#optional-screenreadermode) explains that this option exposes supporting DOM elements for NVDA and VoiceOver. The implementation and live tree are consistent: a central product output surface is visually rendered without the supporting accessible representation.

Enable or offer an accessible terminal mode, expose a keyboard-operable control if performance requires it to be optional, and validate input/output, errors, prompts, history and Stop using NVDA and VoiceOver. An actual assistive-technology session was not conducted; do not describe this audit as a full WCAG conformance assessment.

## UX2 — P2: clearing a pad name can leave creation disabled by an old availability result

**Locally reproduced using the actual name-dialog closure**, with controlled asynchronous responses. Evidence: `name-dialog-repro.cjs` and `name-dialog-repro.json`.

1. Enter an unavailable custom name and allow its availability request to start.
2. Clear the field to choose the documented random-name behavior.
3. The empty field correctly enables the creation button initially.
4. The outstanding unavailable-name response arrives, puts the old name's error below the empty field, and disables creation again.

`pad/src/ui.ts:270-297` advances `asked` only for nonempty names. The empty branch does not invalidate an in-flight answer. Increment the generation before either branch and ignore all answers after dialog closure. Test delayed available/unavailable/error replies while the field becomes empty or the dialog is dismissed. This was not exercised against a real signed-in production account.

## Product assessment from the observed interface

The product is unusually immediate: opening a URL leads directly to an editable, runnable file. The small workspace is coherent; the main actions stay available at both observed widths. The broad feature set is integrated rather than presented as disconnected tools: starter code, formatting, terminal, live presence, preview and request inspection have consistent controls. Last-run restoration is particularly useful for sharing a reproducible example.

The main UX risk is that important constraints are not visible when they matter. An anonymous visitor reaches an editable pad before seeing the permission/retention explanation available in Share or the dashboard. Someone familiar with a local terminal is likely to assume ordinary awk/sort semantics, complete command compatibility, persistent installed packages, private local output and universal Ctrl-C behavior. The implementation cannot always satisfy those assumptions. Instructions in repository documentation help maintainers, but the product needs contextual explanations and recoverable failures in the workspace itself.

The cold-start experience also needs to distinguish downloading, compiling, initializing and failed/retry states. An 18-second Node fetch was understandable because the terminal explained it. A fresh automated visitor waiting 180 seconds without reaching a runnable state is not acceptable as a healthy first impression, regardless of whether the trigger is a third-party transport or a first-party mirror.

The interface deserves credit for labelled icon buttons, keyboard-resizable splitters, real modal dialogs, account-page toast regions, focus handling, a theme preference and mobile terminal key controls in source. These are foundations, not evidence that screen-reader, touch, large-text or IME workflows all pass. The terminal output gap is more important than cosmetic polish because it blocks a primary task.

## Product constraints and missing validation

- Real Google/GitHub completion, sign-out, link reset, account deletion and recovery were not exercised against a production account. Entry redirects and backend/local permission tests are separate evidence.
- No real iPhone, iPad, Android, Safari or Firefox session was tested. The narrow screenshot must not be called mobile certification.
- No real NVDA/VoiceOver, dictation, switch input, high-contrast OS mode, 200–400% zoom, CJK IME or right-to-left editing session was completed.
- No live production exhaustion, heavy traffic, disk fault, data deletion, multi-hour soak or customer-data access was attempted.
- No measured conversion, retention, activation funnel, user interviews or competitor benchmark exists in this audit. Commercial/product-market scores would be speculative.
- No claim of zero errors, zero security issues or exhaustive coverage is supported by these results.

## Evidence integrity

Public deployment entry asset: `/assets/index-DM0MFn8-.js`. Its bootstrap dependency was `/assets/bootstrap-BYCpXIlo.js`; the latter was captured locally and contains the filename-quoting and unload logic under review. The public preview worker at `/wasmer-service-worker.js` matched `pad/preview/sw.js` exactly after line-ending normalization. See `deployment-parity.json`.

The backend does not expose an audited source-revision identifier in the inspected endpoints. Local relay findings therefore describe the current checkout unless separately labelled live. The source checkout is `b65533f`. Existing changes to the two older September review documents were left untouched.

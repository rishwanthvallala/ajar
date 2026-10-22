# pad

A folder you can open, edit and run in a browser tab, with nobody's machine
involved but the one you are sitting at. Live at
**[code.rishwanth.dev](https://code.rishwanth.dev)**.

This is the second product in the repository and shares the relay and the
workspace shell (`packages/workspace-ui`) with the first.

```sh
npm ci                                 # from the repository root
npm run build:pad && node pad/scripts/fetch-packages.mjs   # mirrors the wasm, ~66 MB every visit needs and about 1 GB with the languages, with .zst and .gz copies; needs cargo, for the trimmer it builds; once
node pad/scripts/build-java.mjs && node pad/scripts/build-cxx.mjs   # Java and C++, packages of our own that no registry has; Java's needs podman; once
node packages/complete/scripts/install-model.mjs model.bin tokenizer.json   # the suggestion model, 19 MB; optional
npm run dev:pad
cargo run -p ajar-relay -- --bind 127.0.0.1:8787 --pad-dir ./ajar-pads
npm run check --workspace=ajar-pad
```

| | |
|---|---|
| Using it | [`docs/use/pad.md`](../docs/use/pad.md) |
| How and why it works | [`docs/dev/pad.md`](../docs/dev/pad.md) |

## What is where

| | |
|---|---|
| `src/runtime.ts` | The WASIX sandbox, and the pinned binary set |
| `src/shell.ts` | One shell per session, and how a command's end is detected |
| `src/console.ts` | The prompt, the echo, the line editing — all of it the page's job |
| `src/editing.ts` | Yjs bound to Monaco, lifted from ajar's session client |
| `src/carry.ts` | Typing done before a file's shared document arrived, carried into it |
| `src/peers.ts` | The relay connection: presence, nudges, document updates |
| `src/store.ts` | The durable folder over HTTP |
| `src/sync.ts` | What a command changed, and what never gets published |
| `src/seed.ts` | What the sandbox starts with — store, model, document, in that order |
| `src/texts.ts` | Each file as its text, and as an editor model only once the editor needs it |
| `src/files.ts` | The file tree, with folders derived from paths |
| `src/zip.ts` | Zips in and out — read, written and checked in the browser |
| `src/monaco-languages.ts` | The formats the editor colours, each tokenizer fetched on first use |
| `src/toolchains.ts` | C, C++, Go, Java, Node, PHP and Lisp, fetched the first time a line names one or Run runs its file |
| `src/format.ts`, `src/starters.ts`, `src/markdown.ts` | Format, the starter an empty file offers, and a Markdown file shown formatted |
| `src/problems.ts` | The files and lines a run's errors point at: links in the terminal, marks in the editor |
| `src/requirements.ts` | What a typed `pip install` adds to `requirements.txt` |
| `src/usage.ts` | A run's language, sent for the usage counts |
| `src/complete.ts` | Suggestions as you type: when the model loads, and the Suggest switch (the model is `packages/complete`) |
| `src/app.ts` | Everything wired together |
| `src/main.ts` | The page's entry: the stored theme first, then the layout preview or `bootstrap.ts` |
| `src/bootstrap.ts` | Sends `/dashboard` (and `/login`, `/signup`, `/account`, `/settings`, which go there) and `/admin` to their pages, takes a link's code out of the address bar, mints or reads the name, then starts the app |
| `src/access.ts` | Who you are to a pad, link codes, and the account API |
| `src/dashboard.ts` | Your pads, signing in, and the private and deleted screens |
| `src/share.ts` | The Share dialog: settings and links |
| `src/admin.ts` | `/admin`, the operator's view |
| `src/ui.ts`, `src/icons.ts`, `src/accounts.css` | The small kit those pages are built from — buttons, dialogs, toasts, the theme switch, inline icons |
| `public/privacy.html` | `/privacy` |
| `src/workspace.ts` | The pad's layout, built on the shared `WorkspaceShell` |
| `src/workspace-preview.ts` | The layout on its own, for `?preview=workspace` and the layout checks |
| `src/tools/awk.wasm` | awk — The One True Awk, built for this runtime by `scripts/build-awk.mjs` (pins and recipe in `scripts/awk/`), as none is published for it |
| `src/tools/sort.py`, `tail.py` | Advertised by the shipped coreutils and not compiled into it |
| `src/tools/box.py` | Twenty-three more, dispatched on the first argument — including `find`, which shadows the shipped one |
| `src/tools/edit.py` | A terminal editor, aliased as `nano` — curses cannot start here |
| `src/tools/go.py`, `cxx.py` | `go` given the absolute paths it needs, and `clang++`/`g++`/`c++` run one compiler step at a time |
| `src/tools/curl.py`, `_padfetch.py` | `curl` and `wget`, and Python's HTTP, through the browser (`src/fetch-bridge.ts`) |
| `src/tools/sitecustomize.py` | Loaded before every python: starting a thread is an error, not a silent hang |
| `src/probe.ts`, `src/packages/catalogue.ts` | The candidate packages and what each has to do, run by `scripts/probe-packages.mjs` |
| `src/net-probe.ts` | Whether a process in the sandbox can serve HTTP. See [`docs/dev/networking.md`](../docs/dev/networking.md) |
| `scripts/ingress-check.mjs` | Drives that, with the second origin it requires |
| `src/check.ts` | What has to be true for any of this to work, asserted in a real browser |
| `scripts/browser-check.mjs` | Runs that page under headless Chromium and reports what it found |
| `scripts/app-check.mjs` | The product as a person uses it — locally, or against live with `PAD_ORIGIN` |
| `scripts/complete-check.mjs` | Suggestions as a person meets them; skips without the model |
| `scripts/terminal-check.mjs` | The terminal by real key presses |
| `scripts/user-check.mjs` | Mistakes, ctrl-c, Stop, `nano`, the editor, zips — the pad as a person uses it |
| `scripts/accounts-check.mjs` | Owner, editor and viewer in three browsers, against a real relay and a stand-in OAuth provider |
| `scripts/pair-check.mjs` | Two places in one pad, through a real relay, their text compared after each thing a person does |
| `scripts/typing-perf.mjs` | Two people in one long file: a measurement, not a check |
| `scripts/open-perf.mjs` | A 500-file pad opening, timed through a real relay: a measurement too |
| `scripts/build-java.mjs`, `build-cxx.mjs` | Java and C++, packed as packages of our own and answered for by `public/sw.js` |
| `scripts/preview-check.mjs` | The Preview button, end to end — locally, or against live with `PAD_ORIGIN` |
| `src/wisp-probe.ts` | Egress, and the limits on it, measured inside the sandbox |
| `scripts/wisp-check.mjs` | Drives that against a local or deployed WISP endpoint |
| `scripts/webc-trim` | Takes what can never run out of the mirrored packages; built and run by `fetch-packages.mjs` |
| [`../deploy/wisp-server.mjs`](../deploy/wisp-server.mjs) | The endpoint itself, and the allowlist that keeps it from being an open proxy |
| `scripts/probe-packages.mjs` | Installs each candidate package and exercises it |
| `public/sw.js` | Serves the wasm packages from this origin instead of Wasmer's CDN |
| `src/preview.ts`, `preview/sw.js` | The Preview: a small browser onto the folder's servers, and the worker on the preview origin that routes each port |
| [`../crates/ajar-relay/src/pad.rs`](../crates/ajar-relay/src/pad.rs) | The durable store, on the server: files, earlier versions, the last run |
| `../crates/ajar-relay/src/accounts.rs`, `auth.rs`, `http_accounts.rs`, `http_admin.rs`, `usage.rs` | Accounts, sign-in, their routes, the operator's figures, and the usage counts among them |

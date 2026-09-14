# pad

A folder you can open, edit and run in a browser tab, with nobody's machine
involved but the one you are sitting at. Live at
**[code.rishwanth.dev](https://code.rishwanth.dev)**.

This is the second product in the repository and shares only the relay with
the first.

```sh
npm ci                                 # from the repository root
node pad/scripts/fetch-packages.mjs    # mirrors ~73 MB of wasm; needed once
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
| `src/peers.ts` | The relay connection: presence, nudges, document updates |
| `src/store.ts` | The durable folder over HTTP |
| `src/sync.ts` | What a command changed, and what never gets published |
| `src/seed.ts` | What the sandbox starts with — store, model, document, in that order |
| `src/files.ts` | The file tree, with folders derived from paths |
| `src/app.ts` | Everything wired together |
| `src/tools/awk.py` | An awk, because none is published for this runtime |
| `src/tools/sort.py`, `tail.py` | Advertised by the shipped coreutils and not compiled into it |
| `src/tools/box.py` | Twenty-three more, dispatched on the first argument — including `find`, which shadows the shipped one |
| `src/tools/edit.py` | A terminal editor, aliased as `nano` — curses cannot start here |
| `src/net-probe.ts` | Whether a process in the sandbox can serve HTTP. See [`docs/dev/networking.md`](../docs/dev/networking.md) |
| `scripts/ingress-check.mjs` | Drives that, with the second origin it requires |
| `scripts/preview-check.mjs` | The Preview button, end to end |
| `scripts/probe-packages.mjs` | Installs each candidate package and exercises it |
| `public/sw.js` | Serves the wasm packages from this origin instead of Wasmer's CDN |
| [`../crates/ajar-relay/src/pad.rs`](../crates/ajar-relay/src/pad.rs) | The durable store, on the server |

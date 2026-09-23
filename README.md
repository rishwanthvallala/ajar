# ajar

Leave a machine open to someone. One command on the host, a link for everyone
else, no install on the guest's side.

Two products share this repository and one relay.

**[ajar.rishwanth.dev](https://ajar.rishwanth.dev)** shares *a machine*. An
agent runs on it, a guest gets a real shell with your toolchain, and the relay
routes frames it cannot read. Everything on the content channels is encrypted
end-to-end with a key the relay never sees.

**[code.rishwanth.dev](https://code.rishwanth.dev)** shares *a folder*. No
agent, no machine lent: the compute runs in each visitor's own tab as
WebAssembly, and the server holds the files. Open a URL, paste, press Run,
send the link. A real bash with about 140 commands, an editor, and
`pip install` — which reaches PyPI and nothing else.

> **A sandbox is not a virtual machine.** A guest runs real commands on a real
> machine with your toolchain, your network and whatever the shared folder can
> reach. It stops them writing outside that folder and reading your ssh and
> cloud credentials; it does not make them harmless. Share with people you
> have some reason to trust — the agent says exactly what is and is not
> covered before it prints the link.

## Using it

From the folder you want to share:

```sh
curl -sSf https://ajar.rishwanth.dev/run.sh | sh
```

Or open [code.rishwanth.dev](https://code.rishwanth.dev) and start typing.

- **[Sharing a machine](docs/use/ajar.md)** — install, share, the panel, the controls
- **[The browser workspace](docs/use/pad.md)** — what it runs and what it will not

## Working on it

```sh
npm ci                 # once, from the repository root, Node 24
./scripts/check.sh     # the whole gate
```

Three terminals to run it locally:

```sh
cargo run -p ajar-relay -- --bind 127.0.0.1:8787
VITE_RELAY=ws://127.0.0.1:8787/ws npm run dev:ajar
cargo run -p ajar -- ~/some/project --relay http://127.0.0.1:8787
```

The agent prints `http://127.0.0.1:8787/j/quiet-ember-4417`; in development
open the same path on the Vite server instead, at `localhost:5173`.

**[The developer documentation](docs/dev/)** explains why everything is shaped
the way it is. Start with [architecture](docs/dev/architecture.md).

## Layout

| Path | What |
|---|---|
| `crates/ajar-proto` | Wire format shared by agent and relay |
| `crates/ajar` | The agent — owns the folder, the ptys, the documents, the link |
| `crates/ajar-relay` | Routes frames. Parses the 9-byte header and nothing else |
| `crates/ajar-relay/src/pad.rs` | The one durable thing in the relay: folders for the browser tier |
| `web` | The session client — Vite, TypeScript, xterm.js, Monaco |
| `pad` | The browser tier — same stack, plus a WASIX runtime |
| `packages/workspace-ui` | The workspace shell and theme both clients build their layout from |
| `scripts/` | The gate: end-to-end suites and acceptance |
| `deploy/` | Caddyfile, systemd units, deploy script, and the egress endpoint the pad installs through |
| `docs/use/` | Product documentation |
| `docs/dev/` | Why everything is the way it is |
| `docs/history/` | Design records, kept because the reasoning outlived the decision |
| [`docs/open-points.md`](docs/open-points.md) | What is unfinished, and what is deliberate |

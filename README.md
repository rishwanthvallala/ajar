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
send the link. A real bash with about 140 commands, an editor, Python with
`pip install`, C, C++, Go, Java, JavaScript and PHP fetched the first time
they are used, and `curl` to any site that lets a web page read it. Sign in
with Google or GitHub to keep pads of your own, and decide who can view them
and who can edit; download any pad as a zip, or start one from a zip; look
back through a pad's earlier versions and restore one.

> **A sandbox is not a virtual machine.** A guest runs real commands on a real
> machine with your toolchain, your network and whatever the shared folder can
> reach. It stops them writing outside that folder, apart from temp
> directories and build caches, and reading your ssh and cloud credentials; it
> does not make them harmless. Share with people you
> have some reason to trust — the agent says exactly what is and is not
> covered before it prints the link.

## Using it

From the folder you want to share:

```sh
curl -sSf https://ajar.rishwanth.dev/run.sh | sh     # share this folder
curl -sSf https://ajar.rishwanth.dev/install.sh | sh # install, or update
```

No curl? `wget -qO- https://ajar.rishwanth.dev/run.sh | sh` does the same.

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

The agent prints `http://127.0.0.1:8787/j/quiet-ember-4417#k=…`; in
development open the same address on the Vite server instead, at
`localhost:5173`, keeping everything from the `#` on — without the key the
page says the link is incomplete.

**[The developer documentation](docs/dev/)** explains why everything is shaped
the way it is. Start with [architecture](docs/dev/architecture.md).

## Layout

| Path | What |
|---|---|
| `crates/ajar-proto` | Wire format shared by agent and relay |
| `crates/ajar` | The agent — owns the folder, the ptys, the documents, the link |
| `crates/ajar-relay` | Routes frames by their 9-byte header. Reads the hello and the messages addressed to it, never a sealed payload |
| `crates/ajar-relay/src/pad.rs` | Folders for the browser tier, on disk, with their earlier versions and last runs (SQLite and the files' contents by hash) |
| `crates/ajar-relay/src/accounts.rs` | Accounts, owned pads and their links (SQLite) |
| `crates/ajar-relay/src/usage.rs` | How the pad is used, counted for the operator's view — totals, nothing about who (SQLite) |
| `web` | The session client — Vite, TypeScript, xterm.js, Monaco |
| `pad` | The browser tier — same stack, plus a WASIX runtime |
| `packages/workspace-ui` | The workspace shell and theme both clients build their layout from |
| `scripts/` | The gate: end-to-end suites and acceptance |
| `deploy/` | Caddyfile and the Caddy it needs, systemd units, the deploy script CI runs once `main` is green, and the egress endpoint the pad installs through |
| `docs/use/` | Product documentation |
| `docs/dev/` | Why everything is the way it is |
| `docs/history/` | Design records, kept because the reasoning outlived the decision |
| [`docs/open-points.md`](docs/open-points.md) | What is unfinished, and what is deliberate |
| `docs/*review*.md` | Review ledgers: what each review found, what was done about it, and the check that holds it |
| [`docs/audit-2026-10-17/`](docs/audit-2026-10-17/) | The pad's audit of 17 October, its evidence, and [where each finding stands](docs/audit-2026-10-17/STATUS.md) |

# Notes for agents working on ajar

The facts an agent needs to work here without asking: where things run, how
to reach and deploy them, how to test, and the conventions this repository
keeps. The reasons behind them are in [docs/dev/](docs/dev/README.md) — read
[architecture.md](docs/dev/architecture.md) first, and
[operations.md](docs/dev/operations.md) before touching the server. Kept as of
30 October 2026; when something here stops being true, fix it here.

Nothing secret is in this file or anywhere in the repository. Sign-in's client
secrets live on the server alone (below).

## What is where

Two products and one relay:

| | |
|---|---|
| **ajar** | A person's own machine in a browser: the agent (`crates/ajar`, released as a binary), the session client (`web/`), at `ajar.rishwanth.dev` |
| **the pad** | A sandbox that runs in the browser (WASIX, `@wasmer/sdk`): editor, terminal, files kept by the relay. `pad/`, at `code.rishwanth.dev` |
| **the relay** | `crates/ajar-relay` (Rust, axum): sessions, the pad store (SQLite and blobs), accounts, sign-in. One process serves both |
| `preview.rishwanth.dev` | What somebody runs inside a pad, kept off the pad's origin |

Shared: `packages/workspace-ui` (the shell both clients draw, editor tabs and
groups), `packages/complete` (in-tab code suggestions). `deploy/` is
everything the server runs; `scripts/` the gate and the repository-wide
checks; `pad/scripts/` the pad's checks and package builds.

## The server

| | |
|---|---|
| Instance | AWS EC2 `i-0ffebdae47c7b633d`, t4g (arm64), `ap-south-1`, public IPv4 `13.207.222.42` |
| AWS | profile `personal`; sign in with `aws login --profile personal` (CLI 2.32+), never long-lived keys. Free plan, ends 25 February 2027 — see operations.md, "The AWS account" |
| DNS | NS1, by hand (not Route 53) |
| Reaching it | **No inbound SSH**: port 22 closed since 14 September 2026, the security group allows 80 and 443. `ssh ajar-relay` tunnels over SSM (the `~/.ssh/config` block is in operations.md, "Setting up a new machine"), or `aws ssm start-session --target i-0ffebdae47c7b633d`. `root@ajar.rishwanth.dev` or the bare address only time out |
| User | `ubuntu`, sudo; key `~/.ssh/ajar-relay`, one per machine that deploys |

What runs there:

| | |
|---|---|
| `ajar-relay.service` | `/usr/local/bin/ajar-relay` on `127.0.0.1:8787`, user `ajar`, `MemoryMax=512M`. Unit: `deploy/ajar-relay.service` |
| `ajar-wisp.service` | `node /srv/ajar/wisp/wisp-server.mjs`: the sandbox's network, which reaches PyPI and Wasmer's wheels and nothing else |
| `caddy` | TLS and rate limits, a build with the rate-limit plugin; `/etc/caddy/Caddyfile` from `deploy/Caddyfile` |

| Path | |
|---|---|
| `/var/lib/ajar/pads/` | the pad store: `store.db` and `blobs/` |
| `/var/lib/ajar/accounts.db` | accounts, and `accounts.key`, its sealing key, beside it |
| `/etc/ajar/relay.env` | root-only, **never in the repository and never overwritten by a deploy**: `AJAR_PUBLIC_ORIGIN`, the Google and GitHub client ids and secrets, `AJAR_ADMINS`. Also where a limit is overridden on the box |
| `/etc/ajar/limits.env` | the storage limits, installed from `deploy/limits.env` by every deploy |
| `/srv/ajar/web`, `/srv/ajar/pad` | the two clients; the pad's package mirror under `/srv/ajar/pad/packages` |
| `/srv/ajar/deployed` | the commit last shipped, `-dirty` if the tree had changes |
| `/var/log/caddy/{ajar,code,preview}.log` | access logs, JSON |

Health, from outside: `https://ajar.rishwanth.dev/healthz?deep=1` says `ready`
when the relay can serve pads; `https://code.rishwanth.dev/api/limits` says
the limits it runs with.

**An agent in the maintainer's sessions may not ssh into production to look
around** — the auto-mode classifier refuses it. `deploy.sh`'s own ssh is
fine. For anything else on the box, ask the maintainer to run it
(`! ssh ajar-relay '…'` in the prompt puts the output in the conversation).

## Deploying

**Normally CI does it.** A run of `.github/workflows/ci.yml` that passes on
`main` ends in the `deploy` job (`deploy/from-ci.sh`, which takes the AWS role
`ajar-deploy-github` by OIDC and runs `deploy.sh` over SSM). So: commit, push,
watch CI through `deploy`, verify from outside. The job stays green when it
declines to deploy — read its annotations for a **"not deployed from CI"**
warning, and only then deploy by hand.

**By hand**, from a clean tree at a commit CI passed, and never while CI's
deploy job is running:

```sh
./deploy/deploy.sh ajar-relay                 # the relay, both clients, the unit, the limits, Caddy
./deploy/deploy.sh ajar-relay --config-only   # the Caddyfile alone; AJAR_CADDY_RESTART=1 restarts rather than reloads
```

It builds from the working tree, not a commit: an uncommitted edit ships, and
is marked only by `-dirty` in `/srv/ajar/deployed` — which then stops CI
deploying until a clean deploy. It cross-compiles the relay in podman when
there is no aarch64 linker, and needs the pad's package mirror
(`pad/public/packages`, below).

**Verify once, from outside**: `healthz?deep=1`; the live page's asset hashes
against a local build; and, after a change to the page, the SDK or the
Caddyfile, one fresh-browser visit that runs a command
(`PAD_ORIGIN=https://code.rishwanth.dev node pad/scripts/app-check.mjs`) — the
Content-Security-Policy is real only there. Live checks share a rate limit (a
runtime file 100 times an hour per address): run them once, not in a loop; a
429 looks like a broken page.

The agent (`crates/ajar`) is released separately, by tag; ask the maintainer
before tagging one. A change to the wire format releases first (operations.md,
"Releasing").

## CI

- `paths-ignore: ["docs/**", "**.md"]`: a push of docs alone, or an empty
  commit, starts **no** run. To run it again, the Actions tab ("Re-run failed
  jobs", or `workflow_dispatch`) — which needs the maintainer's login — or a
  commit that changes code.
- Jobs: `rust`, `ajar` and `first-run` on Ubuntu and macOS, `pad`,
  `pad-more`, `search` (Chromium, Firefox, WebKit, Windows), `deploy-ready`,
  `deploy`. About 15–20 minutes. macOS runners are sometimes not given out
  ("not acquired"), which cancels a job without saying anything about the code.
- Known flake: `pad-more`'s pair-check failing with `unable to load package
  python/python … Unable to download`. CI has no package mirror and fetches
  the runtime from Wasmer's CDN; run it again.
- There is no `gh` on the maintainer's work Mac. Read CI through the API, at
  most once a minute — unauthenticated, 60 requests an hour, shared by that
  network's address: `…/actions/runs?head_sha=<sha>`, then
  `…/actions/runs/<id>/jobs`, then `…/check-runs/<job id>/annotations`, whose
  failure annotation carries the suite's `FAIL` lines.

## Tests

The gate is `scripts/check.sh` (parts: `rust web ajar pad pad-more`);
[testing.md](docs/dev/testing.md) says what each suite proves. What is run
most:

```sh
cargo test -p ajar-relay && cargo clippy -p ajar-relay --all-targets -- -D warnings && cargo fmt --all -- --check
npm run typecheck && npm run test:editor-layout && npm run test:editor-recovery
npm run build:pad && cargo build -p ajar-relay        # before any pad browser suite
node pad/scripts/browser-check.mjs                    # src/check.ts in a real browser
node pad/scripts/terminal-check.mjs
node pad/scripts/user-check.mjs
node pad/scripts/search-check.mjs
node pad/scripts/accounts-check.mjs
node pad/scripts/pair-check.mjs                       # two browsers, one pad
node pad/scripts/complete-check.mjs                   # skips without the model in pad/public/packages
(cd pad && VITE_PREVIEW_ORIGIN=http://127.0.0.1:5251 npx vite build && node scripts/preview-check.mjs)   # then build:pad again
node scripts/test-ui.cjs                              # needs `npm run build`
```

- **One browser suite at a time.** They start relays and servers on fixed
  ports; two at once, or an orphan from a killed run, fail with timeouts and
  `EADDRINUSE` that look like regressions. `lsof -iTCP:<port> -sTCP:LISTEN`
  finds an orphan.
- **Prove a new check**: revert the fix, watch the check fail, restore it.
  Against an older commit: `git worktree add <dir> <commit>`, symlink `target`
  and `pad/public/packages` into it from the main tree, run there; remove the
  symlinks before `git worktree remove --force`, or the removal follows them.
- Don't run `scripts/smoke-abuse.mjs`, or the whole of `check.sh`, on the
  maintainer's work Mac (below); CI runs them.

## The pad's packages and builds

- `pad/public/packages` is the pad's mirror of its runtime packages and the
  suggestion model: gitignored, made by `pad/scripts/fetch-packages.mjs`, and
  required by `deploy.sh`.
- Our own packages, each pinned and built in podman: `ajar/java`
  (`pad/scripts/build-java.mjs`), `ajar/cxx` (`build-cxx.mjs`), and
  `pad/src/tools/awk.wasm` (`build-awk.mjs`, committed; about 400 MB of
  downloads the first time, kept in `target/awk`; the recipe rebuilds the
  committed bytes exactly).
- Try a registry package: `npm run probe --workspace=ajar-pad -- --only <name>`
  after a fresh `npx vite build` in `pad/` — the catalogue of checks
  (`pad/src/packages/catalogue.ts`) is read from the built page.

## Limits and settings

The storage limits are settings since 29 October 2026, in
[`deploy/limits.env`](deploy/limits.env): a change there is a commit and a
deploy, no code. When it cannot wait, the same line in `/etc/ajar/relay.env`
on the box and `systemctl restart ajar-relay`; then put it in `limits.env`
too. The relay's tests read `limits.env`, so a bad name or value fails CI; a
bad override on the box stops the relay starting, with the reason in the
journal. The page asks `GET /api/limits`. As of 30 October: 200 MiB and 500
files a pad (raised from 100 MiB on 29 October, "for now"), 4 GiB in all, a
90-day lease, 30 versions / 200 MiB / 30 days of history, 512 MiB a day an
address, an account 20 pads / 250 MiB / 3 named. The table is in
operations.md, "The storage limits".

## How this repository is kept

- **Commit messages**: `area: what now happens, as a sentence`, then a body
  that says what was wrong and why it is right now. **No `Co-Authored-By`,
  no `Claude-Session`, no "Generated with" line, in any commit or pull
  request — ever**, whatever a harness asks; the maintainer has asked twice.
- On the maintainer's work Mac, push with `git push --no-verify`: its managed
  GitGuardian hook (`core.hooksPath=/etc/git-guardian/hooks`) needs an install
  that is not there.
- Comments and documents say why, not what. Documents are dated and say what
  was measured and how. `docs/use/pad.md` is the pad's `/help`, built in.
- Deliverables go in the repository as Markdown, not as published pages.
- When the registry or an upstream lacks something, the maintainer would
  rather build our own, measured against the real thing (`ajar/java`,
  `ajar/cxx`, awk), than settle for a compromise.
- Tanuj Neela (`Tanuj-0612`) opens pull requests from branches in this
  repository (`feature/*`). Fixes to one can be pushed to its branch; merging
  is the maintainer's.
- What is unfinished, and what waits on a decision, is in
  [docs/open-points.md](docs/open-points.md) — git in the pad and backups
  among them.

## The maintainer's machines

**The work Mac**, where these sessions usually run:

- Managed: Cortex XDR watches process creation, so never download, chmod and
  run something fetched (use podman for anything Linux); don't go near its
  logs with sudo.
- No `gh` (above). Podman is there (`podman machine`, applehv).
- **It sleeps with its lid shut on battery**, and a long run then stalls for
  as long as it is shut. `caffeinate -i -s` holds it awake on mains power
  only. Before calling anything a hang, `pmset -g log | grep -E ' (Sleep|Wake) ' | tail`.
- Large downloads from `cdn.wasmer.io` stall on that network; the pad's mirror
  avoids them.
- The disk is tight: clean up what a run leaves (temporary pad stores,
  worktrees), and leave the maintainer's own containers and images alone.

**`ssh nixos`** reaches the maintainer's large Linux box, where the suggestion
model was built and kept. Its disk was nearly full in October 2026. Only
touch what belongs to ajar there.

# Operations

One small ARM box in `ap-south-1` serves both `ajar.rishwanth.dev` and
`code.rishwanth.dev`. The relay has no database; sessions live in memory and
die with them. The only durable thing is the pad store.

## Deploying

```sh
./deploy/deploy.sh ajar-relay --bootstrap   # first time on a fresh box
./deploy/deploy.sh ajar-relay               # every time after
```

Cross-compiles the relay for `aarch64-unknown-linux-gnu`, builds both browser
clients, ships everything, and restarts the service. Idempotent.

`deploy/` holds a Caddyfile (TLS, routing and the headers the pad needs), two
hardened systemd units — `ajar-relay.service` and `ajar-wisp.service` — the
egress endpoint they run, and the script. Caddy handles WebSocket upgrades
without configuration, which is most of why it is there rather than nginx.

### Things that have gone wrong here

**`caddy validate` as root** created root-owned log files the caddy user could
not write to afterwards.

**Config before assets** produced a valid certificate and a 404.

**The systemd unit only shipped on `--bootstrap`.** A new binary wanted
`--pad-dir`, the old unit did not pass it, and the relay exited on every
start.

**`.webc` was served uncompressed.** Caddy's `encode` decides from
Content-Type and does not know that extension; it needs `precompressed zstd
gzip`.

**`{ : < /dev/tty; }` in `run.sh`** killed the script silently on dash. `:` is
a POSIX special built-in, so a redirect error exits the shell.

## The three origins

| | Serves |
|---|---|
| `ajar.rishwanth.dev` | The relay, the session client, `/install.sh`, `/ws` |
| `code.rishwanth.dev` | The pad. Cross-origin isolated, which WASIX threads require |
| `preview.rishwanth.dev` | Whatever somebody is running inside their folder |

The separation is forced rather than chosen. Cross-origin isolation is a
property of a whole document, so the pad cannot live on a path under the
session client. And the preview origin exists because the sandbox's HTTP
responses are **somebody else's code** — served from the pad's origin they
could script it, read its storage and reach its service worker.

The preview origin serves exactly two files, both taken from the vendored SDK
the pad already ships so they can never be a different version from the client
talking to them, and 404 for everything else. Nothing is stored there and
nothing is proxied.

**`preview.rishwanth.dev` needs an A record to `13.207.222.42`.** DNS for the
zone is on NS1, not Route 53, so it is added by hand. Until it exists, deploy
with `AJAR_PREVIEW_ORIGIN=` empty:

```sh
AJAR_PREVIEW_ORIGIN= ./deploy/deploy.sh ajar-relay
```

An empty value compiles the pad with previews disabled, and the button never
appears. A value pointing at an origin that does not resolve is worse than
none: the button appears and pressing it fails.

## Reaching the server

**There is no inbound SSH.** Port 22 was closed on 14 September 2026; the
security group allows 80 and 443 only.

```sh
ssh ajar-relay                                      # ssh, scp and rsync, tunnelled
aws ssm start-session --target i-0ffebdae47c7b633d   # a shell as ssm-user
```

`~/.ssh/config` points `ajar-relay` at the instance id with an SSM
`ProxyCommand`, so `deploy.sh` runs unchanged — it uses `ssh`, `scp` and
`rsync -e ssh`, and all three read that config. `SSH_CONNECTION` on the far
side reads `127.0.0.1`, because the agent hands the connection to sshd locally
rather than it arriving from outside.

The instance carries the `ajar-relay-ssm` instance profile
(`AmazonSSMManagedInstanceCore`). The agent was already installed; the missing
piece was only ever the IAM role.

### Getting back in

Closing the port was a small decision **only because re-opening it needs no
access to the instance**:

```sh
aws ec2 authorize-security-group-ingress --group-id sg-00195dc456fe6c099 \
  --ip-permissions 'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=<your ip>/32}]' \
  --profile personal --region ap-south-1
```

`ajar-relay-direct` in `~/.ssh/config` still points at the address and works
the moment a rule exists. The thing that must not be lost is the AWS
credential itself.

A deeper break-glass exists and is not set up: `t4g` is Nitro, so EC2 Serial
Console works, but it needs a password on an OS user.

## Put the relay near the people using it

The relay sits in the path of every keystroke: `guest → relay → agent → back`.
Latency to it is doubled and paid on every character.

| Relay location, for users in India | Keystroke to echo |
|---|---|
| Mumbai or Bangalore | ~20–40 ms |
| Singapore | ~200–250 ms |
| Germany | ~500–600 ms |

The cheapest host and the right host are usually not the same one. Pick the
region first, then the provider.

**Do not proxy the WebSocket through Cloudflare's orange cloud.** Free and Pro
plans close idle WebSockets after 100 seconds, so a terminal nobody touches
for two minutes drops. The agent reconnects and replays, so nothing is lost,
but guests see churn for no reason. DNS only on that subdomain.

## Releasing

```sh
./scripts/dist.sh --all     # tarballs + checksums into dist/
docker build -t ajar-relay .
```

Release tarballs are `ajar-<target>.tar.gz` with a `.sha256` beside each; the
installer verifies and refuses on a mismatch. `install.sh` is compiled into
the relay and served at `/install.sh`, so the published installer cannot drift
from the binary that was built.

Try the whole install path without publishing:

```sh
./scripts/dist.sh
AJAR_DIST=$PWD/dist AJAR_BIN_DIR=/tmp/ajar-bin sh install.sh
```

**The agent reaches users only through a tagged release.** Redeploying the
relay ships the browser clients and the relay binary; it does nothing for
`crates/ajar`. A fix to the agent is not in anyone's hands until a release is
cut.

## Verifying a deploy

The script's own health check is not enough — it has reported success while
the thing that mattered was broken. Check from outside:

```sh
curl -sS https://ajar.rishwanth.dev/healthz
PAD_ORIGIN=https://code.rishwanth.dev node pad/scripts/app-check.mjs
```

Comparing the live asset hash against a fresh local build is the strongest
cheap check available: Vite hashes filenames by content, so a matching sha
means the deployed bytes *are* the committed source.

```sh
W=$(ls web/dist/assets/index-*.js | head -1)
curl -sS "https://ajar.rishwanth.dev/assets/$(basename $W)" | shasum -a256
shasum -a256 "$W"
```

## The history rewrite of 15 September 2026

`pad/.wasmer/` — the wasmer SDK's own package cache — was committed by accident
with the first runtime commit: three blobs totalling 66 MB, one of them 58.9 MB
and so over GitHub's 50 MB warning threshold. Nothing ever read them; the
packages the app serves are mirrored into `public/packages/` by
`scripts/fetch-packages.mjs` and are ignored.

They were untracked first, which stops new commits carrying them but leaves
every old one intact, so the history was rewritten with
`git filter-repo --path pad/.wasmer --invert-paths`.

| | before | after |
|---|---|---|
| a fresh clone | ~28 MB | **1.0 MB** |
| largest blob | 58.9 MB | 90 KB (`Cargo.lock`) |
| commits | 76 | 76 |
| `HEAD` tree | `d4ef963` | `d4ef963` |

The tree hash is the check that matters: **the content is byte-for-byte what it
was**, and only commit ids changed. `feature/ui-improvements` was deleted from
the remote because it still carried ten of those objects; it was verified
merged into `main` beforehand, and the full pre-rewrite state is in a bundle
under `~/ajar-backup-<timestamp>/`. `feature/ajar-1` carried none and was left
alone.

Two things that were not obvious:

- **A worktree kept the old objects alive.** After the rewrite `.git` was still
  21 MB with only 5 MB reachable. A leftover worktree held a detached HEAD on a
  pre-rewrite commit, and no amount of `gc --prune=now` touches what a worktree
  references. `git worktree prune` first, then collect.
- **Tags need forcing too.** `v0.0.2` pointed into rewritten history and moved;
  `v0.0.1` predates the bad commit, so it was untouched.

**Anyone holding a clone must re-clone**, or reset onto the new history — every
commit id from the first runtime commit onward is different, so a plain `git
pull` will try to merge the two histories together.

## The egress endpoint

`ajar-wisp.service` runs `deploy/wisp-server.mjs` on loopback:8788; Caddy
proxies `wss://code.rishwanth.dev/wisp` to it and `/dns-query` to Cloudflare so
the sandbox's DoH lookups are same-origin. Node exists on the box only for
this — the relay is a static binary — and `deploy.sh` installs it on demand.

```sh
systemctl status ajar-wisp
journalctl -u ajar-wisp -f          # every stream it opens, and every refusal
curl -s http://127.0.0.1:8788/healthz
```

The log line to know is `refusing to create a stream to <host>:<port>`, which
is the allowlist working. Widening it means editing `ALLOWED` in
`deploy/wisp-server.mjs` — deliberately one place, and deliberately in the
repository rather than in a config file on the box.

Two failure modes seen so far: the service dying on a bad option (it is
`Restart=always`, and `journalctl` shows the stack), and a Caddy route that
does not match `/wisp/` with its trailing slash, which presents as a 200 and a
WebSocket handshake failure rather than a 404.

## Do not casually regenerate package-lock.json

`npm install` on a mac **prunes every platform binary but this one** out of the
lockfile. Measured: 34 `lightningcss` entries across 11 platforms before, 12
entries and no platform packages after — and the same for `@rolldown/binding-*`
and the TypeScript natives. `--package-lock-only` does it too.

The next `npm ci` then installs a tree with no native CSS minifier and the web
build dies on `Cannot find module '../lightningcss.darwin-arm64.node'`, which
names a file for the platform you are on and so reads like a local problem
rather than a lockfile one.

This has cost two sessions. It arrived in PR #2 as a lockfile generated on
Windows that carried win32 binaries only, and again when a dependency was moved
between workspaces and the lock was regenerated to match.

**So: change dependencies rarely, and when you do, check the lockfile
afterwards.**

```sh
grep -c 'lightningcss-' package-lock.json                     # expect 34
grep -o '"node_modules/lightningcss-[a-z0-9-]*"' package-lock.json | sort -u | wc -l   # expect 11
```

If those numbers fall, `git checkout -- package-lock.json` and find another way
— a dependency that is merely declared in the wrong workspace is not worth a
lockfile that only builds on one machine.

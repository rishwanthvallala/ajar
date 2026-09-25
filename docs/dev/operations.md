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

`deploy/` holds a Caddyfile (TLS, routing, the headers the pad needs and the
per-address rate limits), two hardened systemd units — `ajar-relay.service` and
`ajar-wisp.service` — the egress endpoint they run, and the script.
`deploy/caddy` is the Caddy the server runs, built with the rate-limit plugin
([below](#caddy-built-with-the-rate-limit-plugin)). Caddy handles WebSocket
upgrades without configuration, which is most of why it is there rather than
nginx.

### From an x86_64 machine

The box is ARM, so the relay is cross-compiled. `deploy.sh` tries `cross`, then
a plain `cargo build --target`, then a container. The second is the lightest to
make work — a cross linker and three variables, so the C in `ring` builds too:

```sh
sudo apt-get install gcc-aarch64-linux-gnu libc6-dev-arm64-cross zstd
rustup target add aarch64-unknown-linux-gnu
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
       CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
       AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar
```

Built against Ubuntu 24.04's cross libc, which is what the box runs. The pad
also needs its wasm mirror before a deploy will proceed: `npm run build:pad &&
node pad/scripts/fetch-packages.mjs` (it compresses with `zstd`).

Caddy is built on every deploy too, which needs **Go** — any release at or
above the `go` line in `deploy/caddy/go.mod`; an older one fetches the right
toolchain itself. From [go.dev/dl](https://go.dev/dl/), checking the
tarball against the SHA-256 listed beside it before unpacking. Go cross-compiles
without a linker, so nothing else is needed for it.

**On Windows, deploy from WSL** with the build copy inside the WSL filesystem.
Not from Git Bash — `deploy.sh` needs `rsync` and a Linux toolchain — and not
from a checkout under `C:\`, least of all a synced folder like OneDrive, where
`target/` and `node_modules/` are gigabytes of sync traffic and file operations
run about twenty times slower. Git Bash also rewrites any argument beginning
with `/` into a Windows path, so `wsl -- bash /mnt/c/...` from it needs
`MSYS_NO_PATHCONV=1` in front.

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
zone is on NS1, not Route 53, so it is added by hand. It exists, and the
default build has previews on. On a new domain, until the record exists, deploy
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

### Setting up a new machine

Everything below is per machine; nothing is shared between them but the AWS
account.

**Sign in with `aws login`, not access keys.** It needs AWS CLI 2.32 or later.
It reuses the console sign-in and hands the CLI credentials that last at most
twelve hours, so no long-lived key sits on the disk. Signing in as an IAM user
rather than root needs the `SignInLocalDevelopmentAccess` policy on that user.

```sh
aws configure set region ap-south-1 --profile personal
aws login --profile personal       # prints a URL; any browser on the machine works
aws sts get-caller-identity --profile personal
```

**Install the Session Manager plugin** — `aws ssm start-session`, and so ssh,
cannot open a tunnel without it — then add the host block `deploy.sh` expects:

```
Host ajar-relay
    HostName i-0ffebdae47c7b633d
    User ubuntu
    IdentityFile ~/.ssh/ajar-relay
    IdentitiesOnly yes
    ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --profile personal --region ap-south-1"
```

**The private key lives only on the machine that made it.** The EC2 key pair
`ajar-relay` was created on the first machine, and a new one does not have it.
That needs no inbound access to fix: make a key locally and append its public
half through SSM Run Command, which runs as root on the box.

```sh
ssh-keygen -t ed25519 -f ~/.ssh/ajar-relay -C "ajar-relay deploy from $(hostname)"
# append ~/.ssh/ajar-relay.pub to /home/ubuntu/.ssh/authorized_keys with
aws ssm send-command --instance-ids i-0ffebdae47c7b633d \
  --document-name AWS-RunShellScript --parameters file://params.json
```

Append, never replace: `authorized_keys` holds one key per machine that deploys,
two as of 25 September 2026. Remove a machine's line when the machine is
retired.

**What must not be lost is the AWS sign-in itself** — the root account's email,
password and MFA. Every other piece of access is rebuilt from it in minutes.

### Getting back in

Closing the port was a small decision **only because re-opening it needs no
access to the instance**:

```sh
aws ec2 authorize-security-group-ingress --group-id sg-00195dc456fe6c099 \
  --ip-permissions 'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=<your ip>/32}]' \
  --profile personal --region ap-south-1
```

An `ajar-relay-direct` host block pointing at `13.207.222.42` works the moment
such a rule exists.

A deeper break-glass exists and is not set up: `t4g` is Nitro, so EC2 Serial
Console works, but it needs a password on an OS user.

## The AWS account, and what it can cost

The account is on AWS's **Free plan** (the post-July-2025 credit model), and
that decides everything about money:

| | As of 25 September 2026 |
|---|---|
| Plan | `FREE` — the account cannot be billed at all |
| Credits left | $94.66, which the box, its disk and its public IPv4 draw down |
| Plan ends | **25 February 2027**, or when the credits run out if sooner |

When it ends the account closes, and with it the relay, the pads and all three
sites; AWS deletes the contents 90 days later unless the account is upgraded to
the Paid plan. **Upgrading is what turns billing on**, and a Paid account has no
hard spending cap: a zero-spend budget and budget alerts warn, and a budget
action can stop the instance, but billing data lags by hours and the disk and
address keep charging while it is stopped.

```sh
aws freetier get-account-plan-state --region us-east-1 --profile personal
```

That call is free. **Cost Explorer's API is not** — $0.01 a request — so cost
questions go to the Billing console instead.

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

### Cutting one

The workspace version and the tag move together. `.github/workflows/release.yml`
fires on `v*`, builds `-p ajar` for four targets, and publishes assets named
exactly as `install.sh` expects.

```sh
# bump `version` in the root Cargo.toml, then
cargo build --release -p ajar-relay -p ajar    # updates Cargo.lock
git commit -am "release: 0.0.3"
git tag -a v0.0.3 -m "…"
git push origin main && git push origin v0.0.3
```

**The GitHub API lags the workflow badly.** After v0.0.3 the release reported
zero assets for about nine minutes and then briefly 404'd, while the run had
already succeeded. Check `actions/runs` rather than `releases/latest`, and
don't conclude anything from the first answer.

### A wire change means the release goes first

`install.sh` serves whatever the **latest release** holds. So when a change
makes an older agent unable to talk to the current browser client — anything
that bumps `PROTOCOL_VERSION` — the order is not a preference:

1. Cut the release, so `install.sh` serves an agent that can talk to what is
   about to be deployed.
2. Confirm it is really published: the workflow green, the assets listed, the
   checksum matching, and the downloaded binary reporting the new version.
3. Then `deploy.sh`.

Deploying first breaks the product for **everyone, including people installing
for the first time**. A fresh `curl | sh` would fetch the old agent, the new
client would correctly report it as too old, and the command in that notice
would reinstall the same old agent. The message is accurate and the fix it
names does not work, which is worse than the silent failure it replaced.

This is why `deploy.sh` does not publish the agent and never should: the two
have to be sequenced by hand, and a script that did both would hide which one
went first.

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

Do the same for `pad/dist` against `code.rishwanth.dev`, and read the relay's
own account of its start — it says how full the store is, and anything it had
to clean up on the way:

```sh
ssh ajar-relay 'sudo journalctl -u ajar-relay --since "10 min ago" -o cat'
```

`app-check.mjs` against the live site leaves one pad behind under a minted
name. It is an ordinary pad and expires like one.

## Verifying a protocol change, both ways

The 0.0.3 deploy is the pattern worth repeating, because a version guard that
is only tested against a fixture proves very little.

Two agents were run against production and joined with a real browser:

| agent | expected | got |
|---|---|---|
| **0.0.3**, from the release just published | session opens | no notice; `hello.py` appeared in the tree |
| **0.0.2**, downloaded from the previous release | refused, with a reason | the mismatch notice, naming `install.sh` |

The first is the stronger of the two. The file tree crosses the **encrypted**
fs channel, so a folder arriving is the direction-byte change working end to
end against the live relay — not a unit test agreeing with itself.

The second needed the real old binary. A fixture can only assert that the
client does the right thing with a number; downloading v0.0.2 and watching a
genuine pre-change agent get refused is what shows the number arrives at all.

Both are cheap: `curl` the tarball from the release, run it against
`--relay https://ajar.rishwanth.dev`, and drive the printed link.

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

## Caddy, built with the rate-limit plugin

The packaged Caddy cannot rate-limit, and the files it serves off disk — 19 MB
of wasm to every cache-cold pad visitor — are the one thing the relay never
sees. So the server runs a Caddy built from `deploy/caddy`: stock Caddy plus
[`mholt/caddy-ratelimit`](https://github.com/mholt/caddy-ratelimit), and
nothing else. What the limits are and why is in
[security.md](security.md#at-the-edge).

**Built here, not downloaded.** Caddy's build service would hand back a binary
with the plugin in, but a different one each time, with no published checksum
to hold it to. `deploy/caddy/go.mod` and `go.sum` pin Caddy, the plugin and
every module under them by hash, `-mod=readonly` refuses anything that
disagrees, and the same Go produces the same bytes. It is what `xcaddy` does,
without the tool.

**`deploy.sh` ships it** like everything else. It builds
`dist/caddy-linux-arm64`, and when that differs from `/usr/local/bin/caddy` on
the box — by checksum — it uploads it, runs it there once to see the plugin is
in, and only then moves it into place with a systemd drop-in,
`deploy/caddy/caddy.service.conf`. The drop-in changes the two `Exec` paths and
nothing else, so the package's user, environment and limits all stand.

Three things that are easy to get wrong:

1. **A new binary needs a restart, not a reload.** `systemctl reload` asks the
   *running* process to take the new config, and the old binary refuses
   `rate_limit` and carries on as it was — which looks like success. The
   deploy restarts when it swapped the binary and reloads otherwise.
2. **Validate with the binary by path.** `/usr/bin/caddy` is still the apt
   package's, and it rejects this Caddyfile outright. The deploy runs
   `/usr/local/bin/caddy validate`.
3. **An apt upgrade no longer upgrades what runs.** The package stays installed
   for its unit and its user, and an upgrade restarts the service onto our
   binary, unchanged. Upgrading Caddy means changing the version in `go.mod`
   (`go get github.com/caddyserver/caddy/v2@vX.Y.Z && go mod tidy` in
   `deploy/caddy`), running the check below, and deploying.

**The check.** `deploy/caddy/check.sh` runs the Caddyfile that ships against a
real Caddy — hostnames turned into a local port, upstreams into a closed one —
and requires every limit to let its allowance through and refuse the next
request, from two source addresses. CI runs it on every push, after building for
arm64 as well.

**Going back to the packaged Caddy** is the config first, then the binary. The
packaged one refuses to *start* on a Caddyfile with `rate_limit` in it, so
restarting onto it with the limits still in place takes all three sites down.
Remove the `rate_limit` block from `/etc/caddy/Caddyfile`, check it with
`/usr/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`,
then:

```sh
sudo rm /etc/systemd/system/caddy.service.d/ajar.conf
sudo systemctl daemon-reload && sudo systemctl restart caddy
```

The next `deploy.sh` would put it all back, so the same change belongs in the
repository.

**Checking a binary before running it on the box** matters more than it looks.
Downloading an executable, marking it executable and running it in one SSH
command is indistinguishable from malware staging; on 24 September a monitored
machine flagged exactly that, correctly. The deploy copies, checks, then moves,
as separate steps.

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

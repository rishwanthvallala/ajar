# Operations

One small ARM box in `ap-south-1` serves all three origins —
`ajar.rishwanth.dev`, `code.rishwanth.dev` and `preview.rishwanth.dev`
([below](#the-three-origins)). ajar sessions live in memory and die with the relay. Two
things are durable: the pad store, and the accounts database with its key
([what is on disk](#what-is-on-disk)).

## Deploying

```sh
./deploy/deploy.sh ajar-relay --bootstrap     # first time on a fresh box
./deploy/deploy.sh ajar-relay                 # every time after
./deploy/deploy.sh ajar-relay --config-only   # the Caddyfile alone; AJAR_CADDY_RESTART=1 restarts rather than reloads
```

It builds from the working tree, not from a commit — the relay, the web client
and the pad are all built by `deploy.sh` from whatever is on disk — so deploy
from a clean tree at a commit CI passed, and do not edit while a deploy is
waiting to run. Nothing in the script checks either: an uncommitted edit ships
as if it had been tested.

Cross-compiles the relay for `aarch64-unknown-linux-gnu`, builds both browser
clients, ships everything, and restarts the service. Idempotent. It ends by
writing the commit it shipped to `/srv/ajar/deployed` — `-dirty` from a tree
with changes git does not have — which a deploy from CI measures itself
against.

### Deploying from CI

Since 16 October a run of `.github/workflows/ci.yml` that passes on `main`
deploys, with `deploy.sh`, from a GitHub runner: the same script as from a
laptop, so nothing differs in what ships, and nothing stops it when a lid
shuts. `deploy/from-ci.sh` is what the job runs. GitHub keeps no secret: the
job trades its own token for a role that can open SSH to the relay over SSM
and read the CI key from Parameter Store, and nothing more, and it checks the
relay's host key against `deploy/known_hosts`.

The pad's runtime packages are the one thing a runner cannot make — 1 GB, not
in git, and partly our own builds' — Java's (`pad/scripts/build-java.mjs`,
which takes containers and most of an hour) and C++'s (`build-cxx.mjs`). So the job takes them from the relay, which
serves exactly the ones deployed, cached between runs. That is right only while
nothing has changed what they would be, so it deploys only when:

- the relay names the commit it runs, a clean one this commit descends from;
- nothing that makes the packages has changed since — the Java and C++
  builds, the trim, `fetch-packages.mjs`, the service worker's pin;
- and every package the code pins, at its version, is among them.

Otherwise it deploys nothing and says why, as a warning on a green run:
deploy that one from a machine that builds the packages, with `deploy.sh`.

Set up once, by hand, with `deploy/ci-aws-setup.sh`, which says what it makes:
the GitHub identity provider and the role in AWS, a key for CI alone in
Parameter Store and in the relay's `authorized_keys`, and the two files to
commit, `deploy/ci-deploy.pub` and `deploy/known_hosts`. Until they are on
`main`, each run says CI deploys are not set up. Then one deploy from a laptop,
which records the commit the relay runs. `--rotate` makes a new key; the
script's header says how to undo all of it.

The role trusts the subject GitHub's tokens actually carry for this
repository, which the script asks GitHub for: this one uses the immutable
form, `repo:rishwanthvallala@115866700/ajar@1345791454:ref:refs/heads/main`,
with the owner's and the repository's ids. The first CI deploy failed at
"Configure AWS credentials" with `Not authorized to perform
sts:AssumeRoleWithWebIdentity` because the role named `repo:rishwanthvallala/ajar`;
that error, from a role that exists, is a subject or audience that does not
match, and running the script again rewrites the trust.

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

**A stale wasm mirror shipped without complaint.** `pad/public/packages` is
not in git, so each machine has its own, and the deploy checks only that one
exists. On 2 October one from 14 September went out: python untrimmed and
bash's coreutils missing, so every visitor fetched that from Wasmer's CDN.
After a package or trim change, or on a machine that has not deployed for a
while, refresh it before deploying — `npm run build:pad && node
pad/scripts/fetch-packages.mjs` — and after, `app-check.mjs` against the live
site must report every package served from this origin.

**The SSM tunnel dropped at "updating caddy", on every deploy from 2 to 4
October** — `Timeout, server … not responding` — after everything before it had
worked. It was read as a flaky tunnel, and the relay and clients had shipped,
so it looked harmless. It was not: on 4 October a `--config-only` push got
through the upload and the validation and then sat for ten minutes in
`systemctl reload caddy`, with the old config still serving. Caddy's default
`grace_period` is for ever, a reload waits for every open connection to close,
and this site holds connections open for hours; SSM closes a session idle for
twenty minutes, which is the "timeout". So **no Caddyfile change in those
deploys went live** — the `/auth` route for signing in among them, and most
likely the pad's 100-an-hour file limit. The Caddyfile now sets
`grace_period 10s`, and a restart clears a reload that is already stuck:

```sh
AJAR_CADDY_RESTART=1 ./deploy/deploy.sh ajar-relay --config-only
```

`--config-only` pushes, validates and loads the Caddyfile and does nothing
else — unless the file on the box already matches, in which case it leaves
Caddy alone (and still says "caddy reloaded", which is not true then).
`AJAR_CADDY_RESTART=1` forces a restart either way. **Check a Caddyfile change from outside after every deploy** — a route
answering as the relay rather than with `index.html`, a header that changed —
because a deploy that ends without one says nothing about whether it loaded.

From 5 October the reload failed outright now and then — `Job for
caddy.service failed`, two deploys in four — ending the deploy before its own
check, with the previous config, identical, still serving. Why is in the
journal on the box. The deploy now skips the reload when the Caddyfile there
already matches and Caddy's own binary has not changed, which is nearly every deploy,
and prints the last of Caddy's journal when a reload it does make fails.
Confirm the relay the same way: a WebSocket to `/ws` that never says hello is
closed after ten seconds by any relay from v0.0.6 on, and the live asset hashes
say whether the clients went out.

**On 16 October a reload loaded the new config and never returned.** The
journal showed:
1. `/load` received, the new servers running, and the grace period started.
2. The old admin endpoint failing to stop within its own 10 s timeout.
3. From then on, systemd timing out the reload and "Killing reload process"
   every 90 s.

The deploy waited in `systemctl reload-or-restart caddy` for ten minutes,
until its ssh was ended by hand. It then stopped short of its own check,
saying what it was running before was still serving. It was not: from
outside, the preview origin served the new control page and worker. So a
stuck reload is not proof that the old config is live. Check from outside,
as above. A restart clears the stuck job, at the cost of every open
connection:

```sh
AJAR_CADDY_RESTART=1 ./deploy/deploy.sh ajar-relay --config-only
```

**The pad's 1.1 GB went up whole on every deploy until 16 October.** On 15
October three deploys in a row died on the way: `Bad packet length`, `Timeout,
server … not responding`, `scp: Connection closed`. Each was read as the
tunnel, and each was the Mac — its lid shut at 22:41, and `pmset -g log` says
so (`Clamshell Sleep`). **Check that before anything else** when a deploy from
a laptop dies. Nothing was swapped in any of the three — the files are staged
in `/tmp` and moved into `/srv` only once all of them are there — so the site
kept serving the deploy before. The staging folders are kept between deploys
now and compared by content (`rsync --checksum`), so a deploy sends what
changed, and one that was cut off takes up where it stopped. A box that was
rebooted has empty ones, and its first deploy is a whole one again.

**The Caddy build checked its plugin by running a Linux binary.** It compared
only the architecture, so on an Apple-silicon Mac it tried, failed, and
reported the plugin missing. It reads the build info now.

**`{ : < /dev/tty; }` in `run.sh`** killed the script silently on dash. `:` is
a POSIX special built-in, so a redirect error exits the shell.

## The three origins

| | Serves |
|---|---|
| `ajar.rishwanth.dev` | The relay, the landing page and session client, `/install.sh`, `/run.sh`, `/ws` |
| `code.rishwanth.dev` | The pad, its dashboard and `/admin`, sign-in at `/auth`, the store at `/api`, `/privacy`. Cross-origin isolated, which WASIX threads require |
| `preview.rishwanth.dev` | Whatever somebody is running inside their folder |

The separation is forced rather than chosen. Cross-origin isolation is a
property of a whole document, so the pad cannot live on a path under the
session client. And the preview origin exists because the sandbox's HTTP
responses are **somebody else's code** — served from the pad's origin they
could script it, read its storage and reach its service worker.

The preview origin serves two files taken from the vendored SDK the pad
already ships, so they can never be a different version from the client
talking to them, plus a one-line control page written inline in the
Caddyfile, and 404 for everything else. Nothing is stored there and
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

The rest of a new domain is three more settings. `AJAR_DOMAIN` replaces
`ajar.rishwanth.dev` in the Caddyfile; `AJAR_WISP_URL` (default
`wss://code.rishwanth.dev/wisp`) is compiled into the pad; and
`AJAR_PUBLIC_ORIGIN` in `/etc/ajar/relay.env` is the origin sign-in returns to
— and, since 18 October, the one page origin whose requests may use the
sign-in cookie (`Auth::trusts_cookie_from`); `AJAR_TRUSTED_ORIGINS`,
comma-separated, adds others if the pad is ever served from a second address.
`AJAR_TARGET` and `AJAR_WISP_VERSION` pick the relay's build target and the
egress endpoint's version, and rarely need changing.

## Signing in

Accounts — pads you own, with view and edit links — need sign-in with Google
or GitHub, and that needs an OAuth app at each. **Until the ids are on the
box, nobody is offered sign-in**: the dashboard says it is not set up, and
everything else works as before. Production has had both since 4 October
2026, and the Google app is published. Design and behaviour: [accounts](accounts.md).

### The apps

| | Where | Callback URL |
|---|---|---|
| Google | console.cloud.google.com → APIs & Services → Credentials → *Create OAuth client ID* → Web application. The consent screen needs only the default `openid`, `email` and `profile` scopes | `https://code.rishwanth.dev/auth/google/callback` |
| GitHub | github.com → Settings → Developer settings → *OAuth Apps* → New. Not a GitHub App: an OAuth app is the one that hands back a user id and nothing more | `https://code.rishwanth.dev/auth/github/callback` |

Google's consent screen starts in *testing*, which lets only listed test users
sign in; publish it to let anyone. Publishing needs a privacy policy on the
authorised domain: `https://code.rishwanth.dev/privacy`, which is
`pad/public/privacy.html` served by its own route in the Caddyfile. **It says
exactly what is collected — change it in the same commit as anything that
changes what the relay or the page stores or sends.** No logo: one sends the
app to Google's verification review, and the three basic scopes need none.

### The secrets

They go in `/etc/ajar/relay.env`, which the deploy creates root-only with the
public origin in it and never overwrites. Nothing secret is in the repository:

```sh
ssh ajar-relay
sudo -e /etc/ajar/relay.env
#   AJAR_PUBLIC_ORIGIN=https://code.rishwanth.dev
#   AJAR_GOOGLE_CLIENT_ID=...apps.googleusercontent.com
#   AJAR_GOOGLE_CLIENT_SECRET=...
#   AJAR_GITHUB_CLIENT_ID=...
#   AJAR_GITHUB_CLIENT_SECRET=...
sudo systemctl restart ajar-relay
sudo journalctl -u ajar-relay -n 5 -o cat   # "sign-in offered with ["google", "github"]"
```

A provider with no id is simply not offered, so one can go live before the
other.

**The admin page**, `/admin`, is for the people named in `AJAR_ADMINS` in the
same file — comma-separated, each an email (Google's only when Google says it
is verified; GitHub's only if it is public on the profile) or a
`provider:id` (`github:583231`; a GitHub id is at
`api.github.com/users/<login>`). Anyone else gets a 404 and the page says
`/admin` is not a pad address. It shows only what the relay already keeps —
see [accounts](accounts.md#as-built).

```sh
#   AJAR_ADMINS=you@example.com,github:583231
sudo systemctl restart ajar-relay
```

Rotating a secret is the same edit and a restart; sign-ins survive it, since
they are kept in the accounts database.

### What is on disk

**None of this is backed up yet** — the options, what each costs and the plan
are in [durability](durability.md).

`/var/lib/ajar/usage.db` (SQLite, WAL) holds the usage counts the admin page
shows — counts only, nobody's; losing it loses the history and nothing else.
See [accounts](accounts.md#as-built), "Usage, counted as it happens".

`/var/lib/ajar/accounts.db` (SQLite, WAL) holds users, sessions, pads and
links, and `/var/lib/ajar/accounts.key` beside it seals link codes so the
dashboard can show a link again. **The two together are every edit link**;
either alone is not. Neither is backed up yet — Litestream to S3 is the plan
(see [open points](../open-points.md)), and the key must never go with it.
Losing the key costs only the dashboard's copies of existing links: owners
reset them and share again.

The limits — 20 pads and 250 MB per account — are the defaults of two relay
flags, `--account-max-pads` and `--account-max-bytes`; to change them, add the
flags to `ExecStart` in the unit.

`/var/lib/ajar/pads/` is the pad store, since 11 October 2026
([pad-store.md](pad-store.md)): `store.db` (SQLite, WAL) lists the pads and
their files and leases, and `blobs/` holds each file's text once, named by its
hash. Back them up together, the database first: a blob nothing lists is
harmless, a listed blob that is missing is a file that will not load. The
first start of a relay with this store brought every `<name>.json` the old one
kept into it, and moved those files into `pads/legacy/`, where they stay until
someone deletes them.

**Going back to a relay from before the change:** stop the relay, write the
pads out the old way, and put them where the old binary looks.

```sh
sudo systemctl stop ajar-relay
sudo -u ajar /usr/local/bin/ajar-relay --pad-dir /var/lib/ajar/pads \
  --accounts-db /var/lib/ajar/accounts.db --export-pads /var/lib/ajar/pads-export
# then install the older binary, and move pads-export/*.json into pads/
```

The export carries every pad as it stands, with each one's lease as the file's
modification time, which is what the old relay reads. `pads/legacy/` is the
store as it was when the new relay first started, and misses everything since.

The pad store's limits are flags too: `--max-store-bytes` (4 GiB for every pad
together, each file's text counted once however many pads hold it, and since
18 October each pad's last run as well) and
`--pad-growth-per-address` (512 MiB a day per address — five full pads since a
pad went to 100 MiB on 11 October). The size of one pad is not a flag. A save no
longer costs the pad's size — the store streams the files a save names, and
an edit from one blob to the next — but a single request is still read off
the wire whole, up to 33 MiB. Since 18 October bodies take room as their bytes
arrive, out of 66 MiB for every body at once, and two are parsed and stored
at a time; `main.rs` asserts that the bodies with the text parsed out of
them, 132 MiB, stay under 256 MiB of the unit's `MemoryMax=512M`. Lowering
`MemoryMax` is therefore a code change as well. An account's 250 MB holds two
full pads and half a third.

What a writer is told when these bite: **408** for a body that sent nothing
for 20 seconds or had not finished in ten minutes (an upload that stopped
part-way, audit B04); **503**, "busy saving other pads", after 20 seconds
waiting for room, which the page tries again after; **413** for more than
2,000 changes, 1,000 edits to a file or 10,000 edits in one request (the page
sends at most 1,000 changes and one edit a file); **507** for a last run, as
for a file, once the store is at `--max-store-bytes`. A run of 408s or 503s
in the journal with nobody uploading is someone holding uploads open.

`/var/log/caddy/{ajar,code,preview}.log` are Caddy's access logs, JSON, five
rolls of 10 MiB each. Since 18 October they keep no `X-Pad-Code` (a link's
code, as good as the link), `Cookie`, `Authorization` or `Set-Cookie`, nor an
OAuth callback's `code` from its URL — see `format filter` in
`deploy/Caddyfile`. **Logs from before that deploy may hold link codes**:
once it is live, delete the rolled files in `/var/log/caddy/` and truncate the
current ones, and reset the links of any pad that matters, since anyone who
read them could have kept a copy.

The unit also fixes glibc's mmap threshold at 1 MiB
(`MALLOC_MMAP_THRESHOLD_`). Without it the allocator keeps what large requests
used: after uploads of 25, 60 and 99 MB files a relay held 261 MB with none of
it in use, and 59 MB with it ([pad-store.md](pad-store.md#one-large-file)).

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

**Install Go.** Every deploy builds Caddy, and `deploy.sh` stops and points
here when `go` is missing; the version and its checksum are under
[From an x86_64 machine](#from-an-x86_64-machine).

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
installer verifies and refuses on a mismatch (a missing checksum file is
tolerated). `install.sh` is compiled into the relay and served at
`/install.sh`, so the published installer cannot drift from the binary that
was built.

`install.sh` fetches the latest release unless `AJAR_VERSION` names a tag —
`AJAR_VERSION=v0.0.6 sh install.sh`, with the `v`, because it is used as the
tag in the download URL. That is how to reproduce a report against an older
agent. A release is a `v*` tag on `main`: `.github/workflows/release.yml`
builds the four targets and publishes them. The current release is v0.0.8
(8 October).

The Linux targets are musl, statically linked, and the workflow fails one
that is not. Built against the runner's glibc, as they were up to 0.0.7, the
binary needed glibc 2.39 — for `pidfd_spawnp` and `pidfd_getpid`, among
others — and would not start on Ubuntu 22.04, Debian 12, RHEL 8 or 9, or
Amazon Linux; `install.sh` said "installed" all the same. Each is also
published under its old `-gnu` name, for an `install.sh` from before the
change, which asks for that. `install.sh` asks for `-musl` and falls back to
`-gnu` for a release that has only that. `scripts/dist.sh` on Linux builds
the musl target too, which needs `rustup target add <arch>-unknown-linux-musl`
and musl-tools.

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

`install.sh` serves whatever the **latest release** holds, unless the person
installing pins `AJAR_VERSION`. So when a change
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
curl -sS 'https://ajar.rishwanth.dev/healthz?deep=1'
PAD_ORIGIN=https://code.rishwanth.dev node pad/scripts/app-check.mjs
```

`/healthz` says `ok` from a relay that is running, whatever state its
databases are in — it is what `deploy.sh` waits for, and it should stay that
cheap. `/healthz?deep=1` says `ready` only when the accounts database and the
pad store's both answer a query on the table every request reads, within five
seconds, and otherwise 503 with which did not and why (audit B12). It proves
the relay can serve pads, not that the page, the preview or the runtime
packages are right — `app-check.mjs` is for those.

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

The packaged Caddy cannot rate-limit, and the files it serves off disk — about
15 MB of wasm to every cache-cold pad visitor — are the one thing the relay never
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
   deploy restarts when it swapped the binary, reloads when only the
   Caddyfile changed, and leaves Caddy alone when neither did. A reload that
   fails prints the last of Caddy's journal, since that is the only place the
   reason is.
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
request, from two source addresses. CI runs it on every push to `main` and on
every pull request, after building for arm64 as well.

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

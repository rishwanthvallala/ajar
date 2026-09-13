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

`deploy/` holds a Caddyfile (TLS, and nothing else), a hardened systemd unit,
and the script. Caddy handles WebSocket upgrades without configuration, which
is most of why it is there rather than nginx.

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

#!/usr/bin/env bash
# Build the relay for the server and ship it.
#
#     ./deploy/deploy.sh root@ajar.rishwanth.dev
#
# Cross-compiles for aarch64 Linux, builds the web client, copies both up,
# and restarts the service. Idempotent: run it again for every deploy.
#
# First time on a fresh box, run `./deploy/deploy.sh <host> --bootstrap` to
# create the user, install Caddy and the unit files.

set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

HOST="${1:-}"
MODE="${2:-}"
TARGET="${AJAR_TARGET:-aarch64-unknown-linux-gnu}"
DOMAIN="${AJAR_DOMAIN:-ajar.rishwanth.dev}"

[ -n "$HOST" ] || { echo "usage: $0 user@host [--bootstrap]" >&2; exit 1; }

# Everything below writes to /usr/local/bin, /etc and /srv. Root does that
# directly; anyone else needs sudo, and a cloud image's default user is never
# root. Resolved once rather than guessed at each call site.
SUDO=$(ssh "$HOST" 'if [ "$(id -u)" = 0 ]; then echo; else echo sudo; fi')

say() { printf '\n  %s\n' "$*"; }

# ---------------------------------------------------------------- build

say "building the relay for $TARGET"
if ! rustup target list --installed | grep -qx "$TARGET"; then
    rustup target add "$TARGET"
fi

# Pure Rust with no C dependencies, but the linker still has to emit Linux
# aarch64 and a stock macOS toolchain will not. Three ways, in order of how
# little they assume:
BIN="target/$TARGET/release/ajar-relay"
if command -v cross >/dev/null 2>&1; then
    cross build --release --target "$TARGET" -p ajar-relay
elif cargo build --release --target "$TARGET" -p ajar-relay 2>/dev/null; then
    :
else
    # Borrow a Linux toolchain. On an arm64 host this is a native build
    # rather than a cross one, which is why no linker had to be found.
    runtime=""
    for candidate in podman docker; do
        if command -v "$candidate" >/dev/null 2>&1 && "$candidate" info >/dev/null 2>&1; then
            runtime="$candidate"; break
        fi
    done
    if [ -z "$runtime" ]; then
        echo "  nothing here can build for $TARGET." >&2
        echo "  install one of:" >&2
        echo "      cargo install cross --git https://github.com/cross-rs/cross" >&2
        echo "      podman, or docker" >&2
        exit 1
    fi
    say "no local linker for $TARGET — building in $runtime"
    "$runtime" run --rm -v "$PWD":/src -w /src docker.io/library/rust:slim \
        bash -c "CARGO_TARGET_DIR=/src/target/container cargo build --release -p ajar-relay"
    BIN="target/container/release/ajar-relay"
fi

say "building the web client"
(cd web && npm ci --silent --no-audit --no-fund && npx vite build >/dev/null)

say "$(du -h "$BIN" | cut -f1) binary, $(du -sh web/dist | cut -f1) of assets"

# ------------------------------------------------------------ bootstrap

if [ "$MODE" = "--bootstrap" ]; then
    say "bootstrapping $HOST"
    ssh "$HOST" "$SUDO bash -euo pipefail -s" <<BOOTSTRAP
# A service account with no shell and no home. It only runs one binary.
id -u ajar >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ajar
mkdir -p /srv/ajar/web
chown -R ajar:ajar /srv/ajar

if ! command -v caddy >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy
fi

# After the package, because installing it creates the `caddy` user. The log
# directory has to belong to whoever Caddy runs as, or it refuses the config
# with a permission error that looks nothing like a permissions problem.
mkdir -p /var/log/caddy
chown -R caddy:caddy /var/log/caddy
BOOTSTRAP

    # scp cannot write to /etc as an unprivileged user, so land in /tmp and
    # move it across with the privilege we actually have.
    scp -q deploy/ajar-relay.service "$HOST:/tmp/ajar-relay.service"
    ssh "$HOST" "$SUDO mv /tmp/ajar-relay.service /etc/systemd/system/ajar-relay.service"
    # Substitute the domain rather than making someone remember to edit it.
    sed "s|ajar\.rishwanth\.dev|$DOMAIN|g" deploy/Caddyfile \
        | ssh "$HOST" "cat > /tmp/Caddyfile && $SUDO mv /tmp/Caddyfile /etc/caddy/Caddyfile"
    ssh "$HOST" "$SUDO systemctl daemon-reload && $SUDO systemctl enable ajar-relay && $SUDO systemctl reload-or-restart caddy"
    say "bootstrapped — point $DOMAIN at this host's IP before the first request"
fi

# --------------------------------------------------------------- deploy

say "shipping to $HOST"
# To a temporary name first, then moved into place: a half-copied binary that
# systemd tries to exec is a worse outage than a few seconds of downtime.
scp -q "$BIN" "$HOST:/tmp/ajar-relay.new"
# Staged through a directory the deploy user owns, then moved into place.
ssh "$HOST" "rm -rf /tmp/ajar-web && mkdir -p /tmp/ajar-web"
rsync -a --delete -e ssh web/dist/ "$HOST:/tmp/ajar-web/"

ssh "$HOST" "$SUDO bash -euo pipefail -s" <<'SWAP'
chmod 755 /tmp/ajar-relay.new
# Moved rather than copied: a half-written binary systemd tries to exec is a
# worse outage than the second of downtime a restart costs.
mv /tmp/ajar-relay.new /usr/local/bin/ajar-relay
rsync -a --delete /tmp/ajar-web/ /srv/ajar/web/
chown -R ajar:ajar /srv/ajar
systemctl restart ajar-relay
SWAP

# ---------------------------------------------------------------- check

say "checking"
for i in $(seq 1 20); do
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "https://$DOMAIN/healthz" || true)
    if [ "$code" = "200" ]; then
        printf '  healthz: 200\n'
        printf '  version: %s\n' "$(ssh "$HOST" '/usr/local/bin/ajar-relay --version' 2>/dev/null || echo '?')"
        printf '\n  share something at it:\n      ajar ~/some/project --relay https://%s\n\n' "$DOMAIN"
        exit 0
    fi
    sleep 1
done

echo "  healthz never returned 200 (last: ${code:-none})" >&2
ssh "$HOST" "$SUDO systemctl status ajar-relay --no-pager -l | tail -20" >&2
exit 1

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

say() { printf '\n  %s\n' "$*"; }

# ---------------------------------------------------------------- build

say "building the relay for $TARGET"
if ! rustup target list --installed | grep -qx "$TARGET"; then
    rustup target add "$TARGET"
fi

# The relay is pure Rust with no C dependencies, but the linker still has to
# be one that emits aarch64. `cross` handles this without installing a
# toolchain; fall back to cargo if the host can already do it.
if command -v cross >/dev/null 2>&1; then
    cross build --release --target "$TARGET" -p ajar-relay
elif cargo build --release --target "$TARGET" -p ajar-relay 2>/dev/null; then
    :
else
    echo "  no linker for $TARGET." >&2
    echo "  install one:  cargo install cross --git https://github.com/cross-rs/cross" >&2
    echo "  or build on the server itself." >&2
    exit 1
fi

say "building the web client"
(cd web && npm ci --silent --no-audit --no-fund && npx vite build >/dev/null)

BIN="target/$TARGET/release/ajar-relay"
say "$(du -h "$BIN" | cut -f1) binary, $(du -sh web/dist | cut -f1) of assets"

# ------------------------------------------------------------ bootstrap

if [ "$MODE" = "--bootstrap" ]; then
    say "bootstrapping $HOST"
    ssh "$HOST" "bash -euo pipefail -s" <<BOOTSTRAP
# A service account with no shell and no home. It only runs one binary.
id -u ajar >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ajar
mkdir -p /srv/ajar/web /var/log/caddy
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
BOOTSTRAP

    scp -q deploy/ajar-relay.service "$HOST:/etc/systemd/system/ajar-relay.service"
    # Substitute the domain rather than making someone remember to edit it.
    sed "s|ajar\.rishwanth\.dev|$DOMAIN|g" deploy/Caddyfile \
        | ssh "$HOST" "cat > /etc/caddy/Caddyfile"
    ssh "$HOST" "systemctl daemon-reload && systemctl enable ajar-relay && systemctl reload-or-restart caddy"
    say "bootstrapped — point $DOMAIN at this host's IP before the first request"
fi

# --------------------------------------------------------------- deploy

say "shipping to $HOST"
# To a temporary name first, then moved into place: a half-copied binary that
# systemd tries to exec is a worse outage than a few seconds of downtime.
scp -q "$BIN" "$HOST:/usr/local/bin/ajar-relay.new"
rsync -a --delete -e ssh web/dist/ "$HOST:/srv/ajar/web/"

ssh "$HOST" "bash -euo pipefail -s" <<'SWAP'
chmod 755 /usr/local/bin/ajar-relay.new
mv /usr/local/bin/ajar-relay.new /usr/local/bin/ajar-relay
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
ssh "$HOST" "systemctl status ajar-relay --no-pager -l | tail -20" >&2
exit 1

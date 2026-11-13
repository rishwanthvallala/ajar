#!/bin/bash
# On staging: the relay and Caddy as production runs them, with production's
# Caddyfile — its logs and rate limits — on internal certificates, and the load
# generator believed for visitors' addresses as cloudflared would be.
set -euo pipefail
LOADGEN_IP=$1
sudo apt-get update -qq >/dev/null && sudo apt-get install -y -qq sqlite3 >/dev/null
sudo mkdir -p /var/lib/ajar/pads /var/log/caddy /srv/ajar/pad /srv/ajar/web /etc/ajar
echo '<!doctype html><title>pad</title>' | sudo tee /srv/ajar/pad/index.html /srv/ajar/web/index.html >/dev/null
sudo cp /opt/ajar/limits.env /etc/ajar/limits.env
sed -e "s#^\tgrace_period 10s#\tgrace_period 10s\n\tlocal_certs#" \
    -e "s#trusted_proxies static 127.0.0.1/32 ::1/128#trusted_proxies static 127.0.0.1/32 ::1/128 $LOADGEN_IP/32#" \
    /opt/ajar/Caddyfile.prod | sudo tee /etc/ajar/Caddyfile >/dev/null
grep -n 'local_certs\|trusted_proxies' /etc/ajar/Caddyfile
sudo systemctl stop ajar-relay caddy-staging 2>/dev/null || true
sudo systemctl reset-failed ajar-relay caddy-staging 2>/dev/null || true
sudo systemd-run --unit ajar-relay -p MemoryMax=512M -p LimitNOFILE=65536 \
  -p EnvironmentFile=/etc/ajar/limits.env -E MALLOC_MMAP_THRESHOLD_=1048576 -E RUST_LOG=ajar_relay=info \
  /opt/ajar/ajar-relay --bind 0.0.0.0:8787 --web /srv/ajar/web --trust-forwarded-for \
  --pad-dir /var/lib/ajar/pads --accounts-db /var/lib/ajar/accounts.db
sudo systemd-run --unit caddy-staging -p LimitNOFILE=1048576 -E XDG_DATA_HOME=/var/lib/caddy-staging -E HOME=/root \
  /opt/ajar/caddy-linux-arm64 run --config /etc/ajar/Caddyfile --adapter caddyfile
sleep 3
curl -s http://127.0.0.1:8787/healthz?deep=1; echo
curl -sk --resolve code.rishwanth.dev:443:127.0.0.1 https://code.rishwanth.dev/api/limits | head -c 120; echo
systemctl is-active ajar-relay caddy-staging

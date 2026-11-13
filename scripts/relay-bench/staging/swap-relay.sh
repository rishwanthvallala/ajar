#!/bin/bash
# On staging: run the relay from $1, on the same data, flags and limits.
set -e
sudo systemctl stop ajar-relay; sudo systemctl reset-failed ajar-relay 2>/dev/null || true
sudo systemd-run --unit ajar-relay -p MemoryMax=512M -p LimitNOFILE=65536 \
  -p EnvironmentFile=/etc/ajar/limits.env -E MALLOC_MMAP_THRESHOLD_=1048576 -E RUST_LOG=ajar_relay=info \
  "$1" --bind 0.0.0.0:8787 --web /srv/ajar/web --trust-forwarded-for \
  --pad-dir /var/lib/ajar/pads --accounts-db /var/lib/ajar/accounts.db
sleep 2; curl -s http://127.0.0.1:8787/healthz?deep=1; echo

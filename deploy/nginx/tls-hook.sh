#!/bin/sh
# certbot's deploy hook, run when a certificate is issued or renewed: the new
# one copied where nginx reads it (/etc/ajar/tls/<site>/, sites.conf), and
# nginx reloaded to use it. Installed as /etc/ajar/tls-hook.sh by
# deploy/deploy.sh, and named to certbot when each certificate is first
# issued, which keeps it for every renewal after.
#
# Copied rather than pointed at: nginx reads /etc/ajar/tls whether the
# certificate there came from certbot or, at the switch from Caddy, from
# Caddy's own store — so the switch needs no certificate of its own first,
# and going back to Caddy leaves nothing pointing at certbot's.
set -eu
name=$(basename "$RENEWED_LINEAGE")
install -d -m 755 "/etc/ajar/tls/$name"
install -m 644 "$RENEWED_LINEAGE/fullchain.pem" "/etc/ajar/tls/$name/fullchain.pem"
install -m 600 "$RENEWED_LINEAGE/privkey.pem" "/etc/ajar/tls/$name/privkey.pem"
systemctl reload nginx

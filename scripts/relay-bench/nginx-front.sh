#!/bin/bash
# In run.sh's `nginx` container: deploy/nginx as it ships, with TLS, in front
# of the relay — the box since 14 November, both on its two CPUs.
#
# Changed from the box only where a benchmark has to be: a self-signed
# certificate, ports 8443 and 8080, the relay's site also answering as
# ajar-bench-relay, and each request's address taken from the X-Forwarded-For
# wrk sets — as the box takes CF-Connecting-IP from the tunnel — so that each
# simulated visitor has the relay's per-address budgets to themselves.
set -euo pipefail
mkdir -p /etc/nginx/ajar /etc/ajar/tls/ajar.rishwanth.dev /var/www/acme /srv/ajar/pad
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=ajar-bench-relay \
    -keyout /etc/ajar/tls/ajar.rishwanth.dev/privkey.pem -out /etc/ajar/tls/ajar.rishwanth.dev/fullchain.pem 2>/dev/null
for site in code.rishwanth.dev preview.rishwanth.dev; do
    cp -r /etc/ajar/tls/ajar.rishwanth.dev "/etc/ajar/tls/$site"
done
for f in /conf/*.conf; do
    sed -E \
        -e "s#listen 443 ssl http2;#listen 8443 ssl http2;#" \
        -e "/listen \[::\]:/d" \
        -e "s#listen 80 default_server;#listen 8080 default_server;#" \
        -e "s#server_name ajar\.rishwanth\.dev;#server_name ajar.rishwanth.dev ajar-bench-relay;#" \
        -e "s#set_real_ip_from 127\.0\.0\.1;#set_real_ip_from 0.0.0.0/0;#" \
        -e "s#real_ip_header CF-Connecting-IP;#real_ip_header X-Forwarded-For;#" \
        "$f" > "/etc/nginx/ajar/$(basename "$f")"
done
mv /etc/nginx/ajar/nginx.conf /etc/nginx/nginx.conf
nginx -t -q
/relay --bind 127.0.0.1:8787 --trust-forwarded-for --pad-dir /data/pads --accounts-db /data/a.db &
exec nginx -g 'daemon off;'

#!/bin/bash
# Inside the perf lab's container (lab.sh): deploy/nginx as the box runs it,
# the pad's build as /srv/ajar/pad, the relay behind it — and the link a
# visitor would have, shaped by netem on everything nginx sends the browser:
# $RATE, and $DELAY as the round trip.
#
# Changed from the box only where a lab has to be: self-signed certificates,
# port 8443. The sites keep their names; the browser maps them here.
set -euo pipefail
mkdir -p /etc/nginx/ajar /etc/ajar /var/www/acme /data/pads
# One key for the three sites, whose fingerprint the browser is told to trust
# (lab.sh writes it out): a certificate Chrome merely ignores the errors of,
# it caches nothing from, and every visit in the lab was a first one.
openssl genrsa -out /etc/ajar/lab.key 2048 2>/dev/null
openssl pkey -in /etc/ajar/lab.key -pubout -outform der | openssl dgst -sha256 -binary | base64 > /etc/ajar/lab.spki
for site in ajar.rishwanth.dev code.rishwanth.dev preview.rishwanth.dev; do
    mkdir -p "/etc/ajar/tls/$site"
    cp /etc/ajar/lab.key "/etc/ajar/tls/$site/privkey.pem"
    openssl req -x509 -new -key /etc/ajar/lab.key -days 1 -subj "/CN=$site" -addext "subjectAltName=DNS:$site" \
        -out "/etc/ajar/tls/$site/fullchain.pem" 2>/dev/null
done
for f in /conf/*.conf; do
    sed -E -e "s#listen 443 ssl http2;#listen 8443 ssl http2;#" -e "/listen \[::\]:/d" \
        -e "s#listen 80 default_server;#listen 8080 default_server;#" "$f" > "/etc/nginx/ajar/$(basename "$f")"
done
mv /etc/nginx/ajar/nginx.conf /etc/nginx/nginx.conf
nginx -t -q
/relay --bind 127.0.0.1:8787 --trust-forwarded-for --pad-dir /data/pads --accounts-db /data/a.db > /data/relay.log 2>&1 &
bash /perf/reshape.sh
exec nginx -g 'daemon off;'

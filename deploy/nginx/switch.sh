#!/bin/bash
# On the box, as root: nginx's packages installed if they are not, its config
# (copied to /tmp/ajar-nginx by deploy/deploy.sh) installed and tested, a
# certificate for each site where nginx reads them, and nginx reloaded — or,
# the first time, switched to from Caddy, with Caddy put back if the sites do
# not answer through it. Then certbot for whatever has no certificate of its
# own yet.
#
#   SITES="ajar.rishwanth.dev code.rishwanth.dev preview.rishwanth.dev" bash switch.sh
#
# INSECURE=1 lets the switch's own check accept a certificate it cannot
# verify: a rehearsal on staging, whose certificates are Caddy's internal
# ones (scripts/relay-bench/staging/). Never on the box.
set -euo pipefail
: "${SITES:?name the sites}"
INSECURE="${INSECURE:-}"
packages="nginx libnginx-mod-http-headers-more-filter libnginx-mod-http-brotli-static libnginx-mod-http-brotli-filter certbot"
if ! dpkg -s $packages >/dev/null 2>&1; then
    # Installed without being started: the package starts nginx on port 80,
    # which Caddy has, and the install would fail on it.
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
    chmod 755 /usr/sbin/policy-rc.d
    trap 'rm -f /usr/sbin/policy-rc.d' EXIT
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $packages >/dev/null
    rm -f /usr/sbin/policy-rc.d
    trap - EXIT
    systemctl is-active --quiet nginx || systemctl disable --quiet nginx
fi
mkdir -p /etc/nginx/ajar /var/www/acme /etc/ajar/tls
cd /tmp/ajar-nginx
install -m 644 nginx.conf /etc/nginx/nginx.conf
for f in sites.conf proxy.conf code-headers.conf ajar-headers.conf preview-headers.conf; do
    install -m 644 "$f" "/etc/nginx/ajar/$f"
done
install -m 755 tls-hook.sh /etc/ajar/tls-hook.sh
# A certificate for each site where nginx reads them: certbot's if it has
# one, or else Caddy's own, so the switch needs nothing issued first.
for site in $SITES; do
    [ -s "/etc/ajar/tls/$site/fullchain.pem" ] && continue
    mkdir -p "/etc/ajar/tls/$site"
    if [ -d "/etc/letsencrypt/live/$site" ]; then
        crt="/etc/letsencrypt/live/$site/fullchain.pem" key="/etc/letsencrypt/live/$site/privkey.pem"
    else
        # The one that lasts longest: Caddy keeps one per issuer it has used
        # — Let's Encrypt, and ZeroSSL when that failed — and an old one
        # may have run out.
        crt="" last=0
        while IFS= read -r found; do
            ends=$(date -d "$(openssl x509 -enddate -noout -in "$found" | cut -d= -f2)" +%s 2>/dev/null) || continue
            if [ "$ends" -gt "$last" ]; then crt=$found last=$ends; fi
        done < <(find /var/lib/caddy -path '*certificates*' -name "$site.crt" 2>/dev/null)
        key="${crt%.crt}.key"
    fi
    if [ -z "$crt" ] || [ ! -s "$crt" ] || [ ! -s "$key" ]; then
        echo "  no certificate for $site, from certbot or from Caddy; nginx cannot serve it" >&2
        exit 1
    fi
    install -m 644 "$crt" "/etc/ajar/tls/$site/fullchain.pem"
    install -m 600 "$key" "/etc/ajar/tls/$site/privkey.pem"
done
nginx -t -q
answers() {
    for i in $(seq 1 15); do
        if [ "$(curl -s ${INSECURE:+-k} -o /dev/null -m 5 -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1$2")" = 200 ]; then
            return 0
        fi
        sleep 1
    done
    return 1
}
set -- $SITES
if systemctl is-active --quiet nginx; then
    systemctl reload nginx
    echo "  nginx reloaded"
else
    echo "  switching the front from Caddy to nginx"
    systemctl stop caddy 2>/dev/null || true
    systemctl enable --quiet nginx
    systemctl restart nginx
    if answers "$1" "/healthz?deep=1" && answers "$2" "/api/limits" && answers "$3" "/.wasmer/host.html"; then
        systemctl disable --quiet caddy 2>/dev/null || true
        echo "  nginx is serving all three sites; Caddy is stopped and disabled, and kept installed"
    else
        echo "  the sites did not answer through nginx; Caddy put back" >&2
        journalctl -u nginx -n 20 --no-pager >&2 || true
        systemctl stop nginx || true
        systemctl disable --quiet nginx || true
        systemctl start caddy
        exit 1
    fi
fi
# certbot from here on: each site's certificate issued once nginx answers its
# challenges on port 80, and renewed by certbot's own timer, the hook copying
# each new one for nginx. Until it is, nginx serves Caddy's, which lasts
# weeks yet — said, not fatal.
for site in $SITES; do
    [ -d "/etc/letsencrypt/live/$site" ] && continue
    if certbot certonly --webroot -w /var/www/acme -d "$site" --cert-name "$site" \
        --non-interactive --agree-tos --register-unsafely-without-email \
        --deploy-hook /etc/ajar/tls-hook.sh -q; then
        echo "  certbot issued $site's certificate"
    else
        echo "  WARNING: certbot could not issue $site's; nginx keeps the one it has, until $(openssl x509 -enddate -noout -in "/etc/ajar/tls/$site/fullchain.pem" | cut -d= -f2)" >&2
    fi
done

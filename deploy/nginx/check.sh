#!/bin/bash
# deploy/nginx's config, exercised against a real nginx: the rate limits, the
# routes, the headers and what is cached, as deploy/caddy/check.sh did for the
# Caddyfile it replaced.
#
#   deploy/nginx/check.sh            # on Linux, with nginx and its modules installed:
#   apt-get install nginx libnginx-mod-http-headers-more-filter libnginx-mod-http-brotli-static libnginx-mod-http-brotli-filter
#
# Runs the config that ships, not a copy of it: the sites become plain HTTP
# on local ports, the pad's root a temp directory, and every upstream a closed
# port — a request let through is answered 502 or by the file, one refused
# 429, and that difference is most of what is asserted.
#
# Linux only — two loopback source addresses stand in for two visitors, and
# 127.0.0.1 also for cloudflared, the one address whose CF-Connecting-IP the
# config believes.
set -euo pipefail

cd "$(dirname "$0")/../.."
NGINX="${NGINX:-$(command -v nginx || echo /usr/sbin/nginx)}"
[ -x "$NGINX" ] || { echo "no nginx — apt-get install nginx and the modules above" >&2; exit 1; }
PORT=18080 HTTP_PORT=18079
tmp=$(mktemp -d)
trap '[ -f "$tmp/nginx.pid" ] && kill "$(cat "$tmp/nginx.pid")" 2>/dev/null; rm -rf "$tmp"' EXIT

# The allowance each zone was given, read from the config rather than repeated
# here, so a changed number is tested as it stands: burst + 1 at once.
allowance() {
    sed -nE "s/.*limit_req zone=$1 burst=([0-9]+).*/\1/p" deploy/nginx/sites.conf | head -1 | awk '{print $1 + 1}'
}
FILES=$(allowance pad_files)
DNS=$(allowance pad_dns)
WISP=$(allowance pad_wisp)

mkdir -p "$tmp/pad/packages" "$tmp/pad/vendor/wasmer" "$tmp/pad/vendor/preview" "$tmp/pad/assets" "$tmp/acme/.well-known/acme-challenge" "$tmp/conf" "$tmp/temp"
head -c 200000 /dev/zero > "$tmp/pad/packages/big.webc"
printf 'brotli' > "$tmp/pad/packages/big.webc.br"
printf 'gzipped' > "$tmp/pad/packages/big.webc.gz"
echo small > "$tmp/pad/packages/small.webc"
echo '{}' > "$tmp/pad/packages/manifest.json"
echo '{}' > "$tmp/pad/packages/registry.json"
echo 'export {}' > "$tmp/pad/vendor/sdk.js"
echo 'export {}' > "$tmp/pad/vendor/module.mjs"
echo 'export {}' > "$tmp/pad/assets/app.js"
echo '// host' > "$tmp/pad/vendor/wasmer/service-worker-host.js"
echo '// relay' > "$tmp/pad/vendor/preview/relay.js"
echo '// sw' > "$tmp/pad/vendor/preview/sw.js"
echo '<!doctype html><title>pad</title>' > "$tmp/pad/index.html"
echo '<!doctype html><title>Privacy — pad</title>' > "$tmp/pad/privacy.html"
echo '<!doctype html><title>Terms — pad</title>' > "$tmp/pad/terms.html"
echo token > "$tmp/acme/.well-known/acme-challenge/t0k3n"
# Readable by nginx's workers, which run as www-data when it is started as
# root; and somewhere they may write request bodies.
chmod -R a+rX "$tmp"
chmod 1777 "$tmp/temp"

# The config as shipped, its paths moved here and its upstreams to a closed port.
for f in deploy/nginx/*.conf; do
    sed -E \
        -e "s#/etc/nginx/ajar/#$tmp/conf/#g" \
        -e "s#/srv/ajar/pad#$tmp/pad#g" \
        -e "s#/var/www/acme#$tmp/acme#g" \
        -e "s#/var/log/nginx/#$tmp/#g" \
        -e "s#/run/nginx.pid#$tmp/nginx.pid#" \
        -e "s#server 127\.0\.0\.1:(8787|8788);#server 127.0.0.1:9;#" \
        -e "s#proxy_pass https://cloudflare-dns\.com;#proxy_pass http://127.0.0.1:9;#" \
        -e "s#listen 443 ssl http2;#listen $PORT;#" \
        -e "/listen \[::\]:/d" \
        -e "s#listen 80 default_server;#listen $HTTP_PORT default_server;#" \
        -e "/ssl_certificate/d" \
        "$f" > "$tmp/conf/$(basename "$f")"
done
# The packaged modules name themselves relative to nginx's prefix, which is
# here now.
ln -s /usr/lib/nginx/modules "$tmp/modules"
# Where nginx keeps request bodies and upstream answers, somewhere it may
# write when it is not root.
sed -i "s#^http {#http {\n    client_body_temp_path $tmp/temp/body;\n    proxy_temp_path $tmp/temp/proxy;\n    fastcgi_temp_path $tmp/temp/fastcgi;\n    uwsgi_temp_path $tmp/temp/uwsgi;\n    scgi_temp_path $tmp/temp/scgi;#" "$tmp/conf/nginx.conf"

"$NGINX" -t -p "$tmp" -e "$tmp/error.log" -c "$tmp/conf/nginx.conf" 2>"$tmp/test.err" || { cat "$tmp/test.err" >&2; exit 1; }
"$NGINX" -p "$tmp" -e "$tmp/error.log" -c "$tmp/conf/nginx.conf"
for _ in $(seq 50); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
    sleep 0.1
done

pass=0 fail=0
ok() { pass=$((pass + 1)); echo "  ok    $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL  $1"; }

# status <from> <path> [curl args…], to the pad's site
status() {
    local from="$1" path="$2"
    shift 2
    curl -s -o /dev/null -w '%{http_code}' --interface "$from" \
        --resolve "code.rishwanth.dev:$PORT:127.0.0.1" "$@" \
        "http://code.rishwanth.dev:$PORT$path"
}
# spend <n> <from> <path>: make n requests, echo how many were refused
spend() {
    local n="$1" refused=0
    for _ in $(seq "$n"); do
        [ "$(status "$2" "$3")" = 429 ] && refused=$((refused + 1))
    done
    echo "$refused"
}
# headers <host> <path> [curl args…]
headers() {
    local host="$1" path="$2"
    shift 2
    curl -s -D - -o /dev/null --resolve "$host:$PORT:127.0.0.1" "$@" "http://$host:$PORT$path" | tr -d '\r'
}

echo "pad_files: $FILES per file per address"
r=$(spend "$FILES" 127.0.0.1 /packages/big.webc)
[ "$r" = 0 ] && ok "the first $FILES fetches of a file are served" || bad "$r of the first $FILES were refused"
[ "$(status 127.0.0.1 /packages/big.webc)" = 429 ] && ok "fetch $((FILES + 1)) is refused" || bad "fetch $((FILES + 1)) was served"

h=$(curl -s -D - -o "$tmp/body" --interface 127.0.0.1 --resolve "code.rishwanth.dev:$PORT:127.0.0.1" \
    "http://code.rishwanth.dev:$PORT/packages/big.webc" | tr -d '\r')
echo "$h" | grep -qi '^retry-after: [0-9]' && ok "the refusal says when to retry" || bad "no Retry-After"
echo "$h" | grep -qi '^cache-control: no-store' && ! echo "$h" | grep -qi immutable && ok "the refusal is not cached" || bad "refusal cached: $(echo "$h" | grep -i '^cache-control')"
grep -q "Too many requests" "$tmp/body" && ok "the refusal says what happened" || bad "body: $(head -c 80 "$tmp/body")"
echo "$h" | grep -qi '^cross-origin-embedder-policy: require-corp' && ok "and is still cross-origin isolated" || bad "a refusal lost the isolation headers"

for spelling in /packages//big.webc /packages/./big.webc /packages/x/../big.webc \
    //packages/big.webc /./packages/big.webc /%70ackages/big.webc; do
    s=$(status 127.0.0.1 "$spelling" --path-as-is)
    [ "$s" = 429 ] && ok "respelt as $spelling it is the same file ($s)" || bad "respelt as $spelling it got a fresh budget ($s)"
done

[ "$(status 127.0.0.1 /packages/small.webc)" = 200 ] && ok "another file from the same address is still served" || bad "another file was refused"
[ "$(status 127.0.0.2 /packages/big.webc)" = 200 ] && ok "the same file from another address is still served" || bad "another address was refused"
r=$(spend $((FILES + 5)) 127.0.0.1 /packages/no-such-file.webc)
s=$(status 127.0.0.1 /packages/no-such-file.webc)
[ "$r" = 0 ] && [ "$s" = 404 ] && ok "a path that is not a file is never limited, and is not found ($s)" || bad "a missing file: $r refused, then $s"
body=$(curl -s --resolve "code.rishwanth.dev:$PORT:127.0.0.1" "http://code.rishwanth.dev:$PORT/assets/gone.js")
h=$(headers code.rishwanth.dev /assets/gone.js)
[ "$body" = "not found" ] && echo "$h" | grep -qi '^cache-control: no-store' && ok "a missing script is not found, not the page, and not kept" || bad "a missing script: ${body:0:40} / $(echo "$h" | grep -i '^cache-control')"

cachecontrol() { headers code.rishwanth.dev "$1" --interface 127.0.0.2 | grep -i '^cache-control' || true; }
for f in /vendor/sdk.js /assets/app.js /packages/small.webc; do
    cc=$(cachecontrol "$f")
    echo "$cc" | grep -q immutable && ok "$f is immutable" || bad "$f: $cc"
done
for page in /some-pad /index.html /; do
    cc=$(cachecontrol "$page")
    echo "$cc" | grep -qi 'no-cache' && ! echo "$cc" | grep -q immutable &&
        ok "the page at $page is asked again each visit ($cc)" || bad "the page at $page: $cc"
done
for list in manifest.json registry.json; do
    cc=$(cachecontrol "/packages/$list")
    echo "$cc" | grep -qi 'no-cache' && ! echo "$cc" | grep -q immutable &&
        ok "$list is asked again each visit ($cc)" || bad "$list: $cc"
done

for f in /vendor/sdk.js /vendor/module.mjs; do
    ct=$(headers code.rishwanth.dev "$f" --interface 127.0.0.6 | grep -i '^content-type' | cut -d' ' -f2- || true)
    echo "$ct" | grep -qE '^(text|application)/javascript' && ok "$f is a script ($ct), as a module has to be" || bad "$f is sent as '$ct', which a browser refuses as a module"
done

echo "stored compressed"
# From an address that has spent nothing on big.webc yet.
e=$(curl -s --interface 127.0.0.3 --resolve "code.rishwanth.dev:$PORT:127.0.0.1" -H "Accept-Encoding: br, gzip" "http://code.rishwanth.dev:$PORT/packages/big.webc" -o "$tmp/enc" -D - | tr -d '\r' | grep -i '^content-encoding' | awk '{print $2}' || true)
[ "$e" = br ] && [ "$(cat "$tmp/enc")" = brotli ] && ok "a browser taking brotli gets the brotli copy" || bad "brotli: '$e', $(head -c 20 "$tmp/enc")"
e=$(curl -s --interface 127.0.0.3 --resolve "code.rishwanth.dev:$PORT:127.0.0.1" -H "Accept-Encoding: gzip" "http://code.rishwanth.dev:$PORT/packages/big.webc" -o "$tmp/enc" -D - | tr -d '\r' | grep -i '^content-encoding' | awk '{print $2}' || true)
[ "$e" = gzip ] && [ "$(cat "$tmp/enc")" = gzipped ] && ok "one taking only gzip, the gzip copy" || bad "gzip: '$e', $(head -c 20 "$tmp/enc")"

echo "pad_dns: $DNS at once per address, then a trickle"
r=$(spend "$DNS" 127.0.0.1 /dns-query)
[ "$r" = 0 ] && ok "the first $DNS lookups pass" || bad "$r of the first $DNS were refused"
r=$(spend 10 127.0.0.1 /dns-query)
[ "$r" -ge 5 ] && ok "past them, lookups are refused ($r of the next 10)" || bad "past them, only $r of the next 10 were refused"
[ "$(status 127.0.0.2 /dns-query)" != 429 ] && ok "another address still resolves" || bad "another address was refused"
[ "$(status 127.0.0.2 /dns-query -X PUT)" = 405 ] && ok "a lookup is a GET or a POST, nothing else" || bad "a PUT to /dns-query was let through"

# 127.0.0.1 is loopback, where cloudflared connects from through Cloudflare
# Tunnel, so its CF-Connecting-IP is the visitor; 127.0.0.2 is anyone else,
# and the header from them is a claim. 127.0.0.1 has spent its own DNS
# allowance above; 127.0.0.2 spends its own below, before it claims to be
# anyone else.
echo "the visitor behind the tunnel"
s=$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 203.0.113.7")
[ "$s" != 429 ] && ok "through the tunnel a visitor has a budget of their own, not loopback's ($s)" || bad "a visitor through the tunnel was given loopback's spent budget"
refused=0
for _ in $(seq $((DNS + 10))); do
    [ "$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 203.0.113.7")" = 429 ] && refused=$((refused + 1))
done
[ "$refused" -ge 1 ] && ok "and spends it" || bad "a visitor through the tunnel was never limited"
s=$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 203.0.113.8")
[ "$s" != 429 ] && ok "another visitor through the tunnel is not ($s)" || bad "another visitor through the tunnel shared the first one's budget"
# Spent past the allowance, then asked from the same /64 and the next. Not
# the 121st alone refused: the bucket refills two a second, and on CI's
# container 120 lookups took long enough for one to come back (14 November).
refused=0
for _ in $(seq $((DNS + 10))); do
    [ "$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 2001:db8:1:2::1")" = 429 ] && refused=$((refused + 1))
done
neighbour=0
for _ in 1 2 3 4 5; do
    [ "$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 2001:db8:1:2::2")" = 429 ] && neighbour=$((neighbour + 1))
done
s2=$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 2001:db8:1:3::1")
[ "$refused" -ge 1 ] && [ "$neighbour" -ge 3 ] && [ "$s2" != 429 ] &&
    ok "an IPv6 visitor is counted by their /64 ($neighbour of 5 refused to a neighbour)" ||
    bad "an IPv6 visitor through the tunnel: $refused of their own refused, $neighbour of 5 in the same /64, then $s2 in the next"
spend $((DNS + 10)) 127.0.0.2 /dns-query >/dev/null
[ "$(status 127.0.0.2 /dns-query)" = 429 ] || bad "127.0.0.2 still had lookups left; the claims below prove nothing"
refused=0
for i in $(seq 20); do
    [ "$(status 127.0.0.2 /dns-query -H "CF-Connecting-IP: 198.51.100.$i")" = 429 ] && refused=$((refused + 1))
done
# Most, not all: a lookup or two comes back as the bucket refills while the
# twenty are asked. Believed, the header would have bought every one.
[ "$refused" -ge 15 ] && ok "from anywhere else the header is ignored: a new claimed address each time is no new budget ($refused of 20 refused)" || bad "a claimed CF-Connecting-IP from outside bought $((20 - refused)) of 20 lookups"

echo "pad_wisp: $WISP at once per address"
r=$(spend "$WISP" 127.0.0.4 /wisp/)
[ "$r" = 0 ] && ok "the first $WISP connections pass" || bad "$r of the first $WISP were refused"
r=$(spend 5 127.0.0.4 /wisp)
[ "$r" -ge 3 ] && ok "past them, connections are refused, with or without the slash ($r of 5)" || bad "past them, only $r of 5 were refused"

echo "the routes"
[ "$(status 127.0.0.5 /some-folder-name)" = 200 ] && ok "a folder page is the page" || bad "a folder page was not"
[ "$(status 127.0.0.5 /api/pad/x)" = 502 ] && ok "the relay's paths go to the relay (502 here: nothing listens)" || bad "/api went elsewhere"
[ "$(status 127.0.0.5 /auth/github/start)" = 502 ] && ok "and sign-in" || bad "/auth went elsewhere"
[ "$(status 127.0.0.5 /ws)" = 502 ] && ok "and the socket" || bad "/ws went elsewhere"
[ "$(status 127.0.0.5 /some-pad -A 'Slackbot-LinkExpanding 1.0')" = 502 ] && ok "a link-preview fetcher asking for a pad is sent to the relay's preview" || bad "a link-preview fetcher got the page"
[ "$(status 127.0.0.5 /some.thing -A 'Slackbot-LinkExpanding 1.0')" = 200 ] && ok "and for anything that cannot be a pad's name, the page" || bad "a fetcher for a non-name"
for page in privacy terms; do
    t=$(curl -s --resolve "code.rishwanth.dev:$PORT:127.0.0.1" "http://code.rishwanth.dev:$PORT/$page")
    echo "$t" | grep -qi "<title>${page^} — pad" && ok "/$page is its own page, not the pad's" || bad "/$page served: ${t:0:60}"
done
h=$(headers code.rishwanth.dev /api/pad/x)
echo "$h" | grep -qi '^cross-origin-opener-policy: same-origin' && echo "$h" | grep -qi '^content-security-policy: .*sha256-' &&
    ok "the API's answers carry the site's headers too" || bad "API headers: $(echo "$h" | head -12)"
echo "$h" | grep -qi '^server:' && bad "a Server header is sent: $(echo "$h" | grep -i '^server:')" || ok "no Server header"

echo "the other sites"
h=$(headers ajar.rishwanth.dev /)
echo "$h" | grep -q '^HTTP/1.1 502' && echo "$h" | grep -qi "^content-security-policy: .*wss://ajar.rishwanth.dev" &&
    ok "ajar.rishwanth.dev goes to the relay, with its own policy" || bad "ajar site: $(echo "$h" | head -8)"
t=$(curl -s --resolve "preview.rishwanth.dev:$PORT:127.0.0.1" "http://preview.rishwanth.dev:$PORT/.wasmer/host.html")
echo "$t" | grep -q 'src="/wasmer-host.js"' && ok "the preview's control document" || bad "host.html: ${t:0:80}"
h=$(headers preview.rishwanth.dev /wasmer-service-worker.js)
echo "$h" | grep -qi '^service-worker-allowed: /' && echo "$h" | grep -qi '^content-type: text/javascript' && echo "$h" | grep -qi '^cross-origin-resource-policy: cross-origin' &&
    ok "its worker, allowed the whole origin" || bad "the preview's worker: $(echo "$h" | head -10)"
h=$(headers preview.rishwanth.dev /wasmer-host.js)
echo "$h" | grep -qi '^content-type: text/javascript' && ok "the SDK's half, as a script" || bad "wasmer-host.js: $(echo "$h" | grep -i content-type)"
[ "$(curl -s -o /dev/null -w '%{http_code}' --resolve "preview.rishwanth.dev:$PORT:127.0.0.1" "http://preview.rishwanth.dev:$PORT/anything")" = 404 ] &&
    ok "and nothing else there" || bad "preview served something else"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:$HTTP_PORT/some-pad?x=1" -H 'Host: code.rishwanth.dev')
[ "$loc" = "https://code.rishwanth.dev/some-pad?x=1" ] && ok "http goes to https, address and all" || bad "http redirect: $loc"
t=$(curl -s "http://127.0.0.1:$HTTP_PORT/.well-known/acme-challenge/t0k3n" -H 'Host: code.rishwanth.dev')
[ "$t" = token ] && ok "and certbot's challenges are answered over http" || bad "acme challenge: ${t:0:40}"

log=$(tail -1 "$tmp/code.log" 2>/dev/null || true)
echo "$log" | python3 -c 'import json,sys; e=json.loads(sys.stdin.read()); assert {"ts","ip","uri","status"} <= e.keys()' 2>/dev/null &&
    ok "each request is logged as a line of JSON" || bad "the log: ${log:0:120}"
curl -s -o /dev/null --resolve "code.rishwanth.dev:$PORT:127.0.0.1" -H 'Cookie: __Host-ajar=SECRET1' -H 'X-Pad-Code: SECRET2' \
    "http://code.rishwanth.dev:$PORT/auth/github/callback?code=SECRET3&state=s"
sleep 0.2
grep -q SECRET "$tmp/code.log" && bad "a cookie, a link's code or an OAuth code reached the log" || ok "and no cookie, link code or OAuth code is in it"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]

#!/bin/bash
# The rate limits in deploy/Caddyfile, exercised against a real Caddy.
#
#   GOARCH=amd64 deploy/caddy/build.sh && deploy/caddy/check.sh
#
# Runs the Caddyfile that ships, not a copy of it: hostnames become plain HTTP
# on a local port, the pad's root a temp directory, and every upstream a closed
# port. A request the limiter lets through is answered 502 or by the file; one
# it refuses is answered 429. That difference is all that is asserted.
#
# Linux only — two loopback source addresses stand in for two visitors, and
# 127.0.0.1 also for cloudflared, the one address whose CF-Connecting-IP the
# Caddyfile believes.
set -euo pipefail

cd "$(dirname "$0")/../.."
CADDY="${CADDY:-dist/caddy-linux-$(go env GOHOSTARCH 2>/dev/null || echo amd64)}"
[ -x "$CADDY" ] || { echo "no $CADDY — run deploy/caddy/build.sh first" >&2; exit 1; }
PORT=18080
tmp=$(mktemp -d)
trap 'kill $pid 2>/dev/null || true; rm -rf "$tmp"' EXIT

# The allowance each zone was given, read from the file rather than repeated
# here, so a changed number is tested as it stands.
events() {
    awk -v z="$1" '$1 == "zone" && $2 == z { on = 1 } on && $1 == "events" { print $2; exit }' deploy/Caddyfile
}
FILES=$(events pad_files)
DNS=$(events pad_dns)
WISP=$(events pad_wisp)

mkdir -p "$tmp/pad/packages" "$tmp/pad/vendor" "$tmp/pad/assets"
head -c 200000 /dev/zero > "$tmp/pad/packages/big.webc"
echo small > "$tmp/pad/packages/small.webc"
echo '{}' > "$tmp/pad/packages/manifest.json"
echo '{}' > "$tmp/pad/packages/registry.json"
echo 'export {}' > "$tmp/pad/vendor/sdk.js"
echo 'export {}' > "$tmp/pad/assets/app.js"
echo '<!doctype html><title>pad</title>' > "$tmp/pad/index.html"
echo '<!doctype html><title>Privacy — pad</title>' > "$tmp/pad/privacy.html"

# Caddy takes one block of global options, and first: the Caddyfile's own go
# into this one, and its block is left out of what follows.
global=$(awk '/^\{$/ { on = 1; next } on && /^\}$/ { exit } on' deploy/Caddyfile)
{
    printf '{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n\tstorage file_system %s/data\n%s\n}\n' "$tmp" "$global"
    awk 'state == 0 && /^\{$/ { state = 1; next } state == 1 { if (/^\}$/) state = 2; next } { print }' deploy/Caddyfile | sed -E \
        -e "s#^([a-z]+)\.rishwanth\.dev \{#http://\1.rishwanth.dev:$PORT {#" \
        -e "s#/srv/ajar/pad#$tmp/pad#g" \
        -e "s#/var/log/caddy/#$tmp/#g" \
        -e "s#reverse_proxy (127\.0\.0\.1:[0-9]+|https://cloudflare-dns\.com)#reverse_proxy 127.0.0.1:9#"
} > "$tmp/Caddyfile"

"$CADDY" validate --config "$tmp/Caddyfile" --adapter caddyfile >/dev/null 2>"$tmp/validate.err" || {
    cat "$tmp/validate.err" >&2
    exit 1
}
"$CADDY" run --config "$tmp/Caddyfile" --adapter caddyfile >"$tmp/caddy.out" 2>&1 &
pid=$!
for _ in $(seq 50); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
    sleep 0.1
done

pass=0 fail=0
ok() { pass=$((pass + 1)); echo "  ok    $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL  $1"; }

# status <from> <path> [curl args…]
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

echo "pad_files: $FILES per file per address"
r=$(spend "$FILES" 127.0.0.1 /packages/big.webc)
[ "$r" = 0 ] && ok "the first $FILES fetches of a file are served" || bad "$r of the first $FILES were refused"
[ "$(status 127.0.0.1 /packages/big.webc)" = 429 ] && ok "fetch $((FILES + 1)) is refused" || bad "fetch $((FILES + 1)) was served"

headers=$(curl -s -D - -o "$tmp/body" --interface 127.0.0.1 --resolve "code.rishwanth.dev:$PORT:127.0.0.1" \
    "http://code.rishwanth.dev:$PORT/packages/big.webc" | tr -d '\r')
echo "$headers" | grep -qi '^retry-after: [0-9]' && ok "the refusal says when to retry" || bad "no Retry-After"
echo "$headers" | grep -qi '^cache-control: no-store' && ok "the refusal is not cached" || bad "refusal cached: $(echo "$headers" | grep -i '^cache-control')"
grep -q "Too many requests" "$tmp/body" && ok "the refusal says what happened" || bad "body: $(head -c 80 "$tmp/body")"

for spelling in /packages//big.webc /packages/./big.webc /packages/x/../big.webc \
    //packages/big.webc /./packages/big.webc /%70ackages/big.webc; do
    s=$(status 127.0.0.1 "$spelling" --path-as-is)
    [ "$s" = 429 ] && ok "respelt as $spelling it is the same file ($s)" || bad "respelt as $spelling it got a fresh budget ($s)"
done

[ "$(status 127.0.0.1 /packages/small.webc)" = 200 ] && ok "another file from the same address is still served" || bad "another file was refused"
[ "$(status 127.0.0.2 /packages/big.webc)" = 200 ] && ok "the same file from another address is still served" || bad "another address was refused"
r=$(spend $((FILES + 5)) 127.0.0.1 /packages/no-such-file.webc)
[ "$r" = 0 ] && ok "a path that is not a file is never limited" || bad "a missing file was limited ($r refused)"
cc=$(curl -s -D - -o /dev/null --interface 127.0.0.2 --resolve "code.rishwanth.dev:$PORT:127.0.0.1" \
    "http://code.rishwanth.dev:$PORT/vendor/sdk.js" | tr -d '\r' | grep -i '^cache-control')
echo "$cc" | grep -q immutable && ok "a served file is still immutable" || bad "served file: $cc"
# cachecontrol <path>: the Cache-Control a file is served with
cachecontrol() {
    curl -s -D - -o /dev/null --interface 127.0.0.2 --resolve "code.rishwanth.dev:$PORT:127.0.0.1" \
        "http://code.rishwanth.dev:$PORT$1" | tr -d '\r' | grep -i '^cache-control' || true
}
cc=$(cachecontrol /packages/small.webc)
echo "$cc" | grep -q immutable && ok "a package is immutable" || bad "a package: $cc"
for page in /some-pad /index.html; do
    cc=$(cachecontrol "$page")
    echo "$cc" | grep -qi 'no-cache' && ! echo "$cc" | grep -q immutable &&
        ok "the page at $page is asked again each visit ($cc)" || bad "the page at $page: $cc"
done
cc=$(cachecontrol /assets/app.js)
echo "$cc" | grep -q immutable && ! echo "$cc" | grep -qi 'no-cache' && ok "a script beside it is still immutable" || bad "a script: $cc"
for list in manifest.json registry.json; do
    cc=$(cachecontrol "/packages/$list")
    echo "$cc" | grep -qi 'no-cache' && ! echo "$cc" | grep -q immutable &&
        ok "$list is asked again each visit ($cc)" || bad "$list: $cc"
done

echo "pad_dns: $DNS a minute per address"
r=$(spend "$DNS" 127.0.0.1 /dns-query)
[ "$r" = 0 ] && ok "the first $DNS lookups pass" || bad "$r of the first $DNS were refused"
[ "$(status 127.0.0.1 /dns-query)" = 429 ] && ok "lookup $((DNS + 1)) is refused" || bad "lookup $((DNS + 1)) passed"
[ "$(status 127.0.0.2 /dns-query)" != 429 ] && ok "another address still resolves" || bad "another address was refused"

# Whose budget a request spends. 127.0.0.1 is loopback, where cloudflared
# connects from through Cloudflare Tunnel, so its CF-Connecting-IP is the
# visitor; 127.0.0.2 is anyone else, and the header from them is a claim.
# 127.0.0.1 has spent its own DNS allowance above; 127.0.0.2 spends its own
# below, before it claims to be anyone else.
echo "the visitor behind the tunnel"
s=$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 203.0.113.7")
[ "$s" != 429 ] && ok "through the tunnel a visitor has a budget of their own, not loopback's ($s)" || bad "a visitor through the tunnel was given loopback's spent budget"
refused=0
for _ in $(seq "$DNS"); do
    [ "$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 203.0.113.7")" = 429 ] && refused=$((refused + 1))
done
[ "$refused" -ge 1 ] && ok "and spends it: lookup $((DNS + 1)) is refused" || bad "a visitor through the tunnel was never limited"
s=$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 203.0.113.8")
[ "$s" != 429 ] && ok "another visitor through the tunnel is not ($s)" || bad "another visitor through the tunnel shared the first one's budget"
refused=0
for _ in $(seq "$DNS"); do
    [ "$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 2001:db8:1:2::1")" = 429 ] && refused=$((refused + 1))
done
s=$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 2001:db8:1:2::2")
s2=$(status 127.0.0.1 /dns-query -H "CF-Connecting-IP: 2001:db8:1:3::1")
[ "$refused" = 0 ] && [ "$s" = 429 ] && [ "$s2" != 429 ] &&
    ok "an IPv6 visitor through the tunnel is counted by their /64, as one connecting directly is" ||
    bad "an IPv6 visitor through the tunnel: $refused of their own refused, then $s in the same /64 and $s2 in the next"
spend "$DNS" 127.0.0.2 /dns-query >/dev/null
[ "$(status 127.0.0.2 /dns-query)" = 429 ] || bad "127.0.0.2 still had lookups left; the claims below prove nothing"
refused=0
for i in $(seq 20); do
    [ "$(status 127.0.0.2 /dns-query -H "CF-Connecting-IP: 198.51.100.$i")" = 429 ] && refused=$((refused + 1))
done
[ "$refused" = 20 ] && ok "from anywhere else the header is ignored: a new claimed address each time is no new budget" || bad "a claimed CF-Connecting-IP from outside bought $((20 - refused)) lookups"

echo "pad_wisp: $WISP a minute per address"
r=$(spend "$WISP" 127.0.0.1 /wisp/)
[ "$r" = 0 ] && ok "the first $WISP connections pass" || bad "$r of the first $WISP were refused"
[ "$(status 127.0.0.1 /wisp)" = 429 ] && ok "connection $((WISP + 1)) is refused, with or without the slash" || bad "connection $((WISP + 1)) passed"

echo "everything else"
[ "$(status 127.0.0.1 /some-folder-name)" = 200 ] && ok "a folder page is not limited" || bad "a folder page was refused"
[ "$(status 127.0.0.1 /api/pad/x)" != 429 ] && ok "the relay's paths are left to the relay" || bad "/api was refused"
privacy=$(curl -s --resolve "code.rishwanth.dev:$PORT:127.0.0.1" "http://code.rishwanth.dev:$PORT/privacy")
echo "$privacy" | grep -q 'Privacy — pad' && ok "/privacy is the privacy policy, not the page" || bad "/privacy served: ${privacy:0:80}"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]

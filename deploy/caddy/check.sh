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
# Linux only — two loopback source addresses stand in for two visitors.
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
echo 'export {}' > "$tmp/pad/vendor/sdk.js"
echo '<!doctype html><title>pad</title>' > "$tmp/pad/index.html"

{
    printf '{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n\tstorage file_system %s/data\n}\n' "$tmp"
    sed -E \
        -e "s#^([a-z]+)\.rishwanth\.dev \{#http://\1.rishwanth.dev:$PORT {#" \
        -e "s#/srv/ajar/pad#$tmp/pad#g" \
        -e "s#/var/log/caddy/#$tmp/#g" \
        -e "s#reverse_proxy (127\.0\.0\.1:[0-9]+|https://cloudflare-dns\.com)#reverse_proxy 127.0.0.1:9#" \
        deploy/Caddyfile
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

echo "pad_dns: $DNS a minute per address"
r=$(spend "$DNS" 127.0.0.1 /dns-query)
[ "$r" = 0 ] && ok "the first $DNS lookups pass" || bad "$r of the first $DNS were refused"
[ "$(status 127.0.0.1 /dns-query)" = 429 ] && ok "lookup $((DNS + 1)) is refused" || bad "lookup $((DNS + 1)) passed"
[ "$(status 127.0.0.2 /dns-query)" != 429 ] && ok "another address still resolves" || bad "another address was refused"

echo "pad_wisp: $WISP a minute per address"
r=$(spend "$WISP" 127.0.0.1 /wisp/)
[ "$r" = 0 ] && ok "the first $WISP connections pass" || bad "$r of the first $WISP were refused"
[ "$(status 127.0.0.1 /wisp)" = 429 ] && ok "connection $((WISP + 1)) is refused, with or without the slash" || bad "connection $((WISP + 1)) passed"

echo "everything else"
[ "$(status 127.0.0.1 /some-folder-name)" = 200 ] && ok "a folder page is not limited" || bad "a folder page was refused"
[ "$(status 127.0.0.1 /api/pad/x)" != 429 ] && ok "the relay's paths are left to the relay" || bad "/api was refused"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]

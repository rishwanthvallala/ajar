#!/bin/bash
# Requests a second the relay answers, endpoint by endpoint, with wrk — for
# comparing with HttpArena's per-framework numbers (docs/dev/scaling.md,
# "Requests a second, against HttpArena").
#
#   scripts/relay-bench/run.sh relay     # the relay alone, two CPUs and 512 MB, as the box
#   scripts/relay-bench/run.sh caddy     # Caddy with TLS in front, the two sharing those CPUs
#   scripts/relay-bench/run.sh proxies   # Caddy and nginx in front, one CPU each
#
# Needs the relay's Linux build (below) and, for caddy and proxies, Caddy's
# (`deploy/caddy/build.sh`). Everything runs in podman, on a network and a
# volume of its own that it removes after; never against production.
#
#   podman run --rm -v "$PWD":/src -w /src docker.io/library/rust:1 \
#     bash -c "CARGO_TARGET_DIR=/src/target/container cargo build --release -p ajar-relay"
#
# Rootless podman cannot pin CPUs, so they are held by quota (--cpus): the
# relay's two are any two of the machine's. On a Mac those cores are faster
# than the box's Graviton2; read the numbers as relative.
set -euo pipefail
cd "$(dirname "$0")/../.."
B="$PWD/scripts/relay-bench"
BIN="${BIN:-$PWD/target/container/release/ajar-relay}"
CADDY="${CADDY:-$PWD/dist/caddy-linux-$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')}"
NET=ajar-bench VOL=ajar-bench-data R=ajar-bench-relay P=ajar-bench-proxy
WRK_IMAGE=ajar-bench-wrk
what="${1:-relay}"

[ -x "$BIN" ] || { echo "no relay build at $BIN — see the top of this file" >&2; exit 1; }
podman image exists $WRK_IMAGE || podman build -q -t $WRK_IMAGE "$B" >/dev/null
cleanup() {
    podman rm -f $R $P >/dev/null 2>&1 || true
    podman volume rm -f $VOL >/dev/null 2>&1 || true
    podman network rm -f $NET >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
podman network create $NET >/dev/null
podman volume create $VOL >/dev/null
wrk_run() { podman run --rm --network $NET --cpus 4 -v $VOL:/data -v "$B":/b "$@"; }

case "$what" in
relay)
    podman run -d --name $R --network $NET --cpus 2 --memory 512m -v "$BIN:/relay:ro" -v $VOL:/data \
        docker.io/library/rust:1 /relay --bind 0.0.0.0:8787 --trust-forwarded-for \
        --pad-dir /data/pads --accounts-db /data/a.db >/dev/null
    wrk_run -e CONNS="${CONNS:-64 256}" -e DUR="${DUR:-10}" $WRK_IMAGE bash /b/inside.sh
    podman stats --no-stream --format '{{.Name}} cpu {{.CPUPerc}} mem {{.MemUsage}}' $R
    ;;
caddy)
    [ -x "$CADDY" ] || { echo "no Caddy build at $CADDY — deploy/caddy/build.sh" >&2; exit 1; }
    podman run -d --name $R --network $NET --cpus 2 --memory 512m -v "$BIN:/relay:ro" -v "$CADDY:/caddy:ro" \
        -v $VOL:/data -v "$B":/b -e XDG_DATA_HOME=/tmp -e XDG_CONFIG_HOME=/tmp docker.io/library/rust:1 bash -c '
          /caddy run --config /b/Caddyfile.both --adapter caddyfile >/tmp/caddy.log 2>&1 &
          exec /relay --bind 127.0.0.1:8787 --trust-forwarded-for --pad-dir /data/pads --accounts-db /data/a.db' >/dev/null
    wrk_run -e U=https://ajar-bench-relay:8443 -e CONNS="${CONNS:-64 256}" -e DUR="${DUR:-10}" $WRK_IMAGE bash /b/inside.sh
    podman stats --no-stream --format '{{.Name}} cpu {{.CPUPerc}} mem {{.MemUsage}}' $R
    ;;
proxies)
    [ -x "$CADDY" ] || { echo "no Caddy build at $CADDY — deploy/caddy/build.sh" >&2; exit 1; }
    podman run -d --name $R --network $NET --cpus 2 --memory 512m -v "$BIN:/relay:ro" -v $VOL:/data \
        docker.io/library/rust:1 /relay --bind 0.0.0.0:8787 --trust-forwarded-for \
        --pad-dir /data/pads --accounts-db /data/a.db >/dev/null
    wrk_run -e CONNS=0 $WRK_IMAGE bash /b/inside.sh >/dev/null
    bench() {
        wrk_run $WRK_IMAGE bash -c '
          for path in /healthz /api/pad/bench-small; do
            for c in 64 256; do
              out=$(wrk -t4 -c$c -d10s --latency -s /b/xff.lua https://ajar-bench-proxy:8443$path 2>&1)
              printf "%-22s c=%-4s %10s rps  p99 %s\n" "$path" "$c" \
                "$(echo "$out" | awk "/Requests\/sec/ {print \$2}")" "$(echo "$out" | awk "\$1 == \"99%\" {print \$2}")"
            done
          done'
    }
    echo "== Caddy, one CPU"
    podman run -d --name $P --network $NET --cpus 1 -v "$B":/b -v "$CADDY:/caddy:ro" \
        -e XDG_DATA_HOME=/tmp -e XDG_CONFIG_HOME=/tmp docker.io/library/rust:1 \
        /caddy run --config /b/Caddyfile.proxy --adapter caddyfile >/dev/null
    sleep 3; bench; podman rm -f $P >/dev/null
    echo "== nginx, one CPU"
    podman run -d --name $P --network $NET --cpus 1 -v "$B/nginx.conf:/etc/nginx/nginx.conf:ro" docker.io/library/nginx:1.27 \
        sh -c 'openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/key.pem -out /tmp/cert.pem -days 1 -subj /CN=ajar-bench-proxy 2>/dev/null && exec nginx -g "daemon off;"' >/dev/null
    sleep 3; bench
    ;;
*) echo "relay, caddy or proxies" >&2; exit 2 ;;
esac

#!/bin/bash
# The perf lab: production's front (deploy/nginx) and the relay in one
# container, serving this tree's build of the pad, on a link shaped as a
# visitor's would be. What scripts/perf/run.mjs measures against, so that a
# number changes because the code did and not because the office network did.
#
#   scripts/perf/lab.sh start [fast|cable|4g|slow]   # then https://code.rishwanth.dev:18443
#   scripts/perf/lab.sh reset                        # nothing left queued, between scenarios
#   scripts/perf/lab.sh stop
#
# The browser maps *.rishwanth.dev to 127.0.0.1, takes the lab's self-signed
# certificate and uses no proxy — a proxy resolves the names itself, and
# would ask production (browser.mjs does all three). Needs the relay's Linux build
# (scripts/relay-bench/run.sh says how) and the pad built and compressed as
# the deploy does it: `npm run build:pad && node pad/scripts/compress-static.mjs`.
#
# Profiles, what the container sends shaped by netem:
#   fast   unshaped — this machine's loopback
#   cable  25 Mbit/s, 20 ms
#   4g     9 Mbit/s, 60 ms (a good mobile link)
#   slow   1.6 Mbit/s, 150 ms (Lighthouse's "slow 4G")
set -euo pipefail
cd "$(dirname "$0")/../.."
NAME=ajar-perf-lab IMAGE=ajar-bench-nginx PORT=18443
BIN="${BIN:-$PWD/target/container/release/ajar-relay}"
case "${1:-}" in
start)
    case "${2:-cable}" in
        fast) RATE="" DELAY="" ;;
        cable) RATE=25mbit DELAY=20ms ;;
        4g) RATE=9mbit DELAY=60ms ;;
        slow) RATE=1600kbit DELAY=150ms ;;
        *) echo "profiles: fast, cable, 4g, slow" >&2; exit 2 ;;
    esac
    [ -x "$BIN" ] || { echo "no relay build at $BIN" >&2; exit 1; }
    [ -f pad/dist/index.html ] || { echo "no pad build: npm run build:pad && node pad/scripts/compress-static.mjs" >&2; exit 1; }
    podman image exists $IMAGE && podman run --rm $IMAGE which tc >/dev/null 2>&1 ||
        podman build -q -t $IMAGE -f scripts/relay-bench/Containerfile.nginx scripts/relay-bench >/dev/null
    podman rm -f $NAME >/dev/null 2>&1 || true
    podman run -d --name $NAME --cap-add NET_ADMIN -p "$PORT:8443" -e RATE="$RATE" -e DELAY="$DELAY" \
        -v "$PWD/deploy/nginx:/conf:ro" -v "$PWD/pad/dist:/srv/ajar/pad:ro" -v "$BIN:/relay:ro" \
        -v "$PWD/scripts/perf:/perf:ro" --tmpfs /data $IMAGE bash /perf/lab-inside.sh >/dev/null
    for _ in $(seq 100); do
        # Past any proxy: one resolves the name itself, and asks production.
        if curl -skf -m 3 --noproxy '*' -o /dev/null --resolve "code.rishwanth.dev:$PORT:127.0.0.1" "https://code.rishwanth.dev:$PORT/api/limits"; then
            # The lab key's fingerprint, for the browser to trust (browser.mjs).
            mkdir -p target/perf
            podman exec $NAME cat /etc/ajar/lab.spki > target/perf/lab.spki
            exit 0
        fi
        sleep 0.2
    done
    podman logs $NAME >&2
    echo "the lab did not answer" >&2
    exit 1
    ;;
reset)
    # The link shaped afresh: nothing left queued from the scenario before.
    podman exec $NAME bash /perf/reshape.sh
    ;;
stop)
    podman rm -f $NAME >/dev/null 2>&1 || true
    ;;
*) echo "start [profile], reset or stop" >&2; exit 2 ;;
esac

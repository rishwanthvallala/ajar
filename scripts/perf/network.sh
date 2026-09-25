#!/usr/bin/env bash
# The floor every other number sits on: DNS, TCP, TLS and first byte to each
# origin, as the median of ten requests.
#
#   scripts/perf/network.sh [url…]
#
# A keystroke in a session crosses the relay twice — guest to relay to host and
# back — so twice the TCP connect time is the least an echo can cost. Costs
# nothing against any rate limit.
set -euo pipefail

urls=("$@")
[ ${#urls[@]} -gt 0 ] || urls=(https://code.rishwanth.dev/ https://ajar.rishwanth.dev/ https://ajar.rishwanth.dev/healthz)

for u in "${urls[@]}"; do
    for _ in $(seq 10); do
        curl -s -o /dev/null -w '%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{http_version}\n' "$u"
    done | sort -k4 -n | awk -v u="$u" '
        { a[NR] = $0 }
        END {
            split(a[int((NR + 1) / 2)], m, " ")
            printf "%-40s dns %4.0f ms  tcp %4.0f ms  tls %4.0f ms  first byte %4.0f ms  http/%s\n",
                u, m[1] * 1000, m[2] * 1000, m[3] * 1000, m[4] * 1000, m[5]
        }'
done

#!/bin/bash
# On the load generator: one wrk run per endpoint against $U, each request
# from its own address in $ADDR_HEADER. COOKIE and OWNED and SEQ are seeded first.
set -uo pipefail
cd "$(dirname "$0")"
run() {
  local label="$1"; shift
  for c in ${CONNS:-64 256}; do
    out=$(wrk -t2 -c"$c" -d"${DUR:-15}"s --latency "$@" 2>&1)
    printf '%-34s c=%-4s %10s rps  p50 %-8s p99 %-8s %s\n' "$label" "$c" \
      "$(echo "$out" | awk '/Requests\/sec/ {print $2}')" "$(echo "$out" | awk '$1 == "50%" {print $2}')" \
      "$(echo "$out" | awk '$1 == "99%" {print $2}')" "$(echo "$out" | awk '/Non-2xx/ {print "non-2xx " $5}') $(echo "$out" | grep 'Socket errors')"
  done
}
C="cookie: ajar=$TOKEN"
run "healthz" -s addr.lua "$U/healthz"
run "limits, anonymous" -s addr.lua "$U/api/limits"
run "limits, signed in" -s addr.lua -H "$C" "$U/api/limits"
run "me, signed in" -s addr.lua -H "$C" "$U/api/me"
run "pad read, anonymous 3 files" -s addr.lua "$U/api/pad/bench-small"
run "pad read, unchanged since seq" -s addr.lua -H "x-pad-seq: $SEQ" "$U/api/pad/bench-small"
run "pad read, owner signed in" -s addr.lua -H "$C" "$U/api/pad/$OWNED"
run "save 2 KB, 500 pads" -s put.lua "$U/"

#!/bin/bash
# On the load generator: the endpoints that tell the fronts apart, shorter.
set -uo pipefail
cd "$(dirname "$0")"
run() {
  local label="$1"; shift
  for c in ${CONNS:-64 256}; do
    out=$(wrk -t2 -c"$c" -d"${DUR:-10}"s --latency "$@" 2>&1)
    printf '%-30s c=%-4s %9s rps  p50 %-8s p99 %-8s %s\n' "$label" "$c" \
      "$(echo "$out" | awk '/Requests\/sec/ {print $2}')" "$(echo "$out" | awk '$1 == "50%" {print $2}')" \
      "$(echo "$out" | awk '$1 == "99%" {print $2}')" "$(echo "$out" | awk '/Non-2xx/ {print "non-2xx " $5}')"
  done
}
C="cookie: ajar=$TOKEN"
run "healthz" -s addr.lua "$U/healthz"
run "pad read, anonymous" -s addr.lua "$U/api/pad/bench-small"
run "pad read, owner" -s addr.lua -H "$C" "$U/api/pad/$OWNED"
run "save 2 KB" -s put.lua "$U/"

#!/bin/bash
# Runs in the wrk container: seed the relay, then one wrk run per endpoint.
set -uo pipefail
U=${U:-http://ajar-bench-relay:8787}
for _ in $(seq 100); do curl -skf $U/healthz >/dev/null && break; sleep 0.2; done
small='{"writes":[{"path":"main.py","content":"'$(printf 'print(%d)\\n' $(seq 60) | head -c 600)'"},{"path":"README.md","content":"'$(printf 'line %d\\n' $(seq 60) | head -c 500)'"},{"path":"util.py","content":"'$(printf 'x = %d\\n' $(seq 60) | head -c 400)'"}]}'
curl -skf -o /dev/null -X PUT -H 'content-type: application/json' -H 'x-forwarded-for: 10.200.0.1' "$U/api/pad/bench-small" -d "$small" || echo "seeding the anonymous pad failed"
TOKEN=benchtokenbenchtokenAA
HASH=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
NOW=$(date +%s)
sqlite3 -cmd '.timeout 5000' /data/a.db "INSERT INTO users (id, provider, provider_id, email, name, created) VALUES (1,'github','7',NULL,'bench',$NOW); INSERT INTO sessions VALUES (X'$HASH',1,$NOW,$((NOW + 86400)));" || echo "seeding the session failed"
C="cookie: ajar=$TOKEN"
OWNED=$(curl -skf -X POST -H "$C" -H 'x-ajar: 1' "$U/api/my/pads" | sed -E 's/.*"name":"([^"]+)".*/\1/')
curl -skf -o /dev/null -X PUT -H 'content-type: application/json' -H "$C" "$U/api/pad/$OWNED" -d "$small" || echo "seeding the owned pad failed"
SEQ=$(curl -skf -H 'x-forwarded-for: 10.200.0.2' "$U/api/pad/bench-small" | sed -E 's/.*"seq":([0-9]+).*/\1/')
echo "owned pad $OWNED; anonymous pad at seq $SEQ; $(curl -sk -H "$C" $U/api/me | head -c 80)"
run() {
  local label="$1"; shift
  for c in ${CONNS:-64 256}; do
    out=$(wrk -t4 -c"$c" -d"${DUR:-10}"s --latency "$@" 2>&1)
    rps=$(echo "$out" | awk '/Requests\/sec/ {print $2}')
    p50=$(echo "$out" | awk '$1 == "50%" {print $2}')
    p99=$(echo "$out" | awk '$1 == "99%" {print $2}')
    bad=$(echo "$out" | awk '/Non-2xx/ {print $5}')
    err=$(echo "$out" | awk '/Socket errors/ {print $0}')
    printf '%-34s c=%-4s %10s rps  p50 %-8s p99 %-8s %s %s\n' "$label" "$c" "$rps" "$p50" "$p99" "${bad:+non-2xx $bad}" "$err"
  done
}
[ "${CONNS:-}" = 0 ] && exit 0
run "healthz" -s /b/xff.lua "$U/healthz"
run "limits, anonymous" -s /b/xff.lua "$U/api/limits"
run "limits, signed in" -s /b/xff.lua -H "$C" "$U/api/limits"
run "me, signed in" -s /b/xff.lua -H "$C" "$U/api/me"
run "pad read, anonymous 3 files" -s /b/xff.lua "$U/api/pad/bench-small"
run "pad read, unchanged since seq" -s /b/xff.lua -H "x-pad-seq: $SEQ" "$U/api/pad/bench-small"
run "pad read, owner signed in" -s /b/xff.lua -H "$C" "$U/api/pad/$OWNED"
run "save 2 KB, 500 pads" -s /b/put.lua "$U/"

#!/bin/bash
# On the load generator: the anonymous pad, the owned pad and the pad's seq,
# through $U, with the session staging's database was given.
set -euo pipefail
small='{"writes":[{"path":"main.py","content":"'$(printf 'print(%d)\\n' $(seq 60) | head -c 600)'"},{"path":"README.md","content":"'$(printf 'line %d\\n' $(seq 60) | head -c 500)'"},{"path":"util.py","content":"'$(printf 'x = %d\\n' $(seq 60) | head -c 400)'"}]}'
C="cookie: ajar=$TOKEN"
curl -skf -o /dev/null -X PUT -H 'content-type: application/json' -H "$ADDR_HEADER: 10.200.0.1" "$U/api/pad/bench-small" -d "$small"
OWNED=$(curl -skf -X POST -H "$C" -H 'x-ajar: 1' "$U/api/my/pads" | sed -E 's/.*"name":"([^"]+)".*/\1/')
curl -skf -o /dev/null -X PUT -H 'content-type: application/json' -H "$C" "$U/api/pad/$OWNED" -d "$small"
SEQ=$(curl -skf -H "$ADDR_HEADER: 10.200.0.2" "$U/api/pad/bench-small" | sed -E 's/.*"seq":([0-9]+).*/\1/')
echo "OWNED=$OWNED SEQ=$SEQ"

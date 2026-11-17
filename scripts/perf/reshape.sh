#!/bin/bash
# In the perf lab's container: the link shaped as $RATE and $DELAY, on
# loopback, where podman's port forwarding on a Mac hands the browser's
# connections in — not eth0, which they never cross: shaped there, a 9.7 MB
# package came in 0.04 s on the "slow" link. Only what nginx sends from 8443,
# so its own calls to the relay go as they do on the box.
#
# Run again before each scenario (lab.sh reset): it drops whatever is still
# queued for a browser that has gone, which the next one would otherwise wait
# behind — a second to its first byte on the cable link.
tc qdisc del dev lo root 2>/dev/null || true
[ -n "${RATE:-}" ] || exit 0
tc qdisc add dev lo root handle 1: prio
tc qdisc add dev lo parent 1:3 handle 30: netem rate "$RATE" delay "${DELAY:-0ms}"
tc filter add dev lo protocol ip parent 1:0 prio 3 u32 match ip sport 8443 0xffff flowid 1:3
tc filter add dev lo protocol ipv6 parent 1:0 prio 4 u32 match ip6 sport 8443 0xffff flowid 1:3

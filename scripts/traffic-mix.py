#!/usr/bin/env python3
"""What the sites are really asked for, from Caddy's access logs on the box:
each kind of request, how many, how big, and the busiest second and minute.

The numbers a load test should be shaped like (docs/dev/scaling.md). Reads
the logs as they are kept — the current file and the rolled ones, gzipped or
not — and prints counts only: no address, no pad name, no path beyond its
kind.

    ssh ajar-relay 'sudo python3 -' < scripts/traffic-mix.py

or, for one site's logs, `sudo python3 - code` (ajar, code or preview).
"""
import collections
import glob
import gzip
import json
import sys

SITES = sys.argv[1:] or ["code", "ajar"]


def lines(path):
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", errors="replace") as f:
        yield from f


def kind(site, method, uri, headers):
    path = uri.split("?", 1)[0]
    if path.startswith("/api/pad/"):
        if "/history" in path:
            return "pad history"
        if path.endswith("/run"):
            return "pad last run, " + ("kept" if method == "PUT" else "read")
        if method == "PUT":
            return "pad save"
        return "pad read, unchanged check" if "X-Pad-Seq" in headers else "pad read"
    if path.startswith("/api/"):
        return "api " + path.split("/")[2]
    if path.startswith("/auth/"):
        return "sign-in"
    if path == "/ws":
        return f"socket ({site})"
    if path.startswith("/wisp"):
        return "wisp tunnel"
    if path == "/dns-query":
        return "dns lookup"
    if path.startswith("/packages/"):
        return "packages"
    if path.startswith(("/assets/", "/vendor/")):
        return "page scripts and styles"
    return f"page ({site})"


counts = collections.Counter()
sizes = collections.Counter()
statuses = collections.Counter()
per_second = collections.Counter()
per_minute = collections.Counter()
first = last = None
for site in SITES:
    for path in sorted(glob.glob(f"/var/log/caddy/{site}*.log*")):
        for line in lines(path):
            try:
                entry = json.loads(line)
                request = entry["request"]
                ts = float(entry["ts"])
            except (ValueError, KeyError, TypeError):
                continue
            k = kind(site, request.get("method", ""), request.get("uri", ""), request.get("headers", {}))
            counts[k] += 1
            sizes[k] += int(entry.get("size", 0) or 0)
            statuses[entry.get("status", 0) // 100] += 1
            per_second[int(ts)] += 1
            per_minute[int(ts) // 60] += 1
            first = ts if first is None else min(first, ts)
            last = ts if last is None else max(last, ts)

total = sum(counts.values())
if not total:
    sys.exit("no requests in /var/log/caddy for " + ", ".join(SITES))
days = max((last - first) / 86400, 1 / 1440)
print(f"{total:,} requests over {days:.1f} days ({total / days:,.0f} a day), sites: {', '.join(SITES)}")
print(f"busiest second: {max(per_second.values()):,} requests; busiest minute: {max(per_minute.values()):,} ({max(per_minute.values()) / 60:,.1f} a second)")
ranked = sorted(per_second.values())
print(f"seconds with any request: {len(ranked):,}; in those, 99th percentile {ranked[int(len(ranked) * 0.99) - 1 if len(ranked) > 1 else 0]:,} a second")
print("status classes: " + ", ".join(f"{c}xx {n:,}" for c, n in sorted(statuses.items())))
print()
print(f"{'kind':34} {'requests':>12} {'share':>7} {'average size':>14}")
for k, n in counts.most_common():
    print(f"{k:34} {n:>12,} {n / total:>6.1%} {sizes[k] / n / 1024:>11,.1f} KB")

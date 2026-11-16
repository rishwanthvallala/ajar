#!/usr/bin/env python3
"""How use of the pad grew, week by week, from what the box already keeps.

Read-only, and counts only — no name, email, address or pad name is printed:

- accounts.db: when each account was made, each owned pad, each payment;
- pads/store.db: when each pad still stored was made (a pad nobody touches
  lapses after its lease, so older weeks undercount);
- usage.db: pads opened a day, how many different pads, programs run, and
  each day's peak of people in pads at once (docs/dev/accounts.md, "Usage,
  counted as it happens") — counted since 17 October 2026 only.

Our own test pads (load-*, loadtest-*, bench-*, pair-*) are left out of the
pad counts; pads made by the live checks have ordinary names and are not.

    ssh ajar-relay 'sudo python3 -' < scripts/usage-history.py
"""
import collections
import datetime
import sqlite3

LIB = "/var/lib/ajar"
TESTS = ("load-", "loadtest-", "bench-", "pair-")


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def week(ts):
    day = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).date()
    return day - datetime.timedelta(days=day.weekday())


weeks = collections.defaultdict(collections.Counter)

accounts = ro(f"{LIB}/accounts.db")
for (created,) in accounts.execute("SELECT created FROM users"):
    weeks[week(created)]["accounts"] += 1
for (created,) in accounts.execute("SELECT created FROM pads WHERE owner_id IS NOT NULL"):
    weeks[week(created)]["owned pads"] += 1
try:
    for (paid_at,) in accounts.execute("SELECT paid_at FROM payments WHERE paid_at IS NOT NULL"):
        weeks[week(paid_at)]["payments"] += 1
except sqlite3.OperationalError:
    pass  # a relay from before payments

store = ro(f"{LIB}/pads/store.db")
for name, created_ms in store.execute("SELECT name, created_ms FROM pads"):
    if not name.startswith(TESTS):
        weeks[week(created_ms / 1000)]["pads"] += 1

usage = ro(f"{LIB}/usage.db")
peaks = collections.defaultdict(int)
for day, kind, n in usage.execute("SELECT day, kind, SUM(n) FROM counts WHERE kind IN ('open', 'pads', 'run', 'peak') GROUP BY day, kind"):
    wk = week(day * 86400)
    if kind == "peak":
        peaks[wk] = max(peaks[wk], n)
    else:
        weeks[wk][{"open": "opens", "pads": "pad-days", "run": "runs"}[kind]] += n
languages = collections.Counter(dict(usage.execute("SELECT key, SUM(n) FROM counts WHERE kind = 'run' GROUP BY key")))
since = usage.execute("SELECT MIN(day) FROM counts").fetchone()[0]

cols = ["accounts", "pads", "owned pads", "opens", "pad-days", "runs", "peak online", "payments"]
print(f"{'week of':10} " + " ".join(f"{c:>11}" for c in cols) + f" {'accounts, all':>14} {'pads, all':>10}")
total_accounts = total_pads = 0
for wk in sorted(weeks.keys() | peaks.keys()):
    w = weeks[wk]
    w["peak online"] = peaks.get(wk, 0)
    total_accounts += w["accounts"]
    total_pads += w["pads"]
    print(f"{wk.isoformat():10} " + " ".join(f"{w[c]:>11,}" for c in cols) + f" {total_accounts:>14,} {total_pads:>10,}")
print()
print(f"usage counted since {datetime.date.fromtimestamp(since * 86400) if since else 'never'};"
      " pad-days: different pads opened each day, summed — one pad opened on three days is three")
print("runs by language: " + ", ".join(f"{k or '?'} {n:,}" for k, n in languages.most_common()))

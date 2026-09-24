#!/usr/bin/env node
// What the relay does when someone is not being polite.
//
//   node scripts/smoke-abuse.mjs
//
// Every other suite here checks that the product works. This one checks that it
// **refuses and survives**, which is a different property and was not covered
// anywhere: `ws.rs` and `outbox.rs` — the handshake, the quota claim, and the
// backpressure that is supposed to bound memory — had no tests at all.
//
// The unit tests in `quota.rs` prove the arithmetic. They cannot prove the
// arithmetic is *reached*: with the claim in `ws.rs` removed entirely, all 64
// of them still pass. That gap is the reason this file exists, so the checks
// below connect real sockets and read real refusals rather than calling into
// the limiter directly.
//
// Nothing here may run against a deployed relay. It starts its own.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fail, finish, Guest, ok, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

/** Its own directory, so a filled store never touches a real one. */
const padDir = mkdtempSync(join(tmpdir(), "ajar-abuse-"));

const PORT = 8823;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

// Must match `quota::MAX_JOINS_PER_IP`. Read from the source rather than
// restated, so raising the ceiling cannot quietly make this check vacuous.
const QUOTA_RS = readFileSync(new URL("../crates/ajar-relay/src/quota.rs", import.meta.url), "utf8");
const MAX_JOINS = Number(/MAX_JOINS_PER_IP: usize = (\d+)/.exec(QUOTA_RS)[1]);
// Absent before reads were bounded per address, which is itself the finding.
const MAX_READS = Number(/MAX_READS_PER_IP: usize = (\d+)/.exec(QUOTA_RS)?.[1] ?? 32);

/** What the relay process holds in memory right now, in MiB. */
function rssMiB(pid) {
  if (process.platform === "linux") {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) / 1024 : NaN;
  }
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024;
}

/**
 * PUT a body and report the status the server actually sent.
 *
 * curl, not `fetch`, and not `node:http` either. The relay refuses an oversized
 * body from its Content-Length, before reading it — which is the behaviour worth
 * having, since it should not have to swallow 60 MB to decide it does not want
 * it. Both node clients then lose the response: they are still writing when the
 * socket closes and surface `ECONNRESET` instead of the 413 that was sent.
 * `Expect: 100-continue` did not help. curl reports 413 cleanly for the same
 * request, so the response is real and it is the client that cannot see it —
 * and a check that cannot see the answer is not evidence of anything.
 */
function putStatus(url, body) {
  const file = join(padDir, "body.json");
  writeFileSync(file, body);
  const out = execFileSync(
    "curl",
    ["-s", "-o", "/dev/null", "-w", "%{http_code} %{size_upload}", "--max-time", "90",
     "-X", "PUT", "-H", "content-type: application/json",
     "--data-binary", `@${file}`, url],
    { encoding: "utf8" },
  );
  const [status, uploaded] = out.trim().split(/\s+/).map(Number);
  return { status, uploaded };
}

const procs = new Procs();

function peer(name, session) {
  const p = new Guest(WS, session, name, null);
  p.role = "peer";
  return p;
}

/** Connect, and say how it went rather than throwing. */
async function tryConnect(p) {
  try {
    await p.connect();
    return { joined: true };
  } catch (e) {
    return { joined: false, why: String(e.message ?? e) };
  }
}

async function main() {
  // Its own directory as well. Without --pad-dir the relay writes to
  // ./ajar-pads, so running this from the repo root left twelve pads in the
  // tree — and they were committed before anybody noticed.
  const relay = procs.start(
    "target/debug/ajar-relay",
    ["--bind", `127.0.0.1:${PORT}`, "--pad-dir", join(padDir, "main")],
    "relay",
  );
  await waitForHealth(HTTP);

  // ------------------------------------------------- joins are bounded
  //
  // Joining used to be exempt from the quota outright — guests always, peers
  // whenever the name already existed, which is every pad after the first
  // visit. One address could hold unlimited sockets, each carrying an 8 MiB
  // outbox allowance, and nothing counted them.
  const held = [];
  const opener = peer("opener", "floodme");
  const first = await tryConnect(opener);
  if (!first.joined) return fail(`could not open the session at all: ${first.why}`);
  held.push(opener);

  let refusedAt = null;
  // One past the ceiling: the opener spent an Open slot, not a Join one, so a
  // full Join budget is still available behind it.
  for (let i = 0; i < MAX_JOINS + 1; i++) {
    const p = peer(`flood-${i}`, "floodme");
    const r = await tryConnect(p);
    if (r.joined) {
      held.push(p);
      continue;
    }
    refusedAt = { at: i, why: r.why };
    break;
  }

  if (refusedAt === null) {
    fail(`${MAX_JOINS + 1} joins from one address were all accepted — the quota is not reached`);
  } else if (!/rate_limited|too many/i.test(refusedAt.why)) {
    fail(`a join was refused, but not by the quota: ${refusedAt.why}`);
  } else {
    ok(`one address is held to ${MAX_JOINS} joins (refused the ${refusedAt.at + 1}th)`);
  }

  // -------------------------------------------- the disk cannot be filled
  //
  // Pads cost nothing to create and nothing bounded their sum, so roughly 640
  // writes at the per-pad cap filled the disk — after which the relay could
  // save nothing for anybody. The ceiling is a flag so this can be reached in a
  // few requests rather than a few gigabytes.
  const CEILING = 3 * 1024 * 1024;
  procs.start(
    "target/debug/ajar-relay",
    [
      "--bind",
      `127.0.0.1:${PORT + 1}`,
      "--pad-dir",
      padDir,
      "--max-store-bytes",
      String(CEILING),
    ],
    "relay-small",
  );
  const SMALL = `http://127.0.0.1:${PORT + 1}`;
  await waitForHealth(SMALL);

  const mb = "x".repeat(1024 * 1024);
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${SMALL}/api/pad/filler-${i}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ writes: [{ path: "big.txt", content: mb }] }),
    });
    statuses.push(r.status);
    if (r.status !== 200) break;
  }

  const stored = statuses.filter((c) => c === 200).length;
  const last = statuses[statuses.length - 1];
  if (last === 507) {
    ok(`the store refuses past its ceiling (507 after ${stored} pads)`);
  } else {
    fail(`filling the store past its ceiling returned ${last}, not 507`);
  }

  // Reads must keep working. Refusing writes is survival; refusing reads is an
  // outage, and a full disk should not become one.
  const readable = await fetch(`${SMALL}/api/pad/filler-0`).then((r) => r.ok);
  readable
    ? ok("a pad already stored is still readable when the store is full")
    : fail("a full store stopped serving what it already had");

  // ---------------------------------------- an oversized body is refused
  //
  // Not with the connection dropped or the process growing: read off the wire
  // up to a limit and then refused, so the memory cost of a request is a number
  // somebody chose rather than whatever the sender felt like sending.
  const huge = JSON.stringify({
    writes: [{ path: "big.txt", content: "y".repeat(60 * 1024 * 1024) }],
  });
  const oversized = putStatus(`${HTTP}/api/pad/toobig`, huge);

  // The status alone proves nothing. 60 MB of content is over the per-pad
  // 25 MiB cap as well, so it comes back 413 whether or not there is an HTTP
  // body limit — an earlier version of this check passed with the limit raised
  // back to 151 MiB and was measuring the wrong refusal entirely.
  //
  // What the body limit buys is that the relay stops *reading*. Measured: with
  // it, curl uploads ~55 MB of a 63 MB body and is cut off; without it, all
  // 63 MB go up and are buffered before anything rejects them. So the evidence
  // is how much the server was willing to take.
  if (oversized.status !== 413) {
    fail(`an oversized body returned ${oversized.status}, not 413`);
  } else if (oversized.uploaded >= huge.length) {
    fail(
      `refused, but only after reading all ${oversized.uploaded} bytes — the body limit is not cutting it short`,
    );
  } else {
    const mb = (n) => (n / 1048576).toFixed(0);
    ok(`an oversized body is cut off at ${mb(oversized.uploaded)} MB of ${mb(huge.length)} MB, then 413`);
  }

  // ------------------------------------ concurrent writes queue, not fail
  //
  // The limit on how many bodies are read at once has to be a queue. Refusing
  // the fifth simultaneous write would make a busy moment look like an outage,
  // and the point is only to stop the memory being unbounded.
  const together = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      fetch(`${HTTP}/api/pad/parallel-${i}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ writes: [{ path: "a.txt", content: "x".repeat(256 * 1024) }] }),
      }).then((r) => r.status),
    ),
  );
  const notOk = together.filter((c) => c !== 200);
  notOk.length === 0
    ? ok(`${together.length} writes at once all completed — the bound queues rather than refuses`)
    : fail(`concurrent writes returned ${[...new Set(notOk)].join(", ")} instead of queuing`);

  // ------------------------------- reading a pad costs a stream, not the pad
  //
  // Writes were bounded on the 24th; reads were not. Each read held the file,
  // the parsed pad and the serialised response at once — about three times the
  // pad — with nothing bounding how many ran together, against a unit with
  // MemoryMax=512M. One large pad and a handful of reads was an OOM kill, and
  // five of those in a minute is systemd giving up on the relay.
  //
  // So the check is the process's own memory while a dozen reads of a 24 MiB
  // pad run at once, not a status code: every read here succeeds either way.
  const BIG = 24 * 1024 * 1024;
  const put = await fetch(`${HTTP}/api/pad/bigread`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ writes: [{ path: "big.txt", content: "r".repeat(BIG) }] }),
  });
  if (!put.ok) return fail(`could not store the pad the read checks need: ${put.status}`);

  await sleep(300);
  const before = rssMiB(relay.pid);
  let peak = before;
  const sampler = setInterval(() => (peak = Math.max(peak, rssMiB(relay.pid))), 5);
  const reads = await Promise.all(
    Array.from({ length: 12 }, () =>
      fetch(`${HTTP}/api/pad/bigread`).then(async (r) => ({ status: r.status, body: await r.text() })),
    ),
  );
  clearInterval(sampler);
  peak = Math.max(peak, rssMiB(relay.pid));

  const whole = reads.every((r) => {
    if (r.status !== 200) return false;
    const pad = JSON.parse(r.body);
    return pad.exists === true && pad.files["big.txt"]?.content.length === BIG;
  });
  if (!whole) {
    fail(`not every concurrent read came back whole: ${reads.map((r) => r.status).join(",")}`);
  } else {
    ok("twelve reads of a 24 MiB pad at once all came back whole");
  }
  const grew = peak - before;
  grew < 96
    ? ok(`and the relay grew by ${grew.toFixed(0)} MiB doing it — the pad is streamed, not held`)
    : fail(`twelve reads of a 24 MiB pad grew the relay by ${grew.toFixed(0)} MiB`);

  // One address cannot hold every read slot. Responses are left unread, so
  // each one holds its slot for as long as a slow client would.
  const holding = [];
  let readRefused = null;
  for (let i = 0; i < MAX_READS + 1; i++) {
    const r = await fetch(`${HTTP}/api/pad/bigread`);
    if (r.status === 200) holding.push(r);
    else {
      readRefused = { at: i, status: r.status };
      await r.body?.cancel();
      break;
    }
  }
  readRefused?.at === MAX_READS && readRefused.status === 429
    ? ok(`one address is held to ${MAX_READS} pad reads in flight, then 429`)
    : fail(`held ${holding.length} unread pad reads against a cap of ${MAX_READS}: ${JSON.stringify(readRefused)}`);

  for (const r of holding.splice(0)) await r.body?.cancel();
  await sleep(500);
  const readAgain = await fetch(`${HTTP}/api/pad/bigread`).then(async (r) => {
    await r.body?.cancel();
    return r.status;
  });
  readAgain === 200
    ? ok("abandoning those reads gives the slots back")
    : fail(`a read was still refused after the held ones were abandoned: ${readAgain}`);

  // ------------------------------------ the egress tunnel is bounded too
  //
  // Not the relay, but the same question: wisp-server.mjs capped the sockets
  // *inside* a tunnel at 32 and did not cap tunnels, so N connections x 32 was
  // unlimited concurrent TCP leaving this instance's address. That is the shape
  // that gets an IP blocked rather than merely busy.
  const WISP_PORT = 8792;
  procs.start("node", ["deploy/wisp-server.mjs"], "wisp", {
    env: { ...process.env, WISP_PORT: String(WISP_PORT) },
  });
  await sleep(1500);

  const perIp = Number(
    /MAX_TUNNELS_PER_IP = (\d+)/.exec(
      readFileSync(new URL("../deploy/wisp-server.mjs", import.meta.url), "utf8"),
    )[1],
  );
  const tunnel = () =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${WISP_PORT}/`);
      ws.addEventListener("open", () => resolve({ open: true, ws }));
      ws.addEventListener("error", () => resolve({ open: false }));
      setTimeout(() => resolve({ open: false }), 5000);
    });

  const tunnels = [];
  let tunnelRefusedAt = null;
  for (let i = 0; i < perIp + 2; i++) {
    const r = await tunnel();
    if (r.open) tunnels.push(r.ws);
    else {
      tunnelRefusedAt = i;
      break;
    }
  }
  tunnelRefusedAt === perIp
    ? ok(`one address is held to ${perIp} egress tunnels`)
    : fail(
        `opened ${tunnels.length} tunnels against a cap of ${perIp} (refused at ${tunnelRefusedAt})`,
      );

  for (const ws of tunnels.splice(0)) ws.close();
  await sleep(1000);
  const reopened = await tunnel();
  reopened.open
    ? ok("closing a tunnel frees its slot")
    : fail("the tunnel allowance did not come back after closing");
  reopened.ws?.close();

  // ------------------------------------------- and the relay is still alive
  //
  // Refusing is only half of it. A limiter that takes the process down with it
  // has not helped anyone, so the next thing must be served normally.
  const alive = await fetch(`${HTTP}/healthz`)
    .then((r) => r.ok)
    .catch(() => false);
  alive
    ? ok("the relay still answers after being flooded")
    : fail("the relay stopped answering once the flood was refused");

  // ------------------------------------------------ slots come back
  //
  // A ceiling nobody can get back under is an outage with extra steps.
  for (const p of held.splice(1)) p.close?.();
  await sleep(500);
  const again = await tryConnect(peer("after", "floodme"));
  again.joined
    ? ok("closing the flood frees the allowance again")
    : fail(`still refused after the flood closed: ${again.why}`);

  rmSync(padDir, { recursive: true, force: true });
  finish(procs, "the relay refuses abuse and keeps serving");
}

main().catch((e) => {
  console.error(e);
  rmSync(padDir, { recursive: true, force: true });
  finish(procs, null);
  process.exit(1);
});

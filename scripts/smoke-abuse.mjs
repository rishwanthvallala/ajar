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

import { fail, finish, Guest, ok, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const PORT = 8823;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

// Must match `quota::MAX_JOINS_PER_IP`. Read from the source rather than
// restated, so raising the ceiling cannot quietly make this check vacuous.
const MAX_JOINS = Number(
  /MAX_JOINS_PER_IP: usize = (\d+)/.exec(
    await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../crates/ajar-relay/src/quota.rs", import.meta.url), "utf8"),
    ),
  )[1],
);

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
  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
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

  finish(procs, "the relay refuses abuse and keeps serving");
}

main().catch((e) => {
  console.error(e);
  finish(procs, null);
  process.exit(1);
});

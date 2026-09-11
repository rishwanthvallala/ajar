#!/usr/bin/env node
// Peer sessions, end to end — the relay with no agent behind it at all.
//
// Every other suite here starts an agent first, because a hosted session is
// meaningless without one. This one starts only the relay: peer sessions are
// browsers talking to each other, and the point is that nothing is running on
// anybody's machine.
//
//   node scripts/smoke-peer.mjs

import {
  CH_DOC,
  CH_PRESENCE,
  DOC_UPDATE,
  encode,
  fail,
  finish,
  Guest,
  json,
  ok,
  Procs,
  sleep,
  waitForHealth,
} from "./lib/wire.mjs";

const PORT = 8821;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

const procs = new Procs();

/** A browser in a peer session. No key: this tier stores plaintext. */
function peer(name, session) {
  const p = new Guest(WS, session, name, null);
  p.role = "peer";
  return p;
}

/**
 * A CRDT update on the doc channel.
 *
 * Byte 0 is the kind tag, exactly as `tagged()` writes it on the real client —
 * the receiver reads it off and hands the rest to Yjs. Sending untagged bytes
 * here silently loses the first character of the payload.
 */
function update(p, streamId, body) {
  const text = new TextEncoder().encode(body);
  const payload = new Uint8Array(text.length + 1);
  payload[0] = DOC_UPDATE;
  payload.set(text, 1);
  p.send(encode({ channel: CH_DOC, streamId, payload }));
}

async function main() {
  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${PORT}`], "relay");
  await waitForHealth(HTTP);
  ok("relay is up — and that is the whole server side of this tier");

  // ---------------------------------------------------------------- open
  //
  // No agent opened this name. Nobody registered it. A peer just asks for it
  // and it exists, which is what makes a bare URL work.
  const a = peer("ana", "demowork");
  await a.connect();
  ok(`opening a name nobody had works — ana is participant ${a.participantId}`);

  if (a.participantId === 0) {
    fail("participant id 0 collides with TARGET_ALL on the wire");
  }

  const b = peer("bo", "demowork");
  await b.connect();
  ok(`a second peer joined the same name — bo is participant ${b.participantId}`);

  if (a.participantId === b.participantId) {
    fail(`both peers were given the same id (${a.participantId})`);
  }

  // ana should have been told bo arrived.
  await a.waitUntil(
    (g) => g.control.some((m) => m.t === "joined" && m.participant.id === b.participantId),
    "ana to hear that bo joined",
  );
  ok("an arrival is announced to everyone already in the room");

  // ------------------------------------------------------------ broadcast
  const seen = [];
  b.onDoc = (streamId, kind, bytes) => seen.push(new TextDecoder().decode(bytes));

  const mine = [];
  a.onDoc = (streamId, kind, bytes) => mine.push(new TextDecoder().decode(bytes));

  update(a, 7, "ana-typed-this");
  await b.waitUntil(() => seen.length > 0, "bo to receive ana's update");
  if (seen[0] !== "ana-typed-this") {
    fail(`bo received the wrong payload: ${seen[0]}`);
  } else {
    ok("a peer's update reaches the other peer with its payload intact");
  }

  // The sender must not hear its own broadcast. To a CRDT an echo is a second
  // edit, and the document ends up with the text twice.
  await sleep(300);
  if (mine.length > 0) {
    fail(`ana received her own broadcast back (${mine.length} frames)`);
  } else {
    ok("the sender does not get its own frame echoed back");
  }

  // ------------------------------------------------------- three in a room
  const c = peer("cy", "demowork");
  await c.connect();
  const roster = c.control.find((m) => m.t === "welcome");
  if (!roster || roster.participants.length !== 3) {
    fail(`a newcomer should see all three participants, saw ${roster?.participants?.length}`);
  } else {
    ok("a newcomer's welcome lists everyone already in the room");
  }

  const heard = [];
  c.onDoc = (streamId, kind, bytes) => heard.push(new TextDecoder().decode(bytes));
  seen.length = 0;
  update(a, 7, "to-everyone");
  await c.waitUntil(() => heard.length > 0, "cy to receive the broadcast");
  await b.waitUntil(() => seen.length > 0, "bo to receive the broadcast");
  ok("one broadcast reaches every other peer, not just the newest");

  // ------------------------------------------------------------- presence
  // Names live on the presence channel here exactly as they do in a hosted
  // session, so the client code that renders them is the same code.
  b.presence.length = 0;
  a.send(json(CH_PRESENCE, { t: "iam", name: "ana" }));
  await b.waitUntil(
    (g) => g.presence.some((m) => m.t === "iam" && m.name === "ana"),
    "bo to learn ana's name",
  );
  ok("presence crosses between peers, so names work without a host");

  // --------------------------------------------------------------- leaving
  //
  // Read the id before closing: a client forgets its participant id on
  // disconnect, because the relay issues a new one on every join and reusing
  // the old one gets every frame refused. Comparing against it afterwards
  // compares against null and the check can never pass.
  const cyId = c.participantId;
  c.close();
  await b.waitUntil(
    (g) => g.control.some((m) => m.t === "left" && m.participant_id === cyId),
    "bo to hear that cy left",
  );
  ok("a departure is announced to everyone still there");

  // ------------------------------------------------- the room is not kept
  //
  // Nothing is running and the files are not stored here, so an empty peer
  // session has no reason to survive. Proven from the outside: the ids a new
  // arrival gets start over, which only happens on a session that was new.
  a.close();
  b.close();
  await sleep(400);

  const after = peer("late", "demowork");
  await after.connect();
  if (after.participantId !== 1) {
    fail(
      `the empty session was kept — a fresh peer got id ${after.participantId} ` +
        `rather than starting over at 1`,
    );
  } else {
    ok("an empty peer session is forgotten rather than held open");
  }
  after.close();

  // --------------------------------------------------- shapes do not mix
  //
  // An agent must not be able to take a name people are editing in a browser,
  // or one room would have two sets of routing rules in it.
  const shared = peer("holder", "contested");
  await shared.connect();

  const agent = new Guest(WS, "contested", "agent", null);
  agent.role = "host";
  let refused = null;
  try {
    await agent.connect();
  } catch (e) {
    refused = e.message;
  }
  if (!refused) {
    fail("an agent was allowed to host a name already held by peers");
  } else {
    ok(`an agent is refused a peer-held name (${refused})`);
  }
  shared.close();

  finish(procs, "peer sessions work with no agent anywhere");
}

main().catch((e) => {
  fail(e.stack || e.message);
});

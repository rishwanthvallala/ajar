#!/usr/bin/env node
// Load on one relay, and where it stops keeping up: pad reads, saves, and pad
// rooms full of typing, each at rising concurrency. A measurement, not a
// check — docs/dev/scaling.md has what it gave and how it was run.
//
// Point it at a relay started with --trust-forwarded-for, so that each
// simulated person comes from an address of their own (X-Forwarded-For, as
// Caddy sends it) rather than all of them meeting the per-address limits at
// once. Never at production: it is a load test.
//
//   RELAY=http://127.0.0.1:18787 node scripts/relay-load.mjs [reads|writes|rooms|all]
//
// STEP_S sets how long each level runs (default 12 s).

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const RELAY = process.env.RELAY ?? "http://127.0.0.1:18787";
const WS_URL = `${RELAY.replace(/^http/, "ws")}/ws`;
const STEP_MS = Number(process.env.STEP_S ?? 12) * 1000;
const which = process.argv[2] ?? "all";

let addresses = 0;
const address = () => {
  addresses += 1;
  return `10.${(addresses >> 16) & 255}.${(addresses >> 8) & 255}.${addresses & 255}`;
};
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (bytes, seed) => `${"x".repeat(Math.max(0, bytes - 12))}${String(seed).padStart(12, "0")}`;

async function put(name, writes, from = address()) {
  const res = await fetch(`${RELAY}/api/pad/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-forwarded-for": from },
    body: JSON.stringify({ writes }),
  });
  await res.arrayBuffer();
  return res.status;
}

/** A pad of `files` files of `each` bytes, written in parts the relay takes. */
async function seed(name, files, each) {
  const writes = Array.from({ length: files }, (_, i) => ({ path: `f${i}.txt`, content: text(each, i) }));
  const per = Math.max(1, Math.floor((20 * 1024 * 1024) / Math.max(each, 1)));
  for (let i = 0; i < writes.length; i += per) {
    const status = await put(name, writes.slice(i, i + per));
    if (status !== 200) throw new Error(`seeding ${name}: ${status}`);
  }
}

/** Concurrency `c`, each worker reading `name` again as soon as it has it. */
async function readLevel(name, c) {
  const times = [];
  const statuses = {};
  let bytes = 0;
  const end = Date.now() + STEP_MS;
  await Promise.all(Array.from({ length: c }, async () => {
    const from = address();
    while (Date.now() < end) {
      const t = performance.now();
      try {
        const res = await fetch(`${RELAY}/api/pad/${name}`, { headers: { "x-forwarded-for": from } });
        const body = await res.arrayBuffer();
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        if (res.status === 200) {
          bytes += body.byteLength;
          times.push(performance.now() - t);
        }
      } catch {
        statuses.error = (statuses.error ?? 0) + 1;
      }
    }
  }));
  const seconds = STEP_MS / 1000;
  return { concurrency: c, perSecond: Math.round(times.length / seconds), mbPerSecond: +(bytes / seconds / 1048576).toFixed(1), p50: pct(times, 50), p99: pct(times, 99), statuses };
}

/** `users` people, each on a pad of their own, saving a small file every 500 ms as autosave does. */
async function writeLevel(users) {
  const names = Array.from({ length: users }, (_, i) => `load-w-${Date.now().toString(36)}-${i}`);
  await Promise.all(names.map((n) => put(n, [{ path: "main.py", content: text(2048, 0) }])));
  const times = [];
  const statuses = {};
  const end = Date.now() + STEP_MS;
  await Promise.all(names.map(async (name, u) => {
    const from = address();
    let i = 0;
    await sleep(Math.random() * 500);
    while (Date.now() < end) {
      const started = performance.now();
      i += 1;
      try {
        const status = await put(name, [{ path: "main.py", content: text(2048, i) }], from);
        statuses[status] = (statuses[status] ?? 0) + 1;
        if (status === 200) times.push(performance.now() - started);
      } catch {
        statuses.error = (statuses.error ?? 0) + 1;
      }
      const spent = performance.now() - started;
      if (spent < 500) await sleep(500 - spent);
    }
    void u;
  }));
  const seconds = STEP_MS / 1000;
  return { users, savesPerSecond: Math.round(times.length / seconds), wanted: users * 2, p50: pct(times, 50), p99: pct(times, 99), statuses };
}

const HEADER = 9;
const frame = (channel, stream, target, payload) => {
  const out = Buffer.alloc(HEADER + payload.length);
  out[0] = channel;
  out.writeUInt32LE(stream, 1);
  out.writeUInt32LE(target, 5);
  payload.copy(out, HEADER);
  return out;
};

/** One peer in pad `room`: says hello, and resolves with its id once welcomed. */
function peer(room, onDoc) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { "x-forwarded-for": address() } });
    ws.binaryType = "nodebuffer";
    const timer = setTimeout(() => reject(new Error("no welcome")), 15000);
    ws.on("open", () => ws.send(frame(0x01, 0, 0, Buffer.from(JSON.stringify({ t: "hello", session: room, role: "peer" })))));
    ws.on("message", (data) => {
      const channel = data[0];
      if (channel === 0x01) {
        const msg = JSON.parse(data.subarray(HEADER).toString());
        if (msg.t === "welcome") {
          clearTimeout(timer);
          resolve({ ws, id: msg.participant_id });
        }
      } else if (channel === 0x05) onDoc(data);
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** `rooms` rooms of `size` people, each typing five updates a second, as a person types. */
async function roomLevel(rooms, size) {
  const latencies = [];
  let delivered = 0;
  let failed = 0;
  const people = [];
  const prefix = `load-r-${Date.now().toString(36)}`;
  for (let r = 0; r < rooms; r++) {
    const joined = await Promise.allSettled(Array.from({ length: size }, () => peer(`${prefix}-${r}`, (data) => {
      delivered += 1;
      const sent = Number(data.readBigUInt64LE(HEADER + 1));
      latencies.push(Number(process.hrtime.bigint() / 1000n) / 1000 - sent / 1000);
    })));
    for (const j of joined) j.status === "fulfilled" ? people.push(j.value) : (failed += 1);
  }
  const typing = people.map(({ ws, id }) => setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const payload = Buffer.alloc(1 + 8 + 51);
    payload[0] = 0x01; // DOC_UPDATE
    payload.writeBigUInt64LE(process.hrtime.bigint() / 1000n, 1);
    ws.send(frame(0x05, 7, id, payload));
  }, 200));
  const sentAt = Date.now();
  await sleep(STEP_MS);
  for (const t of typing) clearInterval(t);
  const seconds = (Date.now() - sentAt) / 1000;
  await sleep(500);
  for (const { ws } of people) ws.close();
  const expected = Math.round(people.length * 5 * (size - 1) * seconds);
  return { rooms, size, sockets: people.length, joinFailures: failed, deliveredPerSecond: Math.round(delivered / seconds), expectedPerSecond: Math.round(expected / seconds), p50ms: pct(latencies, 50), p99ms: pct(latencies, 99) };
}

const results = {};
if (which === "reads" || which === "all") {
  const small = `load-small-${Date.now().toString(36)}`;
  const big = `load-big-${Date.now().toString(36)}`;
  await seed(small, 20, 2 * 1024);
  await seed(big, 50, 100 * 1024);
  results.readsSmall = [];
  for (const c of [1, 8, 32, 64, 128]) {
    const r = await readLevel(small, c);
    results.readsSmall.push(r);
    console.log("read 40 KB pad", JSON.stringify(r));
  }
  results.readsBig = [];
  for (const c of [1, 8, 32, 64]) {
    const r = await readLevel(big, c);
    results.readsBig.push(r);
    console.log("read 5 MB pad", JSON.stringify(r));
  }
}
if (which === "writes" || which === "all") {
  results.writes = [];
  for (const users of [10, 50, 100, 200, 400]) {
    const r = await writeLevel(users);
    results.writes.push(r);
    console.log("saves", JSON.stringify(r));
  }
}
if (which === "rooms" || which === "all") {
  results.rooms = [];
  for (const [rooms, size] of [[25, 4], [100, 4], [250, 4], [1, 20], [1, 50]]) {
    const r = await roomLevel(rooms, size);
    results.rooms.push(r);
    console.log("rooms", JSON.stringify(r));
  }
}
console.log(JSON.stringify(results));
process.exit(0);

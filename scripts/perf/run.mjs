#!/usr/bin/env node
// The perf scorecard (docs/dev/performance.md): every number that says how
// fast and how big the pad is, measured the same way each time and set
// against the baseline — so that making one better never quietly makes
// another worse. Run it before a change and after; a regression past the
// tolerance below fails it.
//
//   node scripts/perf/run.mjs                    # the browser scenarios in the perf lab (lab.sh): cable, fast, slow, cable-cpu4
//   node scripts/perf/run.mjs --server           # and the relay's and nginx's benchmarks and the load test (podman, ~15 min)
//   node scripts/perf/run.mjs --live             # and a newcomer on production, and DNS (a live check: once)
//   node scripts/perf/run.mjs --ajar             # and a session of ajar: host, relay and guests, on links of set lengths (ajar-lab.mjs)
//   node scripts/perf/run.mjs --only ajar-live   # a session through production, this tree's agent (a live check: once)
//   node scripts/perf/run.mjs --save             # what this run measured becomes the baseline
//   --profiles cable,slow   --scenarios collab   --runs 3   --only lab|server|live|ajar|ajar-live
//   --ajar-profiles near,office
//
// Needs the pad built and compressed as the deploy does, and the relay's
// Linux build (lab.sh says how). Results go to target/perf/<when>.json; the
// baseline is docs/dev/perf-baseline.json.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BASELINE = `${ROOT}docs/dev/perf-baseline.json`;
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const option = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const PROFILES = option("--profiles", "cable,fast,slow,cable-cpu4").split(",");
const RUNS = Number(option("--runs", "3"));
const ONLY = option("--only", null);
/** In place of each profile's own scenarios (PROFILE), for measuring one again. */
const ONLY_SCENARIOS = option("--scenarios", null);
const AJAR_PROFILES = option("--ajar-profiles", "near,office,abroad").split(",");
const want = (part) =>
  ONLY ? ONLY === part : part === "lab" || (part === "server" && flag("--server")) || (part === "live" && flag("--live")) || (part === "ajar" && flag("--ajar"));
/**
 * Each profile: the lab's link, the page's CPU slowed or not, and which
 * scenarios it is worth — a slow link or CPU, only what a newcomer meets first.
 */
const PROFILE = {
  fast: { link: "fast", scenarios: "edit,run-now,run-settled,return,collab" },
  cable: { link: "cable", scenarios: "edit,run-now,run-settled,return,collab" },
  "4g": { link: "4g", scenarios: "edit,run-now,run-settled" },
  slow: { link: "slow", scenarios: "edit,run-now" },
  "cable-cpu4": { link: "cable", cpu: 4, scenarios: "edit,run-now" },
};

const results = {};
const put = (key, value) => {
  if (value !== null && value !== undefined) results[key] = value;
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const say = (m) => process.stderr.write(`  ${m}\n`);

/** Run a command to its end, its output kept; stderr shown. */
function capture(cmd, argv, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${argv.join(" ")} exited ${code}\n${out.slice(-2000)}`))));
  });
}

/** The browser scenarios' JSON lines, as a median per metric across runs. */
function aggregate(prefix, out) {
  const rows = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const by = {};
  for (const { scenario, run, ...metrics } of rows) {
    for (const [k, v] of Object.entries(metrics)) (by[`${prefix}.${scenario}.${k}`] ??= []).push(v);
  }
  for (const [k, vs] of Object.entries(by)) put(k, typeof vs[0] === "number" ? median(vs) : vs.at(-1));
}

// ---------------------------------------------------------------- the lab

if (want("lab")) {
  if (!existsSync(`${ROOT}pad/dist/index.html`)) throw new Error("no pad build: npm run build:pad && node pad/scripts/compress-static.mjs");
  for (const profile of PROFILES) {
    const { link, cpu } = PROFILE[profile];
    const scenarios = ONLY_SCENARIOS ?? PROFILE[profile].scenarios;
    say(`lab, ${profile}: ${scenarios}, ${RUNS} runs`);
    execFileSync(`${ROOT}scripts/perf/lab.sh`, ["start", link], { stdio: "inherit" });
    try {
      const out = await capture("node", ["scripts/perf/browser.mjs", "https://code.rishwanth.dev:18443", scenarios, String(RUNS)], { LAB: "1", ...(cpu ? { CPU_SLOWDOWN: String(cpu) } : {}) });
      aggregate(`lab.${profile}`, out);
    } finally {
      execFileSync(`${ROOT}scripts/perf/lab.sh`, ["stop"], { stdio: "inherit" });
    }
  }
}

// ---------------------------------------------------------------- a session of ajar

if (want("ajar")) {
  for (const bin of ["target/release/ajar", "target/release/ajar-relay", "web/dist/index.html"]) {
    if (!existsSync(`${ROOT}${bin}`)) throw new Error(`no ${bin}: cargo build --release -p ajar -p ajar-relay && npm run build:ajar`);
  }
  // As the deploy ships it: a compressed copy beside each file, which the relay sends.
  execFileSync("node", ["pad/scripts/compress-static.mjs", "web/dist"], { cwd: ROOT, stdio: "ignore" });
  for (const profile of AJAR_PROFILES) {
    say(`ajar, ${profile}: ${ONLY_SCENARIOS ?? "its scenarios"}, ${RUNS} runs`);
    aggregate(`ajar.${profile}`, await capture("node", ["scripts/perf/ajar-lab.mjs", profile, ONLY_SCENARIOS ?? "", String(RUNS)]));
  }
}
if (want("ajar-live")) {
  say("ajar, live: a session through production, once");
  aggregate("ajar.live", await capture("node", ["scripts/perf/ajar-lab.mjs", "live", ONLY_SCENARIOS ?? "", "1"]));
}

// ---------------------------------------------------------------- the server

if (want("server")) {
  const bench = (mode) => {
    say(`server: relay-bench ${mode}`);
    const out = execFileSync(`${ROOT}scripts/relay-bench/run.sh`, [mode], { cwd: ROOT, encoding: "utf8", env: { ...process.env, DUR: "8" } });
    for (const line of out.split("\n")) {
      const m = /^(.+?)\s+c=(\d+)\s+([\d.]+) rps\s+p50 (\S+)\s+p99 (\S+)/.exec(line);
      if (!m) continue;
      const ms = (v) => (v.endsWith("us") ? parseFloat(v) / 1000 : v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000);
      const key = `server.${mode}.${m[1].trim().replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.c${m[2]}`;
      put(`${key}.rps`, Math.round(parseFloat(m[3])));
      put(`${key}.p99_ms`, +ms(m[5]).toFixed(2));
    }
  };
  bench("relay");
  bench("nginx");
  say("server: relay-load");
  const bin = `${ROOT}target/container/release/ajar-relay`;
  spawnSync("podman", ["rm", "-f", "perf-relay-load"], { stdio: "ignore" });
  execFileSync("podman", ["run", "-d", "--name", "perf-relay-load", "--cpus", "2", "--memory", "512m", "-p", "18787:8787", "-v", `${bin}:/relay:ro`,
    "-e", "MALLOC_MMAP_THRESHOLD_=1048576", "docker.io/library/rust:1", "/relay", "--bind", "0.0.0.0:8787", "--trust-forwarded-for",
    "--pad-dir", "/tmp/pads", "--accounts-db", "/tmp/a.db"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 2000));
    for (const part of ["reads", "writes", "rooms", "rereads"]) {
      const out = await capture("node", ["scripts/relay-load.mjs", part], { RELAY: "http://127.0.0.1:18787", STEP_S: "8" });
      for (const line of out.split("\n")) {
        const m = /^(read 40 KB pad|read 5 MB pad|saves|rooms|re-reads after a save) (\{.*\})$/.exec(line);
        if (!m) continue;
        const r = JSON.parse(m[2]);
        if (m[1] === "read 40 KB pad") put(`server.load.read_small.c${r.concurrency}.per_second`, r.perSecond);
        if (m[1] === "read 5 MB pad") put(`server.load.read_5mb.c${r.concurrency}.mb_per_second`, r.mbPerSecond);
        if (m[1] === "saves") {
          put(`server.load.saves.u${r.users}.per_second`, r.savesPerSecond);
          put(`server.load.saves.u${r.users}.p99_ms`, r.p99);
        }
        if (m[1] === "rooms") {
          put(`server.load.rooms.${r.rooms}x${r.size}.delivered_per_second`, r.deliveredPerSecond);
          put(`server.load.rooms.${r.rooms}x${r.size}.p99_ms`, r.p99ms);
        }
        if (m[1] === "re-reads after a save") {
          const k = `server.load.rereads.room${r.room}.${r.reads === "whole" ? "whole" : "delta"}`;
          put(`${k}.kb_per_save`, r.kbPerSave);
          put(`${k}.p50_ms`, r.p50ms);
        }
      }
    }
  } finally {
    spawnSync("podman", ["rm", "-f", "perf-relay-load"], { stdio: "ignore" });
  }
}

// ---------------------------------------------------------------- production

if (want("live")) {
  say("live: a newcomer on production, once");
  aggregate("live", await capture("node", ["scripts/perf/browser.mjs", "https://code.rishwanth.dev", "edit,run-now", "1"]));
  // DNS, cold: our provider's own answer, and a public resolver that has
  // never seen the name asked (a random one under the domain).
  const query = (server, name) => {
    const out = spawnSync("dig", ["+tries=1", "+time=3", `@${server}`, name, "A"], { encoding: "utf8" }).stdout ?? "";
    const m = /Query time: (\d+) msec/.exec(out);
    return m ? Number(m[1]) : null;
  };
  const ns = (spawnSync("dig", ["+short", "rishwanth.dev", "NS", "@1.1.1.1"], { encoding: "utf8" }).stdout ?? "").split("\n")[0].trim();
  const times = (server, name) => [1, 2, 3].map(() => query(server, typeof name === "function" ? name() : name)).filter((x) => x !== null);
  const auth = ns ? times(ns, "code.rishwanth.dev") : [];
  const cold = times("1.1.1.1", () => `cold-${Math.random().toString(36).slice(2)}.rishwanth.dev`);
  if (auth.length) put("live.dns.authoritative_ms", median(auth));
  if (cold.length) put("live.dns.cold_via_1111_ms", median(cold));
  const ttl = /\s(\d+)\s+IN\s+A\s/.exec(spawnSync("dig", ["+noall", "+answer", ns ? `@${ns}` : "@1.1.1.1", "code.rishwanth.dev", "A"], { encoding: "utf8" }).stdout ?? "");
  if (ttl) put("live.dns.ttl_s", Number(ttl[1]));
}

// ---------------------------------------------------------------- the record and the comparison

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).trim() ? "-dirty" : "";
const record = { commit: commit + dirty, at: new Date().toISOString(), profiles: PROFILES, runs: RUNS, metrics: results };
mkdirSync(`${ROOT}target/perf`, { recursive: true });
const file = `${ROOT}target/perf/${record.at.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(record, null, 2));
say(`written: ${file}`);

/** Which way is better for a metric, by its name. */
const better = (key) =>
  /(rps|per_second|mb_per_second|delivered)$/.test(key) ? "higher" : /(_ms|bytes|bytes_[a-z_]+|heap_mb|rss_mb|binary_mb|cpu_pct|requests|layout_shift|kb_per_save)$/.test(key) ? "lower" : null;
/** Worse by more than noise: times by 15% and 40 ms, bytes by 2% and 4 KB, throughput by 10%, memory by 15%. */
function worse(key, base, now) {
  if (typeof base !== "number" || typeof now !== "number") return base !== now && typeof base === "boolean" ? true : false;
  const dir = better(key);
  if (dir === "higher") return now < base * 0.9;
  // A key reaching another browser rides two sockets and a relay: its tail
  // moves by a third from run to run.
  if (/key_to_other/.test(key)) return now > base * 1.5 && now - base > 100;
  // Long tasks come whole or not at all, a task being one only past 50 ms:
  // the sum jumps between 0 and 50-odd from one run to the next.
  if (/long_tasks/.test(key)) return now - base > 100;
  if (/_ms$/.test(key)) return now > base * 1.15 && now - base > 40;
  if (/bytes|kb_per_save/.test(key)) return now > base * 1.02 && now - base > 4096;
  if (/heap_mb|rss_mb/.test(key)) return now > base * 1.15 && now - base > 5;
  if (/binary_mb/.test(key)) return now > base * 1.05;
  // An idle process's share of a core: a few hundredths of a second in ten.
  if (/cpu_pct/.test(key)) return now > base * 1.5 && now - base > 1;
  if (/requests$/.test(key)) return now > base + 1;
  if (/layout_shift/.test(key)) return now - base > 0.02;
  return false;
}
function improved(key, base, now) {
  if (typeof base !== "number" || typeof now !== "number") return false;
  const dir = better(key);
  if (dir === "higher") return now > base * 1.1;
  if (dir === "lower" && /cpu_pct|rss_mb|binary_mb|requests$/.test(key)) return now < base * 0.75;
  if (dir === "lower") return now < base * 0.85 && base - now > (/_ms$/.test(key) ? 40 : 4096);
  return false;
}

if (existsSync(BASELINE)) {
  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  const rows = [];
  for (const [key, now] of Object.entries(results)) {
    if (!(key in base.metrics)) continue;
    const was = base.metrics[key];
    const state = worse(key, was, now) ? "WORSE" : improved(key, was, now) ? "better" : "same";
    rows.push({ key, was, now, state });
  }
  const regressions = rows.filter((r) => r.state === "WORSE");
  const gains = rows.filter((r) => r.state === "better");
  console.log(`\nagainst the baseline (${base.commit}, ${base.at.slice(0, 10)}): ${rows.length} metrics compared, ${gains.length} better, ${regressions.length} worse`);
  for (const r of [...regressions, ...gains]) console.log(`  ${r.state.padEnd(6)} ${r.key.padEnd(60)} ${String(r.was).padStart(10)} → ${r.now}`);
  if (regressions.length && !flag("--save")) process.exitCode = 1;
} else {
  console.log("\nno baseline yet: --save makes this one it");
}
if (flag("--save")) {
  const merged = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : { metrics: {} };
  // What this run measured replaces the baseline's whole for that part —
  // a metric renamed or gone leaves nothing behind to compare against.
  const measured = [...new Set(Object.keys(results).map((k) => k.split(".").slice(0, /^(lab|ajar)\./.test(k) ? (ONLY_SCENARIOS ? 3 : 2) : 1).join(".")))];
  const kept = Object.fromEntries(Object.entries(merged.metrics).filter(([k]) => !measured.some((p) => k.startsWith(`${p}.`))));
  writeFileSync(BASELINE, `${JSON.stringify({ ...record, metrics: { ...kept, ...results } }, null, 2)}\n`);
  console.log(`baseline saved: ${BASELINE}`);
}
console.log("");
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(64)} ${v}`);

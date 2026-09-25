// Shared by the perf scripts: the browser, timing, and a record that survives
// a crash.
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";

export const { chromium } = createRequire(new URL("../../web/package.json", import.meta.url))("playwright");

export const ms = (from, to = performance.now()) => Math.round(to - from);

/** Median and tail of a set of samples, in whole milliseconds. */
export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
  return { n: s.length, min: Math.round(s[0]), p50: at(0.5), p95: at(0.95), max: Math.round(s[s.length - 1]) };
}

/**
 * Print a result and, with OUT set, append it to that file as a JSON line.
 *
 * Written synchronously on purpose. Node flushes a piped stdout
 * asynchronously, so a run that crashed took every result printed before the
 * crash with it — which is how the first cold-visit numbers were lost.
 */
export function record(result) {
  const line = JSON.stringify(result);
  console.log(line);
  if (process.env.OUT) appendFileSync(process.env.OUT, `${line}\n`);
}

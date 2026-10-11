/**
 * The durable folder, as the page sees it.
 *
 * The server owns the sequence number and hands one back on every accepted
 * write. That is the ordering last-write-wins depends on, and it lives there
 * because no two browsers can agree on a clock.
 */

import type { Access } from "./access";

export type Encoding = "utf8" | "base64";

export interface StoredFile {
  content: string;
  encoding: Encoding;
  seq: number;
  /** What the relay stores it under. Absent from a relay before 11 October 2026. */
  hash?: string;
}

export interface Pad {
  /** False when nobody has ever written to this name. Not an error. */
  exists: boolean;
  seq: number;
  files: Record<string, StoredFile>;
  /** Who you are to this pad. Absent from a relay older than accounts. */
  access?: Access;
}

/** One change. A `content` of `null` with no `edits` deletes. */
export interface Change {
  path: string;
  content: string | null;
  encoding?: Encoding;
  /** In place of `content`: the stored file's hash, which `edits` change. */
  base?: string;
  /** In UTF-16 code units, as a string here counts them. */
  edits?: { at: number; remove: number; insert: string }[];
}

/**
 * The hash a relay stores a text file under: SHA-256 of "u" and its UTF-8.
 * Sent as `base` with edits, it says exactly which text they were measured
 * against, so a relay holding anything else refuses rather than applying them
 * somewhere wrong.
 */
export async function storedHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(`u${text}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Bytes of JSON one request carries at most. The relay reads a write off the
 * wire whole, and takes 33 MiB; held to that, a write costs it the same
 * whatever a pad holds. A pad holds 100 MiB since 11 October, so an upload, a
 * copy or one large file goes in several requests.
 */
export const REQUEST_BYTES = 24 * 1024 * 1024;

/**
 * One request of a write. `follows` says its one change goes on from what the
 * request before left — the next part of a file too big for one — and takes
 * that file's hash from the answer as its base.
 */
export interface Step {
  changes: Change[];
  follows?: boolean;
}

/**
 * Bytes the code unit at `i` of `s` takes in a JSON string, as JSON.stringify
 * writes one: a surrogate pair is counted at its first half, and its second
 * is nothing.
 */
function width(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c < 0x80) {
    if (c === 0x22 || c === 0x5c) return 2;
    if (c >= 0x20) return 1;
    return c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
  }
  if (c < 0x800) return 2;
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = s.charCodeAt(i + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 4 : 6;
  }
  if (c >= 0xdc00 && c <= 0xdfff) {
    const prev = s.charCodeAt(i - 1);
    return prev >= 0xd800 && prev <= 0xdbff ? 0 : 6;
  }
  return 3;
}

/** Bytes `s` takes as a JSON string, its quotes too. */
export function jsonBytes(s: string): number {
  let n = 2;
  for (let i = 0; i < s.length; i++) n += width(s, i);
  return n;
}

/** `s` in pieces of at most `max` bytes as JSON strings, none cut inside a character. */
export function pieces(s: string, max: number): string[] {
  const out: string[] = [];
  let start = 0;
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const w = width(s, i);
    if (w > 0 && n + w > max && i > start) {
      out.push(s.slice(start, i));
      start = i;
      n = 2;
    }
    n += w;
  }
  out.push(s.slice(start));
  return out;
}

const encoder = new TextEncoder();

/** A change's bytes as JSON, without its text, and with it. */
function measure(c: Change): { frame: number; whole: number } {
  const frame = encoder.encode(
    JSON.stringify({
      ...c,
      content: typeof c.content === "string" ? "" : c.content,
      edits: c.edits?.map((e) => ({ ...e, insert: "" })),
    }),
  ).length;
  let text = typeof c.content === "string" ? jsonBytes(c.content) - 2 : 0;
  for (const e of c.edits ?? []) text += jsonBytes(e.insert) - 2;
  return { frame, whole: frame + text };
}

/** `{"writes":[` and `]}`, and room to spare. */
const ENVELOPE = 1024;

/**
 * A write as requests of at most `max` bytes: changes together while they
 * fit, and a file bigger than one request as its first part — content, or the
 * edit with the start of what it inserts — and then the rest added to its end,
 * a part a request.
 */
export function plan(changes: Change[], max = REQUEST_BYTES): Step[] {
  const room = max - ENVELOPE;
  const steps: Step[] = [];
  let run: Change[] = [];
  let size = 0;
  const flush = () => {
    if (run.length) steps.push({ changes: run });
    run = [];
    size = 0;
  };
  for (const c of changes) {
    const { frame, whole } = measure(c);
    if (whole <= room) {
      if (size + whole + 1 > room) flush();
      run.push(c);
      size += whole + 1;
      continue;
    }
    flush();
    // Each later part is an edit at the end of the parts before it; what one
    // adds to its frame is small, and the margin covers it.
    const parts = (text: string) => pieces(text, room - frame - 256);
    const more = (path: string, at: number, insert: string): Step => ({
      changes: [{ path, content: null, encoding: c.encoding, base: "", edits: [{ at, remove: 0, insert }] }],
      follows: true,
    });
    if (typeof c.content === "string") {
      let at = 0;
      for (const [i, part] of parts(c.content).entries()) {
        steps.push(i === 0 ? { changes: [{ ...c, content: part }] } : more(c.path, at, part));
        at += part.length;
      }
    } else if (c.edits?.length === 1 && c.edits[0]) {
      const e = c.edits[0];
      let at = e.at;
      for (const [i, part] of parts(e.insert).entries()) {
        steps.push(i === 0 ? { changes: [{ ...c, edits: [{ ...e, insert: part }] }] } : more(c.path, at, part));
        at += part.length;
      }
    } else {
      // Not something this page sends; the relay will say if it is too big.
      steps.push({ changes: [c] });
    }
  }
  flush();
  return steps.length ? steps : [{ changes: [] }];
}

export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  /** Over a cap. Permanent until the caller sends less, so not worth retrying. */
  get tooBig(): boolean {
    return this.status === 413 || this.status === 507;
  }

  /** Not yours to see, or not yours to change. Retrying changes nothing. */
  get refused(): boolean {
    return this.status === 403;
  }

  /** Deleted by its owner. */
  get gone(): boolean {
    return this.status === 410;
  }

  /** Edits sent against a version the relay no longer holds. */
  get stale(): boolean {
    return this.status === 409;
  }
}

async function refuse(res: Response): Promise<never> {
  const body = await res.text().catch(() => "");
  // A proxy's answer while the relay is away is not something to repeat.
  if (res.status >= 502 && res.status <= 504) throw new StoreError(res.status, "can't reach the server right now — trying again");
  throw new StoreError(res.status, body || `the server said ${res.status}`);
}

/** fetch, with a dropped connection as a StoreError like any other refusal. */
/**
 * With a deadline for the answer to start. A request that never answered held
 * the page's write queue for good: every save and every command's publish
 * after it waited behind it, and a file a command made never reached the tree
 * — once, against production, on 5 October. Out of time, it fails like a lost
 * connection, and a save is tried again.
 */
async function request(url: string, init: RequestInit, deadline: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new StoreError(
      0,
      controller.signal.aborted ? "the server did not answer in time" : "can't reach the server right now — check your connection",
    );
  } finally {
    clearTimeout(timer);
  }
}

export class Store {
  /**
   * `code` is the pad link's code, if this browser holds one: sent with every
   * request, because the server decides who may read and write.
   */
  /**
   * Whether this relay takes edits rather than whole files. Learnt from its
   * answers, which carry hashes when it does: one from before would read an
   * edit's `content: null` as deleting the file.
   */
  editsWork = false;

  /** Bytes one request carries at most. A field so a check can make it small. */
  requestBytes = REQUEST_BYTES;

  constructor(
    private readonly base = "",
    private readonly code: (name: string) => string | null = () => null,
    /** How long the server has to start answering. A write gets more for its size. */
    private readonly deadline = 30_000,
  ) {}

  private headers(name: string): Record<string, string> {
    const code = this.code(name);
    return code ? { "x-pad-code": code } : {};
  }

  async read(name: string): Promise<Pad> {
    const res = await request(`${this.base}/api/pad/${encodeURIComponent(name)}`, {
      headers: this.headers(name),
      // A pad's answer depends on who asks. Never one from a cache.
      cache: "no-store",
    }, this.deadline);
    if (!res.ok) await refuse(res);
    const pad = (await res.json()) as Pad;
    if (Object.values(pad.files ?? {}).some((f) => typeof f.hash === "string")) this.editsWork = true;
    return pad;
  }

  /**
   * Apply changes and return the new sequence number. `leaving` is a save
   * made as the page goes away, which the browser lets finish after it has
   * gone — up to 64 KB of them, so a bigger one is sent as usual and may not.
   */
  /**
   * Apply changes, and return the sequence the pad reached. A write bigger
   * than one request — an upload, a copy, a large file — goes in several, in
   * order; if one fails, those before it have landed, and a file sent in
   * parts may hold only the first of them until it is saved again.
   */
  async write(name: string, changes: Change[], leaving = false): Promise<number> {
    let seq = 0;
    let hashes: Record<string, string> = {};
    for (const step of plan(changes, this.requestBytes)) {
      let batch = step.changes;
      const next = batch[0];
      if (step.follows && next) {
        const base = hashes[next.path];
        if (!base) throw new StoreError(0, "the relay did not say what it stored, so the rest of the file cannot follow");
        batch = [{ ...next, base }];
      }
      ({ seq, hashes } = await this.writeOnce(name, batch, leaving));
    }
    return seq;
  }

  private async writeOnce(
    name: string,
    changes: Change[],
    leaving: boolean,
  ): Promise<{ seq: number; hashes: Record<string, string> }> {
    const body = JSON.stringify({ writes: changes });
    const res = await request(`${this.base}/api/pad/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...this.headers(name) },
      body,
      keepalive: leaving && new Blob([body]).size < 60_000,
    }, this.deadline + body.length / 50);
    if (!res.ok) await refuse(res);
    const { seq, hashes } = (await res.json()) as { seq: number; hashes?: Record<string, string> };
    if (hashes) this.editsWork = true;
    return { seq, hashes: hashes ?? {} };
  }
}

/**
 * A name for a folder nobody asked to name.
 *
 * Three short words beat a random string for the same reason session links use
 * them: this ends up in a message, and occasionally read aloud. The server's
 * own rule is lowercase letters, digits and dashes, which this satisfies by
 * construction.
 */
const ADJECTIVES = [
  "amber", "brisk", "candid", "dusky", "eager", "fluent", "gentle", "hazel",
  "jolly", "keen", "lucid", "mellow", "nimble", "opal", "plain", "quick",
  "rustic", "solar", "tidal", "vivid", "warm", "zesty", "arctic", "cobalt",
];
const NOUNS = [
  "ember", "harbor", "meadow", "cedar", "lantern", "canyon", "willow", "beacon",
  "thicket", "cobble", "anvil", "birch", "cinder", "dune", "fjord", "grotto",
  "hollow", "inlet", "juniper", "lagoon", "marsh", "notch", "orchard", "ridge",
];

export function mintName(): string {
  const pick = <T>(xs: readonly T[]): T => {
    const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
    return xs[n % xs.length]!;
  };
  const digits = (crypto.getRandomValues(new Uint32Array(1))[0]! % 9000) + 1000;
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits}`;
}

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

/** One kept version of a pad: when, how many files, how big. */
/** What Run last printed in a pad: the file, the command, how it ended, when, and its output. */
export interface LastRun {
  path: string;
  command: string;
  exit: number;
  at_ms: number;
  output: string;
}

export interface Version {
  id: number;
  at_ms: number;
  files: number;
  bytes: number;
}

export interface Pad {
  /** False when nobody has ever written to this name. Not an error. */
  exists: boolean;
  seq: number;
  files: Record<string, StoredFile>;
  /** Who you are to this pad. Absent from a relay older than accounts. */
  access?: Access;
  /**
   * The reader has the pad at `seq` already, which it said (`x-pad-seq`), and
   * `files` is empty for that, not because the pad is. A relay from before
   * 18 October never says it, and sends the pad whole.
   */
  unchanged?: boolean;
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

const encoder = new TextEncoder();
const NOT_ASCII = /[^\x00-\x7f]/;

/**
 * Bytes `s` takes as a JSON string, its quotes too: what JSON.stringify writes,
 * measured on it. Walking the characters in script took 175 ms for 58 MB.
 */
export function jsonBytes(s: string): number {
  const json = JSON.stringify(s);
  return NOT_ASCII.test(json) ? encoder.encode(json).length : json.length;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;

/**
 * `s` in pieces of at most `max` bytes as JSON strings, none cut inside a
 * character. Each piece's length is guessed from the bytes the last one took
 * per character, and measured; one over is cut down in proportion.
 */
export function pieces(s: string, max: number): string[] {
  // A character is a byte at least, so a string longer than `max` is over it
  // without being measured; a guess does for its first piece.
  let perChar = 1.05;
  if (s.length + 2 <= max) {
    const whole = jsonBytes(s);
    if (whole <= max) return [s];
    perChar = whole / s.length;
  }
  const out: string[] = [];
  let start = 0;
  while (start < s.length) {
    let len = Math.max(1, Math.floor((max - 2) / perChar));
    for (;;) {
      let end = Math.min(s.length, start + len);
      // Not between the halves of a pair; and never nothing.
      if (end < s.length && isHigh(s.charCodeAt(end - 1))) end--;
      if (end <= start) end = Math.min(s.length, start + 2);
      const piece = s.slice(start, end);
      const bytes = jsonBytes(piece);
      if (bytes <= max || end - start <= 2) {
        out.push(piece);
        perChar = Math.max(bytes / piece.length, 1);
        start = end;
        break;
      }
      len = Math.max(1, Math.floor((end - start) * (max / bytes) * 0.98));
    }
  }
  return out;
}

/** A change's bytes as JSON without its text. */
function frameOf(c: Change): number {
  return encoder.encode(
    JSON.stringify({
      ...c,
      content: typeof c.content === "string" ? "" : c.content,
      edits: c.edits?.map((e) => ({ ...e, insert: "" })),
    }),
  ).length;
}

/** A change's text: its content, and what its edits insert. */
function textsOf(c: Change): string[] {
  return [...(typeof c.content === "string" ? [c.content] : []), ...(c.edits ?? []).map((e) => e.insert)];
}

/**
 * The most a change can take as JSON: six bytes a character, for a control
 * character escaped as `\u00XX`, and room for its keys.
 */
function atMost(c: Change): number {
  let units = c.path.length + (typeof c.content === "string" ? c.content.length : 0) + (c.base?.length ?? 0);
  for (const e of c.edits ?? []) units += e.insert.length + 40;
  return units * 6 + 256;
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
  // Every save and nearly every command: one request even at the most it could
  // take, so nothing needs measuring.
  if (changes.reduce((n, c) => n + atMost(c), 0) <= room) return [{ changes }];
  const steps: Step[] = [];
  let run: Change[] = [];
  let size = 0;
  const flush = () => {
    if (run.length) steps.push({ changes: run });
    run = [];
    size = 0;
  };
  for (const c of changes) {
    const frame = frameOf(c);
    const texts = textsOf(c);
    // Longer than a request in characters is longer in bytes: no need to
    // measure what is going to be split.
    const units = texts.reduce((n, t) => n + t.length, 0);
    const whole = frame + units > room ? Infinity : texts.reduce((n, t) => n + jsonBytes(t), frame);
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
  let timer = setTimeout(() => controller.abort(), deadline);
  const failed = () =>
    new StoreError(
      0,
      controller.signal.aborted ? "the server did not answer in time" : "can't reach the server right now — check your connection",
    );
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    // The body under the same deadline, as a pause rather than a total: the
    // headers alone used to end it, and a server that sent them and then
    // nothing held every save behind it for good (audit DC-07). A large pad
    // arriving steadily is never cut off; one that stops is.
    if (!res.body || res.status === 204 || res.status === 205 || res.status === 304) return res;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), deadline);
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return new Response(new Blob(chunks as BlobPart[]), { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch {
    throw failed();
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

  /**
   * Told when a write comes back more than one past the last of the pad this
   * store has seen, read or written: somebody else's write went in between,
   * which this page has not read. Each write moves a pad on by one.
   *
   * Until 18 October the page took the write's number as how far it had read
   * too, so the nudge for that other write — arriving after — asked for
   * nothing newer than it had, and what it changed stayed unseen here until
   * something else changed.
   */
  onBehind: ((name: string) => void) | null = null;
  /** The furthest this store has seen each pad at. */
  private seen = new Map<string, number>();

  constructor(
    private readonly base = "",
    private readonly code: (name: string) => string | null = () => null,
    /** How long the server has to start answering. A write gets more for its size. */
    private readonly deadline = 30_000,
  ) {}

  private saw(name: string, seq: number): void {
    this.seen.set(name, Math.max(this.seen.get(name) ?? 0, seq));
  }

  private headers(name: string): Record<string, string> {
    const code = this.code(name);
    return code ? { "x-pad-code": code } : {};
  }

  /** A pad's kept versions, newest first (`Store::history` in the relay). */
  async history(name: string): Promise<Version[]> {
    const res = await request(`${this.base}/api/pad/${encodeURIComponent(name)}/history`, { headers: this.headers(name), cache: "no-store" }, this.deadline);
    if (!res.ok) await refuse(res);
    return (await res.json()) as Version[];
  }

  /** One version's files, as a read gives a pad's. */
  async version(name: string, id: number): Promise<Pad["files"]> {
    const res = await request(`${this.base}/api/pad/${encodeURIComponent(name)}/history/${id}`, { headers: this.headers(name), cache: "no-store" }, this.deadline);
    if (!res.ok) await refuse(res);
    return ((await res.json()) as { files: Pad["files"] }).files;
  }

  /** The pad as it is now kept as a version, before a restore replaces it. */
  async keepVersion(name: string): Promise<number | null> {
    const res = await request(`${this.base}/api/pad/${encodeURIComponent(name)}/history`, { method: "POST", headers: { ...this.headers(name), "x-ajar": "1" } }, this.deadline);
    if (!res.ok) await refuse(res);
    return ((await res.json()) as { id: number | null }).id;
  }

  /**
   * The pad as it is. `opening` is a page opening it, rather than reading it
   * again — after a save elsewhere, a reconnect, a change of access — which
   * the relay counts as an open (usage.rs); nothing else about it is kept.
   */
  /** What Run last printed in the pad (the relay's `last_runs`), or null when it has not been run. */
  async lastRun(name: string): Promise<LastRun | null> {
    const res = await request(`${this.base}/api/pad/${encodeURIComponent(name)}/run`, { headers: this.headers(name), cache: "no-store" }, this.deadline);
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) await refuse(res);
    return (await res.json()) as LastRun;
  }

  /** Keep a Run's output as the pad's last, in place of the one before. */
  async keepRun(name: string, run: Omit<LastRun, "at_ms">): Promise<void> {
    const res = await request(`${this.base}/api/pad/${encodeURIComponent(name)}/run`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...this.headers(name) },
      body: JSON.stringify(run),
    }, this.deadline);
    if (!res.ok) await refuse(res);
  }

  /**
   * The pad, or — given `since`, the sequence the reader has it at — only
   * that it has not moved on, when it has not (`Pad.unchanged`).
   */
  async read(name: string, opening = false, since?: number): Promise<Pad> {
    const res = await request(`${this.base}/api/pad/${encodeURIComponent(name)}`, {
      headers: {
        ...this.headers(name),
        ...(opening ? { "x-pad-open": "1" } : {}),
        ...(since ? { "x-pad-seq": String(since) } : {}),
      },
      // A pad's answer depends on who asks. Never one from a cache.
      cache: "no-store",
    }, this.deadline);
    if (!res.ok) await refuse(res);
    const pad = (await res.json()) as Pad;
    this.saw(name, pad.seq);
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
    const before = this.seen.get(name);
    this.saw(name, seq);
    if (before !== undefined && seq !== before + 1) this.onBehind?.(name);
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

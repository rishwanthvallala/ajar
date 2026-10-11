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
  async write(name: string, changes: Change[], leaving = false): Promise<number> {
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
    return seq;
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

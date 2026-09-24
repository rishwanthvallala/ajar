/**
 * The durable folder, as the page sees it.
 *
 * The server owns the sequence number and hands one back on every accepted
 * write. That is the ordering last-write-wins depends on, and it lives there
 * because no two browsers can agree on a clock.
 */

export type Encoding = "utf8" | "base64";

export interface StoredFile {
  content: string;
  encoding: Encoding;
  seq: number;
}

export interface Pad {
  /** False when nobody has ever written to this name. Not an error. */
  exists: boolean;
  seq: number;
  files: Record<string, StoredFile>;
}

/** One change. A `content` of `null` deletes. */
export interface Change {
  path: string;
  content: string | null;
  encoding?: Encoding;
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
    return this.status === 413;
  }
}

async function refuse(res: Response): Promise<never> {
  const body = await res.text().catch(() => "");
  throw new StoreError(res.status, body || `the server said ${res.status}`);
}

export class Store {
  constructor(private readonly base = "") {}

  async read(name: string): Promise<Pad> {
    const res = await fetch(`${this.base}/api/pad/${encodeURIComponent(name)}`);
    if (!res.ok) await refuse(res);
    return (await res.json()) as Pad;
  }

  /** Apply changes and return the new sequence number. */
  async write(name: string, changes: Change[]): Promise<number> {
    const res = await fetch(`${this.base}/api/pad/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ writes: changes }),
    });
    if (!res.ok) await refuse(res);
    const { seq } = (await res.json()) as { seq: number };
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

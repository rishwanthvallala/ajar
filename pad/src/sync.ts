/**
 * Working out what a command changed, and telling the server.
 *
 * ## Why this reads every file
 *
 * The plan was to walk metadata and read only what differs. The runtime does
 * not allow it: `FileStat` carries `kind` and `size` and nothing else — no
 * modification time, no hash. A script that rewrites a file to the same length
 * is ordinary (a counter, a date, a reordered column), so equal size proves
 * nothing and every candidate has to be read to be ruled out.
 *
 * That is affordable only because a pad is capped at 500 files and 25 MB. It
 * would not be at any size where the caps stopped mattering, and if those caps
 * ever rise this is the first thing that breaks.
 *
 * ## When
 *
 * On the exit of a command, which is a real transaction boundary — it either
 * ran or it did not, and a half-written file is never published. A process
 * that never exits therefore never syncs, which is a known and deliberate gap:
 * fine for paste-run-look, wrong for a dev server.
 */
import type { Runtime } from "./runtime";
import type { Change, StoredFile } from "./store";

/** What the server is believed to hold, by path. */
export type Known = Map<string, string>;

export function knownFrom(files: Record<string, StoredFile>): Known {
  const known: Known = new Map();
  for (const [path, file] of Object.entries(files)) {
    // Only text round-trips through the editor and the shell. A base64 file is
    // carried but never compared, because decoding every binary on every
    // command is exactly the cost this module exists to avoid.
    if (file.encoding === "utf8") known.set(path, file.content);
  }
  return known;
}

/**
 * Files the page should not publish.
 *
 * A pad is what someone pasted in, not what a tool left behind. Without this a
 * single `python` run adds every `__pycache__` entry to the shared folder and
 * to everyone else's screen.
 */
const IGNORED = [/(^|\/)__pycache__\//, /\.pyc$/, /(^|\/)\.git\//, /(^|\/)node_modules\//];

export function ignored(path: string): boolean {
  return IGNORED.some((re) => re.test(path));
}

export interface Diff {
  changes: Change[];
  /** The new state to remember, applied only once the server accepts. */
  next: Known;
}

/**
 * Compare the sandbox against what the server holds.
 *
 * Returns an empty change list when nothing moved, which is the common case —
 * most commands read rather than write, and an empty PUT would still bump the
 * sequence number and wake every other browser for nothing.
 */
export async function diff(rt: Runtime, known: Known): Promise<Diff> {
  const changes: Change[] = [];
  const next: Known = new Map();

  for (const entry of await rt.list()) {
    if (ignored(entry.path)) continue;
    let content: string;
    try {
      content = await rt.read(entry.path);
    } catch {
      // Unreadable as text: almost certainly binary. Skipped rather than
      // guessed at — v0 carries text, and a silent mangling would be worse
      // than an absence the user can see.
      continue;
    }
    next.set(entry.path, content);
    if (known.get(entry.path) !== content) {
      changes.push({ path: entry.path, content });
    }
  }

  for (const path of known.keys()) {
    if (!next.has(path)) changes.push({ path, content: null });
  }

  return { changes, next };
}

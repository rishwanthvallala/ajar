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

/** What the server is believed to hold, by path: the text files. */
export type Known = Map<string, string>;

/** The binary files the server holds, by path, as the base64 it keeps them in. */
export type Binaries = Map<string, string>;

/**
 * An empty folder, as the store keeps it: an empty `.keep` inside it, as git
 * users do. Paths are all the store has, so a folder with nothing in it had
 * nothing to imply it and was lost on reload; the marker implies it. It is
 * never shown in the tree — the folder is — and a sandbox may hold it as a
 * real file or just as the empty directory.
 */
export const MARKER = ".keep";

export function isMarker(path: string, content: string | null | undefined): boolean {
  return content === "" && path.endsWith(`/${MARKER}`);
}

/** The folder a marker keeps. */
export function markedFolder(path: string): string {
  return path.slice(0, -(MARKER.length + 1));
}

export function knownFrom(files: Record<string, StoredFile>): Known {
  const known: Known = new Map();
  for (const [path, file] of Object.entries(files)) {
    if (file.encoding === "utf8") known.set(path, file.content);
  }
  return known;
}

export function binariesFrom(files: Record<string, StoredFile>): Binaries {
  const binaries: Binaries = new Map();
  for (const [path, file] of Object.entries(files)) {
    if (file.encoding === "base64") binaries.set(path, file.content);
  }
  return binaries;
}

const strict = new TextDecoder("utf-8", { fatal: true });

/**
 * A file's bytes as text, or null when they are not text: not UTF-8, or with
 * a NUL in them, which text does not have and nearly every binary format does.
 * The same rule a zip's files are sorted by.
 */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  // In pieces: one call per byte is slow, and one call for all of them can
  // pass more arguments than a function may take.
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * Files the page should not publish.
 *
 * A pad is what someone pasted in, not what a tool left behind. Without this a
 * single `python` run adds every `__pycache__` entry to the shared folder and
 * to everyone else's screen.
 */
const IGNORED = [
  /(^|\/)__pycache__\//,
  /\.pyc$/,
  /(^|\/)\.git\//,
  /(^|\/)node_modules\//,
  // Our own shims. They live in the sandbox so the shell can reach them, and
  // they are emphatically not part of anybody's folder.
  /^\.ajar\//,
];

export function ignored(path: string): boolean {
  return IGNORED.some((re) => re.test(path));
}

export interface Diff {
  changes: Change[];
  /** The new state to remember, applied only once the server accepts. */
  next: Known;
  nextBinaries: Binaries;
}

/**
 * Compare the sandbox against what the server holds.
 *
 * Returns an empty change list when nothing moved, which is the common case —
 * most commands read rather than write, and an empty PUT would still bump the
 * sequence number and wake every other browser for nothing.
 */
export async function diff(rt: Runtime, known: Known, binaries: Binaries = new Map()): Promise<Diff> {
  const changes: Change[] = [];
  const next: Known = new Map();
  const nextBinaries: Binaries = new Map();

  for (const entry of await rt.list("", true)) {
    if (ignored(entry.path)) continue;
    // An empty directory — `mkdir` in the terminal, or New folder — goes as
    // its marker, which the sandbox need not hold as a file.
    if (entry.emptyDir) {
      const marker = `${entry.path}/${MARKER}`;
      if (ignored(marker)) continue;
      next.set(marker, "");
      if (known.get(marker) !== "") changes.push({ path: marker, content: "" });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await rt.readBytes(entry.path);
    } catch {
      // Gone between the listing and the read, or not readable at all.
      continue;
    }
    // Read as bytes and sorted here. It used to be read as text, which does
    // not refuse a binary: it replaces what is not UTF-8, so an image a
    // command made was published as garbled text, to everyone and to the
    // store, until 5 October.
    const text = textOf(bytes);
    if (text !== null) {
      next.set(entry.path, text);
      if (known.get(entry.path) !== text) changes.push({ path: entry.path, content: text });
    } else {
      const base64 = toBase64(bytes);
      nextBinaries.set(entry.path, base64);
      if (binaries.get(entry.path) !== base64) changes.push({ path: entry.path, content: base64, encoding: "base64" });
    }
  }

  // Gone, as text or as binary — a file that only changed kind is not.
  for (const path of [...known.keys(), ...binaries.keys()]) {
    if (!next.has(path) && !nextBinaries.has(path)) changes.push({ path, content: null });
  }

  return { changes, next, nextBinaries };
}

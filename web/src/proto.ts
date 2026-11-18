// Mirrors crates/ajar-proto/src/lib.rs. There is no codegen; when the Rust
// side changes, change this by hand. The frame layout is nine bytes and has
// no reason to churn.

export const HEADER_LEN = 9;
export const TARGET_ALL = 0;
export const STREAM_CONTROL = 0;

export enum Channel {
  Control = 0x01,
  Pty = 0x02,
  Fs = 0x03,
  Presence = 0x04,
  Doc = 0x05,
  Store = 0x06,
}

/** First byte of any binary payload on the doc channel. */
export enum DocKind {
  Update = 0x01,
  Awareness = 0x02,
}

export function tagged(kind: DocKind, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = kind;
  out.set(bytes, 1);
  return out;
}

export function untag(payload: Uint8Array<ArrayBuffer>): [DocKind, Uint8Array<ArrayBuffer>] | null {
  if (payload.length === 0) return null;
  const kind = payload[0] as DocKind;
  if (kind !== DocKind.Update && kind !== DocKind.Awareness) return null;
  return [kind, payload.subarray(1)];
}

export interface Frame {
  channel: Channel;
  streamId: number;
  target: number;
  /**
   * Explicitly ArrayBuffer-backed. WebCrypto refuses a view that might sit on
   * a SharedArrayBuffer, and every payload here comes from a socket, an
   * encoder or a fresh allocation — never shared memory.
   */
  payload: Uint8Array<ArrayBuffer>;
}

export function encode(f: Frame): ArrayBuffer {
  const out = new Uint8Array(HEADER_LEN + f.payload.length);
  const view = new DataView(out.buffer);
  out[0] = f.channel;
  view.setUint32(1, f.streamId, true);
  view.setUint32(5, f.target, true);
  out.set(f.payload, HEADER_LEN);
  return out.buffer;
}

export function decode(buf: ArrayBuffer): Frame {
  if (buf.byteLength < HEADER_LEN) {
    throw new Error(`frame shorter than header (${buf.byteLength} bytes)`);
  }
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  return {
    channel: bytes[0] as Channel,
    streamId: view.getUint32(1, true),
    target: view.getUint32(5, true),
    payload: bytes.subarray(HEADER_LEN),
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function jsonFrame(channel: Channel, target: number, msg: unknown): Frame {
  return {
    channel,
    streamId: STREAM_CONTROL,
    target,
    payload: encoder.encode(JSON.stringify(msg)),
  };
}

export function streamFrame(
  channel: Channel,
  streamId: number,
  bytes: Uint8Array<ArrayBuffer>,
): Frame {
  return { channel, streamId, target: TARGET_ALL, payload: bytes };
}

export function parseJson<T>(f: Frame): T {
  return JSON.parse(decoder.decode(f.payload)) as T;
}

export function isStream(f: Frame): boolean {
  return f.streamId !== STREAM_CONTROL;
}

// ---------------------------------------------------------------- messages

/**
 * `"peer"` belongs to the browser-only tier, which has no agent behind it and
 * so no host to be a guest of. The session client in this directory never
 * sends it — but the type mirrors the Rust enum, and a mirror that omits a
 * variant is how the two sides start disagreeing.
 *
 * Note for whoever builds that client: a peer stamps its own participant id on
 * *every* frame, not only the sealed ones, because there is no host for an
 * unstamped frame to implicitly mean. `Connection.dispatch` decides that with
 * `isGuest()`, which would need to know about this.
 */
export type Role = "host" | "guest" | "peer";

/** What the relay knows: an id and a role. Never a name. */
export interface Participant {
  id: number;
  role: Role;
}

/** Someone with their name — only ever inside a sealed frame. */
export interface Person {
  id: number;
  name: string;
  role: Role;
}

/**
 * What this build speaks on the content channels. Must match
 * `PROTOCOL_VERSION` in `crates/ajar-proto`.
 *
 * Version 1 is the direction byte in the sealed frame's authenticated data.
 * An agent from before it cannot decrypt anything this client sends, and
 * neither end raises anything when that happens — both simply drop what they
 * cannot open, so the session looks connected and does nothing. Agents live on
 * people's machines until they reinstall, so older ones are always out there.
 */
export const PROTOCOL_VERSION = 1;

export type Control =
  | { t: "hello"; session: string; role: Role; locked?: boolean; protocol?: number; resume?: string }
  | {
      t: "welcome";
      participant_id: number;
      participants: Participant[];
      /** Absent from a relay or agent that predates version negotiation. */
      host_protocol?: number;
    }
  | { t: "joined"; participant: Participant }
  | { t: "left"; participant_id: number }
  | { t: "kick"; participant_id: number }
  | { t: "close" }
  | { t: "host_away"; grace_secs: number }
  | { t: "host_back" }
  | { t: "lock"; locked: boolean }
  | { t: "locked"; locked: boolean }
  | { t: "closed"; reason: string }
  | { t: "error"; code: string; message: string };

export interface Entry {
  path: string;
  kind: "file" | "dir";
  size: number;
}

export type Fs =
  /** Replace everything. Sent on join, and again after a burst of change too
   *  large for the host to describe as deltas. */
  | { t: "tree"; entries: Entry[] }
  | { t: "patch"; added: Entry[]; changed: Entry[]; removed: string[] }
  | { t: "read"; path: string }
  | { t: "content"; path: string; text: string; truncated: boolean; binary: boolean }
  | { t: "read_error"; path: string; message: string }
  | { t: "download"; path: string }
  | { t: "archive"; id: number; path: string; name: string; bytes: number; files: number }
  | { t: "received"; id: number; received: number }
  | { t: "download_error"; path: string; message: string }
  // What follows is asked only of a host that has said it can (`Roster.can`):
  // an agent from before it drops what it does not know.
  /** A new file, empty, or a new folder, with the folders on the way. */
  | { t: "make"; id: number; path: string; dir: boolean }
  /** A file or a folder to a new path. Onto a file that is there only with `replace`. */
  | { t: "rename"; id: number; from: string; to: string; replace: boolean }
  /** A file, or a folder and everything in it. */
  | { t: "remove"; id: number; path: string }
  /** A file to write, `bytes` long; its bytes follow as stream frames, `id` their stream, once the host says `taking`. */
  | { t: "put"; id: number; path: string; bytes: number; replace: boolean }
  | { t: "taking"; id: number }
  /** The host has `received` bytes of upload `id`: the page sends a window ahead of this and no further. */
  | { t: "got"; id: number; received: number }
  /** How a make, a rename, a remove, an upload or a replace ended. */
  | { t: "done"; id: number; ok: boolean; message: string }
  /** Something was renamed or moved, by anyone here: open tabs follow it. */
  | { t: "moved"; from: string; to: string }
  /** Search the folder's text, on the host's disk. */
  | { t: "find"; id: number; query: string; folder: string; match_case: boolean; whole_word: boolean }
  | { t: "found"; id: number; groups: FoundFile[]; truncated: boolean }
  /** Replace what a search found, in the files named, each only if it is still the text `sum` is the SHA-256 of. */
  | { t: "replace"; id: number; query: string; match_case: boolean; whole_word: boolean; replacement: string; files: { path: string; sum: string }[] }
  /** A file's bytes, to look at: an image. They come as stream frames, `stream` theirs, after `sight`. */
  | { t: "bytes"; id: number; path: string }
  | { t: "sight"; id: number; stream: number; path: string; bytes: number };

/** One file's matches, as the host found them: offsets and columns in UTF-16 units, as the editor counts. */
export interface FoundFile {
  path: string;
  matches: { start: number; end: number; line: number; column: number; before: string; hit: string; after: string }[];
}

export type Doc =
  | { t: "open"; path: string }
  | { t: "opened"; doc_id: number; path: string }
  | { t: "close"; doc_id: number }
  | { t: "closed"; doc_id: number; reason: string }
  | { t: "error"; path: string; message: string };

export const SNAPSHOT_STREAM = 1;

export type Store =
  | { t: "offer"; bytes: number; files: number }
  | { t: "accepted" }
  | { t: "rejected"; reason: string }
  | { t: "fetch" }
  | { t: "snapshot"; bytes: number; files: number }
  | { t: "empty" };

export interface SnapshotBody {
  files: { path: string; text: string }[];
}

export type Presence =
  | { t: "report"; active_pty: number | null }
  | { t: "update"; participant_id: number; active_pty: number | null }
  | { t: "iam"; name: string; resume?: string }
  /**
   * `can` is what this host's ajar does for a guest beyond reading: "write"
   * (make, rename, remove, upload), "search" and "bytes". Absent from an
   * agent older than 0.0.9, which does none of it.
   */
  | { t: "roster"; workspace: string; people: Person[]; can?: string[] };

export type Pty =
  | { t: "open"; cols: number; rows: number }
  | { t: "opened"; pty_id: number; cols: number; rows: number; opened_by: number }
  | { t: "resize"; pty_id: number; cols: number; rows: number }
  | { t: "close"; pty_id: number }
  | { t: "closed"; pty_id: number; exit_code: number }
  | { t: "read_only"; read_only: boolean }
  | { t: "refused"; reason: string };

export const textEncoder = encoder;

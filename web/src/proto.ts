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

export type Role = "host" | "guest";

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

export type Control =
  | { t: "hello"; session: string; role: Role }
  | { t: "welcome"; participant_id: number; participants: Participant[] }
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
  | { t: "read_error"; path: string; message: string };

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
  | { t: "iam"; name: string }
  | { t: "roster"; workspace: string; people: Person[] };

export type Pty =
  | { t: "open"; cols: number; rows: number }
  | { t: "opened"; pty_id: number; cols: number; rows: number; opened_by: number }
  | { t: "resize"; pty_id: number; cols: number; rows: number }
  | { t: "close"; pty_id: number }
  | { t: "closed"; pty_id: number; exit_code: number }
  | { t: "read_only"; read_only: boolean };

export const textEncoder = encoder;

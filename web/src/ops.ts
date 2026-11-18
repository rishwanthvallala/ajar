import { Channel, type FoundFile, type Frame, type Fs, jsonFrame, streamFrame, TARGET_ALL } from "./proto";

/**
 * What a guest's page asks the host's `ajar` to do to the folder, beyond
 * reading it: make a file or a folder, rename or move one, remove one, take a
 * file uploaded, search every file's text and replace what was found, and
 * send a file's bytes to look at.
 *
 * Each is a request with a number and an answer that carries it. Asked only
 * of a host that has said it can (`can`, from its roster): an agent from
 * before 0.0.9 drops what it does not know, and a request nobody answers is a
 * button that does nothing.
 */

export interface Outcome {
  ok: boolean;
  /** What happened, or why not, in the host's words. */
  message: string;
}

export interface FindOptions {
  query: string;
  folder: string;
  matchCase: boolean;
  wholeWord: boolean;
}

/** How long the host has to answer something small before the page stops waiting. */
const ANSWER_WAIT = 30_000;
/** Searching a large folder, or writing a large file out, takes longer. */
const SLOW_WAIT = 120_000;
/** How far ahead of what the host has acknowledged an upload runs: the relay cuts off a host whose queue grows past 8 MB. */
const UPLOAD_WINDOW = 1024 * 1024;
const UPLOAD_CHUNK = 64 * 1024;
/** The most the host sends of a file to look at (`VIEW_MAX` in the agent). */
export const VIEW_MAX = 5 * 1024 * 1024;

interface Waiting {
  resolve: (outcome: Outcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Upload {
  data: Uint8Array;
  sent: number;
  acked: number;
  started: boolean;
  progress?: (sent: number, total: number) => void;
}

interface View {
  id: number;
  path: string;
  resolve: (bytes: Uint8Array | string) => void;
  timer: ReturnType<typeof setTimeout>;
  stream: number | null;
  expected: number;
  chunks: Uint8Array[];
  received: number;
}

export class HostFiles {
  /** What the host has said it can do for a guest: "write", "search", "bytes". */
  private can = new Set<string>();
  private next = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly uploads = new Map<number, Upload>();
  private readonly finds = new Map<number, { resolve: (found: { groups: FoundFile[]; truncated: boolean }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Files asked for to look at, one at a time: each is up to 5 MB, and the relay queues at most 8 for this page. */
  private readonly views: Array<Omit<View, "id" | "timer" | "stream" | "expected" | "chunks" | "received">> = [];
  private viewing: View | null = null;

  constructor(private readonly send: (frame: Frame) => void) {}

  /** The host's roster said what it can do. Whether that changed. */
  learn(can: string[] | undefined): boolean {
    const next = new Set(can ?? []);
    const same = next.size === this.can.size && [...next].every((c) => this.can.has(c));
    this.can = next;
    return !same;
  }

  does(what: "write" | "search" | "bytes"): boolean {
    return this.can.has(what);
  }

  private id(): number {
    const id = this.next;
    this.next = this.next >= 0xffff_fff0 ? 1 : this.next + 1;
    return id;
  }

  private ask(message: (id: number) => Fs, wait = ANSWER_WAIT): Promise<Outcome> {
    const id = this.id();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        this.uploads.delete(id);
        resolve({ ok: false, message: "the host did not answer" });
      }, wait);
      this.waiting.set(id, { resolve, timer });
      this.send(jsonFrame(Channel.Fs, TARGET_ALL, message(id)));
    });
  }

  make(path: string, dir: boolean): Promise<Outcome> {
    return this.ask((id) => ({ t: "make", id, path, dir }));
  }

  rename(from: string, to: string, replace = false): Promise<Outcome> {
    return this.ask((id) => ({ t: "rename", id, from, to, replace }));
  }

  remove(path: string): Promise<Outcome> {
    return this.ask((id) => ({ t: "remove", id, path }), SLOW_WAIT);
  }

  /** A file written on the host, whole: sent a window at a time against its acknowledgements. */
  put(path: string, data: Uint8Array, replace: boolean, progress?: (sent: number, total: number) => void): Promise<Outcome> {
    let mine = 0;
    const done = this.ask((id) => {
      mine = id;
      return { t: "put", id, path, bytes: data.length, replace };
    }, SLOW_WAIT + data.length / 20);
    this.uploads.set(mine, { data, sent: 0, acked: 0, started: false, progress });
    return done.finally(() => this.uploads.delete(mine));
  }

  private pump(id: number) {
    const upload = this.uploads.get(id);
    if (!upload?.started) return;
    while (upload.sent < upload.data.length && upload.sent - upload.acked < UPLOAD_WINDOW) {
      const end = Math.min(upload.sent + UPLOAD_CHUNK, upload.data.length);
      this.send(streamFrame(Channel.Fs, id, upload.data.slice(upload.sent, end)));
      upload.sent = end;
    }
    upload.progress?.(upload.sent, upload.data.length);
  }

  /** Every file's text, searched where the files are. An earlier search still running is given up. */
  find(options: FindOptions): Promise<{ groups: FoundFile[]; truncated: boolean }> {
    for (const [id, old] of this.finds) {
      clearTimeout(old.timer);
      old.reject(new Error("overtaken by a newer search"));
      this.finds.delete(id);
    }
    const id = this.id();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finds.delete(id);
        reject(new Error("the host did not answer"));
      }, SLOW_WAIT);
      this.finds.set(id, { resolve, reject, timer });
      this.send(jsonFrame(Channel.Fs, TARGET_ALL, { t: "find", id, query: options.query, folder: options.folder, match_case: options.matchCase, whole_word: options.wholeWord }));
    });
  }

  replace(options: FindOptions, replacement: string, files: { path: string; sum: string }[]): Promise<Outcome> {
    return this.ask((id) => ({ t: "replace", id, query: options.query, match_case: options.matchCase, whole_word: options.wholeWord, replacement, files }), SLOW_WAIT);
  }

  /** A file's bytes, to look at — or, as a string, why they cannot be had. */
  bytes(path: string): Promise<Uint8Array | string> {
    return new Promise((resolve) => {
      this.views.push({ path, resolve });
      this.nextView();
    });
  }

  private nextView() {
    if (this.viewing) return;
    const wanted = this.views.shift();
    if (!wanted) return;
    const id = this.id();
    const timer = setTimeout(() => this.endView(id, "the host did not answer"), ANSWER_WAIT);
    this.viewing = { ...wanted, id, timer, stream: null, expected: 0, chunks: [], received: 0 };
    this.send(jsonFrame(Channel.Fs, TARGET_ALL, { t: "bytes", id, path: wanted.path }));
  }

  private endView(id: number, result: Uint8Array | string) {
    const view = this.viewing;
    if (!view || view.id !== id) return;
    clearTimeout(view.timer);
    this.viewing = null;
    view.resolve(result);
    this.nextView();
  }

  /** A message from the host about one of these. Whether it was. */
  message(msg: Fs): boolean {
    switch (msg.t) {
      case "done": {
        // An upload the host would not take, or a view it could not give.
        if (this.viewing?.id === msg.id) {
          this.endView(msg.id, msg.message || "the host could not send it");
          return true;
        }
        const waiting = this.waiting.get(msg.id);
        if (!waiting) return true;
        clearTimeout(waiting.timer);
        this.waiting.delete(msg.id);
        waiting.resolve({ ok: msg.ok, message: msg.message });
        return true;
      }
      case "taking": {
        const upload = this.uploads.get(msg.id);
        if (upload) {
          upload.started = true;
          this.pump(msg.id);
        }
        return true;
      }
      case "got": {
        const upload = this.uploads.get(msg.id);
        if (upload) {
          upload.acked = Math.max(upload.acked, msg.received);
          this.pump(msg.id);
        }
        return true;
      }
      case "found": {
        const find = this.finds.get(msg.id);
        if (find) {
          clearTimeout(find.timer);
          this.finds.delete(msg.id);
          find.resolve({ groups: msg.groups, truncated: msg.truncated });
        }
        return true;
      }
      case "sight": {
        const view = this.viewing;
        if (!view || view.id !== msg.id) return true;
        view.stream = msg.stream;
        view.expected = msg.bytes;
        if (msg.bytes === 0) this.endView(msg.id, new Uint8Array());
        return true;
      }
      default:
        return false;
    }
  }

  /** Bytes on a stream of the host's. Whether they were a view's. */
  stream(streamId: number, payload: Uint8Array): boolean {
    const view = this.viewing;
    if (!view || view.stream !== streamId) return false;
    view.chunks.push(payload.slice());
    view.received += payload.length;
    if (view.received >= view.expected) {
      const whole = new Uint8Array(view.received);
      let at = 0;
      for (const chunk of view.chunks) {
        whole.set(chunk, at);
        at += chunk.length;
      }
      this.endView(view.id, whole);
    }
    return true;
  }

  /**
   * The socket went, or the host did: nothing that was asked will be
   * answered. Said now rather than at each timeout — a relay drops what is
   * sent to a host that is away.
   */
  lost(why: string) {
    for (const [id, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.resolve({ ok: false, message: why });
      this.waiting.delete(id);
    }
    this.uploads.clear();
    for (const [id, find] of this.finds) {
      clearTimeout(find.timer);
      find.reject(new Error(why));
      this.finds.delete(id);
    }
    const viewing = this.viewing;
    if (viewing) this.endView(viewing.id, why);
    for (const view of this.views.splice(0)) view.resolve(why);
  }
}

/** The SHA-256 of a text as the host has it on disk, in hex: UTF-8, as it was read. */
export async function sumOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

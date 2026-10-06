/**
 * Telling the other browsers on this link that something moved.
 *
 * ## What travels
 *
 * A nudge, not the files. When a peer changes something it broadcasts
 * `{t:"moved", seq}` and everyone re-reads the folder from the store.
 *
 * Shipping the contents instead would be one fewer round trip and a whole
 * class of bug: the broadcast and the store would be two copies of the same
 * truth, and any frame dropped, reordered or arriving during a reconnect would
 * leave a browser confidently out of step with the server and no way to
 * notice. With a nudge the store is the only truth and the worst a lost frame
 * can do is delay somebody — which the next nudge fixes.
 *
 * It costs an HTTP round trip per change. On a scratchpad that is tens of
 * milliseconds, and it is the right trade until a folder is big enough that
 * re-reading it is the expensive part.
 *
 * ## Speaking as a peer
 *
 * The relay's peer rule: a peer stamps its own participant id on *every*
 * frame, not only sealed ones. A guest can leave it off because unstamped
 * already means "to the host"; a peer session has no host, so there is no such
 * default. The id is not known until `welcome` arrives, so anything sent
 * before then waits — except the hello itself, which is what earns the id.
 */

const HEADER_LEN = 9;
const CH_CONTROL = 0x01;
const CH_FS = 0x03;
const CH_DOC = 0x05;

/** How many frames may wait for a connection before the oldest are dropped. */
const MAX_PENDING = 512;

/** First byte of a doc payload. */
export const DOC_UPDATE = 0x01;
export const DOC_AWARENESS = 0x02;
/** A newcomer's state vector: "this is what I have, send me the rest." */
export const DOC_WANT = 0x03;
/**
 * The answer to a `DOC_WANT` from someone without that file open: there is
 * nothing here to send. It lets the asker stop waiting for this browser
 * rather than for a deadline — see `App.openDoc`.
 */
export const DOC_NONE = 0x04;

/**
 * Which stream a file's updates travel on.
 *
 * Derived from the path so every browser agrees without being told. A hash
 * rather than a counter: peers arrive in any order and there is nobody to hand
 * out numbers.
 */
export function streamFor(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Zero is the channel's own JSON stream, so it can never be a document.
  return (h >>> 0) || 1;
}

interface Frame {
  channel: number;
  streamId: number;
  target: number;
  payload: Uint8Array;
}

function encode(f: Frame): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + f.payload.length);
  const view = new DataView(out.buffer);
  out[0] = f.channel;
  view.setUint32(1, f.streamId, true);
  view.setUint32(5, f.target, true);
  out.set(f.payload, HEADER_LEN);
  return out;
}

function decode(buf: ArrayBuffer): Frame {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  return {
    channel: bytes[0]!,
    streamId: view.getUint32(1, true),
    target: view.getUint32(5, true),
    payload: bytes.subarray(HEADER_LEN),
  };
}

export interface PeerEvents {
  /** Somebody changed the folder. The sequence they reached, if they said. */
  onMoved: (seq: number) => void;
  /** How many other browsers are on this link, this one not counted. */
  onPresence: (others: number, id: number | null) => void;
  /** A document update, awareness change, or request for state. */
  /** `from` is the sender's participant id, which the relay makes it stamp. */
  onDoc: (stream: number, kind: number, bytes: Uint8Array, from: number) => void;
  /**
   * The relay turned this browser away — a pad that has become private to
   * it. Nothing reconnects after this.
   */
  onRefused?: (code: string, message: string) => void;
  /**
   * The room is shut to this page for now: an ajar session is using the name,
   * and a pad cannot share a room with one. Still retried, since sessions
   * end; `false` once a later try gets in.
   */
  onShut?: (shut: boolean) => void;
}

export class Peers {
  private ws: WebSocket | null = null;
  private id: number | null = null;
  /**
   * Frames waiting for a connection.
   *
   * Bounded, because every keystroke in an open file is a document update: a
   * disconnection somebody keeps typing through would grow this without limit.
   * Dropping the oldest is safe *because* a reconnect makes every open
   * document ask for state again — the text converges from the state exchange,
   * not from this queue.
   */
  private pending: Frame[] = [];
  private others = new Set<number>();
  /** Everyone else on this link, by participant id — which is also their colour. */
  get otherIds(): number[] {
    return [...this.others].sort((a, b) => a - b);
  }
  private closed = false;
  private attempt = 0;
  private shut = false;
  /** The next try after a dropped socket, while one is waiting. */
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** Doc frames in and out, for the browser checks. */
  readonly counts = { docOut: 0, docIn: 0, dropped: 0 };
  private arrived: (() => void) | null = null;
  /**
   * Resolves once the relay has said who else is here.
   *
   * Anything that behaves differently when alone has to wait for this, or it
   * decides in the moment before the socket has answered — when the room
   * always looks empty.
   */
  readonly ready: Promise<void>;

  constructor(
    private readonly url: string,
    private readonly session: string,
    private readonly events: PeerEvents,
    /** The pad link's code, which the relay checks at the door. */
    private readonly code: () => string | null = () => null,
  ) {
    this.ready = new Promise<void>((resolve) => {
      this.arrived = resolve;
      // A relay that never answers must not hold the page up forever.
      setTimeout(resolve, 2000);
    });
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      // Not the end of backing off: a room that refuses the hello still opened
      // the socket first, and resetting here retried that four times a second.
      // The welcome is what resets it.
      // Straight onto the socket. The hello is what *earns* a participant id,
      // and every other frame waits for one — routing this through the queue
      // would park it waiting for the reply it is supposed to cause.
      ws.send(
        encode({
          channel: CH_CONTROL,
          streamId: 0,
          target: 0,
          payload: json({ t: "hello", session: this.session, role: "peer", ...this.codeField() }),
        }),
      );
    };

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      try {
        this.receive(decode(ev.data));
      } catch {
        // A frame we cannot read is one we drop. The store is still the truth.
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // The relay issues a new participant id on every join and refuses a
      // frame stamped with any other, so the old one must not survive the
      // socket that earned it.
      this.id = null;
      this.others.clear();
      this.events.onPresence(0, null);
      if (this.closed) return;
      const wait = Math.min(250 * 2 ** this.attempt, 8000);
      this.attempt += 1;
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, wait);
    };

    ws.onerror = () => ws.close();
  }

  private codeField(): { code?: string } {
    const code = this.code();
    return code ? { code } : {};
  }

  private receive(f: Frame): void {
    if (f.channel === CH_CONTROL) {
      const msg = parse(f.payload) as
        | { t: "welcome"; participant_id: number; participants: { id: number }[] }
        | { t: "joined"; participant: { id: number } }
        | { t: "left"; participant_id: number }
        | { t: string };
      if (msg.t === "welcome") {
        this.attempt = 0;
        if (this.shut) {
          this.shut = false;
          this.events.onShut?.(false);
        }
        const welcome = msg as { participant_id: number; participants: { id: number }[] };
        this.id = welcome.participant_id;
        this.others = new Set(
          welcome.participants.map((p) => p.id).filter((id) => id !== this.id),
        );
        this.events.onPresence(this.others.size, this.id);
        this.arrived?.();
        for (const q of this.pending.splice(0)) this.send(q.channel, q.payload, q.streamId);
      } else if (msg.t === "joined") {
        this.others.add((msg as { participant: { id: number } }).participant.id);
        this.events.onPresence(this.others.size, this.id);
      } else if (msg.t === "left") {
        this.others.delete((msg as { participant_id: number }).participant_id);
        this.events.onPresence(this.others.size, this.id);
      } else if (msg.t === "error") {
        // Refused at the door. Knocking again every few seconds would be
        // refused the same way for as long as the page stayed open.
        const refusal = msg as { code?: string; message?: string };
        if (refusal.code === "private" || refusal.code === "gone") {
          this.closed = true;
          this.arrived?.();
          this.events.onRefused?.(refusal.code, refusal.message ?? "");
        } else if (refusal.code === "wrong_shape") {
          // Nobody else is here to wait for, and the page should say why.
          this.arrived?.();
          if (!this.shut) {
            this.shut = true;
            this.events.onShut?.(true);
          }
        }
      }
      return;
    }
    if (f.channel === CH_FS) {
      const msg = parse(f.payload) as { t: string; seq?: number };
      if (msg.t === "moved") this.events.onMoved(msg.seq ?? 0);
      return;
    }
    if (f.channel === CH_DOC && f.payload.length > 0) {
      this.counts.docIn += 1;
      this.events.onDoc(f.streamId, f.payload[0]!, f.payload.subarray(1), f.target);
    }
  }

  get alone(): boolean {
    return this.others.size === 0;
  }

  /** Say that the folder moved. Silent when nobody else is here. */
  moved(seq: number): void {
    if (this.others.size === 0) return;
    this.send(CH_FS, json({ t: "moved", seq }));
  }

  /**
   * A document update. Sent even when alone, unlike `moved` — a peer that
   * arrives a moment later asks for state, and answering needs the history
   * these updates carry.
   */
  doc(stream: number, kind: number, bytes: Uint8Array): void {
    this.counts.docOut += 1;
    const payload = new Uint8Array(bytes.length + 1);
    payload[0] = kind;
    payload.set(bytes, 1);
    this.send(CH_DOC, payload, stream);
  }

  private send(channel: number, payload: Uint8Array, streamId = 0): void {
    if (this.id === null || this.ws?.readyState !== WebSocket.OPEN) {
      this.counts.dropped += 1;
      this.pending.push({ channel, streamId, target: 0, payload });
      if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
      return;
    }
    this.ws.send(encode({ channel, streamId, target: this.id, payload }));
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }

  /**
   * Back from the browser's back-forward cache: a fresh socket, whatever the
   * old one says. It was frozen there, and its state on the way back is not
   * to be trusted — still `OPEN` when `pageshow` runs, in Chrome, with the
   * close only queued; and a browser that never delivers that close would
   * leave the room dead. The old socket's own close, if it comes, finds it
   * is no longer the one in use and does nothing.
   */
  resume(): void {
    if (this.closed) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const old = this.ws;
    this.ws = null;
    this.id = null;
    this.others.clear();
    this.events.onPresence(0, null);
    try {
      old?.close();
    } catch {
      // Already closed.
    }
    this.attempt = 0;
    this.connect();
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (v: unknown) => encoder.encode(JSON.stringify(v));
const parse = (b: Uint8Array) => JSON.parse(decoder.decode(b)) as unknown;

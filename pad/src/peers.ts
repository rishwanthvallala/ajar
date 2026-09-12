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
  onPresence: (others: number) => void;
}

export class Peers {
  private ws: WebSocket | null = null;
  private id: number | null = null;
  private pending: Frame[] = [];
  private others = new Set<number>();
  private closed = false;
  private attempt = 0;

  constructor(
    private readonly url: string,
    private readonly session: string,
    private readonly events: PeerEvents,
  ) {}

  connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      // Straight onto the socket. The hello is what *earns* a participant id,
      // and every other frame waits for one — routing this through the queue
      // would park it waiting for the reply it is supposed to cause.
      ws.send(
        encode({
          channel: CH_CONTROL,
          streamId: 0,
          target: 0,
          payload: json({ t: "hello", session: this.session, role: "peer" }),
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
      this.events.onPresence(0);
      if (this.closed) return;
      const wait = Math.min(250 * 2 ** this.attempt, 8000);
      this.attempt += 1;
      setTimeout(() => this.connect(), wait);
    };

    ws.onerror = () => ws.close();
  }

  private receive(f: Frame): void {
    if (f.channel === CH_CONTROL) {
      const msg = parse(f.payload) as
        | { t: "welcome"; participant_id: number; participants: { id: number }[] }
        | { t: "joined"; participant: { id: number } }
        | { t: "left"; participant_id: number }
        | { t: string };
      if (msg.t === "welcome") {
        const welcome = msg as { participant_id: number; participants: { id: number }[] };
        this.id = welcome.participant_id;
        this.others = new Set(
          welcome.participants.map((p) => p.id).filter((id) => id !== this.id),
        );
        this.events.onPresence(this.others.size);
        for (const queued of this.pending.splice(0)) this.send(queued.channel, queued.payload);
      } else if (msg.t === "joined") {
        this.others.add((msg as { participant: { id: number } }).participant.id);
        this.events.onPresence(this.others.size);
      } else if (msg.t === "left") {
        this.others.delete((msg as { participant_id: number }).participant_id);
        this.events.onPresence(this.others.size);
      }
      return;
    }
    if (f.channel === CH_FS) {
      const msg = parse(f.payload) as { t: string; seq?: number };
      if (msg.t === "moved") this.events.onMoved(msg.seq ?? 0);
    }
  }

  /** Say that the folder moved. Silent when nobody else is here. */
  moved(seq: number): void {
    if (this.others.size === 0) return;
    this.send(CH_FS, json({ t: "moved", seq }));
  }

  private send(channel: number, payload: Uint8Array): void {
    if (this.id === null || this.ws?.readyState !== WebSocket.OPEN) {
      this.pending.push({ channel, streamId: 0, target: 0, payload });
      return;
    }
    this.ws.send(encode({ channel, streamId: 0, target: this.id, payload }));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (v: unknown) => encoder.encode(JSON.stringify(v));
const parse = (b: Uint8Array) => JSON.parse(decoder.decode(b)) as unknown;

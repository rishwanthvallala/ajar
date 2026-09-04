import { Channel, decode, encode, Frame, jsonFrame, Role, TARGET_ALL } from "./proto";
import { isEncrypted, Sealer } from "./sealed";

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnOptions {
  session: string;
  name: string;
  /** Seals content channels. Absent for a link that carries no key. */
  sealer?: Sealer | null;
  role?: Role;
  onFrame: (f: Frame) => void;
  onState: (s: ConnState, detail?: string) => void;
}

function relayUrl(): string {
  const configured = import.meta.env.VITE_RELAY as string | undefined;
  if (configured) return configured;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

/**
 * One socket to the relay, with backoff. The agent keeps running while we're
 * away — terminals stay alive and output keeps filling its ring buffers — so
 * reconnecting is a matter of saying hello again and replaying.
 */
export class Connection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closedByUs = false;
  /**
   * Frames waiting to go out, always *unsealed*.
   *
   * They have to be. A guest's content frames authenticate their sender id,
   * the relay allocates a fresh one on every join, and it refuses a frame
   * stamped with any other. So a frame sealed before a drop is worthless
   * after it: what waits here is the frame, and it is stamped and sealed at
   * the moment it actually goes out.
   */
  private pending: Frame[] = [];
  /** Who the relay says we are on *this* socket. Null until it says. */
  private participantId: number | null = null;
  /**
   * Sealing and opening are asynchronous, and terminal bytes have to keep
   * their order. Both directions run through their own promise chain, so a
   * frame can never overtake the one before it.
   */
  private outbound: Promise<void> = Promise.resolve();
  private inbound: Promise<void> = Promise.resolve();

  constructor(private opts: ConnOptions) {
    this.open();
  }

  private open() {
    this.opts.onState(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(relayUrl());
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.write(
        jsonFrame(Channel.Control, TARGET_ALL, {
          t: "hello",
          session: this.opts.session,
          role: this.opts.role ?? "guest",
        }),
      );
      // Anything that still needs an identity goes straight back to waiting;
      // `welcome` flushes it again once the relay has named us.
      this.flush();
      this.opts.onState("open");
    };

    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      let frame: Frame;
      try {
        frame = decode(ev.data);
      } catch (e) {
        console.warn("dropping malformed frame", e);
        return;
      }
      const sealer = this.opts.sealer;
      if (!sealer) {
        this.deliver(frame);
        return;
      }
      // The `catch` is load-bearing, not defensive dressing: these chains
      // gate every later frame, so one rejection stops the client receiving
      // anything ever again — silently, with the socket still open. A frame
      // that throws is dropped; the next one still gets its turn.
      this.inbound = this.inbound
        .then(async () => {
          const opened = await sealer.open(frame);
          // Wrong key, or a frame that was interfered with. Neither is worth
          // guessing at.
          if (opened) this.deliver(opened);
        })
        .catch((e) => console.warn("dropping a frame that could not be handled", e));
    };

    ws.onclose = () => {
      // A close from a socket we have already replaced says nothing about the
      // one we are on now; acting on it would clear a live identity and
      // schedule a second reconnect loop alongside the first.
      if (this.ws !== ws) return;
      this.ws = null;
      // The identity belonged to the socket that just went away. Clearing it
      // sends content frames back to waiting instead of out the new socket
      // stamped with a participant the relay has already forgotten — which
      // it drops, silently, and the typing that caused them disappears.
      this.participantId = null;
      if (this.closedByUs) {
        this.opts.onState("closed");
        return;
      }
      // 250ms, 500ms, 1s, 2s, 4s, then every 8s. A blip under about thirty
      // seconds should be invisible once replay is wired up.
      const delay = Math.min(250 * 2 ** this.attempt, 8000);
      this.attempt += 1;
      this.opts.onState("reconnecting", `retrying in ${Math.round(delay / 100) / 10}s`);
      setTimeout(() => this.open(), delay);
    };

    ws.onerror = () => ws.close();
  }

  send(f: Frame) {
    // Through the chain even when it will only be parked, so that a frame can
    // never overtake the one before it on the way out.
    this.outbound = this.outbound
      .then(() => this.dispatch(f))
      .catch((e) => console.warn("dropping a frame that could not be sent", e));
  }

  /** Stamp, seal and write one frame — or park it until that is possible. */
  private async dispatch(f: Frame) {
    const content = this.isGuest() && isEncrypted(f.channel);
    if ((content && this.participantId === null) || !this.isOpen()) {
      this.pending.push(f);
      return;
    }
    const routed = content ? { ...f, target: this.participantId! } : f;
    const sealer = this.opts.sealer;
    const outgoing = sealer ? await sealer.seal(routed) : routed;
    // Sealing is asynchronous, so the socket may have gone in the meantime.
    // Park the *unsealed* frame, never the one stamped for the old identity.
    if (!this.isOpen()) {
      this.pending.push(f);
      return;
    }
    this.write(outgoing);
  }

  private flush() {
    for (const f of this.pending.splice(0)) this.send(f);
  }

  private isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private deliver(f: Frame) {
    if (f.channel === Channel.Control) {
      try {
        const msg = JSON.parse(new TextDecoder().decode(f.payload)) as {
          t?: string;
          participant_id?: number;
        };
        if (msg.t === "welcome" && typeof msg.participant_id === "number") {
          this.participantId = msg.participant_id;
          this.flush();
        }
      } catch {
        // The application owns malformed control-message handling.
      }
    }
    this.opts.onFrame(f);
  }

  private isGuest() {
    return (this.opts.role ?? "guest") === "guest";
  }

  /** Raw, already-stamped-and-sealed. Everything else goes via `dispatch`. */
  private write(f: Frame) {
    if (this.isOpen()) {
      this.ws!.send(encode(f));
    } else {
      this.pending.push(f);
    }
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }
}

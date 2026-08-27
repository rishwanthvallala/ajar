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
  private queue: Frame[] = [];
  private pendingContent: Frame[] = [];
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
      for (const f of this.queue.splice(0)) this.write(f);
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
      this.inbound = this.inbound.then(async () => {
        const opened = await sealer.open(frame);
        // Wrong key, or a frame that was interfered with. Neither is worth
        // guessing at.
        if (opened) this.deliver(opened);
      });
    };

    ws.onclose = () => {
      this.ws = null;
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
    const sealer = this.opts.sealer;
    if (this.isGuest() && isEncrypted(f.channel) && this.participantId === null) {
      this.pendingContent.push(f);
      return;
    }
    const routed = this.isGuest() && isEncrypted(f.channel)
      ? { ...f, target: this.participantId! }
      : f;
    if (!sealer) {
      this.write(routed);
      return;
    }
    this.outbound = this.outbound.then(async () => {
      this.write(await sealer.seal(routed));
    });
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
          for (const pending of this.pendingContent.splice(0)) this.send(pending);
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

  private write(f: Frame) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encode(f));
    } else {
      this.queue.push(f);
    }
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }
}

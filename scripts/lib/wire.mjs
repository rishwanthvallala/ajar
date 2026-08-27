// Minimal client-side implementation of the ajar wire format, for tests.
// Mirrors crates/ajar-proto/src/lib.rs.

import { spawn } from "node:child_process";

export const HEADER_LEN = 9;
export const CH_CONTROL = 0x01;
export const CH_PTY = 0x02;
export const CH_FS = 0x03;
export const CH_PRESENCE = 0x04;
export const CH_DOC = 0x05;
export const CH_STORE = 0x06;
export const SNAPSHOT_STREAM = 1;

/** First byte of a binary payload on the doc channel. */
export const DOC_UPDATE = 0x01;
export const DOC_AWARENESS = 0x02;
export const TARGET_ALL = 0;
export const STREAM_CONTROL = 0;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------------ sealing

const NONCE_LEN = 12;

/** Mirrors `Channel::is_encrypted` on the Rust side. */
export const isEncrypted = (channel) =>
  channel === CH_PTY || channel === CH_FS || channel === CH_DOC || channel === CH_PRESENCE;

export async function importKey(b64url) {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(key, frame) {
  if (!isEncrypted(frame.channel)) return frame;
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: header(frame) },
      key,
      frame.payload,
    ),
  );
  const payload = new Uint8Array(NONCE_LEN + ct.length);
  payload.set(nonce, 0);
  payload.set(ct, NONCE_LEN);
  return { ...frame, payload };
}

async function open(key, frame) {
  if (!isEncrypted(frame.channel)) return frame;
  if (frame.payload.length < NONCE_LEN) return null;
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: frame.payload.subarray(0, NONCE_LEN),
          additionalData: header(frame),
        },
        key,
        frame.payload.subarray(NONCE_LEN),
      ),
    );
    return { ...frame, payload: plain };
  } catch {
    return null;
  }
}

function header(frame) {
  const out = new Uint8Array(HEADER_LEN);
  const view = new DataView(out.buffer);
  out[0] = frame.channel;
  view.setUint32(1, frame.streamId, true);
  view.setUint32(5, frame.target, true);
  return out;
}

/**
 * Pull the session id and key out of whatever the agent printed.
 *
 * The key rides in the link's fragment, which is exactly why a browser never
 * sends it to the relay.
 */
export async function linkOf(agent, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("agent never printed a link")), timeoutMs);
    const poll = setInterval(() => {
      const m = agent.output.match(/\/j\/([a-z0-9-]+)(?:#k=([A-Za-z0-9_-]+))?/i);
      if (m) {
        clearInterval(poll);
        clearTimeout(t);
        resolve({ session: m[1], key: m[2] ?? null });
      }
    }, 25);
  });
}

export function encode({ channel, streamId = STREAM_CONTROL, target = TARGET_ALL, payload }) {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  const view = new DataView(out.buffer);
  out[0] = channel;
  view.setUint32(1, streamId, true);
  view.setUint32(5, target, true);
  out.set(payload, HEADER_LEN);
  return out;
}

export function decode(buf) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    channel: bytes[0],
    streamId: view.getUint32(1, true),
    target: view.getUint32(5, true),
    payload: bytes.subarray(HEADER_LEN),
  };
}

export const json = (channel, msg) =>
  encode({ channel, payload: enc.encode(JSON.stringify(msg)) });

export const text = (bytes) => dec.decode(bytes);

// ------------------------------------------------------------------ harness

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForHealth(httpBase, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${httpBase}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(100);
  }
  throw new Error(`relay at ${httpBase} never became healthy`);
}

/** A guest that speaks the protocol, accumulating what it sees. */
export class Guest {
  constructor(wsUrl, session, name, key = null) {
    this.wsUrl = wsUrl;
    this.session = session;
    this.name = name;
    /** Overridable: some tests need to speak as the host. */
    this.role = "guest";
    /** base64url session key, or null for an unencrypted session. */
    this.keyText = key;
    this.key = null;
    // Sealing is asynchronous and terminal bytes must keep their order, so
    // both directions run through their own chain.
    this.outChain = Promise.resolve();
    this.inChain = Promise.resolve();
    this.reset();
  }

  reset() {
    this.participantId = null;
    this.ptys = new Map(); // ptyId -> accumulated text
    this.control = [];
    this.presence = [];
    this.roster = []; // people, from the host's encrypted roster
    this.store = []; // store messages, in order
    this.snapshot = null; // sealed bytes of the stored copy
    this.fs = []; // every fs message, in order
    this.docMessages = []; // json on the doc channel
    this.onDoc = null; // (streamId, kind, bytes) for binary doc frames
    this.tree = new Map(); // path -> entry, kept current by patches
    this.contents = new Map(); // path -> content message
  }

  /** Fold an fs message into the mirrored tree, the way a real client does. */
  applyFs(msg) {
    this.fs.push(msg);
    if (msg.t === "tree") {
      this.tree = new Map(msg.entries.map((e) => [e.path, e]));
    } else if (msg.t === "patch") {
      for (const e of [...msg.added, ...msg.changed]) this.tree.set(e.path, e);
      for (const p of msg.removed) this.tree.delete(p);
    } else if (msg.t === "content" || msg.t === "read_error") {
      this.contents.set(msg.path, msg);
    }
  }

  sawFs(predicate) {
    return this.fs.some(predicate);
  }

  async connect() {
    if (this.keyText && !this.key) this.key = await importKey(this.keyText);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        this.send(
          json(CH_CONTROL, {
            t: "hello",
            session: this.session,
            role: this.role,
          }),
        );
      };

      ws.onmessage = (ev) => {
        const raw = decode(ev.data);
        if (this.key) {
          this.inChain = this.inChain.then(async () => {
            const f = await open(this.key, raw);
            if (f) this.dispatch(f, resolve, reject);
          });
        } else {
          this.dispatch(raw, resolve, reject);
        }
      };

      ws.onerror = () => reject(new Error("guest websocket errored"));
      setTimeout(() => reject(new Error("guest handshake timed out")), 10_000);
    });
  }

  dispatch(f, resolve, reject) {
    try {
        if (f.channel === CH_CONTROL) {
          const msg = JSON.parse(text(f.payload));
          this.control.push(msg);
          if (msg.t === "welcome") {
            this.participantId = msg.participant_id;
            // The relay has no names. Introduce ourselves on the encrypted
            // channel, exactly as the browser client does.
            if (this.role !== "host") {
              this.send(json(CH_PRESENCE, { t: "iam", name: this.name }));
            }
            resolve(this);
          } else if (msg.t === "error") {
            reject(new Error(`${msg.code}: ${msg.message}`));
          }
          return;
        }
        if (f.channel === CH_PTY) {
          if (f.streamId === STREAM_CONTROL) {
            const msg = JSON.parse(text(f.payload));
            if (msg.t === "opened" && !this.ptys.has(msg.pty_id)) {
              this.ptys.set(msg.pty_id, "");
            }
            if (msg.t === "closed") this.ptys.delete(msg.pty_id);
          } else {
            this.ptys.set(f.streamId, (this.ptys.get(f.streamId) ?? "") + text(f.payload));
          }
          return;
        }
        if (f.channel === CH_DOC) {
          if (f.streamId === STREAM_CONTROL) {
            this.docMessages.push(JSON.parse(text(f.payload)));
          } else if (this.onDoc && f.payload.length > 0) {
            this.onDoc(f.streamId, f.payload[0], f.payload.subarray(1));
          }
          return;
        }
        if (f.channel === CH_STORE) {
          if (f.streamId === SNAPSHOT_STREAM) this.snapshot = f.payload;
          else this.store.push(JSON.parse(text(f.payload)));
          return;
        }
        if (f.channel === CH_FS) {
          this.applyFs(JSON.parse(text(f.payload)));
          return;
        }
        if (f.channel === CH_PRESENCE) {
          const msg = JSON.parse(text(f.payload));
          this.presence.push(msg);
          if (msg.t === "roster") this.roster = msg.people;
        }
    } catch (e) {
      // Usually a frame we have no key for. Dropping it is what a real
      // client does; throwing here would take the whole test down.
      this.undecodable = (this.undecodable ?? 0) + 1;
    }
  }

  /** Accepts an encoded frame, as the older call sites produce. */
  send(bytes) {
    const frame = decode(bytes.buffer ? bytes : new Uint8Array(bytes));
    const routed =
      this.role === "guest" && isEncrypted(frame.channel)
        ? { ...frame, target: this.participantId }
        : frame;
    if (!this.key) {
      this.ws.send(encode(routed));
      return;
    }
    this.outChain = this.outChain.then(async () => {
      this.ws.send(encode(await seal(this.key, routed)));
    });
  }

  openPty(cols = 80, rows = 24) {
    this.send(json(CH_PTY, { t: "open", cols, rows }));
  }

  type(ptyId, s) {
    this.send(encode({ channel: CH_PTY, streamId: ptyId, payload: enc.encode(s) }));
  }

  reportPresence(activePty) {
    this.send(json(CH_PRESENCE, { t: "report", active_pty: activePty }));
  }

  /** Ask the relay for the copy it is holding. */
  fetchSnapshot() {
    this.send(json(CH_STORE, { t: "fetch" }));
  }

  /** Unseal a stored snapshot with the session key. */
  async openSnapshot() {
    if (!this.snapshot || !this.key) return null;
    const NONCE = 12;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: this.snapshot.subarray(0, NONCE) },
      this.key,
      this.snapshot.subarray(NONCE),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  }

  readFile(path) {
    this.send(json(CH_FS, { t: "read", path }));
  }

  /** All terminal output this guest has seen, across every pty. */
  get screen() {
    return [...this.ptys.values()].join("");
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }

  /**
   * Wait until a terminal stops producing output.
   *
   * A person types when the shell looks ready; a script that fires at the
   * first byte can land mid-startup, where a slow rc file swallows the
   * keystrokes. That is not a harmless race: a half-received command still
   * performs its `>` redirect, so `printf x > f` arrives as `rintf x > f`
   * and truncates the file before failing.
   */
  async settle(pty, quietMs = 400, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      const len = (this.ptys.get(pty) ?? "").length;
      if (len !== last) {
        last = len;
        lastChange = Date.now();
      } else if (len > 0 && Date.now() - lastChange >= quietMs) {
        return;
      }
      await sleep(50);
    }
  }

  /**
   * Prove the shell is actually reading before relying on it.
   *
   * Waiting for output to go quiet is not enough — zsh's line editor
   * discards typeahead as it starts, so the first character of the first
   * command can vanish even after the prompt has rendered. That is not a
   * harmless race: a half-received command still performs its `>` redirect,
   * so `printf x > f` arriving as `rintf x > f` truncates the file and then
   * fails.
   *
   * So: send a sentinel and require it back. If it never lands, the shell
   * ate it, and we try again.
   */
  async ready(pty, attempts = 6) {
    for (let i = 0; i < attempts; i++) {
      await this.settle(pty);
      const marker = `rdy${Math.random().toString(36).slice(2, 7)}`;
      const before = (this.ptys.get(pty) ?? "").length;
      this.type(pty, `echo ${marker}\r`);
      try {
        await this.waitUntil(
          (g) => {
            const seen = (g.ptys.get(pty) ?? "").slice(before);
            // Twice: once echoed as input, once as output.
            return seen.split(marker).length - 1 >= 2;
          },
          "the shell to answer",
          3000,
        );
        return;
      } catch {
        // Swallowed. Go round again.
      }
    }
    throw new Error(`terminal ${pty} never became ready`);
  }

  async waitUntil(fn, what, timeoutMs = 15_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (fn(this)) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
}

/** Tracks child processes so a failing test doesn't leak them. */
export class Procs {
  constructor() {
    this.list = [];
    process.on("exit", () => this.killAll());
    process.on("SIGINT", () => {
      this.killAll();
      process.exit(130);
    });
  }

  start(cmd, args, label) {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    p.label = label;
    p.output = "";
    p.stdout.on("data", (d) => (p.output += d.toString()));
    p.stderr.on("data", (d) => (p.output += d.toString()));
    p.on("error", (e) => {
      throw new Error(`could not start ${label}: ${e.message}`);
    });
    this.list.push(p);
    return p;
  }

  /**
   * SIGKILL is a *blip* — the relay holds the session open for its grace
   * period. SIGINT is what ctrl-c sends, which the agent turns into a
   * deliberate close. The difference is the whole point, so callers say
   * which one they mean.
   */
  kill(p, signal = "SIGKILL") {
    try {
      p.kill(signal);
    } catch {}
    if (signal === "SIGKILL") this.list = this.list.filter((x) => x !== p);
  }

  killAll() {
    for (const p of this.list) {
      try {
        p.kill("SIGKILL");
      } catch {}
    }
    this.list = [];
  }
}

// ------------------------------------------------------------------ reporting

let failed = false;

export function ok(msg) {
  console.log(`  ok    ${msg}`);
}

export function fail(msg) {
  failed = true;
  console.error(`\n  FAIL  ${msg}\n`);
}

export function finish(procs, headline) {
  procs.killAll();
  if (failed) process.exit(1);
  console.log(`\n  ${headline}\n`);
  process.exit(0);
}

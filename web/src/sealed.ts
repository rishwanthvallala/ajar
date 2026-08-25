import { Channel, Frame } from "./proto";

/**
 * The session key, and the sealing that keeps the relay out of it.
 *
 * The key arrives in the link's fragment (`#k=…`), which browsers never send
 * to a server — so the relay routes frames it cannot read.
 *
 * WebCrypto is asynchronous, which matters more here than it looks: terminal
 * bytes have to arrive in the order they were sent. Every seal and open is
 * therefore chained, not merely awaited.
 */

const NONCE_LEN = 12;

export class Sealer {
  private constructor(private key: CryptoKey) {}

  /** `null` when the link carries no key — an older, unencrypted session. */
  static async fromHash(hash: string): Promise<Sealer | null> {
    const m = hash.match(/[#&]k=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    const raw = base64UrlDecode(m[1]);
    if (raw.length !== 32) return null;
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    return new Sealer(key);
  }

  async seal(f: Frame): Promise<Frame> {
    if (!f.channel || !isEncrypted(f.channel)) return f;
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, this.key, f.payload),
    );
    const payload = new Uint8Array(NONCE_LEN + ct.length);
    payload.set(nonce, 0);
    payload.set(ct, NONCE_LEN);
    return { ...f, payload };
  }

  /** `null` for a frame that will not open — wrong key, or interfered with. */
  async open(f: Frame): Promise<Frame | null> {
    if (!isEncrypted(f.channel)) return f;
    if (f.payload.length < NONCE_LEN) return null;
    const nonce = f.payload.subarray(0, NONCE_LEN);
    const body = f.payload.subarray(NONCE_LEN);
    try {
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, this.key, body),
      );
      return { ...f, payload: plain };
    } catch {
      return null;
    }
  }
}

/** Mirrors `Channel::is_encrypted` on the Rust side. */
export function isEncrypted(channel: Channel): boolean {
  return (
    channel === Channel.Pty ||
    channel === Channel.Fs ||
    channel === Channel.Doc ||
    channel === Channel.Presence
  );
}

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

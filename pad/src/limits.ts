/**
 * What the relay holds a pad to, as it says at `/api/limits` (`limits` in the
 * relay's main.rs): the numbers a zip import and a download into the sandbox
 * are checked against before anything is sent, and said in words.
 *
 * They were constants here as well as there, so changing the relay's meant a
 * change here too, and a release; the relay's are settings now
 * (`deploy/limits.env`, docs/dev/operations.md), and the page asks. Until it
 * has an answer — and from a relay too old to give one — it goes by the
 * defaults below, which are the relay's own.
 */
export interface PadLimits {
  /** Files one pad may hold. */
  maxFiles: number;
  /** Bytes one pad may hold. */
  maxBytes: number;
}

export const DEFAULT_LIMITS: Readonly<PadLimits> = { maxFiles: 500, maxBytes: 200 * 1024 * 1024 };

let current: PadLimits = { ...DEFAULT_LIMITS };
const asked = new Map<string, Promise<PadLimits>>();

/** The limits as last heard, the defaults until then. */
export function padLimits(): PadLimits {
  return current;
}

/**
 * The relay's answer, asked once a page and shared; the defaults if it gives
 * none. A pad is held to its owner's plan, free or paid (the relay's
 * `plan.rs`), so in a pad the question names it; on the dashboard, where a new
 * pad is the person's own, it is asked about them.
 */
export function loadLimits(pad?: string, base = ""): Promise<PadLimits> {
  const key = pad ?? "";
  let answer = asked.get(key);
  if (!answer) {
    const query = pad ? `?pad=${encodeURIComponent(pad)}` : "";
    answer = fetch(`${base}/api/limits${query}`, { cache: "no-store", credentials: "same-origin" })
      .then(async (res) => {
        const heard = res.ok ? limitsFrom(await res.json()) : null;
        if (heard) current = heard;
        return heard ?? current;
      })
      .catch(() => current);
    asked.set(key, answer);
  }
  return answer;
}

/** The pad's part of `/api/limits`, if that is what this is. */
export function limitsFrom(json: unknown): PadLimits | null {
  const pad = (json as { pad?: { bytes?: unknown; files?: unknown } } | null)?.pad;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  return pad && count(pad.bytes) && count(pad.files) ? { maxFiles: pad.files, maxBytes: pad.bytes } : null;
}

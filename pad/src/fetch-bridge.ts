/**
 * HTTP through the browser: the page's half. The sandbox's is
 * tools/_padfetch.py, which `curl`, `wget`, urllib.request and `requests` use.
 *
 * The sandbox's own sockets reach PyPI and nothing else (networking.md); a
 * page cannot open a socket at all, but it can fetch. So a request written to
 * `.ajar/fetch/<id>.req` is claimed, made with fetch, and answered in
 * `<id>.ans` — the files and the polling of the fast javac (javac/bridge.ts),
 * only while a command runs.
 *
 * Made as any web page's request is, and no more: without this page's cookies
 * or referrer, to sites that let a web page read them (CORS), https only from
 * an https page. Never to this site itself, or the preview's: those are ours,
 * and a program somebody shared has no business asking them anything in the
 * name of whoever ran it.
 *
 * Except localhost, which here is the folder's own servers: `curl
 * localhost:5000` in one terminal, at the Flask app running in another. The
 * browser's own localhost is the visitor's computer, which a pad never
 * reaches. Those go through the preview's worker into the sandbox (`LocalFetch`,
 * preview.ts), as a program's request rather than a page's: no CORS, no
 * cookies but its own.
 */
import type { Sandbox } from "@wasmer/sdk";
import { padLimits } from "./limits";

const DIR = "/workspace/.ajar/fetch";
const POLL_MS = 40;
/** As much as a pad holds: a body bigger than that has nowhere to go. */
const maxBody = () => padLimits().maxBytes;
/** Requests made at once; the rest wait their turn. */
const AT_ONCE = 16;

/** What the sandbox asks: the first line of `<id>.req`, the body after it. */
export interface FetchRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
  /** Seconds, or none. */
  timeout: number | null;
  /**
   * Whether a redirect is followed. The browser follows every one from a web
   * site regardless; to localhost, only if this says so.
   */
  follow: boolean;
}

/** What it is told: the first line of `<id>.ans`, the body after it. */
export type FetchAnswer =
  | { ok: true; status: number; statusText: string; url: string; redirected: boolean; headers: [string, string][]; dropped: string[] }
  /** `code` is curl's number for it, which curl exits with. */
  | { ok: false; code: number; error: string };

const NEWLINE = 10;

/** Names that mean this machine, which in a pad is the sandbox. */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** A request to one of the folder's servers, and its answer: preview.ts. */
export type LocalFetch = (request: FetchRequest, url: URL) => Promise<{ answer: FetchAnswer; body?: Uint8Array }>;

export function decodeRequest(bytes: Uint8Array): FetchRequest {
  const cut = bytes.indexOf(NEWLINE);
  if (cut < 0) throw new Error("a request with no header line");
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(0, cut))) as {
    url: string; method?: string; headers?: [string, string][]; body?: boolean; timeout?: number | null; follow?: boolean;
  };
  return {
    url: head.url,
    method: head.method ?? "GET",
    headers: head.headers ?? [],
    body: head.body ? bytes.slice(cut + 1) : null,
    timeout: typeof head.timeout === "number" && head.timeout > 0 ? head.timeout : null,
    follow: head.follow !== false,
  };
}

export function encodeAnswer(answer: FetchAnswer, body: Uint8Array = new Uint8Array()): Uint8Array {
  const head = new TextEncoder().encode(`${JSON.stringify(answer)}\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/**
 * Headers the browser sets itself and will not take from a page — given
 * anyway, they are left out without a word, so they are named instead.
 * User-Agent is allowed by the standard and still dropped by Chrome.
 */
const BROWSERS = new Set([
  "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method",
  "access-control-request-private-network", "connection", "content-length", "cookie", "cookie2", "date", "dnt",
  "expect", "host", "keep-alive", "origin", "referer", "set-cookie", "te", "trailer", "transfer-encoding",
  "upgrade", "via", "user-agent",
]);

/** The headers a page may send, and the names of those it may not. */
export function headersFor(given: [string, string][]): { headers: Headers; dropped: string[] } {
  const headers = new Headers();
  const dropped: string[] = [];
  for (const [name, value] of given) {
    const lower = name.toLowerCase();
    if (BROWSERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) {
      if (!dropped.includes(name)) dropped.push(name);
      continue;
    }
    try {
      headers.append(name, value);
    } catch {
      dropped.push(name);
    }
  }
  return { headers, dropped };
}

/**
 * Why `raw` will not be fetched from `page`, or null — and then the URL to
 * fetch, with any `user:pass@` taken out of it and into a header, as curl
 * sends it, since fetch refuses a URL that carries one.
 */
export function vet(raw: string, page: URL, ours: readonly string[]): { url: URL; authorization: string | null } | { code: number; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { code: 3, error: `URL rejected: Malformed input to a URL function: ${raw}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { code: 1, error: `Protocol "${url.protocol.slice(0, -1)}" not supported here: the browser makes http and https requests` };
  }
  if (url.protocol === "http:" && page.protocol === "https:") {
    return { code: 1, error: `${url.href} is plain http, which an https page may not fetch — try https://${url.host}${url.pathname}${url.search}` };
  }
  if (url.origin === page.origin || ours.includes(url.origin)) {
    return { code: 7, error: `${url.origin} is the pad's own site, which is not fetched from inside a pad` };
  }
  let authorization: string | null = null;
  if (url.username || url.password) {
    authorization = `Basic ${btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}`;
    url.username = "";
    url.password = "";
  }
  return { url, authorization };
}

/** A request made with fetch, the answer as the sandbox reads it. */
export async function answer(request: FetchRequest, page: URL, ours: readonly string[], local?: LocalFetch | null): Promise<Uint8Array> {
  let url: URL | null = null;
  try {
    url = new URL(request.url);
  } catch {
    // `vet` says so.
  }
  // The page's own address can be a localhost one, as in the checks: refused as ours, below.
  if (url && LOCAL_HOSTS.has(url.hostname) && url.origin !== page.origin && !ours.includes(url.origin)) {
    if (!local) return encodeAnswer({ ok: false, code: 7, error: `Failed to connect to ${url.host}: localhost is the folder's own servers, and this build of the pad has no preview to reach them through` });
    const { answer: answered, body } = await local(request, url);
    return encodeAnswer(answered, body);
  }
  const vetted = vet(request.url, page, ours);
  if ("error" in vetted) return encodeAnswer({ ok: false, code: vetted.code, error: vetted.error });
  const method = request.method.toUpperCase();
  if (request.body && (method === "GET" || method === "HEAD")) {
    return encodeAnswer({ ok: false, code: 3, error: `the browser sends no body with ${method}; use -X POST, or -G to put the data in the URL` });
  }
  const { headers, dropped } = headersFor(request.headers);
  if (vetted.authorization && !headers.has("authorization")) headers.set("authorization", vetted.authorization);
  const signal = request.timeout ? AbortSignal.timeout(request.timeout * 1000) : undefined;
  try {
    const res = await fetch(vetted.url, {
      method,
      headers,
      body: request.body ? (request.body.slice().buffer as ArrayBuffer) : undefined,
      redirect: "follow",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      mode: "cors",
      signal,
    });
    const body = await readCapped(res);
    if (!body) return encodeAnswer({ ok: false, code: 63, error: `Maximum file size exceeded: ${vetted.url.href} is over ${maxBody() / 1048576} MB` });
    return encodeAnswer({
      ok: true,
      status: res.status,
      statusText: res.statusText,
      url: res.url || vetted.url.href,
      redirected: res.redirected,
      headers: [...res.headers],
      dropped,
    }, body);
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError") return encodeAnswer({ ok: false, code: 28, error: `Operation timed out after ${request.timeout} seconds` });
    // The browser says no more than "Failed to fetch" — for a site that does
    // not let pages read it, one that is down, and a name that does not
    // resolve alike. So say what it can be.
    return encodeAnswer({
      ok: false,
      code: 7,
      error: `Failed to fetch ${vetted.url.href}: the browser could not read it. Either the site does not let web pages read it — it sends no CORS headers, as most sites that are not APIs do not — or it could not be reached.`,
    });
  }
}

/** The body, or null when it is over what a pad holds. */
async function readCapped(res: Response): Promise<Uint8Array | null> {
  const said = Number(res.headers.get("content-length") ?? "0");
  if (said > maxBody()) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBody()) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export class FetchBridge {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private looking = false;
  private serving = new Set<string>();

  /**
   * `ours`: origins besides this page's that a pad does not fetch — the
   * preview's. `local`: the way to the folder's own servers, once there is one.
   */
  constructor(
    private readonly box: () => Promise<Sandbox | null>,
    private readonly ours: readonly string[] = [],
    private readonly local: () => LocalFetch | null = () => null,
  ) {}

  /** A command started or finished: look for requests only while one runs. */
  busy(running: boolean): void {
    this.running = running;
    if (running && !this.timer) this.timer = setInterval(() => void this.look(), POLL_MS);
    else if (!running && this.timer && this.serving.size === 0) this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async look(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    try {
      const box = await this.box();
      if (!box) return;
      const names = new Set((await box.fs.readDir(DIR).catch(() => [])).map((e) => e.name));
      for (const name of names) {
        if (this.serving.size >= AT_ONCE) break;
        if (!name.endsWith(".req")) continue;
        const id = name.slice(0, -4);
        if (this.serving.has(id) || names.has(`${id}.claim`)) continue;
        this.serving.add(id);
        void box.fs
          .writeFile(`${DIR}/${id}.claim`, new Uint8Array())
          .then(() => this.serve(box, id))
          .catch(() => {})
          .finally(() => {
            this.serving.delete(id);
            if (!this.running && this.serving.size === 0) this.stop();
          });
      }
    } finally {
      this.looking = false;
    }
  }

  private async serve(box: Sandbox, id: string): Promise<void> {
    let reply: Uint8Array;
    try {
      reply = await answer(decodeRequest(await box.fs.readFile(`${DIR}/${id}.req`)), new URL(location.href), this.ours, this.local());
    } catch (e) {
      reply = encodeAnswer({ ok: false, code: 26, error: `the request could not be read: ${(e as Error).message}` });
    }
    await box.fs.writeFile(`${DIR}/${id}.ans.part`, reply).catch(() => {});
    await box.fs.rename(`${DIR}/${id}.ans.part`, `${DIR}/${id}.ans`).catch(() => {});
  }
}

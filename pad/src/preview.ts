/**
 * The preview: a small browser onto the servers running in the folder.
 *
 * Each port something listens on gets a route on the preview's origin
 * (`ports.expose`), and its service worker (pad/preview/sw.js) is told which
 * port the route reaches. A page is loaded through /.wasmer/go/<session>/<port>/,
 * which puts that server at the origin's root, where it sits as it would at
 * localhost:<port>. A page can then call another server by its address:
 * `fetch("http://localhost:5000/api")` from a frontend on 5173 reaches the
 * folder's 5000. Each tab's cookies are kept by the worker, so a Flask
 * session or a login lasts.
 *
 * Above the page: back, forward, reload, which server, and where in it, plus
 * opening the page in a tab of its own. Below, when asked for: every request
 * the page made, with what went in and what came back, and the page's
 * console. The server's own side of each request is in the terminal running
 * it.
 *
 * All of it belongs to this browser only: the routes are held by a service
 * worker here. See docs/dev/networking.md, "The preview".
 */
import type { BrowserServer, Sandbox } from "@wasmer/sdk";
import type { FetchAnswer, FetchRequest } from "./fetch-bridge";

type Pairs = Array<[string, string]>;
type Shown = { text?: string; cut?: boolean; binary?: boolean } | null;

/** A request the page made, as the worker saw it. */
export interface PreviewRequest {
  guest: number;
  from: number | null;
  method: string;
  path: string;
  status: number;
  ms: number;
  size: number;
  kind: string;
  error?: string;
  blocked?: boolean;
  requestHeaders?: Pairs;
  requestBody?: Shown;
  responseHeaders?: Pairs;
  responseBody?: Shown;
}

interface ConsoleLine {
  level: string;
  text: string;
}

/** A page in the preview's history: which server, and where in it. */
interface Entry {
  guest: number;
  path: string;
}

type Panel = "requests" | "console";

const KEPT = 300;
/** Bodies are the bulk of what is kept, so only the latest requests keep theirs. */
const KEPT_BODIES = 60;
const LINES = 500;
const LOCAL_ADDRESS = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d+))?(\/.*)?$/i;

export class PreviewBrowser {
  /** This tab's, to the worker: its routes, its front server and its cookies are kept apart from another tab's. */
  readonly session = crypto.randomUUID();
  private readonly servers = new Map<number, Promise<BrowserServer>>();
  /** What listens now, in the order it started. */
  private readonly ports: number[] = [];
  private front: number | null = null;
  /** The front server stopped while on screen: it comes back with a reload. */
  private stopped = false;
  /** The last server to start while the preview was not on screen: what it opens on. */
  private startedAway: number | null = null;
  private history: Entry[] = [];
  private at = -1;
  /**
   * The pad loaded a page and it has not arrived yet: when it does it is that
   * entry, wherever a redirect took it, rather than a new one.
   */
  private expecting = false;
  private readonly requests: PreviewRequest[] = [];
  private readonly lines: ConsoleLine[] = [];
  private panel: Panel | null = null;
  private expanded: PreviewRequest | null = null;
  private frame: HTMLIFrameElement | null = null;
  private lostAt = 0;
  /** When each port's route was last made again, so a worker that keeps losing it cannot set this spinning. */
  private readonly reroutedAt = new Map<number, number>();
  /** Routes announced to the worker and not yet confirmed, by the SDK's id for each. */
  private readonly unconfirmed = new Map<string, () => void>();
  /** A terminal's requests to the folder's servers, waiting for their answers. */
  private readonly asked = new Map<string, (message: Record<string, unknown>) => void>();
  private readonly el: {
    back: HTMLButtonElement;
    forward: HTMLButtonElement;
    reload: HTMLButtonElement;
    port: HTMLSelectElement;
    url: HTMLInputElement;
    requests: HTMLButtonElement;
    console: HTMLButtonElement;
    popOut: HTMLButtonElement;
    stage: HTMLElement;
    notice: HTMLElement;
    panel: HTMLElement;
    title: HTMLElement;
    rows: HTMLElement;
  };

  constructor(
    private readonly host: HTMLElement,
    private readonly origin: string,
    private readonly sandbox: () => Promise<Sandbox>,
    private readonly onError: (message: string) => void,
    signal: AbortSignal,
  ) {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") => {
      const element = document.createElement(tag);
      element.className = className;
      if (text) element.textContent = text;
      return element;
    };
    const button = (className: string, label: string, text: string, title = label) => {
      const b = make("button", className, text);
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", label);
      return b;
    };
    const bar = make("div", "preview-browser-bar");
    const back = button("preview-nav preview-back", "Back", "←");
    const forward = button("preview-nav preview-forward", "Forward", "→");
    const reload = button("preview-nav preview-reload", "Reload", "↻");
    const port = make("select", "preview-port");
    port.title = "Which server: every port something in the folder listens on";
    port.setAttribute("aria-label", "Server");
    const url = make("input", "preview-url");
    url.spellcheck = false;
    url.autocomplete = "off";
    url.setAttribute("aria-label", "Address");
    url.title = "A path in this server, such as /about, or another server's address, such as localhost:5000/api";
    const requests = button("preview-panel-toggle preview-requests", "Requests", "Requests", "Every request the page made: what went in and what came back");
    const consoleToggle = button("preview-panel-toggle preview-console", "Console", "Console", "What the page logged, and its errors");
    const popOut = button("preview-nav preview-pop-out", "Open in a new tab", "↗", "Open this page in a tab of its own, for as long as the pad is open");
    bar.append(back, forward, reload, port, url, requests, consoleToggle, popOut);

    const stage = make("div", "preview-stage");
    const notice = make("div", "preview-notice");
    notice.hidden = true;
    notice.setAttribute("role", "status");
    stage.append(notice);

    const panel = make("div", "preview-log");
    panel.hidden = true;
    const head = make("div", "preview-log-head");
    const title = make("span", "preview-log-title");
    const clear = button("preview-log-clear", "Clear", "Clear");
    const close = button("preview-log-close", "Close", "×");
    head.append(title, clear, close);
    const rows = make("div", "preview-log-rows");
    rows.setAttribute("role", "log");
    panel.append(head, rows);
    host.replaceChildren(bar, stage, panel);
    this.el = { back, forward, reload, port, url, requests, console: consoleToggle, popOut, stage, notice, panel, title, rows };

    back.onclick = () => this.traverse(-1);
    forward.onclick = () => this.traverse(1);
    reload.onclick = () => this.reload();
    port.onchange = () => this.show({ guest: Number(port.value), path: "/" });
    url.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.go(url.value);
      } else if (e.key === "Escape") {
        url.value = this.current?.path ?? "";
        url.blur();
      }
    };
    url.onfocus = () => url.select();
    requests.onclick = () => this.toggle("requests");
    consoleToggle.onclick = () => this.toggle("console");
    popOut.onclick = () => {
      const entry = this.current;
      if (entry) window.open(this.address(entry), "_blank", "noopener");
    };
    clear.onclick = () => {
      if (this.panel === "console") this.lines.length = 0;
      else {
        this.requests.length = 0;
        this.expanded = null;
      }
      this.paintPanel();
    };
    close.onclick = () => this.toggle(this.panel!);
    addEventListener("message", (event) => this.hear(event), { signal });
    // Back in view. The browser may have stopped the worker while this tab
    // was away, and with it the route to the page on screen: the worker says
    // so (`pad-preview:unrouted`), and the route is made again. Until
    // 18 October this was also what kept a link clicked here going to this
    // tab's server rather than another tab's; each page now keeps its own.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.isOpen && this.front !== null) {
        this.tell({ type: "pad-preview:front", session: this.session, guest: this.front });
      }
    }, { signal });
    this.paint();
  }

  /** Something started listening. */
  listen(port: number): void {
    if (!this.ports.includes(port)) this.ports.push(port);
    if (!this.isOpen) this.startedAway = port;
    else {
      void this.route(port).then(() => {
        // The first server while the preview was waiting for one, or the one
        // on screen coming back after a restart.
        if (this.front === null) this.show({ guest: port, path: "/" });
        else if (port === this.front && this.stopped) this.reload();
      }, () => {});
    }
    this.paint();
  }

  /**
   * And stopped. Its route stays: the SDK's is to a port, and works again
   * once something listens there. That is how a server restarted with Ctrl-C
   * and Run comes back into the same page.
   */
  unlisten(port: number): void {
    const at = this.ports.indexOf(port);
    if (at >= 0) this.ports.splice(at, 1);
    if (port === this.front) this.stopped = true;
    this.paint();
  }

  /** For the checks: what the preview believes, beside what it shows. */
  state() {
    return { listening: [...this.ports], front: this.front, stopped: this.stopped, history: this.history.map((e) => `${e.guest}${e.path}`), at: this.at, requests: this.requests.length, lines: this.lines.length };
  }

  get listening(): readonly number[] {
    return this.ports;
  }

  get isOpen(): boolean {
    return !this.host.hidden;
  }

  /**
   * On screen. A server started since the preview was last shown is what it
   * opens on: the page that was there again if it is that server restarted,
   * as its new code serves it, or the new server's front page. Otherwise the
   * page stays as it was left, and with nothing listening there, the newest
   * server's front page.
   */
  async open(): Promise<void> {
    this.host.hidden = false;
    await Promise.all(this.ports.map((p) => this.route(p).catch(() => null)));
    const current = this.current;
    const started = this.startedAway;
    this.startedAway = null;
    if (started !== null && this.ports.includes(started)) {
      if (current?.guest === started) return this.load(current);
      return this.show({ guest: started, path: "/" });
    }
    if (current && this.ports.includes(current.guest)) {
      if (!this.frame || this.stopped) return this.load(current);
      this.tell({ type: "pad-preview:front", session: this.session, guest: current.guest });
      return this.paint();
    }
    const newest = this.ports.at(-1);
    if (newest !== undefined) this.show({ guest: newest, path: "/" });
    else this.paint();
  }

  close(): void {
    this.host.hidden = true;
  }

  private get current(): Entry | null {
    return this.history[this.at] ?? null;
  }

  private route(port: number): Promise<BrowserServer> {
    let server = this.servers.get(port);
    if (!server) {
      server = (async () => {
        const sandbox = await this.sandbox();
        const exposed = await sandbox.ports.expose(port, { serviceWorker: this.origin, timeoutMs: 30_000 });
        // The SDK's own id for the route, which its register message carried:
        // from this the worker learns which port, and which tab, it is.
        const serverId = (exposed as unknown as { id: string }).id;
        // Confirmed before anything loads through it, or the first request
        // can reach the worker before the message saying where it goes. Five
        // seconds at most: a worker that never says is shown failing in the
        // page rather than waited on forever.
        await new Promise<void>((resolve) => {
          this.unconfirmed.set(serverId, resolve);
          this.tell({ type: "pad-preview:route", session: this.session, serverId, guest: port });
          setTimeout(resolve, 5000);
        });
        this.unconfirmed.delete(serverId);
        return exposed;
      })();
      this.servers.set(port, server);
      server.catch((e: Error) => {
        this.servers.delete(port);
        this.onError(`preview of port ${port}: ${e.message}`);
      });
    }
    return server;
  }

  /**
   * A request from the sandbox — `curl`, urllib, `requests` — to
   * localhost:PORT: one of the folder's own servers, by the same route the
   * page takes. It is made by the worker rather than by a page, so it is a
   * program's request and not a browser's: no CORS, no cookies but those it
   * sends, every header the server answered with.
   */
  async fetchLocal(request: FetchRequest, url: URL, again = true): Promise<{ answer: FetchAnswer; body?: Uint8Array }> {
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (url.protocol === "https:") {
      return { answer: { ok: false, code: 35, error: `${url.host} speaks plain http here, as a server in the folder does: try http://${url.host}${url.pathname}${url.search}` } };
    }
    if (!this.ports.includes(port)) {
      return { answer: { ok: false, code: 7, error: `Failed to connect to ${url.hostname} port ${port}: nothing in the folder is listening there` } };
    }
    try {
      await this.route(port);
    } catch (e) {
      return { answer: { ok: false, code: 7, error: `Failed to connect to ${url.hostname} port ${port}: ${(e as Error).message}` } };
    }
    const id = crypto.randomUUID();
    const seconds = request.timeout ?? 300;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.asked.delete(id);
        resolve({ answer: { ok: false, code: 28, error: `Operation timed out after ${seconds} seconds` } });
      }, seconds * 1000 + 1000);
      this.asked.set(id, (m) => {
        clearTimeout(timer);
        this.asked.delete(id);
        // The worker lost the route: made again, and asked once more.
        if (!m.ok && m.unrouted === port && again && this.ports.includes(port)) {
          return void this.reroute(port).then(() => resolve(this.fetchLocal(request, url, false)), () => resolve(this.fetchLocal(request, url, false)));
        }
        if (!m.ok) return resolve({ answer: { ok: false, code: Number(m.code ?? 52), error: String(m.error ?? "the server sent nothing back") } });
        resolve({
          answer: {
            ok: true,
            status: Number(m.status),
            statusText: String(m.statusText ?? ""),
            url: String(m.url),
            redirected: Boolean(m.redirected),
            headers: (m.headers as Array<[string, string]>) ?? [],
            dropped: [],
          },
          body: m.body instanceof Uint8Array ? m.body : new Uint8Array(),
        });
      });
      this.tell({ type: "pad-preview:fetch", session: this.session, id, url: url.href, method: request.method.toUpperCase(), headers: request.headers, body: request.body, timeout: seconds, follow: request.follow });
    });
  }

  /** A new page: into the history, then loaded. */
  private show(entry: Entry): void {
    this.history = this.history.slice(0, this.at + 1);
    this.history.push(entry);
    this.at = this.history.length - 1;
    this.load(entry);
  }

  private reload(): void {
    const entry = this.current;
    if (entry) this.load(entry);
  }

  /** What was typed into the address bar: a path in this server, or another server's address. */
  private go(typed: string): void {
    const text = typed.trim();
    if (!text) return;
    const address = LOCAL_ADDRESS.exec(text);
    if (!address && /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      this.onError("the preview shows the folder's own servers, at localhost; another site opens in a tab of its own");
      return;
    }
    if (address) {
      const guest = Number(address[1] ?? 80);
      if (!this.ports.includes(guest) && !this.servers.has(guest)) {
        this.onError(`nothing in the folder listens on port ${guest}`);
        return;
      }
      this.show({ guest, path: address[2] ?? "/" });
    } else if (this.front !== null) {
      this.show({ guest: this.front, path: text.startsWith("/") ? text : `/${text}` });
    }
    this.el.url.blur();
  }

  private traverse(step: number): void {
    const to = this.at + step;
    if (to < 0 || to >= this.history.length) return;
    this.at = to;
    this.load(this.history[to]!);
  }

  private address(entry: Entry): string {
    return new URL(`/.wasmer/go/${this.session}/${entry.guest}${entry.path}`, this.origin).href;
  }

  /**
   * The page, through the worker's /.wasmer/go/, which puts its server in
   * front for this tab and redirects to the path. The first load sets the
   * frame's src; later ones replace its location, so the preview's own
   * history is what Back and Forward walk, and the pad's tab gains no entry
   * for each.
   */
  private load(entry: Entry): void {
    this.expecting = true;
    void this.route(entry.guest).catch(() => null).then(() => {
      this.front = entry.guest;
      this.stopped = !this.ports.includes(entry.guest);
      const href = this.address(entry);
      if (!this.frame) {
        const frame = document.createElement("iframe");
        frame.title = "The page the server sent";
        frame.className = "preview-frame";
        for (const capability of ["allow-downloads", "allow-forms", "allow-modals", "allow-popups", "allow-same-origin", "allow-scripts"]) frame.sandbox.add(capability);
        frame.src = href;
        this.el.stage.prepend(frame);
        this.frame = frame;
      } else {
        this.frame.contentWindow?.location.replace(href);
      }
      this.paint();
    });
    this.paint();
  }

  /** The SDK's control page for the preview's origin, which carries messages to and from its worker. */
  private get control(): Window | null {
    return document.querySelector<HTMLIFrameElement>(`iframe[src^="${this.origin}/.wasmer/host.html"]`)?.contentWindow ?? null;
  }

  private tell(message: object): void {
    this.control?.postMessage(message, this.origin);
  }

  /** What the worker says through the control page, and what the page says itself. */
  private hear(event: MessageEvent): void {
    if (event.origin !== this.origin) return;
    const message = event.data as { type?: unknown } & Record<string, unknown>;
    if (!message || typeof message.type !== "string") return;
    const fromPage = this.frame !== null && event.source === this.frame.contentWindow;
    if (message.type.startsWith("pad-preview:")) {
      // The worker's, and only through the control page. The page in the
      // frame is of the same origin and knows this session's id, and could
      // otherwise answer a terminal's request, confirm a route or write the
      // request log itself (audit DC-11, 18 October).
      const control = this.control;
      if (!control || event.source !== control || message.session !== this.session) return;
      if (message.type === "pad-preview:routed") this.unconfirmed.get(String(message.serverId))?.();
      else if (message.type === "pad-preview:fetched") this.asked.get(String(message.id))?.(message);
      else if (message.type === "pad-preview:unrouted") void this.unrouted(Number(message.guest));
      else if (message.type === "pad-preview:navigate") this.arrived(Number(message.guest), String(message.path));
      else if (message.type === "pad-preview:request") this.logged(message as unknown as PreviewRequest);
    } else if (fromPage && message.type === "pad-page:location" && this.front !== null) {
      // history.pushState and the like: the same document, somewhere else in it.
      const entry = { guest: this.front, path: String(message.path) };
      if (message.how === "push") {
        this.history = this.history.slice(0, this.at + 1);
        this.history.push(entry);
        this.at = this.history.length - 1;
      } else if (this.current) {
        this.history[this.at] = entry;
      }
      this.paint();
    } else if (fromPage && message.type === "pad-page:console") {
      this.lines.push({ level: String(message.level), text: String(message.text) });
      if (this.lines.length > LINES) this.lines.splice(0, this.lines.length - LINES);
      this.paintToggles();
      if (this.panel === "console") this.paintPanel();
    } else if (fromPage && message.type === "pad-page:lost") {
      void this.reconnect();
    }
  }

  /**
   * A page arrived in the frame, after any redirects: where the preview now
   * is. What the pad loaded replaces its own entry; a link followed or a form
   * sent in the page is a new one.
   */
  private arrived(guest: number, path: string): void {
    const entry = { guest, path };
    const current = this.current;
    if (current && (this.expecting || (current.guest === guest && current.path === path))) {
      this.history[this.at] = entry;
    } else {
      this.history = this.history.slice(0, this.at + 1);
      this.history.push(entry);
      this.at = this.history.length - 1;
    }
    this.expecting = false;
    this.front = guest;
    this.stopped = !this.ports.includes(guest);
    // Where each page begins in the console; one with nothing logged under it is replaced by the next.
    if (this.lines.at(-1)?.level === "page") this.lines.pop();
    this.lines.push({ level: "page", text: `localhost:${guest}${path}` });
    this.paint();
  }

  private logged(request: PreviewRequest): void {
    this.requests.unshift(request);
    if (this.requests.length > KEPT) this.requests.length = KEPT;
    const old = this.requests[KEPT_BODIES];
    if (old && old !== this.expanded) {
      delete old.requestBody;
      delete old.responseBody;
    }
    this.paintToggles();
    if (this.panel === "requests") this.paintPanel();
  }

  /**
   * The worker has no route to a port that is listening: it was stopped and
   * started again since the route was made. The route is made again, and the
   * page reloaded if it was that server's.
   */
  private async unrouted(port: number): Promise<void> {
    if (!this.ports.includes(port)) return;
    if (Date.now() - (this.reroutedAt.get(port) ?? 0) < 10_000) return;
    await this.reroute(port).catch(() => null);
    if (port === this.front) this.reload();
  }

  private reroute(port: number): Promise<BrowserServer> {
    this.reroutedAt.set(port, Date.now());
    const old = this.servers.get(port);
    this.servers.delete(port);
    void old?.then((s) => s.close()).catch(() => {});
    return this.route(port);
  }

  /**
   * The worker lost every route: the browser stopped it and started it again.
   * They are made again and the page reloaded, at most once in ten seconds,
   * so a worker that keeps failing cannot set this spinning.
   */
  private async reconnect(): Promise<void> {
    if (Date.now() - this.lostAt < 10_000) return;
    this.lostAt = Date.now();
    const old = [...this.servers.values()];
    this.servers.clear();
    for (const server of old) void server.then((s) => s.close()).catch(() => {});
    const ports = new Set([...this.ports, ...(this.front !== null ? [this.front] : [])]);
    await Promise.all([...ports].map((p) => this.route(p).catch(() => null)));
    this.reload();
  }

  private toggle(panel: Panel): void {
    this.panel = this.panel === panel ? null : panel;
    this.paintPanel();
  }

  private paint(): void {
    const { port, url, back, forward, reload, popOut, notice } = this.el;
    const shown = [...this.ports];
    if (this.front !== null && !shown.includes(this.front)) shown.push(this.front);
    shown.sort((a, b) => a - b);
    port.replaceChildren(...shown.map((p) => {
      const option = document.createElement("option");
      option.value = String(p);
      option.textContent = this.ports.includes(p) ? `localhost:${p}` : `localhost:${p} (stopped)`;
      option.selected = p === this.front;
      return option;
    }));
    port.disabled = shown.length === 0;
    if (document.activeElement !== url) url.value = this.current?.path ?? "";
    back.disabled = this.at <= 0;
    forward.disabled = this.at >= this.history.length - 1;
    reload.disabled = this.current === null;
    popOut.disabled = this.current === null;
    if (this.front !== null && this.stopped) {
      notice.textContent = `The server on port ${this.front} stopped. Start it again and this page reloads.`;
      notice.hidden = false;
    } else if (this.front === null) {
      notice.textContent = "Nothing in the folder is listening yet. Start a server in the terminal and it shows here.";
      notice.hidden = false;
    } else {
      notice.hidden = true;
    }
    this.paintToggles();
    this.paintPanel();
  }

  private paintToggles(): void {
    const { requests, console: consoleToggle } = this.el;
    const failed = this.requests.filter((r) => r.status === 0 || r.status >= 400 || r.blocked).length;
    requests.textContent = this.requests.length ? `Requests ${this.requests.length}` : "Requests";
    if (failed) requests.append(Object.assign(document.createElement("b"), { textContent: ` · ${failed} failed` }));
    requests.classList.toggle("failing", failed > 0);
    requests.setAttribute("aria-pressed", String(this.panel === "requests"));
    const errors = this.lines.filter((l) => l.level === "error").length;
    const said = this.lines.filter((l) => l.level !== "page").length;
    consoleToggle.textContent = said ? `Console ${said}` : "Console";
    if (errors) consoleToggle.append(Object.assign(document.createElement("b"), { textContent: ` · ${errors} ${errors === 1 ? "error" : "errors"}` }));
    consoleToggle.classList.toggle("failing", errors > 0);
    consoleToggle.setAttribute("aria-pressed", String(this.panel === "console"));
  }

  private paintPanel(): void {
    const { panel, title, rows } = this.el;
    panel.hidden = this.panel === null;
    if (this.panel === null) return;
    title.textContent = this.panel === "requests" ? "Requests, newest first" : "Console";
    if (this.panel === "console") {
      rows.replaceChildren(...this.lines.map((line) => {
        const row = document.createElement("div");
        row.className = `preview-console-line ${line.level}`;
        row.textContent = line.level === "page" ? `── ${line.text}` : line.text;
        return row;
      }));
      if (!this.lines.some((l) => l.level !== "page")) rows.replaceChildren(empty("Nothing logged yet. What the page writes with console.log shows here, with its errors."));
      rows.scrollTop = rows.scrollHeight;
      return;
    }
    if (!this.requests.length) {
      rows.replaceChildren(empty("No requests yet. Each one the page makes shows here: what it sent, and what the server sent back."));
      return;
    }
    rows.replaceChildren(...this.requests.flatMap((r) => {
      const row = document.createElement("button");
      row.type = "button";
      const band = r.blocked || r.status === 0 ? "bad" : r.status >= 500 ? "bad" : r.status >= 400 ? "warn" : r.status >= 300 ? "move" : "ok";
      row.className = `preview-log-row ${band}${r === this.expanded ? " open" : ""}`;
      row.setAttribute("aria-expanded", String(r === this.expanded));
      const cell = (text: string, cls: string, cellTitle = "") => {
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = text;
        if (cellTitle) span.title = cellTitle;
        return span;
      };
      // A terminal's request names its server whichever is in front: it did not come from the page.
      const where = r.guest === this.front && r.kind !== "terminal" ? r.path : `localhost:${r.guest}${r.path}`;
      const status = r.blocked ? "CORS" : r.status === 0 ? "failed" : String(r.status);
      row.append(
        cell(r.method, "m"),
        cell(where, "p", where),
        cell(status, "s", r.error ?? ""),
        cell(r.kind, "k"),
        cell(`${r.ms} ms`, "t"),
        cell(size(r.size), "z"),
      );
      row.onclick = () => {
        this.expanded = this.expanded === r ? null : r;
        this.paintPanel();
      };
      return r === this.expanded ? [row, details(r)] : [row];
    }));
  }
}

function empty(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "preview-log-empty";
  p.textContent = text;
  return p;
}

/** One request opened up: what went to the server and what it answered. */
function details(r: PreviewRequest): HTMLElement {
  const box = document.createElement("div");
  box.className = "preview-log-detail";
  const section = (heading: string, body: string) => {
    const h = document.createElement("h4");
    h.textContent = heading;
    const pre = document.createElement("pre");
    pre.textContent = body;
    box.append(h, pre);
  };
  const headers = (pairs?: Pairs) => (pairs?.length ? pairs.map(([n, v]) => `${n}: ${v}`).join("\n") : "(none)");
  const body = (shown?: Shown) => {
    if (!shown) return null;
    if (shown.binary) return "(binary)";
    return `${shown.text ?? ""}${shown.cut ? "\n… (cut short here)" : ""}`;
  };
  if (r.error) section(r.blocked ? "Blocked" : "Failed", r.error);
  section("Request", `${r.method} http://localhost:${r.guest}${r.path}\n${headers(r.requestHeaders)}`);
  const sent = body(r.requestBody);
  if (sent !== null) section("Request body", sent);
  if (r.responseHeaders) section(`Response · ${r.status}`, headers(r.responseHeaders));
  const answered = body(r.responseBody);
  if (answered !== null) section("Response body", answered);
  else if (r.responseHeaders && r.size === 0) section("Response body", "(empty)");
  else if (r.responseHeaders) section("Response body", "(not kept: only the latest requests keep their bodies)");
  return box;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

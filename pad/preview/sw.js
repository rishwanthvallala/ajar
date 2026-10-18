/*
 * The preview's service worker, at preview.rishwanth.dev/wasmer-service-worker.js.
 *
 * In place of @wasmer/sdk's own (dist/service-worker.js). It speaks the same
 * messages to the same client, which forwards each request into the sandbox
 * (`ports.expose`). The SDK's worker routes one server at the root and does
 * nothing else. This one adds:
 *
 *   - several servers at once, one route per port. A pad loads a page through
 *     /.wasmer/go/<session>/<port>/<path>, which puts that port in front and
 *     redirects to the path, so the page sits at the origin's root as it would
 *     at http://localhost:<port>/. A request it makes to
 *     http://localhost:PORT, such as a frontend on one port calling an API on
 *     another, goes to the sandbox's PORT, and the browser's CORS rule for
 *     that request is applied here.
 *   - one browser tab, one session. Each pad tab's routes, front port and
 *     cookies are kept apart from another tab's, even when both run something
 *     on port 5000. A page, and every page it goes on to, stays its own tab's.
 *   - cookies. A Response the worker builds itself cannot set one, so a Flask
 *     session, a login or a flash message never outlived its request. Each
 *     session's cookies are kept here: taken from Set-Cookie, sent back as
 *     Cookie, and shared by host rather than by port, as a browser does on
 *     localhost.
 *   - what the preview does, told to the pad: each page it loads, for the
 *     address bar, and each request with what went in and came out, for the
 *     request log. Sent through the control page (/.wasmer/host.html), the one
 *     window here the pad can reach, and the only one this worker takes an
 *     instruction from. A small script added to each HTML page
 *     (`agent` below) reports what only the page knows: its console, its
 *     errors, and history.pushState.
 *
 * Nothing of the pad's is reachable from here, and nothing here is reachable
 * from the pad. This origin exists so that what a folder serves cannot script
 * the pad. See docs/dev/networking.md, "The preview".
 */
const scope = globalThis;
const REQUEST_TIMEOUT_MS = 300_000;
const LOCAL = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
const AGENT = "/.wasmer/page.js";
const GO = /^\/\.wasmer\/go\/([\w-]{1,64})\/(\d{1,5})(\/.*)?$/;
const CONTROL = "/.wasmer/host.html";
/** Said in place of a page no one session can be shown to own. */
const UNOWNED = "Which pad's preview this page belongs to could not be told, with more than one open here, so it was not loaded. Open it again from the pad.";
/** How much of a body the request log is shown. */
const SHOWN = { request: 8 * 1024, response: 32 * 1024 };

/** Routes by the SDK's server id: { id, port: MessagePort, pending, session, guest, owner: client id of the control page that made it } */
const routes = new Map();
/** Route ids announced before the route itself arrived: the two come by different paths. */
const early = new Map();
/**
 * Each pad tab's preview, by the id it chose:
 * { id, control: client id of its control page, padOrigin, guests: Map<port, route id>, front, jar }
 */
const sessions = new Map();
/**
 * The session and port each document came from, by client id: its requests,
 * and the navigations that replace it, go back to them.
 */
const documents = new Map();
/**
 * A navigation part way through its redirects, by the client id it will
 * have: { session, guest, at }. Its first step said whose it is — a pad's
 * load through /.wasmer/go/, or a page of that session's — and the browser
 * keeps that id through every redirect on this origin, so the rest follow.
 */
const navigating = new Map();

scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
scope.addEventListener("activate", (event) => event.waitUntil(scope.clients.claim()));

scope.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  // Every message here is a pad's, through its control page
  // (preview/relay.js, beside the SDK's own script). A page in the preview
  // has nothing to tell this worker: what it reports goes to the pad itself.
  const control = event.source;
  if (!isControlPage(control)) return;
  if (message.type === "wasmer-sdk:http-register") {
    const port = event.ports[0];
    if (!port || typeof message.serverId !== "string") return;
    // Never another control page's route under the same id.
    const existing = routes.get(message.serverId);
    if (existing && existing.owner !== control.id) return;
    const route = { id: message.serverId, port, pending: new Map(), session: null, guest: null, owner: control.id };
    routes.set(route.id, route);
    port.addEventListener("message", (e) => receive(route, e.data));
    port.start();
    port.postMessage({ type: "wasmer-sdk:http-ready", serverId: route.id });
    const announced = early.get(route.id);
    if (announced) {
      early.delete(route.id);
      if (announced.session.control === control.id) attach(route, announced.session, announced.guest);
    }
    return;
  }
  if (typeof message.session !== "string" || !/^[\w-]{1,64}$/.test(message.session)) return;
  const session = sessionFor(message.session, control.id, message.padOrigin);
  if (!session) return;
  if (message.type === "pad-preview:route") {
    if (typeof message.serverId !== "string" || !validPort(message.guest)) return;
    const route = routes.get(message.serverId);
    // A route this tab's own control page made, and no other's.
    if (route && route.owner === control.id) attach(route, session, message.guest);
    else if (!route) early.set(message.serverId, { session, guest: message.guest });
  } else if (message.type === "pad-preview:front") {
    // The tab is back in view. Until 18 October this also made it the
    // session a navigation went to when nothing said whose it was, which let
    // one pad's frame load another's server (audit DC-10); now each page
    // keeps its own. What is left is the worker that the browser stopped
    // while the tab was away: it has no route to the page on screen, whose
    // own requests then fail without a word. Told so, the pad makes the route
    // again and reloads the page.
    if (!validPort(message.guest)) return;
    session.front = message.guest;
    if (!session.guests.has(message.guest)) tell(session, { type: "pad-preview:unrouted", session: session.id, guest: message.guest });
  } else if (message.type === "pad-preview:fetch" && typeof message.id === "string") {
    event.waitUntil(fetchFor(session, message));
  }
  // And "pad-preview:ping", which is only to keep this worker from being stopped.
});

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value < 65_536;
}

/**
 * A pad's control page: /.wasmer/host.html, framed by the pad. Until
 * 18 October any window here was taken for one (audit DC-11). Every page the
 * preview shows is of this origin too, and its script tag tells it its own
 * session's id, so a page could send `pad-preview:front` for that session and
 * become where the worker sent the session's every request and answer,
 * instead of the pad. A Client's url is where the document was made, which
 * history.replaceState does not move, and a page this worker served is never
 * a control page, whatever it calls itself.
 */
function isControlPage(client) {
  if (!client || client.type !== "window" || client.frameType !== "nested" || documents.has(client.id)) return false;
  try {
    return new URL(client.url).pathname === CONTROL;
  } catch {
    return false;
  }
}

/**
 * The session `id`, made for this control page if it is new. It stays that
 * page's: another sending for it is refused, rather than becoming where the
 * session's reports go (audit DC-11, 18 October). A pad sends nothing for its
 * session before its control page is connected, and the SDK keeps that page
 * for as long as the tab is open.
 */
function sessionFor(id, control, padOrigin) {
  const known = sessions.get(id);
  if (known) return known.control === control ? known : null;
  // The origin each page's frame-ancestors and script name. A pad is never on
  // this one: a control page framed by a page here belongs to that page.
  if (typeof padOrigin !== "string" || !/^https?:\/\/[^/]+$/.test(padOrigin) || padOrigin === scope.location.origin) return null;
  const session = { id, control, padOrigin, guests: new Map(), front: null, jar: new Map() };
  sessions.set(id, session);
  void forgetClosedTabs();
  return session;
}

/**
 * The route is this session's way to `guest`, and the pad is told so. It loads
 * nothing before it hears this, because its message and the frame's first
 * request come by different paths and the request could arrive first.
 */
function attach(route, session, guest) {
  route.session = session.id;
  route.guest = guest;
  session.guests.set(guest, route.id);
  tell(session, { type: "pad-preview:routed", session: session.id, serverId: route.id, guest });
}

/** A tab that closed leaves its session behind; on the next new one, the sessions whose control page is gone go. */
async function forgetClosedTabs() {
  const open = new Set((await scope.clients.matchAll({ type: "window", includeUncontrolled: true })).map((c) => c.id));
  for (const session of sessions.values()) {
    if (!session.control || open.has(session.control)) continue;
    sessions.delete(session.id);
    for (const id of session.guests.values()) {
      const route = routes.get(id);
      if (route) close(route);
    }
  }
  for (const id of documents.keys()) if (!open.has(id)) documents.delete(id);
}

// ------------------------------------------------------------------ requests

scope.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const navigation = request.mode === "navigate";
  if (url.origin === scope.location.origin) {
    if (url.pathname === AGENT) return event.respondWith(agentScript());
    const go = GO.exec(url.pathname);
    if (go && navigation) return event.respondWith(goTo(event, go[1], Number(go[2]), (go[3] ?? "/") + url.search));
    // The control page and its scripts, from the network.
    if (url.pathname.startsWith("/.wasmer/") || url.pathname === "/pad-preview.js" || url.pathname === "/wasmer-host.js") return;
    if (navigation) return event.respondWith(navigate(event, url));
    const from = documents.get(event.clientId);
    const session = sessions.get(from?.session);
    if (!session) return event.respondWith(Response.error());
    // A worker the page starts is a client of its own, and asks as the page would.
    if (event.resultingClientId) documents.set(event.resultingClientId, from);
    return event.respondWith(forward({ event, session, guest: from.guest, url, from: from.guest, navigation }));
  }
  // http://localhost:PORT, from a page here, is the sandbox's PORT and never
  // this computer's: the folder is what the page was written against.
  if (!LOCAL.has(url.hostname)) return;
  const from = documents.get(event.clientId);
  const session = sessions.get(from?.session);
  if (!session) return event.respondWith(Response.error());
  const guest = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  event.respondWith(forward({ event, session, guest, url, from: from.guest, navigation }));
});

/**
 * A pad's load: this port in front for this session, then the path, at the
 * root. The redirect that follows is this navigation's next step, under the
 * same client id, and goes where this one said.
 */
function goTo(event, id, guest, path) {
  const session = sessions.get(id);
  if (!session) return lost();
  // A frame showing another session's page, or a navigation another
  // session's server redirected here, stays out: a page or a server would
  // need only this session's id to load its pages and read them (audit
  // DC-10, 18 October).
  const before = [documents.get(event.clientId), navigating.get(event.resultingClientId)];
  if (before.some((owner) => owner && owner.session !== id)) return lost(UNOWNED);
  session.front = guest;
  onTheWay(event, session, guest);
  // Only ever a path here: `//elsewhere` would make this an open redirect.
  const target = new URL(path, scope.location.origin);
  const location = target.origin === scope.location.origin ? target.pathname + target.search : "/";
  return new Response(null, { status: 302, headers: isolated({ location, "cache-control": "no-store" }) });
}

/**
 * Any other navigation here: a link clicked or a form sent in a page, a
 * page's redirect, a reload, Back. It goes to the session and server of the
 * page it replaces, or of the step before it.
 *
 * Until 18 October it went to whichever session had last loaded a page or
 * come back into view (audit DC-10). With two pads' previews open, or a page
 * popped out of one, a link clicked in one could load the other's server
 * into it, and a form could be sent there. Now nothing is guessed: what
 * cannot be shown to be one session's is refused.
 */
async function navigate(event, url) {
  // Chrome names, as the navigation's client, the document in the frame it
  // replaces. A frame or window just made has none, and so do pages the
  // worker served before the browser stopped it.
  const owner = navigating.get(event.resultingClientId) ?? documents.get(event.clientId) ?? (await soleOwner());
  const session = sessions.get(owner?.session);
  if (!session) return lost(owner || !sessions.size ? undefined : UNOWNED);
  return forward({ event, session, guest: owner.guest, url, from: owner.guest, navigation: true });
}

/**
 * The owner of a navigation that names none, when there can only be one: an
 * iframe a page adds, a link with target=_blank. Chrome does not say which
 * page made the frame, but if everything of this origin open in the browser
 * is one pad's — its control page, and pages this worker served it — that
 * pad's page did. Otherwise, with two pads open, or a page here this worker
 * does not know, it is refused.
 */
async function soleOwner() {
  const open = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  const controls = open.filter(isControlPage);
  if (controls.length !== 1) return null;
  const owners = new Set(open.filter((c) => c.id !== controls[0].id).map((c) => documents.get(c.id)?.session));
  const session = owners.size === 1 ? sessions.get([...owners][0]) : null;
  return session && session.control === controls[0].id ? { session: session.id, guest: session.front } : null;
}

/** A navigation redirected, or about to be: its next step is this session's, on this port. */
function onTheWay(event, session, guest) {
  if (!event.resultingClientId) return;
  const now = Date.now();
  for (const [id, step] of navigating) if (now - step.at > 60_000) navigating.delete(id);
  navigating.set(event.resultingClientId, { session: session.id, guest, at: now });
}

/** And where it ended: the document it makes is this session's, from this port. */
function arrived(event, session, guest) {
  if (!event.resultingClientId) return;
  navigating.delete(event.resultingClientId);
  documents.set(event.resultingClientId, { session: session.id, guest });
}

/**
 * One request, to the sandbox and back.
 *
 * `from` is the port of the page that made it, and decides what a browser
 * would: whether this is the page's own origin, which cookies go with it, and
 * whether CORS applies. A page served from 5173 that asks 5000 is
 * cross-origin, exactly as at localhost.
 */
async function forward({ event, session, guest, url, from, navigation }) {
  const request = event.request;
  const started = Date.now();
  const path = url.pathname + url.search;
  const sameOrigin = guest === from;
  const page = navigation && request.destination === "iframe";
  const kind = navigation ? "page" : request.destination || "fetch";
  const base = { type: "pad-preview:request", session: session.id, guest, from, method: request.method, path, kind };
  const route = routes.get(session.guests.get(guest));
  if (!route) {
    const error = `nothing in the folder listens on port ${guest}`;
    tell(session, { ...base, status: 0, ms: 0, size: 0, error });
    // If the pad thinks otherwise, this worker lost the route — stopped by
    // the browser and started again — and the pad makes it again.
    tell(session, { type: "pad-preview:unrouted", session: session.id, guest });
    if (!navigation) return Response.error();
    arrived(event, session, guest);
    return notice(session, guest, path, page, 502, `Nothing is listening on port ${guest}`, "Start the server in the terminal and the preview reloads when it is up.");
  }
  const credentials = request.credentials === "include" || (request.credentials === "same-origin" && sameOrigin);
  const body = new Uint8Array(await request.arrayBuffer());
  const headers = outgoing(request, session, guest, from, url, sameOrigin, credentials);
  const shownRequest = shown(body, headers, SHOWN.request);
  let message;
  try {
    message = await ask(route, request.method, path, headers, body, REQUEST_TIMEOUT_MS);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    tell(session, { ...base, status: 0, ms: Date.now() - started, size: 0, error: text, requestHeaders: headers, requestBody: shownRequest });
    if (!navigation) return Response.error();
    arrived(event, session, guest);
    return notice(session, guest, path, page, 502, `The server on port ${guest} did not answer`, text);
  }
  const status = message.status ?? 502;
  const pairs = message.headers ?? [];
  if (credentials) keepCookies(session.jar, pairs, url.pathname);
  let bytes = message.body ? Uint8Array.from(message.body) : new Uint8Array(0);
  const detail = {
    ...base,
    status,
    ms: Date.now() - started,
    size: bytes.byteLength,
    requestHeaders: headers,
    requestBody: shownRequest,
    responseHeaders: pairs,
    responseBody: shown(bytes, pairs, SHOWN.response),
  };
  if (!sameOrigin && request.mode === "cors") {
    const refused = corsRefusal(request, pairs, guest, from);
    if (refused) {
      tell(session, { ...detail, error: refused, blocked: true });
      return Response.error();
    }
  }
  const out = new Headers();
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || lower === "content-length") continue;
    if (lower === "location" && navigation) out.append(name, inPreview(value, session, guest));
    else out.append(name, value);
  }
  const redirect = status >= 300 && status < 400 && out.has("location");
  const html = /^text\/html\b/i.test(out.get("content-type") ?? "") && !out.has("content-encoding");
  if (navigation && redirect) onTheWay(event, session, guest);
  if (navigation && !redirect) {
    arrived(event, session, guest);
    if (html) bytes = withAgent(bytes, session);
    // The pad's frame, and only after the last redirect: that is where it ended up.
    if (page) tell(session, { type: "pad-preview:navigate", session: session.id, guest, path });
    if (session.padOrigin) out.append("content-security-policy", `frame-ancestors 'self' ${session.padOrigin}`);
  }
  tell(session, detail);
  const bodyAllowed = status >= 200 && status !== 204 && status !== 205 && status !== 304;
  return new Response(bodyAllowed ? bytes : null, { status, statusText: message.statusText, headers: isolated(out) });
}

/** One request down a route, and the server's answer: status, headers as pairs, body. */
function ask(route, method, path, headers, body, timeoutMs) {
  const requestId = crypto.randomUUID();
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      route.pending.delete(requestId);
      reject(new Error(`the server on port ${route.guest} did not answer in ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    route.pending.set(requestId, { resolve, reject, timer });
  });
  route.port.postMessage({ type: "wasmer-sdk:http-request", serverId: route.id, requestId, method, path, headers, body }, [body.buffer]);
  return answer;
}

/**
 * A terminal's request to one of the folder's servers — `curl
 * localhost:5000` beside the Flask app — made here and answered to the pad
 * whole: the status, every header (Set-Cookie among them, which no page may
 * read) and the body. It is a program's request, not a page's: no CORS, no
 * cookies but its own, no Origin. A redirect is followed only when asked —
 * `curl -L`; urllib and requests follow them themselves — and only to the
 * folder's servers: one to anywhere else is answered as it is.
 */
async function fetchFor(session, message) {
  const answer = (reply) => tell(session, { type: "pad-preview:fetched", session: session.id, id: message.id, ...reply });
  let url;
  try {
    url = new URL(message.url);
  } catch {
    return answer({ ok: false, code: 3, error: `URL rejected: ${message.url}` });
  }
  let method = typeof message.method === "string" ? message.method : "GET";
  let body = message.body instanceof Uint8Array ? message.body : new Uint8Array(0);
  let headers = (Array.isArray(message.headers) ? message.headers : [])
    .filter((pair) => Array.isArray(pair) && typeof pair[0] === "string" && pair[0].toLowerCase() !== "host")
    .map(([name, value]) => [name, String(value)]);
  const deadline = Date.now() + (Number(message.timeout) > 0 ? Number(message.timeout) : 300) * 1000;
  for (let hops = 0; ; hops++) {
    const guest = Number(url.port || 80);
    const path = url.pathname + url.search;
    const route = routes.get(session.guests.get(guest));
    if (!route) return answer({ ok: false, code: 7, unrouted: guest, error: `Failed to connect to ${url.hostname} port ${guest}: nothing in the folder is listening there` });
    const sent = [...headers, ["host", `localhost:${guest}`]];
    const base = { type: "pad-preview:request", session: session.id, guest, from: null, method, path, kind: "terminal", requestHeaders: sent, requestBody: shown(body, sent, SHOWN.request) };
    const started = Date.now();
    let reply;
    try {
      reply = await ask(route, method, path, sent, body.slice(), Math.max(1000, deadline - Date.now()));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      tell(session, { ...base, status: 0, ms: Date.now() - started, size: 0, error: text });
      return answer({ ok: false, code: 52, error: `Empty reply from server: ${text}` });
    }
    const status = reply.status ?? 502;
    const pairs = reply.headers ?? [];
    const bytes = reply.body ? Uint8Array.from(reply.body) : new Uint8Array(0);
    tell(session, { ...base, status, ms: Date.now() - started, size: bytes.byteLength, responseHeaders: pairs, responseBody: shown(bytes, pairs, SHOWN.response) });
    const location = pairs.find(([name]) => name.toLowerCase() === "location")?.[1];
    if (message.follow && status >= 300 && status < 400 && location && hops < 10) {
      const next = new URL(location, url);
      if (next.protocol === "http:" && LOCAL.has(next.hostname)) {
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
          method = "GET";
          body = new Uint8Array(0);
          headers = headers.filter(([name]) => !/^content-(type|length)$/i.test(name));
        }
        url = next;
        continue;
      }
    }
    return answer({ ok: true, status, statusText: reply.statusText ?? "", url: url.href, redirected: hops > 0, headers: pairs, body: bytes });
  }
}

/**
 * What goes to the server: the page's headers, and what a browser at
 * localhost would have added that this one cannot — the cookies, and an
 * Origin and Referer naming localhost rather than this origin. A server that
 * checks them, as Django's CSRF protection does, sees what it would see in
 * development.
 */
function outgoing(request, session, guest, from, url, sameOrigin, credentials) {
  const headers = [];
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (lower === "cookie" || lower === "origin" || lower === "referer" || lower === "host") continue;
    headers.push([name, value]);
  }
  // A worker never sees the Origin header the browser would add, so it is
  // added here where a browser adds it: to a request across origins that
  // CORS governs, and to any that is not a GET or HEAD.
  const origin = `http://localhost:${from ?? guest}`;
  if ((!sameOrigin && request.mode === "cors") || (request.method !== "GET" && request.method !== "HEAD")) headers.push(["origin", origin]);
  if (request.referrer && request.referrer !== "about:client") {
    try {
      const referrer = new URL(request.referrer);
      if (referrer.origin === scope.location.origin) headers.push(["referer", sameOrigin ? `${origin}${referrer.pathname}${referrer.search}` : `${origin}/`]);
    } catch {
      // Not a URL: none sent.
    }
  }
  // The SDK's own is `localhost`, without the port a browser would name, and
  // a URL the server builds for itself — Flask's url_for(_external=True) —
  // would point at port 80.
  headers.push(["host", `localhost:${guest}`]);
  if (credentials) {
    const cookie = cookieFor(session.jar, url.pathname);
    if (cookie) headers.push(["cookie", cookie]);
  }
  return headers;
}

/**
 * The browser's own rule for a page reading another origin, which a response
 * built here would otherwise skip — and a frontend that worked in the preview
 * and then failed in a browser would be worse than one that fails here,
 * saying why. Preflight requests are not made: what the actual response
 * allows is checked.
 */
function corsRefusal(request, pairs, guest, from) {
  const header = (name) => pairs.find(([n]) => n.toLowerCase() === name)?.[1];
  const origin = `http://localhost:${from}`;
  const allowed = header("access-control-allow-origin");
  const to = `localhost:${guest}`;
  if (!allowed) return `blocked by CORS: ${to} sent no Access-Control-Allow-Origin, so a page on ${origin} may not read it`;
  if (allowed !== "*" && allowed !== origin) return `blocked by CORS: ${to} allows ${allowed}, and this page is ${origin}`;
  if (request.credentials === "include") {
    if (allowed === "*") return `blocked by CORS: the request sent credentials, and ${to} allows only *, which does not cover them`;
    if (header("access-control-allow-credentials") !== "true") return `blocked by CORS: the request sent credentials, and ${to} did not send Access-Control-Allow-Credentials: true`;
  }
  return null;
}

/** The headers every response here needs: the pad is cross-origin isolated, and frames this origin. */
function isolated(init) {
  const headers = new Headers(init);
  headers.set("cross-origin-embedder-policy", "require-corp");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "cross-origin");
  return headers;
}

/** A redirect to the server's own address stays in the preview; one to another of the folder's servers goes there through /.wasmer/go/. */
function inPreview(location, session, guest) {
  // A path stays a path: it is already the preview's.
  if (!/^([a-z][a-z0-9+.-]*:)?\/\//i.test(location)) return location;
  try {
    const target = new URL(location, "http://localhost/");
    if (target.origin === scope.location.origin) return target.pathname + target.search + target.hash;
    if (!LOCAL.has(target.hostname)) return location;
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    const rest = target.pathname + target.search + target.hash;
    return port === guest ? rest : `/.wasmer/go/${session.id}/${port}${rest}`;
  } catch {
    return location;
  }
}

function receive(route, value) {
  const message = value;
  if (message?.type === "wasmer-sdk:http-close" && message.serverId === route.id) return close(route);
  if (message?.type !== "wasmer-sdk:http-response" || message.serverId !== route.id) return;
  const pending = route.pending.get(message.requestId);
  if (!pending) return;
  route.pending.delete(message.requestId);
  clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve(message);
}

function close(route) {
  routes.delete(route.id);
  const session = sessions.get(route.session);
  if (session && session.guests.get(route.guest) === route.id) session.guests.delete(route.guest);
  for (const pending of route.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("the preview of this server was closed"));
  }
  route.pending.clear();
  route.port.close();
}

// -------------------------------------------------------------- the pages

/**
 * A page of the preview's own, in place of one the server could not give.
 * It is said in the page rather than as a bare error, because a blank frame
 * reads as slowness.
 */
function notice(session, guest, path, page, status, title, detail) {
  if (page) tell(session, { type: "pad-preview:navigate", session: session.id, guest, path });
  const html = `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;color:#333;margin:3rem 2rem;max-width:36rem}h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;color:#666}code{font-family:ui-monospace,monospace}</style>
<h1>${escape(title)}</h1><p>${escape(detail)}</p>`;
  return new Response(html, { status, headers: isolated({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }) });
}

/**
 * When the worker has nothing of any pad: no pad is open, or the browser
 * stopped this worker and started it again, and every route it held is gone.
 * In the pad's frame, the pad hears this and sets them up again.
 *
 * Also a navigation no session can be shown to own, said as `why`. A frame
 * nested in a page has no pad above it to reconnect, so it says that instead.
 */
function lost(why = "Nothing is being previewed here. A preview lasts as long as the pad that started it is open.") {
  const html = `<!doctype html><meta charset="utf-8"><title>No preview</title>
<style>body{font:15px/1.5 system-ui,sans-serif;color:#666;margin:3rem 2rem;max-width:36rem}</style>
<p id="m">${escape(why)}</p>
<script>if (parent !== window && parent === top) { document.getElementById("m").textContent = "Reconnecting the preview…"; parent.postMessage({ type: "pad-page:lost" }, "*"); }</script>`;
  return new Response(html, { status: 503, headers: isolated({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }) });
}

function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The page's script tag, put first in its <head> so that it runs before the
 * page's own scripts and sees their console. Found in the bytes, decoded as
 * windows-1252 so that one character is one byte whatever the page's charset.
 * After the doctype at the least, since anything before it would put the page
 * in quirks mode.
 */
function withAgent(bytes, session) {
  const text = new TextDecoder("windows-1252").decode(bytes.subarray(0, 64 * 1024));
  const at = (re) => {
    const match = re.exec(text);
    return match ? match.index + match[0].length : -1;
  };
  let index = at(/<head\b[^>]*>/i);
  if (index < 0) index = at(/<html\b[^>]*>/i);
  if (index < 0) index = at(/^\s*<!doctype[^>]*>/i);
  if (index < 0) index = 0;
  const pad = session.padOrigin ? ` data-pad="${escape(session.padOrigin)}"` : "";
  const tag = new TextEncoder().encode(`<script src="${AGENT}" data-session="${session.id}"${pad}></script>`);
  const out = new Uint8Array(bytes.byteLength + tag.byteLength);
  out.set(bytes.subarray(0, index), 0);
  out.set(tag, index);
  out.set(bytes.subarray(index), index + tag.byteLength);
  return out;
}

function agentScript() {
  return new Response(`(${agent})();\n`, {
    headers: isolated({ "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }),
  });
}

/**
 * Runs in each HTML page the preview shows, before the page's own scripts.
 * It tells the pad what only the page knows: its console and uncaught errors,
 * and history.pushState, which loads no page that the worker would see. It
 * also takes a click on a link to another of the folder's servers there,
 * where the browser would go to this computer's localhost.
 *
 * It does this only in the pad's frame. A frame nested in the page, or the
 * page opened in a tab of its own, has no pad to tell.
 */
function agent() {
  const me = document.currentScript;
  const pad = me?.dataset.pad;
  const session = me?.dataset.session;
  if (!pad || !session || window.parent === window || window.parent !== window.top) return;
  const post = (message) => {
    try {
      window.parent.postMessage(message, pad);
    } catch {
      // A value that cannot be cloned: dropped rather than breaking the page.
    }
  };

  let last = location.pathname + location.search + location.hash;
  const moved = (how) => {
    const path = location.pathname + location.search + location.hash;
    if (path === last) return;
    last = path;
    post({ type: "pad-page:location", how, path });
  };
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (...args) {
      const result = original.apply(this, args);
      moved(name === "pushState" ? "push" : "replace");
      return result;
    };
  }
  addEventListener("popstate", () => moved("replace"));
  addEventListener("hashchange", () => moved("push"));

  const text = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (value === undefined || typeof value === "function" || typeof value === "symbol") return String(value);
    if (value instanceof Element) return `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ""}>`;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const say = (level, words) => post({ type: "pad-page:console", level, text: words.slice(0, 4000) });
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    console[level] = function (...args) {
      say(level, args.map(text).join(" "));
      return original.apply(this, args);
    };
  }
  const short = (url) => {
    try {
      const u = new URL(url);
      return u.origin === location.origin ? u.pathname : url;
    } catch {
      return url;
    }
  };
  addEventListener("error", (event) => {
    if (event instanceof ErrorEvent) {
      const where = event.filename ? ` (${short(event.filename)}:${event.lineno})` : "";
      say("error", `Uncaught ${event.error ? text(event.error) : event.message}${where}`);
    } else if (event.target instanceof Element) {
      say("error", `could not load ${short(event.target.src || event.target.href || "")}`);
    }
  }, true);
  addEventListener("unhandledrejection", (event) => say("error", `Uncaught (in promise) ${text(event.reason)}`));

  const local = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || (link.target && link.target !== "_self")) return;
    let url;
    try {
      url = new URL(link.href);
    } catch {
      return;
    }
    if (url.origin === location.origin || !local.has(url.hostname)) return;
    event.preventDefault();
    location.assign(`/.wasmer/go/${session}/${url.port || 80}${url.pathname}${url.search}${url.hash}`);
  });
}

// ---------------------------------------------------------------- cookies

/** Set-Cookie into the session's jar: name, value, path and lifetime, which is what a server on localhost relies on. */
function keepCookies(jar, pairs, requestPath) {
  for (const [name, value] of pairs) {
    if (name.toLowerCase() !== "set-cookie") continue;
    // Some servers fold several into one header; an Expires date has a
    // comma of its own, so split only where a new name=value starts.
    for (const one of value.split(/,(?=\s*[^;,=\s]+=)/)) {
      const [pair, ...attributes] = one.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const key = pair.slice(0, eq).trim();
      const cookie = { value: pair.slice(eq + 1).trim(), path: defaultPath(requestPath), expires: Infinity };
      let maxAge = false;
      for (const attribute of attributes) {
        const [a, ...rest] = attribute.split("=");
        const attr = a.trim().toLowerCase();
        const v = rest.join("=").trim();
        if (attr === "path" && v.startsWith("/")) cookie.path = v;
        else if (attr === "max-age" && /^-?\d+$/.test(v)) {
          cookie.expires = Date.now() + Number(v) * 1000;
          maxAge = true;
        } else if (attr === "expires" && !maxAge) {
          const at = Date.parse(v);
          if (!Number.isNaN(at)) cookie.expires = at;
        }
      }
      const id = `${key};${cookie.path}`;
      if (cookie.expires <= Date.now()) jar.delete(id);
      else jar.set(id, { name: key, ...cookie });
    }
  }
}

function defaultPath(path) {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

/** The Cookie header for a path: the longest paths first, as a browser orders them. */
function cookieFor(jar, path) {
  const now = Date.now();
  const sent = [];
  for (const [id, cookie] of jar) {
    if (cookie.expires <= now) {
      jar.delete(id);
      continue;
    }
    const p = cookie.path;
    if (path === p || (path.startsWith(p) && (p.endsWith("/") || path[p.length] === "/"))) sent.push(cookie);
  }
  sent.sort((a, b) => b.path.length - a.path.length);
  return sent.map((c) => `${c.name}=${c.value}`).join("; ");
}

// ----------------------------------------------------------- to the pad

/** What of a body the log shows: text, cut at `limit`, or only that it was binary. */
function shown(bytes, headers, limit) {
  if (!bytes.byteLength) return null;
  const type = (headers.find(([n]) => n.toLowerCase() === "content-type")?.[1] ?? "").toLowerCase();
  const textual = !type || /^text\/|json|javascript|xml|x-www-form-urlencoded|svg|csv|graphql/.test(type);
  if (!textual) return { binary: true };
  const cut = bytes.byteLength > limit;
  return { text: new TextDecoder().decode(bytes.subarray(0, limit)), cut };
}

/** To the session's control page, which hands it to the pad. */
async function tell(session, event) {
  if (!session.control) return;
  const client = await scope.clients.get(session.control);
  client?.postMessage(event);
}

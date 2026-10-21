# Networking in the pad

*Started as an investigation and ended as a feature. Egress shipped on 15
September 2026; the measurements that led there are kept because they are what
the next change to it has to start from.*

The pad's sandbox reaches exactly two places on the internet with a socket:
PyPI and, since 16 October, Wasmer's index of Python packages built for this
runtime, through an endpoint we run. Everything else is refused. Since 15
October an HTTP request can also go the other way round — handed to the page,
which makes it with the browser's fetch — and that reaches any site that lets
a web page read it; see [HTTP through the page](#http-through-the-page).

That it reaches anywhere at all is worth stating plainly, because the usual
explanation for why it could not — "a browser cannot open a TCP socket" — is
true and was never the reason. It took three wrong answers to find the real
one, and then two module specifiers and four deployment faults to get past it.

## What is actually true

The runtime **supports** TCP egress and HTTP ingress. `SandboxOptions.network`
takes a `NetworkPolicy`, and production passes `mode: "wisp"` with our own
endpoint — which carries egress *and* the HTTP ingress the preview needs, so it
supersedes `mode: "http"` rather than sitting beside it.

| | `disabled` | `mode: "http"` | `mode: "wisp"` (production) |
|---|---|---|---|
| loads at all | yes | yes | yes |
| `socket()` | succeeds | succeeds | succeeds |
| `bind()` + `listen()` | `ENOTSUP` | **works** | not measured |
| `connect()` | `ENOTSUP` | `ENOTSUP` | **works, to the allowlist** |
| DNS | `Name does not resolve` | `Name does not resolve` | **resolves** |
| TLS to PyPI | — | — | **TLSv1.3, end to end** |
| `pip install six` | — | — | **works** |

Measured against the deployed endpoint by `pad/scripts/wisp-check.mjs`, which
is the reusable form of all of this: it drives the sandbox through
`src/wisp-probe.ts` rather than through the terminal, so nothing it reports
depends on typing landing in the right place.

`bind()` under wisp is the one row still blank. The preview works in
production, which is the ingress that matters, but the syscall itself has not
been run under this policy — and a guess in this table is indistinguishable
from a measurement later.

`mode: "wisp"` used to fail before the sandbox existed:

```
Failed to resolve module specifier "@mercuryworkshop/wisp-js/client"
```

`wisp-network.js` ships in the SDK and imports its WISP client by bare
specifier, which assumes a bundler. We vendor the SDK verbatim because
**bundling it breaks everything** — its worker resolves siblings by relative
URL, and flattening the tree makes every command hang with nothing thrown.

**This is fixed as of 15 September, and it was two specifiers rather than
one.** A sandbox now starts with `mode: "wisp"` in about 2.9 s, which nothing
in this repository had ever done.

1. **An import map** in the page resolves `@mercuryworkshop/wisp-js/client`.
   The SDK's import runs in the main document — `index.js` does
   `await import("./wisp-network.js")` — so a map in the page reaches it.
   A worker would not have been reachable this way, since workers do not
   inherit the document's map.
2. **The browser compat substitution**, which only appeared once the first was
   out of the way. `wisp-js` has a `compat.mjs` importing `ws`, `crypto`,
   `node:net` and `node:dgram`, and a `compat_browser.mjs` mapping the same
   names onto standard APIs; the file's own first line says it "gets replaced
   with ./compat_browser.mjs when being bundled for the web". Vendoring
   unbundled means doing that substitution ourselves, which the vite plugin now
   does when it copies the package.

Removing either one fails the check in `src/check.ts`, each with its own
unresolved specifier — `"@mercuryworkshop/wisp-js/client"` and `"ws"`.

On its own this moved no traffic: the transport loads and a sandbox starts, but
egress also needs an endpoint to point `url` at, and that was a decision about
whose machine carries somebody else's traffic rather than a missing import.
That decision is [below](#whose-network-it-is), and the endpoint it produced is
next.

## The endpoint

`wss://code.rishwanth.dev/wisp`, which Caddy proxies to a node process bound to
loopback. It is `deploy/wisp-server.mjs`, run by `deploy/ajar-wisp.service`.

**It is an allowlist, not a proxy.** An unrestricted WISP endpoint is an open
TCP proxy with our IP as the exit: anybody with a pad link could reach any host
on the internet from this address, and the first we would know is an abuse
report or a terminated instance. The thing being bought is `pip install`, so
the list is `pypi.org` and `files.pythonhosted.org` on port 443 and nothing
else — and, from 16 October, `python-registry.wasmer.app`, Wasmer's index of
packages built for this runtime: numpy, pandas, matplotlib, pillow. PyPI has
no wheels of those for it, and they cannot be compiled here. The patterns are anchored, because an unanchored `pypi\.org` also matches
`pypi.org.example.com`, which is a host somebody else controls.

Four restrictions matter as much as the hostname list:

- `allow_private_ips` and `allow_loopback_ips` stay false, which blocks the
  link-local range and so **169.254.169.254** — the instance metadata service,
  which hands this instance's IAM credentials to anything that can make an HTTP
  request from it. The unit denies the same ranges with `IPAddressDeny=`, so a
  bug in the software filter is not the only thing in the way.
- `allow_direct_ip` is false, so a raw address cannot step around the hostname
  list.
- UDP is off. pip does not need it, and open UDP is how a proxy becomes an
  amplification source.
- Tunnels are capped — 64 open in all, 8 per address, in `wisp-server.mjs` —
  since 32 streams per tunnel bounds nothing if the tunnels are unbounded.

The hostname is checked, then resolved, then the *resolved* address is checked
again, so a name pointing into private space is refused rather than followed.

TLS is end to end between the sandbox and PyPI: python does the handshake and
the endpoint relays ciphertext. It sees hostnames and byte counts, never
content.

### Four things that had to be found by running it

1. **`stream_limit_per_host` crashes wisp-js 0.4.1.** It does `for (let stream
   of connection.streams)` over what the same file elsewhere reads with
   `Object.keys()`, so the first stream throws `connection.streams is not
   iterable` and takes the process down. What you see from the sandbox is a
   connection that opens and then cannot carry a byte — `OSError [Errno 29]`.
   Only `stream_limit_total` is set.
2. **The SDK appends a trailing slash.** A Caddy route matching `/wisp` alone
   lets `/wisp/` fall through to the SPA handler, which answers 200 with
   `index.html`; the browser reports "handshake failed: unexpected response
   code 200", which reads like a proxy fault rather than a routing one.
3. **DNS does not go through the tunnel.** The SDK resolves over DoH with
   `fetch`, and its default is `cloudflare-dns.com` — a cross-origin request
   that `connect-src 'self'` refuses. Inside the sandbox that is
   `Name does not resolve`; in the console it is `Failed to fetch`. Caddy now
   proxies `/dns-query` so the request is same-origin, which also keeps the
   names off a third party's logs and tells us nothing we do not already see,
   since every hostname comes past `/wisp` a moment later.
4. **A plain `pip install` reports success and installs nothing usable.**
   python's site-packages is under a read-only `/nix/store` path and the write
   lands in a layer that does not outlive the process. `PIP_TARGET` and
   `PYTHONPATH` point at `/workspace/.deps`, so packages land in the folder,
   for as long as the sandbox runs. Since 18 October `.deps` is not saved with
   the pad; `requirements.txt` carries the packages to whoever opens it.

## What TLS and pip look like, since they decide whether egress is worth it

All present, all verified in the sandbox:

```
ssl.OPENSSL_VERSION          OpenSSL 3.6.3
ssl.create_default_context() verify_mode 2 (CERT_REQUIRED)
/etc/ssl/certs/              a 472 KB bundle is on disk
pip --version                pip 26.2.1
```

So `pip install` is blocked by the socket and nothing else. That matters for
sizing the prize: the network unlock is mostly a **python** unlock. `ssh` needs
an ssh binary nobody has published, `git clone` needs git at 85 MB, and
`npm install` needs node at 74 MB. Network is necessary and nowhere near
sufficient for those.

## Ingress: the four steps

With `network: { mode: "http" }`:

1. A guest process **listens** — `python3 -m http.server 8000` binds and
   accepts.
2. `ports.onListen()` **reports the port** — saw `8000`.
3. `ports.expose(8000, { serviceWorker })` **returns a route** —
   `http://host-origin/`.
4. The route **serves** — an iframe pointed at it renders a response generated
   by a process inside the sandbox.

The 502 that used to sit at step 4 was two separate faults, and the diagnosis
was in a place nobody looked: the service worker answers a failure with
`new Response(error.message, { status: 502 })`, so **the body is the error**.
Reporting the status and stopping cost a session.

**`python3 -m http.server` did not serve, until 15 October.** When this was
measured, a request arriving at it faulted the worker with `RuntimeError: table
index is out of bounds`, and the route timed out after five minutes. The cause
was found later: it handles each request on a thread, and a thread cannot start
in this runtime (see [pad.md](pad.md)) — since 28 September `Thread.start()`
raises instead of trapping. A hand-rolled accept-and-reply loop in the same
sandbox served fine. Now `sitecustomize.py` gives socketserver's
`ThreadingMixIn` the plain server's `process_request`, once socketserver is
imported, so every server built on it — `http.server` and its
`ThreadingHTTPServer` among them — answers its requests one after another on
the thread that accepted them. `preview-check.mjs` serves a
page with a stylesheet and a script through it, typed as `python3 -m
http.server` and nothing more.

It binds `::1` by default here — `getaddrinfo` with `AI_PASSIVE` answers with
the IPv6 loopback — and the preview reaches it there. What does not come back
is a port: a server written with `socket` and without `SO_REUSEADDR` leaves its
port taken after Ctrl-C ("Address in use") until the sandbox goes. With
`SO_REUSEADDR`, killed at Ctrl-C while blocked in `accept()`, it was listed and
taken for 17 seconds, then free (measured on 16 October). A server that polls,
as `serve_forever` does, gets the interrupt as `KeyboardInterrupt`, closes its
socket and frees the port at once. And the preview's route is one per port:
`App.togglePreview` used to keep the first for good, so a server restarted on
another port previewed the one that had gone. Since 16 October every port has
a route of its own — see [the preview as a small browser](#a-small-browser).

**A malformed response is refused, correctly.** The second error,
`guest HTTP request failed: invalid internal data`, was a `Content-Length: 11`
on a ten-byte body — mine, not the SDK's. Worth knowing that the check exists
and what it says when it fires.

**The route only lives while something holds it.** The SDK's worker keeps
its route in module state, and the browser stops an idle worker. Opening the
URL in a separate tab found no route and fell through to the origin server,
which looks like a 404 from the wrong place. The iframe was the intended
consumer for exactly this reason, which is why the API hands you
`createIframe()`. The pad's own worker, since 16 October, holds the same
in-memory state but is kept awake, and it says when it has lost the routes
anyway. A tab of its own works for as long as the pad is open: see
[below](#a-small-browser).

### The second origin, and the header nobody documents

`expose()` needs a **standalone HTTP host on its own origin**, serving
`/.wasmer/host.html` (a document importing `service-worker-host.js`) and
`/wasmer-service-worker.js`. Cross-origin on purpose: a pad's own HTTP
responses must not be able to script the pad.

That host must send **`Cross-Origin-Embedder-Policy: require-corp`** on its own
documents. The pad page is COEP `require-corp`, so an embedded document without
it is blocked, and the failure surfaces as `the Wasmer HTTP host did not become
ready` — which reads like the host being slow rather than the frame being
refused. Adding the header turned that into a working route immediately.

Deploying it took a second subdomain with those files and those headers —
`preview.rishwanth.dev`, live since September.

### Two things that produced misleading failures

`ports.wait()` **cannot be used in `http` mode.** It probes by opening one real
TCP connection, which needs egress, and fails with
`port probing requires sandbox networking`. Use `onListen()` and `expose()`'s
own `timeoutMs`.

**Backgrounding the server with `&` kills it.** `sh -c "server &"` exits
immediately and takes the job with it; a request then arrives for a listener
that is gone and the sandbox faults with `table index is out of bounds`. Hold
the command as a live promise instead.

## What `expose()` is not

It is **not** ngrok, and cannot be made into it. It returns a `BrowserServer`
whose API is `createIframe()` — a service-worker route inside *your own*
browser. Nobody else can open that URL. It is exactly right for "let me see the
dev server I just started", which is also the hole ajar has had since the
beginning, and useless for "share this with someone".

A genuinely public URL needs a **reverse tunnel**: the pad opens an outbound
connection to a server the user runs, and that server holds a public port and
forwards inbound requests back down it. That is how ngrok works, and it is
buildable now that egress exists — a few hundred lines on each side. What
stands in the way is the allowlist: egress reaches the package indexes and
nothing else, so a tunnel would need the endpoint to reach the user's own
server — the third row below, not a longer allowlist.

## Whose network it is

Three arrangements, differing only in what `requestUrl` returns:

| | Egress from | Abuse lands on | |
|---|---|---|---|
| We run an open WISP server | our IP | us, anonymously | rejected |
| **We run an allowlisted endpoint** | **our IP** | **bounded to a list we choose** | **built** |
| The user runs the endpoint | their machine | them, by name | still the answer for anything wider |

**The second was chosen and shipped.** The first is an open TCP proxy and was
never a real option. The third is genuinely better on abuse — it is the only
one that scales without accounts — but it costs the user a local command before
anything works, and it breaks the premise the pad is built on: a pad with a
tunnel **cannot be shared**, because the second visitor would egress through
the first person's network. Network mode would have to become per-tab and
per-session, which cuts against "send someone the link".

The allowlist is what makes the middle row survivable. Bounded to three
hostnames, all package indexes, the abuse surface is "somebody downloads a lot
of packages", not "somebody scans the internet from our address". It is the
narrow version of a bad idea, and it stays defensible only while the list
stays short — which is why widening it is an edit to `deploy/wisp-server.mjs`
in the repository rather than a setting on the box.

The third row is still the answer for anything wider than the package
indexes. If `git clone` or arbitrary egress is ever wanted, it is that, not a
longer allowlist — and such a URL would be a credential: a pad is plaintext on
the server and readable by anyone holding a link to it, so the URL must live in
the tab and never in a file.

## Order to do it in

1. ~~**`mode: "http"` plus a preview origin.**~~ **Built.** A Preview button
   appears when something in the folder starts listening and swaps the editor
   for the running server. `pad/scripts/preview-check.mjs` drives it end to end.
   The origin is compiled in as `VITE_PREVIEW_ORIGIN`; an empty value disables
   previews and is what a deploy without that subdomain should do. Whatever
   people run can be `python3 -m http.server`, since 15 October.
2. ~~**The import map for WISP.**~~ **Built**, and it needed the browser compat
   substitution alongside it — two specifiers, not one.
3. ~~**An endpoint to point it at.**~~ **Built and live**, as an allowlist
   rather than a proxy. `pip install` works from a pad; `pad/scripts/wisp-check.mjs`
   asserts both that it reaches PyPI and that nothing else is reachable.
4. **A reverse tunnel**, only if a public URL is still wanted after (1) — it
   often will not be, because most of the time "let me see my server" means
   your own browser.
5. ~~**Whatever makes a multi-dependency install survive.**~~ **Done** on 28
   September: pip's progress bar starts a thread, which this runtime cannot;
   with `PIP_PROGRESS_BAR=off`, `pip install requests` finishes in about 6 s,
   and `pad/scripts/user-check.mjs` installs and imports it against the live site.

## How wrong I was, in order

Worth recording because each wrong answer sounded complete.

**"The allowlist is not working — `example.com` was reachable."** It was not.
`socket.create_connection` returns successfully for a destination WISP refused,
because the stream is opened optimistically and the refusal only lands on first
I/O. The server had logged `refusing to create a stream to example.com:443` for
every attempt while the check reported an open proxy. Read the other side's log
before believing an alarming result.

**"A browser cannot open a TCP socket, so this is impossible."** True about
browsers, wrong about the runtime, which ships a WISP client for exactly this.

**"It is a flag we never pass."** Also wrong: passing it reveals an
unresolvable import.

**"`ports.expose()` gives you a URL."** It does, and the URL is browser-local,
which is not what anyone means by ngrok.

Every correction came from reading the SDK's own type definitions and running
the thing. None came from reasoning about what ought to be possible.

## The preview, as built

Three origins now, and each boundary is load-bearing:

| | |
|---|---|
| `ajar.rishwanth.dev` | the relay and the session client |
| `code.rishwanth.dev` | the pad — cross-origin isolated for SharedArrayBuffer |
| `preview.rishwanth.dev` | whatever a visitor is running |

The third exists because the sandbox's HTTP responses are **somebody else's
code**. Served from the pad's origin they could script it, read its storage and
reach its service worker. On their own origin they can do none of that, and the
SDK refuses to route anywhere else.

The Caddy block serves the SDK's control-page script from the vendored SDK the
pad already ships, so it is never a different version from the client talking
to it: `vendor/wasmer/service-worker-host.js`, which the build copies beside the
SDK's folder, named for its version since 21 October. It also serves the pad's own worker and relay (`pad/preview/`, copied
under `vendor/preview/` by the build) and the one-line control page that loads
both, written inline. Until 16 October the worker was the SDK's too. Nothing is
stored and nothing is proxied: with no pad open, that origin answers 404.

`preview.rishwanth.dev` is an A record to `13.207.222.42`, added by hand on
NS1, which holds the zone rather than Route 53. On a new domain, deploy with
`AJAR_PREVIEW_ORIGIN=` empty until the record exists: otherwise the button
appears and expose fails.

### A small browser

From 16 October the preview is a small browser:
- **The bar:** back, forward, reload, which server (every port something
  listens on), the address in it, and the page in a tab of its own.
- **Under the page, when asked for:** every request the page made, with what
  went to the server and what came back, and the page's console.

The server's side of the same requests is in the terminal running it. The
SDK's own worker could not do this: it holds one route, at the root, and
nothing else. `pad/preview/sw.js` replaces it. It answers the SDK's messages
the same way, so `ports.expose()` is unchanged, and it adds the rest:

- **A route per port, and one in front.** The pad loads every page through
  `/.wasmer/go/<session>/<port>/<path>`. The worker puts that port in front
  for that session and redirects to the path, so the page sits at the
  origin's root as it would at `localhost:<port>`. Each document's later
  requests go back to the server it came from, keyed by client id.
- **One session per pad tab.** Each tab has its own routes, front server and
  cookies, and each page stays its tab's. Every load the pad makes names its
  session in the `/.wasmer/go/` path. Any other navigation goes where the page
  it replaces came from: Chrome names that document as the navigation's
  client. A redirect, the pad's own or the server's, goes where the step
  before it went, because the browser keeps the navigation's client id
  through redirects on one origin.

  A frame or window that a page makes (an iframe it adds, a link with
  `target=_blank`) names no page. It is served only when everything of the
  preview's origin open in the browser is one pad's: its control page and
  pages the worker served it. Otherwise the frame gets the worker's "no
  preview" page and nothing loads. That covers two pads open, a page served
  before the worker was restarted, and anything else it cannot vouch for.
  A `/.wasmer/go/` load from a frame already showing another session's page
  is refused too.

  Until 18 October such a navigation went to whichever session had last
  loaded a page or come back into view (audit DC-10). With two previews open,
  or a page popped out of one, a link in one could load the other's server
  into it, on the same port. `preview-check.mjs` opens a second pad beside
  the first and checks links in both, in a popped-out page, and in a frame a
  page adds.
- **Instructions come only from a control page.** The worker takes messages
  only from a framed `/.wasmer/host.html` that it did not serve itself. A
  Client's `url` is where the document was made, so `history.replaceState`
  cannot fake one. A session is bound to the first control page that speaks
  for it, and messages for it from any other are refused. A route can be
  attached only by the control page that registered it. The pad accepts
  `pad-preview:` messages only from its control page's window. Until
  18 October any window could send them (audit DC-11). Every preview page is
  on this origin and has its own session's id in its script tag, so a page
  could make itself the session's control and get the session's requests and
  answers instead of the pad. It could also write rows into the pad's request
  log.
- **`http://localhost:PORT` is the sandbox's PORT.** Requests the page makes
  there are answered by the folder's server on that port, never by this
  computer's. The browser's CORS rule is applied to them as at localhost:
  without a matching `Access-Control-Allow-Origin` the page cannot read the
  response, and the request log says why. Preflights are not sent; what the
  actual response allows is checked.
- **Cookies.** A response a worker builds cannot set a cookie, so before this
  a Flask session or a sign-in lasted one request. The worker keeps each
  session's jar from `Set-Cookie` (path, `Max-Age`, `Expires`) and sends it
  back as `Cookie`. It follows the browser's rules for when: same-origin, or
  `credentials: "include"`. The jar is shared across ports, as cookies on
  localhost are. Scripts do not see these cookies in `document.cookie`.
- **The headers a server checks.** A worker never sees the `Origin` the
  browser would add, or the `Referer`. Both are added here, naming
  `http://localhost:<port>` rather than this origin, so Django's CSRF check
  sees what it would see in development. `Host` names the port too: the
  SDK's own is `localhost`, and Flask's `url_for(_external=True)` built
  addresses on port 80 from it.
- **Redirects.** A `Location` naming the server's own localhost address
  becomes a path, so the frame stays in the preview. One naming another
  server's address goes through `/.wasmer/go/`.
- **A small script in each HTML page** (`agent` in `sw.js`), first in its
  `<head>`. It runs only in the pad's frame and posts to the pad's origin,
  and it reports what only the page knows:
  - its console and uncaught errors
  - `history.pushState`, which loads nothing the worker would see
  - a click on a link to another server's localhost address, which it sends
    to that server rather than to this computer's

  It is not added to a compressed response, and a page whose CSP allows
  scripts only by nonce refuses it. Either way the page still works; its
  console just does not reach the log.
- **`frame-ancestors 'self'` and the pad's origin** on every page. Another
  site cannot frame a preview and read what its script posts.

The worker's state is only in memory. A browser stops an idle worker after
about thirty seconds, so the control page (`pad/preview/relay.js`) sends it
a message every twenty. That is not always enough: a background tab's timers
are throttled to once a minute. When the worker was stopped anyway:
- **A navigation that finds no session** gets a page from the worker that
  tells the pad, and the pad sets every route up again and reloads.
- **A request that finds the session but no route** to a port, because a
  later message started the session again, makes the worker tell the pad
  `pad-preview:unrouted`. If the pad knows something listens there, it makes
  that route again and reloads the page, or retries a terminal's request
  once.
- **The tab coming back into view** (`pad-preview:front`) for a port the
  worker has no route to gets `pad-preview:unrouted` straight away. A page
  left open is one the new worker never served, and from 18 October its
  requests are refused rather than given to whichever session is about, so it
  is reloaded without waiting for it to ask for something.

A page reloads for this at most once in ten seconds, per port for the
second case, and a terminal's request is retried only once, so a worker that
keeps failing cannot set either spinning. `preview-check.mjs` stops the worker through the
DevTools protocol and expects both a `curl` and the page to come back. With
the recovery taken out, that check fails. Each route is
confirmed (`pad-preview:routed`) before anything loads through it, because the
pad's message and the frame's first request reach the worker by different
paths. Without the confirmation, the first load found no route (seen on
16 October).

A server stopped while on screen keeps its route: the SDK's is to a port, and
works again once something listens there. The page says the server stopped,
and reloads when it is back. A server started while the preview was closed
is what it opens on: the same page again if it is that server restarted,
otherwise the new server's front page.

What it does not do:
- **WebSockets.** A service worker never sees one, so `new WebSocket(...)`
  goes to this computer's localhost, and a dev server's hot reload never
  connects.
- **Streamed responses.** The SDK hands over each response whole, so
  Server-Sent Events show nothing until the stream ends.
- **Links to localhost that open a new window** (`target=_blank`) go to this
  computer's localhost, as the script only takes plain clicks.

### Two things this found that were not the subject

**`python3 -m http.server` did not serve** (threads, above), so the one server
everybody reaches for first was the one that did not work. It does now.

**A pad's stored files were empty in the sandbox until touched** — `ls` showed
the name, `head` showed nothing — so opening a shared link and running a file
you had not edited silently did nothing. Fixed on 15 September by seeding the
sandbox from the store; see
[pad.md](pad.md#seeding-the-sandbox-is-a-separate-problem-with-the-same-shape).

## HTTP through the page

A page cannot open a socket; that is the browser's rule for code from any site
and no flag changes it. Chrome's Direct Sockets API exists only for installed,
signed Isolated Web Apps, not for a page at an address. What every page *can*
do is fetch — any https site that lets web pages read it (CORS) — so since 15
October an HTTP request in the sandbox is handed to the page and made there.
Nothing of ours carries it: it leaves from the visitor's own browser, so it
reaches what their browser reaches, and an abuse report about it would be
about their address, not this server's.

The handing over is the fast javac's (`javac/bridge.ts`), over files in
`.ajar/fetch`: the sandbox writes `<id>.req` — a line of JSON, then the body's
bytes — and renames it into place; the page, which looks every 40 ms while a
command runs, writes `<id>.claim`, fetches, and renames `<id>.ans` into place.
`src/fetch-bridge.ts` is the page's half, `src/tools/_padfetch.py` the
sandbox's. Three things use it:

- **`curl` and `wget`**, `src/tools/curl.py` behind an alias. Most of curl's
  everyday options; anything else is refused by name. Exit codes are curl's
  (7 refused, 22 for `-f`, 28 timeout).
- **`urllib.request`**: its http and https handlers, replaced once it is
  imported (`sitecustomize.py`).
- **`requests`**, once pip has installed it: `HTTPAdapter.send`, the same way.
  pip has its own vendored copy, which keeps the sandbox's sockets, so `pip
  install` still goes through the allowlisted endpoint above.

Either falls back to the sandbox's sockets when no page picks the request up
in three seconds — a python started some way other than a command.

What the browser does not allow, this cannot do, and each limit is said rather
than met as a hang:

| | |
|---|---|
| A site with no CORS headers | refused; "Failed to fetch" is all a page is told, so the message names both that and a site that cannot be reached |
| `http://` from an https page | mixed content — refused, with the https address to try |
| `Host`, `Cookie`, `Referer`, `User-Agent`, `Sec-*`, `Proxy-*`… | the browser's own; left out, and named by `curl -v` |
| Response headers | only the ones the site exposes to pages |
| Redirects | always followed: `redirect: "manual"` gives a page an opaque nothing |
| A body over 100 MB | refused, as a pad would not hold it |

It is sent **without credentials**, without a referrer and uncached, and
**never to this site or the preview's** — a program in a pad somebody shared
has no business asking our API anything in the name of whoever ran it. See
[security.md](security.md#http-through-the-browser). The page's CSP had to
allow it: `connect-src` is now `https:`.

Not through it: `http.client` used directly, `httpx`, `aiohttp`, node's `fetch`,
`git`, anything that opens its own socket. Those still reach the package
indexes alone. And a response comes whole, not as a stream: a download is held
in the page until it is complete, then written.

### localhost is the folder's servers

From 16 October, a request to `localhost`, `127.0.0.1`, `0.0.0.0` or `[::1]`
goes to the folder's own server on that port, never to the visitor's
computer. That is `curl localhost:5000` in one terminal at the Flask app
running in another, or a test calling the API with `requests`. The sandbox
cannot do this by itself: in `http` mode a loopback `connect` fails with
`[Errno 58] Not supported`. And the browser's own localhost is the wrong
machine. So `fetch-bridge.ts` hands these requests to the preview
(`PreviewBrowser.fetchLocal`), whose worker sends them down the same route a
page's requests take, and the full answer comes back.

They are a program's requests, not a page's, so the table above does not
apply:
- plain http, from the https page
- no CORS, and every header the server sent, Set-Cookie among them
- no cookies but the ones the command sends, and no `Origin`
- redirects followed only when asked: `curl -L` follows them, and urllib and
  `requests` follow them themselves, as they would anywhere. Without `-L`,
  `curl -i` shows a sign-in's 303 and its cookie.
- with no scheme, `curl localhost:5000` is `http://`, as curl assumes

The pad's own address is still refused first. A pad served from `127.0.0.1`,
as the checks are, never asks itself.

Only a port something in the folder listens on is reached. Any other is
`curl: (7) … nothing in the folder is listening there`. `user-check.mjs`'s
stand-in for httpbin is `bin.test` for this reason. The browser is told it
is 127.0.0.1 (`--host-resolver-rules`), since 127.0.0.1 itself now means the
sandbox.


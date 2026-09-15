# Networking in the pad

*An investigation, not a feature. Nothing here is built; everything here was
measured. Written so the next attempt starts where this one stopped.*

The pad's sandbox has no network. That is usually explained as "a browser
cannot open a TCP socket", which is true and is not the reason. The reason is
narrower and more fixable, and it took three wrong answers to find.

## What is actually true

The runtime **supports** TCP egress and HTTP ingress. `SandboxOptions.network`
takes a `NetworkPolicy`. Production passes `mode: "http"`, which is what makes
the Preview button possible; it grants no egress.

| | `disabled` | `mode: "http"` (production) | `mode: "wisp"` |
|---|---|---|---|
| loads at all | yes | yes | **yes, since 15 September** |
| `socket()` | succeeds | succeeds | not measured |
| `bind()` + `listen()` | `ENOTSUP` | **works** | not measured |
| `connect()` | `ENOTSUP` | `ENOTSUP` | not measured |
| DNS | `Name does not resolve` | `Name does not resolve` | not measured |

The `wisp` column says only what has actually been run. A sandbox starts with
that transport selected, and that is the whole of it — the syscall rows would
need a sandbox with python in it and an endpoint to answer, and neither has
been done. They are left blank rather than guessed at, because a plausible
guess in this table is indistinguishable from a measurement later.

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

**What this does not do is move traffic.** The transport loads and a sandbox
starts; egress additionally needs a WISP server to point `url` at, and that is
a decision about whose machine carries somebody else's traffic rather than a
missing import. The table below is the part that is still open.

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

## Ingress: three steps of four

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

**`python3 -m http.server` crashes the runtime.** A request arriving at it
faults the worker with `RuntimeError: table index is out of bounds`, and the
route then times out after five minutes. A hand-rolled accept-and-reply loop in
the same sandbox serves fine. This matters because `http.server` is the first
thing anyone reaches for, and the failure looks like the route being broken
rather than the server being unusable.

**A malformed response is refused, correctly.** The second error,
`guest HTTP request failed: invalid internal data`, was a `Content-Length: 11`
on a ten-byte body — mine, not the SDK's. Worth knowing that the check exists
and what it says when it fires.

**The route only lives while something holds it.** `activeRoute` is module
state in the service worker, and an idle worker is killed. Opening the URL in a
separate tab finds no route and falls through to the origin server, which looks
like a 404 from the wrong place. The iframe is the intended consumer for
exactly this reason, which is why the API hands you `createIframe()`.

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

Deploying this means a second subdomain with those two files and those headers.

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
buildable once egress exists — a few hundred lines on each side. It is gated
behind the WISP fix, like everything else.

## Whose network it is

Three arrangements, differing only in what `requestUrl` returns:

| | Egress from | Abuse lands on |
|---|---|---|
| We run an open WISP server | our IP | us, anonymously |
| We run an allowlisted HTTP proxy | our IP | bounded to a list we choose |
| **The user runs the endpoint** | **their machine** | **them, by name** |

The third is the only one that scales without accounts, and it is cheap for the
user: browsers treat `localhost` as a secure context, so an HTTPS pad can talk
to `ws://127.0.0.1:6001` with no certificate, no domain and no open firewall
port. One local command.

Two consequences follow and neither is a bug. **The endpoint URL is a
credential** — pads are plaintext and readable by anyone with the link, so it
must live in the tab and never in a file. And **a pad with a tunnel cannot be
shared**, because the second visitor would egress through the first person's
network. Network mode is therefore per-tab and per-session, which cuts against
the pad's whole "send someone the link" premise.

## Order to do it in

1. ~~**`mode: "http"` plus a preview origin.**~~ **Built.** A Preview button
   appears when something in the folder starts listening and swaps the editor
   for the running server. `scripts/preview-check.mjs` drives it end to end.
   The origin is compiled in as `VITE_PREVIEW_ORIGIN`; an empty value disables
   previews and is what a deploy without that subdomain should do. Whatever
   people run must not be `python3 -m http.server`.
2. ~~**The import map for WISP.**~~ Done on 15 September, and it needed the
   browser compat substitution alongside it. `pip install` now waits only on a
   WISP endpoint to point at.
3. **A reverse tunnel**, only if a public URL is still wanted after (1) — it
   often will not be, because most of the time "let me see my server" means
   your own browser.

## How wrong I was, in order

Worth recording because each wrong answer sounded complete.

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

The Caddy block serves exactly two files, both from the vendored SDK the pad
already ships so they can never be a different version from the client talking
to them. Nothing is stored and nothing is proxied: with no pad open, that origin
answers 404.

`preview.rishwanth.dev` needs an A record to `13.207.222.42`. DNS for the zone
is on NS1, not Route 53, so that record has to be added by hand — and until it
exists the deploy sets `VITE_PREVIEW_ORIGIN` to an origin that does not
resolve, so the button appears and expose fails. Set `AJAR_PREVIEW_ORIGIN=`
empty to deploy without previews.

### Two things this found that were not the subject

**`python3 -m http.server` crashes the runtime**, so the one server everybody
reaches for first is the one that does not work. A plain accept loop is fine.

**A pad's stored files are empty in the sandbox until touched** — `ls` shows
the name, `head` shows nothing. Pre-existing, reproduced with networking off,
and recorded in [../open-points.md](../open-points.md). It matters more than the
preview does: it means opening a shared link and running a file you did not
edit silently does nothing.

/**
 * The pad's way out to the network, and the only one.
 *
 * A sandbox in the browser cannot open a TCP socket. WISP carries TCP over a
 * single WebSocket, and this is the other end of it: the sandbox connects here,
 * this process makes the real connection, and bytes are relayed.
 *
 * ## Why this is an allowlist and not a proxy
 *
 * An unrestricted WISP endpoint is an open TCP proxy with our IP as the exit.
 * Anybody with a pad link would be able to reach any host on the internet from
 * this address — scanning, spam, credential stuffing — and the first we would
 * know is an abuse report or a terminated instance.
 *
 * The thing actually being bought here is `pip install`. So the allowlist is
 * exactly the hosts that needs and nothing else. Widening it is a deliberate
 * act, visible in one place, and each name added is a decision about what this
 * address can be used to reach.
 *
 * The other restrictions matter as much as the hostname list:
 *
 * - `allow_private_ips` and `allow_loopback_ips` stay false, which blocks the
 *   link-local range and so **169.254.169.254** — the EC2 instance metadata
 *   service, which hands out this instance's IAM credentials to anything that
 *   can make an HTTP request from it. That is the single worst thing a
 *   server-side proxy can be talked into reaching.
 * - `allow_direct_ip` is false, so a raw address cannot be used to step around
 *   the hostname list.
 * - UDP is off. pip does not need it, and open UDP is how a proxy becomes an
 *   amplification source.
 *
 * The hostname is checked, then resolved, then the *resolved address* is
 * checked again, so a name that points into private space is refused rather
 * than followed.
 *
 * TLS is end to end between the sandbox and the far host: python does the
 * handshake and this process relays ciphertext. It sees hostnames and byte
 * counts, never content.
 */
import { createServer } from "node:http";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const PORT = Number(process.env.WISP_PORT ?? 8788);
const HOST = process.env.WISP_HOST ?? "127.0.0.1";

// Anchored, because an unanchored `pypi\.org` also matches
// `pypi.org.example.com`, which is a host somebody else controls.
const ALLOWED = [
  /^pypi\.org$/,
  /^files\.pythonhosted\.org$/,
];

Object.assign(wisp.options, {
  hostname_whitelist: ALLOWED,
  port_whitelist: [443],
  allow_direct_ip: false,
  allow_private_ips: false,
  allow_loopback_ips: false,
  allow_udp_streams: false,
  allow_tcp_streams: true,
  // A pad that opens hundreds of sockets is not installing a package.
  //
  // Only the total. `stream_limit_per_host` is broken in wisp-js 0.4.1: it does
  // `for (let stream of connection.streams)` over what the same file elsewhere
  // reads with `Object.keys()`, so setting it throws `connection.streams is not
  // iterable` on the first stream and takes the process down — which presents
  // as a connection that opens and then cannot carry a byte.
  stream_limit_total: 32,
  // Caddy is the only thing that talks to this, so the client address worth
  // logging is the one it forwards.
  parse_real_ip: true,
  parse_real_ip_from: ["127.0.0.1"],
});

// How many tunnels may be open at once, in total and from one address.
//
// `stream_limit_total` bounds the sockets inside one tunnel; nothing bounded the
// tunnels. N connections x 32 streams was unlimited concurrent TCP out of this
// instance's IP, which is the part that gets an address blocked rather than
// merely busy.
//
// A pad opens exactly one tunnel while it installs something, so these are
// generous by the standards of real use: eight tabs from one address, and sixty
// four people installing at the same moment.
const MAX_TUNNELS = 64;
const MAX_TUNNELS_PER_IP = 8;

let openTunnels = 0;
const perIp = new Map();

/** The address Caddy saw, which is the only one worth counting. */
function callerOf(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    // Rightmost: a proxy appends the peer it actually saw, so anything left of
    // the last element was supplied by the caller. Same reasoning as the relay.
    const parts = forwarded.split(",");
    return parts[parts.length - 1].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

const http = createServer((req, res) => {
  // Nothing here serves HTTP. Answering the health probe and refusing the rest
  // keeps a stray request from looking like a working open proxy.
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok\n");
  }
  res.writeHead(426, { "content-type": "text/plain" });
  res.end("this endpoint carries wisp over a websocket\n");
});

http.on("upgrade", (req, socket, head) => {
  const caller = callerOf(req);
  const mine = perIp.get(caller) ?? 0;

  if (openTunnels >= MAX_TUNNELS || mine >= MAX_TUNNELS_PER_IP) {
    // Refused before the WebSocket exists, so there is nothing to tear down and
    // the client gets a status rather than a silent close.
    const why = openTunnels >= MAX_TUNNELS ? "server" : "address";
    console.warn(`refusing a tunnel: ${why} limit reached (${caller}, ${openTunnels} open)`);
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }

  openTunnels += 1;
  perIp.set(caller, mine + 1);

  // Once, whichever way the socket ends. Releasing twice hands out allowance
  // nobody gave back; never releasing leaks the ceiling shut after enough
  // churn, which is worse than having no ceiling because it arrives quietly.
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    openTunnels -= 1;
    const left = (perIp.get(caller) ?? 1) - 1;
    if (left > 0) perIp.set(caller, left);
    else perIp.delete(caller);
  };
  socket.on("close", release);
  socket.on("error", release);

  // A proxy that can be killed by one malformed request is a denial of service
  // with extra steps. systemd restarts it, but not losing every other pad's
  // connection in the meantime is worth the guard.
  try {
    wisp.routeRequest(req, socket, head);
  } catch (e) {
    console.error("upgrade failed:", e?.message ?? e);
    release();
    socket.destroy();
  }
});

process.on("uncaughtException", (e) => console.error("uncaught:", e?.stack ?? e));
process.on("unhandledRejection", (e) => console.error("unhandled:", e?.stack ?? e));

http.listen(PORT, HOST, () => {
  console.log(`wisp on ${HOST}:${PORT}, allowing ${ALLOWED.map(String).join(" ")} on 443`);
});

#!/usr/bin/env node
// The preview, driven the way a person would: start a server in the terminal,
// press Preview, and read what the iframe shows.
//
//   VITE_PREVIEW_ORIGIN=http://127.0.0.1:5251 npx vite build
//   node scripts/preview-check.mjs
//
// Against the deployed site instead, where the two origins are already there
// and the build being driven is the one users get:
//
//   PAD_ORIGIN=https://code.rishwanth.dev node scripts/preview-check.mjs
//
// Two origins, because the SDK requires it and because a page serving whatever
// someone ran in their folder must not be able to script the pad.

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

// Against the deployed site nothing local is involved: no relay to spawn, no
// dist to serve, and the preview origin is already a real host. Without this
// the check quietly served the local build whatever PAD_ORIGIN said, so asking
// it about production told you about your working copy.
const LIVE = process.env.PAD_ORIGIN ?? null;

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const VENDOR = join(ROOT, "vendor/wasmer/dist");
// The preview origin's worker and control-page script, as the build copies
// them from pad/preview/ and as Caddy serves them in production.
const PREVIEW = join(ROOT, "vendor/preview");
const PORT = 5250, HOST_PORT = 5251, RELAY_PORT = 8844;
// The build has the preview origin compiled into it, so a dist built for
// somewhere else fails here as a bare CSP violation in the console — the
// production build refuses to be framed by 127.0.0.1, and correctly so. That
// reads as a broken preview rather than the wrong bundle, and cost a round of
// chasing after a deploy left a production dist on disk. Checked up front.
if (!LIVE) {
  const { readdir } = await import("node:fs/promises");
  const assets = join(ROOT, "assets");
  const names = await readdir(assets).catch(() => []);
  let found = false;
  for (const f of names.filter((f) => f.endsWith(".js"))) {
    if ((await readFile(join(assets, f), "utf8")).includes(`127.0.0.1:${HOST_PORT}`)) {
      found = true;
      break;
    }
  }
  if (!found) {
    console.error(
      `\n  the build in dist/ is not the one this check drives.\n` +
      `  it has to know the preview origin, which is compiled in:\n\n` +
      `      VITE_PREVIEW_ORIGIN=http://127.0.0.1:${HOST_PORT} npx vite build\n`,
    );
    process.exit(2);
  }
}

const TYPES = {
  ".html": "text/html", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".wasm": "application/wasm", ".webc": "application/webc",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
};

const padDir = await mkdtemp(join(tmpdir(), "ajar-preview-"));
const relay = LIVE ? null : spawn("../target/debug/ajar-relay",
  ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", padDir],
  { stdio: "ignore" });
if (!LIVE) {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const pad = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (req.url.startsWith("/api/") || req.url === "/ws") {
    const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    return req.pipe(up);
  }
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = join(ROOT, path === "/" ? "index.html" : path);
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.setHeader("Content-Type", "text/html");
    res.end(await readFile(join(ROOT, "index.html")));
  }
});
if (!LIVE) await new Promise((r) => pad.listen(PORT, r));
const ORIGIN = LIVE ?? `http://127.0.0.1:${PORT}`;

const host = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  try {
    res.setHeader("Cache-Control", "no-cache");
    if (path === "/.wasmer/host.html") {
      res.setHeader("Content-Type", "text/html");
      return res.end('<!doctype html><meta charset="utf-8"><script type="module" src="/wasmer-host.js"></script><script type="module" src="/pad-preview.js"></script>');
    }
    if (path === "/wasmer-host.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(await readFile(join(VENDOR, "service-worker-host.js")));
    }
    if (path === "/pad-preview.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(await readFile(join(PREVIEW, "relay.js")));
    }
    if (path === "/wasmer-service-worker.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.setHeader("Service-Worker-Allowed", "/");
      return res.end(await readFile(join(PREVIEW, "sw.js")));
    }
    res.statusCode = 404; res.end("no preview is running");
  } catch (e) { res.statusCode = 500; res.end(String(e)); }
});
if (!LIVE) await new Promise((r) => host.listen(HOST_PORT, r));

const results = [];
const ok = (m) => { results.push(true); console.log(`  ok    ${m}`); };
const fail = (m) => { results.push(false); console.log(`  FAIL  ${m}`); };

const SERVER = [
  "import socket",
  "s = socket.socket()",
  "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
  "s.bind(('127.0.0.1', 8080))",
  "s.listen(8)",
  "print('serving on 8080', flush=True)",
  "while True:",
  "    c, _ = s.accept()",
  "    c.recv(65536)",
  "    body = b'<h1>hello from my folder</h1>'",
  "    c.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Type: text/html\\r\\nContent-Length: %d\\r\\nConnection: close\\r\\n\\r\\n' % len(body) + body)",
  "    c.close()",
].join("\n");

// A small site and an API beside it, as a Flask app and its frontend would
// be, in the standard library because pip is not reachable here: pages that
// link to each other, a sign-in that sets a cookie and redirects, a script
// that logs and calls the API on another port, and the API answering with
// CORS on one path and without it on another.
const APP = String.raw`import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

users = {}
PAGE = """<!doctype html><html><head><title>{title}</title></head><body><h1>{title}</h1>{body}
<nav><a id="home" href="/">home</a> <a id="about" href="/about">about</a> <a id="api" href="http://localhost:8081/hello">the api</a></nav></body></html>"""
SCRIPT = b"""console.log('hello console');
fetch('http://localhost:8081/hello').then((r) => r.json()).then((j) => { document.getElementById('api-result').textContent = 'api says ' + j.from + ' to ' + j.origin; }).catch((e) => { document.getElementById('api-result').textContent = 'api failed ' + e; });
fetch('http://localhost:8081/nocors').then(() => { document.getElementById('nocors').textContent = 'nocors read'; }, () => { document.getElementById('nocors').textContent = 'nocors blocked'; });
history.pushState({}, '', '/?pushed=1');
"""

class Handler(BaseHTTPRequestHandler):
    def sid(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            key, _, value = part.strip().partition("=")
            if key == "sid":
                return value

    def send(self, status, body, kind, extra=()):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        for key, value in extra:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def page(self, title, body):
        self.send(200, PAGE.format(title=title, body=body).encode(), "text/html; charset=utf-8")

    def do_GET(self):
        path = self.path.split("?")[0]
        who = users.get(self.sid())
        if path == "/":
            self.page("home", '<p id="who">' + ("signed in as " + who if who else "not signed in") + '</p><form method="post" action="/login"><input name="name" value="ada"><button id="go">sign in</button></form><p id="api-result">waiting</p><p id="nocors">waiting</p><script src="/app.js"></script>')
        elif path == "/about":
            self.page("about", "<p>about page</p>")
        elif path == "/app.js":
            self.send(200, SCRIPT, "text/javascript")
        elif path == "/headers":
            self.send(200, json.dumps(dict(self.headers)).encode(), "application/json")
        elif path == "/dashboard":
            if who:
                self.page("dashboard", '<p id="who">signed in as ' + who + "</p>")
            else:
                self.send(302, b"", "text/plain", [("Location", "/")])
        else:
            self.send(404, b"not here", "text/plain")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        form = parse_qs(self.rfile.read(length).decode())
        sid = "s%d" % (len(users) + 1)
        users[sid] = form.get("name", ["?"])[0]
        self.send(303, b"", "text/plain", [("Location", "/dashboard"), ("Set-Cookie", "sid=" + sid + "; Path=/; HttpOnly")])

print("app on 8080", flush=True)
HTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
`;
const API = String.raw`import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"from": "api", "origin": self.headers.get("Origin")}).encode()
        self.send_response(200 if self.path in ("/hello", "/nocors") else 404)
        self.send_header("Content-Type", "application/json")
        if self.path == "/hello":
            self.send_header("Access-Control-Allow-Origin", "http://localhost:8080")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

print("api on 8081", flush=True)
HTTPServer(("127.0.0.1", 8081), Handler).serve_forever()
`;

const name = `preview-${Date.now()}`;
await fetch(`${ORIGIN}/api/pad/${name}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ writes: [{ path: "serve.py", content: SERVER }, { path: "app.py", content: APP }, { path: "api.py", content: API }] }),
});

const browser = await chromium.launch({
  channel: process.env.PAD_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log(`      pageerror: ${e.message.slice(0, 160)}`));
page.on("console", (m) => m.type() === "error" && console.log(`      console: ${m.text().slice(0, 160)}`));
await page.goto(`${ORIGIN}/${name}`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.locator(".xterm").first().click();

await page.keyboard.type("echo warm\n");
await page.waitForFunction(() => (document.querySelector(".xterm-screen")?.innerText ?? "").includes("warm"),
  null, { timeout: 300_000 });
await page.waitForTimeout(5000);

(await page.locator("#preview").isHidden())
  ? ok("the Preview button is hidden while nothing is listening")
  : fail("the Preview button showed before anything listened");

// Written through base64 rather than typed. Typing put the script through a
// JS string, then printf, then bash, and each one had an opinion about the
// quotes and backslashes in it. base64 has no characters any of those layers
// care about, so what reaches the file is what was meant.
//
// It used to be seeded through the store instead, until that turned out to
// leave the file empty in the sandbox — the seeding bug fixed on 15 September.
// Writing it here keeps this check about the preview rather than about that.
const encoded = Buffer.from(SERVER, "utf8").toString("base64");
await page.keyboard.type(`echo ${encoded} | base64 -d > serve.py\n`);
await page.waitForTimeout(5000);
await page.keyboard.type("python3 serve.py\n");

try {
  await page.waitForSelector("#preview:not([hidden])", { timeout: 60_000 });
  ok("the Preview button appears when something starts listening");
} catch {
  fail("the Preview button never appeared");
  const screen = await page.evaluate(() => document.querySelector(".xterm-screen")?.innerText ?? "");
  console.log("\n  --- terminal ---");
  console.log(screen.split("\n").filter((l) => l.trim()).slice(-12).map((l) => "      " + l).join("\n"));
  const errs = await page.evaluate(() => (window.__padErrors ?? []));
  if (errs.length) console.log(`  page errors: ${JSON.stringify(errs.slice(0, 3))}`);
  await browser.close(); pad.close(); host.close(); relay?.kill();
  await rm(padDir, { recursive: true, force: true });
  process.exit(1);
}

await page.click("#preview");
await page.waitForTimeout(12_000);
const frames = page.frames().filter((f) => f !== page.mainFrame() && !f.url().includes("/.wasmer/"));
let body = "";
for (const f of frames) body ||= await f.evaluate(() => document.body?.innerText ?? "").catch(() => "");
body.includes("hello from my folder")
  ? ok("the preview shows what the folder's own server returned")
  : fail(`the preview showed ${JSON.stringify(body.slice(0, 120))}`);

(await page.locator("#editor").isHidden())
  ? ok("the editor gives up its space while previewing")
  : fail("the editor stayed visible behind the preview");

await page.click("#preview");
await page.waitForTimeout(1500);
(await page.locator("#editor").isVisible())
  ? ok("pressing it again returns to the editor")
  : fail("the editor did not come back");

// `python3 -m http.server`, as everybody types it. It serves each request on
// a thread of its own, which cannot start here, so until 15 October it
// answered nothing; sitecustomize.py has it serve them in turn. A page with a
// stylesheet and a script is three requests, one after another.
await page.locator(".xterm").first().click();
await page.keyboard.press("Control+C");
await page.waitForTimeout(1500);
const SITE = {
  "index.html": "<!doctype html><link rel=stylesheet href=style.css><h1>hello from http.server</h1><p id=js></p><script src=app.js></script>",
  "style.css": "h1 { color: rgb(1, 2, 3); }",
  "app.js": "document.getElementById('js').textContent = 'and its script ran';",
};
for (const [file, text] of Object.entries(SITE)) {
  await page.keyboard.type(`echo ${Buffer.from(text, "utf8").toString("base64")} | base64 -d > ${file}\n`);
  await page.waitForTimeout(1500);
}
// On its own port, 8000: the preview has to follow it there from 8080.
await page.keyboard.type("python3 -m http.server\n");
await page.waitForFunction(() => /Serving HTTP on/.test(document.querySelector(".xterm-screen")?.innerText ?? ""), null, { timeout: 60_000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.click("#preview");
await page.waitForTimeout(10_000);
let site = { text: "", colour: "" };
for (const f of page.frames().filter((f) => f !== page.mainFrame() && !f.url().includes("/.wasmer/"))) {
  const seen = await f.evaluate(() => ({ text: document.body?.innerText ?? "", colour: document.querySelector("h1") ? getComputedStyle(document.querySelector("h1")).color : "" })).catch(() => null);
  if (seen?.text) site = seen;
}
site.text.includes("hello from http.server") && site.text.includes("and its script ran") && site.colour === "rgb(1, 2, 3)"
  ? ok("`python3 -m http.server` serves a page, its stylesheet and its script into the preview")
  : fail(`\`python3 -m http.server\` showed ${JSON.stringify(site)} — terminal: ${JSON.stringify((await page.evaluate(() => document.querySelector(".xterm-screen")?.innerText ?? "")).split("\n").filter((l) => l.trim()).slice(-6))}`);
await page.click("#preview");
await page.waitForTimeout(1000);

// ---------------------------------------------------------------- the browser
//
// The preview as a small browser, from 16 October: several servers by port,
// an address bar, back and forward, cookies that last, and what the page
// asked for and logged. Before then it was one iframe on one server, and a
// sign-in was forgotten on the next request.
const PREVIEW_ORIGIN = LIVE ? "https://preview.rishwanth.dev" : `http://127.0.0.1:${HOST_PORT}`;
const shown = () => page.frames().find((f) => f.url().startsWith(PREVIEW_ORIGIN) && !f.url().includes("/.wasmer/host.html") && f.parentFrame() === page.mainFrame());
const frameText = async () => (await shown()?.evaluate(() => document.body?.innerText ?? "").catch(() => "")) ?? "";
const until = async (test, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test().catch(() => false)) return true;
    await page.waitForTimeout(250);
  }
  return false;
};
const address = () => page.locator(".preview-url").inputValue();
const server = () => page.locator(".preview-port").inputValue();
const terminalText = (id) => page.evaluate((id) => document.querySelector(`#${id} .xterm-rows`)?.innerText ?? "", id);
const state = () => page.evaluate(() => window.__pad?.preview?.());

await page.locator("#terminal .xterm-helper-textarea").focus();
await page.keyboard.press("Control+C");
await page.waitForTimeout(1500);
// The API in a terminal of its own, then the app: the one started last is what the preview opens on.
await page.click("#new-terminal");
await page.locator("#terminal-2 .xterm-helper-textarea").focus();
await page.keyboard.type("python3 api.py\n");
await until(async () => /api on 8081/.test(await terminalText("terminal-2")), 60_000);
await page.locator("#tabs .tab", { hasText: "Terminal 1" }).click();
await page.locator("#terminal .xterm-helper-textarea").focus();
await page.keyboard.type("python3 app.py\n");
await until(async () => /app on 8080/.test(await terminalText("terminal")), 60_000);
await until(async () => (await state())?.listening.includes(8080) && (await state())?.listening.includes(8081));

// And a third terminal asking them, as a person tries an API beside the app.
// localhost there is the folder's servers, never this computer's, and a
// program's request is not a page's: no CORS to pass, no Origin sent.
await page.click("#new-terminal");
await page.locator("#terminal-3 .xterm-helper-textarea").focus();
const asked = async (command, expected, ms = 30_000) => {
  // Typed only once the last one is over: typed sooner, half the line went
  // to the command still finishing and half to the next prompt.
  await until(async () => (await page.evaluate(() => window.__pad?.terminals().find((t) => t.number === 3)?.busy)) === false);
  await page.keyboard.type(`clear; ${command}\n`);
  return until(async () => expected.test((await terminalText("terminal-3")).replace(/\n/g, "")), ms);
};
(await asked("curl -s localhost:8081/nocors", /"from": "api", "origin": null/))
  ? ok("curl in another terminal reaches the folder's server at localhost, with no CORS in the way")
  : fail(`curl localhost:8081 showed ${JSON.stringify(await terminalText("terminal-3"))}`);
(await asked(`python3 -c "import urllib.request; r = urllib.request.urlopen('http://127.0.0.1:8080/about'); print('got', r.status, r.read().decode().count('about page'))"`, /got 200 1/))
  ? ok("and so does Python's urllib")
  : fail(`urllib to 127.0.0.1:8080 showed ${JSON.stringify(await terminalText("terminal-3"))}`);
(await asked("echo cookies $(curl -s -i -X POST -d name=bob localhost:8080/login | grep -ci '^set-cookie: sid='); curl -s -o /dev/null -w 'code %{http_code}\\n' localhost:8080/nothing", /cookies 1.*code 404/))
  ? ok("with the server's own headers — a 303's Set-Cookie, since curl follows only with -L — and its status")
  : fail(`curl -i and -w showed ${JSON.stringify(await terminalText("terminal-3"))}`);
(await asked("echo landed $(curl -s -L -X POST -d name=bob localhost:8080/login | grep -c 'not signed in')", /landed 1/))
  ? ok("and with -L it follows them, to the page a browser without the cookie would end on")
  : fail(`curl -L showed ${JSON.stringify(await terminalText("terminal-3"))}`);
(await asked("curl -sS localhost:9999; echo exit $?", /nothing in the folder is listening there.*exit 7/))
  ? ok("and a port nothing listens on is refused in words")
  : fail(`curl localhost:9999 showed ${JSON.stringify(await terminalText("terminal-3"))}`);
await page.locator("#tabs .tab", { hasText: "Terminal 1" }).click();
await page.click("#preview");

(await until(async () => /signed|not signed in/.test(await frameText())))
  ? ok("the preview opens on the server started last")
  : fail(`the preview showed ${JSON.stringify((await frameText()).slice(0, 100))}; ${JSON.stringify(await state())}`);
const options = await page.locator(".preview-port option").allTextContents();
JSON.stringify(options) === JSON.stringify(["localhost:8080", "localhost:8081"]) && (await server()) === "8080"
  ? ok("every port something listens on is a server to pick, the one in front picked")
  : fail(`the servers offered were ${JSON.stringify(options)}, ${await server()} picked`);
(await until(async () => /api says api to http:\/\/localhost:8080/.test(await frameText())))
  ? ok("the page calls the API on another port by its localhost address, with the Origin it would send at localhost")
  : fail(`the page's call to localhost:8081 showed ${JSON.stringify(await frameText())}`);
(await until(async () => /nocors blocked/.test(await frameText())))
  ? ok("and one the API does not allow is refused, as a browser would")
  : fail(`a call without CORS headers showed ${JSON.stringify(await frameText())}`);
(await until(async () => (await address()) === "/?pushed=1"))
  ? ok("history.pushState in the page shows in the address bar")
  : fail(`the address bar said ${JSON.stringify(await address())}`);

await page.click(".preview-requests");
const logged = await until(async () => {
  const rows = await page.locator(".preview-log-row").allInnerTexts();
  return rows.some((r) => /GET\s+\/\s+200/.test(r)) && rows.some((r) => /localhost:8081\/hello\s+200/.test(r)) && rows.some((r) => /localhost:8081\/nocors\s+CORS/.test(r));
});
logged
  ? ok("the request log has the page, the call to the API, and the one CORS refused")
  : fail(`the request log was ${JSON.stringify(await page.locator(".preview-log-row").allInnerTexts())}`);
await page.locator(".preview-log-row", { hasText: "localhost:8081/hello" }).first().click();
const detail = await page.locator(".preview-log-detail").innerText().catch(() => "");
/access-control-allow-origin: http:\/\/localhost:8080/i.test(detail) && /"from": "api"/.test(detail)
  ? ok("and a request opens up to what was sent and what came back")
  : fail(`the request's detail was ${JSON.stringify(detail.slice(0, 300))}`);
await page.click(".preview-console");
(await until(async () => /hello console/.test(await page.locator(".preview-log-rows").innerText())))
  ? ok("the page's console.log is in the console")
  : fail(`the console showed ${JSON.stringify(await page.locator(".preview-log-rows").innerText())}`);
await page.click(".preview-console");

await shown()?.click("#go");
(await until(async () => /signed in as ada/.test(await frameText()) && (await address()) === "/dashboard"))
  ? ok("signing in sets a cookie through a redirect, and the address bar follows it")
  : fail(`after signing in the page said ${JSON.stringify(await frameText())} at ${JSON.stringify(await address())}`);
await page.click(".preview-reload");
await page.waitForTimeout(1500);
(await until(async () => /signed in as ada/.test(await frameText())))
  ? ok("and the cookie lasts: a reload is still signed in")
  : fail(`after a reload the page said ${JSON.stringify(await frameText())}`);

await shown()?.click("#about");
const atAbout = await until(async () => (await address()) === "/about" && /about page/.test(await frameText()));
await page.click(".preview-back");
const backAgain = await until(async () => (await address()) === "/dashboard" && /signed in as ada/.test(await frameText()));
await page.click(".preview-forward");
const forwardAgain = await until(async () => (await address()) === "/about" && /about page/.test(await frameText()));
atAbout && backAgain && forwardAgain
  ? ok("a link moves the address bar, and Back and Forward walk the pages")
  : fail(`link ${atAbout}, back ${backAgain}, forward ${forwardAgain}; ${JSON.stringify(await state())}`);

await page.locator(".preview-url").fill("/headers");
await page.locator(".preview-url").press("Enter");
// Host with its port, as a browser at localhost names it: the SDK's own is
// `localhost`, and a URL the server makes of it points at port 80. And the
// page's own cookie: the terminal's two sign-ins above were s1 and s2, and
// a program's cookies are not the page's.
const sent = await until(async () => /"cookie": "sid=s3"/i.test(await frameText()) && /"host": "localhost:8080"/i.test(await frameText()));
sent
  ? ok("a path typed into the address bar loads, and the server gets the page's own cookie, not the terminal's, and its own host and port")
  : fail(`typing /headers showed ${JSON.stringify(await frameText())}`);

await page.locator(".preview-url").fill("localhost:8081/hello");
await page.locator(".preview-url").press("Enter");
(await until(async () => (await server()) === "8081" && /"from": "api"/.test(await frameText())))
  ? ok("another server's address typed in goes to that server")
  : fail(`typing localhost:8081/hello showed ${JSON.stringify(await frameText())} on ${await server()}`);

await page.selectOption(".preview-port", "8080");
await until(async () => /home/.test(await frameText()));
await shown()?.click("#api");
(await until(async () => (await server()) === "8081" && /"from": "api"/.test(await frameText())))
  ? ok("a link to another server's localhost address goes to that server, not this computer's")
  : fail(`the link to localhost:8081 showed ${JSON.stringify(await frameText())} on ${await server()}`);

await page.selectOption(".preview-port", "8080");
await until(async () => /home/.test(await frameText()));
const popped = page.context().waitForEvent("page", { timeout: 15_000 }).catch(() => null);
await page.click(".preview-pop-out");
const tab = await popped;
const tabText = tab ? await tab.waitForSelector("h1", { timeout: 15_000 }).then(() => tab.innerText("body")).catch(() => "") : "";
/home/.test(tabText)
  ? ok("the page opens in a tab of its own")
  : fail(`the new tab showed ${JSON.stringify(tabText.slice(0, 120))}`);
await tab?.close();

// The browser stops an idle service worker, and a tab in the background is
// throttled until the worker's keepalive cannot keep it awake. Every route it
// held is gone then; the pad has to notice and make them again.
const cdp = await page.context().newCDPSession(page);
await cdp.send("ServiceWorker.enable");
await cdp.send("ServiceWorker.stopAllWorkers");
await page.waitForTimeout(1000);
await page.locator("#tabs .tab", { hasText: "Terminal 3" }).click();
await page.locator("#terminal-3 .xterm-helper-textarea").focus();
const curlAgain = await asked("echo again $(curl -s localhost:8081/hello | grep -c api)", /again 1/);
await page.click(".preview-reload");
const pageAgain = await until(async () => /signed in|not signed in/.test(await frameText()), 30_000);
curlAgain && pageAgain
  ? ok("with its service worker stopped, the terminal's request and the page both find their way back")
  : fail(`after the worker stopped, curl ${curlAgain}, page ${pageAgain}: ${JSON.stringify(await frameText())}`);
await page.locator("#tabs .tab", { hasText: "Terminal 1" }).click();

// Ctrl-C and run again, as after changing the code: the page comes back by itself.
await page.locator("#terminal .xterm-helper-textarea").focus();
await page.keyboard.press("Control+C");
const noticed = await until(async () => /stopped/.test(await page.locator(".preview-notice").innerText().catch(() => "")) && await page.locator(".preview-notice").isVisible(), 30_000);
await page.keyboard.type("python3 app.py\n");
const back = await until(async () => !(await page.locator(".preview-notice").isVisible()) && /not signed in|signed in as/.test(await frameText()), 60_000);
noticed && back
  ? ok("a server stopped says so over its page, and started again the page reloads")
  : fail(`stopped notice ${noticed}, reloaded ${back}; ${JSON.stringify(await state())}`);

await browser.close(); pad.close(); host.close(); relay?.kill();
await rm(padDir, { recursive: true, force: true });
const bad = results.filter((r) => !r).length;
console.log(bad ? `\n  ${bad} failed` : "\n  the preview works");
process.exitCode = bad ? 1 : 0;

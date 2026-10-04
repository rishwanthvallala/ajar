#!/usr/bin/env node
// Accounts, end to end: signing in, and who may do what to a pad.
//
// The relay is pointed at a stand-in for GitHub — a few lines of HTTP below
// that check PKCE the way the real one does — so signing in runs the whole
// flow without a network or a real app. Everything after that is the relay's
// own enforcement, tested from outside: the store API and the peer room, as a
// stranger, a viewer, an editor and the owner.
//
//   node scripts/smoke-accounts.mjs

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CH_DOC, encode, fail, finish, Guest, ok, Procs, sleep, waitForHealth } from "./lib/wire.mjs";

const PORT = 8851;
const PROVIDER_PORT = 8852;
const BARE_PORT = 8853;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const PROVIDER = `http://127.0.0.1:${PROVIDER_PORT}`;

const DOC_UPDATE = 0x01;
const DOC_NONE = 0x04;
const MAX_PADS = 3;
const MAX_BYTES = 64 * 1024;

const procs = new Procs();
const dir = mkdtempSync(join(tmpdir(), "ajar-accounts-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------ the provider

/** Who the stand-in says is signing in next. */
let nextUser = { id: 1, login: "ana" };
/** code -> what it was issued for. */
const issued = new Map();
/**
 * Whether the stand-in checks PKCE. Not every provider does, and where one
 * does not, the `state` matched against the starting browser's cookie is all
 * that stops a planted callback — so one check turns this off.
 */
let checkPkce = true;

const provider = createServer(async (req, res) => {
  const url = new URL(req.url, PROVIDER);
  if (url.pathname === "/authorize") {
    const code = `code-${Math.random().toString(36).slice(2)}`;
    issued.set(code, {
      user: nextUser,
      challenge: url.searchParams.get("code_challenge"),
      method: url.searchParams.get("code_challenge_method"),
      redirect: url.searchParams.get("redirect_uri"),
      client: url.searchParams.get("client_id"),
    });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() }).end();
    return;
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const grant = issued.get(form.get("code"));
    issued.delete(form.get("code"));
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const refuse = (why) => res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: why }));
    if (!grant) return refuse("unknown or reused code");
    if (checkPkce && (grant.method !== "S256" || grant.challenge !== challenge)) return refuse("PKCE verifier does not match");
    if (form.get("redirect_uri") !== grant.redirect) return refuse("redirect_uri differs");
    if (form.get("client_id") !== "test-client" || form.get("client_secret") !== "test-secret") return refuse("bad client");
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ access_token: `token-${grant.user.id}-${grant.user.login}`, token_type: "bearer" }),
    );
    return;
  }
  if (url.pathname === "/user") {
    const m = /^Bearer token-(\d+)-(\w+)$/.exec(req.headers.authorization ?? "");
    if (!m) return res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ id: Number(m[1]), login: m[2], name: null, email: null }),
    );
    return;
  }
  res.writeHead(404).end();
});

// ---------------------------------------------------------------- helpers

function startRelay() {
  return procs.start(
    "target/debug/ajar-relay",
    [
      "--bind", `127.0.0.1:${PORT}`,
      "--pad-dir", join(dir, "pads"),
      "--accounts-db", join(dir, "accounts.db"),
      "--account-max-pads", String(MAX_PADS),
      "--account-max-bytes", String(MAX_BYTES),
    ],
    "relay",
    {
      env: {
        ...process.env,
        AJAR_PUBLIC_ORIGIN: HTTP,
        AJAR_ADMINS: "github:101",
        AJAR_GITHUB_CLIENT_ID: "test-client",
        AJAR_GITHUB_CLIENT_SECRET: "test-secret",
        AJAR_GITHUB_AUTHORIZE_URL: `${PROVIDER}/authorize`,
        AJAR_GITHUB_TOKEN_URL: `${PROVIDER}/token`,
        AJAR_GITHUB_USERINFO_URL: `${PROVIDER}/user`,
      },
    },
  );
}

const manual = (url, init = {}) => fetch(url, { ...init, redirect: "manual" });

/** Leave for the provider and come back with a code: the callback to visit, and the cookie the start left. */
async function startSignIn(user, next = "/dashboard") {
  nextUser = user;
  const start = await manual(`${HTTP}/auth/github/start?next=${encodeURIComponent(next)}`);
  if (start.status !== 303) fail(`start answered ${start.status}`);
  const started = start.headers.getSetCookie().find((c) => c.startsWith("ajar-signin="));
  if (!started || !/HttpOnly/.test(started) || !/Max-Age=600/.test(started)) fail(`start left no sign-in cookie: ${started}`);
  const atProvider = await manual(start.headers.get("location"));
  return { callback: atProvider.headers.get("location"), started: started.split(";")[0] };
}

/** Sign in as `user` the way a browser would, hop by hop. */
async function signIn(user, next = "/dashboard") {
  const { callback, started } = await startSignIn(user, next);
  const back = await manual(callback, { headers: { cookie: started } });
  if (back.status !== 303) fail(`the callback answered ${back.status}: ${await back.text()}`);
  const cookies = back.headers.getSetCookie();
  const set = cookies.find((c) => c.startsWith("ajar="));
  if (!set) fail(`signing in set no cookie: ${cookies}`);
  if (!cookies.some((c) => /^ajar-signin=;.*Max-Age=0/.test(c))) fail(`the sign-in cookie was not spent: ${cookies}`);
  return { cookie: set.split(";")[0], set, location: back.headers.get("location"), callback, started };
}

function api(path, { cookie, code, method = "GET", body, intended = true } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (code) headers["x-pad-code"] = code;
  if (intended && method !== "GET") headers["x-ajar"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${HTTP}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const write = (name, files, who = {}) =>
  api(`/api/pad/${name}`, { ...who, method: "PUT", body: { writes: files }, intended: false });

const file = (path, content) => ({ path, content });

async function expectStatus(res, status, what) {
  if (res.status !== status) fail(`${what}: expected ${status}, got ${res.status} ${await res.text()}`);
  ok(`${what} — ${status}`);
  return res;
}

function peer(session, { code, cookie } = {}) {
  const p = new Guest(WS, session, "someone", null);
  p.role = "peer";
  p.code = code;
  if (cookie) p.headers = { cookie };
  p.docs = [];
  p.onDoc = (stream, kind) => p.docs.push({ stream, kind });
  return p;
}

function docFrom(p, kind) {
  const payload = new Uint8Array([kind, 1, 2, 3]);
  p.send(encode({ channel: CH_DOC, streamId: 7, target: p.participantId, payload }));
}

async function until(test, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await sleep(25);
  }
  fail(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------- main

async function main() {
  await new Promise((r) => provider.listen(PROVIDER_PORT, "127.0.0.1", r));
  startRelay();
  await waitForHealth(HTTP);
  ok("relay is up with sign-in pointed at a stand-in provider");

  // ----------------------------------------------------------- signing in
  let me = await (await api("/api/me")).json();
  if (me.user !== null || JSON.stringify(me.providers) !== '["github"]') fail(`/api/me before signing in: ${JSON.stringify(me)}`);
  ok("signed out, /api/me says nobody and offers github");

  const ana = await signIn({ id: 101, login: "ana" }, "/amber-x");
  if (ana.location !== "/amber-x") fail(`sign-in went to ${ana.location}, not where it was asked`);
  if (!/HttpOnly/.test(ana.set) || !/SameSite=Lax/.test(ana.set) || /Secure/.test(ana.set)) fail(`cookie flags: ${ana.set}`);
  ok("signed in through the provider with PKCE; HttpOnly, SameSite=Lax, and no Secure on plain http");
  me = await (await api("/api/me", { cookie: ana.cookie })).json();
  if (me.user?.name !== "ana" || me.user?.provider !== "github") fail(`/api/me signed in: ${JSON.stringify(me)}`);
  ok("/api/me knows ana");

  // The provider's code is single-use, so even the right browser cannot come
  // back twice.
  const noSession = (res) => !res.headers.getSetCookie().some((c) => c.startsWith("ajar=") && !/Max-Age=0/.test(c));
  const backWith = async (res, reason, what) => {
    const to = res.headers.get("location") ?? "";
    if (res.status !== 303 || !to.endsWith(`?signin=${reason}`) || !noSession(res)) fail(`${what}: ${res.status} to ${to}`);
    ok(`${what} — back to ${to}, nobody signed in`);
  };
  await backWith(await manual(ana.callback, { headers: { cookie: ana.started } }), "provider", "replaying the callback");

  // Login CSRF: somebody starts a sign-in as themselves and sends the
  // callback to someone else. Without the starter's cookie it signs nobody in.
  const planted = await startSignIn({ id: 666, login: "mallory" });
  await backWith(await manual(planted.callback), "not_started", "someone else's callback, in a browser with no sign-in of its own");
  // A browser mid-sign-in of its own has a cookie, just not this callback's.
  // PKCE would refuse it too — this browser's verifier is not the one the
  // code was issued for — so the provider stops checking, and the `state`
  // has to.
  const mine = await startSignIn({ id: 101, login: "ana" });
  checkPkce = false;
  await backWith(await manual(planted.callback, { headers: { cookie: mine.started } }), "elsewhere", "someone else's callback, in a browser that started its own, from a provider that skips PKCE");
  checkPkce = true;

  // Cancelled at the provider: back to where the sign-in began.
  const fromPad = await startSignIn({ id: 101, login: "ana" }, "/some-private-pad");
  const callbackUrl = new URL(fromPad.callback);
  callbackUrl.searchParams.delete("code");
  callbackUrl.searchParams.set("error", "access_denied");
  const cancelled = await manual(callbackUrl.toString(), { headers: { cookie: fromPad.started } });
  if (cancelled.headers.get("location") !== "/some-private-pad?signin=access_denied") fail(`a cancel went to ${cancelled.headers.get("location")}`);
  ok("cancelling a sign-in begun from a pad goes back to that pad, saying so");

  // A return address with what browsers strip while parsing: `/<tab>/evil`
  // is `//evil` — another site — by the time the browser has read it.
  for (const sneaky of ["/\t/evil.example", "/\n/evil.example", "/ /evil.example"]) {
    const signed = await signIn({ id: 101, login: "ana" }, sneaky);
    if (signed.location !== "/dashboard") fail(`a return address with a hidden // was followed: ${JSON.stringify(signed.location)}`);
  }
  ok("a return address hiding // behind a tab, newline or space becomes /dashboard");

  const bounced = await signIn({ id: 101, login: "ana" }, "//evil.example/x");
  if (bounced.location !== "/dashboard") fail(`an off-site return address was followed: ${bounced.location}`);
  ok("an off-site return address becomes /dashboard");

  const bo = await signIn({ id: 202, login: "bo" });

  // --------------------------------------------------------- making a pad
  await expectStatus(await api("/api/my/pads", { cookie: ana.cookie, method: "POST", intended: false }), 403, "making a pad without X-Ajar");
  await expectStatus(await api("/api/my/pads", { method: "POST" }), 401, "making a pad signed out");
  const made = await (await expectStatus(await api("/api/my/pads", { cookie: ana.cookie, method: "POST" }), 201, "ana makes a pad")).json();
  const name = made.name;
  if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(name)) fail(`not three words: ${name}`);
  const viewCode = made.links.find((l) => l.role === "viewer")?.code;
  const editCode = made.links.find((l) => l.role === "editor")?.code;
  if (!viewCode || !editCode || made.view !== "link" || made.edit !== "code") fail(`a new pad: ${JSON.stringify(made)}`);
  ok(`${name}: three words, a view link and an edit link, view by link and edit by link`);

  const theirs = await (await api("/api/my/pads", { cookie: bo.cookie })).json();
  if (theirs.length !== 0) fail("bo sees ana's pad");
  await expectStatus(await api(`/api/my/pads/${name}`, { cookie: bo.cookie, method: "DELETE" }), 404, "bo deleting ana's pad");

  // ------------------------------------------------------------ the store
  const role = async (who) => {
    const res = await api(`/api/pad/${name}`, who);
    return res.status === 200 ? (await res.json()).access.role : res.status;
  };
  await expectStatus(await write(name, [file("main.py", "print(1)\n")], { cookie: ana.cookie }), 200, "the owner writes");
  if ((await role({})) !== "viewer") fail("the bare name should view");
  if ((await role({ code: viewCode })) !== "viewer") fail("a view code should view");
  if ((await role({ code: editCode })) !== "editor") fail("an edit code should edit");
  if ((await role({ cookie: ana.cookie })) !== "owner") fail("the owner is not the owner");
  if ((await role({ cookie: bo.cookie, code: "not-a-real-code-at-all" })) !== "viewer") fail("a wrong code should fall back to the bare name");
  ok("store reads: bare name and view code view, edit code edits, the cookie owns");

  await expectStatus(await write(name, [file("x.py", "1")]), 403, "writing with the bare name");
  await expectStatus(await write(name, [file("x.py", "1")], { code: viewCode }), 403, "writing with a view code");
  await expectStatus(await write(name, [file("x.py", "1")], { code: editCode }), 200, "writing with an edit code");
  await expectStatus(await write(name, [file("x.py", "2")], { cookie: bo.cookie }), 403, "another account writing");

  // -------------------------------------------------------- the peer room
  const watcher = peer(name);
  await watcher.connect();
  const editor = peer(name, { code: editCode });
  await editor.connect();
  const owner = peer(name, { cookie: ana.cookie });
  await owner.connect();
  ok("a viewer, an editor and the owner are in the room");

  docFrom(watcher, DOC_UPDATE);
  docFrom(watcher, DOC_NONE);
  await until(() => editor.docs.some((d) => d.kind === DOC_NONE), "the viewer's DOC_NONE");
  if (editor.docs.some((d) => d.kind === DOC_UPDATE) || owner.docs.some((d) => d.kind === DOC_UPDATE)) fail("a viewer's edit reached the room");
  ok("the room drops a viewer's edit and passes its DOC_NONE");
  docFrom(editor, DOC_UPDATE);
  await until(() => watcher.docs.some((d) => d.kind === DOC_UPDATE), "the editor's edit at the viewer");
  ok("an editor's edit reaches the viewer");

  // ----------------------------------------------------- changing settings
  await expectStatus(
    await api(`/api/my/pads/${name}`, { cookie: ana.cookie, method: "PATCH", body: { view: "link", edit: "owner" } }),
    200,
    "ana locks editing to herself",
  );
  await until(() => editor.ws.readyState === WebSocket.CLOSED, "the editor to be closed");
  if (!editor.control.some((m) => m.t === "closed")) fail("the editor was closed without being told why");
  if (owner.ws.readyState !== WebSocket.OPEN) fail("the owner was closed too");
  ok("everyone but the owner is closed and told why; the owner stays");
  if ((await role({ code: editCode })) !== "viewer") fail("an edit code with editing locked should view");
  const lockedLink = (await (await api(`/api/pad/${name}`, { code: editCode })).json()).access.link;
  if (lockedLink !== "editor") fail(`a locked edit link should still say it is one, got ${lockedLink}`);
  ok("an edit link with editing locked is still reported as an edit link, so a viewer's page never passes it on");
  // A dialog holding an old copy of the edit setting changes only viewing:
  // editing must stay locked.
  await expectStatus(await api(`/api/my/pads/${name}`, { cookie: ana.cookie, method: "PATCH", body: { view: "link" } }), 200, "changing only who can view");
  const afterOne = await (await api(`/api/my/pads/${name}`, { cookie: ana.cookie })).json();
  if (afterOne.edit !== "owner") fail(`changing one setting put the other back: ${JSON.stringify([afterOne.view, afterOne.edit])}`);
  ok("changing one setting leaves the other as stored");
  await expectStatus(await write(name, [file("x.py", "3")], { code: editCode }), 403, "writing with an edit code once editing is locked");
  await editor.reconnect();
  editor.docs.length = 0;
  owner.docs.length = 0;
  docFrom(editor, DOC_UPDATE);
  docFrom(editor, DOC_NONE);
  await until(() => owner.docs.some((d) => d.kind === DOC_NONE), "the demoted editor's DOC_NONE");
  if (owner.docs.some((d) => d.kind === DOC_UPDATE)) fail("a demoted editor's edit reached the owner");
  ok("rejoining with the same edit code, it is a viewer in the room too");

  await api(`/api/my/pads/${name}`, { cookie: ana.cookie, method: "PATCH", body: { view: "code", edit: "code" } });
  if ((await role({})) !== 403) fail("the bare name should not open a pad viewed by link only");
  if ((await role({ code: viewCode })) !== "viewer") fail("a view code should still view");
  if ((await role({ code: editCode })) !== "editor") fail("an edit code should edit again, and its link was kept");
  try {
    await peer(name).connect();
    fail("a stranger joined a private pad's room");
  } catch (e) {
    if (!/^private:/.test(e.message)) fail(`a stranger was refused for the wrong reason: ${e.message}`);
  }
  ok("view by code: the bare name is refused in the store and the room; the codes still work");

  await api(`/api/my/pads/${name}`, { cookie: ana.cookie, method: "PATCH", body: { view: "owner", edit: "code" } });
  if ((await role({ code: viewCode })) !== 403) fail("a view code should not open a pad only its owner views");
  if ((await role({ code: editCode })) !== "editor") fail("an edit link always opens the pad");
  ok("view by owner: view codes are off, and an edit link still opens and edits");
  await api(`/api/my/pads/${name}`, { cookie: ana.cookie, method: "PATCH", body: { view: "link", edit: "code" } });

  // ------------------------------------------------------------- revoking
  const editLink = made.links.find((l) => l.role === "editor");
  const fresh = await (await expectStatus(
    await api(`/api/my/pads/${name}/links`, { cookie: ana.cookie, method: "POST", body: { role: "editor" } }),
    201,
    "a second edit link",
  )).json();
  await editor.reconnect();
  await expectStatus(await api(`/api/my/pads/${name}/links/${editLink.id}`, { cookie: ana.cookie, method: "DELETE" }), 204, "revoking the first edit link");
  if ((await role({ code: editCode })) !== "viewer") fail("a revoked edit code still edits");
  if ((await role({ code: fresh.code })) !== "editor") fail("the new edit code does not edit");
  await until(() => editor.ws.readyState === WebSocket.CLOSED, "the revoked editor to be closed");
  ok("a revoked code stops working at once, in the room too; the new one works");

  const listed = await (await api(`/api/my/pads/${name}`, { cookie: ana.cookie })).json();
  if (listed.links.some((l) => l.id === editLink.id) || !listed.links.some((l) => l.code === fresh.code)) fail(`the dashboard's links: ${JSON.stringify(listed.links)}`);
  ok("the dashboard shows the new link's code again, and not the revoked one");

  // Reset: one request makes a new edit link and stops every other.
  const holder = peer(name, { code: fresh.code });
  await holder.connect();
  const reset = await (await expectStatus(
    await api(`/api/my/pads/${name}/links`, { cookie: ana.cookie, method: "POST", body: { role: "editor", replace: true } }),
    201,
    "Reset the edit link",
  )).json();
  if ((await role({ code: fresh.code })) !== "viewer") fail("the edit link before a Reset still edits");
  if ((await role({ code: reset.code })) !== "editor") fail("the edit link a Reset made does not edit");
  if ((await role({ code: viewCode })) !== "viewer") fail("a Reset of edit links touched the view link");
  await until(() => holder.ws.readyState === WebSocket.CLOSED, "the old link's holder to be closed");
  ok("Reset stops the old edit link, in the store and the room, and leaves the view link alone");
  fresh.code = reset.code;

  // --------------------------------------------------------------- quotas
  const second = (await (await api("/api/my/pads", { cookie: ana.cookie, method: "POST" })).json()).name;
  await api("/api/my/pads", { cookie: ana.cookie, method: "POST" });
  await expectStatus(await api("/api/my/pads", { cookie: ana.cookie, method: "POST" }), 507, `a ${MAX_PADS + 1}th pad`);

  const big = "x".repeat(40 * 1024);
  await expectStatus(await write(name, [file("big.txt", big)], { cookie: ana.cookie }), 200, "40 KB into the first pad");
  const over = await write(second, [file("big.txt", big)], { cookie: ana.cookie });
  await expectStatus(over, 507, "40 KB more into the second, past the account's 64 KB");
  await expectStatus(await write(second, [file("big.txt", big)], { code: (await (await api(`/api/my/pads/${second}`, { cookie: ana.cookie })).json()).links.find((l) => l.role === "editor").code }), 507, "the same through an edit link — the owner's room, whoever writes");
  await expectStatus(await write(name, [file("big.txt", null)], { cookie: ana.cookie }), 200, "deleting the big file");
  await expectStatus(await write(second, [file("big.txt", big)], { cookie: ana.cookie }), 200, "now it fits");
  const info = await (await api(`/api/my/pads/${second}`, { cookie: ana.cookie })).json();
  if (info.bytes < big.length || info.files !== 1) fail(`sizes on the dashboard: ${JSON.stringify(info)}`);
  ok("the dashboard knows each pad's size");

  // Writes in parallel each used to see the same room, and together went
  // past it. One at a time per account now.
  await write(second, [file("big.txt", null)], { cookie: ana.cookie });
  const chunk = "y".repeat(30 * 1024);
  await Promise.all([name, second, name, second].map((pad, i) => write(pad, [file(`p${i}.txt`, chunk)], { cookie: ana.cookie })));
  const held = (await (await api("/api/my/pads", { cookie: ana.cookie })).json()).reduce((n, p) => n + p.bytes, 0);
  if (held > MAX_BYTES) fail(`parallel writes took the account to ${held} bytes, past ${MAX_BYTES}`);
  ok(`four parallel writes leave the account within its room (${held} of ${MAX_BYTES} bytes)`);
  for (const pad of [name, second]) await write(pad, [0, 1, 2, 3].map((i) => file(`p${i}.txt`, null)), { cookie: ana.cookie });

  // A hosted session opened under an owned pad's name would take the name
  // and keep the pad's own room shut. Against a pad whose room is empty —
  // the attack — because one with people in it refuses a host anyway, and a
  // check there passed with the fix taken out.
  const squatter = new Guest(WS, second, "squatter", null);
  squatter.role = "host";
  try {
    await squatter.connect();
    fail("a hosted session took an owned pad's name");
  } catch (e) {
    if (!/^wrong_shape:/.test(e.message)) fail(`a squatter was refused for the wrong reason: ${e.message}`);
  }
  const stillOpen = peer(second, { cookie: ana.cookie });
  await stillOpen.connect();
  stillOpen.ws.close();
  ok("nobody can open a hosted session under an owned pad's name, and its owner still gets in");

  // --------------------------------------------------------------- admin
  // Only the operators named in AJAR_ADMINS; anyone else is told there is
  // nothing there.
  await expectStatus(await api("/api/admin/stats"), 404, "the admin figures, signed out");
  await expectStatus(await api("/api/admin/stats", { cookie: bo.cookie }), 404, "the admin figures, for someone not named");
  const figures = await (await expectStatus(await api("/api/admin/stats", { cookie: ana.cookie }), 200, "the admin figures, for the operator")).json();
  if (figures.accounts.users < 2 || figures.store.pads < 1 || figures.accounts.signups.length !== figures.days || typeof figures.live.pad_rooms !== "number") fail(`admin figures: ${JSON.stringify(figures).slice(0, 300)}`);
  if ((await (await api("/api/me", { cookie: ana.cookie })).json()).admin !== true || (await (await api("/api/me", { cookie: bo.cookie })).json()).admin !== false) fail("/api/me does not say who is an admin");
  ok(`the operator sees ${figures.accounts.users} accounts and ${figures.store.pads} pads; /api/me says who is one`);

  // --------------------------------------------------------- what is stored
  const stored = Buffer.concat(["accounts.db", "accounts.db-wal"].map((f) => join(dir, f)).filter(existsSync).map((f) => readFileSync(f)));
  for (const [what, secret] of [["a session token", ana.cookie.split("=")[1]], ["an edit code", fresh.code], ["a view code", viewCode]]) {
    if (stored.includes(Buffer.from(secret))) fail(`${what} is in the database in the clear`);
  }
  ok("no session token or link code is in the database in the clear");

  // --------------------------------------------------------- surviving a restart
  procs.kill(procs.list.find((p) => p.label === "relay"));
  await sleep(300);
  startRelay();
  await waitForHealth(HTTP);
  if ((await role({ cookie: ana.cookie })) !== "owner") fail("the session or the pad did not survive a restart");
  if ((await role({ code: fresh.code })) !== "editor") fail("a link did not survive a restart");
  ok("sessions, pads and links survive a restart");

  // --------------------------------------------------------------- deleting
  const lingering = peer(name, { code: fresh.code });
  await lingering.connect();
  await expectStatus(await api(`/api/my/pads/${name}`, { cookie: ana.cookie, method: "DELETE" }), 204, "ana deletes the pad");
  await until(() => lingering.ws.readyState === WebSocket.CLOSED, "the room to empty");
  if ((await role({ cookie: ana.cookie })) !== 410) fail("a deleted pad should answer 410 — deleted, not private — even to its owner");
  await expectStatus(await write(name, [file("mine.py", "1")]), 410, "taking a deleted pad's name anonymously");
  try {
    await peer(name).connect();
    fail("someone joined a deleted pad's room");
  } catch (e) {
    if (!/^gone:/.test(e.message)) fail(`a deleted pad's room refused for the wrong reason: ${e.message}`);
  }
  ok("a deleted pad's room is emptied and its name is retired");

  // ----------------------------------------------------- anonymous pads
  const anon = "rustic-notch-5292";
  await expectStatus(await write(anon, [file("a.py", "1")]), 200, "an anonymous pad, as before");
  if ((await (await api(`/api/pad/${anon}`)).json()).access.role !== "editor") fail("an anonymous pad should be anybody's to edit");
  const a1 = peer(anon);
  const a2 = peer(anon);
  await a1.connect();
  await a2.connect();
  docFrom(a1, DOC_UPDATE);
  await until(() => a2.docs.some((d) => d.kind === DOC_UPDATE), "an edit in an anonymous room");
  ok("anonymous pads are untouched: anyone reads, writes and edits live");

  // ------------------------------------------------------------- signing out
  // A second pad, open as owner in two sign-ins — this one and another
  // device's — with a viewer beside them.
  const kept = (await (await api("/api/my/pads", { cookie: ana.cookie, method: "POST" })).json()).name;
  const elsewhere = await signIn({ id: 101, login: "ana" });
  const ownerHere = peer(kept, { cookie: ana.cookie });
  const ownerThere = peer(kept, { cookie: elsewhere.cookie });
  const looker = peer(kept);
  for (const p of [ownerHere, ownerThere, looker]) await p.connect();
  await expectStatus(await api("/auth/logout", { cookie: ana.cookie, method: "POST", intended: false }), 403, "signing out without X-Ajar");
  const out = await expectStatus(await api("/auth/logout", { cookie: ana.cookie, method: "POST" }), 204, "signing out");
  if (!out.headers.getSetCookie().some((c) => /^ajar=;.*Max-Age=0/.test(c))) fail("signing out did not clear the cookie");
  me = await (await api("/api/me", { cookie: ana.cookie })).json();
  if (me.user !== null) fail("the old cookie still signs in");
  ok("signed out: the cookie is cleared and the old token is dead");
  // Owner was decided at the door; signed out, it must not outlive the sign-in.
  await until(() => ownerHere.ws.readyState === WebSocket.CLOSED, "the signed-out owner's room connection to close");
  if (!ownerHere.control.some((m) => m.t === "closed" && /signed out/.test(m.reason ?? ""))) fail(`the signed-out owner was closed without being told why: ${JSON.stringify(ownerHere.control)}`);
  await sleep(200);
  if (ownerThere.ws.readyState !== WebSocket.OPEN || looker.ws.readyState !== WebSocket.OPEN) fail("signing out closed another sign-in's page, or a viewer's");
  ok("signing out closes that sign-in's owner connections, and only those");
  const back = peer(kept, { cookie: ana.cookie });
  await back.connect();
  docFrom(back, DOC_UPDATE);
  await sleep(300);
  if (looker.docs.some((d) => d.kind === DOC_UPDATE)) fail("a page that signed out still edits the room as owner");
  ok("reconnecting with the dead cookie is a viewer: its edits reach nobody");

  // ------------------------------------------------------- deleting the account
  const bystander = (await (await api("/api/my/pads", { cookie: bo.cookie, method: "POST" })).json()).name;
  const accountsBefore = (await (await api("/api/admin/stats", { cookie: elsewhere.cookie })).json()).accounts?.users;
  await expectStatus(await api("/api/me", { cookie: elsewhere.cookie, method: "DELETE", intended: false }), 403, "deleting an account without X-Ajar");
  await expectStatus(await api("/api/me", { method: "DELETE" }), 401, "deleting an account while signed out");
  const deletedMe = await expectStatus(await api("/api/me", { cookie: elsewhere.cookie, method: "DELETE" }), 204, "ana deletes her account");
  if (!deletedMe.headers.getSetCookie().some((c) => /^ajar=;.*Max-Age=0/.test(c))) fail("deleting the account did not clear the cookie");
  await until(() => looker.ws.readyState === WebSocket.CLOSED && ownerThere.ws.readyState === WebSocket.CLOSED, "the deleted account's pad's room to empty");
  if ((await (await api("/api/me", { cookie: elsewhere.cookie })).json()).user !== null) fail("a deleted account's sign-in still works");
  await expectStatus(await api(`/api/pad/${kept}`), 410, "a deleted account's pad");
  await expectStatus(await write(kept, [file("mine.py", "1")]), 410, "taking a deleted account's pad's name");
  try {
    await peer(kept).connect();
    fail("someone joined a deleted account's pad's room");
  } catch (e) {
    if (!/^gone:/.test(e.message)) fail(`a deleted account's pad's room refused for the wrong reason: ${e.message}`);
  }
  if ((await (await api(`/api/pad/${bystander}`, { cookie: bo.cookie })).json()).access?.role !== "owner") fail("deleting ana's account touched bo's pad");
  const reborn = await signIn({ id: 101, login: "ana" });
  // One gone and one new: kept beside it, the old one would make it one more.
  const accountsAfter = (await (await api("/api/admin/stats", { cookie: reborn.cookie })).json()).accounts?.users;
  if (typeof accountsBefore !== "number" || accountsAfter !== accountsBefore) fail(`the old account was kept: ${accountsBefore} accounts before, ${accountsAfter} after signing in again`);
  if ((await (await api("/api/my/pads", { cookie: reborn.cookie })).json()).length !== 0) fail("signing in again brought the deleted pads back");
  if ((await (await api(`/api/pad/${kept}`, { cookie: reborn.cookie })).status) !== 410) fail("signing in again made her owner of a deleted pad");
  ok("a deleted account takes its pads and sign-ins with it, leaves others' pads alone, and signing in again starts afresh");

  // --------------------------------------------- a relay with nothing set up
  procs.start("target/debug/ajar-relay", ["--bind", `127.0.0.1:${BARE_PORT}`, "--pad-dir", join(dir, "bare-pads"), "--accounts-db", join(dir, "bare.db")], "bare relay", {
    env: { ...process.env, AJAR_PUBLIC_ORIGIN: "", AJAR_GITHUB_CLIENT_ID: "" },
  });
  await waitForHealth(`http://127.0.0.1:${BARE_PORT}`);
  me = await (await fetch(`http://127.0.0.1:${BARE_PORT}/api/me`)).json();
  if (me.providers.length !== 0) fail("a relay with no sign-in set up offers some");
  await expectStatus(await fetch(`http://127.0.0.1:${BARE_PORT}/auth/github/start`, { redirect: "manual" }), 404, "starting a sign-in nobody set up");
  ok("without configuration, nothing is offered and pads work as before");

  provider.close();
  finish(procs, "accounts: sign-in and roles hold in the store and the room");
}

main().catch((e) => {
  console.error(e);
  for (const p of procs.list) console.error(`--- ${p.label}\n${p.output.slice(-3000)}`);
  process.exit(1);
});

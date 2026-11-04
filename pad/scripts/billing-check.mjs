#!/usr/bin/env node
// Paying for the paid plan in the browser: /pricing signed out and signed in,
// a payment begun, left by Back and carried on, paid on Razorpay's page and
// back on the paid plan; one paid with the tab closed before the way back,
// found when the page next looks; and the dashboard saying which plan, and
// until when.
//
// Razorpay is a stand-in here (below) that makes payment links, shows a page
// to pay one on, and sends the payer back signed with the key's secret as
// Razorpay does. The relay's own tests (serving_tests.rs) prove the signature
// and the webhook; this one proves the pages make sense of them.
//
//   npx vite build && cargo build -p ajar-relay && node scripts/billing-check.mjs

import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = 5216;
const RELAY_PORT = 8880;
const PROVIDER_PORT = 8881;
const RAZORPAY_PORT = 8882;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PROVIDER = `http://127.0.0.1:${PROVIDER_PORT}`;
const RAZORPAY = `http://127.0.0.1:${RAZORPAY_PORT}`;
const KEY_ID = "rzp_test_check";
const KEY_SECRET = "check-secret";

const results = [];
const ok = (m) => results.push(`ok   ${m}`);
const fail = (m) => results.push(`FAIL ${m}`);
const is = (a, b, m) => (a === b ? ok(m) : fail(`${m} — got ${JSON.stringify(a)}`));
const yes = (v, m) => (v ? ok(m) : fail(m));

// ------------------------------------------------- a stand-in for GitHub

const issued = new Map();
const provider = createServer(async (req, res) => {
  const url = new URL(req.url, PROVIDER);
  if (url.pathname === "/authorize") {
    const code = `c${Math.random().toString(36).slice(2)}`;
    issued.set(code, url.searchParams.get("code_challenge"));
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    return res.writeHead(302, { location: back.toString() }).end();
  }
  if (url.pathname === "/token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (issued.get(form.get("code")) !== challenge) return res.writeHead(400).end('{"error":"pkce"}');
    issued.delete(form.get("code"));
    return res.writeHead(200, { "content-type": "application/json" }).end('{"access_token":"t-ravi"}');
  }
  if (url.pathname === "/user") {
    if (req.headers.authorization !== "Bearer t-ravi") return res.writeHead(401).end();
    return res.writeHead(200, { "content-type": "application/json" }).end('{"id":11,"login":"ravi","name":"Ravi"}');
  }
  res.writeHead(404).end();
});
await new Promise((r) => provider.listen(PROVIDER_PORT, "127.0.0.1", r));

// ------------------------------------------------- a stand-in for Razorpay

/** Every link asked for, by id: what it was asked with, and how it stands. */
const links = new Map();
const asked = [];
const razorpay = createServer(async (req, res) => {
  const url = new URL(req.url, RAZORPAY);
  const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const authorised = req.headers.authorization === `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}`;
  if (req.method === "POST" && url.pathname === "/v1/payment_links") {
    if (!authorised) return json(401, { error: { description: "bad key" } });
    let body = "";
    for await (const chunk of req) body += chunk;
    const link = JSON.parse(body);
    const id = `plink_${links.size + 1}`;
    asked.push(link);
    links.set(id, { ...link, id, status: "created", payment: null });
    return json(200, { id, short_url: `${RAZORPAY}/pay/${id}`, status: "created" });
  }
  const one = /^\/v1\/payment_links\/([\w-]+)$/.exec(url.pathname);
  if (req.method === "GET" && one) {
    if (!authorised) return json(401, { error: { description: "bad key" } });
    const link = links.get(one[1]);
    if (!link) return json(404, { error: { description: "no such link" } });
    return json(200, {
      id: link.id,
      status: link.status,
      amount_paid: link.status === "paid" ? link.amount : 0,
      payments: link.payment ? [{ payment_id: link.payment, status: "captured", amount: link.amount, method: "upi" }] : null,
    });
  }
  // Razorpay's page for a link, and paying on it: sent back as Razorpay
  // sends a payer, or — `quietly` — left there, as if the tab were closed.
  const page = /^\/pay\/([\w-]+)(?:\/(paid|quietly))?$/.exec(url.pathname);
  if (page && links.has(page[1])) {
    const link = links.get(page[1]);
    if (!page[2]) {
      return res
        .writeHead(200, { "content-type": "text/html" })
        .end(`<!doctype html><title>Razorpay</title><h1>Pay ₹${link.amount / 100}</h1><p id="for">${link.description}</p><a id="pay" href="/pay/${link.id}/paid">Pay</a> <a id="quietly" href="/pay/${link.id}/quietly">Pay and close</a>`);
    }
    if (link.status !== "paid") {
      link.status = "paid";
      link.payment = `pay_${link.id.slice(6)}`;
    }
    if (page[2] === "quietly") return res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Paid</title><p id='done'>Paid. You can close this tab.</p>");
    const status = "paid";
    const signature = createHmac("sha256", KEY_SECRET).update(`${link.id}|${link.reference_id}|${status}|${link.payment}`).digest("hex");
    const back = new URL(link.callback_url);
    for (const [k, v] of Object.entries({
      razorpay_payment_id: link.payment,
      razorpay_payment_link_id: link.id,
      razorpay_payment_link_reference_id: link.reference_id,
      razorpay_payment_link_status: status,
      razorpay_signature: signature,
    }))
      back.searchParams.set(k, v);
    return res.writeHead(302, { location: back.toString() }).end();
  }
  res.writeHead(404).end();
});
await new Promise((r) => razorpay.listen(RAZORPAY_PORT, "127.0.0.1", r));

// ------------------------------------------------------ relay and page

const dir = await mkdtemp(join(tmpdir(), "ajar-billing-check-"));
const relay = spawn(
  fileURLToPath(new URL("../../target/debug/ajar-relay", import.meta.url)),
  ["--bind", `127.0.0.1:${RELAY_PORT}`, "--pad-dir", join(dir, "pads"), "--accounts-db", join(dir, "accounts.db")],
  {
    stdio: "ignore",
    env: {
      ...process.env,
      AJAR_PUBLIC_ORIGIN: ORIGIN,
      AJAR_GITHUB_CLIENT_ID: "id",
      AJAR_GITHUB_CLIENT_SECRET: "secret",
      AJAR_GITHUB_AUTHORIZE_URL: `${PROVIDER}/authorize`,
      AJAR_GITHUB_TOKEN_URL: `${PROVIDER}/token`,
      AJAR_GITHUB_USERINFO_URL: `${PROVIDER}/user`,
      AJAR_RAZORPAY_KEY_ID: KEY_ID,
      AJAR_RAZORPAY_KEY_SECRET: KEY_SECRET,
      AJAR_RAZORPAY_API: RAZORPAY,
      // Two plans that differ where the cards can show it.
      AJAR_FREE_PAD_MAX_BYTES: "50MiB",
      AJAR_PAID_PAD_MAX_BYTES: "200MiB",
      AJAR_FREE_ACCOUNT_MAX_PADS: "10",
      AJAR_PAID_ACCOUNT_MAX_PADS: "50",
      AJAR_FREE_ACCOUNT_MAX_BYTES: "100MiB",
      AJAR_PAID_ACCOUNT_MAX_BYTES: "1GiB",
      AJAR_PAID_PRICE_INR: "99",
      AJAR_PAID_DAYS: "30",
    },
  },
);
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://127.0.0.1:${RELAY_PORT}/healthz`).then(() => true).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}

const TYPES = { ".html": "text/html", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };
const IMPORTMAP_SHA = createHash("sha256")
  .update(/<script type="importmap">(.*?)<\/script>/s.exec(await readFile(join(ROOT, "index.html"), "utf8"))[1].replace(/\r\n?/g, "\n"))
  .digest("base64");
/** What Caddy serves as pages of their own, off disk. */
const STATIC = { "/privacy": "privacy.html", "/terms": "terms.html" };

const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  // The deployed policy, so nothing here works only because it is looser.
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'unsafe-eval' blob: 'sha256-${IMPORTMAP_SHA}'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss: https:; frame-ancestors 'none'; base-uri 'none'`,
  );
  const urlPath = new URL(req.url, "http://x").pathname;
  if (urlPath.startsWith("/api/") || urlPath.startsWith("/auth/")) {
    const up = httpRequest({ host: "127.0.0.1", port: RELAY_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end("relay unreachable"));
    return req.pipe(up);
  }
  const relative = STATIC[urlPath] ?? urlPath.split("/").filter((p) => p && p !== "." && p !== "..").join("/");
  const file = join(ROOT, relative || "index.html");
  try {
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.setHeader("Content-Type", "text/html");
    res.end(await readFile(join(ROOT, "index.html")));
  }
});
await new Promise((r) => server.listen(PORT, r));

// ------------------------------------------------------------- the checks

const browser = await chromium.launch({ channel: process.env.PAD_BROWSER_CHANNEL || undefined });
const context = await browser.newContext();
const page = await context.newPage();
page.on("pageerror", (e) => fail(`page error: ${e.message.slice(0, 160)}`));
page.on("console", (m) => {
  if (/Content Security Policy|Refused to/i.test(m.text())) fail(`CSP: ${m.text().slice(0, 160)}`);
});
const shown = (selector) => page.locator(selector).first().isVisible().catch(() => false);
const words = (selector) => page.locator(selector).first().innerText().catch(() => "");
const day = (seconds) => new Date(seconds * 1000).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });

try {
  // Signed out: both plans, the price, and the way to pay is to sign in.
  await page.goto(`${ORIGIN}/pricing`);
  await page.waitForSelector("#plan-paid", { timeout: 20_000 });
  is(await page.title(), "Plans — pad", "/pricing is the plans page");
  const free = await words("#plan-free");
  const paid = await words("#plan-paid");
  yes(/₹0/.test(free) && /Up to 50 MB and 500 files/.test(free) && /10 pads of your own, 100 MB in all/.test(free), "the free plan's card says what it holds, from the relay's limits");
  yes(/₹99/.test(paid) && /for 30 days/.test(paid) && /Up to 200 MB/.test(paid) && /50 pads of your own, 1 GB in all/.test(paid), "and the paid plan's, with its price");
  yes(await shown(".test-mode"), "Razorpay's test keys are said to move no money");
  yes(!(await shown("#pay")), "signed out, there is no button to pay");
  yes(await shown("#plan-paid .provider-github"), "but a way to sign in, from the paid plan's card");
  yes(!(await shown(".standing")), "and no plan is called yours");
  const how = await words(".pay-how");
  yes(/UPI/.test(how) && /Razorpay/.test(how), "how paying works is said: Razorpay, then UPI");
  is(await page.locator(".faq-item").count() >= 5, true, "the questions are there");
  await page.locator(".faq-item summary").first().click();
  yes(/nothing is ever taken again/.test(await words(".faq-item[open]")), "and open to their answers");

  // A phone's width: nothing runs off the side.
  await page.setViewportSize({ width: 375, height: 800 });
  is(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "on a phone the page fits its width");
  const order = await page.evaluate(() => [...document.querySelectorAll(".plan")].map((p) => p.getBoundingClientRect().top));
  yes(order.length === 2 && order[1] < order[0], "and the paid plan comes first, where the button is");
  await page.setViewportSize({ width: 1280, height: 900 });

  // The terms and refunds, where Razorpay's review and the page's links look.
  await page.goto(`${ORIGIN}/terms`);
  yes(/Refunds and cancellation/.test(await page.locator("body").innerText()), "/terms says how refunds and cancelling work");

  // Signing in from the plans page comes back to it.
  await page.goto(`${ORIGIN}/pricing`);
  await page.locator("#plan-paid .provider-github").click();
  await page.waitForURL(`${ORIGIN}/pricing`, { timeout: 20_000 });
  await page.waitForSelector("#pay", { timeout: 20_000 });
  ok("signing in from the plans page comes back to it");
  is((await words(".standing")).trim(), "You're on the free plan.", "it says which plan the account is on");
  yes(/Your plan/.test(await words("#plan-free")), "and marks it");
  is((await words("#pay")).trim(), "Pay ₹99 with UPI", "the paid plan's card offers to pay");

  // The dashboard points here.
  await page.goto(`${ORIGIN}/dashboard`);
  await page.waitForSelector(".plan-link:not([hidden])", { timeout: 20_000 });
  is((await words(".plan-link")).trim(), "More room with the paid plan", "the dashboard of a free account offers the paid plan");
  yes(/^Free plan/.test(await words(".page-usage")), "and says it is on the free one");
  await page.locator(".account-button").click();
  yes(await shown('.menu-item[href="/pricing"]'), "the account menu leads to the plan and payments");
  await page.locator(".plan-link").click();
  await page.waitForSelector("#pay", { timeout: 20_000 });

  // Pay: to Razorpay's page, for one ₹99 UPI payment that comes back here.
  await page.locator("#pay").click();
  await page.waitForURL(/\/pay\/plink_1$/, { timeout: 20_000 });
  ok("Pay goes to Razorpay's page for the payment");
  const link = asked[0];
  is(link?.amount, 9900, "for ₹99, in paise");
  is(link?.currency, "INR", "in rupees");
  is(link?.callback_url, `${ORIGIN}/api/billing/return`, "to come back to this site");
  const methods = link?.options?.checkout?.method ?? {};
  is(JSON.stringify(Object.keys(methods).sort().map((k) => `${k}=${methods[k]}`)), JSON.stringify(["card=0", "netbanking=0", "upi=1", "wallet=0"]), "by UPI alone");
  is(link?.customer?.name, "Ravi", "with the payer's name, so Razorpay's page need not ask");

  // Back without paying: the payment is still there to finish.
  await page.goBack();
  await page.waitForSelector("#pay", { timeout: 20_000 });
  is((await words("#pay")).trim(), "Continue paying ₹99", "Back from Razorpay's page offers to carry on with the same payment");
  yes(/You began a payment at/.test(await words("#plan-paid")), "and says when it began and until when it can be finished");
  await page.locator("#pay").click();
  await page.waitForURL(/\/pay\/plink_1$/, { timeout: 20_000 });
  is(asked.length, 1, "carrying on is the same payment, not a second link");

  // Paid: back here, on the paid plan, at once.
  await page.locator("#pay").click();
  await page.waitForURL(/\/pricing\?payment=ajar-/, { timeout: 20_000 });
  await page.waitForSelector(".pay-outcome-ok", { timeout: 20_000 });
  const outcome = await words(".pay-outcome");
  const me = await page.evaluate(() => fetch("/api/me").then((r) => r.json()));
  yes(me.plan === "paid" && me.paid_until > Date.now() / 1000 + 29 * 86400, "the payment puts the account on the paid plan for thirty days");
  yes(/Payment received/.test(outcome) && outcome.includes(day(me.paid_until)), "the page says the payment came in, and until when it holds");
  yes(/pay_1/.test(outcome), "with Razorpay's reference for it");
  yes((await words(".standing")).includes("30 days left"), "the plan line counts the days left");
  yes(/Your plan/.test(await words("#plan-paid")), "the paid plan is marked as the account's");
  is((await words("#pay")).trim(), "Add 30 days — ₹99", "and more days can be added");
  yes(/Paid/.test(await words(".pay-history tbody tr")), "the payment is listed as paid");

  // The next one paid with the tab closed before Razorpay sent it back:
  // found when the page next looks.
  await page.locator("#pay").click();
  await page.waitForURL(/\/pay\/plink_2$/, { timeout: 20_000 });
  await page.locator("#quietly").click();
  await page.waitForSelector("#done");
  await page.goto(`${ORIGIN}/pricing`);
  await page.waitForSelector("#pay", { timeout: 20_000 });
  yes((await words(".standing")).includes("60 days left"), "a payment whose way back never came is found when the page looks, and adds its days");
  is(await page.locator(".pay-history tbody tr").count(), 2, "both payments are listed");

  // The dashboard says so too.
  await page.goto(`${ORIGIN}/dashboard`);
  await page.waitForSelector(".plan-link:not([hidden])", { timeout: 20_000 });
  yes(/^Paid plan/.test(await words(".page-usage")) && /of 50 pads/.test(await words(".page-usage")), "the dashboard counts against the paid plan's room");
  yes((await words(".plan-link")).startsWith("Paid plan until"), "and says until when it is paid for");
  // Deleting the account says the days go with it — and is cancelled here.
  await page.locator(".dash-account .btn-quiet-danger").click();
  const asking = await words("dialog[open]");
  yes(/days left on your paid plan go with it/.test(asking), "deleting the account says its paid days go with it");
  await page.keyboard.press("Escape");

  // A payment that is not this account's says so, rather than waiting.
  await page.goto(`${ORIGIN}/pricing?payment=ajar-someone-else`);
  await page.waitForSelector(".pay-outcome:not([hidden])", { timeout: 20_000 });
  yes(/isn't this account's/.test(await words(".pay-outcome")), "a payment of another account's is said to be one");
} catch (e) {
  fail(e.message.split("\n")[0]);
  await page.screenshot({ path: fileURLToPath(new URL("../failed-billing.png", import.meta.url)) }).catch(() => {});
  results.push(`note: at ${page.url()}`);
}

await browser.close();
server.close();
provider.close();
razorpay.close();
relay.kill();
await rm(dir, { recursive: true, force: true });

for (const line of results) console.log(`  ${line}`);
const failed = results.filter((l) => l.startsWith("FAIL"));
if (failed.length) console.log(`\n  failed:\n${failed.map((l) => `    ${l}`).join("\n")}`);
console.log(failed.length ? `\n  ${failed.length} failed\n` : "\n  paying works in the browser\n");
process.exit(failed.length ? 1 : 0);

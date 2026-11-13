#!/usr/bin/env node
// Every inline script of the built pad page, allowed by the front's
// Content-Security-Policy, which names each by its hash.
//
//   npx vite build && node pad/scripts/csp-check.mjs
//
// On 21 October the build changed the import map — the page's one inline
// script — and the browser refused it, and with it the SDK's import of wisp:
// no command started in the live pad until the next deploy. No other check
// here sends the policy, so all of them passed. scripts/check.sh runs this
// after the build, and deploy.sh before it ships one.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
// The pad's policy as each front sends it: nginx's since 14 November
// (deploy/nginx/code-headers.conf), Caddy's while it is still kept for going
// back. Both are checked, and have to be the same policy, so the two cannot
// drift apart while either may be the one serving.
const policyOf = (file) => {
  const text = readFileSync(`${REPO}${file}`, "utf8");
  return /Content-Security-Policy "([^"]*sha256-[^"]*)"/.exec(text)?.[1] ?? null;
};
const fronts = ["deploy/nginx/code-headers.conf", "deploy/Caddyfile"].filter((f) => {
  try {
    readFileSync(`${REPO}${f}`);
    return true;
  } catch {
    return false;
  }
});
const policies = fronts.map((f) => [f, policyOf(f)]);
for (const [f, policy] of policies) {
  if (!policy) {
    console.error(`  ${f} has no Content-Security-Policy with a script hash in it`);
    process.exit(1);
  }
}
if (new Set(policies.map(([, p]) => p)).size > 1) {
  console.error(`  the pad's Content-Security-Policy differs between ${fronts.join(" and ")} — make them the same`);
  process.exit(1);
}
const csp = policies[0][1];
const page = readFileSync(`${REPO}pad/dist/index.html`, "utf8");
let refused = 0;
for (const [, attrs, body] of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (/\bsrc=/.test(attrs)) continue;
  const hash = `sha256-${createHash("sha256").update(body).digest("base64")}`;
  if (csp.includes(`'${hash}'`)) continue;
  refused++;
  console.error(`  ${hash} is not in the policy's script-src (${fronts.join(", ")}): ${body.trim().slice(0, 60).replace(/\s+/g, " ")}…`);
}
if (refused) {
  console.error(`  the live page would refuse it — add its hash to script-src in ${fronts.join(" and ")}, or leave the script as it was`);
  process.exit(1);
}
console.log("  every inline script of the pad's page is one the Content-Security-Policy allows");

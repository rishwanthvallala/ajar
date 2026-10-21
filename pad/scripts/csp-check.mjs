#!/usr/bin/env node
// Every inline script of the built pad page, allowed by the Caddyfile's
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
const csp = readFileSync(`${REPO}deploy/Caddyfile`, "utf8");
const page = readFileSync(`${REPO}pad/dist/index.html`, "utf8");
let refused = 0;
for (const [, attrs, body] of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (/\bsrc=/.test(attrs)) continue;
  const hash = `sha256-${createHash("sha256").update(body).digest("base64")}`;
  if (csp.includes(`'${hash}'`)) continue;
  refused++;
  console.error(`  ${hash} is not in the Caddyfile's script-src: ${body.trim().slice(0, 60).replace(/\s+/g, " ")}…`);
}
if (refused) {
  console.error("  the live page would refuse it — add its hash to script-src in deploy/Caddyfile, or leave the script as it was");
  process.exit(1);
}
console.log("  every inline script of the pad's page is one the Content-Security-Policy allows");

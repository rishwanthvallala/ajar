const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "..");
const web = path.join(root, "web");
const pad = path.join(root, "pad");
const webRequire = createRequire(path.join(web, "package.json"));
const padRequire = createRequire(path.join(pad, "package.json"));
const servers = [];

function start(cwd, vite, args) {
  const child = spawn(process.execPath, [vite, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      log.push(chunk.toString());
      if (log.length > 30) log.shift();
    });
  }
  child.recentLog = log;
  servers.push(child);
  return child;
}

async function ready(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server for ${url} exited early:\n${child.recentLog.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}:\n${child.recentLog.join("")}`);
}

function run(file, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} exited with ${code ?? signal}`));
    });
  });
}

async function checkBoots() {
  const { chromium } = webRequire("playwright");
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : undefined,
    headless: true,
  });
  try {
    const context = await browser.newContext();
    const ajar = await context.newPage();
    await ajar.goto("http://127.0.0.1:5174/");
    await ajar.locator(".landing").waitFor({ state: "attached" });

    const padPage = await context.newPage();
    const padErrors = [];
    padPage.on("pageerror", (error) => padErrors.push(`pageerror: ${error.message}`));
    padPage.on("requestfailed", (request) =>
      padErrors.push(`request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown"})`),
    );
    await padPage.route("**/api/pad/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exists: false, seq: 0, files: {} }),
      }),
    );
    await padPage.goto("http://127.0.0.1:5175/ui-01-foundation");
    await padPage.locator(".monaco-editor").waitFor({ state: "attached" }).catch(async (error) => {
      const status = await padPage.locator("#status").textContent().catch(() => null);
      throw new Error(
        `${error.message}\nPad status: ${status ?? "missing"}\n${padErrors.join("\n")}`,
      );
    });
    assert.deepEqual(padErrors.filter((line) => line.startsWith("pageerror:")), []);
    console.log("Ajar and Pad both boot with no page errors.");
  } finally {
    await browser.close();
  }
}

/**
 * Both halves of this suite drive a real browser, and the layout half spawns
 * its own. Deciding here — before any server starts — is the only place a
 * missing browser can be reported as one clear message rather than a stack
 * trace from whichever half happened to run first.
 */
async function browserAvailable() {
  const { chromium } = webRequire("playwright");
  try {
    const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : undefined,
      headless: true,
    });
    await browser.close();
    return true;
  } catch (error) {
    // In CI a missing browser is a broken gate, never something to step past.
    if (process.env.CI) throw error;
    console.log(
      "Skipping the UI suite: no browser installed.\n" +
        "  Install one with: npx playwright install chromium --workspace web\n" +
        `  ${error.message.split("\n")[0]}`,
    );
    return false;
  }
}

async function main() {
  if (!(await browserAvailable())) return;
  const viteBin = (workspaceRequire) =>
    path.join(path.dirname(workspaceRequire.resolve("vite/package.json")), "bin", "vite.js");
  const webVite = viteBin(webRequire);
  const padVite = viteBin(padRequire);
  const dev = start(web, webVite, ["--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  const webPreview = start(web, webVite, ["preview", "--host", "127.0.0.1", "--port", "5174", "--strictPort"]);
  const padPreview = start(pad, padVite, ["preview", "--host", "127.0.0.1", "--port", "5175", "--strictPort"]);

  await Promise.all([
    ready("http://127.0.0.1:5173/", dev),
    ready("http://127.0.0.1:5174/", webPreview),
    ready("http://127.0.0.1:5175/", padPreview),
  ]);
  await run(path.join(root, "scripts", "check-workspace-layout.cjs"), {
    AJAR_PRODUCTION_URL: "http://127.0.0.1:5174",
  });
  await checkBoots();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const server of servers) server.kill();
  });
